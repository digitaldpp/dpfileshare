'use strict';
// The share manager: create and manage private links. Only reachable from this PC.

const $ = (id) => document.getElementById(id);
let picked = []; // paths to share
let uploadDir = null; // null = default folder
let status = null;

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { ...opts, headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  } catch {
    $('offline').hidden = false;
    throw new Error('DP File Share is not running.');
  }
  $('offline').hidden = true;
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status})`);
  return data;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
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

const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

function fromNow(t) {
  const s = (t - Date.now()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = el('textarea', {}, text);
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  const old = button.textContent;
  button.textContent = 'Copied';
  setTimeout(() => (button.textContent = old), 1500);
}

// ---------- status ----------

async function loadStatus(refresh) {
  try {
    status = await (refresh ? post('/api/refresh-ip') : api('/api/status'));
  } catch {
    $('address').textContent = 'Sharing is off.';
    return;
  }
  const host = status.publicHost || status.publicIp;
  $('address').textContent = host ? `Public address: ${host}:${status.port}` : 'Could not look up your public IP. Check the internet connection.';
  $('transfers').textContent = status.activeTransfers ? `${status.activeTransfers} transfer${status.activeTransfers === 1 ? '' : 's'} in progress` : '';
}

// ---------- new link form ----------

function renderPicked() {
  $('picked').replaceChildren(...picked.map((p, k) => el('li', {},
    el('span', { class: 'path' }, p),
    el('button', { type: 'button', class: 'link danger small', onclick: () => { picked.splice(k, 1); renderPicked(); } }, 'Remove'))));
  $('picked-empty').hidden = picked.length > 0;
}

function addPaths(paths) {
  for (const p of paths) if (p && !picked.includes(p)) picked.push(p);
  renderPicked();
}

async function pickInto(kind, done) {
  const msg = $('create-msg');
  msg.textContent = '';
  try {
    const { paths } = await post('/api/pick', { kind });
    done(paths);
  } catch (err) {
    msg.textContent = err.message;
  }
}

function syncModes() {
  $('dl-panel').hidden = !$('m-dl').checked;
  $('ul-panel').hidden = !$('m-ul').checked;
}

function renderUploadDir() {
  $('ul-dir').textContent = uploadDir || 'a new folder in your uploads folder';
  $('ul-reset').hidden = !uploadDir;
}

function expiryBody() {
  const v = $('expiry').value;
  if (v === 'never') return { expiresAt: null };
  if (v === 'custom') {
    const t = new Date($('custom').value).getTime();
    if (!Number.isFinite(t)) throw new Error('Pick the date and time the link should expire.');
    return { expiresAt: t };
  }
  return { expiresInHours: Number(v) };
}

async function createLink() {
  const msg = $('create-msg');
  msg.textContent = '';
  const download = $('m-dl').checked;
  const upload = $('m-ul').checked;
  try {
    if (!download && !upload) throw new Error('Tick download, upload, or both.');
    if (download && !picked.length) throw new Error('Add at least one file or folder to share.');
    const body = { download, upload, label: $('label').value, ...expiryBody() };
    if (download) body.items = picked;
    if (upload) {
      body.uploadDir = uploadDir;
      body.uploadLimitGB = $('no-limit').checked ? null : Number($('limit').value);
    }
    $('create').disabled = true;
    const link = await post('/api/links', body);
    $('result').hidden = false;
    $('result-url').value = link.url;
    $('result-note').textContent = [
      link.expiresAt ? `Expires ${when(link.expiresAt)}.` : 'Never expires.',
      link.upload ? `Uploads go to ${link.uploadDir}.` : '',
    ].join(' ');
    $('result-url').select();
    picked = [];
    renderPicked();
    $('label').value = '';
    loadLinks();
  } catch (err) {
    msg.textContent = err.message;
  } finally {
    $('create').disabled = false;
  }
}

// ---------- links list ----------

async function act(link, body) {
  try {
    if (body === 'delete') await api(`/api/links/${link.id}`, { method: 'DELETE' });
    else if (body === 'open') await post(`/api/links/${link.id}/open`);
    else await api(`/api/links/${link.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  } catch (err) {
    alert(err.message);
  }
  loadLinks();
}

