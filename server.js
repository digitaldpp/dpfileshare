'use strict';
// DP File Share: share files on this PC through private, expiring links. No dependencies.
//
// Two servers run side by side:
//   - the public one (HTTPS, all interfaces) only answers private links: /s/<token>
//   - the share manager (plain HTTP, 127.0.0.1 only) is where links are created. It is
//     never reachable from another device.

const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pipeline, Transform } = require('stream');
const { execFile } = require('child_process');

// When built into the exe (a Node "single executable application"), the pages in public/ and
// package.json travel inside it as assets. Run with plain `node server.js`, they come from disk.
let sea = null;
try {
  sea = require('node:sea');
  if (!sea.isSea()) sea = null;
} catch {}

const assetCache = new Map();
function asset(name) {
  if (!sea) return fs.readFileSync(name === 'package.json' ? path.join(__dirname, name) : path.join(__dirname, 'public', name));
  if (!assetCache.has(name)) assetCache.set(name, Buffer.from(sea.getAsset(name)));
  return assetCache.get(name);
}

const VERSION = JSON.parse(asset('package.json').toString('utf8')).version;

// Everything the app writes (settings, links, certificate, default uploads folder) lives in
// one data folder. The tray app picks it; on its own the server uses the folder it runs from.
const APP_DIR = sea ? path.dirname(process.execPath) : __dirname;
// Paths are compared to keep the app's own data from being shared, so they are stored the way
// Windows itself spells them: no short names (PROGRA~1), junctions or shortcuts in between.
function truePath(p) {
  const missing = [];
  let at = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(at), ...missing);
    } catch {
      const parent = path.dirname(at);
      if (parent === at) return path.resolve(p);
      missing.unshift(path.basename(at));
      at = parent;
    }
  }
}

fs.mkdirSync(path.resolve(process.env.DPFS_DATA_DIR || APP_DIR), { recursive: true });
const ROOT = truePath(process.env.DPFS_DATA_DIR || APP_DIR);
const LINKS_FILE = path.join(ROOT, 'links.json');
const config = readConfig();

const PORT = Number(process.env.PORT || config.port || 53817);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || config.adminPort || 53818);
const UPLOAD_DIR = truePath(config.uploadDir
  ? path.resolve(ROOT, config.uploadDir)
  : process.env.DPFS_DEFAULT_UPLOAD_DIR || path.join(ROOT, 'uploads'));
const DEFAULT_UPLOAD_LIMIT_GB = numberOr(config.defaultUploadLimitGB, 10);
const DEFAULT_EXPIRY_HOURS = numberOr(config.defaultExpiryHours, 168);
const PUBLIC_HOST = String(config.publicHost || '').trim();
const CERT_FILE = path.resolve(ROOT, config.certFile || 'cert/cert.pem');
const KEY_FILE = path.resolve(ROOT, config.keyFile || 'cert/key.pem');

const GB = 1024 ** 3;
const MAX_PENDING_UPLOADS = 100; // unfinished uploads allowed per link at once
const MAX_FILES_PER_LINK = 10000; // files one link can receive in total
const PART_EXT = '.dpshare-part'; // uploads in progress; never listed or downloadable
const HIDDEN_NAMES = new Set(['$recycle.bin', 'system volume information', 'desktop.ini', 'thumbs.db']);
const EXPIRED_KEEP_MS = 30 * 24 * 3600 * 1000; // expired links stay visible in the manager this long
const STALE_UPLOAD_MS = 7 * 24 * 3600 * 1000; // unfinished uploads untouched this long are discarded

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function numberOr(value, fallback) {
  const n = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(n) ? fallback : n;
}

function log(...args) {
  console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...args);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


// ---------- links ----------
//
// A link: { id, token, label, download, upload, items: [{ name, path, type }], uploadDir,
//   uploadLimitBytes (null = no limit), uploadedBytes, pending: [{ id, name, size, partPath }],
//   received: [{ name, size, at }], downloads, createdAt, expiresAt (null = never), ip }

let links = loadLinks();

