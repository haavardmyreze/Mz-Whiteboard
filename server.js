'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createAuth } = require('./auth');

const PORT = Number(process.env.PORT) || 4680;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.WIPBOARD_DATA || path.join(__dirname, 'data'));
const BOARD_DIR = path.join(DATA_DIR, 'boards');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = (Number(process.env.WIPBOARD_MAX_UPLOAD_MB) || 1024) * 1024 * 1024;
// Uploads arrive in pieces, so a single request never needs to be large (hosting front ends cap it).
const MAX_PART = 64 * 1024 * 1024;

let auth;
try {
  auth = createAuth({
    mode: process.env.AUTH_MODE,
    audience: process.env.IAP_AUDIENCE,
    allowedEmails: process.env.ALLOWED_EMAILS,
    allowedDomains: process.env.ALLOWED_DOMAINS,
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const SAVE_DELAY = 800;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ico': 'image/x-icon',
};
const UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.m4v', '.webm', '.mov']);

for (const dir of [BOARD_DIR, UPLOAD_DIR, TRASH_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------- boards

const ID_RE = /^[\w-]{4,40}$/;
const boards = new Map();

function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function loadBoards() {
  for (const file of fs.readdirSync(BOARD_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(BOARD_DIR, file), 'utf8'));
      if (!ID_RE.test(raw.id)) continue;
      const items = new Map();
      for (const it of raw.items || []) if (it && ID_RE.test(it.id)) items.set(it.id, it);
      boards.set(raw.id, {
        id: raw.id,
        name: raw.name || 'Untitled',
        folderId: raw.folderId || null,
        createdAt: raw.createdAt || Date.now(),
        updatedAt: raw.updatedAt || Date.now(),
        items,
        peers: new Map(),
        presenter: null,
        saveTimer: null,
        saving: Promise.resolve(),
      });
    } catch (err) {
      console.error(`Skipping unreadable board file ${file}: ${err.message}`);
    }
  }
}

function createBoard(name, folderId) {
  const board = {
    id: newId(),
    name: String(name || 'Untitled board').slice(0, 120),
    folderId: folderId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: new Map(),
    peers: new Map(),
    presenter: null,
    saveTimer: null,
    saving: Promise.resolve(),
  };
  boards.set(board.id, board);
  scheduleSave(board);
  return board;
}

function boardFile(board) {
  return path.join(BOARD_DIR, `${board.id}.json`);
}

function serialize(board) {
  return JSON.stringify({
    id: board.id,
    name: board.name,
    folderId: board.folderId || null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    items: [...board.items.values()],
  });
}

function scheduleSave(board, touch = true) {
  if (touch) board.updatedAt = Date.now();
  if (board.saveTimer) return;
  board.saveTimer = setTimeout(() => {
    board.saveTimer = null;
    board.saving = board.saving.then(() => writeBoard(board)).catch((err) => {
      console.error(`Failed to save board ${board.id}: ${err.message}`);
    });
  }, SAVE_DELAY);
}

// Write to a temp file and rename so a crash mid-write never truncates a board.
async function writeBoard(board) {
  if (!boards.has(board.id)) return;
  const file = boardFile(board);
  const tmp = `${file}.tmp`;
  const data = serialize(board);
  await fsp.writeFile(tmp, data);
  try {
    await fsp.rename(tmp, file);
  } catch {
    // Windows can refuse the rename while another process holds the target open.
    await fsp.writeFile(file, data);
    await fsp.rm(tmp, { force: true });
  }
}

function flushAllSync() {
  for (const board of boards.values()) {
    if (!board.saveTimer) continue;
    clearTimeout(board.saveTimer);
    board.saveTimer = null;
    try {
      fs.writeFileSync(boardFile(board), serialize(board));
    } catch (err) {
      console.error(`Failed to save board ${board.id}: ${err.message}`);
    }
  }
}

function boardMeta(board) {
  const thumbs = [];
  let media = 0;
  for (const it of board.items.values()) {
    if (it.type !== 'image' && it.type !== 'video') continue;
    media++;
    if (it.type === 'image' && thumbs.length < 4) thumbs.push(it.prev || it.src);
  }
  return {
    id: board.id,
    name: board.name,
    folderId: board.folderId || null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    count: board.items.size,
    media,
    thumbs,
    online: board.peers.size,
  };
}

function applyOps(board, ops) {
  const applied = [];
  if (!Array.isArray(ops)) return applied;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'add') {
      const it = op.item;
      if (!it || typeof it !== 'object' || !ID_RE.test(it.id) || typeof it.type !== 'string') continue;
      board.items.set(it.id, it);
      applied.push({ t: 'add', item: it });
    } else if (op.t === 'set') {
      const it = board.items.get(op.id);
      if (!it || !op.patch || typeof op.patch !== 'object') continue;
      const patch = {};
      for (const key of Object.keys(op.patch)) {
        if (key === 'id' || key === 'type' || key === '__proto__') continue;
        patch[key] = op.patch[key];
      }
      Object.assign(it, patch);
      applied.push({ t: 'set', id: op.id, patch });
    } else if (op.t === 'del') {
      if (!Array.isArray(op.ids)) continue;
      const ids = op.ids.filter((id) => board.items.delete(id));
      if (ids.length) applied.push({ t: 'del', ids });
    } else if (op.t === 'meta') {
      if (!op.patch || typeof op.patch.name !== 'string') continue;
      board.name = op.patch.name.trim().slice(0, 120) || 'Untitled';
      applied.push({ t: 'meta', patch: { name: board.name } });
    }
  }
  if (applied.length) scheduleSave(board);
  return applied;
}