function linkCard(link) {
  const expiry = !link.active
    ? el('span', { class: 'error small' }, 'Expired')
    : el('span', { class: 'muted small' }, link.expiresAt ? `Expires in ${fromNow(link.expiresAt)} · ${when(link.expiresAt)}` : 'Never expires');

  const parts = [
    el('div', { class: 'link-head' },
      el('div', { class: 'row' }, el('h3', {}, link.label), el('span', { class: 'badges' },
        link.download && el('span', { class: 'badge dl' }, 'Download'),
        link.upload && el('span', { class: 'badge ul' }, 'Upload'))),
      expiry),
  ];

  if (link.active) {
    const btn = el('button', { type: 'button', class: 'secondary' }, 'Copy');
    btn.addEventListener('click', () => copy(link.url, btn));
    parts.push(el('div', { class: 'url field' }, el('input', { type: 'text', readonly: '', value: link.url }), btn));
    if (link.ipChanged) parts.push(el('p', { class: 'warn small' }, 'Your public IP changed since this link was made. Send this new address; the old one no longer works.'));
  }

  const meta = [];
  if (link.download) {
    parts.push(el('ul', { class: 'items small' }, ...link.items.map((it) => el('li', {}, el('span', { class: 'path' }, it.path), el('span', { class: 'muted' }, it.type === 'dir' ? 'folder' : 'file')))));
    meta.push(`${link.downloads} download${link.downloads === 1 ? '' : 's'} started`);
  }
  if (link.upload) {
    const limit = link.uploadLimitBytes == null ? 'no limit' : `${formatBytes(link.uploadLimitBytes)} limit`;
    meta.push(`${link.received.length} file${link.received.length === 1 ? '' : 's'} received (${formatBytes(link.uploadedBytes)} of ${limit})`);
    if (link.uploading) meta.push(`${link.uploading} upload${link.uploading === 1 ? '' : 's'} unfinished`);
  }
  parts.push(el('p', { class: 'muted small link-meta' }, meta.join(' · ')));

  if (link.upload && link.received.length) {
    parts.push(el('ul', { class: 'items small' }, ...link.received.slice(0, 5).map((r) =>
      el('li', {}, el('span', { class: 'path' }, r.name), el('span', { class: 'muted' }, `${formatBytes(r.size)} · ${when(r.at)}`)))));
  }

  const actions = el('div', { class: 'link-actions small' });
  const action = (label, body, cls = 'link') => actions.append(el('button', { type: 'button', class: cls, onclick: () => act(link, body) }, label));
  if (link.upload) action('Open upload folder', 'open');
  action(link.active ? '+1 day' : 'Turn back on for 1 day', { extendHours: 24 });
  action(link.active ? '+7 days' : 'Turn back on for 7 days', { extendHours: 168 });
  if (link.active) action('Expire now', { expireNow: true }, 'link danger');
  actions.append(el('button', {
    type: 'button',
    class: 'link danger',
    onclick: () => confirm(`Delete the link "${link.label}"? Files on this PC are not touched.`) && act(link, 'delete'),
  }, 'Delete'));
  parts.push(actions);

  return el('div', { class: `link-card${link.active ? '' : ' expired'}` }, ...parts);
}

async function loadLinks() {
  let list;
  try {
    list = await api('/api/links');
  } catch {
    return;
  }
  $('links').replaceChildren(...list.map(linkCard));
  $('no-links').hidden = list.length > 0;
}

// ---------- start ----------

$('m-dl').addEventListener('change', syncModes);
$('m-ul').addEventListener('change', syncModes);
$('add-files').addEventListener('click', () => pickInto('files', addPaths));
$('add-folder').addEventListener('click', () => pickInto('folder', addPaths));
$('add-path-btn').addEventListener('click', () => {
  addPaths([$('add-path').value.trim().replace(/^"(.*)"$/, '$1')]);
  $('add-path').value = '';
});
$('add-path').addEventListener('keydown', (e) => e.key === 'Enter' && $('add-path-btn').click());
$('ul-choose').addEventListener('click', () => pickInto('upload-folder', (paths) => {
  if (paths[0]) uploadDir = paths[0];
  renderUploadDir();
}));
$('ul-reset').addEventListener('click', () => {
  uploadDir = null;
  renderUploadDir();
});
$('no-limit').addEventListener('change', () => ($('limit').disabled = $('no-limit').checked));
$('expiry').addEventListener('change', () => ($('custom').hidden = $('expiry').value !== 'custom'));
$('create').addEventListener('click', createLink);
$('copy-result').addEventListener('click', (e) => copy($('result-url').value, e.target));
$('refresh-ip').addEventListener('click', async () => {
  await loadStatus(true);
  loadLinks();
});

(async () => {
  await loadStatus();
  if (status) {
    $('limit').value = status.defaultUploadLimitGB;
    const opt = [...$('expiry').options].find((o) => o.value === String(status.defaultExpiryHours));
    $('expiry').value = opt ? opt.value : '168';
  } else {
    $('expiry').value = '168';
  }
  renderPicked();
  renderUploadDir();
  syncModes();
  loadLinks();
})();

// Keep counts and received files fresh while the page is open.
setInterval(() => {
  if (document.hidden || document.activeElement?.closest?.('#links')) return;
  loadStatus();
  loadLinks();
}, 5000);
