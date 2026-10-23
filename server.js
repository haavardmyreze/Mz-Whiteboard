'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { createAuth, parseCookies, isLoopback, clientAddress } = require('./auth');
const { openStore } = require('./store');
const { noticesFor, markRead } = require('./notifications');
const { createAdmin } = require('./admin');
const zip = require('./zip');
const naming = require('./public/naming');
const { createAi } = require('./ai');
const likely = require('./likely');
const cutfiles = require('./cutfiles');

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
// Claude, to suggest names when importing and in batch edit (ai.js). Off without ANTHROPIC_API_KEY.
const ai = createAi();
// One question to Claude at a time from each person: a second click while it thinks is refused.
const aiBusy = new Set();
// Uploads arrive in pieces, so a single request never needs to be large (hosting front ends cap it).
const MAX_PART = 64 * 1024 * 1024;
// Files somebody has started sending and not finished, at most, and how much of them may be waiting at
// once, per person (or, without sign-in, per address); a piece nobody has added to for an hour is swept up.
const MAX_UNFINISHED = 20;
const MAX_UNFINISHED_BYTES = Math.max(2 * MAX_UPLOAD, 4 * 1024 ** 3);
const STALE_UPLOAD = 3600e3;

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
    trustProxy: process.env.TRUST_PROXY,
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
  '.glb': 'model/gltf-binary',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
// A .glb is a project's 3D model of its venue (see cleanProjectSettings), and a sound file is what an animatic
// is cut to (see cleanAnimatic); everything else is media for boards and versions.
const UPLOAD_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.mp4', '.m4v', '.webm', '.mov', '.glb',
  '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac']);

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

// What a board can be set to, for everyone on it. Each is on or off.
//   names   every image and video shows its file name
const BOARD_SETTINGS = ['names'];
function cleanSettings(asked) {
  const out = {};
  if (!asked || typeof asked !== 'object') return out;
  for (const key of BOARD_SETTINGS) if (typeof asked[key] === 'boolean') out[key] = asked[key];
  return out;
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
    // What has changed since the last write: items to write, items to remove, and who added each new one.
    changed: new Set(),
    removed: new Set(),
    creators: new Map(),
    saveTimer: null,
    dirty: false,
    // The last round of changes taken from each page (by its `cid`), so one sent again after a dropped
    // connection is not applied twice. Kept in memory only, for the pages most recently heard from.
    seqs: new Map(),
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

// A board's items, read in when somebody opens it. A board brought back after being deleted may hold
// versions deleted since, or of a project it can no longer see: those pieces come back as plain media.
function openItems(board) {
  board.lastUsed = Date.now();
  if (board.items) return board;
  board.items = new Map(store.loadItems(board.id).map((it) => [it.id, it]));
  let mended = false;
  for (const it of board.items.values()) {
    if (it.type === 'comment' || it.ver === undefined) continue;
    checkVer(it, board);
    if (it.ver === undefined) {
      board.changed.add(it.id);
      mended = true;
    }
  }
  if (mended) scheduleSave(board, false);
  syncNotes(board);
  return board;
}

// Boards nobody is on and nothing is waiting to be written for are let go of after a while.
function unloadIdle() {
  const cutoff = Date.now() - IDLE_UNLOAD;
  for (const board of boards.values()) {
    if (!board.items || board.peers.size || board.dirty || board.saveTimer || board.lastUsed > cutoff) continue;
    board.summary = summarize(board);
    board.items = null;
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

// ---------------------------------------------------------------- what has happened on a board
//
// Who opened a board and who changed it are noted as they happen, for the board's Activity. Changes
// come many to the second while something is dragged, so what is noted waits here a few seconds and is
// written together; the store makes one line of the same thing done again within a few minutes.
//
// And before a round of changes begins, the board is kept as it was: a snapshot it can be put back to.
// A round is whatever follows a quiet spell, so there is at most one snapshot every few minutes.
const SNAPSHOT_EVERY = Number(process.env.WIPBOARD_SNAPSHOT_MS || process.env.WIPBOARD_VERSION_MS) || 10 * 60 * 1000;
const noted = new Map(); // board|who|what -> { board, who, what, n }

function note(board, who, what, n = 1) {
  const key = `${board.id}|${who}|${what}`;
  const line = noted.get(key);
  if (line) line.n += n;
  else noted.set(key, { board: board.id, who, what, n });
}

function writeNoted() {
  if (!noted.size || !store.isOpen()) return;
  const lines = [...noted.values()];
  noted.clear();
  try {
    for (const l of lines) store.logActivity(l.board, l.who, l.what, l.n);
  } catch (err) {
    console.error(`Failed to note activity: ${err.message}`);
  }
}
setInterval(writeNoted, 5000).unref();

// `force` keeps one whatever the time since the last, as before a board is put back to an older one.
function keepSnapshot(board, who, force = false) {
  const now = Date.now();
  if (board.snapshotAt === undefined) board.snapshotAt = store.lastSnapshotAt(board.id);
  if (!force && now - board.snapshotAt < SNAPSHOT_EVERY) return;
  board.snapshotAt = now;
  if (!board.items || !summarize(board).count) return;
  try {
    store.addSnapshot(board.id, [...board.items.values()], who, summarize(board).count, now);
  } catch (err) {
    console.error(`Failed to keep a snapshot of board ${board.id}: ${err.message}`);
  }
}

// Everything still waiting, written now: before a search, so it sees the latest, and on the way out.
function flushAll() {
  writeNoted();
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
    settings: board.settings || {},
    share: shareInfo(board),
  };
}

// ---------------------------------------------------------------- notes
//
// What people say about the work is kept in the notes table, not on the board. A note on a piece of
// media that is filed as a version belongs to the version, so it shows on every board the version is
// on, and it says which board it was made on. A note on media that is not filed belongs to that piece
// on its board. The boards still show notes as comment items on what they are about, so the browser
// and everything it does with comments is as it was: each board holds the comment items its notes
// come to, worked out afresh whenever what is on it changes (see syncNotes).
//
// A note goes only when somebody deletes it. A piece taken off a board, or a board put back to an
// earlier snapshot, takes the notes out of sight, never out of the table: they come back with it.

// What a note keeps of a comment, besides where it is (which the board works out).
function noteData(c) {
  const { id, type, on, re, ob, obn, ...data } = c;
  return data;
}

// The comment item a board shows for a note, on the piece `host`.
function noteItem(board, n, host) {
  const c = { ...noteData(n.data), id: n.id, type: 'comment', on: host };
  if (n.re) c.re = n.re;
  // Made on another board: which one, so the thread can say so. Its name only when everybody who can
  // see this board can see that one too (null otherwise): a personal board's name stays its owner's.
  if (n.boardId !== board.id) {
    c.ob = n.boardId;
    const other = boards.get(n.boardId);
    // Made in the catalogue, on no board at all.
    c.obn = n.boardId === '' ? 'the catalogue' : other && (other.workspace === 'myreze' || other.workspace === board.workspace) ? other.name : null;
  }
  return c;
}

// A board's name for somebody to be shown, when they can see that board; null otherwise.
const boardNameFor = (user, id, name, workspace) => {
  const live = boards.get(id);
  return (live ? canSee(user, live.workspace) && live.name : workspace && canSee(user, workspace) && name) || null;
};

// The comment items a board should hold now: the notes on its media that is not filed, on the piece
// they were made on, and the notes on the versions it holds, on the piece showing that version (the one
// it was made on, when that is here, otherwise the first). Replies sit with their thread.
function notesWanted(board) {
  const placed = new Map(); // version id -> the pieces showing it, in board order
  for (const it of board.items.values()) {
    if (it.type === 'comment' || typeof it.ver !== 'string') continue;
    (placed.get(it.ver) || placed.set(it.ver, []).get(it.ver)).push(it.id);
  }
  const notes = store.notesForBoard(board.id, [...placed.keys()]);
  const want = new Map();
  for (const n of notes) {
    if (n.re) continue;
    let host = null;
    if (n.versionId) {
      const list = placed.get(n.versionId);
      if (list) host = n.boardId === board.id && list.includes(n.itemId) ? n.itemId : list[0];
    } else if (board.items.has(n.itemId) && board.items.get(n.itemId).type !== 'comment') {
      host = n.itemId;
    }
    if (host) want.set(n.id, noteItem(board, n, host));
  }
  for (const n of notes) {
    const root = n.re && want.get(n.re);
    if (root && !root.re) want.set(n.id, noteItem(board, n, root.on));
  }
  return want;
}

// Brings the comment items a board holds in line with its notes. Returns the ops that did it, for
// everybody on the board (whoever made the change too: the server may have put a note elsewhere).
function syncNotes(board) {
  if (!board.items) return [];
  const want = notesWanted(board);
  const gone = [];
  for (const [id, it] of board.items) {
    if (it.type === 'comment' && !want.has(id)) {
      board.items.delete(id);
      gone.push(id);
    }
  }
  const ops = gone.length ? [{ t: 'del', ids: gone }] : [];
  for (const [id, c] of want) {
    const have = board.items.get(id);
    if (have && JSON.stringify(have) === JSON.stringify(c)) continue;
    board.items.set(id, c);
    ops.push({ t: 'add', item: c });
  }
  return ops;
}

// Notes on these versions have changed: every other board that is open and holds one of them is told.
function spreadNotes(versionIds, from) {
  if (!versionIds.size) return;
  for (const board of boards.values()) {
    if (board === from || !board.items) continue;
    if (![...board.items.values()].some((it) => it.type !== 'comment' && versionIds.has(it.ver))) continue;
    const ops = syncNotes(board);
    if (ops.length) broadcast(board, { t: 'op', ops, from: null });
  }
  tellRooms(versionIds);
  retellPresentations([...versionIds]);
}

// What was drawn for a comment, kept with it: strokes measured against the piece, whose width is 1000.
// Each as a board's drawing is: a box, its points within the box from 0 to 1, how wide the line is
// along them, its colour.
function cleanDrawing(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const n = (v) => Number.isFinite(v);
  for (const s of list.slice(0, 100)) {
    if (!s || typeof s !== 'object' || !['x', 'y', 'w', 'h', 'size'].every((k) => n(s[k]))) continue;
    if (!Array.isArray(s.pts) || s.pts.length < 2 || s.pts.length > 6000 || !s.pts.every(n)) continue;
    const stroke = { x: s.x, y: s.y, w: s.w, h: s.h, pts: s.pts, size: s.size, color: typeof s.color === 'string' && s.color.length <= 16 ? s.color : 'ink' };
    if (Array.isArray(s.ws) && s.ws.length * 2 === s.pts.length && s.ws.every(n)) stroke.ws = s.ws;
    if (s.arrow === true) stroke.arrow = true;
    out.push(stroke);
  }
  return out.length ? out : null;
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
  const drawing = cleanDrawing(it.drawing);
  if (drawing) clean.drawing = drawing;
  // Made in a project's 3D preview: where the view was (a drawing's strokes are in that view's frame).
  const pov = cleanPov(it.pov);
  if (pov) clean.pov = pov;
  // Made on one of its version's extras rather than its own file: which (see cleanLook).
  const ex = extraName(it.ex);
  if (ex) clean.ex = ex;
  return clean;
}

// Where a comment made in 3D was made from: the camera's place, which way it turned (a quaternion) and its
// lens (degrees top to bottom, over a 16:9 frame). 'main' is the model's main camera, which comments drawn
// before views could be anywhere were made through.
function cleanPov(pov) {
  if (pov === 'main') return 'main';
  if (!pov || typeof pov !== 'object' || !Array.isArray(pov.p) || !Array.isArray(pov.q)) return null;
  const fine = (a, n) => a.length === n && a.every((v) => Number.isFinite(v) && Math.abs(v) < 1e6);
  if (!fine(pov.p, 3) || !fine(pov.q, 4) || !Number.isFinite(pov.fov) || pov.fov < 1 || pov.fov > 179) return null;
  const len = Math.hypot(...pov.q);
  if (len < 1e-6) return null;
  const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
  return { p: pov.p.map((v) => r(v, 4)), q: pov.q.map((v) => r(v / len, 6)), fov: r(pov.fov, 3) };
}

// What may change about a comment: whether it has been dealt with, by anyone on the board, and what it
// says, by whoever wrote it (known by the name the connection goes by), stamped as edited. Nothing else,
// and nothing at all from somebody holding a link. Null when the patch changes nothing it may.
function commentPatch(it, asked, peer) {
  const patch = {};
  if ('done' in asked) patch.done = !!asked.done;
  if (typeof asked.text === 'string' && peer && !peer.viewer && peer.name === it.name) {
    const text = asked.text.trim().slice(0, 2000);
    if (text && text !== it.text) {
      patch.text = text;
      patch.edited = Date.now();
    }
  }
  return Object.keys(patch).length ? patch : null;
}

// A new note from a comment somebody sent: on the version the piece shows, if it shows one, and a
// reply in the thread it answers.
function addNote(board, c, peer) {
  let versionId = null;
  if (c.re) {
    const root = store.note(c.re);
    if (!root || root.deletedAt || root.re) return null;
    versionId = root.versionId;
  } else {
    const host = board.items.get(c.on);
    if (host && typeof host.ver === 'string') versionId = host.ver;
  }
  return store.addNote({ id: c.id, boardId: board.id, itemId: c.on, versionId, re: c.re || null, data: noteData(c), by: peer ? peer.name : null });
}

// A version that is there: not one that never was, nor one deleted.
const liveVersion = (id) => {
  const v = typeof id === 'string' && store.version(id);
  return v && !v.deletedAt ? v : null;
};

// A piece may show a catalogue version (`ver`) only if there is such a version, of a project the board's
// own people can see: a board in the shared workspace never shows a version from a project in somebody's
// personal one. A snapshot or an undo that brings back a piece of a version since deleted brings it back
// as plain media.
function checkVer(it, board) {
  if (it.ver === undefined || it.ver === null) {
    if (it.ver === undefined) delete it.ex;
    return;
  }
  const v = liveVersion(it.ver);
  const e = v && store.entity(v.entityId);
  const project = e && folders.get(e.projectId);
  if (!project || !(project.workspace === 'myreze' || project.workspace === board.workspace)) delete it.ver;
  // A piece showing one of its version's extras: only while it is a version, and has that extra.
  if (it.ex !== undefined && (it.ver === undefined || typeof it.ex !== 'string' || !hasExtra(v.look, it.ex))) delete it.ex;
}

// Where a piece's files may be. Its file (`src`) is uploaded here, a picture written into the item
// itself, or, for an image added by its address (pasted or dropped from another site), that address.
// Its stills and preview (`th`, `poster`, `prev`) are made here, so uploaded or written in; the file a
// video was made from (`orig`) is always uploaded; its timeline strip (`wf`) is the colours and loudness
// packed small, as a version keeps it (see cleanLook). Anything else in those fields is dropped.
const UPLOADED = /^\/uploads\/[\w-]+\.[a-z0-9]+$/i;
const DATA_IMAGE = /^data:image\/[\w.+-]+[;,]/i;
const WEB_ADDRESS = /^https?:\/\/[^\s"'<>\\]+$/i;
const MAX_INLINE = 4 * 1024 * 1024;
const inline = (v) => DATA_IMAGE.test(v) && v.length <= MAX_INLINE;
const MEDIA_FIELDS = {
  src: (v, type) => UPLOADED.test(v) || inline(v) || (type === 'image' && WEB_ADDRESS.test(v) && v.length <= 2000),
  th: (v) => UPLOADED.test(v) || inline(v),
  poster: (v) => UPLOADED.test(v) || inline(v),
  prev: (v) => UPLOADED.test(v) || inline(v),
  orig: (v) => UPLOADED.test(v),
  // A video's phone copy (see "phone copies" below).
  lo: (v) => UPLOADED.test(v),
};
const cleanStrip = (v) => (v && typeof v === 'object' && typeof v.c === 'string' && v.c.length < 100000 && (v.p === undefined || (typeof v.p === 'string' && v.p.length < 100000)) ? { c: v.c, ...(v.p !== undefined && { p: v.p }) } : null);
// Checks those fields of an item, or of a patch to one (where null clears a field), in place.
function cleanMedia(fields, type) {
  for (const [key, ok] of Object.entries(MEDIA_FIELDS)) {
    if (!(key in fields) || fields[key] === null) continue;
    if (typeof fields[key] !== 'string' || !ok(fields[key], type)) delete fields[key];
  }
  if ('wf' in fields && fields.wf !== null) {
    const wf = cleanStrip(fields.wf);
    if (wf) fields.wf = wf;
    else delete fields.wf;
  }
}

// A note this board shows, so that an undo on it may bring it back: one made on the board on a piece
// that is not filed, or one on a version a piece on the board shows.
function shownOn(board, n) {
  if (n.versionId) return [...board.items.values()].some((it) => it.type !== 'comment' && it.ver === n.versionId);
  return n.boardId === board.id;
}

// Who may delete a note: whoever wrote it (known, as for editing, by the name the connection goes by),
// and, for a note somebody holding a link wrote, anybody on the board, who look after what is said on
// it. Never somebody holding a link. Deleting the note a thread starts with deletes its replies too.
const mayDelete = (n, peer) => !peer || (!peer.viewer && (peer.name === n.data.name || n.data.guest === true));

// `touch` is false for housekeeping a browser does by itself, which must not make the board look edited.
// What the notes then come to on this board and on others is settled by settle() below, after the ops
// themselves have gone out.
function applyOps(board, ops, peer, touch = true) {
  const applied = [];
  applied.notes = new Set(); // versions whose notes changed
  applied.resync = false;    // whether what the board shows of its notes may have to change
  applied.versions = new Set(); // versions put on the board
  if (!Array.isArray(ops)) return applied;
  const removedComments = [];
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'add') {
      let it = op.item;
      if (!it || typeof it !== 'object' || !ID_RE.test(it.id) || typeof it.type !== 'string') continue;
      if (it.type === 'comment') {
        if (board.items.has(it.id)) continue;
        const known = store.note(it.id);
        if (known) {
          // Undo bringing back a note that was deleted: as its author wrote it, wherever it belongs. Only
          // by the board's own people (or the server), and only a note this board shows; the first note
          // of a thread brings back the replies deleted with it.
          if (known.deletedAt && (!peer || !peer.viewer) && shownOn(board, known)) store.restoreNote(it.id);
          if (known.versionId) applied.notes.add(known.versionId);
          applied.resync = true;
          continue;
        }
        const clean = cleanComment(it, peer);
        const n = clean && addNote(board, clean, peer);
        if (!n) continue;
        if (n.versionId) applied.notes.add(n.versionId);
        applied.resync = true;
        it = noteItem(board, n, clean.on);
        board.items.set(it.id, it);
        applied.push({ t: 'add', item: it });
        continue;
      }
      cleanMedia(it, it.type);
      if (it.type === 'stroke' || it.type === 'frame' || it.type === 'note' || it.type === 'text' || it.type === 'block') delete it.ver;
      else checkVer(it, board);
      if (typeof it.ver === 'string') applied.versions.add(it.ver);
      board.items.set(it.id, it);
      board.changed.add(it.id);
      board.removed.delete(it.id);
      if (peer && !board.creators.has(it.id)) board.creators.set(it.id, peer.name);
      applied.resync = true;
      applied.push({ t: 'add', item: it });
    } else if (op.t === 'set') {
      const it = board.items.get(op.id);
      if (!it || !op.patch || typeof op.patch !== 'object') continue;
      let patch = {};
      if (it.type === 'comment') {
        patch = commentPatch(it, op.patch, peer);
        if (!patch) continue;
        const n = store.note(op.id);
        if (!n) continue;
        store.setNote(op.id, { ...n.data, ...patch });
        if (n.versionId) applied.notes.add(n.versionId);
      } else {
        for (const key of Object.keys(op.patch)) {
          if (key === 'id' || key === 'type' || key === '__proto__') continue;
          patch[key] = op.patch[key];
        }
        cleanMedia(patch, it.type);
        if ('ver' in patch) {
          checkVer(patch, board);
          if (!('ver' in patch)) patch.ver = null;
          applied.resync = true;
          if (typeof patch.ver === 'string') applied.versions.add(patch.ver);
        }
      }
      // Which extra of its version a piece shows (see fileVersions) goes with the version: another
      // version put on it shows that one's own file.
      if ('ver' in patch && !('ex' in patch)) delete it.ex;
      Object.assign(it, patch);
      if (it.ver === null) delete it.ver;
      if (!it.ver || typeof it.ex !== 'string') delete it.ex;
      if (it.type !== 'comment') board.changed.add(op.id);
      applied.push({ t: 'set', id: op.id, patch });
    } else if (op.t === 'del') {
      if (!Array.isArray(op.ids)) continue;
      const ids = op.ids.filter((id) => {
        const gone = board.items.get(id);
        if (!gone) return false;
        board.items.delete(id);
        if (gone.type === 'comment') {
          removedComments.push(gone);
          return true;
        }
        board.changed.delete(id);
        board.removed.add(id);
        board.creators.delete(id);
        applied.resync = true;
        return true;
      });
      if (ids.length) applied.push({ t: 'del', ids });
    } else if (op.t === 'meta') {
      if (!op.patch || typeof op.patch !== 'object') continue;
      const patch = {};
      if (typeof op.patch.name === 'string') {
        board.name = cleanName(op.patch.name, 'Untitled');
        patch.name = board.name;
      }
      const settings = cleanSettings(op.patch.settings);
      if (Object.keys(settings).length) {
        board.settings = { ...board.settings, ...settings };
        patch.settings = board.settings;
      }
      if (Object.keys(patch).length) applied.push({ t: 'meta', patch });
    }
  }
  // A comment taken off together with what it was on only goes out of sight with it. Taken off on its
  // own, from a piece still here, somebody deleted it: if they may (see mayDelete), it is deleted, and
  // otherwise it stays (the sender is told, see fixesFor). Threads go first, so that their replies,
  // deleted with them, are not then refused one by one.
  const kept = new Set();
  removedComments.sort((a, b) => (a.re ? 1 : 0) - (b.re ? 1 : 0));
  for (const c of removedComments) {
    applied.resync = true;
    const n = store.note(c.id);
    if (!n) continue;
    if (n.versionId) applied.notes.add(n.versionId);
    if (!board.items.has(c.on) || n.deletedAt) continue;
    if (mayDelete(n, peer)) {
      store.deleteNote(c.id);
    } else {
      board.items.set(c.id, c);
      kept.add(c.id);
    }
  }
  if (kept.size) {
    for (const op of applied) if (op.t === 'del') op.ids = op.ids.filter((id) => !kept.has(id));
    for (let i = applied.length - 1; i >= 0; i--) if (applied[i].t === 'del' && !applied[i].ids.length) applied.splice(i, 1);
  }
  if (applied.length) scheduleSave(board, touch);
  return applied;
}

// What the server made of the ops somebody sent, where that is not what they sent: the server's own
// version of each (an item as it is now, a patch with what those fields now hold, an item put back that
// they took off, a `del` for one that is not there), for the sender alone, so that their board is the
// same as everybody else's. `sent` is a copy of the ops taken before they were applied.
function fixesFor(board, sent) {
  const fix = [];
  if (!Array.isArray(sent)) return fix;
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const op of sent) {
    if (!op || typeof op !== 'object') continue;
    if (op.t === 'add' && op.item && typeof op.item === 'object' && typeof op.item.id === 'string') {
      const now = board.items.get(op.item.id);
      if (!now) fix.push({ t: 'del', ids: [op.item.id] });
      else if (!same(now, op.item)) fix.push({ t: 'add', item: now });
    } else if (op.t === 'set' && typeof op.id === 'string' && op.patch && typeof op.patch === 'object') {
      const now = board.items.get(op.id);
      if (!now) {
        fix.push({ t: 'del', ids: [op.id] });
        continue;
      }
      const patch = {};
      let differs = false;
      for (const key of Object.keys(op.patch)) {
        if (key === '__proto__') continue;
        patch[key] = now[key] ?? null;
        if (!same(now[key], op.patch[key])) differs = true;
      }
      if (differs) fix.push({ t: 'set', id: op.id, patch });
    } else if (op.t === 'del' && Array.isArray(op.ids)) {
      for (const id of op.ids) if (typeof id === 'string' && board.items.has(id)) fix.push({ t: 'add', item: board.items.get(id) });
    } else if (op.t === 'meta' && op.patch && typeof op.patch === 'object') {
      const patch = {};
      if ('name' in op.patch && op.patch.name !== board.name) patch.name = board.name;
      if ('settings' in op.patch && !same(op.patch.settings, board.settings || {})) patch.settings = board.settings || {};
      if (Object.keys(patch).length) fix.push({ t: 'meta', patch });
    }
  }
  return fix;
}