function loadLinks() {
  try {
    const list = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((l) => l && l.id && l.token) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read ${LINKS_FILE}: ${err.message}`);
    return [];
  }
}

function saveLinks() {
  const tmp = LINKS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(links, null, 2));
  try {
    fs.renameSync(tmp, LINKS_FILE);
  } catch {
    // Antivirus or a backup tool can hold the file open for a moment, which blocks a rename.
    fs.copyFileSync(tmp, LINKS_FILE);
    fs.rmSync(tmp, { force: true });
  }
}

const isActive = (link) => !link.expiresAt || link.expiresAt > Date.now();
const findByToken = (token) => links.find((l) => l.token === token);
const findById = (id) => links.find((l) => l.id === id);
const reservedBytes = (link) => (link.uploadedBytes || 0) + link.pending.reduce((sum, p) => sum + p.size, 0);
const uploadRemaining = (link) => (link.uploadLimitBytes == null ? null : Math.max(0, link.uploadLimitBytes - reservedBytes(link)));

// Removes leftovers: unfinished uploads on expired links or ones abandoned for a week,
// and links that expired more than 30 days ago.
async function sweep() {
  const now = Date.now();
  let changed = false;
  for (const link of links) {
    for (const p of [...link.pending]) {
      const stat = await fsp.stat(p.partPath).catch(() => null);
      if (stat && isActive(link) && now - stat.mtimeMs < STALE_UPLOAD_MS) continue;
      if (busyUploads.has(p.id)) continue;
      await fsp.unlink(p.partPath).catch(() => {});
      link.pending = link.pending.filter((x) => x !== p);
      changed = true;
    }
  }
  const keep = links.filter((l) => !l.expiresAt || l.expiresAt + EXPIRED_KEEP_MS > now);
  if (keep.length !== links.length) {
    links = keep;
    changed = true;
  }
  if (changed) saveLinks();
}

// ---------- paths ----------

// True if target is dir itself or somewhere inside it.
function insideDir(dir, target) {
  const rel = path.relative(dir, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

// The app's data folder (settings, links, the certificate's private key) is never shared,
// except for things in the uploads folder.
const isAppPath = (real) => insideDir(ROOT, real) && !insideDir(UPLOAD_DIR, real);

function displayName(real) {
  return path.basename(real) || `${real.slice(0, 1).toUpperCase()} drive`;
}

// Turns a shared item + relative path ("Photos/2024/a.jpg") into a real path on disk, refusing
// anything that escapes the shared folder (including through shortcuts/junctions).
async function resolveInItem(item, rel) {
  let root;
  try {
    root = await fsp.realpath(item.path);
  } catch {
    throw new HttpError(404, `"${item.name}" is not available right now. If it is on an external drive, it may be unplugged.`);
  }
  if (item.type === 'file') return root;
  const parts = String(rel || '').split(/[\\/]+/).filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..' || /[\x00-\x1f:<>"|?*]/.test(s))) throw new HttpError(400, 'Bad path');
  let real;
  try {
    real = await fsp.realpath(path.join(root, ...parts));
  } catch {
    throw new HttpError(404, 'Not found');
  }
  if (!insideDir(root, real) || isAppPath(real) || real.endsWith(PART_EXT)) throw new HttpError(404, 'Not found');
  return real;
}

// Turns any client-supplied name into a plain, Windows-safe file name.
function safeName(name) {
  let n = path.basename(String(name || '').replace(/[\\/]/g, '_'))
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .slice(0, 200)
    .replace(/^[. ]+|[. ]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  if (n.toLowerCase().endsWith(PART_EXT)) n += '_';
  return n || 'file';
}

// Picks "name", "name (1)", "name (2)"... whichever is free in dir.
const claimedNames = new Set();
async function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    const full = path.join(dir, candidate).toLowerCase();
    if (claimedNames.has(full)) continue;
    try {
      await fsp.access(path.join(dir, candidate));
    } catch (err) {
      if (err.code === 'ENOENT') {
        claimedNames.add(full);
        return candidate;
      }
      throw err;
    }
  }
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|"/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

// ---------- http helpers ----------

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
}

const sendJSON = (res, status, data) => send(res, status, JSON.stringify(data), 'application/json');

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function serveStatic(res, file, status = 200) {
  send(res, status, asset(file), STATIC_TYPES[path.extname(file)]);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJSON(req, limit = 8192) {
  try {
    return JSON.parse((await readBody(req, limit)) || '{}') || {};
  } catch (err) {
    throw err instanceof HttpError ? err : new HttpError(400, 'Bad request');
  }
}

function clientIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
}

// Transfers in progress, so the tray can warn before turning sharing off.
const active = { downloads: 0, uploads: 0 };

// ---------- public IP ----------

let ipCache = { ip: null, at: 0 };

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 4000, headers: { 'User-Agent': 'dp-file-share' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 200) req.destroy(new Error('Too long'));
      });
      res.on('end', () => resolve(data.trim()));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.on('error', reject);
  });
}

// The home connection's IP can change, so it is looked up again every few minutes.
async function getPublicIp(force = false) {
  if (PUBLIC_HOST) return null; // links use the configured name, so there is nothing to look up
  if (!force && ipCache.ip && Date.now() - ipCache.at < 5 * 60 * 1000) return ipCache.ip;
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://checkip.amazonaws.com']) {
    try {
      const ip = await fetchText(url);
      if (net.isIPv4(ip)) {
        if (ipCache.ip && ipCache.ip !== ip) log(`Public IP changed from ${ipCache.ip} to ${ip}`);
        ipCache = { ip, at: Date.now() };
        return ip;
      }
    } catch {}
  }
  return ipCache.ip; // a stale answer beats none
}

function linkUrl(link) {
  const host = PUBLIC_HOST || ipCache.ip || 'YOUR-PUBLIC-IP';
  return `https://${host}${PORT === 443 ? '' : ':' + PORT}/s/${link.token}`;
}

// ---------- public server: private links ----------

// Guessing tokens is hopeless (256 bits), but an IP that keeps trying gets shut out anyway.
const misses = new Map(); // ip -> { count, since, blockedUntil }
const MISS_LIMIT = 20;
const MISS_WINDOW_MS = 10 * 60 * 1000;

function isBlocked(ip) {
  const m = misses.get(ip);
  return !!m && m.blockedUntil > Date.now();
}

function recordMiss(ip) {
  const now = Date.now();
  let m = misses.get(ip);
  if (!m || now - m.since > MISS_WINDOW_MS) m = { count: 0, since: now, blockedUntil: 0 };
  if (++m.count >= MISS_LIMIT) {
    m.blockedUntil = now + MISS_WINDOW_MS;
    log(`Blocking ${ip} for 10 minutes after ${m.count} bad link attempts`);
  }
  misses.set(ip, m);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, m] of misses) if (m.blockedUntil < now && now - m.since > MISS_WINDOW_MS) misses.delete(ip);
}, 3600 * 1000).unref();

