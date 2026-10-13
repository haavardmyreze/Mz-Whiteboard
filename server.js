'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const { createAuth, parseCookies } = require('./auth');
const { openStore } = require('./store');
const { noticesFor, markRead } = require('./notifications');
const { createAdmin } = require('./admin');
const zip = require('./zip');
const naming = require('./public/naming');

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
  // Made on another board: which one, so the thread can say so.
  if (n.boardId !== board.id) {
    c.ob = n.boardId;
    // Made in the catalogue, on no board at all.
    c.obn = n.boardId === '' ? 'the catalogue' : boards.get(n.boardId)?.name || 'another board';
  }
  return c;
}

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
  return clean;
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

// A piece may show a catalogue version (`ver`) only if there is such a version. A snapshot or an undo
// that brings back a piece of a version since deleted brings it back as plain media.
function checkVer(it) {
  if (it.ver === undefined || it.ver === null) return;
  if (!liveVersion(it.ver)) delete it.ver;
}

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
          // Undo bringing back a note that was deleted: as its author wrote it, wherever it belongs.
          if (known.deletedAt) store.restoreNote(it.id);
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
      if (it.type === 'stroke' || it.type === 'frame' || it.type === 'note' || it.type === 'text' || it.type === 'block') delete it.ver;
      else checkVer(it);
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
        if ('ver' in patch) {
          checkVer(patch);
          if (!('ver' in patch)) patch.ver = null;
          applied.resync = true;
          if (typeof patch.ver === 'string') applied.versions.add(patch.ver);
        }
      }
      Object.assign(it, patch);
      if (it.ver === null) delete it.ver;
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
  // own, from a piece still here, somebody deleted it.
  for (const c of removedComments) {
    applied.resync = true;
    const n = store.note(c.id);
    if (!n) continue;
    if (n.versionId) applied.notes.add(n.versionId);
    if (board.items.has(c.on)) store.deleteNote(c.id);
  }
  if (applied.length) scheduleSave(board, touch);
  return applied;
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
  if (applied.versions.size) broadcast(board, { t: 'versions', list: [...applied.versions].map(versionInfo).filter(Boolean) });
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
// What a project is set to: for now, which naming preset its files are read by.
function cleanProjectSettings(asked, was = {}) {
  const out = { ...was };
  if (asked && typeof asked === 'object' && typeof asked.naming === 'string' && naming.PRESETS[asked.naming]) out.naming = asked.naming;
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
}

// ---------------------------------------------------------------- the catalogue of a project
//
// A project folder keeps a catalogue: its entities (assets, sets and shots) and the versions filed under
// them. A version is filed from a piece of media on a board in the project, or from the project's
// catalogue page. A piece on a board that shows a version says which (`ver`); the board shows what it is
// called, and when there is a newer one.

const LOOK_KEYS = ['type', 'src', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name'];
const UPLOAD_KEYS = new Set(['src', 'orig', 'prev', 'th', 'poster']);

// What a board needs to show a file, taken from a piece on a board or from a file brought into the catalogue, keeping
// only what such a piece has: addresses of uploaded files, its size, length and rate, its name.
function cleanLook(asked) {
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
    } else if (key === 'wf') {
      // The timeline strip: the colours of the picture and the loudness of the sound, each packed small.
      if (v && typeof v === 'object' && typeof v.c === 'string' && v.c.length < 100000 && (v.p === undefined || (typeof v.p === 'string' && v.p.length < 100000))) look.wf = { c: v.c, ...(v.p && { p: v.p }) };
    } else if (Number.isFinite(v) && v >= 0) {
      look[key] = v;
    }
  }
  if (!look.src || !look.type || !store.media(uploadName(look.src))) return null;
  return look;
}

// A version as a board and the catalogue show it: what it is called, and the newest of its entity and
// task when that is a later one.
function versionInfo(ref) {
  const v = typeof ref === 'string' ? liveVersion(ref) : ref;
  const e = v && store.entity(v.entityId);
  if (!e) return null;
  const newest = store.newestVersion(v.entityId, v.task);
  return {
    id: v.id, entityId: e.id, entity: e.name, tier: e.tier, projectId: e.projectId, task: v.task, number: v.number,
    label: naming.label(e.name, v.task, v.number), hip: v.hip, artist: v.artist, descriptor: v.descriptor, hidden: v.hidden,
    thumb: v.thumb, kind: v.kind, newest: newest && newest.id !== v.id && newest.number > v.number ? newest : null,
  };
}

