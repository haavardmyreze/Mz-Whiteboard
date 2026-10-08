'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createAuth, parseCookies } = require('./auth');
const { openStore } = require('./store');
const { noticesFor, markRead } = require('./notifications');
const { createAdmin } = require('./admin');

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
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_UPLOAD = (Number(process.env.WIPBOARD_MAX_UPLOAD_MB) || 1024) * 1024 * 1024;
// Uploads arrive in pieces, so a single request never needs to be large (hosting front ends cap it).
const MAX_PART = 64 * 1024 * 1024;

// Signed sessions need a secret that survives restarts: taken from SESSION_SECRET, else made once and kept.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (kept) return kept;
  } catch {
    // none kept yet
  }
  const made = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, made, { mode: 0o600 });
  return made;
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
const SAVE_RETRY = 5000;
// A board nobody has had open for this long is let go of; its items are read back when somebody opens it.
const IDLE_UNLOAD = Number(process.env.WIPBOARD_IDLE_MS) || 5 * 60 * 1000;

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

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
let store;
try {
  store = openStore(DATA_DIR);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------- boards

const ID_RE = /^[\w-]{4,40}$/;
const boards = new Map();

// Workspaces: "myreze" is shared by everyone who can sign in; "u:<email>" is one person's own space.
// Stored with the full key, but people only ever see "myreze" and "personal", and only their own.
const PERSONAL = 'u:';
const spaceKey = (name, user) => (name === 'personal' && user ? PERSONAL + user.id : 'myreze');
const spaceName = (key) => (key === 'myreze' ? 'myreze' : 'personal');
const canSee = (user, key) => key === 'myreze' || (!!user && key === PERSONAL + user.id);
const visible = (user, board) => !!board && canSee(user, board.workspace);

// Read-only links: the secret in /s/<token> -> the board it opens.
const shares = new Map();

function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function cleanName(value, fallback) {
  return String(value ?? '').trim().slice(0, 120) || fallback;
}

// A board as it is held in memory: what is saved, plus who is on it and where its saving stands. Every
// board's details are always here; its items only while somebody has it open (`items` is null otherwise).
function boardRecord(saved, items = null) {
  return {
    ...saved,
    items,
    summary: null,
    lastUsed: Date.now(),
    peers: new Map(),
    viewerSeq: 0,
    removedComments: new Map(),
    // What has changed since the last write: items to write, items to remove, and who added each new one.
    changed: new Set(),
    removed: new Set(),
    creators: new Map(),
    saveTimer: null,
    dirty: false,
  };
}

function loadBoards() {
  const summaries = store.summaries();
  for (const saved of store.boards()) {
    const board = boardRecord(saved);
    board.summary = summaries.get(board.id) || { count: 0, thumbs: [] };
    boards.set(board.id, board);
    if (board.shareToken) shares.set(board.shareToken, board);
  }
}

// A board's items, read in when somebody opens it.
function openItems(board) {
  board.lastUsed = Date.now();
  if (board.items) return board;
  board.items = new Map(store.loadItems(board.id).map((it) => [it.id, it]));
  return board;
}

// Boards nobody is on and nothing is waiting to be written for are let go of after a while.
function unloadIdle() {
  const cutoff = Date.now() - IDLE_UNLOAD;
  for (const board of boards.values()) {
    if (!board.items || board.peers.size || board.dirty || board.saveTimer || board.lastUsed > cutoff) continue;
    board.summary = summarize(board);
    board.items = null;
    board.removedComments.clear();
  }
}

function createBoard(name, folderId, workspace = 'myreze', by = null) {
  const board = boardRecord({
    id: newId(),
    name: cleanName(name, 'Untitled board'),
    folderId: folderId || null,
    workspace,
    shareToken: null,
    createdAt: Date.now(),
    createdBy: by,
    updatedAt: Date.now(),
  }, new Map());
  boards.set(board.id, board);
  scheduleSave(board);
  return board;
}

// `dirty` means memory holds something the database does not. Writes are quick and happen in one go,
// so a change can never land halfway through one.
function scheduleSave(board, touch = true, delay = SAVE_DELAY) {
  if (touch) board.updatedAt = Date.now();
  board.dirty = true;
  if (board.saveTimer) return;
  board.saveTimer = setTimeout(() => {
    board.saveTimer = null;
    try {
      writeBoard(board);
    } catch (err) {
      console.error(`Failed to save board ${board.id}: ${err.message}. Trying again shortly.`);
      // The changes are still in memory: keep trying rather than wait for somebody's next edit.
      scheduleSave(board, false, SAVE_RETRY);
    }
  }, delay);
}

function writeBoard(board) {
  if (!board.dirty || boards.get(board.id) !== board || !store.isOpen()) return;
  const changed = board.items ? [...board.changed].map((id) => board.items.get(id)).filter(Boolean) : [];
  store.saveBoard(board, changed, [...board.removed], board.creators);
  board.dirty = false;
  board.changed.clear();
  board.removed.clear();
  board.creators.clear();
}

// Everything still waiting, written now: before a search, so it sees the latest, and on the way out.
function flushAll() {
  for (const board of boards.values()) {
    clearTimeout(board.saveTimer);
    board.saveTimer = null;
    try {
      writeBoard(board);
    } catch (err) {
      console.error(`Failed to save board ${board.id}: ${err.message}`);
      scheduleSave(board, false, SAVE_RETRY);
    }
  }
}

function summarize(board) {
  if (!board.items) return board.summary || { count: 0, thumbs: [] };
  const thumbs = [];
  let count = 0;
  for (const it of board.items.values()) {
    // What somebody would call an item: not the comments on it, nor each stroke of a drawing.
    if (it.type !== 'comment' && it.type !== 'stroke') count++;
    if (thumbs.length === 4) continue;
    // The small still made when it was uploaded; an image small enough to have none shows its preview or itself.
    const still = it.th || (it.type === 'image' ? it.prev || it.src : null);
    if (typeof still === 'string') thumbs.push(still);
  }
  return { count, thumbs };
}

function boardMeta(board) {
  const { count, thumbs } = summarize(board);
  return {
    id: board.id,
    name: board.name,
    folderId: board.folderId || null,
    workspace: spaceName(board.workspace),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    count,
    thumbs,
    online: [...board.peers.values()].filter((p) => !p.viewer).length,
    share: shareInfo(board),
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
  // Written by somebody with a link, under a name they typed themselves.
  if (peer && peer.viewer) clean.guest = true;
  if (typeof it.re === 'string' && ID_RE.test(it.re)) clean.re = it.re;
  // Where on the piece it points, when it points at a spot: a comment can also be about the piece as a whole.
  if (num(it.rx) !== null && num(it.ry) !== null) {
    clean.rx = Math.min(1, Math.max(0, it.rx));
    clean.ry = Math.min(1, Math.max(0, it.ry));
  }
  if (num(it.at) !== null && it.at >= 0) clean.at = it.at;
  // On a video whose frame rate is known, the exact frame as well.
  if (Number.isSafeInteger(it.fr) && it.fr >= 0) clean.fr = it.fr;
  return clean;
}

// Comments deleted since the server started, so undoing a delete brings each one back exactly as it
// was written. Without this the server would stamp it with whoever pressed undo.
const REMOVED_COMMENTS_KEPT = 500;
function rememberComment(board, comment) {
  board.removedComments.set(comment.id, comment);
  if (board.removedComments.size > REMOVED_COMMENTS_KEPT) board.removedComments.delete(board.removedComments.keys().next().value);
}

// `touch` is false for housekeeping a browser does by itself, which must not make the board look edited.
function applyOps(board, ops, peer, touch = true) {
  const applied = [];
  if (!Array.isArray(ops)) return applied;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'add') {
      let it = op.item;
      if (!it || typeof it !== 'object' || !ID_RE.test(it.id) || typeof it.type !== 'string') continue;
      if (it.type === 'comment') {
        if (board.items.has(it.id)) continue;
        it = board.removedComments.get(it.id) || cleanComment(it, peer);
        if (!it) continue;
        board.removedComments.delete(it.id);
      }
      board.items.set(it.id, it);
      board.changed.add(it.id);
      board.removed.delete(it.id);
      if (peer && !board.creators.has(it.id)) board.creators.set(it.id, peer.name);
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
      board.changed.add(op.id);
      applied.push({ t: 'set', id: op.id, patch });
    } else if (op.t === 'del') {
      if (!Array.isArray(op.ids)) continue;
      const ids = op.ids.filter((id) => {
        const gone = board.items.get(id);
        if (gone && gone.type === 'comment') rememberComment(board, gone);
        if (!board.items.delete(id)) return false;
        board.changed.delete(id);
        board.removed.add(id);
        board.creators.delete(id);
        return true;
      });
      if (ids.length) applied.push({ t: 'del', ids });
    } else if (op.t === 'meta') {
      if (!op.patch || typeof op.patch.name !== 'string') continue;
      board.name = cleanName(op.patch.name, 'Untitled');
      applied.push({ t: 'meta', patch: { name: board.name } });
    }
  }
  if (applied.length) scheduleSave(board, touch);
  return applied;
}