function notAvailable(res, isApi) {
  if (isApi) return sendJSON(res, 404, { error: 'This link is not available. It may have expired or been turned off.' });
  serveStatic(res, 'gone.html', 404);
}

async function linkInfo(res, link) {
  const items = link.download
    ? await Promise.all(link.items.map(async (item, i) => {
      const stat = await fsp.stat(item.path).catch(() => null);
      return { i, name: item.name, type: item.type, available: !!stat, size: item.type === 'file' && stat ? stat.size : undefined };
    }))
    : [];
  sendJSON(res, 200, {
    label: link.label,
    download: link.download,
    upload: link.upload,
    expiresAt: link.expiresAt,
    items,
    uploadRemaining: link.upload ? uploadRemaining(link) : 0,
  });
}

function getItem(link, q) {
  if (!link.download) throw new HttpError(403, 'This link is for uploading only.');
  const item = link.items[Number(q.get('item'))];
  if (!item) throw new HttpError(404, 'Not found');
  return item;
}

async function listDir(res, link, q) {
  const item = getItem(link, q);
  if (item.type !== 'dir') throw new HttpError(400, 'Not a folder');
  const dir = await resolveInItem(item, q.get('path'));
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOTDIR') throw new HttpError(400, 'Not a folder');
    throw new HttpError(404, 'This folder could not be opened.');
  }
  const out = [];
  await Promise.all(entries.map(async (entry) => {
    const lower = entry.name.toLowerCase();
    if (HIDDEN_NAMES.has(lower) || entry.name.startsWith('~$') || lower.endsWith(PART_EXT)) return;
    const full = path.join(dir, entry.name);
    if (isAppPath(full)) return;
    try {
      const stat = await fsp.stat(full);
      if (stat.isDirectory()) out.push({ name: entry.name, type: 'dir', mtime: stat.mtimeMs });
      else if (stat.isFile()) out.push({ name: entry.name, type: 'file', size: stat.size, mtime: stat.mtimeMs });
    } catch {} // locked or broken entries are skipped
  }));
  sendJSON(res, 200, out);
}

// Sends a file, honouring Range requests so browsers can resume big downloads.
async function download(req, res, link, q) {
  const item = getItem(link, q);
  const file = await resolveInItem(item, q.get('path'));
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || !stat.isFile()) throw new HttpError(404, 'Not found');

  const size = stat.size;
  const lastModified = stat.mtime.toUTCString();
  let start = 0;
  let end = size - 1;
  let status = 200;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': contentDisposition(path.basename(file)),
    'Accept-Ranges': 'bytes',
    'Last-Modified': lastModified,
  };

  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  const m = range && (!ifRange || ifRange === lastModified) && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2]) && size > 0) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();

  const ip = clientIp(req);
  if (start === 0) {
    link.downloads = (link.downloads || 0) + 1;
    saveLinks();
    log(`Download of "${file}" started by ${ip} (link "${link.label}")`);
  }
  active.downloads++;
  pipeline(fs.createReadStream(file, { start, end }), res, (err) => {
    active.downloads--;
    if (!err && end === size - 1) log(`Download of "${file}" finished for ${ip}`);
  });
}

// Uploads go in chunks: start one with POST, then PUT each piece at its offset. If a piece
// fails, the page asks how much arrived and carries on from there, so big files survive
// flaky connections and even a restart of the server.
const busyUploads = new Set(); // upload ids with a piece arriving right now

function requireUpload(link) {
  if (!link.upload) throw new HttpError(403, 'This link is for downloading only.');
}