// After ops have gone out: the board's notes as they now come out, here and on the other boards that
// hold the versions they are on, and what those versions are called, for whoever does not know yet.
function settle(board, applied) {
  if (applied.resync) {
    const ops = syncNotes(board);
    // What a board shows of notes it already had, worked out again: nobody has just said anything.
    if (ops.length) broadcast(board, { t: 'op', ops, from: null, sync: true });
  }
  spreadNotes(applied.notes, board);
  if (applied.versions.size) broadcast(board, { t: 'versions', list: [...applied.versions].map((id) => boardVersion(id, board3d(board))).filter(Boolean) });
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

const publicFolder = (f) => ({
  id: f.id, name: f.name, parentId: f.parentId, workspace: spaceName(f.workspace), createdAt: f.createdAt,
  ...(f.project && { project: true, settings: f.settings || {} }),
});

// The project a folder is in, or is: the nearest folder up its path that is marked as one.
function projectOf(folderId) {
  for (let id = folderId, hops = 0; id && hops < 1000; id = folders.get(id)?.parentId, hops++) {
    const f = folders.get(id);
    if (f && f.project) return f;
  }
  return null;
}
const boardProject = (board) => (board ? projectOf(board.folderId) : null);
// Whether a folder or anything below it is a project.
function holdsProject(folder) {
  for (const f of folders.values()) if (f.project && isWithin(f.id, folder.id)) return true;
  return false;
}
// A project's settings: its 3D preview: the model of the venue its work is shown
// on (an uploaded .glb), the name of the material its projection surface has (`screen` unless said), and
// which view of a version goes on it (its main one unless said). `preview3d: null` takes the 3D preview away.
// `tasks: false` says its versions are not counted by task: each asset, set or shot has one count.
// `views` says how its versions are shown: false, one way only; or the names of the ways, the main one
// first (["cmp", "bty"]: each version is its cmp, and may have a bty beside it). `rules` are what its
// people taught it about file names from elsewhere (see ruleFrom in naming.js), the whole list each time.
function cleanProjectSettings(asked, was = {}) {
  const out = { ...was };
  if (!asked || typeof asked !== 'object') return out;
  if (asked.tasks === false) out.tasks = false;
  else if (asked.tasks === true) delete out.tasks;
  if (asked.views === false) out.views = false;
  else if (Array.isArray(asked.views)) {
    const names = [...new Set(asked.views.map(viewName).filter(Boolean))].slice(0, 12);
    // One name is no more than the one way every version is shown.
    out.views = names.length > 1 ? names : false;
  }
  const seqName = (v) => typeof v === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v.length <= 80;
  // The order its sequences go in (in the timeline, the catalogue, wherever they are listed), first to last.
  if (Array.isArray(asked.seqs)) {
    const seqs = [...new Set(asked.seqs.filter(seqName))].slice(0, 500);
    if (seqs.length) out.seqs = seqs;
    else delete out.seqs;
  }
  // The names from elsewhere it has learned to read (see ruleFrom in naming.js): `rules` is all of them,
  // given anew (one forgotten); `addRules` are more to keep beside those it has now, so that two learned
  // at about the same time (two patterns offered while filing one batch) are both kept.
  const ruleOf = (r) => {
    if (!r || typeof r !== 'object') return null;
    // A whole name's pattern (see patternFrom in naming.js): where its sequence and shot are, at least.
    if (Array.isArray(r.pattern)) {
      const pattern = r.pattern.slice(0, 16);
      if (!pattern.length || !pattern.every((t) => typeof t === 'string' && naming.PATTERN_TOKEN.test(t))) return null;
      if (!pattern.includes('{seq}') || !pattern.some((t) => t.startsWith('{shot'))) return null;
      const seqs = Object.fromEntries(Object.entries(r.seqs && typeof r.seqs === 'object' ? r.seqs : {})
        .filter(([from, to]) => /^[a-z0-9]{1,40}$/.test(from) && seqName(to)).slice(0, 50));
      return { pattern, ...(Object.keys(seqs).length && { seqs }), like: String(r.like || '').slice(0, 120), as: String(r.as || '').slice(0, 80) };
    }
    if (typeof r.word !== 'string' || !/^[a-z0-9]{1,40}$/.test(r.word)) return null;
    if (seqName(r.seq)) return { word: r.word, seq: r.seq, ...(r.glued === true && { glued: true }) };
    if (typeof r.name === 'string' && naming.tokenize(r.name) === r.name) return { word: r.word, name: r.name };
    return null;
  };
  if (Array.isArray(asked.rules) || Array.isArray(asked.addRules)) {
    const rules = new Map();
    const given = Array.isArray(asked.rules) ? asked.rules : [...(out.rules || []), ...asked.addRules];
    for (const r of given.slice(0, 200)) {
      const rule = ruleOf(r);
      if (rule) rules.set(naming.ruleKey(rule), rule);
    }
    if (rules.size) out.rules = [...rules.values()];
    else delete out.rules;
  }
  if (asked.preview3d === null) delete out.preview3d;
  else if (asked.preview3d && typeof asked.preview3d === 'object') {
    const p = asked.preview3d;
    const model = typeof p.model === 'string' && path.extname(uploadName(p.model) || '') === '.glb' && store.media(uploadName(p.model)) ? p.model : null;
    if (model) {
      out.preview3d = {
        model,
        name: typeof p.name === 'string' ? p.name.slice(0, 200) : '',
        screen: typeof p.screen === 'string' && p.screen.trim() ? p.screen.trim().slice(0, 80) : 'screen',
        view: viewName(p.view) || '',
        // The camera of the model's that the 3D view opens through (its name); none, the one named main, or its first.
        camera: typeof p.camera === 'string' ? p.camera.slice(0, 120) : '',
      };
    }
  }
  return out;
}

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
  for (const p of store.loosePlaylists()) if (p.folderId && moved.has(p.folderId)) store.setPlaylist(p.id, { workspace: key });
  dropRoomStrangers();
}

// Whether a folder or anything below it holds something: a board, a playlist or another folder.
function holdsAnything(folder) {
  for (const f of folders.values()) if (f.id !== folder.id && isWithin(f.id, folder.id)) return true;
  for (const b of boards.values()) if (b.folderId && isWithin(b.folderId, folder.id)) return true;
  for (const p of store.loosePlaylists()) if (p.folderId && isWithin(p.folderId, folder.id)) return true;
  return false;
}

// ---------------------------------------------------------------- the catalogue of a project
//
// A project folder keeps a catalogue: its entities (assets, sets and shots) and the versions filed under
// them. A version is filed from a piece of media on a board in the project, or from the project's
// catalogue page. A piece on a board that shows a version says which (`ver`); the board shows what it is
// called, and when there is a newer one.

