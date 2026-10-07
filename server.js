'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createAuth, parseCookies } = require('./auth');

// Settings can live in a .env file next to this one (KEY=value per line); real environment variables win.
try {
  for (const line of fs.readFileSync(process.env.WIPBOARD_ENV_FILE || path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
  }
} catch {
  // no .env file
}

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

// Signed sessions need a secret that survives restarts: taken from SESSION_SECRET, else made once and kept.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const made = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, made, { mode: 0o600 });
    return made;
  }
}

let auth;
try {
  auth = createAuth({
    mode: process.env.AUTH_MODE,
    audience: process.env.IAP_AUDIENCE,
    allowedEmails: process.env.ALLOWED_EMAILS,
    allowedDomains: process.env.ALLOWED_DOMAINS,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    publicUrl: process.env.PUBLIC_URL,
    password: process.env.SITE_PASSWORD,
    sessionSecret: ['google', 'password'].includes(process.env.AUTH_MODE) ? sessionSecret() : null,
  });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
// View-only links work wherever this app decides who gets in; behind IAP the platform does, and it cannot let anonymous people through.
const SHARING = auth.mode !== 'iap';
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
  '.woff2': 'font/woff2',
};
const UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.m4v', '.webm', '.mov']);

for (const dir of [BOARD_DIR, UPLOAD_DIR, TRASH_DIR]) fs.mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------- boards

const ID_RE = /^[\w-]{4,40}$/;
const boards = new Map();

// Workspaces: "myreze" is shared by everyone who can sign in; "u:<email>" is one person's own space.
// Stored with the full key, but people only ever see "myreze" and "personal", and only their own.
const PERSONAL = 'u:';
const validSpace = (key) => key === 'myreze' || (typeof key === 'string' && key.startsWith(PERSONAL) && key.length > 3);
const spaceKey = (name, user) => (name === 'personal' && user ? PERSONAL + user.id : 'myreze');
const spaceName = (key) => (key === 'myreze' ? 'myreze' : 'personal');
const canSee = (user, key) => key === 'myreze' || (!!user && key === PERSONAL + user.id);
const visible = (user, board) => !!board && canSee(user, board.workspace);

// Read-only links: the secret in /s/<token> -> the board it opens.
const SHARE_RE = /^[\w-]{16,64}$/;
const shares = new Map();

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
        workspace: validSpace(raw.workspace) ? raw.workspace : 'myreze',
        shareToken: typeof raw.shareToken === 'string' && SHARE_RE.test(raw.shareToken) ? raw.shareToken : null,
        createdAt: raw.createdAt || Date.now(),
        updatedAt: raw.updatedAt || Date.now(),
        items,
        peers: new Map(),
        presenter: null,
        saveTimer: null,
        saving: Promise.resolve(),
      });
      const loaded = boards.get(raw.id);
      if (loaded.shareToken) shares.set(loaded.shareToken, loaded);
    } catch (err) {
      console.error(`Skipping unreadable board file ${file}: ${err.message}`);
    }
  }
}

function createBoard(name, folderId, workspace = 'myreze') {
  const board = {
    id: newId(),
    name: String(name || 'Untitled board').slice(0, 120),
    folderId: folderId || null,
    workspace,
    shareToken: null,
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
    workspace: board.workspace,
    shareToken: board.shareToken || null,
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
    workspace: spaceName(board.workspace),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    count: [...board.items.values()].filter((it) => it.type !== 'comment').length,
    media,
    thumbs,
    online: [...board.peers.values()].filter((p) => !p.viewer).length,
    shareToken: board.shareToken || null,
  };
}