async function uploadDir(link) {
  await fsp.mkdir(link.uploadDir, { recursive: true });
  return fsp.realpath(link.uploadDir);
}

async function partSize(p) {
  const stat = await fsp.stat(p.partPath).catch(() => null);
  return stat ? stat.size : null;
}

async function startUpload(req, res, link) {
  requireUpload(link);
  const body = await readJSON(req);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Bad file size');
  const name = safeName(body.name);

  // Picking up where an earlier attempt (maybe from before a page reload) left off.
  const earlier = typeof body.resumeId === 'string' && link.pending.find((p) => p.id === body.resumeId && p.size === size);
  if (earlier) {
    const received = await partSize(earlier);
    if (received !== null) return sendJSON(res, 200, { id: earlier.id, received });
  }

  if (link.pending.length >= MAX_PENDING_UPLOADS) {
    throw new HttpError(429, 'Too many unfinished uploads on this link. Let some finish, then try again.');
  }
  if ((link.uploadedFiles || 0) + link.pending.length >= MAX_FILES_PER_LINK) {
    throw new HttpError(413, 'This link has received as many files as it can take.');
  }

  const remaining = uploadRemaining(link);
  if (remaining !== null && size > remaining) {
    throw new HttpError(413, remaining === 0
      ? 'This link has reached its upload limit.'
      : `This file is too big. This link can take ${formatBytes(remaining)} more.`);
  }

  const dir = await uploadDir(link);
  const free = await fsp.statfs(dir).then((s) => s.bavail * s.bsize).catch(() => Infinity);
  if (size > free) throw new HttpError(507, 'There is not enough free space on the receiving computer for this file.');

  const p = { id: crypto.randomBytes(12).toString('hex'), name, size, partPath: '' };
  p.partPath = path.join(dir, `${p.id}${PART_EXT}`);
  await fsp.writeFile(p.partPath, '', { flag: 'wx' });
  link.pending.push(p);
  saveLinks();
  log(`Upload of "${name}" (${formatBytes(size)}) started by ${clientIp(req)} (link "${link.label}")`);

  if (size === 0) return sendJSON(res, 201, { id: p.id, received: 0, done: true, name: await finishUpload(link, p) });
  sendJSON(res, 201, { id: p.id, received: 0 });
}

async function finishUpload(link, p) {
  const dir = path.dirname(p.partPath);
  const name = await uniqueName(dir, p.name);
  const full = path.join(dir, name);
  try {
    await fsp.rename(p.partPath, full);
  } finally {
    claimedNames.delete(full.toLowerCase());
  }
  link.pending = link.pending.filter((x) => x !== p);
  link.uploadedBytes = (link.uploadedBytes || 0) + p.size;
  link.uploadedFiles = (link.uploadedFiles || 0) + 1;
  link.received = [...(link.received || []), { name, size: p.size, at: Date.now() }].slice(-200);
  saveLinks();
  log(`Received "${full}" (${formatBytes(p.size)}) on link "${link.label}"`);
  return name;
}

function findPending(link, id) {
  const p = link.pending.find((x) => x.id === id);
  if (!p) throw new HttpError(404, 'This upload was cancelled or has expired. Please start it again.');
  return p;
}

async function uploadStatus(res, link, id) {
  requireUpload(link);
  const p = findPending(link, id);
  const received = await partSize(p);
  if (received === null) throw new HttpError(404, 'This upload was lost. Please start it again.');
  sendJSON(res, 200, { id, received, size: p.size });
}

async function uploadPiece(req, res, link, id, q) {
  requireUpload(link);
  const p = findPending(link, id);
  if (busyUploads.has(id)) throw new HttpError(409, 'This file is already being uploaded from another window.');
  // Claimed before the first await, so two pieces arriving together can't both write.
  busyUploads.add(id);
  let received;
  let room;
  try {
    received = await partSize(p);
    if (received === null) throw new HttpError(404, 'This upload was lost. Please start it again.');
    room = p.size - received;
    const length = Number(req.headers['content-length']);
    if (Number(q.get('offset')) === received && (!Number.isSafeInteger(length) || length < 1 || length > room)) {
      throw new HttpError(400, 'Bad piece size');
    }
  } catch (err) {
    busyUploads.delete(id);
    throw err;
  }
  if (Number(q.get('offset')) !== received) {
    busyUploads.delete(id);
    res.setHeader('Connection', 'close'); // the piece's body is not read
    return sendJSON(res, 409, { error: 'offset', received });
  }

  active.uploads++;
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > room) cb(Object.assign(new Error('Too much data'), { status: 413 }));
      else cb(null, chunk);
    },
  });

  pipeline(req, limiter, fs.createWriteStream(p.partPath, { flags: 'a' }), async (err) => {
    busyUploads.delete(id);
    active.uploads--;
    if (!links.includes(link) || !link.pending.includes(p)) {
      // The link was deleted while this piece was arriving: don't leave the partial file behind.
      await fsp.unlink(p.partPath).catch(() => {});
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        sendJSON(res, 404, { error: 'This link is not available. It may have expired or been turned off.' });
      }
      return;
    }
    if (err) {
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        send(res, err.status || 400, 'Upload interrupted');
      }
      return;
    }
    const now = received + bytes;
    if (now < p.size) return sendJSON(res, 200, { received: now });
    try {
      sendJSON(res, 200, { received: now, done: true, name: await finishUpload(link, p) });
    } catch (e) {
      console.error(e);
      send(res, 500, 'The file arrived but could not be saved.');
    }
  });
}