const LOOK_KEYS = ['type', 'src', 'lo', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name', 'view'];
const MAX_VIEWS = 16;
const MAX_EXTRAS = 64;
const UPLOAD_KEYS = new Set(['src', 'lo', 'orig', 'prev', 'th', 'poster']);

// What a board needs to show a file, taken from a piece on a board or from a file brought into the catalogue, keeping
// only what such a piece has: addresses of uploaded files, its size, length and rate, its name.
// A version's look may also say which view it is (`view`: cmp, bty, top...) and carry its other views
// (`views`: a look each, every one named and none twice); a view itself carries no more views. It may also
// carry extras (`extras`): more files that belong to the version without being another way of showing it,
// full-size stills or another lighting, say, each with a `label` of its own and none twice.
function cleanLook(asked, nested = false) {
  const look = {};
  if (!asked || typeof asked !== 'object') return null;
  for (const key of LOOK_KEYS) {
    const v = asked[key];
    if (v === undefined || v === null) continue;
    if (UPLOAD_KEYS.has(key)) {
      if (uploadName(v)) look[key] = v;
    } else if (key === 'type') {
      if (v === 'image' || v === 'video') look.type = v;
    } else if (key === 'name') {
      if (typeof v === 'string') look.name = v.slice(0, 200);
    } else if (key === 'view') {
      const view = viewName(v);
      if (view) look.view = view;
    } else if (key === 'wf') {
      // The timeline strip: the colours of the picture and the loudness of the sound, each packed small.
      if (v && typeof v === 'object' && typeof v.c === 'string' && v.c.length < 100000 && (v.p === undefined || (typeof v.p === 'string' && v.p.length < 100000))) look.wf = { c: v.c, ...(v.p && { p: v.p }) };
    } else if (Number.isFinite(v) && v >= 0) {
      look[key] = v;
    }
  }
  if (!look.src || !look.type || !store.media(uploadName(look.src))) return null;
  if (!nested && Array.isArray(asked.views)) {
    const views = [];
    for (const x of asked.views.slice(0, MAX_VIEWS)) {
      const c = cleanLook(x, true);
      if (c && c.view && c.view !== look.view && !views.some((y) => y.view === c.view)) views.push(c);
    }
    if (views.length) look.views = views;
  }
  if (!nested && Array.isArray(asked.extras)) {
    const extras = [];
    for (const x of asked.extras.slice(0, MAX_EXTRAS)) {
      const c = cleanLook(x, true);
      const label = x && extraName(x.label);
      if (c && label && !extras.some((y) => y.label === label)) {
        delete c.view;
        extras.push({ ...c, label });
      }
    }
    if (extras.length) look.extras = extras;
  }
  return look;
}
// What a view is called: a token (bty, bty-left, cmp), short.
const viewName = (v) => (typeof v === 'string' ? naming.tokenize(v).slice(0, 40) || null : null);
const hasView = (look, view) => look.view === view || (look.views || []).some((x) => x.view === view);
// What an extra is called: a token too (still-1043, light-b, warm).
const extraName = viewName;
const hasExtra = (look, label) => (look.extras || []).some((x) => x.label === label);

// A version as a board and the catalogue show it: what it is called, and the newest of its entity and
// task when that is a later one.
function versionInfo(ref) {
  const v = typeof ref === 'string' ? liveVersion(ref) : ref;
  const e = v && store.entity(v.entityId);
  if (!e) return null;
  const newest = store.newestVersion(v.entityId, v.task);
  return {
    id: v.id, entityId: e.id, entity: e.name, tier: e.tier, projectId: e.projectId, task: v.task, number: v.number,
    label: naming.label(e.name, v.task, v.number), artist: v.artist, descriptor: v.descriptor, hidden: v.hidden,
    thumb: v.thumb, kind: v.kind, newest: newest && newest.id !== v.id && newest.number > v.number ? newest : null,
  };
}

// A version as the catalogue shows it to `user`: the board it was filed from is named only if they can see it.
function publicVersion(v, user) {
  const from = v.boardId && boards.get(v.boardId);
  return {
    ...versionInfo(v), ...versionFiles(v.look), look: v.look, originalName: v.originalName, createdAt: v.createdAt, createdBy: v.createdBy,
    board: from ? { id: v.boardId, name: canSee(user, from.workspace) ? from.name : null } : null,
  };
}

// The versions a board shows, as it shows them.
function boardVersions(board) {
  const ids = new Set();
  for (const it of board.items.values()) if (it.type !== 'comment' && typeof it.ver === 'string') ids.add(it.ver);
  const model = board3d(board);
  return [...ids].map((id) => boardVersion(id, model)).filter(Boolean);
}

// The versions a board shows, in the order it reads (as board.js reads it, mediaOrder): rows first, then
// left to right, a frame counting as one piece among the loose ones, what it holds read in the same way.
// Each once, where it first comes.
function boardReadingVersions(board) {
  openItems(board);
  const inOrder = (list) => {
    const rows = [];
    for (const it of list.slice().sort((a, b) => a.y - b.y)) {
      const row = rows[rows.length - 1];
      if (row && it.y < row.y + row.h * 0.5) row.list.push(it);
      else rows.push({ y: it.y, h: it.h || 0, list: [it] });
    }
    return rows.flatMap((row) => row.list.sort((a, b) => a.x - b.x));
  };
  const held = new Map();
  const pieces = [];
  for (const it of board.items.values()) {
    if ((it.type !== 'image' && it.type !== 'video') || it.pid || !Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
    const frame = it.fid && board.items.get(it.fid);
    if (!frame || frame.type !== 'frame') pieces.push(it);
    else if (held.has(frame.id)) held.get(frame.id).push(it);
    else {
      held.set(frame.id, [it]);
      pieces.push(frame);
    }
  }
  const order = inOrder(pieces).flatMap((p) => (p.type === 'frame' ? inOrder(held.get(p.id)) : [p]));
  return [...new Set(order.map((it) => it.ver).filter((id) => typeof id === 'string'))];
}

// The model of its venue the project a board is in has, if it has one (see cleanProjectSettings).
function board3d(board) {
  const p = boardProject(board);
  const preview3d = p && p.settings && p.settings.preview3d;
  // `main` is the name of the project's main view: a model set to show it shows each version's own file.
  return preview3d && preview3d.model ? { ...preview3d, key: p.id, main: (viewsOf(p) || [])[0] || null } : null;
}
// A version as a board shows it, and in a project with a model of its venue, what goes on the model's
// screens (`look3d`): the version's view the project puts there (its main one, unless the project names
// one). A version without that view is not seen in 3D. Only what the player needs, not its timeline strip.
// A version with extras has its files too (`files`): its own (`ex` ''), then each extra (`ex` its label),
// so the player can show any of them in place of the piece.
const LOOK3D_KEYS = ['type', 'src', 'lo', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'name', 'view'];
const FILE_KEYS = ['type', 'src', 'lo', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name'];
const fileOf = (look, ex) => {
  const out = { ex };
  for (const k of FILE_KEYS) if (look[k] !== undefined) out[k] = look[k];
  return out;
};
const versionFiles = (look) => (look && look.extras ? { files: [fileOf(look, ''), ...look.extras.map((x) => fileOf(x, x.label))] } : null);
function boardVersion(ref, model) {
  let info = versionInfo(ref);
  const v = info && (typeof ref === 'string' ? liveVersion(ref) : ref);
  const look = v && v.look;
  if (info) info = { ...info, ...versionFiles(look) };
  if (!info || !model) return info;
  if (!look || (look.type !== 'image' && look.type !== 'video')) return info;
  // Its own file is its main view, unless it was filed as another (a version that is only a bty, say).
  const own = !model.view || look.view === model.view || (model.view === model.main && !look.view);
  const shown = own ? look : (look.views || []).find((x) => x.view === model.view);
  if (!shown) return info;
  const look3d = {};
  for (const k of LOOK3D_KEYS) if (shown[k] !== undefined) look3d[k] = shown[k];
  if (!look3d.type) look3d.type = look.type;
  return { ...info, look3d };
}

// Some entities have a new version, or one hidden or shown again: the boards that show any of their
// versions are told what they are now called, and whether a newer one is there, in one message each.
function retellEntities(entityIds) {
  if (!entityIds.size) return;
  for (const board of boards.values()) {
    if (!board.items || !board.peers.size) continue;
    const list = boardVersions(board).filter((v) => entityIds.has(v.entityId));
    if (list.length) broadcast(board, { t: 'versions', list });
  }
}
const retellEntity = (entityId) => retellEntities(new Set([entityId]));

// Whether a project counts its versions by task (see cleanProjectSettings).
const usesTasks = (project) => !(project.settings && project.settings.tasks === false);
// The ways a project's versions are shown, the main one first, or null for one way (see
// cleanProjectSettings).
function viewsOf(project) {
  const set = project.settings && project.settings.views;
  return Array.isArray(set) && set.length > 1 ? set : null;
}
// Which view a file is filed as: null for the main one (a version of its own), else one of the project's
// views, to go with a version that has not got it. A project shown one way has none at all.
function viewFor(project, asked) {
  const list = viewsOf(project);
  const view = viewName(asked);
  if (!list || !view || view === list[0]) return null;
  if (!list.includes(view)) throw refusal(400, `“${view}” is not one of this project's views (${list.join(', ')})`);
  return view;
}

// The entity a file is to go under, without making anything yet: one the project has, by its id or its
// name, or one to make, by its name ({ name, tier, make: true }).
function entityFor(project, spec) {
  if (typeof spec === 'string') {
    const e = store.entity(spec);
    if (!e || e.projectId !== project.id) throw refusal(400, 'That entity is not in this project');
    return e;
  }
  if (!spec || typeof spec !== 'object') throw refusal(400, 'Say which asset, set or shot it is');
  const name = naming.tokenize(spec.name);
  if (!name) throw refusal(400, 'An asset, set or shot needs a name');
  const have = store.entityNamed(project.id, name);
  if (have) return have;
  const tier = naming.TIERS.includes(spec.tier) ? spec.tier : naming.kindOf(name, store.entities(project.id)) || 'asset';
  return { name, tier, make: true };
}
// That entity, made now if it is to be (or the one of that name, should it have been made meanwhile).
const madeEntity = (project, e, by) => (e.make ? store.addEntity({ id: newId(), projectId: project.id, tier: e.tier, name: e.name, by }) : e);
const resolveEntity = (project, spec, by) => madeEntity(project, entityFor(project, spec), by);

const tokenOrNull = (v) => (typeof v === 'string' && naming.tokenize(v) ? naming.tokenize(v) : null);

// Why a number cannot be had: the version that has it.
function takenMessage(t) {
  const name = naming.label(store.entity(t.entityId).name, t.task, t.number);
  return t.deletedAt ? `${name} was given to a version since deleted, so it can't be used again` : `There is a ${name} already`;
}
const validNumber = (n) => Number.isSafeInteger(n) && n >= 1 && n <= 99999;
// How long after it was filed a version can be taken back as if it never had been.
const UNFILE_WITHIN = 30 * 60 * 1000;
// A version's colour strip as bytes, kept once read (they are asked for again with every video filed).
const strips = new Map();
function headStrip(v) {
  if (strips.has(v.id)) return strips.get(v.id);
  if (strips.size > 5000) strips.delete(strips.keys().next().value);
  const s = likely.strip(v.look.wf && v.look.wf.c);
  strips.set(v.id, s);
  return s;
}

// Files pieces of media as versions. Each file is a piece on a board ({ board, item }) or a file
// brought into the catalogue ({ look }); what each says about itself (entity, task, descriptor,
// artist, number) goes before what is said for them all. What its name says fills in the rest.
// One that says `extra` (a label) is no version of its own but an extra of one (see cleanLook).
// Everything is checked first, and then all of it is filed in one write, so a mistake files nothing;
// only then are the boards told.
function fileVersions(req, project, body) {
  const by = actor(req, body);
  const files = Array.isArray(body.files) ? body.files.slice(0, 500) : [];
  if (!files.length) throw refusal(400, 'Nothing to file');
  const known = store.entities(project.id);
  const pieces = new Set();
  const plan = files.map((f) => {
    if (!f || typeof f !== 'object') throw refusal(400, 'Each file is a piece on a board or an uploaded file');
    let board = null;
    let item = null;
    let look;
    if (f.board) {
      board = boards.get(f.board);
      if (!visible(req.user, board)) throw refusal(404, 'Board not found');
      if (boardProject(board) !== project) throw refusal(400, `“${board.name}” is not in this project`);
      openItems(board);
      item = board.items.get(f.item);
      if (!item || (item.type !== 'image' && item.type !== 'video')) throw refusal(400, 'Only images and videos are filed as versions');
      if (liveVersion(item.ver)) throw refusal(409, `“${item.name || 'That piece'}” is ${versionInfo(item.ver).label} already`);
      if (pieces.has(`${board.id}/${item.id}`)) throw refusal(400, `“${item.name || 'That piece'}” is in the list twice`);
      pieces.add(`${board.id}/${item.id}`);
      look = cleanLook(item);
      if (!look) throw refusal(400, `“${item.name || 'That piece'}” has not finished uploading`);
    } else {
      look = cleanLook(f.look);
      if (!look) throw refusal(400, 'That file is not on the server');
    }
    const parsed = naming.parse(look.name || '', known);
    const pick = (key) => (f[key] !== undefined ? f[key] : body[key]);
    // A number may be asked for (one a file says on its own); otherwise it is the next.
    const asked = f.number ?? null;
    if (asked != null && !validNumber(asked)) throw refusal(400, 'A version number is a whole number from 1');
    // Which view it is files it as that, and nothing else does: a view the file's look carries of its own
    // (a piece copied from another version's view, say) counts only as the project allows, and a new
    // version is its one file, whatever other views a look sent along says it has.
    // An extra is neither: it is said in so many words, and a file brought in is filed as one file.
    const extra = f.extra != null ? extraName(f.extra) : null;
    if (f.extra != null && !extra) throw refusal(400, 'An extra needs a name');
    const view = extra ? null : viewFor(project, f.view !== undefined ? f.view : look.view);
    look = { ...look };
    delete look.views;
    delete look.extras;
    if (view) look.view = view;
    else delete look.view;
    return {
      board, item, look, asked, view, extra,
      entity: entityFor(project, pick('entity') ?? (parsed.entity && { name: parsed.entity, tier: parsed.tier })),
      task: !usesTasks(project) ? null : pick('task') !== undefined ? tokenOrNull(pick('task')) : parsed.task,
      descriptor: pick('descriptor') !== undefined ? tokenOrNull(pick('descriptor')) : parsed.descriptor,
      artist: pick('artist') !== undefined ? tokenOrNull(pick('artist')) : parsed.artist,
    };
  });
  // A number asked for that another version has, or that two of these ask for, is refused now too.
  // Unless it is another view of that version (a file saying which view it is, bty to go with the cmp
  // there): then it goes with that version, as long as the version has no view of that name yet. One
  // saying its view and no number goes with the newest version of its entity and task that lacks that view.
  // An extra goes with a version that is there, or that a file before it in this lot makes: the one
  // its number says, else the nearest before it going to the same entity and task, else the newest.
  const asking = new Map();
  for (const [i, p] of plan.entries()) {
    const label = (n) => naming.label(p.entity.name, p.task, n);
    if (p.extra) {
      const sameStream = (o) => !o.extra && o.task === p.task && (o.entity.make ? p.entity.make && o.entity.name === p.entity.name : o.entity.id === p.entity.id);
      const before = plan.slice(0, i).filter(sameStream);
      const held = p.asked != null && !p.entity.make && store.numberHolder(p.entity.id, p.task, p.asked);
      if (p.asked != null) {
        if (held && !held.deletedAt) p.onto = held;
        else p.with = before.find((o) => o.asked === p.asked) || null;
        if (!p.onto && !p.with) throw refusal(409, `There is no ${label(p.asked)} to add “${p.extra}” to`);
      } else if (before.length) p.with = before[before.length - 1];
      else {
        const newest = !p.entity.make && store.newestVersion(p.entity.id, p.task);
        if (!newest) throw refusal(409, `${naming.label(p.entity.name, p.task, '').replace(/ v$/, '')} has no version to add “${p.extra}” to`);
        p.onto = store.version(newest.id);
      }
      continue;
    }
    if (p.view && p.asked == null && !p.entity.make) {
      const newest = store.newestVersion(p.entity.id, p.task);
      const v = newest && store.version(newest.id);
      if (v && !hasView(v.look, p.view)) p.onto = v;
    }
    if (p.asked == null) continue;
    const taken = !p.entity.make && store.numberHolder(p.entity.id, p.task, p.asked);
    if (taken) {
      if (!p.view || taken.deletedAt) throw refusal(409, takenMessage(taken));
      if (hasView(taken.look, p.view)) throw refusal(409, `${label(p.asked)} has a ${p.view} view already`);
      p.onto = taken;
    }
    const key = `${p.entity.make ? `+${p.entity.name}` : p.entity.id}|${p.task || ''}|${p.asked}`;
    const before = asking.get(key);
    if (before) {
      // Two views of one version brought in together: the first makes it (the main one, or a view), the
      // others go with it.
      const views = [before.view, ...plan.filter((o) => o.with === before).map((o) => o.view)];
      if (!p.view || views.includes(p.view)) throw refusal(409, `${label(p.asked)} is asked for twice`);
      if (!p.onto) p.with = before;
    } else asking.set(key, p);
  }
  const filed = store.transaction(() => plan.map((p) => {
    const entity = madeEntity(project, p.entity, by);
    let v;
    const onto = p.onto || (p.with && p.with.made);
    if (p.extra) {
      v = store.addExtra(onto.id, { ...p.look, label: p.extra }, by, p.board ? p.board.id : null);
      if (!v) throw refusal(409, `${naming.label(entity.name, onto.task, onto.number)} has an extra called “${p.extra}” already`);
      // Said about the piece, it is said about the version, on this extra of it.
      if (p.board) store.fileNotes(p.board.id, p.item.id, v.id, p.extra);
      return { p, v };
    }
    if (onto) {
      v = store.addView(onto.id, { ...p.look, view: p.view });
      // Said about the piece, it is said about the version it is now a view of.
      if (p.board) store.fileNotes(p.board.id, p.item.id, v.id);
      p.made = v;
      return { p, v };
    }
    if (p.view) p.look.view = p.view;
    try {
      v = store.addVersion({
        id: newId(), entityId: entity.id, task: p.task, number: p.asked, descriptor: p.descriptor, artist: p.artist,
        media: uploadName(p.look.src), thumb: p.look.th || (p.look.type === 'image' ? p.look.prev || p.look.src : p.look.poster) || null,
        kind: p.look.type, originalName: p.look.name || null, look: p.look, boardId: p.board ? p.board.id : null, by,
      });
    } catch (err) {
      // One filed before it in this lot took the number: none of them is filed.
      throw err.taken ? refusal(409, takenMessage(err.taken)) : err;
    }
    // What was said about the piece goes with it: from now on it is said about the version.
    if (p.board) store.fileNotes(p.board.id, p.item.id, v.id);
    p.made = v;
    return { p, v };
  }));
  for (const { p, v } of filed) {
    if (!p.board) continue;
    const applied = applyOps(p.board, [{ t: 'set', id: p.item.id, patch: { ver: v.id, ...(p.extra && { ex: p.extra }) } }], null, false);
    if (applied.length) broadcast(p.board, { t: 'op', ops: applied, from: null });
    settle(p.board, applied);
    note(p.board, by || 'Somebody', 'file');
  }
  retellEntities(new Set(filed.map(({ v }) => v.entityId)));
  return filed.map(({ p, v }) => ({ ...publicVersion(v, req.user), ...(p.view && { filedView: p.view }), ...(p.extra && { filedExtra: p.extra }) }));
}

// Who did something: the person signed in, or the name the page gives, without sign-in.
const actor = (req, body, fallback = null) => (req.user ? req.user.name : cleanName(body && body.by, fallback));

// Names of people, as they are given for an entity's artists and cc: each once, at most fifty.
const cleanPeople = (list) => [...new Set((Array.isArray(list) ? list : []).slice(0, 50).map((n) => cleanName(n, null)).filter(Boolean))];

// The label of a version, looked up once however many times it is asked for.
function versionLabels() {
  const known = new Map();
  return (id) => {
    if (!known.has(id)) known.set(id, versionInfo(id)?.label);
    return known.get(id);
  };
}
// A line of a project's Activity: a version filed, or a note written.
const versionLine = (v, entity, label) => ({ kind: 'version', at: v.createdAt, by: v.createdBy, entity, version: { id: v.id, label: label(v.id), thumb: v.thumb, kind: v.kind } });
const noteLine = (n, entity, label) => ({
  kind: 'note', at: n.createdAt, by: n.data.name || n.createdBy, color: n.data.color, entity,
  version: { id: n.versionId, label: label(n.versionId) }, note: { id: n.id, text: String(n.data.text || '').slice(0, 300), reply: !!n.re },
});

// A page of a project's Versions: where the one before ended (`next` in its answer), or, as before,
// a time (only versions filed before it). Undefined for something that is neither.
const VERSIONS_PAGE = 300;
const pageCursor = (v) => Buffer.from(JSON.stringify([v.createdAt, v.number, v.id])).toString('base64url');
function pageAfter(before) {
  if (!before) return [Number.MAX_SAFE_INTEGER, 0, ''];
  if (/^\d+$/.test(before)) return [Number(before), 0, ''];
  try {
    const at = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
    if (Array.isArray(at) && at.length === 3 && Number.isSafeInteger(at[0]) && Number.isSafeInteger(at[1]) && typeof at[2] === 'string') return at;
  } catch {
    // not a page of this list
  }
  return undefined;
}

// What a playlist's versions belong to: its project, or, outside any, the playlist itself.
const playlistScope = (p) => p.projectId || p.id;
// A playlist's versions, in its order: those still there, each with its entity.
const playlistVersions = (p) => p.versions.map((id) => liveVersion(id)).filter(Boolean).map((v) => {
  const e = store.entity(v.entityId);
  return e && e.projectId === playlistScope(p) ? { ...v, entityName: e.name, entityTier: e.tier } : null;
}).filter(Boolean);
// A playlist as a list of them shows it: its name, how many versions, the first stills, when it changed.
// One outside a project also says where it is kept.
const playlistCard = (p) => {
  const list = playlistVersions(p);
  return {
    id: p.id, name: p.name, count: list.length, thumbs: list.map((v) => v.thumb).filter(Boolean).slice(0, 4), createdBy: p.createdBy, createdAt: p.createdAt, updatedAt: p.updatedAt,
    ...(!p.projectId && { loose: true, workspace: spaceName(p.workspace), folderId: p.folderId, entityId: p.entityId }),
  };
};

// ---------------------------------------------------------------- animatics
//
// An animatic is an edit of a project's shots: clips on video tracks, the higher over the lower, and sound
// files on sound tracks, played through as the cut is. A clip names a shot, never a version, and plays the
// newest version of it (of the animatic's task, or of any), so filing a version is all it takes for every
// animatic the shot is in to show it. Every position is in whole frames of the animatic's own rate.

const ANIMATIC_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const MAX_TRACKS = 16;
const MAX_CLIPS = 2000;
const MAX_FRAMES = 60 * 60 * 60 * 6; // six hours at sixty frames a second
const STILL_SECONDS = 3; // how long a still, or a shot with nothing filed, is when it is put on
const wholeIn = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);
const gainOf = (v) => (Number.isFinite(v) ? Math.min(2, Math.max(0, Math.round(v * 100) / 100)) : 1);
const trackId = (v) => typeof v === 'string' && /^[\w-]{1,24}$/.test(v);

// An edit as it may be kept: what it says that makes sense, and nothing else. Its rate is one of the usual
// ones; it has at least one video track and one sound track; each clip is on a track of its kind, a video
// clip names a shot of `project`, and a sound clip an uploaded sound file. Fades are no longer than their
// clip. A dissolve (on the clip after a cut) is no longer than the clip either.
function cleanAnimatic(asked, project) {
  const a = asked && typeof asked === 'object' ? asked : {};
  const tracks = [];
  for (const t of Array.isArray(a.tracks) ? a.tracks.slice(0, MAX_TRACKS) : []) {
    if (!t || !trackId(t.id) || tracks.some((x) => x.id === t.id) || (t.kind !== 'video' && t.kind !== 'audio')) continue;
    const name = String(t.name ?? '').trim().slice(0, 40) || `${t.kind === 'video' ? 'V' : 'A'}${tracks.filter((x) => x.kind === t.kind).length + 1}`;
    tracks.push(t.kind === 'video' ? { id: t.id, kind: 'video', name, mute: t.mute === true, hide: t.hide === true } : { id: t.id, kind: 'audio', name, mute: t.mute === true, gain: gainOf(t.gain) });
  }
  const freeId = (base) => {
    let id = base;
    for (let n = 2; tracks.some((x) => x.id === id); n++) id = `${base}-${n}`;
    return id;
  };
  if (!tracks.some((t) => t.kind === 'video')) tracks.unshift({ id: freeId('v1'), kind: 'video', name: 'V1', mute: false, hide: false });
  if (!tracks.some((t) => t.kind === 'audio')) tracks.push({ id: freeId('a1'), kind: 'audio', name: 'A1', mute: false, gain: 1 });
  const kindOf = new Map(tracks.map((t) => [t.id, t.kind]));
  const shotOk = new Map();
  const isShot = (id) => {
    if (!shotOk.has(id)) {
      const e = typeof id === 'string' && store.entity(id);
      shotOk.set(id, !!e && e.projectId === project.id && e.tier === 'shot');
    }
    return shotOk.get(id);
  };
  const clips = [];
  for (const c of Array.isArray(a.clips) ? a.clips.slice(0, MAX_CLIPS) : []) {
    if (!c || !trackId(c.id) || clips.some((x) => x.id === c.id) || !kindOf.has(c.track)) continue;
    const start = wholeIn(c.start, 0, MAX_FRAMES, null);
    const len = wholeIn(c.len, 1, MAX_FRAMES, null);
    if (start === null || len === null) continue;
    const fadeIn = wholeIn(c.fadeIn, 0, len, 0);
    const clip = { id: c.id, track: c.track, start, len, in: wholeIn(c.in, 0, MAX_FRAMES, 0), fadeIn, fadeOut: Math.min(len - fadeIn, wholeIn(c.fadeOut, 0, len, 0)), dissolve: wholeIn(c.dissolve, 0, len, 0), gain: gainOf(c.gain) };
    if (kindOf.get(c.track) === 'video') {
      if (!isShot(c.shot)) continue;
      clips.push({ ...clip, shot: c.shot, loop: c.loop === true });
    } else {
      const file = uploadName(c.media);
      if (!file || store.media(file)?.kind !== 'audio') continue;
      clips.push({ ...clip, media: `/uploads/${file}`, name: String(c.name ?? '').slice(0, 200), dur: Number.isFinite(c.dur) && c.dur > 0 ? c.dur : null });
    }
  }
  clips.sort((x, y) => x.start - y.start);
  // The sound files brought in, in its library whether or not they are on a track (each once, and every one
  // on a track among them).
  const sounds = [];
  const addSound = (x) => {
    const file = x && uploadName(x.media);
    if (!file || store.media(file)?.kind !== 'audio' || sounds.some((y) => y.media === `/uploads/${file}`) || sounds.length >= 200) return;
    sounds.push({ media: `/uploads/${file}`, name: String(x.name ?? '').slice(0, 200), dur: Number.isFinite(x.dur) && x.dur > 0 ? x.dur : null });
  };
  for (const x of Array.isArray(a.sounds) ? a.sounds : []) addSound(x);
  for (const c of clips) if (c.media) addSound(c);
  const task = typeof a.task === 'string' ? naming.tokenize(a.task).slice(0, 40) || null : null;
  return {
    fps: ANIMATIC_RATES.includes(a.fps) ? a.fps : 25, w: wholeIn(a.w, 16, 8192, 1920), h: wholeIn(a.h, 16, 8192, 1080),
    task, view: viewName(a.view) || '', tracks, clips, sounds,
  };
}

// The newest version of each of some shots, as an animatic of `task` plays them: { shot id: { id, name, seq,
// version: { id, task, number, label, kind, look } or null } }. The look is the version's whole one, as the
// player needs it (its phone copy, its colour strip, its views).
function animaticShots(ids, task) {
  const list = [...new Set(ids)].map((id) => store.entity(id)).filter(Boolean);
  const cards = task ? null : store.entityCards(list.map((e) => e.id));
  const out = {};
  for (const e of list) {
    const glance = task ? store.newestOfTask(e.id, task) : cards.get(e.id)?.newest;
    const v = glance && liveVersion(glance.id);
    out[e.id] = {
      id: e.id, name: e.name, seq: naming.seqOf(e.name),
      version: v ? { id: v.id, task: v.task, number: v.number, label: naming.label(e.name, v.task, v.number), kind: v.kind, look: v.look } : null,
    };
  }
  return out;
}
// How long a clip of a version is when it is put on: the version's length, or a still's few seconds.
const framesOf = (version, fps) => {
  const look = version && version.look;
  const dur = look && look.type === 'video' && look.dur > 0 ? look.dur : STILL_SECONDS;
  return Math.max(1, Math.round(dur * fps));
};
// The rate a new animatic of a project starts at: the one most of its shots' newest versions have, near
// enough, or 25.
function usualRate(project) {
  const count = new Map();
  for (const e of store.entities(project.id)) {
    const fps = e.tier === 'shot' && e.newest && e.newest.look.fps;
    if (!(fps > 0)) continue;
    const rate = ANIMATIC_RATES.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best));
    if (Math.abs(rate - fps) < 0.05) count.set(rate, (count.get(rate) || 0) + 1);
  }
  return [...count].sort((x, y) => y[1] - x[1])[0]?.[0] || 25;
}
// A shot named by its own id or by one of its versions' (from a list of versions, say), or null.
const shotFor = (id) => {
  if (typeof id !== 'string') return null;
  const e = store.entity(id) || store.entity(liveVersion(id)?.entityId);
  return e && e.tier === 'shot' ? e.id : null;
};
// The shape a new animatic of a project starts at: the one most of its shots' newest versions have (in a
// project with a model of its venue, the unwrapped picture its screens show), or 1920 x 1080.
function usualShape(project) {
  const count = new Map();
  for (const e of store.entities(project.id)) {
    const look = e.tier === 'shot' && e.newest && e.newest.look;
    if (!look || !(look.nw >= 16 && look.nh >= 16)) continue;
    const key = `${Math.round(look.nw)}x${Math.round(look.nh)}`;
    count.set(key, (count.get(key) || 0) + 1);
  }
  const best = [...count].sort((x, y) => y[1] - x[1])[0];
  if (!best) return { w: 1920, h: 1080 };
  const [w, h] = best[0].split('x').map(Number);
  return { w: Math.min(8192, w), h: Math.min(8192, h) };
}
// Shots put at the end of an animatic's first video track, one after another, each as long as its newest
// version. `asked` may name each by a version of it. Returns the edit with them on.
function appendShots(doc, asked) {
  const v1 = doc.tracks.find((t) => t.kind === 'video');
  const ids = asked.map(shotFor).filter(Boolean);
  const shots = animaticShots(ids, doc.task);
  let at = doc.clips.filter((c) => c.track === v1.id).reduce((end, c) => Math.max(end, c.start + c.len), 0);
  const added = ids.filter((id) => shots[id]).map((id) => {
    const len = framesOf(shots[id].version, doc.fps);
    const clip = { id: newId(6), track: v1.id, start: at, len, in: 0, shot: id };
    at += len;
    return clip;
  });
  return { ...doc, clips: [...doc.clips, ...added] };
}
// An animatic as a list of them shows it: its name, how many shots, the first stills along its first track,
// how long it runs, when it changed and who changed it.
function animaticCard(a) {
  const shown = a.doc.clips.filter((c) => c.shot).sort((x, y) => x.start - y.start);
  const cards = store.entityCards([...new Set(shown.slice(0, 12).map((c) => c.shot))]);
  const end = a.doc.clips.reduce((n, c) => Math.max(n, c.start + c.len), 0);
  return {
    id: a.id, name: a.name, shots: new Set(shown.map((c) => c.shot)).size, dur: end / a.doc.fps,
    thumbs: [...new Set(shown.map((c) => cards.get(c.shot)?.thumb).filter(Boolean))].slice(0, 4),
    createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt, updatedBy: a.updatedBy,
  };
}
// An animatic whole, as its page needs it: the edit, which save it is, and the newest version of each shot on it.
const animaticOut = (a) => ({ animatic: animaticCard(a), projectId: a.projectId, doc: a.doc, rev: a.rev, shots: animaticShots(a.doc.clips.filter((c) => c.shot).map((c) => c.shot), a.doc.task) });