function publicVersion(v) {
  return {
    ...versionInfo(v), look: v.look, originalName: v.originalName, createdAt: v.createdAt, createdBy: v.createdBy,
    board: v.boardId && boards.has(v.boardId) ? { id: v.boardId, name: boards.get(v.boardId).name } : null,
  };
}

// The versions a board shows, as it shows them.
function boardVersions(board) {
  const ids = new Set();
  for (const it of board.items.values()) if (it.type !== 'comment' && typeof it.ver === 'string') ids.add(it.ver);
  return [...ids].map(versionInfo).filter(Boolean);
}

// An entity has a new version, or one hidden or shown again: the boards that show any of its versions
// are told what they are now called, and whether a newer one is there.
function retellEntity(entityId) {
  for (const board of boards.values()) {
    if (!board.items || !board.peers.size) continue;
    const list = boardVersions(board).filter((v) => v.entityId === entityId);
    if (list.length) broadcast(board, { t: 'versions', list });
  }
}

const presetOf = (project) => naming.preset(project.settings && project.settings.naming);

// The entity a file is to go under: one the project has, by its id, or one to make, by its name.
function resolveEntity(project, spec, by) {
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
  const presetId = project.settings && project.settings.naming;
  const tier = naming.TIERS.includes(spec.tier) ? spec.tier : naming.tierOf(name, presetId) || 'asset';
  return store.addEntity({ id: newId(), projectId: project.id, tier, name, by });
}

const tokenOrNull = (v) => (typeof v === 'string' && naming.tokenize(v) ? naming.tokenize(v) : null);

// Files pieces of media as versions. Each file is a piece on a board ({ board, item }) or a file
// brought into the catalogue ({ look }); what each says about itself (entity, task, descriptor,
// artist) goes before what is said for them all. What its name says fills in the rest.
async function fileVersions(req, project, body) {
  const by = req.user ? req.user.name : cleanName(body.by, null);
  const files = Array.isArray(body.files) ? body.files.slice(0, 500) : [];
  if (!files.length) throw refusal(400, 'Nothing to file');
  const presetId = project.settings && project.settings.naming;
  // Everything is checked before anything is filed, so a mistake files nothing.
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
      look = cleanLook(item);
      if (!look) throw refusal(400, `“${item.name || 'That piece'}” has not finished uploading`);
    } else {
      look = cleanLook(f.look);
      if (!look) throw refusal(400, 'That file is not on the server');
    }
    const parsed = naming.parse(look.name || '', presetId);
    return { f, board, item, look, parsed };
  });
  const out = [];
  const entitiesTouched = new Set();
  for (const p of plan) {
    const pick = (key) => (p.f[key] !== undefined ? p.f[key] : body[key]);
    const entity = resolveEntity(project, pick('entity') ?? (p.parsed.entity && { name: p.parsed.entity, tier: p.parsed.tier }), by);
    const task = pick('task') !== undefined ? tokenOrNull(pick('task')) : p.parsed.task;
    const descriptor = pick('descriptor') !== undefined ? tokenOrNull(pick('descriptor')) : p.parsed.descriptor;
    const artist = pick('artist') !== undefined ? tokenOrNull(pick('artist')) : p.parsed.artist;
    const media = uploadName(p.look.src);
    const thumb = p.look.th || (p.look.type === 'image' ? p.look.prev || p.look.src : p.look.poster) || null;
    const v = store.addVersion({
      id: newId(), entityId: entity.id, task, descriptor, artist, hip: Number.isSafeInteger(p.parsed.hip) ? p.parsed.hip : null,
      media, thumb, kind: p.look.type, originalName: p.look.name || null, look: p.look, boardId: p.board ? p.board.id : null, by,
    });
    entitiesTouched.add(entity.id);
    if (p.board) {
      // What was said about the piece goes with it: from now on it is said about the version.
      store.fileNotes(p.board.id, p.item.id, v.id);
      const applied = applyOps(p.board, [{ t: 'set', id: p.item.id, patch: { ver: v.id } }], null, false);
      if (applied.length) broadcast(p.board, { t: 'op', ops: applied, from: null });
      settle(p.board, applied);
      note(p.board, by || 'Somebody', 'file');
    }
    out.push(publicVersion(v));
  }
  for (const id of entitiesTouched) retellEntity(id);
  return out;
}