// A comment is built from scratch rather than copied: who wrote it comes from the connection, not
// from what the browser claims, and only the fields a comment has are kept.
function cleanComment(it, peer) {
  const text = typeof it.text === 'string' ? it.text.trim().slice(0, 2000) : '';
  if (!text) return null;
  const now = Date.now();
  const num = (v) => (Number.isFinite(v) ? v : null);
  // A comment belongs to one piece of content, never to a spot on the board.
  if (typeof it.on !== 'string' || !ID_RE.test(it.on)) return null;
  const clean = {
    id: it.id,
    type: 'comment',
    text,
    name: peer ? peer.name : 'Guest',
    color: peer ? peer.color : '#888888',
    // Keep the author's own clock when it is plausible so every screen numbers the pins the same way,
    // and so a deleted comment that is undone gets its old place back.
    t: Number.isFinite(it.t) && it.t > 1.6e12 && it.t < now + 10 * 60 * 1000 ? Math.round(it.t) : now,
    on: it.on,
    done: it.done === true,
  };
  if (typeof it.re === 'string' && ID_RE.test(it.re)) clean.re = it.re;
  clean.rx = Math.min(1, Math.max(0, num(it.rx) ?? 0.5));
  clean.ry = Math.min(1, Math.max(0, num(it.ry) ?? 0.5));
  if (num(it.at) !== null && it.at >= 0) clean.at = it.at;
  return clean;
}