async function handleCatalogue(req, res, parts) {
  const projectFor = (id) => (visibleFolder(req.user, id) && folders.get(id).project ? folders.get(id) : null);
  const boardsSeen = (list) => list.filter((b) => canSee(req.user, b.workspace)).map((b) => ({ id: b.id, name: b.name }));
  // Versions as a list shows them (the Versions page, a playlist): each read with its entity's name and
  // tier. `full` sends the whole of each one's look, as the player needs it to play them one after another.
  const shape = (list, { full = false } = {}) => {
    const on = store.boardsWithVersions(list.map((v) => v.id));
    return list.map((v) => {
      const { src, poster, th, dur, fps, nw, nh, type } = v.look;
      return {
        id: v.id, entityId: v.entityId, entity: v.entityName, tier: v.entityTier, task: v.task, number: v.number,
        label: naming.label(v.entityName, v.task, v.number), kind: v.kind, thumb: v.thumb, look: full ? v.look : { type, src, poster, th, dur, fps, nw, nh },
        views: [v.look.view || '', ...(v.look.views || []).map((x) => x.view)].filter((x, i) => i || (v.look.views || []).length),
        extras: (v.look.extras || []).map((x) => x.label),
        artist: v.artist, createdAt: v.createdAt, createdBy: v.createdBy, hidden: v.hidden, originalName: v.originalName, boards: boardsSeen(on.get(v.id)),
      };
    });
  };
  // Versions asked to go on a playlist of `project` (or, for one outside a project, the playlist's own id):
  // each once, only its own and still there.
  const versionsFor = (scope, ids) => [...new Set(Array.isArray(ids) ? ids : [])].slice(0, 1000)
    .filter((id) => typeof id === 'string' && liveVersion(id) && store.entity(liveVersion(id).entityId)?.projectId === scope);
  // GET /api/projects/:id                  the project and its entities
  // POST /api/projects/:id/entities        { name, tier }
  // POST /api/projects/:id/versions        { files, entity, task, descriptor, artist }
  if (parts[1] === 'projects') {
    const project = projectFor(parts[2]);
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    if (parts.length === 3 && req.method === 'GET') {
      return sendJson(res, 200, {
        project: publicFolder(project),
        tiers: naming.TIER_LIST,
        entities: store.entities(project.id),
        tasks: [...new Set([...naming.TASKS, ...store.projectTasks(project.id)])],
        artists: store.projectArtists(project.id),
        views: store.projectViews(project.id),
        // How its versions are shown: its views, the main one first, or null for one way.
        viewList: viewsOf(project),
        boards: [...boards.values()].filter((b) => visible(req.user, b) && boardProject(b) === project).map((b) => ({ id: b.id, name: b.name })),
        playlists: store.playlists(project.id).map(playlistCard),
        animatics: store.animatics(project.id).map(animaticCard),
      });
    }
    // GET /api/projects/:id/animatics                  its animatics, the one changed last first
    // POST /api/projects/:id/animatics { name, doc }    a new one, as given (or empty)
    //   { name, from: 'timeline', seq }                 the shots of the timeline (of one sequence), each filed one
    //                                                   after another on V1, as long as its newest version
    //   { name, shots: [ids] }                          these shots (or the shots of these versions), the same way
    //   { name, copy: id }                              another of its animatics, as it is
    if (parts.length === 4 && parts[3] === 'animatics') {
      if (req.method === 'GET') return sendJson(res, 200, { animatics: store.animatics(project.id).map(animaticCard) });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const body = await readJson(req, 1024 * 1024);
      const name = cleanName(body.name, null);
      if (!name) return sendJson(res, 400, { error: 'An animatic needs a name' });
      let doc = cleanAnimatic(body.doc || { fps: usualRate(project), ...usualShape(project) }, project);
      if (body.copy !== undefined) {
        const from = store.animatic(body.copy);
        if (!from || from.projectId !== project.id) return sendJson(res, 404, { error: 'Animatic not found' });
        doc = cleanAnimatic(from.doc, project);
      } else if (body.from === 'timeline' || Array.isArray(body.shots)) {
        const ids = body.from === 'timeline'
          ? timelineShots(project.id, doc.task).filter(({ e, v }) => v && (!body.seq || naming.seqOf(e.name) === body.seq)).map(({ e }) => e.id)
          : body.shots.slice(0, MAX_CLIPS).filter((id) => typeof id === 'string');
        doc = cleanAnimatic(appendShots(doc, ids), project);
      }
      const a = store.addAnimatic({ id: newId(), projectId: project.id, name, doc, by: actor(req, body) });
      return sendJson(res, 201, animaticOut(a));
    }
    // GET /api/projects/:id/playlists          its playlists, the one changed last first
    // POST /api/projects/:id/playlists { name, versions }   a new one, with these versions on it to begin with
    // POST /api/projects/:id/playlists { name, board }      a new one of the versions a board of the project
    //                                                        shows, in the order the board reads
    if (parts.length === 4 && parts[3] === 'playlists') {
      if (req.method === 'GET') return sendJson(res, 200, { playlists: store.playlists(project.id).map(playlistCard) });
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      const body = await readJson(req, 256 * 1024);
      const name = cleanName(body.name, null);
      if (!name) return sendJson(res, 400, { error: 'A playlist needs a name' });
      let ids = body.versions;
      if (body.board !== undefined) {
        const board = boards.get(body.board);
        if (!visible(req.user, board) || boardProject(board) !== project) return sendJson(res, 404, { error: 'Board not found' });
        ids = boardReadingVersions(board);
        if (!ids.length) return sendJson(res, 400, { error: 'Nothing on that board is filed as a version' });
      }
      const p = store.addPlaylist({ id: newId(), projectId: project.id, name, versions: versionsFor(project.id, ids), by: actor(req, body) });
      return sendJson(res, 200, playlistCard(p));
    }
    // POST /api/projects/:id/likely { looks: [{ key, type, dur, fps, nw, nh, wf }] }: for each video about
    // to be filed, the assets, sets and shots (and tasks) whose newest version it most likely follows,
    // by its length, frame rate, size and picture (likely.js): { answers: { key: [{ entityId, entity,
    // task, number, score, why }] } }. `wf` is its colour strip's colours (the `c` of its strip).
    if (parts.length === 4 && parts[3] === 'likely' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      const looks = Array.isArray(body.looks) ? body.looks.slice(0, 200) : [];
      const heads = store.streamHeads(project.id);
      const names = new Map();
      const nameOf = (id) => (names.has(id) ? names.get(id) : names.set(id, store.entity(id)?.name || null).get(id));
      const answers = {};
      for (const l of looks) {
        if (!l || typeof l.key !== 'string') continue;
        const look = { type: l.type, dur: Number(l.dur) || 0, fps: Number(l.fps) || 0, nw: Number(l.nw) || 0, nh: Number(l.nh) || 0, wf: typeof l.wf === 'string' ? l.wf : null };
        answers[l.key] = likely.likelyFor(look, heads, headStrip).map(({ head, score, why }) => ({
          entityId: head.entityId, entity: nameOf(head.entityId), task: head.task, number: head.number, score, why,
        }));
      }
      return sendJson(res, 200, { answers });
    }
    // GET /api/projects/:id/versions?before=   its versions, newest filed first, a page at a time: the
    // project's Versions list. `next`, when there are more, is what to give as `before` for the next page.
    //
    // GET /api/projects/:id/versions?find=1&...  the same, as the Versions page asks for it: filtered by any
    // of `task`, `seq`, `tier`, `by` (who filed), `artist` (each comma separated; an empty task is none),
    // `since` (a time), words `q`, only the `newest` of each entity and task, `archived` ones too; in a
    // `sort` (new, old, name, number); a page at a time from `offset`, `limit` long (at most 300). With every page, `total` and
    // `facets`: what there is to filter by (its tasks, sequences, tiers, filers, artists).
    if (parts.length === 4 && parts[3] === 'versions' && req.method === 'GET') {
      const sp = new URL(req.url, 'http://x').searchParams;
      // Which boards each is on is read from the database, so what is waiting to be written goes first.
      flushAll();
      if (sp.get('find')) {
        const listOf = (key) => (sp.get(key) === null ? null : sp.get(key).split(',').map((x) => x.trim()).slice(0, 100));
        const offset = Math.max(0, Math.min(1e6, Number(sp.get('offset')) || 0));
        const found = store.findVersions(project.id, {
          tasks: listOf('task'), seqs: listOf('seq'), tiers: listOf('tier'), by: listOf('by'), artists: listOf('artist'),
          since: Number(sp.get('since')) || 0, q: (sp.get('q') || '').slice(0, 200), newest: sp.get('newest') === '1', archived: sp.get('archived') === '1',
          sort: sp.get('sort') || 'new', offset, limit: Math.max(1, Math.min(VERSIONS_PAGE, Number(sp.get('limit')) || VERSIONS_PAGE)),
        });
        const out = { versions: shape(found.list), total: found.total, more: offset + found.list.length < found.total, offset: offset + found.list.length };
        const ents = store.entities(project.id);
        out.facets = {
          tasks: store.projectTasks(project.id), filers: store.projectFilers(project.id), artists: store.projectArtists(project.id),
          seqs: [...new Set(ents.filter((e) => e.tier === 'shot' && naming.seqOf(e.name)).map((e) => naming.seqOf(e.name)))].sort(naming.seqOrder(project.settings && project.settings.seqs)),
          tiers: naming.TIER_LIST.filter((t) => ents.some((e) => e.tier === t.id)).map((t) => ({ id: t.id, label: t.label })),
          untasked: ents.some((e) => e.tops && e.tops['']),
        };
        return sendJson(res, 200, out);
      }
      const after = pageAfter(sp.get('before'));
      if (!after) return sendJson(res, 400, { error: 'That is not a page of this list' });
      const list = store.projectVersions(project.id, { after, limit: VERSIONS_PAGE });
      const more = list.length === VERSIONS_PAGE;
      return sendJson(res, 200, { versions: shape(list), more, next: more ? pageCursor(list.at(-1)) : null });
    }
    // PATCH /api/projects/:id/versions { edits: [{ id, entity, task, number, artist, hidden }] }: many versions
    // changed at once, each as its edit says (what it leaves out stays): moved to another asset, set or shot
    // (one to make, by name) or task, with the next number there unless one is given, an artist, archived or
    // brought back. In the order given, so several moved to one place keep their order. Everything is
    // checked as it is done, in one write: a number taken anywhere changes nothing.
    if (parts.length === 4 && parts[3] === 'versions' && req.method === 'PATCH') {
      const body = await readJson(req, 512 * 1024);
      const edits = Array.isArray(body.edits) ? body.edits.slice(0, 1000) : [];
      if (!edits.length) return sendJson(res, 400, { error: 'Nothing to change' });
      const by = actor(req, body);
      const told = new Set();
      const done = store.transaction(() => edits.map((ed) => {
        const v = ed && typeof ed === 'object' && store.version(ed.id);
        const was = v && store.entity(v.entityId);
        if (!v || v.deletedAt || !was || was.projectId !== project.id) throw refusal(404, 'One of those versions is not in this project');
        const edit = {};
        const target = ed.entity !== undefined ? entityFor(project, ed.entity) : null;
        if (ed.task !== undefined) edit.task = usesTasks(project) ? tokenOrNull(ed.task) : null;
        if (ed.artist !== undefined) edit.artist = tokenOrNull(ed.artist);
        if (ed.number !== undefined && ed.number !== null) {
          if (!validNumber(Number(ed.number))) throw refusal(400, 'A version number is a whole number from 1');
          edit.number = Number(ed.number);
        }
        if (target) edit.entityId = madeEntity(project, target, by).id;
        if ('hidden' in ed) store.hideVersion(v.id, !!ed.hidden);
        if (Object.keys(edit).length) {
          const r = store.editVersion(v.id, edit);
          if (!r.ok) throw refusal(409, takenMessage(r.taken));
        }
        told.add(was.id);
        const now = store.version(v.id);
        told.add(now.entityId);
        return publicVersion(now, req.user);
      }));
      retellEntities(told);
      for (const id of told) tellRoom(id);
      return sendJson(res, 200, { versions: done });
    }
    // POST /api/projects/:id/place { board, versions: [ids], layout }: puts versions on one of the
    // project's boards, as pieces that are those versions, below what is on it already: in rows, or
    // with `layout: 'sequences'` a column for each sequence, its shots going down from first to last
    // (assets and sets in columns of their own after them).
    if (parts.length === 4 && parts[3] === 'place' && req.method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      const board = boards.get(body.board);
      if (!visible(req.user, board) || boardProject(board) !== project) return sendJson(res, 404, { error: 'Board not found' });
      const ids = Array.isArray(body.versions) ? [...new Set(body.versions)].slice(0, 200) : [];
      const list = ids.map((id) => liveVersion(id)).filter((v) => v && store.entity(v.entityId).projectId === project.id);
      if (!list.length) return sendJson(res, 400, { error: 'Pick versions of this project' });
      openItems(board);
      // Where what is on the board ends: its left edge, its bottom, its topmost layer. A loop, not a
      // spread into Math.min, which a board of many thousands of pieces would overflow.
      let left = Infinity;
      let bottom = -Infinity;
      let z = 0;
      for (const it of board.items.values()) {
        z = Math.max(z, it.z || 0);
        if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) continue;
        left = Math.min(left, it.x);
        bottom = Math.max(bottom, it.y + (it.h || 0));
      }
      if (left === Infinity) left = 0;
      const top = bottom === -Infinity ? 0 : bottom + 160;
      const W = 750;
      const GAP = 24;
      const sizeOf = (look) => {
        const h = Math.round(Math.min(1080, W * ((look.nh || 9) / (look.nw || 16))));
        return { w: Math.round(h === 1080 ? 1080 * ((look.nw || 16) / (look.nh || 9)) : W), h };
      };
      const piece = (v, x, y) => ({ t: 'add', item: { ...v.look, id: newId(), type: v.look.type, x: left + x, y: top + y, ...sizeOf(v.look), z: ++z, ver: v.id } });
      const ops = [];
      if (body.layout === 'sequences') {
        const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true });
        const bySeq = naming.seqOrder(project.settings && project.settings.seqs);
        const cols = new Map();
        for (const v of list) {
          const e = store.entity(v.entityId);
          const key = e.tier === 'shot' ? `0:${naming.seqOf(e.name) || e.name}` : `${e.tier === 'asset' ? 1 : 2}:${e.tier === 'asset' ? 'Assets' : 'Sets'}`;
          (cols.get(key) || cols.set(key, []).get(key)).push({ v, name: e.name });
        }
        let x = 0;
        for (const key of [...cols.keys()].sort((a, b) => a[0] - b[0] || (a[0] === '0' ? bySeq(a.slice(2), b.slice(2)) : byName(a, b)))) {
          const col = cols.get(key).sort((a, b) => byName(a.name, b.name) || byName(a.v.task || '', b.v.task || '') || a.v.number - b.v.number);
          let y = 0;
          let widest = 0;
          for (const { v } of col) {
            const op = piece(v, x, y);
            ops.push(op);
            y += op.item.h + GAP;
            widest = Math.max(widest, op.item.w);
          }
          x += widest + 120;
        }
      } else {
        const cols = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(list.length * 1.5))));
        let x = 0;
        let y = 0;
        let tallest = 0;
        list.forEach((v, i) => {
          if (i && i % cols === 0) {
            x = 0;
            y += tallest + GAP;
            tallest = 0;
          }
          const op = piece(v, x, y);
          ops.push(op);
          x += op.item.w + GAP;
          tallest = Math.max(tallest, op.item.h);
        });
      }
      const applied = applyOps(board, ops, null, true);
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: null });
      settle(board, applied);
      note(board, actor(req, body, 'Somebody'), 'add', list.length);
      return sendJson(res, 200, { board: { id: board.id, name: board.name }, placed: ops.map((o) => o.item.id) });
    }
    // GET /api/projects/:id/activity   what happened in the project in the last two weeks, newest first:
    // versions filed and comments written, on any of its assets, sets and shots (the project's home shows it).
    if (parts.length === 4 && parts[3] === 'activity' && req.method === 'GET') {
      const byId = new Map(store.entities(project.id).map((e) => [e.id, e]));
      // Enough of two weeks to say what each person did, grouped (the project's home groups them).
      const { versions, notes } = store.happenings([...byId.keys()], Date.now() - 14 * 24 * 3600 * 1000, 600);
      const about = (id) => {
        const e = byId.get(id);
        return { id: e.id, name: e.name, tier: e.tier, projectId: project.id, project: project.name };
      };
      const label = versionLabels();
      const items = [
        ...versions.map((v) => versionLine(v, about(v.entityId), label)),
        ...notes.map((n) => noteLine(n, about(n.entityId), label)),
      ].sort((a, b) => b.at - a.at).slice(0, 600);
      return sendJson(res, 200, { items });
    }
    // GET /api/projects/:id/timeline?task=   every shot in order, by sequence, with its newest version (of
    // that task, or of any), what the timeline view lays out and plays through.
    if (parts.length === 4 && parts[3] === 'timeline' && req.method === 'GET') {
      const task = new URL(req.url, 'http://x').searchParams.get('task');
      const inOrder = naming.shotOrder(project.settings && project.settings.seqs);
      const shots = store.entities(project.id).filter((e) => e.tier === 'shot').sort((a, b) => inOrder(a.name, b.name));
      return sendJson(res, 200, {
        tasks: store.projectTasks(project.id),
        views: store.projectViews(project.id),
        shots: shots.map((e) => {
          const v = task ? store.newestOfTask(e.id, naming.tokenize(task) || null) : e.newest;
          return {
            id: e.id, name: e.name, seq: naming.seqOf(e.name), artists: e.artists,
            version: v && { ...v, label: naming.label(e.name, v.task, v.number) },
          };
        }),
      });
    }
    // PATCH { ids, tier, artists: { add, remove, set }, cc: { add, remove, set }, names, tiers }: many at once. What is not
    // said of them is left as each has it; all or none are changed.
    if (parts.length === 4 && parts[3] === 'entities' && req.method === 'PATCH') {
      const body = await readJson(req, 1024 * 1024);
      const ids = Array.isArray(body.ids) ? [...new Set(body.ids)].slice(0, 2000) : [];
      const list = ids.map((id) => store.entity(id));
      if (!list.length || list.some((e) => !e || e.projectId !== project.id)) return sendJson(res, 400, { error: 'Pick assets, sets or shots of this project' });
      if (body.tier !== undefined && !naming.TIERS.includes(body.tier)) return sendJson(res, 400, { error: 'An asset, a set or a shot' });
      // { names: { id: name }, tiers: { id: tier } }: each its own (as Claude suggests in batch edit).
      const own = (map) => (map && typeof map === 'object' && !Array.isArray(map) ? map : {});
      const names = new Map();
      for (const [id, n] of Object.entries(own(body.names))) {
        if (!ids.includes(id)) return sendJson(res, 400, { error: 'Rename only what is picked' });
        const name = naming.tokenize(n);
        if (!name) return sendJson(res, 400, { error: 'An asset, set or shot needs a name' });
        names.set(id, name);
      }
      const tiers = own(body.tiers);
      for (const [id, t] of Object.entries(tiers)) {
        if (!ids.includes(id)) return sendJson(res, 400, { error: 'Change only what is picked' });
        if (!naming.TIERS.includes(t)) return sendJson(res, 400, { error: 'An asset, a set or a shot' });
      }
      // The names as they will all be: none twice, and none another of the project's has.
      const after = new Map(list.map((e) => [e.id, names.get(e.id) || e.name]));
      const seen = new Map();
      for (const [id, n] of after) {
        if (seen.has(n)) return sendJson(res, 409, { error: `Two would be called ${n}` });
        seen.set(n, id);
      }
      for (const n of names.values()) {
        const have = store.entityNamed(project.id, n);
        if (have && !after.has(have.id)) return sendJson(res, 409, { error: `There is a ${n} in this project already` });
      }
      const change = (now, how) => {
        if (!how || typeof how !== 'object') return now;
        if (Array.isArray(how.set)) return cleanPeople(how.set);
        const drop = cleanPeople(how.remove).map((n) => n.toLowerCase());
        const kept = now.filter((n) => !drop.includes(n.toLowerCase()));
        for (const n of cleanPeople(how.add)) if (!kept.some((k) => k.toLowerCase() === n.toLowerCase())) kept.push(n);
        return kept;
      };
      const done = store.transaction(() => {
        // Renamed in two steps, so names can go round among them (a to b, b to a).
        const moving = list.filter((e) => names.has(e.id) && names.get(e.id) !== e.name);
        for (const e of moving) store.setEntity(e.id, { name: `~${e.id}` });
        return list.map((e) => store.setEntity(e.id, {
          ...(names.has(e.id) && { name: names.get(e.id) }),
          ...(tiers[e.id] ? { tier: tiers[e.id] } : body.tier !== undefined && { tier: body.tier }),
          artists: change(e.artists, body.artists),
          cc: change(e.cc, body.cc),
        }).entity);
      });
      retellEntities(new Set(done.map((e) => e.id)));
      return sendJson(res, 200, { entities: done });
    }
    // { name, tier } makes one; { names: [...], tier } sets up many at once, before anything is filed of
    // them. A name the project has already is left as it is. Without a tier, the name's shape says.
    if (parts.length === 4 && parts[3] === 'entities' && req.method === 'POST') {
      const body = await readJson(req, 1024 * 1024);
      const by = actor(req, body);
      if (!Array.isArray(body.names)) return sendJson(res, 201, resolveEntity(project, { name: body.name, tier: body.tier }, by));
      const wanted = [...new Set(body.names.slice(0, 2000).map((n) => naming.tokenize(n)).filter(Boolean))];
      if (!wanted.length) return sendJson(res, 400, { error: 'No names to add' });
      const had = wanted.filter((n) => store.entityNamed(project.id, n));
      const made = store.transaction(() => wanted.filter((n) => !had.includes(n)).map((n) => resolveEntity(project, { name: n, tier: body.tier }, by)));
      return sendJson(res, 201, { made, had });
    }
    if (parts.length === 4 && parts[3] === 'versions' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      return sendJson(res, 201, { versions: fileVersions(req, project, body) });
    }
    // POST /api/projects/:id/ai/files { instruction, files: [{ key, filename, now }] }: what Claude would file
    // each as. POST /api/projects/:id/ai/entities { instruction, ids }: what Claude would rename them to.
    // Only suggestions: nothing is changed here (ai.js).
    if (parts.length === 5 && parts[3] === 'ai' && req.method === 'POST' && (parts[4] === 'files' || parts[4] === 'entities')) {
      if (!ai.enabled) return sendJson(res, 503, { error: 'Claude is not set up on this server' });
      const body = await readJson(req, 1024 * 1024);
      const who = `${project.id}:${actor(req, body, '') || clientAddress(req, process.env.TRUST_PROXY)}`;
      if (aiBusy.has(who)) return sendJson(res, 429, { error: 'Claude is still answering your last question' });
      aiBusy.add(who);
      try {
        const entities = store.entities(project.id);
        const tasks = store.projectTasks(project.id);
        if (parts[4] === 'files') {
          const files = (Array.isArray(body.files) ? body.files : []).filter((f) => f && typeof f === 'object')
            .map((f) => ({ key: String(f.key), filename: String(f.filename || ''), now: f.now && typeof f.now === 'object' ? f.now : null }));
          if (files.length > ai.MAX_FILES) return sendJson(res, 400, { error: `Ask about at most ${ai.MAX_FILES} files at a time` });
          const answers = await ai.fileNames({ instruction: body.instruction, files, entities, tasks, views: viewsOf(project) || [], useViews: !!viewsOf(project), useTasks: usesTasks(project) });
          return sendJson(res, 200, { model: ai.model, answers });
        }
        const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(String))] : [];
        if (ids.length > ai.MAX_ENTITIES) return sendJson(res, 400, { error: `Ask about at most ${ai.MAX_ENTITIES} at a time` });
        const chosen = ids.map((id) => entities.find((e) => e.id === id));
        if (!chosen.length || chosen.some((e) => !e)) return sendJson(res, 400, { error: 'Pick assets, sets or shots of this project' });
        const withFiles = chosen.map((e) => ({
          id: e.id, name: e.name, tier: e.tier,
          files: [...new Set(store.versionsOf(e.id).map((v) => v.originalName).filter(Boolean))].slice(0, 3),
        }));
        const answers = await ai.renameEntities({ instruction: body.instruction, chosen: withFiles, entities, tasks });
        return sendJson(res, 200, { model: ai.model, answers });
      } finally {
        aiBusy.delete(who);
      }
    }
    return sendJson(res, 404, { error: 'Not found' });
  }
  // PATCH /api/entities/:id { name, tier, artists, cc }: renamed, or who works on it and who follows it.
  if (parts[1] === 'entities' && parts.length === 3 && req.method === 'PATCH') {
    const entity = store.entity(parts[2]);
    const project = entity && projectFor(entity.projectId);
    if (!project) return sendJson(res, 404, { error: 'Not found' });
    const body = await readJson(req);
    const edit = {};
    if (body.name !== undefined) {
      edit.name = naming.tokenize(body.name);
      if (!edit.name) return sendJson(res, 400, { error: 'An asset, set or shot needs a name' });
    }
    if (body.tier !== undefined) {
      if (!naming.TIERS.includes(body.tier)) return sendJson(res, 400, { error: 'An asset, a set or a shot' });
      edit.tier = body.tier;
    }
    if (body.artists !== undefined) edit.artists = cleanPeople(body.artists);
    if (body.cc !== undefined) edit.cc = cleanPeople(body.cc);
    const done = store.setEntity(entity.id, edit);
    if (!done.ok) return sendJson(res, 409, { error: `There is a ${done.taken.name} in this project already` });
    retellEntity(entity.id);
    return sendJson(res, 200, done.entity);
  }
  // GET /api/entities/:id: an entity, every version of it, and everything said about them.
  if (parts[1] === 'entities' && parts.length === 3 && req.method === 'GET') {
    const entity = store.entity(parts[2]);
    const project = entity && projectFor(entity.projectId);
    if (!project) return sendJson(res, 404, { error: 'Not found' });
    // Which boards each version is on is read from the database, so what is waiting to be written goes first.
    flushAll();
    const versions = store.versionsOf(entity.id);
    const on = store.boardsWithVersions(versions.map((v) => v.id));
    const notes = store.notesOfVersions(versions.map((v) => v.id)).map((n) => ({
      id: n.id, versionId: n.versionId, re: n.re, board: { id: n.boardId, name: boardNameFor(req.user, n.boardId, n.boardName, n.boardWorkspace) }, ...noteData(n.data),
    }));
    return sendJson(res, 200, {
      entity, project: publicFolder(project),
      versions: versions.map((v) => ({ ...publicVersion(v, req.user), boards: boardsSeen(on.get(v.id)) })),
      notes,
    });
  }
  // GET /api/people: every name the app knows, for picking artists and people to keep in the loop.
  if (parts[1] === 'people' && parts.length === 2 && req.method === 'GET') {
    return sendJson(res, 200, { people: store.people() });
  }
  // POST /api/playlists { name, folderId, workspace }   a new playlist outside any project, in a folder
  //                                                       (not one in a project: those make theirs there)
  //                                                       or at the top of a workspace; empty, to upload versions to
  if (parts[1] === 'playlists' && parts.length === 2 && req.method === 'POST') {
    const body = await readJson(req);
    const name = cleanName(body.name, null);
    if (!name) return sendJson(res, 400, { error: 'A playlist needs a name' });
    const folderId = body.folderId || null;
    if (folderId && !visibleFolder(req.user, folderId)) return sendJson(res, 404, { error: 'Folder not found' });
    if (folderId && projectOf(folderId)) return sendJson(res, 400, { error: 'A playlist in a project is made from its Reviews' });
    const workspace = folderId ? folders.get(folderId).workspace : spaceKey(body.workspace, req.user);
    const p = store.addPlaylist({ id: newId(), name, workspace, folderId, by: actor(req, body) });
    return sendJson(res, 201, playlistCard(p));
  }
  // GET /api/playlists/:id      the playlist, and its versions in order, each whole, to list and to play
  // PATCH { name }              renamed
  // PATCH { versions }          its versions given anew, in their new order (moved, taken off)
  // PATCH { add }               these put at its end (any it has already stay where they are)
  // PATCH { folderId }          one outside a project moved to a folder (null: the top of its workspace);
  //                             { workspace } to the other workspace, landing at its top
  // DELETE                      gone; its versions are not touched
  // POST .../versions { files: [{ look }] }   one outside a project: files uploaded to it, each the next version
  if (parts[1] === 'playlists' && (parts.length === 3 || (parts.length === 4 && parts[3] === 'versions'))) {
    const p = store.playlist(parts[2]);
    const project = p && p.projectId ? projectFor(p.projectId) : null;
    const mine = p && !p.projectId && canSee(req.user, p.workspace);
    if (!project && !mine) return sendJson(res, 404, { error: 'Playlist not found' });
    const scope = playlistScope(p);
    if (parts.length === 4) {
      if (req.method !== 'POST' || !mine) return sendJson(res, 405, { error: 'Method not allowed' });
      const body = await readJson(req, 4 * 1024 * 1024);
      const by = actor(req, body);
      const looks = (Array.isArray(body.files) ? body.files.slice(0, 50) : []).map((f) => cleanLook(f && f.look));
      if (!looks.length || looks.some((look) => !look)) return sendJson(res, 400, { error: 'That file is not on the server' });
      // Each is the next number of the playlist's one entity, in the order they were sent; a view or an
      // extra has no meaning here, so only the file itself is kept.
      const made = store.transaction(() => looks.map((look) => store.addVersion({
        id: newId(), entityId: p.entityId, media: uploadName(look.src), thumb: look.th || (look.type === 'image' ? look.prev || look.src : look.poster) || null,
        kind: look.type, originalName: look.name || null, look: { ...look, views: undefined, extras: undefined }, by,
      })));
      store.setPlaylist(p.id, { versions: [...p.versions, ...made.map((v) => v.id)].slice(0, 1000) });
      flushAll();
      const done = store.playlist(p.id);
      return sendJson(res, 200, { playlist: playlistCard(done), versions: shape(playlistVersions(done), { full: true }) });
    }
    if (req.method === 'GET') {
      flushAll();
      return sendJson(res, 200, { playlist: playlistCard(p), versions: shape(playlistVersions(p), { full: true }) });
    }
    if (req.method === 'DELETE') {
      store.deletePlaylist(p.id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req, 256 * 1024);
    const patch = {};
    if (body.name !== undefined) {
      patch.name = cleanName(body.name, null);
      if (!patch.name) return sendJson(res, 400, { error: 'A playlist needs a name' });
    }
    if (body.versions !== undefined) patch.versions = versionsFor(scope, body.versions);
    if (body.add !== undefined) {
      const have = patch.versions || p.versions;
      patch.versions = [...have, ...versionsFor(scope, body.add).filter((id) => !have.includes(id))].slice(0, 1000);
    }
    if (mine && ('folderId' in body || 'workspace' in body)) {
      const key = 'workspace' in body ? spaceKey(body.workspace, req.user) : p.workspace;
      if ('workspace' in body && body.workspace === 'personal' && !req.user) return sendJson(res, 400, { error: 'Personal workspaces need sign-in' });
      const folderId = key !== p.workspace ? null : body.folderId || null;
      if (folderId && !visibleFolder(req.user, folderId)) return sendJson(res, 404, { error: 'Folder not found' });
      if (folderId && folders.get(folderId).workspace !== key) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
      if (folderId && projectOf(folderId)) return sendJson(res, 400, { error: 'A playlist cannot be moved into a project' });
      patch.workspace = key;
      patch.folderId = folderId;
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'Nothing to change' });
    const done = store.setPlaylist(p.id, patch);
    if (patch.workspace && patch.workspace !== p.workspace) dropRoomStrangers();
    return sendJson(res, 200, playlistCard(done));
  }
  // GET /api/animatics/:id/download   the cut for a playback system, as one zip (see sendAnimaticZip)
  if (parts[1] === 'animatics' && parts.length === 4 && parts[3] === 'download' && (req.method === 'GET' || req.method === 'HEAD')) {
    const a = store.animatic(parts[2]);
    if (!a || !projectFor(a.projectId)) return sendJson(res, 404, { error: 'Animatic not found' });
    return sendAnimaticZip(req, res, a);
  }
  // GET /api/animatics/:id      the edit, which save it is (`rev`), and the newest version of each shot on it
  // PATCH { name }              renamed
  // PATCH { doc, rev }          the edit saved, over save `rev`; one made from an older save is refused (409)
  //                             with the newer one, so the page can take it
  // PATCH { add: [ids] }        these shots (or the shots of these versions) put at the end of its first video
  //                             track, from elsewhere in the project
  // DELETE                      gone
  if (parts[1] === 'animatics' && parts.length === 3) {
    const a = store.animatic(parts[2]);
    const project = a && projectFor(a.projectId);
    if (!project) return sendJson(res, 404, { error: 'Animatic not found' });
    if (req.method === 'GET') return sendJson(res, 200, animaticOut(a));
    if (req.method === 'DELETE') {
      store.deleteAnimatic(a.id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method !== 'PATCH') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = await readJson(req, 2 * 1024 * 1024);
    const by = actor(req, body);
    const patch = {};
    if (body.name !== undefined) {
      patch.name = cleanName(body.name, null);
      if (!patch.name) return sendJson(res, 400, { error: 'An animatic needs a name' });
    }
    if (body.doc !== undefined) {
      patch.doc = cleanAnimatic(body.doc, project);
      patch.rev = body.rev;
    } else if (Array.isArray(body.add)) {
      patch.doc = cleanAnimatic(appendShots(a.doc, body.add.slice(0, MAX_CLIPS).filter((id) => typeof id === 'string')), project);
      patch.rev = a.rev;
    }
    if (!Object.keys(patch).length) return sendJson(res, 400, { error: 'Nothing to change' });
    const done = store.setAnimatic(a.id, patch, by);
    if (!done) {
      const now = store.animatic(a.id);
      return sendJson(res, 409, { error: `${now.updatedBy || 'Somebody'} changed this animatic since`, ...animaticOut(now) });
    }
    return sendJson(res, 200, animaticOut(done));
  }
  // GET /api/versions/:id
  // PATCH  { entity, task, number, descriptor, artist }   what it is filed as: its name follows
  // PATCH  { hidden }                                      archived: out of the catalogue's way, and no longer the newest
  // PATCH  { deleted: false }                              a deleted one brought back
  // DELETE                                                 only one that no board shows; it is marked, not removed
  // POST /api/versions/:id/unfile   taken back straight after it was filed (see unfileVersion in store.js)
  if (parts[1] === 'versions' && parts.length === 4 && parts[3] === 'unfile') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const v = store.version(parts[2]);
    const entity = v && store.entity(v.entityId);
    const project = entity && projectFor(entity.projectId);
    if (!project || v.deletedAt) return sendJson(res, 404, { error: 'Not found' });
    const body = await readJson(req);
    const label = versionInfo(v).label;
    // { extra }: one of its extras, taken back straight after it was added, the version staying as it is.
    if (body.extra != null) {
      const name = extraName(body.extra);
      const x = name && (v.look.extras || []).find((y) => y.label === name);
      if (!x) return sendJson(res, 404, { error: `${label} has no extra of that name` });
      const what = `“${name}” of ${label}`;
      if (!(Date.now() - x.at <= UNFILE_WITHIN)) return sendJson(res, 409, { error: `${what} was added a while ago: there is no taking it back now` });
      if (req.user && x.by && x.by !== actor(req, body)) return sendJson(res, 409, { error: `${what} was added by ${x.by}` });
      flushAll();
      const board = x.board ? boards.get(x.board) : null;
      if (board) openItems(board);
      const item = board ? [...board.items.values()].find((it) => it.ver === v.id && it.ex === name) || null : null;
      if (store.notesOnExtra(v.id, name, item ? board.id : null, item ? item.id : null)) return sendJson(res, 409, { error: `Something has been said about ${what} since` });
      if (item) {
        const applied = applyOps(board, [{ t: 'set', id: item.id, patch: { ver: null } }], null, false);
        if (applied.length) broadcast(board, { t: 'op', ops: applied, from: null });
        settle(board, applied);
      }
      store.unfileExtra(v.id, name, item ? board.id : null, item ? item.id : null);
      retellEntity(entity.id);
      tellRoom(entity.id);
      return sendJson(res, 200, { ok: true });
    }
    if (Date.now() - v.createdAt > UNFILE_WITHIN) return sendJson(res, 409, { error: `${label} was filed a while ago: archive or delete it instead` });
    if (req.user && v.createdBy && v.createdBy !== actor(req, body)) return sendJson(res, 409, { error: `${label} was filed by ${v.createdBy}` });
    if (Array.isArray(v.look.views) && v.look.views.length) return sendJson(res, 409, { error: `${label} has more views since` });
    if (Array.isArray(v.look.extras) && v.look.extras.length) return sendJson(res, 409, { error: `${label} has extras since` });
    flushAll();
    const on = store.boardsWithVersion(v.id);
    const board = v.boardId ? boards.get(v.boardId) : null;
    if (board) openItems(board);
    const pieces = board ? [...board.items.values()].filter((it) => it.ver === v.id) : [];
    if (on.some((b) => b.id !== v.boardId) || pieces.length > (board ? 1 : 0) || (v.boardId && !pieces.length)) {
      return sendJson(res, 409, { error: `${label} is on other boards since: archive or delete it instead` });
    }
    const item = pieces[0] || null;
    if (store.notesBesides(v.id, item ? board.id : null, item ? item.id : null)) return sendJson(res, 409, { error: `Something has been said about ${label} since: archive or delete it instead` });
    if (item) {
      const applied = applyOps(board, [{ t: 'set', id: item.id, patch: { ver: null } }], null, false);
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: null });
      settle(board, applied);
    }
    const done = store.unfileVersion(v.id, item ? item.id : null, { madeSince: v.createdAt - 60 * 1000 });
    retellEntity(entity.id);
    tellRoom(entity.id);
    return sendJson(res, 200, { ok: true, entityDropped: done.entityDropped });
  }
  if (parts[1] === 'versions' && parts.length === 3) {
    const v = store.version(parts[2]);
    const entity = v && store.entity(v.entityId);
    const project = entity && projectFor(entity.projectId);
    if (!project) return sendJson(res, 404, { error: 'Not found' });
    if (!['GET', 'HEAD', 'PATCH', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed' });
    if (v.deletedAt && req.method !== 'PATCH') return sendJson(res, 404, { error: 'That version was deleted' });
    if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, publicVersion(v, req.user));
    if (req.method === 'DELETE') {
      flushAll();
      const on = store.boardsWithVersion(v.id);
      if (on.length) {
        const seen = on.filter((b) => canSee(req.user, b.workspace)).map((b) => `“${b.name}”`);
        const where = seen.length ? `on ${seen.length === 1 ? seen[0] : `${seen.slice(0, -1).join(', ')} and ${seen.at(-1)}`}` : 'on a board';
        return sendJson(res, 409, { error: `${versionInfo(v).label} is ${where}. Take it off ${on.length === 1 ? 'that board' : 'those boards'} first, or archive it instead.` });
      }
      store.deleteVersion(v.id);
      retellEntity(entity.id);
      tellRoom(entity.id);
      return sendJson(res, 200, { ok: true });
    }
    const body = await readJson(req);
    if (v.deletedAt && body.deleted !== false) return sendJson(res, 404, { error: 'That version was deleted' });
    // Everything asked for is checked before anything is changed, and then it is all changed in one write.
    const edit = {};
    const target = body.entity !== undefined ? entityFor(project, body.entity) : null;
    if (body.task !== undefined) edit.task = tokenOrNull(body.task);
    if (body.descriptor !== undefined) edit.descriptor = tokenOrNull(body.descriptor);
    if (body.artist !== undefined) edit.artist = tokenOrNull(body.artist);
    if (body.number !== undefined && body.number !== null) {
      const n = Number(body.number);
      if (!validNumber(n)) return sendJson(res, 400, { error: 'A version number is a whole number from 1' });
      edit.number = n;
    }
    // An entity still to be made has no numbers taken; anywhere else the number may be.
    if (!(target && target.make)) {
      const to = store.placeFor(v, { entityId: target ? target.id : undefined, task: edit.task, number: edit.number });
      if (to.taken) return sendJson(res, 409, { error: takenMessage(to.taken) });
    }
    const now = store.transaction(() => {
      if (v.deletedAt) store.restoreVersion(v.id);
      if ('hidden' in body) store.hideVersion(v.id, !!body.hidden);
      if (target) edit.entityId = madeEntity(project, target, actor(req, body)).id;
      if (Object.keys(edit).length) {
        const done = store.editVersion(v.id, edit);
        if (!done.ok) throw refusal(409, takenMessage(done.taken));
      }
      return store.version(v.id);
    });
    // The boards showing it, and the catalogue rooms it was and is in, are told what it is now called.
    const told = new Set([entity.id, now.entityId]);
    retellEntities(told);
    for (const id of told) tellRoom(id);
    return sendJson(res, 200, publicVersion(now, req.user));
  }
  return sendJson(res, 404, { error: 'Not found' });
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

// Compressed when the browser takes it so and it is worth it (a catalogue, a list of versions, the library).
function sendJson(res, status, body) {
  let data = Buffer.from(JSON.stringify(body));
  const head = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  const how = res.req ? encodingFor(res.req, data.length) : null;
  if (how) {
    data = how === 'br' ? zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } }) : zlib.gzipSync(data, { level: 5 });
    head['Content-Encoding'] = how;
  }
  head['Content-Length'] = data.length;
  res.writeHead(status, head);
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