// ---------------------------------------------------------------- folders

const FOLDER_FILE = path.join(DATA_DIR, 'folders.json');
const folders = new Map();

function loadFolders() {
  try {
    for (const f of JSON.parse(fs.readFileSync(FOLDER_FILE, 'utf8'))) {
      if (!f || !ID_RE.test(f.id)) continue;
      folders.set(f.id, {
        id: f.id,
        name: String(f.name || 'Folder').slice(0, 120),
        parentId: f.parentId || null,
        createdAt: f.createdAt || Date.now(),
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read folders.json: ${err.message}`);
  }
  for (const f of folders.values()) if (f.parentId && !folders.has(f.parentId)) f.parentId = null;
  for (const board of boards.values()) if (board.folderId && !folders.has(board.folderId)) board.folderId = null;
}

function saveFolders() {
  const tmp = `${FOLDER_FILE}.tmp`;
  const data = JSON.stringify([...folders.values()]);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, FOLDER_FILE);
  } catch {
    fs.writeFileSync(FOLDER_FILE, data);
  }
}

// True when `folderId` is `ancestorId` or sits anywhere below it.
function isWithin(folderId, ancestorId) {
  for (let id = folderId, hops = 0; id && hops < 1000; id = folders.get(id)?.parentId, hops++) {
    if (id === ancestorId) return true;
  }
  return false;
}

function cleanName(value, fallback) {
  return String(value ?? '').trim().slice(0, 120) || fallback;
}

// ---------------------------------------------------------------- http

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': MIME['.json'],
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendFile(req, res, file, headers = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    const head = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ...headers,
    };
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    // Range support is what lets browsers scrub through video.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range && (range[1] || range[2])) {
      if (range[1] === '') {
        start = Math.max(0, st.size - Number(range[2]));
      } else {
        start = Number(range[1]);
        if (range[2] !== '') end = Math.min(end, Number(range[2]));
      }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    head['Content-Length'] = st.size === 0 ? 0 : end - start + 1;
    res.writeHead(status, head);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
}

// A file arrives as one or more pieces, POSTed in order to /api/upload?uid=..&offset=..&done=0|1.
// Each piece is stored on its own and joined when the last one lands. Plain uploads (no uid) are a
// single piece. Separate small files, rather than appending, also suit object-storage mounts.
const PARTS_PREFIX = '.parts-';

function handleUpload(req, res, url) {
  const refuse = (status, error) => {
    req.resume();
    return sendJson(res, status, { error });
  };
  const ext = path.extname(url.searchParams.get('name') || '').toLowerCase();
  if (!UPLOAD_EXTS.has(ext)) return refuse(415, `Unsupported file type ${ext || '(none)'}`);
  const uid = url.searchParams.get('uid') || newId(9);
  if (!/^[\w-]{6,40}$/.test(uid)) return refuse(400, 'Bad upload id');
  const offset = Number(url.searchParams.get('offset') || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_UPLOAD) return refuse(400, 'Bad offset');
  const done = url.searchParams.get('done') !== '0';
  if (Number(req.headers['content-length']) > MAX_PART) return refuse(413, 'Piece too large');

  const partsDir = path.join(UPLOAD_DIR, PARTS_PREFIX + uid);
  fs.mkdirSync(partsDir, { recursive: true });
  const partFile = path.join(partsDir, String(offset).padStart(12, '0'));
  const out = fs.createWriteStream(partFile);
  let size = 0;
  let failed = false;

  const fail = (status, message) => {
    if (failed) return;
    failed = true;
    req.unpipe(out);
    out.destroy();
    fs.rm(partFile, { force: true }, () => {});
    if (!res.headersSent) sendJson(res, status, { error: message });
    req.resume();
  };

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_PART) fail(413, 'Piece too large');
  });
  req.on('error', () => fail(400, 'Upload interrupted'));
  req.on('aborted', () => fail(400, 'Upload interrupted'));
  out.on('error', (err) => fail(500, err.message));
  out.on('finish', async () => {
    if (failed) return;
    try {
      if (!done) return sendJson(res, 200, { ok: true, received: offset + size });
      sendJson(res, 200, await assembleUpload(partsDir, ext));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
  });
  req.pipe(out);
}

// Joins the pieces in order, checking none is missing, under a content-addressed name so that
// re-uploading the same file reuses the stored copy.
async function assembleUpload(partsDir, ext) {
  const names = (await fsp.readdir(partsDir)).sort();
  const hash = crypto.createHash('sha1');
  let total = 0;
  const finish = async (tmp) => {
    const name = `${hash.digest('hex').slice(0, 24)}${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, dest);
    await fsp.rm(partsDir, { recursive: true, force: true });
    return { url: `/uploads/${name}`, size: total };
  };

  // The common case, one piece: hash it where it lies and move it into place without copying.
  if (names.length === 1 && Number(names[0]) === 0) {
    const only = path.join(partsDir, names[0]);
    for await (const chunk of fs.createReadStream(only)) {
      total += chunk.length;
      hash.update(chunk);
    }
    return finish(only);
  }

  // Check the pieces line up end to end before anything is written.
  let expected = 0;
  for (const name of names) {
    if (Number(name) !== expected) throw Object.assign(new Error('A piece of the upload is missing'), { status: 409 });
    expected += (await fsp.stat(path.join(partsDir, name))).size;
    if (expected > MAX_UPLOAD) throw Object.assign(new Error('File too large'), { status: 413 });
  }

  const tmp = path.join(UPLOAD_DIR, `.upload-${newId(9)}`);
  const out = fs.createWriteStream(tmp);
  // A failed write is reported through the awaited calls below; this keeps it from escaping as an
  // unhandled event that would take the whole server down.
  out.on('error', () => {});
  try {
    for (const name of names) {
      for await (const chunk of fs.createReadStream(path.join(partsDir, name))) {
        total += chunk.length;
        if (total > MAX_UPLOAD) throw Object.assign(new Error('File too large'), { status: 413 });
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
    return await finish(tmp);
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

// Abandoned uploads (a closed tab, a dropped connection) leave pieces behind; sweep them up.
function cleanStaleUploads() {
  const cutoff = Date.now() - 6 * 3600e3;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    if (!name.startsWith(PARTS_PREFIX) && !name.startsWith('.upload-')) continue;
    const file = path.join(UPLOAD_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { recursive: true, force: true });
    } catch {
      // gone already
    }
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'me') return sendJson(res, 200, { auth: auth.mode, user: req.user || null });
  if (parts[1] === 'library' && req.method === 'GET') {
    return sendJson(res, 200, {
      folders: [...folders.values()],
      boards: [...boards.values()].map(boardMeta).sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }
  if (parts[1] === 'folders') {
    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      const parentId = body.parentId || null;
      if (parentId && !folders.has(parentId)) return sendJson(res, 400, { error: 'Parent folder not found' });
      const folder = { id: newId(), name: cleanName(body.name, 'New folder'), parentId, createdAt: Date.now() };
      folders.set(folder.id, folder);
      saveFolders();
      return sendJson(res, 201, folder);
    }
    const folder = folders.get(parts[2]);
    if (parts.length === 3 && folder) {
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if ('parentId' in body) {
          const parentId = body.parentId || null;
          if (parentId && !folders.has(parentId)) return sendJson(res, 400, { error: 'Folder not found' });
          if (parentId && isWithin(parentId, folder.id)) return sendJson(res, 400, { error: 'A folder cannot be moved into itself' });
          folder.parentId = parentId;
        }
        if ('name' in body) folder.name = cleanName(body.name, folder.name);
        saveFolders();
        return sendJson(res, 200, folder);
      }
      if (req.method === 'DELETE') {
        // Nothing inside is deleted: boards and subfolders move up one level.
        for (const f of folders.values()) if (f.parentId === folder.id) f.parentId = folder.parentId;
        for (const board of boards.values()) {
          if (board.folderId !== folder.id) continue;
          board.folderId = folder.parentId;
          scheduleSave(board, false);
        }
        folders.delete(folder.id);
        saveFolders();
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: 'Folder not found' });
  }
  if (parts[1] === 'boards' && parts.length === 2) {
    if (req.method === 'GET') {
      const list = [...boards.values()].map(boardMeta).sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const folderId = folders.has(body.folderId) ? body.folderId : null;
      return sendJson(res, 201, boardMeta(createBoard(body.name, folderId)));
    }
  }
  if (parts[1] === 'boards' && parts.length === 3) {
    const board = boards.get(parts[2]);
    if (!board) return sendJson(res, 404, { error: 'Board not found' });
    if (req.method === 'GET') return sendJson(res, 200, boardMeta(board));
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if ('folderId' in body) {
        if (body.folderId && !folders.has(body.folderId)) return sendJson(res, 400, { error: 'Folder not found' });
        board.folderId = body.folderId || null;
        scheduleSave(board, false);
      }
      const applied = applyOps(board, [{ t: 'meta', patch: { name: body.name } }]);
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: null });
      return sendJson(res, 200, boardMeta(board));
    }
    if (req.method === 'DELETE') {
      // Soft delete: the JSON is moved to data/trash so a mis-click is recoverable.
      boards.delete(board.id);
      clearTimeout(board.saveTimer);
      board.saveTimer = null;
      await board.saving;
      await fsp.writeFile(path.join(TRASH_DIR, `${board.id}-${Date.now()}.json`), serialize(board));
      await fsp.rm(boardFile(board), { force: true });
      for (const peer of board.peers.values()) peer.ws.close(4004, 'Board deleted');
      return sendJson(res, 200, { ok: true });
    }
  }
  if (parts[1] === 'upload' && req.method === 'POST') return handleUpload(req, res, url);
  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }

  // For the platform's health checks: no login, no data.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  const who = await auth.authenticate(req);
  if (who.status) {
    return sendJson(res, who.status, { error: who.status === 403 ? 'This account is not on the list for these boards' : 'Sign in required' });
  }
  req.user = who.user;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (!res.headersSent) sendJson(res, 400, { error: err.message });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });

  if (pathname.startsWith('/uploads/')) {
    const name = path.basename(pathname);
    if (name.startsWith('.')) return sendJson(res, 404, { error: 'Not found' });
    return sendFile(req, res, path.join(UPLOAD_DIR, name), {
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Uploaded SVGs must never run script when opened directly.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  }

  // The in-browser video encoder, served from the installed package so there is no build step.
  if (pathname === '/vendor/mediabunny.mjs') {
    return sendFile(req, res, path.join(__dirname, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'), { 'Cache-Control': 'public, max-age=86400' });
  }

  let file;
  if (pathname === '/') file = 'index.html';
  else if (/^\/b\/[\w-]+\/?$/.test(pathname)) file = 'board.html';
  else file = pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  sendFile(req, res, full, { 'Cache-Control': 'no-cache' });
});

// Behind a load balancer, keep connections open longer than the balancer does, and let big uploads take their time.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

// ---------------------------------------------------------------- realtime

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const board = url.pathname === '/ws' ? boards.get(url.searchParams.get('board')) : null;
    if (!board) return socket.destroy();
    const who = await auth.authenticate(req);
    if (who.status) {
      socket.write(`HTTP/1.1 ${who.status} Unauthorized\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, board, who.user));
  } catch {
    socket.destroy();
  }
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(board, msg, except) {
  const data = JSON.stringify(msg);
  for (const peer of board.peers.values()) {
    if (peer !== except && peer.ws.readyState === 1) peer.ws.send(data);
  }
}

function publicPeer(peer) {
  return { id: peer.id, name: peer.name, color: peer.color, p: peer.p };
}

function onConnect(ws, board, user) {
  const peer = { id: newId(4), ws, name: 'Guest', color: '#888888', p: {}, joined: false };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'hello') {
      if (peer.joined) return;
      peer.joined = true;
      // Behind a login the identity comes from the sign-in, never from what the browser claims.
      if (user) {
        peer.name = user.name;
        peer.color = user.color;
      } else {
        peer.name = String(msg.name || 'Guest').slice(0, 32);
        if (/^#[0-9a-f]{6}$/i.test(msg.color)) peer.color = msg.color;
      }
      send(ws, {
        t: 'init',
        you: peer.id,
        board: { id: board.id, name: board.name },
        items: [...board.items.values()],
        peers: [...board.peers.values()].map(publicPeer),
        presenter: board.presenter,
      });
      board.peers.set(peer.id, peer);
      broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
      return;
    }
    if (!peer.joined) return;

    if (msg.t === 'op') {
      const applied = applyOps(board, msg.ops);
      // Always ack, even when nothing applied, so the sender's outbox stays in step.
      send(ws, { t: 'ack' });
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: peer.id }, peer);
    } else if (msg.t === 'p') {
      if (!msg.p || typeof msg.p !== 'object') return;
      Object.assign(peer.p, msg.p);
      broadcast(board, { t: 'p', id: peer.id, p: msg.p }, peer);
    } else if (msg.t === 'present') {
      if (msg.on) board.presenter = peer.id;
      else if (board.presenter === peer.id) board.presenter = null;
      else return;
      broadcast(board, { t: 'presenter', id: board.presenter });
    } else if (msg.t === 'laser') {
      if (!Array.isArray(msg.pts)) return;
      const pts = msg.pts.slice(0, 200).filter((n) => Number.isFinite(n));
      if (pts.length >= 2) broadcast(board, { t: 'laser', id: peer.id, pts: pts.slice(0, pts.length - (pts.length % 2)) }, peer);
    } else if (msg.t === 'media') {
      broadcast(board, { t: 'media', from: peer.id, id: msg.id, playing: !!msg.playing, time: Number(msg.time) || 0 }, peer);
    }
  });

  ws.on('close', () => {
    if (!board.peers.delete(peer.id)) return;
    broadcast(board, { t: 'leave', id: peer.id });
    if (board.presenter === peer.id) {
      board.presenter = null;
      broadcast(board, { t: 'presenter', id: null });
    }
  });
  ws.on('error', () => {});
}

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

// ---------------------------------------------------------------- start

loadBoards();
loadFolders();
cleanStaleUploads();
setInterval(cleanStaleUploads, 3600e3).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    flushAllSync();
    process.exit(0);
  });
}
process.on('exit', flushAllSync);

server.listen(PORT, HOST, () => {
  console.log(`Wipboard is running. ${boards.size} board(s) loaded from ${DATA_DIR}. Sign-in: ${auth.mode}`);
  console.log(`  This machine:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  On the network: http://${net.address}:${PORT}`);
    }
  }
  console.log(`  By hostname:   http://${os.hostname()}:${PORT}`);
});
