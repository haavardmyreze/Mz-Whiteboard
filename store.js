'use strict';

// Where boards, folders and the catalogue live: one SQLite file, data/wipboard.db.
//
// A board's items are stored one row each, so a change writes only what changed. Each row keeps the item
// exactly as the browser sent it (`data`) plus a few columns worked out from it (what it is called, which
// frame holds it, which uploaded file it shows). Those columns are what make questions across boards
// cheap, such as "every frame titled Desk" or "every board this file is on". They are derived, never
// edited: to catalogue something new, add a column to `derive` and raise DERIVE_VERSION, and every item
// is worked out again on the next start.

const fs = require('fs');
const path = require('path');

// node:sqlite prints an "experimental" notice on Node 22. It is what this app relies on, and the notice
// would only worry whoever reads the server window, so that one notice is left out.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite/.test(String((warning && warning.message) || warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  throw new Error(`Wipboard needs Node.js 22.13 or newer (this is ${process.version}). Install the current LTS from https://nodejs.org`);
} finally {
  process.emitWarning = emitWarning;
}

const SCHEMA_VERSION = 1;
const DERIVE_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id TEXT,
  workspace TEXT NOT NULL,
  share_token TEXT UNIQUE,
  share_access TEXT,
  share_expires INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  board_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT,
  label_key TEXT,
  frame_id TEXT,
  parent_id TEXT,
  media TEXT,
  thumb TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, id)
);
CREATE INDEX IF NOT EXISTS items_by_label ON items (type, label_key);
CREATE INDEX IF NOT EXISTS items_by_frame ON items (board_id, frame_id);
CREATE INDEX IF NOT EXISTS items_by_parent ON items (board_id, parent_id);
CREATE INDEX IF NOT EXISTS items_by_media ON items (media);