async function cancelUpload(res, link, id) {
  requireUpload(link);
  const p = findPending(link, id);
  if (busyUploads.has(id)) throw new HttpError(409, 'Wait for the current piece to finish.');
  await fsp.unlink(p.partPath).catch(() => {});
  link.pending = link.pending.filter((x) => x !== p);
  saveLinks();
  log(`Upload of "${p.name}" cancelled on link "${link.label}"`);
  send(res, 204);
}

async function handlePublic(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'https://localhost');
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;
  const ip = clientIp(req);

  if (m === 'GET' && p === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n');
  if (m === 'GET' && p === '/assets/style.css') return serveStatic(res, 'style.css');
  if (m === 'GET' && p === '/assets/share.js') return serveStatic(res, 'share.js');
  if (m === 'GET' && p === '/favicon.ico') return send(res, 204);

  if (isBlocked(ip)) return send(res, 429, 'Too many requests. Try again later.');
  // Only wrong links count as guesses. Browsers and scanners ask for plenty of other paths.
  if (!p.startsWith('/s/')) return send(res, 404, 'Not found');
  const match = /^\/s\/([A-Za-z0-9_-]{20,64})(\/.*)?$/.exec(p);
  const sub = (match && match[2]) || '';
  const isApi = sub.length > 1;
  const link = match && findByToken(match[1]);
  if (!link || !isActive(link)) {
    recordMiss(ip);
    return notAvailable(res, isApi);
  }

  if (m === 'GET' && (sub === '' || sub === '/')) return serveStatic(res, 'share.html');
  if (m === 'GET' && sub === '/info') return linkInfo(res, link);
  if (m === 'GET' && sub === '/list') return listDir(res, link, q);
  if ((m === 'GET' || m === 'HEAD') && sub === '/file') return download(req, res, link, q);
  if (m === 'POST' && sub === '/upload') return startUpload(req, res, link);
  const up = /^\/upload\/([0-9a-f]{24})$/.exec(sub);
  if (up && m === 'GET') return uploadStatus(res, link, up[1]);
  if (up && m === 'PUT') return uploadPiece(req, res, link, up[1], q);
  if (up && m === 'DELETE') return cancelUpload(res, link, up[1]);
  send(res, 404, 'Not found');
}

// ---------- share manager (this PC only) ----------

function adminView(link) {
  return {
    id: link.id,
    label: link.label,
    download: link.download,
    upload: link.upload,
    items: link.items,
    uploadDir: link.upload ? link.uploadDir : null,
    uploadLimitBytes: link.uploadLimitBytes,
    uploadedBytes: link.uploadedBytes || 0,
    uploading: link.pending.length,
    received: (link.received || []).slice(-50).reverse(),
    downloads: link.downloads || 0,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    active: isActive(link),
    url: linkUrl(link),
    ipChanged: !PUBLIC_HOST && !!(ipCache.ip && link.ip && link.ip !== ipCache.ip),
  };
}

async function status(res) {
  await getPublicIp();
  sendJSON(res, 200, {
    version: VERSION,
    dataDir: ROOT,
    publicIp: ipCache.ip,
    publicHost: PUBLIC_HOST || null,
    port: PORT,
    activeTransfers: active.downloads + active.uploads,
    activeLinks: links.filter(isActive).length,
    defaultUploadLimitGB: DEFAULT_UPLOAD_LIMIT_GB,
    defaultExpiryHours: DEFAULT_EXPIRY_HOURS,
    uploadRoot: UPLOAD_DIR,
  });
}

async function realItem(input) {
  let p = String(input || '').trim().replace(/^"(.*)"$/, '$1');
  if (/^[a-z]:$/i.test(p)) p += path.sep; // "E:" -> "E:\"
  if (!p || !path.isAbsolute(p)) throw new HttpError(400, `Use the full path, like E:\\Photos (got "${p}").`);
  let real;
  try {
    real = await fsp.realpath(p);
  } catch {
    throw new HttpError(400, `Could not find ${p}`);
  }
  const stat = await fsp.stat(real);
  if (!stat.isFile() && !stat.isDirectory()) throw new HttpError(400, `${p} is not a file or folder.`);
  if (isAppPath(real) || real.endsWith(PART_EXT)) throw new HttpError(400, `${p} is part of DP File Share itself and can't be shared.`);
  return { name: displayName(real), path: real, type: stat.isDirectory() ? 'dir' : 'file' };
}