// ---------------------------------------------------------------- folders

const folders = new Map();

function loadFolders() {
  for (const f of store.folders()) folders.set(f.id, f);
}

function saveFolders() {
  store.saveFolders([...folders.values()]);
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
    dropStrangers(board);
  }
}

// ---------------------------------------------------------------- admin

// People, groups and permissions: see admin.js. Permissions go on the boards and folders of the shared workspace.
const admin = createAdmin({
  store, adminEmails: process.env.ADMIN_EMAILS, newId, readJson, sendJson, cleanName, sameOrigin: fromOurPages,
  local: (req) => auth.mode === 'none' && fromThisMachine(req),
  targets: () => ({
    boards: [...boards.values()].filter((b) => b.workspace === 'myreze').map((b) => ({ id: b.id, name: b.name, folderId: b.folderId || null })),
    folders: [...folders.values()].filter((f) => f.workspace === 'myreze').map((f) => ({ id: f.id, name: f.name, parentId: f.parentId || null })),
  }),
});

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

// An error that is the caller's doing and is told to them as it is. Anything else is ours: logged, and
// answered with a plain 500.
const refusal = (status, message) => Object.assign(new Error(message), { status });

// The body of a request as an object: handlers look fields up in it without checking what they got.
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(refusal(413, 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body = {};
      try {
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(refusal(400, 'The request body is not valid JSON'));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(refusal(400, 'The request body must be a JSON object'));
      resolve(body);
    });
    req.on('error', () => reject(refusal(400, 'Request interrupted')));
  });
}