async function handleCatalogue(req, res, parts) {
  const projectFor = (id) => (visibleFolder(req.user, id) && folders.get(id).project ? folders.get(id) : null);
  // GET /api/projects/:id                  the project and its entities
  // POST /api/projects/:id/entities        { name, tier }
  // POST /api/projects/:id/versions        { files, entity, task, descriptor, artist }
  if (parts[1] === 'projects') {
    const project = projectFor(parts[2]);
    if (!project) return sendJson(res, 404, { error: 'Project not found' });
    if (parts.length === 3 && req.method === 'GET') {
      flushAll();
      const preset = presetOf(project);
      return sendJson(res, 200, {
        project: publicFolder(project),
        preset: { id: (project.settings && project.settings.naming) || naming.DEFAULT, name: preset.name, tiers: preset.tiers.map((t) => ({ id: t.id, label: t.label, one: t.one })), tasks: preset.tasks },
        entities: store.entities(project.id),
        tasks: [...new Set([...preset.tasks, ...store.projectTasks(project.id)])],
        artists: store.projectArtists(project.id),
        boards: [...boards.values()].filter((b) => visible(req.user, b) && boardProject(b) === project).map((b) => ({ id: b.id, name: b.name })),
      });
    }
    if (parts.length === 4 && parts[3] === 'entities' && req.method === 'POST') {
      const body = await readJson(req);
      const by = req.user ? req.user.name : cleanName(body.by, null);
      return sendJson(res, 201, resolveEntity(project, { name: body.name, tier: body.tier }, by));
    }
    if (parts.length === 4 && parts[3] === 'versions' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      return sendJson(res, 201, { versions: await fileVersions(req, project, body) });
    }
    return sendJson(res, 404, { error: 'Not found' });
  }
  // GET /api/entities/:id: an entity, every version of it, and everything said about them.
  if (parts[1] === 'entities' && parts.length === 3 && req.method === 'GET') {
    const entity = store.entity(parts[2]);
    const project = entity && projectFor(entity.projectId);
    if (!project) return sendJson(res, 404, { error: 'Not found' });
    flushAll();
    const versions = store.versionsOf(entity.id);
    const notes = store.notesOfVersions(versions.map((v) => v.id)).map((n) => ({
      id: n.id, versionId: n.versionId, re: n.re, board: { id: n.boardId, name: n.boardName }, ...noteData(n.data),
    }));
    return sendJson(res, 200, {
      entity, project: publicFolder(project),
      versions: versions.map((v) => ({ ...publicVersion(v), boards: store.boardsWithVersion(v.id).filter((b) => canSee(req.user, b.workspace)).map((b) => ({ id: b.id, name: b.name })) })),
      notes,
    });
  }
  // GET /api/versions/:id
  // PATCH  { entity, task, number, descriptor, artist }   what it is filed as: its name follows
  // PATCH  { hidden }                                      archived: out of the catalogue's way, and no longer the newest
  // PATCH  { deleted: false }                              a deleted one brought back
  // DELETE                                                 only one that no board shows; it is marked, not removed
  if (parts[1] === 'versions' && parts.length === 3) {
    const v = store.version(parts[2]);
    const entity = v && store.entity(v.entityId);
    const project = entity && projectFor(entity.projectId);
    if (!project) return sendJson(res, 404, { error: 'Not found' });
    if (v.deletedAt && !(req.method === 'PATCH')) return sendJson(res, 404, { error: 'That version was deleted' });
    if (req.method === 'GET') return sendJson(res, 200, publicVersion(v));
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
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (v.deletedAt) {
        if (body.deleted !== false) return sendJson(res, 404, { error: 'That version was deleted' });
        store.restoreVersion(v.id);
      }
      if ('hidden' in body) store.hideVersion(v.id, !!body.hidden);
      const edit = {};
      if (body.entity !== undefined) {
        const by = req.user ? req.user.name : cleanName(body.by, null);
        edit.entityId = resolveEntity(project, body.entity, by).id;
      }
      if (body.task !== undefined) edit.task = tokenOrNull(body.task);
      if (body.descriptor !== undefined) edit.descriptor = tokenOrNull(body.descriptor);
      if (body.artist !== undefined) edit.artist = tokenOrNull(body.artist);
      if (body.number !== undefined && body.number !== null) {
        const n = Number(body.number);
        if (!Number.isSafeInteger(n) || n < 1 || n > 99999) return sendJson(res, 400, { error: 'A version number is a whole number from 1' });
        edit.number = n;
      }
      if (Object.keys(edit).length) {
        const done = store.editVersion(v.id, edit);
        if (!done.ok) {
          const t = done.taken;
          const name = naming.label(store.entity(t.entityId).name, t.task, t.number);
          return sendJson(res, 409, { error: t.deletedAt ? `${name} was given to a version since deleted, so it can't be used again` : `There is a ${name} already` });
        }
      }
      // The boards showing it, and the catalogue rooms it was and is in, are told what it is now called.
      const now = store.version(v.id);
      for (const id of new Set([entity.id, now.entityId])) {
        retellEntity(id);
        tellRoom(id);
      }
      return sendJson(res, 200, publicVersion(now));
    }
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
  let start = 0;
  let end = plan.size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const same = !req.headers['if-range'] || req.headers['if-range'] === etag;
  if (range && (range[1] || range[2]) && same) {
    if (range[1] === '') {
      start = Math.max(0, plan.size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(end, Number(range[2]));
    }
    if (start > end || start >= plan.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${plan.size}` });
      return res.end();
    }
    status = 206;
    head['Content-Range'] = `bytes ${start}-${end}/${plan.size}`;
  }
  head['Content-Length'] = end - start + 1;
  res.writeHead(status, head);
  if (req.method === 'HEAD') return res.end();
  // Files from before checksums were kept have theirs worked out the first time, and kept from then on.
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

// The file a video was made from is for the people who work on the board, not for whoever holds a link to it.
function withoutOriginal(it) {
  if (!it || it.orig === undefined) return it;
  const { orig, ...rest } = it;
  return rest;
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
    return sendJson(res, 200, { auth: auth.mode, user: req.user || null, admin: admin.allows(req), canShare: SHARING, maxUpload: MAX_UPLOAD, publicUrl: auth.publicUrl || null, shareBases: shareBases(), signOut: !!auth.interactive });
  }
  if (parts[1] === 'admin') return admin.handle(req, res, parts.slice(2));
  if (parts[1] === 'projects' || parts[1] === 'entities' || parts[1] === 'versions') return handleCatalogue(req, res, parts);
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
          if (parentId && projectOf(parentId) && holdsProject(folder)) return sendJson(res, 400, { error: 'A project cannot go inside another project' });
          folder.parentId = parentId;
        }
        // Marked as a project, a folder has a catalogue. Not inside another project, nor around one;
        // and once its catalogue has something in it, it stays a project.
        if ('project' in body && !!body.project !== !!folder.project) {
          if (body.project) {
            if (projectOf(folder.parentId) || holdsProject(folder)) return sendJson(res, 400, { error: 'A project cannot be inside another project, or hold one' });
            folder.project = true;
            folder.settings = cleanProjectSettings({ naming: naming.DEFAULT }, folder.settings);
          } else {
            if (store.entityCount(folder.id)) return sendJson(res, 409, { error: 'This project has a catalogue, so it stays a project' });
            folder.project = false;
          }
        }
        if ('settings' in body && folder.project) folder.settings = cleanProjectSettings(body.settings, folder.settings);
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
    const who = req.user ? req.user.name : cleanName(body.by, 'Somebody');
    const was = store.snapshot(board.id, Number(parts[4]));
    if (!was) return sendJson(res, 404, { error: 'That snapshot is not kept any more' });
    openItems(board);
    keepSnapshot(board, who, true);
    const next = new Map(was.map((it) => [it.id, it]));
    for (const it of next.values()) checkVer(it);
    for (const [id, it] of board.items) if (it.type !== 'comment' && !next.has(id)) board.removed.add(id);
    for (const id of next.keys()) {
      board.changed.add(id);
      board.removed.delete(id);
    }
    board.items = next;
    syncNotes(board);
    scheduleSave(board);
    note(board, who, 'restore');
    // Everybody on the board is given it afresh, as when they opened it.
    for (const peer of board.peers.values()) sendInit(board, peer);
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
      // Boards showing notes made here say where they were made, by name.
      if (applied.length) for (const other of boards.values()) if (other !== board && other.items && [...other.items.values()].some((it) => it.ob === board.id)) settle(other, Object.assign([], { resync: true, notes: new Set(), versions: new Set() }));
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
    const entityId = url.searchParams.get('entity');
    if (entityId) {
      const entity = store.entity(entityId);
      if (!entity || !fromOurPages(req)) return socket.destroy();
      const who = await auth.authenticate(req);
      if (who.status || !visibleFolder(who.user, entity.projectId)) return socket.destroy();
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
const hiddenNote = (board, c) => !!c && c.type === 'comment' && (board.shareAccess === 'view' || c.ob !== undefined);
const hiddenFromViewers = (board, op) => (op.t === 'add' ? hiddenNote(board, op.item) : op.t === 'set' && hiddenNote(board, board.items.get(op.id)));

// All that somebody commenting through a link can send: new comments and replies on what is there.
function guestOps(board, ops) {
  if (!Array.isArray(ops)) return [];
  return ops.filter((op) => op && op.t === 'add' && op.item && op.item.type === 'comment' && !board.items.has(op.item.id)
    && board.items.has(op.item.on) && board.items.get(op.item.on).type !== 'comment'
    && (!op.item.re || (board.items.get(op.item.re)?.type === 'comment' && !hiddenNote(board, board.items.get(op.item.re)))));
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
      const ops = msg.ops.filter((op) => !hiddenFromViewers(board, op))
        .map((op) => (op.t === 'add' ? { ...op, item: withoutOriginal(op.item) } : op.t === 'set' ? { ...op, patch: withoutOriginal(op.patch) } : op))
        .filter((op) => op.t !== 'set' || Object.keys(op.patch).length);
      viewerData = ops.length ? JSON.stringify({ ...msg, ops }) : null;
    }
    if (viewerData) peer.ws.send(viewerData);
  }
}

const VIEWER_COLORS = ['#8bb6e8', '#74c2b9', '#aa9ce6', '#e4c978', '#e090b8', '#82c79b'];

// The board as somebody is given it when they join, and again if it is put back to an older snapshot.
function sendInit(board, peer) {
  const access = board.shareAccess;
  const project = boardProject(board);
  send(peer.ws, peer.viewer ? {
    t: 'init',
    you: peer.id,
    board: { name: board.name, settings: board.settings || {} },
    access,
    items: [...board.items.values()].filter((it) => !hiddenNote(board, it)).map(withoutOriginal),
    versions: boardVersions(board),
    peers: [...board.peers.values()].filter((p) => p !== peer).map(publicPeer),
  } : {
    t: 'init',
    you: peer.id,
    board: { id: board.id, name: board.name, settings: board.settings || {} },
    project: project ? { id: project.id, name: project.name, naming: (project.settings && project.settings.naming) || naming.DEFAULT } : null,
    items: [...board.items.values()],
    versions: boardVersions(board),
    peers: [...board.peers.values()].filter((p) => p !== peer).map(publicPeer),
  });
}

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
        sendInit(board, peer);
        note(board, peer.name, 'link');
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
      sendInit(board, peer);
      note(board, peer.name, 'open');
      board.peers.set(peer.id, peer);
      broadcast(board, { t: 'join', peer: publicPeer(peer) }, peer);
      return;
    }
    if (!peer.joined) return;
    // A viewer may show a pointer and use the laser, and comment when the link allows it. Nothing else.
    if (peer.viewer && msg.t !== 'laser' && msg.t !== 'p' && !(msg.t === 'op' && board.shareAccess === 'comment')) return;

    if (msg.t === 'op') {
      // Housekeeping a browser does on opening a board is not somebody changing it.
      const counts = peer.viewer || msg.quiet !== true;
      if (counts) keepSnapshot(board, peer.name);
      const applied = applyOps(board, peer.viewer ? guestOps(board, msg.ops) : msg.ops, peer, counts);
      if (counts && applied.length) {
        const comments = applied.every((op) => (op.t === 'add' ? op.item.type === 'comment' : op.t === 'set' && board.items.get(op.id)?.type === 'comment'));
        note(board, peer.name, comments ? 'comment' : 'edit', applied.length);
      }
      // Always ack, even when nothing applied, so the sender's outbox stays in step.
      send(ws, { t: 'ack' });
      if (applied.length) broadcast(board, { t: 'op', ops: applied, from: peer.id }, peer);
      settle(board, applied);
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
      // On the board the points are where on the board; in the viewer, where on the open piece (`on`).
      const on = typeof msg.on === 'string' && ID_RE.test(msg.on) ? msg.on : undefined;
      if (pts.length >= 2) broadcast(board, { t: 'laser', id: peer.id, pts: pts.slice(0, pts.length - (pts.length % 2)), ...(on && { on }) }, peer);
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

// ---------------------------------------------------------------- the catalogue, live
//
// An asset, set or shot opened in the catalogue's viewer has a room of its own: everyone in it has all
// the notes on all its versions, live, and what they write there is there on every board the version
// is on, as what is written on those boards is there in the room. A note written in the catalogue was
// made on no board (its board is '').

const rooms = new Map(); // entity id -> Set of { ws, name, color, user }

function roomNotes(entityId) {
  const versions = store.versionsOf(entityId).map((v) => v.id);
  return store.notesOfVersions(versions).map((n) => ({
    ...noteData(n.data), id: n.id, type: 'comment', on: n.versionId, ...(n.re && { re: n.re }),
    ob: n.boardId, obn: n.boardId === '' ? 'the catalogue' : boards.get(n.boardId)?.name || n.boardName || 'a board',
  }));
}

function tellRoom(entityId) {
  const peers = rooms.get(entityId);
  if (!peers || !peers.size) return;
  const msg = { t: 'notes', notes: roomNotes(entityId) };
  for (const peer of peers) send(peer.ws, msg);
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
      peer.joined = true;
      if (!user) {
        peer.name = String(msg.name || 'Guest').slice(0, 32);
        if (/^#[0-9a-f]{6}$/i.test(msg.color)) peer.color = msg.color;
      }
      (rooms.get(entity.id) || rooms.set(entity.id, new Set()).get(entity.id)).add(peer);
      return send(ws, { t: 'init', notes: roomNotes(entity.id) });
    }
    if (!peer.joined || msg.t !== 'op' || !Array.isArray(msg.ops)) return;
    const touched = new Set();
    for (const op of msg.ops) {
      if (!op || typeof op !== 'object') continue;
      if (op.t === 'add' && op.item && ID_RE.test(op.item.id)) {
        const known = store.note(op.item.id);
        if (known) {
          // Undo bringing a deleted note back, as its author wrote it.
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
        for (const id of op.ids) {
          const n = typeof id === 'string' && store.note(id);
          if (!n || n.deletedAt || !ofEntity(n.versionId)) continue;
          store.deleteNote(n.id);
          touched.add(n.versionId);
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
  console.log(`Boards by Myreze is running. ${boards.size} board(s) loaded from ${DATA_DIR}. Sign-in: ${auth.mode}`);
  console.log(`  This machine:  http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) console.log(`  On the network: http://${net.address}:${PORT}`);
    }
  }
  console.log(`  By hostname:   http://${os.hostname()}:${PORT}`);
});