function expiryFrom(body, fallbackNow = Date.now()) {
  if (body.expiresAt === null) return null; // never
  if (body.expiresAt !== undefined) {
    const at = Number(body.expiresAt);
    if (!Number.isFinite(at) || at <= Date.now()) throw new HttpError(400, 'Pick an expiry time in the future.');
    return at;
  }
  const hours = numberOr(body.expiresInHours, DEFAULT_EXPIRY_HOURS);
  if (!(hours > 0)) throw new HttpError(400, 'Pick how long the link should last.');
  return fallbackNow + hours * 3600 * 1000;
}

function limitFrom(body) {
  if (body.uploadLimitGB === null) return null; // no limit
  const gb = numberOr(body.uploadLimitGB, DEFAULT_UPLOAD_LIMIT_GB);
  if (!(gb > 0)) throw new HttpError(400, 'The upload limit must be more than 0 GB.');
  return Math.round(gb * GB);
}

function stamp(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}${z(d.getMinutes())}`;
}

async function createLink(req, res) {
  const body = await readJSON(req, 256 * 1024);
  const download = body.download === true;
  const upload = body.upload === true;
  if (!download && !upload) throw new HttpError(400, 'Choose download, upload, or both.');

  const items = [];
  if (download) {
    const paths = Array.isArray(body.items) ? body.items : [];
    if (!paths.length) throw new HttpError(400, 'Add at least one file or folder to share.');
    for (const p of paths) {
      const item = await realItem(p);
      if (!items.some((i) => i.path === item.path)) items.push(item);
    }
  }

  let label = String(body.label || '').trim().slice(0, 80);
  if (!label) {
    label = download
      ? items[0].name + (items.length > 1 ? ` + ${items.length - 1} more` : '')
      : `Upload ${stamp()}`;
  }

  let dir = null;
  if (upload) {
    if (body.uploadDir) {
      const target = await realItem(body.uploadDir);
      if (target.type !== 'dir') throw new HttpError(400, 'Uploads need a folder, not a file.');
      dir = target.path;
    } else {
      dir = path.join(UPLOAD_DIR, safeName(download ? `${label} (received)` : label));
    }
  }

  const ip = await getPublicIp(true);
  const link = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(32).toString('base64url'),
    label,
    download,
    upload,
    items,
    uploadDir: dir,
    uploadLimitBytes: upload ? limitFrom(body) : null,
    uploadedBytes: 0,
    pending: [],
    received: [],
    downloads: 0,
    createdAt: Date.now(),
    expiresAt: expiryFrom(body),
    ip,
  };
  links.push(link);
  saveLinks();
  log(`Created link "${label}" (${[download && 'download', upload && 'upload'].filter(Boolean).join(' + ')}), ` +
    `expires ${link.expiresAt ? new Date(link.expiresAt).toLocaleString() : 'never'}`);
  sendJSON(res, 201, adminView(link));
}

async function updateLink(req, res, link) {
  const body = await readJSON(req);
  if (body.extendHours !== undefined) {
    const hours = Number(body.extendHours);
    if (!(hours > 0)) throw new HttpError(400, 'Bad extension');
    link.expiresAt = Math.max(Date.now(), link.expiresAt || Date.now()) + hours * 3600 * 1000;
  } else if (body.expiresAt !== undefined || body.expiresInHours !== undefined) {
    link.expiresAt = expiryFrom(body);
  }
  if (body.expireNow === true) link.expiresAt = Date.now();
  if (body.uploadLimitGB !== undefined && link.upload) link.uploadLimitBytes = limitFrom(body);
  if (typeof body.label === 'string' && body.label.trim()) link.label = body.label.trim().slice(0, 80);
  saveLinks();
  log(`Updated link "${link.label}", expires ${link.expiresAt ? new Date(link.expiresAt).toLocaleString() : 'never'}`);
  sendJSON(res, 200, adminView(link));
}

async function deleteLink(res, link) {
  for (const p of link.pending) {
    if (!busyUploads.has(p.id)) await fsp.unlink(p.partPath).catch(() => {});
  }
  links = links.filter((l) => l !== link);
  saveLinks();
  log(`Deleted link "${link.label}" (files on disk were not touched)`);
  send(res, 204);
}

// Native Windows pickers, shown on this PC.
let picking = false;
async function pick(req, res) {
  if (process.platform !== 'win32') throw new HttpError(501, 'The picker only works on Windows. Paste a path instead.');
  if (picking) throw new HttpError(409, 'A picker is already open. It may be behind other windows.');
  const { kind } = await readJSON(req);
  const owner = '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }';
  const files = [
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Multiselect = $true',
    "$d.Title = 'Choose files to share'",
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write(($d.FileNames -join \"`n\")) }",
  ];
  const folder = [
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$d.Description = '${kind === 'upload-folder' ? 'Choose where uploaded files are saved' : 'Choose a folder to share'}'`,
    `$d.ShowNewFolderButton = $${kind === 'upload-folder'}`,
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
  ];
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    owner,
    ...(kind === 'files' ? files : folder),
  ].join('\n');
  picking = true;
  try {
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
        { timeout: 15 * 60 * 1000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    sendJSON(res, 200, { paths: out.split('\n').map((s) => s.trim()).filter(Boolean) });
  } catch (err) {
    console.error('Picker failed:', err.message);
    throw new HttpError(500, 'Could not open the picker. Paste a path instead.');
  } finally {
    picking = false;
  }
}

async function openFolder(res, link) {
  if (!link.uploadDir) throw new HttpError(400, 'This link has no upload folder.');
  const dir = await uploadDir(link);
  execFile('explorer.exe', [dir], () => {}); // explorer exits with 1 even when it works
  send(res, 204);
}

function shutdown(res) {
  log('Turning off (asked by the share manager or tray)');
  sendJSON(res, 200, { ok: true });
  publicServer.close();
  adminServer.close();
  setTimeout(() => process.exit(0), 300);
}

async function handleAdmin(req, res) {
  securityHeaders(res);
  // Only answer requests addressed to us by our loopback name, which blocks DNS-rebinding tricks.
  const host = String(req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${ADMIN_PORT}` && host !== `localhost:${ADMIN_PORT}`) return send(res, 403, 'Forbidden');

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/') return serveStatic(res, 'admin.html');
  if (m === 'GET' && p === '/assets/style.css') return serveStatic(res, 'style.css');
  if (m === 'GET' && p === '/assets/admin.js') return serveStatic(res, 'admin.js');

  // API calls must come from our own page or the tray (blocks cross-site requests).
  if (!p.startsWith('/api/') || req.headers['x-requested-with'] !== 'fetch') return send(res, 404, 'Not found');
  if (m === 'GET' && p === '/api/status') return status(res);
  if (m === 'GET' && p === '/api/links') {
    await getPublicIp();
    return sendJSON(res, 200, [...links].reverse().map(adminView));
  }
  if (m === 'POST' && p === '/api/links') return createLink(req, res);
  if (m === 'POST' && p === '/api/pick') return pick(req, res);
  if (m === 'POST' && p === '/api/refresh-ip') {
    await getPublicIp(true);
    return status(res);
  }
  if (m === 'POST' && p === '/api/shutdown') return shutdown(res);

  const lm = /^\/api\/links\/([0-9a-f]{12})(\/open)?$/.exec(p);
  const link = lm && findById(lm[1]);
  if (lm && !link) throw new HttpError(404, 'That link no longer exists.');
  if (link && lm[2] && m === 'POST') return openFolder(res, link);
  if (link && !lm[2] && m === 'PATCH') return updateLink(req, res, link);
  if (link && !lm[2] && m === 'DELETE') return deleteLink(res, link);
  send(res, 404, 'Not found');
}