// The part of something `size` bytes long a request asks for with its Range header: the whole of it
// (200) when it asks for no part, or `honour` is false; the part (206); or null for a part that is not
// there, to be answered with refuseRange.
function byteRange(req, size, honour = true) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!honour || !range || !(range[1] || range[2])) return { start: 0, end: size - 1, status: 200 };
  let start;
  let end = size - 1;
  if (range[1] === '') {
    start = Math.max(0, size - Number(range[2]));
  } else {
    start = Number(range[1]);
    if (range[2] !== '') end = Math.min(end, Number(range[2]));
  }
  if (start > end || start >= size) return null;
  return { start, end, status: 206 };
}
function refuseRange(res, size) {
  res.writeHead(416, { 'Content-Range': `bytes */${size}` });
  res.end();
}

// ---------------------------------------------------------------- the app's own files
//
// The pages, scripts and styles (and three.js, for the 3D view) are sent compressed to a browser that takes
// them so: about a fifth of the size, which over a tunnel or from Cloud Run is most of the wait. Each is
// compressed once, the first time it is asked for after it changed, and kept.
//
// A page names its scripts and styles with a version made from what is in them (/viewer.js?v=3fa9...), and
// a file asked for under its current version may be kept by the browser for good: going from page to page
// then asks for nothing but the page itself. A file that changes gets a new version, so an old copy is
// never used; one asked for under a version it no longer has is sent as it is now, and not kept.
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const statics = new Map(); // file -> { mtime, size, raw, version, br, gzip }
const digest = (buf) => crypto.createHash('sha1').update(buf).digest('base64url');
async function staticEntry(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new Error('Not a file');
  const known = statics.get(file);
  if (known && known.mtime === st.mtimeMs && known.size === st.size) return known;
  const raw = await fsp.readFile(file);
  const entry = { mtime: st.mtimeMs, size: st.size, raw, version: digest(raw).slice(0, 12), br: null, gzip: null };
  statics.set(file, entry);
  return entry;
}
const squeeze = (fn, buf, opts) => new Promise((resolve, reject) => fn(buf, opts, (err, out) => (err ? reject(err) : resolve(out))));
const BROTLI = (size) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: size } });
// How a browser takes things compressed, best first; null when it does not (or it is not worth it).
function encodingFor(req, size) {
  if (size < 1024) return null;
  const accepts = String(req.headers['accept-encoding'] || '');
  return /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
}
// A page with its scripts and styles named by version.
async function versionLinks(html) {
  const found = [...new Set([...html.matchAll(/\b(?:src|href)="(\/[\w./-]+\.(?:js|css))"/g)].map((m) => m[1]))];
  const versions = new Map();
  await Promise.all(found.map(async (p) => {
    const full = path.join(PUBLIC_DIR, p);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return;
    try {
      versions.set(p, (await staticEntry(full)).version);
    } catch {
      // not there: named as it is
    }
  }));
  return html.replace(/\b(src|href)="(\/[\w./-]+\.(?:js|css))"/g, (all, attr, p) => (versions.has(p) ? `${attr}="${p}?v=${versions.get(p)}"` : all));
}
// `cache` says how long the browser may keep it when it is not asked for by version (default: ask again each time).
async function sendStatic(req, res, file, { cache = 'no-cache', headers = {} } = {}) {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT.has(ext)) return sendFile(req, res, file, { 'Cache-Control': cache, ...headers });
  let entry;
  try {
    entry = await staticEntry(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  let body = entry.raw;
  let version = entry.version;
  if (ext === '.html') {
    body = Buffer.from(await versionLinks(entry.raw.toString('utf8')));
    version = digest(body).slice(0, 12);
  }
  const asked = new URL(req.url, 'http://x').searchParams.get('v');
  const keep = ext !== '.html' && asked === version;
  const etag = `"${version}"`;
  const head = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': keep ? 'private, max-age=31536000, immutable' : cache,
    ETag: etag,
    Vary: 'Accept-Encoding',
    ...headers,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, head);
    return res.end();
  }
  const how = encodingFor(req, body.length);
  if (how) {
    if (ext === '.html') body = await squeeze(how === 'br' ? zlib.brotliCompress : zlib.gzip, body, how === 'br' ? BROTLI(body.length) : { level: 6 });
    else {
      if (!entry[how]) entry[how] = await squeeze(how === 'br' ? zlib.brotliCompress : zlib.gzip, entry.raw, how === 'br' ? BROTLI(entry.raw.length) : { level: 9 });
      body = entry[how];
    }
    head['Content-Encoding'] = how;
  }
  head['Content-Length'] = body.length;
  res.writeHead(200, head);
  res.end(req.method === 'HEAD' ? undefined : body);
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
    // Range support is what lets browsers scrub through video.
    const range = byteRange(req, st.size);
    if (!range) return refuseRange(res, st.size);
    const { start, end, status } = range;
    if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
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
// Uploads begun and not yet finished: uid -> { owner, bytes, pieces (offset -> size), at }.
const unfinished = new Map();

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

  // Nobody may fill the disk with files they never finish sending (see MAX_UNFINISHED).
  const owner = req.user ? `u:${req.user.id}` : `a:${clientAddress(req, process.env.TRUST_PROXY)}`;
  let job = unfinished.get(uid);
  if (job && job.owner !== owner) return refuse(409, 'That upload is somebody else’s');
  const theirs = [...unfinished.values()].filter((j) => j.owner === owner && j !== job);
  if (!job && theirs.length >= MAX_UNFINISHED) return refuse(429, 'Too many files are on their way in at once. Wait for some to finish.');
  // What they have waiting besides this piece (a piece sent again replaces the one before).
  const waiting = theirs.reduce((n, j) => n + j.bytes, 0) + (job ? job.bytes - (job.pieces.get(offset) || 0) : 0);
  if (waiting + (Number(req.headers['content-length']) || 0) > MAX_UNFINISHED_BYTES) return refuse(413, 'Too much is on its way in at once. Wait for some of it to finish.');
  if (!job) {
    job = { owner, bytes: 0, pieces: new Map(), at: Date.now() };
    unfinished.set(uid, job);
  }

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
    else if (waiting + size > MAX_UNFINISHED_BYTES) fail(413, 'Too much is on its way in at once. Wait for some of it to finish.');
  });
  req.on('error', () => fail(400, 'Upload interrupted'));
  req.on('close', () => {
    if (!req.complete) fail(400, 'Upload interrupted');
  });
  out.on('error', (err) => fail(500, err.message));
  out.on('finish', async () => {
    if (failed) return;
    job.bytes += size - (job.pieces.get(offset) || 0);
    job.pieces.set(offset, size);
    job.at = Date.now();
    try {
      if (!done) return sendJson(res, 200, { ok: true, received: offset + size });
      sendJson(res, 200, await assembleUpload(partsDir, ext, req.user));
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message });
    } finally {
      // Finished, or failed for good: either way it no longer waits.
      if (done) unfinished.delete(uid);
    }
  });
  req.pipe(out);
}