function applyOps(board, ops, peer) {
  const applied = [];
  if (!Array.isArray(ops)) return applied;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'add') {
      let it = op.item;
      if (!it || typeof it !== 'object' || !ID_RE.test(it.id) || typeof it.type !== 'string') continue;
      if (it.type === 'comment') {
        if (board.items.has(it.id)) continue;
        it = cleanComment(it, peer);
        if (!it) continue;
      }
      board.items.set(it.id, it);
      applied.push({ t: 'add', item: it });
    } else if (op.t === 'set') {
      const it = board.items.get(op.id);
      if (!it || !op.patch || typeof op.patch !== 'object') continue;
      const patch = {};
      for (const key of Object.keys(op.patch)) {
        if (key === 'id' || key === 'type' || key === '__proto__') continue;
        // The one thing about a comment that changes is whether it has been dealt with.
        if (it.type === 'comment' && key !== 'done') continue;
        patch[key] = op.patch[key];
      }
      if (it.type === 'comment') {
        if (!('done' in patch)) continue;
        patch.done = !!patch.done;
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
        workspace: validSpace(f.workspace) ? f.workspace : 'myreze',
        createdAt: f.createdAt || Date.now(),
      });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Could not read folders.json: ${err.message}`);
  }
  for (const f of folders.values()) if (f.parentId && folders.get(f.parentId)?.workspace !== f.workspace) f.parentId = null;
  for (const board of boards.values()) if (board.folderId && folders.get(board.folderId)?.workspace !== board.workspace) board.folderId = null;
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

const publicFolder = (f) => ({ id: f.id, name: f.name, parentId: f.parentId, workspace: spaceName(f.workspace), createdAt: f.createdAt });

// Moves a folder, everything below it and the boards in them to another workspace; it lands at the top level there.
function moveFolderToSpace(folder, key) {
  const moved = new Set();
  const collect = (id) => {
    moved.add(id);
    for (const f of folders.values()) if (f.parentId === id) collect(f.id);
  };
  collect(folder.id);
  for (const id of moved) folders.get(id).workspace = key;
  folder.parentId = null;
  for (const board of boards.values()) {
    if (!board.folderId || !moved.has(board.folderId)) continue;
    board.workspace = key;
    scheduleSave(board, false);
  }
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

const visibleFolder = (user, id) => folders.has(id) && canSee(user, folders.get(id).workspace);

function revokeShare(board) {
  if (board.shareToken) shares.delete(board.shareToken);
  board.shareToken = null;
  scheduleSave(board, false);
  for (const peer of [...board.peers.values()]) if (peer.viewer) peer.ws.close(4005, 'Link no longer shared');
}

const VIEW_COOKIE = 'wb_view';
const secureCookie = (req) => ((auth.publicUrl && auth.publicUrl.startsWith('https://')) || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
// Someone who opened a live read-only link may load the files on that board without being signed in.
const viewingShare = (req) => SHARING && shares.has(parseCookies(req.headers.cookie)[VIEW_COOKIE]);

// Where a read-only link can be opened from: the public address when there is one, otherwise this
// machine's network addresses, never "localhost", which only means "this computer" to whoever opens it.
function shareBases() {
  if (auth.publicUrl && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(auth.publicUrl)) return [auth.publicUrl];
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) ips.push(net.address);
  }
  return ips.sort((a, b) => rank(a) - rank(b)).map((ip) => `http://${ip}:${PORT}`);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (parts[1] === 'me') {
    return sendJson(res, 200, { auth: auth.mode, user: req.user || null, canShare: SHARING, publicUrl: auth.publicUrl || null, shareBases: shareBases(), signOut: !!auth.interactive });
  }
  if (parts[1] === 'library' && req.method === 'GET') {
    return sendJson(res, 200, {
      folders: [...folders.values()].filter((f) => canSee(req.user, f.workspace)).map(publicFolder),
      boards: [...boards.values()].filter((b) => visible(req.user, b)).map(boardMeta).sort((a, b) => b.updatedAt - a.updatedAt),
    });
  }
  if (parts[1] === 'folders') {
    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      const parentId = body.parentId || null;
      if (parentId && !visibleFolder(req.user, parentId)) return sendJson(res, 400, { error: 'Parent folder not found' });
      // A folder belongs to the workspace of the folder it is made in.
      const workspace = parentId ? folders.get(parentId).workspace : spaceKey(body.workspace, req.user);
      const folder = { id: newId(), name: cleanName(body.name, 'New folder'), parentId, workspace, createdAt: Date.now() };
      folders.set(folder.id, folder);
      saveFolders();
      return sendJson(res, 201, publicFolder(folder));
    }
    const folder = visibleFolder(req.user, parts[2]) ? folders.get(parts[2]) : null;
    if (parts.length === 3 && folder) {
      if (req.method === 'PATCH') {
        const body = await readJson(req);
        if ('parentId' in body) {
          const parentId = body.parentId || null;
          if (parentId && !visibleFolder(req.user, parentId)) return sendJson(res, 400, { error: 'Folder not found' });
          if (parentId && folders.get(parentId).workspace !== folder.workspace) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
          if (parentId && isWithin(parentId, folder.id)) return sendJson(res, 400, { error: 'A folder cannot be moved into itself' });
          folder.parentId = parentId;
        }
        if ('workspace' in body) {
          const key = spaceKey(body.workspace, req.user);
          if (body.workspace === 'personal' && !req.user) return sendJson(res, 400, { error: 'Personal workspaces need sign-in' });
          if (key !== folder.workspace) moveFolderToSpace(folder, key);
        }
        if ('name' in body) folder.name = cleanName(body.name, folder.name);
        saveFolders();
        return sendJson(res, 200, publicFolder(folder));
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
      const list = [...boards.values()].filter((b) => visible(req.user, b)).map(boardMeta).sort((a, b) => b.updatedAt - a.updatedAt);
      return sendJson(res, 200, list);
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const folderId = visibleFolder(req.user, body.folderId) ? body.folderId : null;
      const workspace = folderId ? folders.get(folderId).workspace : spaceKey(body.workspace, req.user);
      return sendJson(res, 201, boardMeta(createBoard(body.name, folderId, workspace)));
    }
  }
  // A read-only link for a board: anyone holding it can watch, nobody holding it can change anything.
  if (parts[1] === 'boards' && parts.length === 4 && parts[3] === 'share') {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board) || !SHARING) return sendJson(res, 404, { error: 'Board not found' });
    if (req.method === 'POST') {
      if (!board.shareToken) {
        board.shareToken = newId(16);
        shares.set(board.shareToken, board);
        scheduleSave(board, false);
      }
      return sendJson(res, 200, { token: board.shareToken });
    }
    if (req.method === 'DELETE') {
      revokeShare(board);
      return sendJson(res, 200, { ok: true });
    }
  }
  if (parts[1] === 'boards' && parts.length === 3) {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board)) return sendJson(res, 404, { error: 'Board not found' });
    if (req.method === 'GET') return sendJson(res, 200, boardMeta(board));
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if ('workspace' in body) {
        const key = spaceKey(body.workspace, req.user);
        if (body.workspace === 'personal' && !req.user) return sendJson(res, 400, { error: 'Personal workspaces need sign-in' });
        if (key !== board.workspace) {
          board.workspace = key;
          board.folderId = null;
          scheduleSave(board, false);
        }
      }
      if ('folderId' in body) {
        if (body.folderId && !visibleFolder(req.user, body.folderId)) return sendJson(res, 400, { error: 'Folder not found' });
        if (body.folderId && folders.get(body.folderId).workspace !== board.workspace) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
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
      if (board.shareToken) shares.delete(board.shareToken);
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
  // Used by stop.bat: only accepted from this machine, so nobody on the network can stop it.
  if (pathname === '/__shutdown' && req.method === 'POST') {
    const addr = req.socket.remoteAddress || '';
    // A tunnel or proxy on this machine also arrives from loopback, but it adds forwarding headers.
    const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
    if (proxied || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr)) return sendJson(res, 403, { error: 'Local only' });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('stopping');
    console.log('\nStop requested from this machine. Saving boards and shutting down...');
    setTimeout(() => process.exit(0), 100);
    return;
  }
  // Read-only links need no sign-in: the page, and the board's name for it.
  if (SHARING && (req.method === 'GET' || req.method === 'HEAD')) {
    const link = /^\/s\/([\w-]{16,64})\/?$/.exec(pathname);
    if (link) {
      const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      if (shares.has(link[1])) headers['Set-Cookie'] = `${VIEW_COOKIE}=${link[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureCookie(req)}`;
      return sendFile(req, res, path.join(PUBLIC_DIR, 'board.html'), headers);
    }
    const shared = /^\/api\/shared\/([\w-]{16,64})$/.exec(pathname);
    if (shared) {
      const board = shares.get(shared[1]);
      return board ? sendJson(res, 200, { name: board.name }) : sendJson(res, 404, { error: 'This link is not shared any more' });
    }
  }
  if (auth.handle && (await auth.handle(req, res, url))) return;

  // Pages, data and files need a signed-in user. The scripts, styles and fonts do not, so the sign-in page can use them.
  const isPage = pathname === '/' || /^\/b\/[\w-]+\/?$/.test(pathname) || pathname === '/index.html' || pathname === '/board.html';
  const guarded = auth.mode === 'iap' || isPage || pathname.startsWith('/api/') || pathname.startsWith('/uploads/');
  if (guarded) {
    const who = await auth.authenticate(req);
    if (who.status && !(pathname.startsWith('/uploads/') && viewingShare(req))) {
      if (auth.interactive && isPage) {
        res.writeHead(302, { Location: who.status === 403 ? '/auth/login?error=not-allowed' : `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendJson(res, who.status, { error: who.status === 403 ? 'This account is not on the list for these boards' : 'Sign in required' });
    }
    req.user = who.user;
  }

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
  else if (pathname === '/auth/login') file = 'login.html';
  else if (/^\/b\/[\w-]+\/?$/.test(pathname)) file = 'board.html';
  else file = pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  // The typeface never changes under the same name, so browsers may keep it.
  sendFile(req, res, full, { 'Cache-Control': file.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
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
    if (url.pathname !== '/ws') return socket.destroy();
    const shared = url.searchParams.get('share');
    if (shared) {
      const viewed = SHARING ? shares.get(shared) : null;
      if (!viewed) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, viewed, null, true));
    }
    const board = boards.get(url.searchParams.get('board'));
    if (!board) return socket.destroy();
    // A page on another site must not be able to open a signed-in visitor's session as a board connection.
    if (auth.interactive && req.headers.origin) {
      const origin = new URL(req.headers.origin).host;
      if (origin !== req.headers.host && !(auth.publicUrl && origin === new URL(auth.publicUrl).host)) return socket.destroy();
    }
    const who = await auth.authenticate(req);
    if (who.status) {
      socket.write(`HTTP/1.1 ${who.status} Unauthorized\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    if (!visible(who.user, board)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, board, who.user));
  } catch {
    socket.destroy();
  }
});

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// What people holding a read-only link are shown: the board, without the team's comments.
const hiddenFromViewers = (board, op) => (op.t === 'add' ? op.item.type === 'comment' : op.t === 'set' && board.items.get(op.id)?.type === 'comment');

function broadcast(board, msg, except) {
  const data = JSON.stringify(msg);
  let viewerData;
  for (const peer of board.peers.values()) {
    if (peer === except || peer.ws.readyState !== 1) continue;
    if (!peer.viewer || msg.t !== 'op') {
      peer.ws.send(data);
      continue;
    }
    if (viewerData === undefined) {
      const ops = msg.ops.filter((op) => !hiddenFromViewers(board, op));
      viewerData = ops.length ? JSON.stringify({ ...msg, ops }) : null;
    }
    if (viewerData) peer.ws.send(viewerData);
  }
}

const VIEWER_COLORS = ['#8bb6e8', '#74c2b9', '#aa9ce6', '#e4c978', '#e090b8', '#82c79b'];

function publicPeer(peer) {
  return { id: peer.id, name: peer.name, color: peer.color, p: peer.p, viewer: !!peer.viewer };
}

function onConnect(ws, board, user, viewer = false) {
  const peer = { id: newId(4), ws, name: 'Guest', color: '#888888', p: {}, joined: false, viewer };
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
      if (viewer) {
        // Someone holding a read-only link: seen only as a pointer. They cannot change anything.
        board.viewerSeq = (board.viewerSeq || 0) + 1;
        // They give a name when they open the link; nobody vouches for it, so it is only a label.
        peer.name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || `Viewer ${board.viewerSeq}`;
        peer.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : VIEWER_COLORS[(board.viewerSeq - 1) % VIEWER_COLORS.length];
        send(ws, {
          t: 'init',
          you: peer.id,
          board: { name: board.name },
          items: [...board.items.values()].filter((it) => it.type !== 'comment'),
          peers: [...board.peers.values()].map(publicPeer),
          presenter: board.presenter,
        });
        board.peers.set(peer.id, peer);
        broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
        return;
      }
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
        peers: [...board.peers.values()].filter((p) => !p.viewer).map(publicPeer),
        presenter: board.presenter,
      });
      board.peers.set(peer.id, peer);
      broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
      return;
    }
    if (!peer.joined) return;
    // A viewer may show a pointer and use the laser, nothing else.
    if (peer.viewer && msg.t !== 'laser' && msg.t !== 'p') return;

    if (msg.t === 'op') {
      const applied = applyOps(board, msg.ops, peer);
      // Always ack, even when nothing applied, so the sender's outbox stays in step.
      send(ws, { t: 'ack' });
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: peer.id }, peer);
    } else if (msg.t === 'p') {
      if (!msg.p || typeof msg.p !== 'object') return;
      const p = peer.viewer ? { c: msg.p.c, l: msg.p.l } : msg.p;
      if (peer.viewer) {
        if (!Array.isArray(p.c) || !p.c.every(Number.isFinite)) delete p.c;
        if (p.l !== undefined) p.l = p.l ? 1 : 0;
        for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
        if (!Object.keys(p).length) return;
      }
      Object.assign(peer.p, p);
      broadcast(board, { t: 'p', id: peer.id, p }, peer);
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