// ---------- certificate ----------

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4')
    .map((i) => i.address);
}

const CERT_NAME = 'DP File Share';
const CERT_DAYS = 825;

// Just enough DER (the binary format certificates are written in) to build one ourselves, so
// nothing like OpenSSL has to be installed.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const len = [];
  if (body.length < 128) len.push(body.length);
  else {
    for (let n = body.length; n > 0; n = Math.floor(n / 256)) len.unshift(n % 256);
    len.unshift(0x80 | len.length);
  }
  return Buffer.concat([Buffer.from([tag]), Buffer.from(len), body]);
}
const derSeq = (...parts) => der(0x30, ...parts);
const derUtf8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const derTime = (d) => der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
function derOid(oid) {
  const n = oid.split('.').map(Number);
  const out = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const bytes = [v & 0x7f];
    for (let rest = v >>> 7; rest > 0; rest >>>= 7) bytes.unshift((rest & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return der(0x06, Buffer.from(out));
}
function derInt(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}

// A self-signed certificate for this PC: localhost, the computer name and its network addresses.
function makeSelfSignedCert() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = derSeq(derOid('1.2.840.10045.4.3.2')); // ECDSA with SHA-256
  const name = derSeq(der(0x31, derSeq(derOid('2.5.4.3'), derUtf8(CERT_NAME))));
  const from = new Date(Date.now() - 24 * 3600 * 1000);
  const to = new Date(Date.now() + CERT_DAYS * 24 * 3600 * 1000);
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;

  const dnsNames = ['localhost', os.hostname(), PUBLIC_HOST].filter((h) => /^[A-Za-z0-9.-]+$/.test(h) && !net.isIP(h));
  const altNames = [
    ...[...new Set(dnsNames)].map((h) => der(0x82, Buffer.from(h, 'ascii'))),
    ...[...new Set(['127.0.0.1', ...lanAddresses()])].map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number)))),
  ];
  const extensions = derSeq(
    derSeq(derOid('2.5.29.17'), der(0x04, derSeq(...altNames))), // names it is valid for
    derSeq(derOid('2.5.29.37'), der(0x04, derSeq(derOid('1.3.6.1.5.5.7.3.1')))), // for web servers
    derSeq(derOid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, derSeq())), // can't sign other certificates
  );
  const body = derSeq(
    der(0xa0, derInt(Buffer.from([2]))), // X.509 version 3
    derInt(serial),
    algorithm,
    name, // issued by itself
    derSeq(derTime(from), derTime(to)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, extensions),
  );
  const signature = crypto.sign('sha256', body, privateKey);
  const cert = derSeq(body, algorithm, der(0x03, Buffer.from([0]), signature));
  const lines = cert.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