function sendFile(req, res, file, headers = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'Not found' });
    // Unchanged since the browser last fetched it: say so instead of sending it all again.
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, ...headers });
      return res.end();
    }
    const head = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      ETag: etag,
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
  req.on('close', () => {
    if (!req.complete) fail(400, 'Upload interrupted');
  });
  out.on('error', (err) => fail(500, err.message));
  out.on('finish', async () => {
    if (failed) return;
    try {
      if (!done) return sendJson(res, 200, { ok: true, received: offset + size });
      sendJson(res, 200, await assembleUpload(partsDir, ext, req.user));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    }
  });
  req.pipe(out);
}

// Joins the pieces in order, checking none is missing, under a content-addressed name so that
// re-uploading the same file reuses the stored copy.
async function assembleUpload(partsDir, ext, user) {
  const names = (await fsp.readdir(partsDir)).sort();
  const hash = crypto.createHash('sha1');
  let total = 0;
  const finish = async (tmp) => {
    const name = `${hash.digest('hex').slice(0, 24)}${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, dest);
    await fsp.rm(partsDir, { recursive: true, force: true });
    store.addMedia({ name, size: total, by: user ? user.name : null });
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

// What people holding a board's link may do: look ('view'), also read the team's comments
// ('comments'), or also comment themselves ('comment').
const SHARE_ACCESS = ['view', 'comments', 'comment'];
const shareInfo = (board) => (board.shareToken ? { token: board.shareToken, access: board.shareAccess, expiresAt: board.shareExpires || null } : { token: null });

// The board a link opens, while it is shared and has not run out.
function sharedBoard(token) {
  const board = SHARING && token ? shares.get(token) : null;
  if (!board || (board.shareExpires && board.shareExpires <= Date.now())) return null;
  return board;
}

const closeViewers = (board, code, reason) => {
  for (const peer of [...board.peers.values()]) if (peer.viewer) peer.ws.close(code, reason);
};

function revokeShare(board) {
  if (board.shareToken) shares.delete(board.shareToken);
  board.shareToken = null;
  scheduleSave(board, false);
  closeViewers(board, 4005, 'Link no longer shared');
}

// Links that ran out while somebody was watching stop working for them too.
function closeExpiredLinks() {
  for (const board of boards.values()) if (board.shareToken && !sharedBoard(board.shareToken)) closeViewers(board, 4005, 'Link no longer shared');
}

// Changes what a link allows and when it runs out. Whoever is watching is sent to reload, so they see the board as now shared.
function setShare(board, body) {
  const before = `${board.shareAccess}:${board.shareExpires || ''}`;
  if (SHARE_ACCESS.includes(body.access)) board.shareAccess = body.access;
  if ('expiresAt' in body) board.shareExpires = Number.isSafeInteger(body.expiresAt) && body.expiresAt > Date.now() ? body.expiresAt : null;
  if (`${board.shareAccess}:${board.shareExpires || ''}` !== before) closeViewers(board, 4006, 'Link settings changed');
  scheduleSave(board, false);
}

// After a board changes workspace, whoever is on it but may no longer see it is shown the door.
function dropStrangers(board) {
  for (const peer of [...board.peers.values()]) if (!peer.viewer && !visible(peer.user, board)) peer.ws.close(4003, 'Board moved');
}

const VIEW_COOKIE = 'wb_view';
const secureCookie = (req) => ((auth.publicUrl && auth.publicUrl.startsWith('https://')) || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
// Someone who opened a live read-only link may load the files on that board without being signed in.
const viewingShare = (req) => !!sharedBoard(parseCookies(req.headers.cookie)[VIEW_COOKIE]);

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
    return sendJson(res, 200, { auth: auth.mode, user: req.user || null, admin: admin.allows(req), canShare: SHARING, publicUrl: auth.publicUrl || null, shareBases: shareBases(), signOut: !!auth.interactive });
  }
  if (parts[1] === 'admin') return admin.handle(req, res, parts.slice(2));
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
        if (body.workspace === 'personal' && !req.user) return sendJson(res, 400, { error: 'Personal workspaces need sign-in' });
        if ('parentId' in body) {
          const parentId = body.parentId || null;
          if (parentId && !visibleFolder(req.user, parentId)) return sendJson(res, 400, { error: 'Folder not found' });
          if (parentId && folders.get(parentId).workspace !== folder.workspace) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
          if (parentId && isWithin(parentId, folder.id)) return sendJson(res, 400, { error: 'A folder cannot be moved into itself' });
          folder.parentId = parentId;
        }
        if ('workspace' in body) {
          const key = spaceKey(body.workspace, req.user);
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
        store.removeGrantsOn('folder', folder.id);
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 404, { error: 'Folder not found' });
  }
  if (parts[1] === 'boards' && parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    const folderId = visibleFolder(req.user, body.folderId) ? body.folderId : null;
    const workspace = folderId ? folders.get(folderId).workspace : spaceKey(body.workspace, req.user);
    const by = req.user ? req.user.name : typeof body.by === 'string' ? cleanName(body.by, null) : null;
    return sendJson(res, 201, boardMeta(createBoard(body.name, folderId, workspace, by)));
  }
  // A board's link: anyone holding it can watch without signing in and, as the board's people decide,
  // read the comments or comment too. Never more: nobody holding it can change the board.
  //   GET     what the link allows now          POST   turn it on (with any settings below)
  //   PATCH   { access, expiresAt }             DELETE turn it off
  //   POST .../share/reset  a new address, the old one stops working
  if (parts[1] === 'boards' && parts[3] === 'share' && (parts.length === 4 || (parts.length === 5 && parts[4] === 'reset'))) {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board) || !SHARING) return sendJson(res, 404, { error: 'Board not found' });
    if (parts.length === 5) {
      if (req.method !== 'POST' || !board.shareToken) return sendJson(res, 404, { error: 'Not shared' });
      shares.delete(board.shareToken);
      closeViewers(board, 4005, 'Link no longer shared');
      board.shareToken = newId(16);
      shares.set(board.shareToken, board);
      scheduleSave(board, false);
      return sendJson(res, 200, shareInfo(board));
    }
    if (req.method === 'GET') return sendJson(res, 200, shareInfo(board));
    if (req.method === 'POST' || req.method === 'PATCH') {
      const body = await readJson(req);
      if (req.method === 'POST' && !board.shareToken) {
        board.shareToken = newId(16);
        board.shareAccess = 'view';
        board.shareExpires = null;
        shares.set(board.shareToken, board);
      }
      if (!board.shareToken) return sendJson(res, 404, { error: 'Not shared' });
      setShare(board, body);
      return sendJson(res, 200, shareInfo(board));
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
          dropStrangers(board);
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
      // Soft delete: whatever is unsaved is written first, then the board is only marked deleted, so a
      // mis-click is recoverable (scripts/restore-board.js).
      clearTimeout(board.saveTimer);
      board.saveTimer = null;
      writeBoard(board);
      store.deleteBoard(board.id);
      boards.delete(board.id);
      if (board.shareToken) shares.delete(board.shareToken);
      for (const peer of board.peers.values()) peer.ws.close(4004, 'Board deleted');
      return sendJson(res, 200, { ok: true });
    }
  }
  // What has happened that this person should know about: see notifications.js. Without sign-in people
  // are who they say they are, so the page says which name it is asking for.
  if (parts[1] === 'notifications') {
    const named = cleanName(url.searchParams.get('name'), null);
    const who = req.user ? { user: req.user.id, name: req.user.name } : named ? { user: `name:${named.toLowerCase()}`, name: named } : null;
    if (!who) return sendJson(res, 200, { items: [], unread: 0 });
    flushAll();
    if (parts.length === 2 && req.method === 'GET') {
      return sendJson(res, 200, noticesFor(store, who, req.user ? ['myreze', PERSONAL + req.user.id] : ['myreze']));
    }
    if (parts.length === 3 && parts[2] === 'read' && req.method === 'POST') {
      markRead(store, who, await readJson(req));
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }
  // The catalogue: items across every board this person can see. See `find` in store.js for the filters.
  if (parts[1] === 'catalog' && req.method === 'GET') {
    flushAll();
    const spaces = req.user ? ['myreze', PERSONAL + req.user.id] : ['myreze'];
    if (parts[2] === 'media' && parts.length === 4) {
      const media = store.media(parts[3]);
      if (!media) return sendJson(res, 404, { error: 'No such file' });
      return sendJson(res, 200, { media, uses: store.find({ spaces, media: parts[3] }) });
    }
    if (parts.length !== 2) return sendJson(res, 404, { error: 'Not found' });
    const q = url.searchParams;
    const found = store.find({
      spaces, type: q.get('type'), name: q.get('name'), q: q.get('q'), inFrame: q.get('in'), media: q.get('media'), board: q.get('board'), limit: q.get('limit'),
    });
    return sendJson(res, 200, { items: found });
  }
  if (parts[1] === 'upload' && req.method === 'POST') return handleUpload(req, res, url);
  sendJson(res, 404, { error: 'Not found' });
}

async function handleRequest(req, res) {
  let url;
  let pathname;
  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: 'Bad request' });
  }
  // No file has a null byte in its name, and Node throws rather than go looking for one.
  if (pathname.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });

  // For the platform's health checks: no login, no data.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return res.end('ok');
  }
  // Used by stop.bat: only accepted from this machine, so nobody on the network can stop it.
  if (pathname === '/__shutdown' && req.method === 'POST') {
    if (!fromThisMachine(req)) return sendJson(res, 403, { error: 'Local only' });
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
      if (sharedBoard(link[1])) headers['Set-Cookie'] = `${VIEW_COOKIE}=${link[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureCookie(req)}`;
      return sendFile(req, res, path.join(PUBLIC_DIR, 'board.html'), headers);
    }
    const shared = /^\/api\/shared\/([\w-]{16,64})$/.exec(pathname);
    if (shared) {
      const board = sharedBoard(shared[1]);
      return board ? sendJson(res, 200, { name: board.name, access: board.shareAccess }) : sendJson(res, 404, { error: 'This link is not shared any more' });
    }
  }
  if (auth.handle && (await auth.handle(req, res, url))) return;

  // Pages, data and files need a signed-in user. The scripts, styles and fonts do not, so the sign-in page can use them.
  const isPage = pathname === '/' || /^\/b\/[\w-]+\/?$/.test(pathname) || pathname === '/index.html' || pathname === '/board.html' || pathname === '/admin' || pathname === '/admin.html';
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
    admin.seen(req.user);
  }

  if (pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
  // Where the app does no sign-in of its own there is no sign-in page to show.
  if (pathname.startsWith('/auth/') && !auth.interactive) {
    res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
    return res.end();
  }

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
  else if (pathname === '/admin') file = 'admin.html';
  else if (/^\/b\/[\w-]+\/?$/.test(pathname)) file = 'board.html';
  else file = pathname.slice(1);
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'Not found' });
  // The typeface never changes under the same name, so browsers may keep it.
  sendFile(req, res, full, { 'Cache-Control': file.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
}

// Nothing one request does may take the server, and everybody's open boards, down with it.
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    const status = err.status || 500;
    if (status >= 500) console.error(`${req.method} ${req.url} failed: ${err.stack || err.message}`);
    if (res.headersSent) return res.destroy();
    sendJson(res, status, { error: status >= 500 ? 'Something went wrong on the server' : err.message });
  });
});

// Behind a load balancer, keep connections open longer than the balancer does, and let big uploads take their time.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;

// ---------------------------------------------------------------- realtime

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

// Whether a request was made on the machine the server runs on, by someone sitting at it.
function fromThisMachine(req) {
  // A tunnel or proxy on this machine also arrives from loopback, but it adds forwarding headers.
  const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
  return !proxied && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
}

// Browsers say which page is opening a connection. It has to be one of ours: a page on another site
// must not be able to open a board from a visitor's browser, with the visitor's sign-in.
function fromOurPages(req) {
  if (!req.headers.origin) return true; // not a browser
  let origin;
  try {
    origin = new URL(req.headers.origin).host.toLowerCase();
  } catch {
    return false;
  }
  const ours = [req.headers.host, req.headers['x-forwarded-host'], auth.publicUrl && new URL(auth.publicUrl).host];
  return ours.some((host) => typeof host === 'string' && host.toLowerCase() === origin);
}

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') return socket.destroy();
    const shared = url.searchParams.get('share');
    if (shared) {
      const viewed = sharedBoard(shared);
      if (!viewed) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, viewed, null, shared));
    }
    const board = boards.get(url.searchParams.get('board'));
    if (!board || !fromOurPages(req)) return socket.destroy();
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

// What people holding a link are shown: the board, and the team's comments only if the link includes them.
const hiddenFromViewers = (board, op) => board.shareAccess === 'view'
  && (op.t === 'add' ? op.item.type === 'comment' : op.t === 'set' && board.items.get(op.id)?.type === 'comment');

// All that somebody commenting through a link can send: new comments and replies on what is there.
function guestOps(board, ops) {
  if (!Array.isArray(ops)) return [];
  return ops.filter((op) => op && op.t === 'add' && op.item && op.item.type === 'comment' && !board.items.has(op.item.id)
    && board.items.has(op.item.on) && (!op.item.re || board.items.get(op.item.re)?.type === 'comment'));
}

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

// `viewToken` is the secret of the read-only link the connection came in through, if it did.
function onConnect(ws, board, user, viewToken = null) {
  const viewer = viewToken !== null;
  const peer = { id: newId(4), ws, user, name: 'Guest', color: '#888888', p: {}, joined: false, viewer };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const receive = (msg) => {
    if (msg.t === 'hello') {
      if (peer.joined) return;
      // Between connecting and saying hello the board may have been deleted, unshared or moved out of reach.
      if (boards.get(board.id) !== board) return ws.close(4004, 'Board deleted');
      if (viewer && (board.shareToken !== viewToken || !sharedBoard(viewToken))) return ws.close(4005, 'Link no longer shared');
      if (!viewer && !visible(user, board)) return ws.close(4003, 'Board moved');
      openItems(board);
      peer.joined = true;
      if (viewer) {
        // Someone holding a read-only link: seen only as a pointer. They cannot change anything.
        board.viewerSeq += 1;
        // They give a name when they open the link; nobody vouches for it, so it is only a label.
        peer.name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || `Viewer ${board.viewerSeq}`;
        peer.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : VIEWER_COLORS[(board.viewerSeq - 1) % VIEWER_COLORS.length];
        const access = board.shareAccess;
        send(ws, {
          t: 'init',
          you: peer.id,
          board: { name: board.name },
          access,
          items: [...board.items.values()].filter((it) => access !== 'view' || it.type !== 'comment'),
          peers: [...board.peers.values()].map(publicPeer),
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
        peers: [...board.peers.values()].map(publicPeer),
      });
      board.peers.set(peer.id, peer);
      broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
      return;
    }
    if (!peer.joined) return;
    // A viewer may show a pointer and use the laser, and comment when the link allows it. Nothing else.
    if (peer.viewer && msg.t !== 'laser' && msg.t !== 'p' && !(msg.t === 'op' && board.shareAccess === 'comment')) return;

    if (msg.t === 'op') {
      const applied = applyOps(board, peer.viewer ? guestOps(board, msg.ops) : msg.ops, peer, peer.viewer || msg.quiet !== true);
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
    } else if (msg.t === 'laser') {
      if (!Array.isArray(msg.pts)) return;
      const pts = msg.pts.slice(0, 200).filter((n) => Number.isFinite(n));
      if (pts.length >= 2) broadcast(board, { t: 'laser', id: peer.id, pts: pts.slice(0, pts.length - (pts.length % 2)) }, peer);
    } else if (msg.t === 'media') {
      broadcast(board, { t: 'media', from: peer.id, id: msg.id, playing: !!msg.playing, time: Number(msg.time) || 0 }, peer);
    }
  };

  // A message this code chokes on costs whoever sent it that message, and nobody anything else.
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg && typeof msg === 'object') receive(msg);
    } catch (err) {
      if (!(err instanceof SyntaxError)) console.error(`A message on board ${board.id} could not be handled: ${err.message}`);
    }
  });

  ws.on('close', () => {
    if (!board.peers.delete(peer.id)) return;
    broadcast(board, { t: 'leave', id: peer.id });
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
setInterval(unloadIdle, Math.min(60e3, IDLE_UNLOAD)).unref();
setInterval(closeExpiredLinks, 30e3).unref();

// A copy of the database a day, the last week of them kept, in data/backups.
function dailyBackup() {
  try {
    store.backup(BACKUP_DIR);
  } catch (err) {
    console.error(`Backup failed: ${err.message}`);
  }
}
dailyBackup();
setInterval(dailyBackup, 3 * 3600e3).unref();

function shutdown() {
  if (!store.isOpen()) return;
  flushAll();
  store.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}
process.on('exit', shutdown);

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
