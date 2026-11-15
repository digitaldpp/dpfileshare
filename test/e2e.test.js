'use strict';
// End-to-end tests: start the real server on spare ports with a throwaway data folder and talk
// to it the way the share manager page and a link recipient would.
//
//   npm test                       tests server.js with Node
//   DPFS_ENGINE=path\to\engine.exe npm test     tests a built engine instead

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const PORT = 53900 + Math.floor(Math.random() * 50) * 2;
const ADMIN_PORT = PORT + 1;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dpfs-test-'));
const dataDir = path.join(tmp, 'data');
const shared = path.join(tmp, 'shared');
const outside = path.join(tmp, 'outside.txt');
const bigFile = crypto.randomBytes(300 * 1024);

let server;
let output = '';

function startServer() {
  const engine = process.env.DPFS_ENGINE;
  server = spawn(engine || process.execPath, engine ? [] : [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, DPFS_DATA_DIR: dataDir, PORT: '', ADMIN_PORT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (output += d));
  server.stderr.on('data', (d) => (output += d));
}

// One request. Resolves with { status, headers, body (Buffer), json }.
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try {
          json = JSON.parse(buf.toString('utf8'));
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: buf, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const adminUrl = (p) => `http://127.0.0.1:${ADMIN_PORT}${p}`;
const admin = (p, opts = {}) => request(adminUrl(p), {
  ...opts,
  headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', ...(opts.headers || {}) },
  body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
});
const pub = (p, opts) => request(`https://127.0.0.1:${PORT}${p}`, opts);

async function createLink(body) {
  const res = await admin('/api/links', { method: 'POST', body });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return { ...res.json, base: new URL(res.json.url).pathname };
}

async function waitFor(check, what) {
  for (let i = 0; i < 100; i++) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${what}.\n${output}`);
}

test.before(async () => {
  fs.mkdirSync(path.join(shared, 'sub folder'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.txt'), 'hello world');
  fs.writeFileSync(path.join(shared, 'sub folder', 'big ünïcode.bin'), bigFile);
  fs.writeFileSync(path.join(shared, 'half-done.dpshare-part'), 'partial');
  fs.writeFileSync(outside, 'secret');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT, adminPort: ADMIN_PORT, publicHost: 'files.example.test' }));
  startServer();
  await waitFor(async () => (await admin('/api/status')).status === 200, 'the server to start');
});

test.after(async () => {
  await admin('/api/shutdown', { method: 'POST' }).catch(() => {});
  await new Promise((resolve) => (server.exitCode === null ? server.once('exit', resolve) : resolve()));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('makes its own certificate, for this PC, without OpenSSL', () => {
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(dataDir, 'cert', 'cert.pem')));
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(dataDir, 'cert', 'key.pem')));
  assert.equal(cert.subject, 'CN=DP File Share');
  assert.ok(cert.checkPrivateKey(key));
  assert.ok(cert.verify(cert.publicKey), 'signed by itself');
  assert.ok(cert.checkHost('localhost'));
  assert.ok(cert.checkHost('files.example.test'));
  assert.ok(cert.checkIP('127.0.0.1'));
  assert.ok(Date.parse(cert.validTo) > Date.now() + 365 * 24 * 3600 * 1000);
});

test('share manager only answers its own page on this PC', async () => {
  assert.equal((await request(adminUrl('/'))).status, 200);
  assert.equal((await request(adminUrl('/api/status'))).status, 404, 'no X-Requested-With header');
  assert.equal((await request(adminUrl('/'), { headers: { Host: 'evil.example' } })).status, 403, 'DNS rebinding');
  const status = (await admin('/api/status')).json;
  assert.equal(status.version, require('../package.json').version);
  assert.equal(status.dataDir, dataDir);
  // The manager must not be reachable through the public port.
  assert.equal((await pub('/api/status', { headers: { 'X-Requested-With': 'fetch' } })).status, 404);
});

test('public server gives nothing away without a link', async () => {
  assert.equal((await pub('/')).status, 404);
  assert.equal((await pub('/robots.txt')).body.toString(), 'User-agent: *\nDisallow: /\n');
  assert.equal((await pub('/favicon.ico')).status, 204);
  const res = await pub('/s/' + 'x'.repeat(43));
  assert.equal(res.status, 404);
  assert.match(res.headers['x-robots-tag'], /noindex/);
});

test('rejects bad link requests', async () => {
  const bad = async (body) => (await admin('/api/links', { method: 'POST', body })).status;
  assert.equal(await bad({}), 400, 'neither download nor upload');
  assert.equal(await bad({ download: true, items: [] }), 400, 'nothing to share');
  assert.equal(await bad({ download: true, items: ['relative\\path'] }), 400);
  assert.equal(await bad({ download: true, items: [path.join(tmp, 'missing')] }), 400);
  assert.equal(await bad({ download: true, items: [path.join(dataDir, 'cert')] }), 400, "the app's own data");
  assert.equal(await bad({ download: true, items: [shared], expiresAt: Date.now() - 1000 }), 400, 'expiry in the past');
  assert.equal(await bad({ upload: true, uploadLimitGB: 0 }), 400);
});

test('download link: browse, download, resume', async () => {
  const link = await createLink({ download: true, items: [shared, path.join(shared, 'hello.txt')], label: 'Test files' });
  assert.match(link.url, /^https:\/\/files\.example\.test:\d+\/s\/[A-Za-z0-9_-]{43}$/);

  assert.equal((await pub(link.base)).status, 200);
  const info = (await pub(`${link.base}/info`)).json;
  assert.equal(info.label, 'Test files');
  assert.deepEqual(info.items.map((i) => [i.name, i.type, i.available]), [['shared', 'dir', true], ['hello.txt', 'file', true]]);
  assert.equal(JSON.stringify(info).includes(tmp), false, 'no real paths are shown to recipients');

  const list = (await pub(`${link.base}/list?item=0`)).json;
  assert.deepEqual(list.map((e) => e.name).sort(), ['hello.txt', 'sub folder'], 'unfinished uploads are hidden');

  const file = await pub(`${link.base}/file?item=1`);
  assert.equal(file.body.toString(), 'hello world');
  assert.match(file.headers['content-disposition'], /^attachment; filename="hello.txt"/);

  const rel = encodeURIComponent('sub folder/big ünïcode.bin');
  const whole = await pub(`${link.base}/file?item=0&path=${rel}`);
  assert.ok(whole.body.equals(bigFile));
  assert.match(whole.headers['content-disposition'], /filename\*=UTF-8''big%20%C3%BCn%C3%AFcode\.bin/);

  const head = await pub(`${link.base}/file?item=0&path=${rel}`, { method: 'HEAD' });
  assert.equal(Number(head.headers['content-length']), bigFile.length);

  const part = await pub(`${link.base}/file?item=0&path=${rel}`, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], `bytes 1000-1999/${bigFile.length}`);
  assert.ok(part.body.equals(bigFile.subarray(1000, 2000)));

  const tail = await pub(`${link.base}/file?item=0&path=${rel}`, { headers: { Range: 'bytes=-500' } });
  assert.ok(tail.body.equals(bigFile.subarray(bigFile.length - 500)));
  assert.equal((await pub(`${link.base}/file?item=0&path=${rel}`, { headers: { Range: `bytes=${bigFile.length}-` } })).status, 416);

  const mine = (await admin('/api/links')).json.find((l) => l.id === link.id);
  assert.equal(mine.downloads, 2, 'full downloads are counted; HEAD and resumed ranges are not');
});

test('nothing outside a shared folder can be reached', async () => {
  const link = await createLink({ download: true, items: [shared] });
  const get = async (p) => (await pub(`${link.base}/file?item=0&path=${encodeURIComponent(p)}`)).status;
  assert.equal(await get('../outside.txt'), 400);
  assert.equal(await get('sub folder/../../outside.txt'), 400);
  assert.equal(await get('..\\outside.txt'), 400);
  assert.equal(await get(outside), 400, 'absolute path');
  assert.equal(await get('hello.txt::$DATA'), 400, 'alternate data stream');
  assert.equal(await get('half-done.dpshare-part'), 404);
  assert.equal(await get('nope.txt'), 404);
  assert.equal((await pub(`${link.base}/file?item=5`)).status, 404);
  assert.equal((await pub(`${link.base}/list?item=0&path=..`)).status, 400);

  // A junction inside the shared folder that points outside it must not be followed.
  const escape = path.join(shared, 'escape');
  fs.symlinkSync(tmp, escape, 'junction');
  try {
    assert.equal(await get('escape/outside.txt'), 404);
    assert.equal((await pub(`${link.base}/list?item=0&path=escape`)).status, 404);
  } finally {
    fs.rmSync(escape, { force: true });
  }

  assert.equal((await pub(`${link.base}/upload`, { method: 'POST', body: '{}' })).status, 403, 'download-only link');
});

async function upload(link, name, data, pieceSize = 100 * 1024) {
  const start = await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name, size: data.length }) });
  if (start.status !== 201 || start.json.done) return start;
  let res = start;
  for (let at = 0; at < data.length; at += pieceSize) {
    res = await pub(`${link.base}/upload/${start.json.id}?offset=${at}`, { method: 'PUT', body: data.subarray(at, at + pieceSize) });
    assert.equal(res.status, 200, res.body.toString());
  }
  return res;
}

test('upload link: pieces, resume, limits, safe names', async () => {
  const link = await createLink({ upload: true, label: 'Send me stuff', uploadLimitGB: 0.001 }); // about 1 MB
  assert.equal((await pub(`${link.base}/list?item=0`)).status, 403, 'upload-only link');
  const dir = link.uploadDir;
  assert.ok(dir.startsWith(path.join(dataDir, 'uploads')));

  const done = await upload(link, 'report.bin', bigFile);
  assert.deepEqual([done.json.done, done.json.name], [true, 'report.bin']);
  assert.ok(fs.readFileSync(path.join(dir, 'report.bin')).equals(bigFile));

  const again = await upload(link, 'report.bin', bigFile);
  assert.equal(again.json.name, 'report (1).bin', 'never overwrites');

  const nasty = await upload(link, '..\\..\\evil<>:name?.txt', Buffer.from('x'));
  assert.equal(nasty.json.name, '_.._evil___name_.txt');
  assert.ok(fs.existsSync(path.join(dir, nasty.json.name)), 'stays inside the upload folder');

  const empty = await upload(link, 'empty.txt', Buffer.alloc(0));
  assert.equal(empty.json.done, true);

  // Interrupted upload: ask how much arrived, then carry on from there.
  const data = crypto.randomBytes(50000);
  const start = (await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name: 'resume.bin', size: data.length }) })).json;
  const put = (offset, body) => pub(`${link.base}/upload/${start.id}?offset=${offset}`, { method: 'PUT', body });
  assert.equal((await put(0, data.subarray(0, 20000))).json.received, 20000);
  const wrong = await put(0, data.subarray(0, 20000));
  assert.deepEqual([wrong.status, wrong.json.received], [409, 20000], 'wrong offset is refused');
  assert.equal((await put(20000, Buffer.alloc(40000))).status, 400, 'more than the file size');
  assert.equal((await pub(`${link.base}/upload/${start.id}`)).json.received, 20000);
  const resumed = (await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name: 'resume.bin', size: data.length, resumeId: start.id }) })).json;
  assert.deepEqual([resumed.id, resumed.received], [start.id, 20000]);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.dpshare-part')).length, 1);
  const last = await put(20000, data.subarray(20000));
  assert.equal(last.json.done, true);
  assert.ok(fs.readFileSync(path.join(dir, 'resume.bin')).equals(data));

  // Two copies of the same piece arriving together: only one may be written.
  const twin = crypto.randomBytes(30000);
  const t = (await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name: 'twin.bin', size: twin.length }) })).json;
  const both = await Promise.all([0, 1].map(() => pub(`${link.base}/upload/${t.id}?offset=0`, { method: 'PUT', body: twin })));
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  assert.ok(fs.readFileSync(path.join(dir, 'twin.bin')).equals(twin));

  // Cancelling removes the partial file.
  const c = (await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name: 'cancel.bin', size: 5000 }) })).json;
  assert.equal((await pub(`${link.base}/upload/${c.id}`, { method: 'DELETE' })).status, 204);
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.dpshare-part')).length, 0);

  // About 1 MB allowed, roughly 680 KB used.
  const tooBig = await pub(`${link.base}/upload`, { method: 'POST', body: JSON.stringify({ name: 'huge.bin', size: 600 * 1024 }) });
  assert.equal(tooBig.status, 413);

  const mine = (await admin('/api/links')).json.find((l) => l.id === link.id);
  assert.equal(mine.received.length, 6);
  assert.equal(mine.uploading, 0);
});

test('two-way link keeps uploads out of the download side', async () => {
  const link = await createLink({ download: true, upload: true, items: [path.join(shared, 'hello.txt')], label: 'Both ways' });
  assert.ok(link.uploadDir.endsWith('Both ways (received)'));
  await upload(link, 'from-them.txt', Buffer.from('hi'));
  const info = (await pub(`${link.base}/info`)).json;
  assert.deepEqual(info.items.map((i) => i.name), ['hello.txt']);
});

test('expire, turn back on, delete', async () => {
  const link = await createLink({ download: true, items: [shared], expiresInHours: 1 });
  const patch = (body) => admin(`/api/links/${link.id}`, { method: 'PATCH', body });

  assert.equal((await patch({ expireNow: true })).json.active, false);
  assert.equal((await pub(link.base)).status, 404);
  assert.equal((await pub(`${link.base}/info`)).status, 404);
  assert.equal((await pub(`${link.base}/file?item=0&path=hello.txt`)).status, 404);

  assert.equal((await patch({ extendHours: 24 })).json.active, true);
  assert.equal((await pub(`${link.base}/info`)).status, 200);
  assert.equal((await patch({ expiresAt: null })).json.expiresAt, null, 'never expires');

  assert.equal((await admin(`/api/links/${link.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await pub(`${link.base}/info`)).status, 404);
  assert.equal((await admin(`/api/links/${link.id}`, { method: 'DELETE' })).status, 404);
  assert.ok(fs.existsSync(path.join(shared, 'hello.txt')), 'deleting a link never deletes files');
});

test('links survive a restart; too many wrong links get an address blocked', async () => {
  const link = await createLink({ download: true, items: [shared] });
  await admin('/api/shutdown', { method: 'POST' });
  await new Promise((resolve) => server.once('exit', resolve));
  startServer();
  await waitFor(async () => (await admin('/api/status')).status === 200, 'the server to restart');
  assert.equal((await pub(`${link.base}/info`)).status, 200);

  // Other paths (favicons, scanners) are not counted as guesses.
  for (let i = 0; i < 30; i++) await pub('/favicon.ico');
  for (let i = 0; i < 30; i++) await pub(`/wp-login-${i}.php`);
  assert.equal((await pub(`${link.base}/info`)).status, 200);

  for (let i = 0; i < 20; i++) assert.equal((await pub('/s/' + crypto.randomBytes(32).toString('base64url'))).status, 404);
  assert.equal((await pub(`${link.base}/info`)).status, 429);
});
