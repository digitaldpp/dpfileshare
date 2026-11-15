'use strict';
// The page people see when they open a private link.

const token = location.pathname.split('/')[2];
const BASE = `/s/${token}`;
const PIECE = 32 * 1024 * 1024; // uploads go up in 32 MB pieces so a hiccup only repeats one piece
const $ = (id) => document.getElementById(id);

const ICONS = {
  dir: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
};

let info = null;

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { 'X-Requested-With': 'fetch', ...(opts.headers || {}) } });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `Something went wrong (${res.status})`), { status: res.status, data });
  return data;
}

function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDuration(s) {
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${Math.ceil(s)} s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // only ever our own constant icons
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

// ---------- download ----------

// Where we are is kept in the address (#i=0&p=sub/folder) so Back works.
function location_() {
  const h = new URLSearchParams(location.hash.slice(1));
  const i = h.has('i') ? Number(h.get('i')) : null;
  return { i, p: h.get('p') || '' };
}

function go(i, p = '') {
  location.hash = i == null ? '' : `i=${i}${p ? '&p=' + encodeURIComponent(p) : ''}`;
}

function fileUrl(i, p) {
  return `${BASE}/file?item=${i}${p ? '&path=' + encodeURIComponent(p) : ''}`;
}

function crumbs(i, p) {
  const nav = $('crumbs');
  nav.replaceChildren();
  const multi = info.items.length > 1;
  const parts = [];
  if (multi) parts.push(['Everything shared', () => go(null)]);
  if (i != null) {
    const item = info.items[i];
    parts.push([item.name, () => go(i)]);
    const segs = p.split('/').filter(Boolean);
    segs.forEach((s, k) => parts.push([s, () => go(i, segs.slice(0, k + 1).join('/'))]));
  }
  parts.forEach(([label, onclick], k) => {
    if (k) nav.append(el('span', { class: 'sep' }, '›'));
    nav.append(k === parts.length - 1 ? el('span', {}, label) : el('a', { href: '#', onclick: (e) => { e.preventDefault(); onclick(); } }, label));
  });
  nav.hidden = !parts.length;
}

function row(type, name, size, href, onOpen) {
  const nameCell = type === 'dir'
    ? el('a', { href: '#', class: 'name', onclick: (e) => { e.preventDefault(); onOpen(); } }, el('span', { class: 'icon dir', html: ICONS.dir }), name)
    : el('span', { class: 'name' }, el('span', { class: 'icon', html: ICONS.file }), name);
  const action = type === 'file' && href ? el('a', { href, download: '' }, 'Download') : type === 'dir' ? el('a', { href: '#', onclick: (e) => { e.preventDefault(); onOpen(); } }, 'Open') : el('span', { class: 'muted small' }, 'Unavailable');
  return el('tr', {}, el('td', {}, nameCell), el('td', { class: 'size' }, type === 'file' ? formatBytes(size) : ''), el('td', {}, action));
}

function showRows(rows) {
  $('files').querySelector('tbody').replaceChildren(...rows);
  $('files').hidden = !rows.length;
  $('empty').hidden = !!rows.length;
}

async function renderDownload() {
  if (!info.download) return;
  let { i, p } = location_();
  if (i == null && info.items.length === 1 && info.items[0].type === 'dir') i = 0; // a single folder opens straight away
  crumbs(i, p);
  showError('');

  if (i == null) {
    showRows(info.items.map((it) => row(it.type, it.name, it.size, it.available ? fileUrl(it.i) : null, () => go(it.i))));
    return;
  }
  const item = info.items[i];
  if (!item) return go(null);
  if (item.type === 'file') {
    showRows([row('file', item.name, item.size, item.available ? fileUrl(i) : null)]);
    return;
  }
  try {
    const list = await api(`/list?item=${i}${p ? '&path=' + encodeURIComponent(p) : ''}`);
    list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
    showRows(list.map((e) => {
      const rel = p ? `${p}/${e.name}` : e.name;
      return row(e.type, e.name, e.size, fileUrl(i, rel), () => go(i, rel));
    }));
  } catch (err) {
    showRows([]);
    $('empty').hidden = true;
    showError(err.message);
  }
}

// ---------- upload ----------

const queue = [];
let running = false;

function updateRoom() {
  const r = info.uploadRemaining;
  $('room').textContent = r == null ? '' : r === 0 ? 'The upload limit for this link has been reached.' : `Up to ${formatBytes(r)} more can be sent with this link.`;
}

function addFiles(files) {
  for (const file of files) {
    const li = el('li', {},
      el('div', { class: 'top' }, el('span', {}, file.name), el('span', { class: 'muted small' }, formatBytes(file.size))),
      el('progress', { max: '1', value: '0' }),
      el('div', { class: 'state' }, 'Waiting…'));
    $('queue').append(li);
    queue.push({ file, li });
  }
  if (!running) runQueue();
}

function setState(job, text, cls) {
  job.li.querySelector('.state').textContent = text;
  if (cls) job.li.className = cls;
}

function putPiece(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error((data && data.error) || xhr.responseText || `Error ${xhr.status}`), { status: xhr.status, data }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('Connection problem'), { status: 0 }));
    xhr.send(blob);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadOne(job) {
  const { file } = job;
  const key = `dpshare:${token}:${file.name}:${file.size}:${file.lastModified}`;
  let resumeId = null;
  try {
    resumeId = localStorage.getItem(key);
  } catch {}

  const start = await api('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, size: file.size, resumeId }),
  });
  try {
    localStorage.setItem(key, start.id);
  } catch {}
  if (start.done) return start.name;

  let received = start.received;
  let failures = 0;
  const t0 = Date.now();
  const firstByte = received;
  const progress = job.li.querySelector('progress');

  while (received < file.size) {
    const end = Math.min(file.size, received + PIECE);
    try {
      const out = await putPiece(`${BASE}/upload/${start.id}?offset=${received}`, file.slice(received, end), (loaded) => {
        const done = received + loaded;
        progress.value = file.size ? done / file.size : 1;
        const rate = (done - firstByte) / Math.max(1, (Date.now() - t0) / 1000);
        setState(job, `${Math.floor((done / file.size) * 100)}% · ${formatBytes(rate)}/s · ${formatDuration((file.size - done) / rate)} left`);
      });
      received = out.received;
      failures = 0;
      if (out.done) {
        try {
          localStorage.removeItem(key);
        } catch {}
        return out.name;
      }
    } catch (err) {
      if (err.status === 404 || err.status === 403 || err.status === 413 || err.status === 507) throw err;
      if (++failures > 30) throw new Error('The connection keeps dropping. Try again later; it will pick up where it stopped.');
      const wait = Math.min(30, 2 ** Math.min(failures, 5));
      setState(job, `Connection problem, retrying in ${wait} s…`);
      await sleep(wait * 1000);
      try {
        received = (await api(`/upload/${start.id}`)).received; // carry on from what actually arrived
      } catch (e) {
        if (e.status === 404 || e.status === 403) throw e;
      }
    }
  }
  return null;
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    setState(job, 'Starting…');
    try {
      const name = await uploadOne(job);
      job.li.querySelector('progress').value = 1;
      setState(job, name && name !== job.file.name ? `Sent (saved as ${name})` : 'Sent', 'done');
    } catch (err) {
      setState(job, err.message, 'error');
    }
  }
  running = false;
  try {
    info = await api('/info');
    updateRoom();
  } catch {}
}

window.addEventListener('beforeunload', (e) => {
  if (running) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function setupUpload() {
  const drop = $('drop');
  $('picker').addEventListener('change', (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  });
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const entries = [...e.dataTransfer.items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    const files = [...e.dataTransfer.files].filter((_f, k) => !(entries[k] && entries[k].isDirectory));
    if (files.length < e.dataTransfer.files.length) showError('Folders can\'t be dropped here. Open the folder and drop the files inside it instead.');
    if (files.length) addFiles(files);
  });
  updateRoom();
}

// ---------- start ----------

(async () => {
  try {
    info = await api('/info');
  } catch (err) {
    $('title').textContent = 'This link isn\'t available';
    showError(err.message);
    return;
  }
  document.title = info.label;
  $('title').textContent = info.label;
  $('expires').textContent = info.expiresAt
    ? `Link expires ${new Date(info.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
    : '';
  $('download').hidden = !info.download;
  $('upload').hidden = !info.upload;
  if (info.upload) setupUpload();
  if (info.download) {
    window.addEventListener('hashchange', renderDownload);
    renderDownload();
  }
})();