// True for a certificate this app made that has run out (or is about to). A certificate you
// supplied yourself is never replaced.
function ownCertExpired() {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(CERT_FILE));
    return x.subject === `CN=${CERT_NAME}` && x.issuer === x.subject && Date.parse(x.validTo) < Date.now() + 7 * 24 * 3600 * 1000;
  } catch {
    return false;
  }
}

function ensureCert() {
  const have = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
  if (have && !ownCertExpired()) return;
  log(have ? 'The self-signed certificate has expired, making a new one...' : 'No certificate found, making a self-signed one...');
  const made = makeSelfSignedCert();
  fs.mkdirSync(path.dirname(CERT_FILE), { recursive: true });
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, made.key, { mode: 0o600 });
  fs.writeFileSync(CERT_FILE, made.cert);
}

// ---------- start ----------

function wrap(handler) {
  return (req, res) => {
    handler(req, res).catch((err) => {
      if (!(err instanceof HttpError)) console.error(err);
      if (res.headersSent) return res.destroy();
      if (req.method === 'PUT' || req.method === 'POST') res.setHeader('Connection', 'close'); // don't wait for an unread body
      const message = err instanceof HttpError ? err.message : 'Internal error';
      if (req.headers['x-requested-with'] === 'fetch') sendJSON(res, err.status || 500, { error: message });
      else send(res, err.status || 500, message);
    });
  };
}

// A stray failed promise is logged instead of taking the whole server (and every transfer) down.
process.on('unhandledRejection', (err) => console.error('Unexpected error:', err));

// Started by the tray app: if the tray goes away without turning sharing off (it crashed or was
// ended from Task Manager), stop too, so nothing keeps sharing with no icon to show it.
const PARENT_PID = Number(process.env.DPFS_PARENT_PID) || 0;
if (PARENT_PID) {
  setInterval(() => {
    try {
      process.kill(PARENT_PID, 0);
    } catch {
      log('The tray app is no longer running, turning off.');
      process.exit(0);
    }
  }, 3000).unref();
}

let tlsOptions;
try {
  ensureCert();
  tlsOptions = { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  https.createServer(tlsOptions).close(); // fails here, with a clear message, if the files are not usable
} catch (err) {
  console.error(`The certificate (${CERT_FILE}) or its key (${KEY_FILE}) could not be used: ${err.message}`);
  console.error('Delete both files to have a new self-signed certificate made, or fix certFile / keyFile in config.json.');
  process.exit(1);
}
const publicServer = https.createServer(tlsOptions, wrap(handlePublic));
publicServer.requestTimeout = 0; // big transfers can take a long time
const adminServer = http.createServer(wrap(handleAdmin));

function fail(what, port) {
  return (err) => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${port} (${what}) is already in use. Is DP File Share already running?`
      : `Could not start the ${what}: ${err.message}`);
    process.exit(1);
  };
}
publicServer.on('error', fail('public server', PORT));
adminServer.on('error', fail('share manager', ADMIN_PORT));

publicServer.listen(PORT, () => {
  adminServer.listen(ADMIN_PORT, '127.0.0.1', async () => {
    log(`DP File Share is on. Private links are served on port ${PORT}.`);
    log(`Share manager (this PC only): http://127.0.0.1:${ADMIN_PORT}`);
    await sweep().catch((err) => console.error('Cleanup failed:', err.message));
    if (PUBLIC_HOST) return log(`Links use the address ${PUBLIC_HOST} (publicHost in config.json).`);
    const ip = await getPublicIp();
    log(ip ? `Public IP: ${ip}` : 'Could not look up the public IP (no internet?). Links will show a placeholder until it works.');
  });
});

setInterval(() => sweep().catch((err) => console.error('Cleanup failed:', err.message)), 3600 * 1000).unref();