// Joins the pieces in order, checking none is missing, under a content-addressed name so that
// re-uploading the same file reuses the stored copy.
async function assembleUpload(partsDir, ext, user) {
  const names = (await fsp.readdir(partsDir)).sort();
  const hash = crypto.createHash('sha1');
  // The checksum a zip of the file will want, taken now, while every byte is passing anyway.
  let crc = 0;
  let total = 0;
  const finish = async (tmp) => {
    const name = `${hash.digest('hex').slice(0, 24)}${ext}`;
    const dest = path.join(UPLOAD_DIR, name);
    if (fs.existsSync(dest)) await fsp.rm(tmp, { force: true });
    else await fsp.rename(tmp, dest);
    await fsp.rm(partsDir, { recursive: true, force: true });
    store.addMedia({ name, size: total, by: user ? user.name : null, crc: crc >>> 0 });
    store.setMediaCrc(name, crc >>> 0);
    return { url: `/uploads/${name}`, size: total };
  };

  // The common case, one piece: hash it where it lies and move it into place without copying.
  if (names.length === 1 && Number(names[0]) === 0) {
    const only = path.join(partsDir, names[0]);
    for await (const chunk of fs.createReadStream(only)) {
      total += chunk.length;
      hash.update(chunk);
      crc = zlib.crc32(chunk, crc);
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
        crc = zlib.crc32(chunk, crc);
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

// Abandoned uploads (a closed tab, a dropped connection) leave pieces behind; sweep them up, an hour
// after the last piece of them came.
function cleanStaleUploads() {
  const cutoff = Date.now() - STALE_UPLOAD;
  for (const [uid, job] of unfinished) if (job.at < cutoff) unfinished.delete(uid);
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

// Whom an entity's versions belong to is either a project (a folder), or a playlist outside any project
// (its entity's projectId is the playlist's id). Either way they are seen by whoever sees its workspace.
const scopeWorkspace = (id) => (folders.has(id) ? folders.get(id).workspace : store.playlist(id)?.workspace || null);
const visibleScope = (user, id) => {
  const workspace = scopeWorkspace(id);
  return workspace !== null && canSee(user, workspace);
};

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

// Those holding the board's read-only link (not those watching a presentation of it).
const closeViewers = (board, code, reason) => {
  for (const peer of [...board.peers.values()]) if (peer.share) peer.ws.close(code, reason);
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

// The same for the catalogue's rooms (see joinRoom): after a project changes workspace, whoever has one
// of its assets, sets or shots open but may no longer see the project is shown the door.
function dropRoomStrangers() {
  for (const [entityId, peers] of rooms) {
    const e = store.entity(entityId);
    for (const peer of [...peers]) if (!e || !visibleScope(peer.user, e.projectId)) peer.ws.close(4003, 'Project moved');
  }
}

// ---------------------------------------------------------------- a board's files, as they were uploaded
//
// What goes on a board for a video is a review copy made in the browser. The file it was made from is
// uploaded as well and the item points at it (`orig`). A picture is its own original. Each can be
// downloaded from the board, and all of a board's at once from here: a video's original where it was
// kept, otherwise the copy the board plays. A file is sent once however many times it is on the board.
const UPLOAD_URL = /^\/uploads\/([\w-]+\.[a-z0-9]+)$/i;
const uploadName = (src) => (typeof src === 'string' && UPLOAD_URL.exec(src)?.[1]) || null;

async function sendBoardZip(req, res, board) {
  openItems(board);
  const seen = new Set();
  const entries = [];
  for (const it of board.items.values()) {
    if (it.type !== 'image' && it.type !== 'video') continue;
    for (const upload of [uploadName(it.orig), uploadName(it.src)]) {
      if (!upload) continue;
      const file = path.join(UPLOAD_DIR, upload);
      const st = await fsp.stat(file).catch(() => null);
      // An original that has gone missing still leaves the copy to send.
      if (!st) continue;
      if (!seen.has(upload)) {
        seen.add(upload);
        // Under the name it came with, and the ending of the file that is sent.
        const stem = String(it.name || '').replace(/\.[^./\\]+$/, '') || (it.type === 'video' ? 'video' : 'image');
        entries.push({ upload, file, size: st.size, mtime: st.mtimeMs, name: stem + path.extname(upload) });
      }
      break;
    }
  }
  if (!entries.length) return sendJson(res, 404, { error: 'There is nothing on this board to download' });
  zip.safeNames(entries.map((e) => e.name)).forEach((name, i) => { entries[i].name = name; });
  const plan = zip.layout(entries);
  const title = zip.safeNames([board.name])[0];
  // The same files under the same names make the same archive, byte for byte, so a download that was
  // cut off (a large one through a tunnel often is) can be taken up where it stopped. The tag says
  // which archive it was, for a browser that asks to go on with it.
  const etag = `"${crypto.createHash('sha1').update(entries.map((e) => `${e.upload}/${e.size}/${Math.floor(e.mtime / 2000)}/${e.name}`).join('|')).digest('hex').slice(0, 24)}"`;
  const head = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${title.replace(/[^\x20-\x7e]|["\\]/g, '_')}.zip"; filename*=UTF-8''${encodeURIComponent(title)}.zip`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  // Only a part of the same archive as before is sent on; a different one is sent whole.
  const range = byteRange(req, plan.size, !req.headers['if-range'] || req.headers['if-range'] === etag);
  if (!range) return refuseRange(res, plan.size);
  const { start, end, status } = range;
  if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${plan.size}`;
  head['Content-Length'] = end - start + 1;
  res.writeHead(status, head);
  if (req.method === 'HEAD') return res.end();
  // A file the database has no checksum for has it worked out the first time, and kept from then on.
  const crcOf = async (e) => {
    const known = store.media(e.upload);
    if (known && known.crc != null) return known.crc >>> 0;
    const crc = await zip.crcOfFile(e.file);
    store.setMediaCrc(e.upload, crc);
    return crc;
  };
  try {
    await zip.writeZip(res, plan, crcOf, start, end);
  } catch {
    res.destroy();
  }
}

// ---------------------------------------------------------------- an animatic's cut, for a playback system
//
// One zip: the cut as OpenTimelineIO and as a CMX 3600 edit decision list for each track (cutfiles.js), a list
// of the version each file is, and the files: the newest version of each shot it plays (the file it was made
// from where that was kept, in the view the animatic shows), named by the shot, and its sound files by their
// names. Named by shot, a newer version can be put over the old file without a new cut.
async function sendAnimaticZip(req, res, a) {
  const doc = a.doc;
  const shots = animaticShots(doc.clips.filter((c) => c.shot).map((c) => c.shot), doc.task);
  const lookOf = (c) => {
    const v = c.shot && shots[c.shot] && shots[c.shot].version;
    if (!v) return null;
    return (doc.view && doc.view !== v.look.view && (v.look.views || []).find((x) => x.view === doc.view)) || v.look;
  };
  const lengthOf = (c) => {
    if (c.media) return c.dur ? c.dur * doc.fps : Infinity;
    const look = lookOf(c);
    return look && look.type === 'video' && look.dur > 0 ? look.dur * doc.fps : Infinity;
  };
  // Each file once, under the name of its shot (or its own, for a sound).
  const files = new Map(); // upload -> { name, ... }
  const fileOf = new Map(); // clip id -> name in the zip
  const rows = [];
  for (const c of doc.clips) {
    const look = c.media ? null : lookOf(c);
    const upload = c.media ? uploadName(c.media) : look && uploadName(look.orig || look.src);
    if (!upload) continue;
    const file = path.join(UPLOAD_DIR, upload);
    const st = await fsp.stat(file).catch(() => null);
    if (!st) continue;
    if (!files.has(upload)) {
      const stem = c.media ? String(c.name || 'sound').replace(/\.[^./\\]+$/, '') : shots[c.shot].name;
      files.set(upload, { upload, file, size: st.size, mtime: st.mtimeMs, name: stem + path.extname(upload), clip: c });
    }
    fileOf.set(c.id, files.get(upload));
  }
  const entries = [...files.values()];
  zip.safeNames(entries.map((e) => e.name)).forEach((name, i) => { entries[i].name = name; });
  for (const e of entries) {
    if (e.clip.media) continue;
    const v = shots[e.clip.shot].version;
    const full = liveVersion(v.id);
    rows.push({ file: e.name, shot: shots[e.clip.shot].name, label: v.label, task: v.task || '', number: v.number, filed: full ? new Date(full.createdAt).toISOString() : '', by: full ? full.createdBy || '' : '', original: full ? full.originalName || '' : '' });
  }
  const title = zip.safeNames([a.name])[0];
  const info = {
    lengthOf,
    fileOf: (c) => fileOf.get(c.id)?.name || null,
    metaOf: (c) => {
      if (c.media) return { name: c.name || 'sound', file: fileOf.get(c.id)?.name || null };
      const s = shots[c.shot];
      return { name: s.name, shot: s.id, version: s.version ? s.version.label : null, versionId: s.version ? s.version.id : null, file: fileOf.get(c.id)?.name || null };
    },
  };
  const made = (name, text) => {
    const data = Buffer.from(text, 'utf8');
    return { name, data, size: data.length, mtime: a.updatedAt };
  };
  const cut = [
    made(`${title}.otio`, `${JSON.stringify(cutfiles.otio(doc, a.name, info), null, 2)}\n`),
    ...doc.tracks.filter((t) => doc.clips.some((c) => c.track === t.id && info.fileOf(c))).map((t) => made(`${title} ${t.name}.edl`, cutfiles.edl(doc, t, a.name, info))),
    made(`${title} versions.csv`, cutfiles.versionList(rows)),
  ];
  const all = [...cut, ...entries];
  zip.safeNames(all.map((e) => e.name)).forEach((name, i) => { all[i].name = name; });
  const plan = zip.layout(all);
  const etag = `"${crypto.createHash('sha1').update(all.map((e) => (e.data ? crypto.createHash('sha1').update(e.data).digest('hex') : `${e.upload}/${e.size}/${Math.floor(e.mtime / 2000)}`) + `/${e.name}`).join('|')).digest('hex').slice(0, 24)}"`;
  const head = {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${title.replace(/[^\x20-\x7e]|["\\]/g, '_')}.zip"; filename*=UTF-8''${encodeURIComponent(title)}.zip`,
    'Cache-Control': 'no-store',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  const range = byteRange(req, plan.size, !req.headers['if-range'] || req.headers['if-range'] === etag);
  if (!range) return refuseRange(res, plan.size);
  const { start, end, status } = range;
  if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${plan.size}`;
  head['Content-Length'] = end - start + 1;
  res.writeHead(status, head);
  if (req.method === 'HEAD') return res.end();
  const crcOf = async (e) => {
    if (e.data) return zlib.crc32(e.data) >>> 0;
    const known = store.media(e.upload);
    if (known && known.crc != null) return known.crc >>> 0;
    const crc = await zip.crcOfFile(e.file);
    store.setMediaCrc(e.upload, crc);
    return crc;
  };
  try {
    await zip.writeZip(res, plan, crcOf, start, end);
  } catch {
    res.destroy();
  }
}

// The file a video was made from is for the people who work on the board, not for whoever holds a link to it.
function withoutOriginal(it) {
  if (!it || it.orig === undefined) return it;
  const { orig, ...rest } = it;
  return rest;
}

const VIEW_COOKIE = 'wb_view';
const secureCookie = (req) => ((auth.publicUrl && auth.publicUrl.startsWith('https://')) || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');
// Someone who opened a live read-only link may load the files that board shows without being signed
// in: what its pieces show (the file, its stills, its preview) and the stills of the versions they
// are, never the files the videos were made from (`orig`), which the link does not show either.
function sharedFile(req, name) {
  const board = sharedBoard(parseCookies(req.headers.cookie)[VIEW_COOKIE]);
  if (!board) return false;
  openItems(board);
  for (const it of board.items.values()) {
    if (it.type === 'comment') continue;
    for (const key of ['src', 'lo', 'th', 'poster', 'prev']) if (uploadName(it[key]) === name) return true;
    if (it.wf && typeof it.wf === 'object' && Object.values(it.wf).some((v) => uploadName(v) === name)) return true;
  }
  const model = board3d(board);
  if (model && uploadName(model.model) === name) return true;
  return boardVersions(board).some((v) => uploadName(v.thumb) === name || (v.look3d && ['src', 'lo', 'th', 'poster', 'prev'].some((k) => uploadName(v.look3d[k]) === name)));
}

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
    return sendJson(res, 200, { auth: auth.mode, user: req.user || null, admin: admin.allows(req), canShare: SHARING, maxUpload: MAX_UPLOAD, publicUrl: auth.publicUrl || null, shareBases: shareBases(), signOut: !!auth.interactive, ai: ai.enabled ? { model: ai.model } : null });
  }
  if (parts[1] === 'admin') return admin.handle(req, res, parts.slice(2));
  if (parts[1] === 'projects' && parts[3] === 'present' && parts.length <= 5) {
    const project = visibleFolder(req.user, parts[2]) && folders.get(parts[2]).project ? folders.get(parts[2]) : null;
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    return handlePresentApi(req, res, url, project, parts[4] || '');
  }
  if (['projects', 'entities', 'versions', 'playlists', 'animatics', 'people'].includes(parts[1])) return handleCatalogue(req, res, parts);
  if (parts[1] === 'library' && req.method === 'GET') {
    return sendJson(res, 200, {
      folders: [...folders.values()].filter((f) => canSee(req.user, f.workspace)).map(publicFolder),
      boards: [...boards.values()].filter((b) => visible(req.user, b)).map(boardMeta).sort((a, b) => b.updatedAt - a.updatedAt),
      // The playlists that are in no project (a project's come with its catalogue), listed with the boards.
      playlists: store.loosePlaylists().filter((p) => canSee(req.user, p.workspace)).map(playlistCard),
      // Who of the team is presenting a project, and the link to watch them by.
      presenting: [...presentations.values()].filter((p) => p.live && presentationFor(p.token) && visibleFolder(req.user, p.projectId))
        .map((p) => ({ projectId: p.projectId, name: p.ownerName, color: p.color, token: p.token })),
    });
  }
  if (parts[1] === 'folders') {
    if (parts.length === 2 && req.method === 'POST') {
      const body = await readJson(req);
      const parentId = body.parentId || null;
      if (parentId && !visibleFolder(req.user, parentId)) return sendJson(res, 404, { error: 'Parent folder not found' });
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
        // What is shared stays shared: a project, or a folder with anything in it, is not taken from the
        // shared workspace into somebody's own, where nobody else could see it, except by an admin.
        if ('workspace' in body && folder.workspace === 'myreze' && spaceKey(body.workspace, req.user) !== 'myreze'
          && (folder.project || holdsAnything(folder)) && !admin.isAdmin(req.user)) {
          return sendJson(res, 403, { error: `“${folder.name}” is shared with everyone, and ${folder.project ? 'it is a project' : 'it holds boards or folders'}, so only an admin can move it to a personal workspace` });
        }
        if ('parentId' in body) {
          const parentId = body.parentId || null;
          if (parentId && !visibleFolder(req.user, parentId)) return sendJson(res, 404, { error: 'Folder not found' });
          if (parentId && folders.get(parentId).workspace !== folder.workspace) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
          if (parentId && isWithin(parentId, folder.id)) return sendJson(res, 400, { error: 'A folder cannot be moved into itself' });
          if (parentId && projectOf(parentId) && holdsProject(folder)) return sendJson(res, 400, { error: 'A project cannot go inside another project' });
          folder.parentId = parentId;
        }
        // Marked as a project, a folder has a catalogue. Not inside another project, nor around one;
        // and once its catalogue has something in it, it stays a project.
        if ('project' in body && !!body.project !== !!folder.project) {
          if (body.project) {
            if (projectOf(folder.parentId) || holdsProject(folder)) return sendJson(res, 400, { error: 'A project cannot be inside another project, or hold one' });
            folder.project = true;
            folder.settings = folder.settings || {};
          } else {
            if (store.entityCount(folder.id)) return sendJson(res, 409, { error: 'This project has a catalogue, so it stays a project' });
            folder.project = false;
          }
        }
        if ('settings' in body && folder.project) {
          folder.settings = cleanProjectSettings(body.settings, folder.settings);
          // The boards in it that are open are told what its model of its venue now is, and what of theirs goes on it.
          for (const board of boards.values()) {
            if (!board.items || !board.peers.size || boardProject(board) !== folder) continue;
            broadcast(board, { t: 'view3d', view3d: board3d(board), versions: boardVersions(board) });
          }
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
        // A project is where its catalogue lives: its versions and what was said about them. It is not
        // dissolved into the folder above like a plain folder.
        if (folder.project) return sendJson(res, 409, { error: 'A project cannot be deleted' });
        // Nothing inside is deleted: boards, playlists and subfolders move up one level.
        for (const f of folders.values()) if (f.parentId === folder.id) f.parentId = folder.parentId;
        for (const p of store.loosePlaylists()) if (p.folderId === folder.id) store.setPlaylist(p.id, { folderId: folder.parentId });
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
    if (body.folderId && !visibleFolder(req.user, body.folderId)) return sendJson(res, 404, { error: 'Folder not found' });
    const folderId = body.folderId || null;
    const workspace = folderId ? folders.get(folderId).workspace : spaceKey(body.workspace, req.user);
    return sendJson(res, 201, boardMeta(createBoard(body.name, folderId, workspace, actor(req, body))));
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
  // What has happened on a board, newest first, and the snapshots it can be put back to.
  if (parts[1] === 'boards' && parts.length === 4 && parts[3] === 'activity' && req.method === 'GET') {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board)) return sendJson(res, 404, { error: 'Board not found' });
    writeNoted();
    return sendJson(res, 200, { events: store.activity(board.id), snapshots: store.snapshots(board.id) });
  }
  // Puts a board back as it was. What is there now is kept first, so this can be undone the same way.
  // Only what is on the board goes back: versions and what was said about them stay as they are.
  if (parts[1] === 'boards' && parts.length === 6 && parts[3] === 'snapshots' && parts[5] === 'restore' && req.method === 'POST') {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board)) return sendJson(res, 404, { error: 'Board not found' });
    const body = await readJson(req);
    const who = actor(req, body, 'Somebody');
    const was = store.snapshot(board.id, Number(parts[4]));
    if (!was) return sendJson(res, 404, { error: 'That snapshot is not kept any more' });
    openItems(board);
    keepSnapshot(board, who, true);
    const next = new Map(was.map((it) => [it.id, it]));
    for (const it of next.values()) checkVer(it, board);
    for (const [id, it] of board.items) if (it.type !== 'comment' && !next.has(id)) board.removed.add(id);
    for (const id of next.keys()) {
      board.changed.add(id);
      board.removed.delete(id);
    }
    board.items = next;
    syncNotes(board);
    scheduleSave(board);
    note(board, who, 'restore');
    // Everybody on the board is given it afresh, as when they opened it, marked as put back: what they
    // could undo was done to the board as it was before.
    for (const peer of board.peers.values()) sendInit(board, peer, true);
    return sendJson(res, 200, { ok: true });
  }
  // Every image and video on a board, as it was uploaded, in one zip. HEAD says whether there is one
  // to be had, and how large, without sending it.
  if (parts[1] === 'boards' && parts.length === 4 && parts[3] === 'media.zip' && (req.method === 'GET' || req.method === 'HEAD')) {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board)) return sendJson(res, 404, { error: 'Board not found' });
    return sendBoardZip(req, res, board);
  }
  if (parts[1] === 'boards' && parts.length === 3) {
    const board = boards.get(parts[2]);
    if (!visible(req.user, board)) return sendJson(res, 404, { error: 'Board not found' });
    if (req.method === 'GET') return sendJson(res, 200, boardMeta(board));
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      // Checked first, so a move refused changes nothing.
      const key = 'workspace' in body ? spaceKey(body.workspace, req.user) : board.workspace;
      if ('workspace' in body) {
        if (body.workspace === 'personal' && !req.user) return sendJson(res, 400, { error: 'Personal workspaces need sign-in' });
        // A shared board somebody else made stays shared, unless an admin moves it (see the folders above).
        if (board.workspace === 'myreze' && key !== 'myreze' && board.createdBy !== req.user.name && !admin.isAdmin(req.user)) {
          return sendJson(res, 403, { error: `“${board.name}” is shared with everyone and somebody else made it, so only an admin can move it to a personal workspace` });
        }
      }
      if ('folderId' in body && body.folderId) {
        if (!visibleFolder(req.user, body.folderId)) return sendJson(res, 404, { error: 'Folder not found' });
        if (folders.get(body.folderId).workspace !== key) return sendJson(res, 400, { error: 'Move it to the other workspace first' });
      }
      if (key !== board.workspace) {
        board.workspace = key;
        board.folderId = null;
        scheduleSave(board, false);
        dropStrangers(board);
        dropRoomStrangers();
      }
      if ('folderId' in body) {
        board.folderId = body.folderId || null;
        scheduleSave(board, false);
      }
      const applied = applyOps(board, [{ t: 'meta', patch: { name: body.name } }]);
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: null });
      // Boards showing notes made here say where they were made, by name.
      if (applied.length) for (const other of boards.values()) if (other !== board && other.items && [...other.items.values()].some((it) => it.ob === board.id)) settle(other, Object.assign([], { resync: true, notes: new Set(), versions: new Set() }));
      return sendJson(res, 200, boardMeta(board));
    }
    if (req.method === 'DELETE') {
      // Soft delete: whatever is unsaved is written first, then the board is only marked deleted, so a
      // mis-click is recoverable (scripts/restore-board.js).
      // Should that write fail, the board is not deleted, and its saving carries on as before.
      clearTimeout(board.saveTimer);
      board.saveTimer = null;
      try {
        writeBoard(board);
      } catch (err) {
        scheduleSave(board, false, SAVE_RETRY);
        throw err;
      }
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
  if (parts[1] === 'phone-copy' && req.method === 'POST' && parts.length <= 3) return handlePhoneCopy(req, res, parts[2] || '');
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
  if (!knownHost(req)) return sendJson(res, 421, { error: `This server does not answer to the address ${String(req.headers.host || '(none)').slice(0, 100)}. Add it to ALLOWED_HOSTS if it should.` });
  // Changes come only from our own pages (see CHANGES_HEADER).
  if (req.method !== 'GET' && req.method !== 'HEAD' && (pathname.startsWith('/api/') || pathname === '/__shutdown') && req.headers[CHANGES_HEADER] !== '1') {
    return sendJson(res, 403, { error: `Changes need the header ${CHANGES_HEADER}: 1` });
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
      return sendStatic(req, res, path.join(PUBLIC_DIR, 'board.html'), { cache: headers['Cache-Control'], headers });
    }
    const shared = /^\/api\/shared\/([\w-]{16,64})$/.exec(pathname);
    if (shared) {
      const board = sharedBoard(shared[1]);
      return board ? sendJson(res, 200, { name: board.name, access: board.shareAccess }) : sendJson(res, 404, { error: 'This link is not shared any more' });
    }
    // A link to watch a project being presented: its page, and a board shown through it (in a frame of that page).
    const watching = /^\/p\/([\w-]{16,64})(?:\/b\/([\w-]+))?\/?$/.exec(pathname);
    if (watching) {
      const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      if (!watching[2] && presentationFor(watching[1])) headers['Set-Cookie'] = `${WATCH_COOKIE}=${watching[1]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureCookie(req)}`;
      return sendStatic(req, res, path.join(PUBLIC_DIR, watching[2] ? 'board.html' : 'watch.html'), { cache: headers['Cache-Control'], headers });
    }
    const watchApi = /^\/api\/watch\/([\w-]{16,64})(?:\/(.+))?$/.exec(pathname);
    if (watchApi) return handleWatchApi(req, res, url, watchApi[1], watchApi[2] || '');
  }
  if (auth.handle && (await auth.handle(req, res, url))) return;

  // Pages, data and files need a signed-in user. The scripts, styles and fonts do not, so the sign-in page can use them.
  const isPage = pathname === '/' || /^\/b\/[\w-]+\/?$/.test(pathname) || pathname === '/index.html' || pathname === '/board.html' || pathname === '/admin' || pathname === '/admin.html';
  const guarded = auth.mode === 'iap' || isPage || pathname.startsWith('/api/') || pathname.startsWith('/uploads/');
  if (guarded) {
    const who = await auth.authenticate(req);
    if (who.status && !(pathname.startsWith('/uploads/') && (sharedFile(req, path.basename(pathname)) || watchedFile(req, path.basename(pathname))))) {
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
      // Named by what is in them, so they never change; but only for this browser, never a shared cache,
      // as who may have them depends on who is asking.
      'Cache-Control': 'private, max-age=31536000, immutable',
      // Uploaded SVGs must never run script when opened directly.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    });
  }

  // The in-browser video encoder, served from the installed package so there is no build step.
  if (pathname === '/vendor/mediabunny.mjs') {
    return sendFile(req, res, path.join(__dirname, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.min.mjs'), { 'Cache-Control': 'public, max-age=86400' });
  }
  // three.js, for a project's 3D view (view3d.js): its build, and the add-ons it is used with, as modules.
  const three = /^\/vendor\/three\/(build|addons)\/([\w/.-]+\.js)$/.exec(pathname);
  if (three && !three[2].includes('..')) {
    const root = path.join(__dirname, 'node_modules', 'three', three[1] === 'build' ? 'build' : path.join('examples', 'jsm'));
    const file = path.join(root, three[2]);
    if (file.startsWith(root + path.sep)) return sendStatic(req, res, file, { cache: 'public, max-age=86400' });
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
  sendStatic(req, res, full, { cache: file.startsWith('fonts/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
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

// Behind a load balancer, keep connections open longer than the balancer does. A request has five
// minutes to arrive whole: uploads come in pieces of a few megabytes each (see handleUpload), so that is
// plenty for one piece, and a connection that trickles in for ever is let go.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 5 * 60 * 1000;

// ---------------------------------------------------------------- realtime

// Messages over a kilobyte (a board as it is opened, a catalogue's notes) go compressed, each on its own so a
// connection holds no compression state between them: tunnels pass a live connection on as it is, so
// nothing else would.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, zlibDeflateOptions: { level: 6 } },
});

// Whether a request was made on the machine the server runs on, by someone sitting at it.
function fromThisMachine(req) {
  // A tunnel or proxy on this machine also arrives from loopback, but it adds forwarding headers.
  const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.headers['x-real-ip'];
  return !proxied && isLoopback(req.socket.remoteAddress);
}

// ---- requests from other sites
//
// A page on another site can make a visitor's browser send requests here, and can even make its own
// name point at this server (DNS rebinding), which would make it look like one of our pages. Two things
// keep it out:
//
// The address a request is for (its Host) has to be one this server goes by: an IP address, localhost,
// this machine's own name, the address in PUBLIC_URL, a quick Cloudflare tunnel's (*.trycloudflare.com,
// whose names nobody else can point anywhere), or one listed in ALLOWED_HOSTS (comma separated; a name
// starting with "." or "*." allows everything under it). Behind Google's IAP no request reaches the
// server without Google's token, so there it is not asked.
//
// And every change (anything but GET and HEAD to /api/, and /__shutdown) carries the header X-WB: 1,
// which a page on another site cannot add without asking first, and this server never says yes.
const CHANGES_HEADER = 'x-wb';
const hostList = (value) => String(value || '').split(',').map((s) => s.trim().toLowerCase().replace(/^\*\./, '.')).filter(Boolean);
const OUR_HOSTS = new Set(['localhost', os.hostname().toLowerCase(), os.hostname().toLowerCase().split('.')[0], `${os.hostname().toLowerCase().split('.')[0]}.local`]);
if (auth.publicUrl) OUR_HOSTS.add(new URL(auth.publicUrl).hostname.toLowerCase());
const HOSTS_ALLOWED = ['.trycloudflare.com', ...hostList(process.env.ALLOWED_HOSTS)];
function knownHost(req) {
  if (auth.mode === 'iap') return true;
  const raw = String(req.headers.host || '').trim().toLowerCase();
  const host = (raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.replace(/:\d*$/, '')).replace(/\.$/, '');
  if (!host) return false;
  if (net.isIP(host) || OUR_HOSTS.has(host) || host.endsWith('.localhost')) return true;
  return HOSTS_ALLOWED.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
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
    if (!knownHost(req)) {
      socket.write('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const shared = url.searchParams.get('share');
    if (shared) {
      const viewed = sharedBoard(shared);
      if (!viewed) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, viewed, null, { share: shared }));
    }
    // Watching a presentation: its own page, or a board it shows.
    const watched = url.searchParams.get('watch');
    if (watched) {
      const pres = presentationFor(watched);
      if (!pres) return socket.destroy();
      if (!url.searchParams.has('board')) return wss.handleUpgrade(req, socket, head, (ws) => presentWatcher(ws, pres));
      const board = boards.get(url.searchParams.get('board'));
      if (!board || !wasShown(pres, 'board', board.id)) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, board, null, { watch: pres }));
    }
    // Presenting: the presenter's own page, signed in.
    const presenting = url.searchParams.get('present');
    if (presenting) {
      const pres = presentationFor(presenting);
      if (!pres || !fromOurPages(req)) return socket.destroy();
      const who = await auth.authenticate(req);
      if (who.status || !visibleFolder(who.user, pres.projectId)) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => presentHost(ws, pres, who.user));
    }
    const entityId = url.searchParams.get('entity');
    if (entityId) {
      const entity = store.entity(entityId);
      if (!entity || !fromOurPages(req)) return socket.destroy();
      const who = await auth.authenticate(req);
      if (who.status || !visibleScope(who.user, entity.projectId)) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, (ws) => joinRoom(ws, entity, who.user));
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
// A link shows the notes made on its own board, not those made about the same version on others.
// Somebody watching a presentation sees what it allows: the board, and its comments only if it includes them.
const accessOf = (board, peer) => (peer.watch ? peer.watch.access : board.shareAccess);
const hiddenNote = (access, c) => !!c && c.type === 'comment' && (access === 'view' || c.ob !== undefined);
const hiddenFromViewers = (board, op, access) => (op.t === 'add' ? hiddenNote(access, op.item) : op.t === 'set' && hiddenNote(access, board.items.get(op.id)));

// All that somebody commenting through a link can send: new comments and replies on what is there.
function guestOps(board, ops) {
  if (!Array.isArray(ops)) return [];
  return ops.filter((op) => op && op.t === 'add' && op.item && op.item.type === 'comment' && !board.items.has(op.item.id)
    && board.items.has(op.item.on) && board.items.get(op.item.on).type !== 'comment'
    && (!op.item.re || (board.items.get(op.item.re)?.type === 'comment' && !hiddenNote(board.shareAccess, board.items.get(op.item.re)))));
}

function broadcast(board, msg, except) {
  const data = JSON.stringify(msg);
  const viewerData = new Map(); // what they may see -> the message as they are sent it
  for (const peer of board.peers.values()) {
    if (peer === except || peer.ws.readyState !== 1) continue;
    if (!peer.viewer || msg.t !== 'op') {
      peer.ws.send(data);
      continue;
    }
    const access = accessOf(board, peer);
    if (!viewerData.has(access)) {
      const ops = forViewers(board, msg.ops, access);
      viewerData.set(access, ops.length ? JSON.stringify({ ...msg, ops }) : null);
    }
    if (viewerData.get(access)) peer.ws.send(viewerData.get(access));
  }
}

// Ops as somebody holding a link may see them: no notes the link does not show, nothing of originals.
const forViewers = (board, ops, access = board.shareAccess) => ops.filter((op) => !hiddenFromViewers(board, op, access))
  .map((op) => (op.t === 'add' ? { ...op, item: withoutOriginal(op.item) } : op.t === 'set' ? { ...op, patch: withoutOriginal(op.patch) } : op))
  .filter((op) => op.t !== 'set' || Object.keys(op.patch).length);

// What a pointer says, as the pages send it: where it is (c), the laser held (l), and for the board's
// own people also their view (v), what they have selected (s), the piece open (f), the thread read in it
// (t), how far it is zoomed into (z) and how it is seen in 3D (d, see cleanPlayer), a video playing there
// (m) and files on their way in (u). Anything else, or not of its
// shape, is left out, so nobody can hand everybody else whatever they like.
function cleanPresence(p, viewer) {
  const out = {};
  const id = (v) => typeof v === 'string' && v.length <= 40;
  const numbers = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if ('c' in p && (p.c === null || numbers(p.c, 2))) out.c = p.c;
  if ('l' in p) out.l = p.l ? 1 : 0;
  if (viewer) return out;
  if ('v' in p && (p.v === null || numbers(p.v, 4))) out.v = p.v;
  if ('s' in p && Array.isArray(p.s)) out.s = p.s.filter(id).slice(0, 5000);
  if ('f' in p && (p.f === null || id(p.f))) out.f = p.f;
  if ('t' in p && (p.t === null || id(p.t))) out.t = p.t;
  if ('m' in p && (p.m === null || (Array.isArray(p.m) && id(p.m[0]) && Number.isFinite(p.m[1])))) out.m = p.m && [p.m[0], p.m[1], p.m[2] ? 1 : 0];
  if ('z' in p && (p.z === null || numbers(p.z, 3))) out.z = p.z;
  if ('d' in p && (p.d === null || (p.d && typeof p.d === 'object'))) out.d = cleanPlayer({ d: p.d }).d;
  if ('u' in p && Array.isArray(p.u)) {
    out.u = p.u.slice(0, 50).filter((u) => u && id(u.i))
      .map((u) => ({ i: u.i, k: Number.isFinite(u.k) ? u.k : 0, ...(typeof u.ph === 'string' && { ph: u.ph.slice(0, 20) }) }));
  }
  return out;
}

// Rounds of changes remembered per board (see `seqs` in boardRecord): the pages heard from most recently.
const SEQS_KEPT = 500;

const VIEWER_COLORS = ['#8bb6e8', '#74c2b9', '#aa9ce6', '#e4c978', '#e090b8', '#82c79b'];

// The board as somebody is given it when they join, and again if it is put back to an older snapshot
// (`restored`, which tells their page that what it could undo no longer applies).
function sendInit(board, peer, restored = false) {
  const access = accessOf(board, peer);
  const project = boardProject(board);
  send(peer.ws, peer.viewer ? {
    t: 'init',
    you: peer.id,
    board: { name: board.name, settings: board.settings || {} },
    access,
    // Watching a presentation: who presents, as their peer here is known.
    ...(peer.watch && { lead: peer.watch.lead }),
    items: [...board.items.values()].filter((it) => !hiddenNote(access, it)).map(withoutOriginal),
    versions: boardVersions(board),
    view3d: board3d(board),
    peers: [...board.peers.values()].filter((p) => p !== peer).map(publicPeer),
    ...(restored && { restored: true }),
  } : {
    t: 'init',
    you: peer.id,
    board: { id: board.id, name: board.name, settings: board.settings || {} },
    project: project ? { id: project.id, name: project.name } : null,
    items: [...board.items.values()],
    versions: boardVersions(board),
    view3d: board3d(board),
    peers: [...board.peers.values()].filter((p) => p !== peer).map(publicPeer),
    ...(restored && { restored: true }),
  });
}

function publicPeer(peer) {
  return { id: peer.id, name: peer.name, color: peer.color, p: peer.p, viewer: !!peer.viewer, ...(peer.lead && { lead: peer.lead }) };
}

// `via` is how somebody who is not on the team came in, if they did: a board's read-only link (`share`, its
// secret), or a presentation that shows the board (`watch`).
function onConnect(ws, board, user, via = null) {
  const viewer = !!via;
  const peer = { id: newId(4), ws, user, name: 'Guest', color: '#888888', p: {}, joined: false, viewer, share: via && via.share, watch: via && via.watch };
  // Whether the way they came in still opens the board.
  const stillOpen = () => (peer.watch ? presentationFor(peer.watch.token) === peer.watch && wasShown(peer.watch, 'board', board.id)
    : board.shareToken === peer.share && !!sharedBoard(peer.share));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const receive = (msg) => {
    if (msg.t === 'hello') {
      if (peer.joined) return;
      // Between connecting and saying hello the board may have been deleted, unshared or moved out of reach.
      if (boards.get(board.id) !== board) return ws.close(4004, 'Board deleted');
      if (viewer && !stillOpen()) return ws.close(4005, 'Link no longer shared');
      if (!viewer && !visible(user, board)) return ws.close(4003, 'Board moved');
      openItems(board);
      peer.joined = true;
      // Which page this is (made afresh each time a page loads, the same across its reconnections), so
      // that a round of changes it sends again after a dropped connection is known (see `seq` below).
      if (typeof msg.cid === 'string' && msg.cid && msg.cid.length <= 40) peer.cid = msg.cid;
      if (viewer) {
        // Someone holding a read-only link: seen only as a pointer. They cannot change anything.
        board.viewerSeq += 1;
        // They give a name when they open the link; nobody vouches for it, so it is only a label.
        peer.name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || `Viewer ${board.viewerSeq}`;
        peer.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : VIEWER_COLORS[(board.viewerSeq - 1) % VIEWER_COLORS.length];
        sendInit(board, peer);
        note(board, peer.name, peer.watch ? 'watch' : 'link');
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
      // Presenting the project this board is in: the people watching follow this peer.
      const pres = typeof msg.present === 'string' && presentationFor(msg.present);
      if (pres && pres.projectId === boardProject(board)?.id && ownerKey(user, peer.name) === pres.owner) peer.lead = pres.lead;
      sendInit(board, peer);
      note(board, peer.name, 'open');
      board.peers.set(peer.id, peer);
      broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
      return;
    }
    if (!peer.joined) return;
    // A viewer may show a pointer and use the laser, and comment when the link allows it. Nothing else.
    if (peer.viewer && msg.t !== 'laser' && msg.t !== 'p' && !(msg.t === 'op' && peer.share && board.shareAccess === 'comment')) return;

    if (msg.t === 'op') {
      // Each round of changes a page sends is numbered (`seq`, counting up for its `cid`). One already
      // applied, sent again because the connection dropped before its ack came, is acked and not applied twice.
      const seq = Number.isSafeInteger(msg.seq) && msg.seq > 0 ? msg.seq : null;
      const ack = seq === null ? { t: 'ack' } : { t: 'ack', seq };
      if (peer.cid && seq !== null) {
        if (seq <= (board.seqs.get(peer.cid) || 0)) return send(ws, ack);
        board.seqs.delete(peer.cid);
        board.seqs.set(peer.cid, seq);
        for (const cid of board.seqs.keys()) {
          if (board.seqs.size <= SEQS_KEPT) break;
          board.seqs.delete(cid);
        }
      }
      // Housekeeping a browser does on opening a board is not somebody changing it.
      const counts = peer.viewer || msg.quiet !== true;
      if (counts) keepSnapshot(board, peer.name);
      const sent = Array.isArray(msg.ops) ? structuredClone(msg.ops) : [];
      const applied = applyOps(board, peer.viewer ? guestOps(board, msg.ops) : msg.ops, peer, counts);
      if (counts && applied.length) {
        const comments = applied.every((op) => (op.t === 'add' ? op.item.type === 'comment' : op.t === 'set' && board.items.get(op.id)?.type === 'comment'));
        note(board, peer.name, comments ? 'comment' : 'edit', applied.length);
      }
      // What the board shows of its notes is worked out now (a note brought back by undo is only there
      // after this), and goes out once the ops themselves have.
      const synced = applied.resync ? syncNotes(board) : [];
      applied.resync = false;
      // Where the server made something else of what was sent (a comment stamped with its author, a
      // version it may not show, a change refused), the sender is given the server's version first...
      const fix = fixesFor(board, sent);
      const told = peer.viewer ? forViewers(board, fix, accessOf(board, peer)) : fix;
      if (told.length) send(ws, { t: 'op', ops: told, fix: true });
      // ...then the ack, always, even when nothing applied, so the sender's outbox stays in step.
      send(ws, ack);
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: peer.id }, peer);
      if (synced.length) broadcast(board, { t: 'op', ops: synced, from: null, sync: true });
      settle(board, applied);
    } else if (msg.t === 'p') {
      if (!msg.p || typeof msg.p !== 'object' || Array.isArray(msg.p)) return;
      const p = cleanPresence(msg.p, peer.viewer);
      if (!Object.keys(p).length) return;
      Object.assign(peer.p, p);
      broadcast(board, { t: 'p', id: peer.id, p }, peer);
    } else if (msg.t === 'laser') {
      if (!Array.isArray(msg.pts)) return;
      const pts = msg.pts.slice(0, 200).filter((n) => Number.isFinite(n));
      // On the board the points are where on the board; in the viewer, where on the open piece (`on`).
      const on = typeof msg.on === 'string' && ID_RE.test(msg.on) ? msg.on : undefined;
      if (pts.length >= 2) broadcast(board, { t: 'laser', id: peer.id, pts: pts.slice(0, pts.length - (pts.length % 2)), ...(on && { on }) }, peer);
    } else if (msg.t === 'media') {
      if (typeof msg.id !== 'string' || !ID_RE.test(msg.id)) return;
      broadcast(board, { t: 'media', from: peer.id, id: msg.id, playing: !!msg.playing, time: Number(msg.time) || 0 }, peer);
    } else if (msg.t === 'lead') {
      // Presenting started or stopped on this page: whoever watches it follows this peer, or no longer.
      const pres = typeof msg.present === 'string' && presentationFor(msg.present);
      const lead = pres && pres.projectId === boardProject(board)?.id && ownerKey(user, peer.name) === pres.owner ? pres.lead : null;
      if ((peer.lead || null) === lead) return;
      peer.lead = lead;
      broadcast(board, { t: 'lead', id: peer.id, lead }, peer);
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

// ---------------------------------------------------------------- the catalogue, live
//
// An asset, set or shot opened in the catalogue's viewer has a room of its own: everyone in it has all
// the notes on all its versions, live, and what they write there is there on every board the version
// is on, as what is written on those boards is there in the room. A note written in the catalogue was
// made on no board (its board is '').

const rooms = new Map(); // entity id -> Set of { ws, name, color, user }

// The notes of an entity as somebody in its room is shown them: which board each was made on is named
// only when they can see that board (null otherwise).
function roomNotes(entityId, user, notes = store.notesOfVersions(store.versionsOf(entityId).map((v) => v.id))) {
  return notes.map((n) => ({
    ...noteData(n.data), id: n.id, type: 'comment', on: n.versionId, ...(n.re && { re: n.re }),
    ob: n.boardId, obn: n.boardId === '' ? 'the catalogue' : boardNameFor(user, n.boardId, n.boardName, n.boardWorkspace),
  }));
}

function tellRoom(entityId) {
  const peers = rooms.get(entityId);
  if (!peers || !peers.size) return;
  const notes = store.notesOfVersions(store.versionsOf(entityId).map((v) => v.id));
  for (const peer of peers) send(peer.ws, { t: 'notes', notes: roomNotes(entityId, peer.user, notes) });
}

// Notes on these versions have changed somewhere: the rooms of their entities are told.
function tellRooms(versionIds) {
  if (!rooms.size) return;
  const entities = new Set();
  for (const id of versionIds) {
    const v = store.version(id);
    if (v && rooms.has(v.entityId)) entities.add(v.entityId);
  }
  for (const id of entities) tellRoom(id);
}

function joinRoom(ws, entity, user) {
  const peer = { ws, user, name: user ? user.name : 'Guest', color: user ? user.color : '#888888', joined: false, viewer: false };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const ofEntity = (versionId) => {
    const v = typeof versionId === 'string' && store.version(versionId);
    return !!v && v.entityId === entity.id;
  };
  const receive = (msg) => {
    if (msg.t === 'hello') {
      if (peer.joined) return;
      // Between connecting and saying hello the project may have moved out of reach.
      const now = store.entity(entity.id);
      if (!now || !visibleScope(user, now.projectId)) return ws.close(4003, 'Project moved');
      peer.joined = true;
      if (!user) {
        peer.name = String(msg.name || 'Guest').slice(0, 32);
        if (/^#[0-9a-f]{6}$/i.test(msg.color)) peer.color = msg.color;
      }
      (rooms.get(entity.id) || rooms.set(entity.id, new Set()).get(entity.id)).add(peer);
      return send(ws, { t: 'init', notes: roomNotes(entity.id, user) });
    }
    if (!peer.joined || msg.t !== 'op' || !Array.isArray(msg.ops)) return;
    const touched = new Set();
    for (const op of msg.ops) {
      if (!op || typeof op !== 'object') continue;
      if (op.t === 'add' && op.item && ID_RE.test(op.item.id)) {
        const known = store.note(op.item.id);
        if (known) {
          // Undo bringing a deleted note back, as its author wrote it (with the replies deleted with it).
          if (known.deletedAt && ofEntity(known.versionId)) {
            store.restoreNote(known.id);
            touched.add(known.versionId);
          }
          continue;
        }
        const c = cleanComment(op.item, peer);
        if (!c || !ofEntity(c.on)) continue;
        let re = null;
        if (c.re) {
          const root = store.note(c.re);
          if (!root || root.deletedAt || root.re || root.versionId !== c.on) continue;
          re = root.id;
        }
        store.addNote({ id: c.id, boardId: '', itemId: c.on, versionId: c.on, re, data: noteData(c), by: peer.name });
        touched.add(c.on);
      } else if (op.t === 'set' && typeof op.id === 'string' && op.patch && typeof op.patch === 'object') {
        const n = store.note(op.id);
        if (!n || n.deletedAt || !ofEntity(n.versionId)) continue;
        const patch = commentPatch(n.data, op.patch, peer);
        if (!patch) continue;
        store.setNote(n.id, { ...n.data, ...patch });
        touched.add(n.versionId);
      } else if (op.t === 'del' && Array.isArray(op.ids)) {
        // As on a board (see mayDelete): a thread first, taking its replies with it. One this person may
        // not delete stays; the room is told its notes again all the same, so their page has it back.
        const notes = op.ids.map((id) => typeof id === 'string' && store.note(id)).filter((n) => n && ofEntity(n.versionId));
        notes.sort((a, b) => (a.re ? 1 : 0) - (b.re ? 1 : 0));
        for (const n of notes) {
          touched.add(n.versionId);
          if (!store.note(n.id).deletedAt && mayDelete(n, peer)) store.deleteNote(n.id);
        }
      }
    }
    send(ws, { t: 'ack' });
    if (touched.size) spreadNotes(touched, null);
  };
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg && typeof msg === 'object') receive(msg);
    } catch (err) {
      if (!(err instanceof SyntaxError)) console.error(`A message in the catalogue could not be handled: ${err.message}`);
    }
  });
  ws.on('close', () => {
    const peers = rooms.get(entity.id);
    if (!peers) return;
    peers.delete(peer);
    if (!peers.size) rooms.delete(entity.id);
  });
  ws.on('error', () => {});
}

// ---------------------------------------------------------------- phone copies
//
// A review copy is made for looking at closely on a desk: up to 1080p and 12 Mbit/s. A phone, or anybody on
// a slow line, waits on that, and stutters until it has all of it. So each video also gets a phone copy:
// the same frames at the same moments, at most 720p and about a fifth of the size, which they play (and keep)
// instead. It is made in the browser, as review copies are, by a desk browser of the team's that has a video
// without one on its page, one at a time when it has nothing better to do (see phoneCopies in ingest.js).
//
// A browser asks first (claim), so two do not make the same one; the server says to go ahead, that it is
// somebody else's for now, or that there is one already (which it then puts everywhere it belongs). Once
// made and uploaded it says so (POST /api/phone-copy { src, lo }), and the server puts `lo` on every piece
// on every board, and every version (and view of one), showing that file.
const PHONE_CLAIM_FOR = 20 * 60e3;
const phoneClaims = new Map(); // upload name -> when a browser said it would make its phone copy

// Puts a file's phone copy everywhere the file is shown that does not have it yet.
function spreadPhoneCopy(src, lo) {
  const name = uploadName(src);
  let pieces = 0;
  const ids = new Map(); // board id -> item ids, as last written
  for (const r of store.itemsWithMedia(name)) (ids.get(r.boardId) || ids.set(r.boardId, new Set()).get(r.boardId)).add(r.id);
  for (const board of boards.values()) {
    if (!board.items && !ids.has(board.id)) continue;
    openItems(board);
    const ops = [];
    for (const it of board.items.values()) {
      if (it.type !== 'video' || it.src !== src || it.lo === lo) continue;
      it.lo = lo;
      board.changed.add(it.id);
      ops.push({ t: 'set', id: it.id, patch: { lo } });
    }
    if (!ops.length) continue;
    pieces += ops.length;
    scheduleSave(board, false);
    broadcast(board, { t: 'op', ops, from: null });
  }
  let versions = 0;
  for (const id of store.versionsWithFile(src)) {
    const v = store.version(id);
    if (!v || !v.look) continue;
    let touched = false;
    const look = { ...v.look };
    if (look.src === src && look.lo !== lo) {
      look.lo = lo;
      touched = true;
    }
    for (const key of ['views', 'extras']) {
      if (Array.isArray(look[key])) look[key] = look[key].map((x) => (x.src === src && x.lo !== lo ? ((touched = true), { ...x, lo }) : x));
    }
    if (touched && store.setLook(id, look)) versions++;
  }
  return { pieces, versions };
}

async function handlePhoneCopy(req, res, rest) {
  const body = await readJson(req);
  const src = typeof body.src === 'string' ? body.src : '';
  const name = uploadName(src);
  const known = name && store.media(name);
  if (!known || !/\.(mp4|m4v|webm|mov)$/i.test(name)) return sendJson(res, 404, { error: 'Not a video here' });
  // POST /api/phone-copy/claim { src }: may this browser make it?
  if (rest === 'claim') {
    if (known.phone) return sendJson(res, 200, { lo: known.phone, ...spreadPhoneCopy(src, known.phone) });
    const at = phoneClaims.get(name);
    if (at && Date.now() - at < PHONE_CLAIM_FOR) return sendJson(res, 200, { busy: true });
    phoneClaims.set(name, Date.now());
    return sendJson(res, 200, { go: true });
  }
  // POST /api/phone-copy { src, lo }: made.
  if (!rest) {
    const loName = uploadName(body.lo);
    const lo = loName && store.media(loName);
    if (!lo || !/\.(mp4|m4v|webm)$/i.test(loName)) return sendJson(res, 400, { error: 'That is not a phone copy here' });
    // Only ever smaller: a "phone copy" no lighter than the review copy would only cost a download. A review
    // copy already as light as a phone copy is its own (lo the same as src), and is not asked about again.
    if (loName !== name && known.size && lo.size >= known.size) return sendJson(res, 400, { error: 'It is not smaller than the review copy' });
    phoneClaims.delete(name);
    if (!known.phone) store.setMediaPhone(name, body.lo);
    const now = store.media(name).phone;
    return sendJson(res, 200, { lo: now, ...spreadPhoneCopy(src, now) });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// ---------------------------------------------------------------- presenting a project
//
// Somebody on the team presents a project: whoever opens its link (/p/<token>) sees what they show, as
// they show it, and can do nothing else: no going elsewhere, no looking about. One board, then an asset's
// versions, then the timeline: the link follows them through all of it. Each person has one link per
// project, kept, so it can be sent ahead of every review; it is live only while they present.
//
// The presenter's pages (present.js) keep a connection here while they present (`hosts`), each page in
// turn, and say what they show (`scene`): a board, an asset, set or shot's versions in the player, the
// timeline, or nothing that can be shown (a list of the catalogue, say: `idle`). With it goes what the
// player is doing (`p`: the piece open, its moment, the thread read, the zoom, 3D) and the laser. The people
// watching (`watchers`) are told all of it. A board is watched as a board is through a read-only link:
// its page, in a frame of the watching page, joined through this link (see onConnect), following the
// presenter's own place on it (their peer there carries `lead`).
//
// What the people watching can load is what has been shown since the link was made live (`shown`): the
// boards' files as a read-only link has them, the versions of the assets, sets and shots opened, the
// shots of a timeline played, and the project's model of its venue. Never a file a video was made from.

const PRESENT_ACCESS = ['view', 'comments'];
const WATCH_COOKIE = 'wb_watch';
// A presenter's page that goes (to open the next one) is given this long to come back before the people
// watching are told they have stepped away.
const AWAY_AFTER = 5000;
// Away this long (the presenter's browser closed, say), presenting ends, as if they had stopped.
const ENDS_AFTER = Number(process.env.WIPBOARD_PRESENT_AWAY_MS) || 30 * 60e3;
const SHOWN_KEPT = 100;
const presentations = new Map(); // token -> the link and, while somebody presents through it, its live state

// Who presents: their sign-in, or where nobody signs in, the name they go by.
const ownerKey = (user, name) => (user ? `u:${user.id}` : `n:${String(name || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 32)}`);

function presentationRuntime(record) {
  return {
    ...record,
    hosts: new Set(),   // the presenter's connections, a page each
    leader: null,       // the one whose word goes: the page that last said what it shows
    color: '#888888',
    live: false,
    away: false,
    awayTimer: 0,
    scene: null,
    p: {},
    watchers: new Set(), // { ws, name, color, cache }
    shown: [],           // scenes shown since it was made live, as { k, id, task }
    files: null,         // what may be loaded through it, worked out from `shown` when asked (see presentedFiles)
    filesAt: 0,
    notesOf: null,       // the entity whose notes the people watching are shown
    lead: newId(6),      // how the presenter's own peer on a board is known to the people watching it
  };
}

function loadPresentations() {
  for (const r of store.presentations()) presentations.set(r.token, presentationRuntime(r));
}

// The link, while it works: sharing is on here, it has not run out, and its project is still a project.
function presentationFor(token) {
  const pres = SHARING && typeof token === 'string' ? presentations.get(token) : null;
  if (!pres || (pres.expiresAt && pres.expiresAt <= Date.now())) return null;
  const project = folders.get(pres.projectId);
  return project && project.project ? pres : null;
}

const presentInfo = (pres) => (pres
  ? { token: pres.token, access: pres.access, expiresAt: pres.expiresAt || null, live: pres.live, watching: pres.watchers.size }
  : { token: null });

const tellWatchers = (pres, msg) => {
  const data = JSON.stringify(msg);
  for (const w of pres.watchers) if (w.ws.readyState === 1) w.ws.send(data);
};
const tellHosts = (pres, msg) => {
  for (const ws of pres.hosts) send(ws, msg);
};
const tellWatching = (pres) => tellHosts(pres, { t: 'watchers', list: [...pres.watchers].map((w) => ({ name: w.name, color: w.color, cache: w.cache })) });

// How much of what is shown somebody watching has cached on their computer, as their page says it (see
// watch.js): the whole of it (k), the videos done and there are (v), the model of the venue (m, or null
// where there is none), why caching is not going on (off), or that it is still working that out (wait).
const CACHE_OFF = ['unavailable', 'off', 'data', 'full'];
function cleanCache(msg) {
  if (msg.wait) return { wait: true };
  const part = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
  const count = (n) => (Number.isInteger(n) ? Math.min(9999, Math.max(0, n)) : 0);
  const k = part(msg.k);
  if (k === null) return null;
  const v = Array.isArray(msg.v) ? [count(msg.v[0]), count(msg.v[1])] : [0, 0];
  return { k, v: [Math.min(v[0], v[1]), v[1]], m: part(msg.m), off: CACHE_OFF.includes(msg.off) ? msg.off : null };
}

// Everybody watching through it, on the link's own page or on a board's, is shown the door.
function closeWatchers(pres, code, reason) {
  for (const w of [...pres.watchers]) w.ws.close(code, reason);
  for (const board of boards.values()) {
    for (const peer of [...board.peers.values()]) if (peer.watch === pres) peer.ws.close(code, reason);
  }
}

function endPresenting(pres) {
  clearTimeout(pres.awayTimer);
  pres.live = false;
  pres.away = false;
  pres.leader = null;
  pres.scene = null;
  pres.p = {};
  pres.shown = [];
  pres.files = null;
  pres.notesOf = null;
  tellWatchers(pres, { t: 'ended' });
  // A board being watched through it is not, any more.
  for (const board of boards.values()) {
    for (const peer of [...board.peers.values()]) if (peer.watch === pres) peer.ws.close(4007, 'Presenting ended');
  }
}

function dropPresentation(pres, code = 4005) {
  presentations.delete(pres.token);
  store.deletePresentation(pres.token);
  for (const ws of [...pres.hosts]) ws.close(4005, 'Link no longer shared');
  closeWatchers(pres, code, 'Link no longer shared');
}

// Links that ran out stop working for whoever has them open, presenting or watching.
function closeExpiredPresentations() {
  for (const pres of [...presentations.values()]) {
    if (pres.expiresAt && pres.expiresAt <= Date.now() && (pres.hosts.size || pres.watchers.size)) {
      for (const ws of [...pres.hosts]) ws.close(4005, 'Link no longer shared');
      closeWatchers(pres, 4005, 'Link no longer shared');
    }
  }
}

// What a presenter's page says it shows, if it is something of this project they may see. Anything else
// is shown as nothing (`idle`): the people watching wait.
function cleanScene(pres, user, s) {
  const idle = { k: 'idle' };
  if (!s || typeof s !== 'object') return idle;
  const token = (v) => (typeof v === 'string' ? viewName(v) || '' : '');
  if (s.k === 'board') {
    const board = typeof s.board === 'string' && boards.get(s.board);
    if (!board || !visible(user, board) || boardProject(board)?.id !== pres.projectId) return idle;
    return { k: 'board', board: board.id };
  }
  if (s.k === 'entity') {
    const e = typeof s.entity === 'string' && store.entity(s.entity);
    if (!e || e.projectId !== pres.projectId) return idle;
    return { k: 'entity', entity: e.id, view: token(s.view) };
  }
  if (s.k === 'run') {
    return {
      k: 'run', seq: typeof s.seq === 'string' ? s.seq.slice(0, 80) : '', task: typeof s.task === 'string' ? naming.tokenize(s.task) || '' : '',
      empty: s.empty !== false, view: token(s.view),
    };
  }
  return idle;
}

// What the player is doing, as the presenter's page says it: the piece open (f), which of its version's
// files is shown in its place (x: an extra's label, '' its own), the thread read (t), the
// moment of the video (m), the zoom on the piece (z: its middle, in drawing units, and how far in), and in
// 3D, how it is seen (d: on, the model's camera held, a comment's frame held, or the view flown).
function cleanPlayer(p) {
  const out = {};
  const id = (v) => typeof v === 'string' && v.length <= 60;
  const numbers = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  const pose = (v) => v && typeof v === 'object' && numbers(v.p, 3) && numbers(v.q, 4) && Number.isFinite(v.fov) && { p: v.p, q: v.q, fov: v.fov, ...(Number.isFinite(v.t) && { t: v.t }) };
  if ('f' in p && (p.f === null || id(p.f))) out.f = p.f;
  if ('x' in p && typeof p.x === 'string' && p.x.length <= 40) out.x = p.x;
  if ('t' in p && (p.t === null || id(p.t))) out.t = p.t;
  if ('m' in p && (p.m === null || (Array.isArray(p.m) && id(p.m[0]) && Number.isFinite(p.m[1])))) out.m = p.m && [p.m[0], p.m[1], p.m[2] ? 1 : 0];
  if ('z' in p && (p.z === null || numbers(p.z, 3))) out.z = p.z;
  if ('d' in p && (p.d === null || (p.d && typeof p.d === 'object'))) {
    out.d = p.d && {
      on: p.d.on ? 1 : 0,
      ...(Number.isInteger(p.d.c) && p.d.c >= 0 && p.d.c < 100 && { c: p.d.c }),
      ...(pose(p.d.q) && { q: pose(p.d.q) }),
      ...(pose(p.d.f) && { f: pose(p.d.f) }),
    };
  }
  return out;
}

const shownKey = (s) => `${s.k}:${s.id || ''}:${s.task || ''}`;

// The entity whose notes go with what is shown: the one open, or on the timeline, the shot on screen.
function notesEntity(pres) {
  const s = pres.scene;
  if (!s || pres.access !== 'comments') return null;
  if (s.k === 'entity') return s.entity;
  if (s.k !== 'run' || typeof pres.p.f !== 'string') return null;
  const v = store.version(pres.p.f);
  return v && v.entityId;
}
// Notes as the people watching are shown them: never which board they were made on.
const watcherNotes = (entityId) => roomNotes(entityId, null).map(({ ob, obn, ...n }) => n);
function retellWatcherNotes(pres, force = false) {
  const entityId = notesEntity(pres);
  if (!force && entityId === pres.notesOf) return;
  pres.notesOf = entityId;
  tellWatchers(pres, { t: 'notes', notes: entityId ? watcherNotes(entityId) : [] });
}
// Notes on these versions changed: whoever watches them being shown is told.
function retellPresentations(versionIds) {
  let entities = null;
  for (const pres of presentations.values()) {
    if (!pres.live || !pres.notesOf || !pres.watchers.size) continue;
    entities = entities || new Set(versionIds.map((id) => store.version(id)?.entityId).filter(Boolean));
    if (entities.has(pres.notesOf)) retellWatcherNotes(pres, true);
  }
}

// The newest version of each of the project's shots, as the timeline plays them (of `task`, or of any).
function timelineShots(projectId, task) {
  const p = folders.get(projectId);
  const inOrder = naming.shotOrder(p && p.settings && p.settings.seqs);
  return store.entities(projectId).filter((e) => e.tier === 'shot').sort((a, b) => inOrder(a.name, b.name)).map((e) => {
    const v = task ? store.newestOfTask(e.id, naming.tokenize(task) || null) : e.newest;
    return { e, v };
  });
}

// The files that may be loaded through the link: those of what has been shown. Worked out again every few
// seconds, so a piece put on a board, or a version filed, while it is being shown can be loaded too.
const FILES_FOR = 5000;
function presentedFiles(pres) {
  if (pres.files && Date.now() - pres.filesAt < FILES_FOR) return pres.files;
  const out = new Set();
  const add = (src) => {
    const name = uploadName(src);
    if (name) out.add(name);
  };
  const addLook = (look) => {
    if (!look) return;
    for (const key of ['src', 'lo', 'th', 'poster', 'prev']) add(look[key]);
    if (look.wf && typeof look.wf === 'object') Object.values(look.wf).forEach(add);
    for (const v of look.views || []) addLook(v);
  };
  const project = folders.get(pres.projectId);
  add(project && project.settings && project.settings.preview3d && project.settings.preview3d.model);
  for (const s of pres.shown) {
    if (s.k === 'board') {
      const board = boards.get(s.id);
      if (!board) continue;
      openItems(board);
      for (const it of board.items.values()) if (it.type !== 'comment') addLook(it);
      for (const v of boardVersions(board)) {
        add(v.thumb);
        addLook(v.look3d);
      }
    } else if (s.k === 'entity') {
      for (const v of store.versionsOf(s.id)) {
        addLook(v.look);
        add(v.thumb);
      }
    } else if (s.k === 'run') {
      for (const { v } of timelineShots(pres.projectId, s.task)) {
        if (!v) continue;
        addLook(v.look);
        add(v.thumb);
      }
    }
  }
  pres.files = out;
  pres.filesAt = Date.now();
  return out;
}

// Whether somebody who opened a live presentation's link may load this file.
function watchedFile(req, name) {
  const pres = presentationFor(parseCookies(req.headers.cookie)[WATCH_COOKIE]);
  return !!pres && pres.live && presentedFiles(pres).has(name);
}
const wasShown = (pres, k, id, task = '') => pres.live && pres.shown.some((s) => shownKey(s) === shownKey({ k, id, task }));

// GET /api/watch/<token>[/entity/<id> | /timeline?task=]: what the link's page needs, without sign-in.
// What it is (whose, of what), and only for what is being shown or has been, its pieces.
function handleWatchApi(req, res, url, token, rest) {
  const pres = presentationFor(token);
  if (!pres) return sendJson(res, 404, { error: 'This link is not shared any more' });
  const project = folders.get(pres.projectId);
  if (!rest) {
    return sendJson(res, 200, { project: { name: project.name }, presenter: { name: pres.ownerName || 'Somebody', color: pres.color }, access: pres.access, live: pres.live });
  }
  const preview3d = project.settings && project.settings.preview3d;
  const projectOut = { id: project.id, name: project.name, settings: preview3d ? { preview3d } : {} };
  const versionOut = (v, e) => ({ id: v.id, kind: v.kind, task: v.task, number: v.number, hidden: v.hidden, originalName: v.originalName, look: v.look, label: naming.label(e.name, v.task, v.number) });
  const entity = /^entity\/([\w-]{4,40})$/.exec(rest);
  if (entity) {
    const e = store.entity(entity[1]);
    if (!e || e.projectId !== pres.projectId || !wasShown(pres, 'entity', e.id)) return sendJson(res, 404, { error: 'Not shown' });
    return sendJson(res, 200, {
      entity: { id: e.id, name: e.name, tier: e.tier, projectId: e.projectId }, project: projectOut,
      versions: store.versionsOf(e.id).map((v) => versionOut(v, e)), notes: [],
    });
  }
  if (rest === 'timeline') {
    const task = url.searchParams.get('task') || '';
    if (!wasShown(pres, 'run', null, naming.tokenize(task) || '')) return sendJson(res, 404, { error: 'Not shown' });
    return sendJson(res, 200, {
      project: projectOut, tasks: store.projectTasks(project.id), views: store.projectViews(project.id),
      shots: timelineShots(project.id, task).map(({ e, v }) => ({ id: e.id, name: e.name, seq: naming.seqOf(e.name), version: v && versionOut(v, e) })),
    });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// /api/projects/:id/present: the link of the person asking, to present this project through. GET says
// what it is, POST makes it (or gives the one there is), PATCH changes who sees what and when it ends,
// POST .../reset makes a new one that stops the old at once, DELETE takes it away.
async function handlePresentApi(req, res, url, project, rest) {
  const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
  const name = req.user ? req.user.name : cleanName(body.by || url.searchParams.get('by'), '').slice(0, 32);
  if (!req.user && !name) return sendJson(res, 400, { error: 'Say who is presenting' });
  const owner = ownerKey(req.user, name);
  const mine = [...presentations.values()].find((p) => p.projectId === project.id && p.owner === owner) || null;
  if (!SHARING) return sendJson(res, 403, { error: 'Links are turned off on this server' });
  if (!rest && req.method === 'GET') return sendJson(res, 200, presentInfo(mine && presentationFor(mine.token)));
  if (!rest && req.method === 'POST') {
    if (mine && presentationFor(mine.token)) return sendJson(res, 200, presentInfo(mine));
    if (mine) dropPresentation(mine);
    const access = PRESENT_ACCESS.includes(body.access) ? body.access : 'view';
    const pres = presentationRuntime({ token: newId(18), projectId: project.id, owner, ownerName: name, access, expiresAt: null, createdAt: Date.now() });
    presentations.set(pres.token, pres);
    store.savePresentation(pres);
    return sendJson(res, 200, presentInfo(pres));
  }
  if (!mine) return sendJson(res, 404, { error: 'There is no link to present this project yet' });
  if (!rest && req.method === 'PATCH') {
    const before = mine.access;
    if (PRESENT_ACCESS.includes(body.access)) mine.access = body.access;
    if ('expiresAt' in body) mine.expiresAt = Number.isSafeInteger(body.expiresAt) && body.expiresAt > Date.now() ? body.expiresAt : null;
    mine.ownerName = name;
    store.savePresentation(mine);
    if (mine.access !== before) {
      // The people watching are shown the notes, or no longer, from now on.
      mine.notesOf = undefined;
      retellWatcherNotes(mine);
      tellWatchers(mine, { t: 'access', access: mine.access });
      for (const board of boards.values()) {
        for (const peer of [...board.peers.values()]) if (peer.watch === mine) peer.ws.close(4006, 'Link settings changed');
      }
    }
    return sendJson(res, 200, presentInfo(mine));
  }
  if (rest === 'reset' && req.method === 'POST') {
    dropPresentation(mine);
    const { projectId, ownerName, access, expiresAt } = mine;
    const pres = presentationRuntime({ token: newId(18), projectId, owner, ownerName, access, expiresAt, createdAt: Date.now() });
    presentations.set(pres.token, pres);
    store.savePresentation(pres);
    return sendJson(res, 200, presentInfo(pres));
  }
  if (!rest && req.method === 'DELETE') {
    dropPresentation(mine);
    return sendJson(res, 200, { token: null });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

// The presenter's page, presenting: it says what it shows, and the people watching are told.
function presentHost(ws, pres, user) {
  let joined = false;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const receive = (msg) => {
    if (msg.t === 'hello') {
      if (joined) return;
      if (presentationFor(pres.token) !== pres) return ws.close(4005, 'Link no longer shared');
      if (!visibleFolder(user, pres.projectId) || ownerKey(user, msg.name) !== pres.owner) return ws.close(4003, 'Not yours to present');
      joined = true;
      pres.hosts.add(ws);
      pres.color = user ? user.color : /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : pres.color;
      if (user && user.name !== pres.ownerName) {
        pres.ownerName = user.name;
        store.savePresentation(pres);
      }
      clearTimeout(pres.awayTimer);
      const starting = !pres.live;
      pres.live = true;
      if (starting) tellWatchers(pres, { t: 'live', presenter: { name: pres.ownerName, color: pres.color }, access: pres.access });
      else if (pres.away) {
        pres.away = false;
        tellWatchers(pres, { t: 'back' });
      }
      send(ws, { t: 'init', ...presentInfo(pres) });
      tellWatching(pres);
      return;
    }
    if (!joined || !pres.live) return;
    if (msg.t === 'end') return endPresenting(pres);
    if (msg.t === 'scene') {
      pres.leader = ws;
      const scene = cleanScene(pres, user, msg.scene);
      const p = msg.p && typeof msg.p === 'object' ? cleanPlayer(msg.p) : {};
      const shown = scene.k === 'idle' ? null : { k: scene.k, id: scene.board || scene.entity || null, task: scene.task || '' };
      if (shown && !pres.shown.some((s) => shownKey(s) === shownKey(shown))) {
        pres.shown.push(shown);
        if (pres.shown.length > SHOWN_KEPT) pres.shown.shift();
        pres.files = null;
      }
      pres.scene = scene;
      pres.p = p;
      pres.mAt = Date.now();
      tellWatchers(pres, { t: 'scene', scene, p });
      // What they had cached was for what was shown before: they say how it stands for this.
      for (const w of pres.watchers) w.cache = { wait: true };
      tellWatching(pres);
      retellWatcherNotes(pres);
      return;
    }
    // Only the page whose word goes: another tab of theirs, left open, says nothing to anyone.
    if (ws !== pres.leader) return;
    if (msg.t === 'p') {
      if (!msg.p || typeof msg.p !== 'object' || Array.isArray(msg.p)) return;
      const p = cleanPlayer(msg.p);
      if (!Object.keys(p).length) return;
      Object.assign(pres.p, p);
      if ('m' in p) pres.mAt = Date.now();
      tellWatchers(pres, { t: 'p', p });
      if ('f' in p) retellWatcherNotes(pres);
    } else if (msg.t === 'laser') {
      if (!Array.isArray(msg.pts) || typeof msg.on !== 'string' || msg.on.length > 60) return;
      const pts = msg.pts.slice(0, 200).filter((n) => Number.isFinite(n));
      if (pts.length >= 2) tellWatchers(pres, { t: 'laser', on: msg.on, pts: pts.slice(0, pts.length - (pts.length % 2)) });
    }
  };
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg && typeof msg === 'object') receive(msg);
    } catch (err) {
      if (!(err instanceof SyntaxError)) console.error(`A message from a presenter could not be handled: ${err.message}`);
    }
  });
  ws.on('close', () => {
    if (!pres.hosts.delete(ws)) return;
    if (pres.leader === ws) pres.leader = null;
    if (pres.hosts.size || !pres.live) return;
    clearTimeout(pres.awayTimer);
    pres.awayTimer = setTimeout(() => {
      if (pres.hosts.size || !pres.live) return;
      pres.away = true;
      tellWatchers(pres, { t: 'away' });
      pres.awayTimer = setTimeout(() => {
        if (!pres.hosts.size && pres.live) endPresenting(pres);
      }, ENDS_AFTER);
    }, AWAY_AFTER);
  });
  ws.on('error', () => {});
}

// Somebody watching through the link, on its own page.
function presentWatcher(ws, pres) {
  const w = { ws, name: 'Guest', color: VIEWER_COLORS[0], cache: null };
  let joined = false;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.t === 'cache' && joined) {
      w.cache = cleanCache(msg);
      return tellWatching(pres);
    }
    if (msg.t !== 'hello' || joined) return;
    if (presentationFor(pres.token) !== pres) return ws.close(4005, 'Link no longer shared');
    joined = true;
    w.name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || `Viewer ${pres.watchers.size + 1}`;
    w.color = /^#[0-9a-f]{6}$/i.test(msg.color) ? msg.color : VIEWER_COLORS[pres.watchers.size % VIEWER_COLORS.length];
    pres.watchers.add(w);
    const entityId = notesEntity(pres);
    send(ws, {
      t: 'init',
      project: { name: folders.get(pres.projectId).name },
      presenter: { name: pres.ownerName || 'Somebody', color: pres.color },
      access: pres.access, live: pres.live, away: pres.away,
      scene: pres.live ? pres.scene : null, p: pres.live ? pres.p : {}, mAge: pres.mAt ? Date.now() - pres.mAt : 0,
      notes: entityId ? watcherNotes(entityId) : [],
    });
    tellWatching(pres);
  });
  ws.on('close', () => {
    if (pres.watchers.delete(w)) tellWatching(pres);
  });
  ws.on('error', () => {});
}

// ---------------------------------------------------------------- start

loadBoards();
loadFolders();
loadPresentations();
cleanStaleUploads();
setInterval(cleanStaleUploads, 10 * 60e3).unref();
setInterval(unloadIdle, Math.min(60e3, IDLE_UNLOAD)).unref();
setInterval(() => {
  closeExpiredLinks();
  closeExpiredPresentations();
}, 30e3).unref();

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
  console.log(`Boards by Myreze is running. ${boards.size} board(s) loaded from ${DATA_DIR}. Sign-in: ${auth.mode}`);
  console.log(`  Claude:        ${ai.enabled ? `on, ${ai.model} (suggests names when importing and in batch edit)` : 'off (set ANTHROPIC_API_KEY to turn it on)'}`);
  console.log(`  This machine:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  On the network: http://${net.address}:${PORT}`);
    }
  }
  console.log(`  By hostname:   http://${os.hostname()}:${PORT}`);
});