CREATE VIRTUAL TABLE IF NOT EXISTS items_text USING fts5 (label, content = 'items', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS items_text_add AFTER INSERT ON items WHEN new.label IS NOT NULL BEGIN
  INSERT INTO items_text (rowid, label) VALUES (new.rowid, new.label);
END;
CREATE TRIGGER IF NOT EXISTS items_text_del AFTER DELETE ON items WHEN old.label IS NOT NULL BEGIN
  INSERT INTO items_text (items_text, rowid, label) VALUES ('delete', old.rowid, old.label);
END;
CREATE TRIGGER IF NOT EXISTS items_text_set AFTER UPDATE OF label ON items BEGIN
  INSERT INTO items_text (items_text, rowid, label) SELECT 'delete', old.rowid, old.label WHERE old.label IS NOT NULL;
  INSERT INTO items_text (rowid, label) SELECT new.rowid, new.label WHERE new.label IS NOT NULL;
END;

-- Small things kept per person, such as which notifications they have read.
CREATE TABLE IF NOT EXISTS user_state (
  user TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (user, key)
);

CREATE TABLE IF NOT EXISTS media (
  name TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  size INTEGER,
  original_name TEXT,
  width INTEGER,
  height INTEGER,
  duration REAL,
  fps REAL,
  uploaded_by TEXT,
  created_at INTEGER NOT NULL
);
`;

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const UPLOAD_NAME = /^\/uploads\/([\w-]+\.[a-z0-9]+)$/i;

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v) => (Number.isFinite(v) ? v : null);
// How a name is compared: case and spacing do not matter, so "Desk", "desk " and "DESK" are one name.
const nameKey = (v) => (v ? v.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim() : null);
const uploadName = (src) => (typeof src === 'string' && UPLOAD_NAME.exec(src)?.[1]) || null;

// The columns worked out from an item. `label` is what a person would call it or search it by.
function derive(it) {
  let label = null;
  if (it.type === 'frame') label = text(it.title);
  else if (it.type === 'image' || it.type === 'video') label = text(it.name);
  else if (it.type === 'note' || it.type === 'text' || it.type === 'block' || it.type === 'comment') label = text(it.text);
  return {
    type: String(it.type),
    label,
    label_key: nameKey(label),
    frame_id: typeof it.fid === 'string' ? it.fid : null,
    // What it belongs to: the image or video a drawing or note was made on, or the content a comment is on.
    parent_id: typeof it.pid === 'string' ? it.pid : typeof it.on === 'string' ? it.on : null,
    media: it.type === 'image' || it.type === 'video' ? uploadName(it.src) : null,
    // The small still the board list shows for it.
    thumb: typeof it.th === 'string' ? it.th : it.type === 'image' && typeof (it.prev || it.src) === 'string' ? it.prev || it.src : null,
  };
}

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'wipboard.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  if (!getMeta.get('schema')) setMeta.run('schema', String(SCHEMA_VERSION));

  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const putBoard = db.prepare(`
    INSERT INTO boards (id, name, folder_id, workspace, share_token, share_access, share_expires, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, folder_id = excluded.folder_id, workspace = excluded.workspace,
      share_token = excluded.share_token, share_access = excluded.share_access, share_expires = excluded.share_expires,
      updated_at = excluded.updated_at, deleted_at = NULL`);
  const putItem = db.prepare(`
    INSERT INTO items (board_id, id, data, type, label, label_key, frame_id, parent_id, media, thumb, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (board_id, id) DO UPDATE SET data = excluded.data, type = excluded.type, label = excluded.label,
      label_key = excluded.label_key, frame_id = excluded.frame_id, parent_id = excluded.parent_id, media = excluded.media,
      thumb = excluded.thumb, updated_at = excluded.updated_at`);
  const dropItem = db.prepare('DELETE FROM items WHERE board_id = ? AND id = ?');
  // What the board learns about a file fills in what the upload alone could not say, and never overwrites.
  const learnMedia = db.prepare(`
    UPDATE media SET original_name = coalesce(original_name, ?), width = coalesce(width, ?), height = coalesce(height, ?),
      duration = coalesce(duration, ?), fps = coalesce(fps, ?) WHERE name = ?`);

  function writeItem(boardId, it, by, now) {
    const d = derive(it);
    putItem.run(boardId, it.id, JSON.stringify(it), d.type, d.label, d.label_key, d.frame_id, d.parent_id, d.media, d.thumb, now, by || null, now);
    if (d.media) learnMedia.run(text(it.name), num(it.nw), num(it.nh), num(it.dur), num(it.fps), d.media);
  }

  const boardValues = (b) => [
    b.id, b.name, b.folderId || null, b.workspace, b.shareToken || null, b.shareAccess || null, b.shareExpires || null, b.createdAt, b.createdBy || null, b.updatedAt,
  ];

  // A board's details, and the items that changed and went since it was last written, in one go.
  function saveBoard(board, changed = [], removed = [], creators = new Map()) {
    const now = Date.now();
    transaction(() => {
      putBoard.run(...boardValues(board));
      for (const id of removed) dropItem.run(board.id, id);
      for (const it of changed) writeItem(board.id, it, creators.get(it.id), now);
    });
  }

  const readBoards = db.prepare('SELECT * FROM boards WHERE deleted_at IS NULL');
  function boards() {
    return readBoards.all().map((r) => ({
      id: r.id, name: r.name, folderId: r.folder_id, workspace: r.workspace, shareToken: r.share_token, shareAccess: r.share_access,
      shareExpires: r.share_expires, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at,
    }));
  }

  const readItems = db.prepare('SELECT data FROM items WHERE board_id = ? ORDER BY rowid');
  const loadItems = (boardId) => readItems.all(boardId).map((r) => JSON.parse(r.data));

  // What the board list shows for boards nobody has open: how many things are on each, and its first stills.
  const readCounts = db.prepare("SELECT board_id, count(*) AS n FROM items WHERE type NOT IN ('comment', 'stroke') GROUP BY board_id");
  const readThumbs = db.prepare(`
    SELECT board_id, thumb FROM (
      SELECT board_id, thumb, row_number() OVER (PARTITION BY board_id ORDER BY rowid) AS n FROM items WHERE thumb IS NOT NULL
    ) WHERE n <= 4 ORDER BY board_id, n`);
  function summaries() {
    const out = new Map();
    const of = (id) => out.get(id) || out.set(id, { count: 0, thumbs: [] }).get(id);
    for (const r of readCounts.all()) of(r.board_id).count = r.n;
    for (const r of readThumbs.all()) of(r.board_id).thumbs.push(r.thumb);
    return out;
  }

  // Deleting a board keeps it, out of sight: `node scripts/restore-board.js` lists deleted boards and brings one back.
  const markDeleted = db.prepare('UPDATE boards SET deleted_at = ?, share_token = NULL WHERE id = ?');
  const deleteBoard = (id) => markDeleted.run(Date.now(), id);
  const readDeleted = db.prepare('SELECT id, name, deleted_at FROM boards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
  const deletedBoards = () => readDeleted.all().map((r) => ({ id: r.id, name: r.name, deletedAt: r.deleted_at }));
  // Back at the top level, since its folder may have gone since.
  const unmark = db.prepare('UPDATE boards SET deleted_at = NULL, folder_id = NULL WHERE id = ? AND deleted_at IS NOT NULL');
  const restoreBoard = (id) => unmark.run(id).changes > 0;

  const readFolders = db.prepare('SELECT * FROM folders');
  const folders = () => readFolders.all().map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, workspace: r.workspace, createdAt: r.created_at }));
  const clearFolders = db.prepare('DELETE FROM folders');
  const putFolder = db.prepare('INSERT INTO folders (id, name, parent_id, workspace, created_at) VALUES (?, ?, ?, ?, ?)');
  // The whole tree at once: it is small, and changes to it come one click at a time.
  function saveFolders(list) {
    transaction(() => {
      clearFolders.run();
      for (const f of list) putFolder.run(f.id, f.name, f.parentId || null, f.workspace, f.createdAt);
    });
  }

  const putMedia = db.prepare('INSERT OR IGNORE INTO media (name, kind, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const addMedia = ({ name, size, by = null, at = Date.now() }) => putMedia.run(name, VIDEO_EXT.test(name) ? 'video' : 'image', size ?? null, by, at);
  const readMedia = db.prepare('SELECT * FROM media WHERE name = ?');
  const media = (name) => readMedia.get(name) || null;
  const readMediaNames = db.prepare('SELECT name FROM media');

  // Every stored file has a row, including those uploaded before there was a catalogue.
  function catalogueUploads(uploadDir) {
    const known = new Set(readMediaNames.all().map((r) => r.name));
    const missing = [];
    for (const name of fs.readdirSync(uploadDir)) {
      if (known.has(name) || name.startsWith('.') || !UPLOAD_NAME.test(`/uploads/${name}`)) continue;
      try {
        const st = fs.statSync(path.join(uploadDir, name));
        if (st.isFile()) missing.push({ name, size: st.size, at: Math.round(st.mtimeMs) });
      } catch {
        // gone already
      }
    }
    if (!missing.length) return 0;
    transaction(() => {
      for (const m of missing) addMedia(m);
      // Fill in what the boards already know about them.
      for (const r of db.prepare("SELECT data FROM items WHERE media IS NOT NULL").all()) {
        const it = JSON.parse(r.data);
        learnMedia.run(text(it.name), num(it.nw), num(it.nh), num(it.dur), num(it.fps), uploadName(it.src));
      }
    });
    return missing.length;
  }

  // After `derive` learns something new, every item is worked out again from what was stored.
  function rederive() {
    if (Number(getMeta.get('derive')?.value) === DERIVE_VERSION) return 0;
    const rows = db.prepare('SELECT board_id, id, data FROM items').all();
    const update = db.prepare(`UPDATE items SET type = ?, label = ?, label_key = ?, frame_id = ?, parent_id = ?, media = ?, thumb = ?
      WHERE board_id = ? AND id = ?`);
    transaction(() => {
      for (const r of rows) {
        const d = derive(JSON.parse(r.data));
        update.run(d.type, d.label, d.label_key, d.frame_id, d.parent_id, d.media, d.thumb, r.board_id, r.id);
      }
      setMeta.run('derive', String(DERIVE_VERSION));
    });
    return rows.length;
  }

  // Boards and folders from before the database, data/boards/*.json and data/folders.json, are read in
  // once and their files moved to data/legacy, where they stay as they were.
  function importLegacy({ boardDir, folderFile, legacyDir, clean }) {
    let imported = 0;
    const files = fs.existsSync(boardDir) ? fs.readdirSync(boardDir).filter((f) => f.endsWith('.json')) : [];
    const hasFolders = fs.existsSync(folderFile);
    if (!files.length && !hasFolders) return 0;
    fs.mkdirSync(path.join(legacyDir, 'boards'), { recursive: true });
    const known = db.prepare('SELECT 1 FROM boards WHERE id = ?');
    for (const name of files) {
      const from = path.join(boardDir, name);
      let board;
      try {
        board = clean.board(JSON.parse(fs.readFileSync(from, 'utf8')));
      } catch (err) {
        console.error(`Skipping unreadable board file ${name}: ${err.message}`);
        continue;
      }
      if (!board) continue;
      if (!known.get(board.id)) {
        saveBoard(board, board.items);
        imported++;
      }
      fs.renameSync(from, path.join(legacyDir, 'boards', name));
    }
    if (hasFolders) {
      try {
        if (!folders().length) saveFolders(clean.folders(JSON.parse(fs.readFileSync(folderFile, 'utf8'))));
        fs.renameSync(folderFile, path.join(legacyDir, 'folders.json'));
      } catch (err) {
        console.error(`Could not read folders.json: ${err.message}`);
      }
    }
    return imported;
  }

  // ---------------------------------------------------------------- catalogue

  // Items across every board someone can see, narrowed by any of:
  //   type     one type or several ("image,video")
  //   name     what it is called, exactly, ignoring case and spacing ("Desk" finds a frame titled "desk")
  //   q        words anywhere in what it is called or says; the last word may be the start of one
  //   in       only items inside a frame called this (same matching as `name`)
  //   media    only items showing this uploaded file
  //   board    only this board
  function find({ spaces, type, name, q, inFrame, media: file, board, limit = 200 }) {
    const where = ['b.deleted_at IS NULL', `b.workspace IN (${spaces.map(() => '?').join(', ')})`];
    const args = [...spaces];
    const types = String(type || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (types.length) {
      where.push(`i.type IN (${types.map(() => '?').join(', ')})`);
      args.push(...types);
    }
    if (name) {
      where.push('i.label_key = ?');
      args.push(nameKey(name));
    }
    if (inFrame) {
      where.push("f.type = 'frame' AND f.label_key = ?");
      args.push(nameKey(inFrame));
    }
    if (file) {
      where.push('i.media = ?');
      args.push(file);
    }
    if (board) {
      where.push('i.board_id = ?');
      args.push(board);
    }
    if (q) {
      const words = String(q).match(/[\p{L}\p{N}_]+/gu) || [];
      if (!words.length) return [];
      where.push('i.rowid IN (SELECT rowid FROM items_text WHERE items_text MATCH ?)');
      args.push(words.map((w, n) => `"${w}"${n === words.length - 1 ? '*' : ''}`).join(' '));
    }
    const rows = db.prepare(`
      SELECT i.data, i.created_at, i.created_by, i.updated_at, b.id AS board_id, b.name AS board_name, b.folder_id, b.workspace,
        f.id AS frame_id, f.label AS frame_title
      FROM items i JOIN boards b ON b.id = i.board_id
      LEFT JOIN items f ON f.board_id = i.board_id AND f.id = i.frame_id
      WHERE ${where.join(' AND ')}
      ORDER BY b.updated_at DESC, i.rowid
      LIMIT ?`).all(...args, Math.max(1, Math.min(1000, Number(limit) || 200)));
    return rows.map((r) => ({
      board: { id: r.board_id, name: r.board_name, folderId: r.folder_id, workspace: r.workspace },
      frame: r.frame_id ? { id: r.frame_id, title: r.frame_title } : null,
      item: JSON.parse(r.data),
      createdAt: r.created_at,
      createdBy: r.created_by,
      updatedAt: r.updated_at,
    }));
  }

  // ---------------------------------------------------------------- notifications

  // Every comment on the boards in these workspaces that have had one since `since`, with what each is on
  // and who made that, and who made the board. Older comments on those boards come too: a new reply
  // needs the thread it is in.
  function commentsForNotices(spaces, since) {
    const list = spaces.map(() => '?').join(', ');
    return db.prepare(`
      SELECT c.data, c.created_at, b.id AS board_id, b.name AS board_name, b.created_by AS board_by,
        h.created_by AS host_by, h.type AS host_type, h.label AS host_label
      FROM items c JOIN boards b ON b.id = c.board_id
      LEFT JOIN items h ON h.board_id = c.board_id AND h.id = c.parent_id
      WHERE c.type = 'comment' AND b.deleted_at IS NULL AND b.workspace IN (${list})
        AND c.board_id IN (SELECT board_id FROM items WHERE type = 'comment' AND created_at > ?)`).all(...spaces, since)
      .map((r) => ({ ...r, comment: JSON.parse(r.data) }));
  }

  const readState = db.prepare('SELECT value FROM user_state WHERE user = ? AND key = ?');
  const writeState = db.prepare('INSERT INTO user_state (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value');
  const getState = (user, key) => {
    const row = readState.get(user, key);
    return row ? JSON.parse(row.value) : null;
  };
  const setState = (user, key, value) => writeState.run(user, key, JSON.stringify(value));

  // A copy of the whole database, safe to take while the server runs. Keeps the newest `keep` of them.
  function backup(dir, keep = 7) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `wipboard-${stamp}.db`);
    if (fs.existsSync(target)) return null;
    db.prepare('VACUUM INTO ?').run(target);
    const old = fs.readdirSync(dir).filter((f) => /^wipboard-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(keep);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
    return target;
  }

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    db.close();
  }

  rederive();

  return {
    file, saveBoard, boards, loadItems, summaries, deleteBoard, deletedBoards, restoreBoard, folders, saveFolders, addMedia, media,
    catalogueUploads, importLegacy, find, commentsForNotices, getState, setState, backup, close, isOpen: () => !closed,
  };
}

module.exports = { openStore, derive, nameKey };
