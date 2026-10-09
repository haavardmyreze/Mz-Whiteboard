'use strict';

// Where boards, folders and the catalogue live: one SQLite file, data/wipboard.db.
//
// A board's items are stored one row each, so a change writes only what changed. Each row keeps the item
// exactly as the browser sent it (`data`) plus a few columns worked out from it (what it is called, which
// frame holds it, which uploaded file it shows). Those columns are what make questions across boards
// cheap, such as "every frame titled Desk" or "every board this file is on". They are derived from
// `data` when an item is written, never edited on their own.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

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
  throw new Error(`Boards by Myreze needs Node.js 22.13 or newer (this is ${process.version}). Install the current LTS from https://nodejs.org`);
} finally {
  process.emitWarning = emitWarning;
}

const SCHEMA = `
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

-- What has happened on a board, for the people on it to look back over: who opened it, who changed it.
-- The same thing done again within a few minutes is the same line, counted, not a new one.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  board_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  what TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS activity_by_board ON activity (board_id, at);

-- A board as it was before a round of changes, to go back to: everything on it, packed small. The
-- files themselves are not copied; they stay in uploads/ whatever happens to the board.
CREATE TABLE IF NOT EXISTS versions (
  board_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  who TEXT,
  count INTEGER NOT NULL,
  sig TEXT NOT NULL,
  items BLOB NOT NULL,
  PRIMARY KEY (board_id, at)
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
  created_at INTEGER NOT NULL,
  crc INTEGER
);

-- People, groups and who may do what, kept by the admin area. People are known by their sign-in email.
-- Grants are recorded here but not enforced yet: who sees what still follows the workspaces.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);

-- A person or a group, at a role, on one board or folder. One role per person or group per target.
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  UNIQUE (target_type, target_id, principal_type, principal_id)
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
  // Added later: a file's checksum, which a zip of it needs. Databases from before get the column here.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('media') WHERE name = 'crc'").get()) db.exec('ALTER TABLE media ADD COLUMN crc INTEGER');
  // And what a board is set to (see BOARD_SETTINGS in server.js), as JSON.
  if (!db.prepare("SELECT 1 FROM pragma_table_info('boards') WHERE name = 'settings'").get()) db.exec('ALTER TABLE boards ADD COLUMN settings TEXT');

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
    INSERT INTO boards (id, name, folder_id, workspace, share_token, share_access, share_expires, created_at, created_by, updated_at, settings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, folder_id = excluded.folder_id, workspace = excluded.workspace,
      share_token = excluded.share_token, share_access = excluded.share_access, share_expires = excluded.share_expires,
      updated_at = excluded.updated_at, settings = excluded.settings, deleted_at = NULL`);
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
    b.settings && Object.keys(b.settings).length ? JSON.stringify(b.settings) : null,
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
      settings: r.settings ? JSON.parse(r.settings) : {},
    }));
  }

  // ---------------------------------------------------------------- activity and versions

  const ACTIVITY_SAME = 10 * 60 * 1000; // the same person doing the same thing again within this is one line
  const ACTIVITY_KEPT = 300;            // lines kept for a board
  const VERSIONS_KEPT = 40;             // versions kept for a board
  const lastOfKind = db.prepare('SELECT id, at FROM activity WHERE board_id = ? AND who = ? AND what = ? ORDER BY at DESC, id DESC LIMIT 1');
  const addActivity = db.prepare('INSERT INTO activity (board_id, at, who, what, n) VALUES (?, ?, ?, ?, ?)');
  const bumpActivity = db.prepare('UPDATE activity SET at = ?, n = n + ? WHERE id = ?');
  const trimActivity = db.prepare('DELETE FROM activity WHERE board_id = ? AND id NOT IN (SELECT id FROM activity WHERE board_id = ? ORDER BY at DESC, id DESC LIMIT ?)');
  const readActivity = db.prepare('SELECT at, who, what, n FROM activity WHERE board_id = ? ORDER BY at DESC, id DESC LIMIT ?');
  function logActivity(boardId, who, what, n = 1, now = Date.now()) {
    const last = lastOfKind.get(boardId, who, what);
    if (last && now - last.at < ACTIVITY_SAME) return bumpActivity.run(now, n, last.id);
    addActivity.run(boardId, now, who, what, n);
    trimActivity.run(boardId, boardId, ACTIVITY_KEPT);
  }
  const activity = (boardId, limit = 200) => readActivity.all(boardId, limit);

  const putVersion = db.prepare('INSERT OR REPLACE INTO versions (board_id, at, who, count, sig, items) VALUES (?, ?, ?, ?, ?, ?)');
  const newestVersion = db.prepare('SELECT at, sig FROM versions WHERE board_id = ? ORDER BY at DESC LIMIT 1');
  const listVersions = db.prepare('SELECT at, who, count FROM versions WHERE board_id = ? ORDER BY at DESC');
  const readVersion = db.prepare('SELECT items FROM versions WHERE board_id = ? AND at = ?');
  const trimVersions = db.prepare('DELETE FROM versions WHERE board_id = ? AND at NOT IN (SELECT at FROM versions WHERE board_id = ? ORDER BY at DESC LIMIT ?)');
  // Keeps the board as it is now, unless that is exactly what was kept last. Says whether it did.
  function addVersion(boardId, list, who, count, now = Date.now()) {
    const json = JSON.stringify(list);
    const sig = crypto.createHash('sha1').update(json).digest('hex');
    const last = newestVersion.get(boardId);
    if (last && last.sig === sig) return false;
    putVersion.run(boardId, now, who || null, count, sig, zlib.gzipSync(json));
    trimVersions.run(boardId, boardId, VERSIONS_KEPT);
    return true;
  }
  const versions = (boardId) => listVersions.all(boardId);
  const lastVersionAt = (boardId) => newestVersion.get(boardId)?.at || 0;
  function version(boardId, at) {
    const row = readVersion.get(boardId, at);
    return row ? JSON.parse(zlib.gunzipSync(row.items).toString('utf8')) : null;
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

  // ---- people, groups and grants, for the admin area

  const userOf = (r) => ({ email: r.email, name: r.name, admin: !!r.admin, createdAt: r.created_at, lastSeenAt: r.last_seen_at });
  const readUsers = db.prepare('SELECT * FROM users ORDER BY lower(coalesce(name, email))');
  const users = () => readUsers.all().map(userOf);
  const readUser = db.prepare('SELECT * FROM users WHERE email = ?');
  const user = (email) => {
    const r = readUser.get(email);
    return r ? userOf(r) : null;
  };
  const putUser = db.prepare('INSERT INTO users (email, name, admin, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING');
  const addUser = ({ email, name = null, admin = false }) => putUser.run(email, name, admin ? 1 : 0, Date.now()).changes > 0;
  const putAdmin = db.prepare('UPDATE users SET admin = ? WHERE email = ?');
  const setAdmin = (email, admin) => putAdmin.run(admin ? 1 : 0, email).changes > 0;
  // Someone signed in: known from now on, under the name their sign-in gives.
  const putSeen = db.prepare(`INSERT INTO users (email, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (email) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`);
  const seeUser = (email, name, at = Date.now()) => putSeen.run(email, name, at, at);

  const readGroups = db.prepare('SELECT * FROM groups ORDER BY lower(name)');
  const readMembers = db.prepare('SELECT group_id, email FROM group_members ORDER BY email');
  function groups() {
    const members = new Map();
    for (const r of readMembers.all()) (members.get(r.group_id) || members.set(r.group_id, []).get(r.group_id)).push(r.email);
    return readGroups.all().map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, members: members.get(r.id) || [] }));
  }
  const putGroup = db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)');
  const addGroup = (id, name) => putGroup.run(id, name, Date.now());
  const putGroupName = db.prepare('UPDATE groups SET name = ? WHERE id = ?');
  const renameGroup = (id, name) => putGroupName.run(name, id).changes > 0;
  const putMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, email) VALUES (?, ?)');
  const addMember = (groupId, email) => putMember.run(groupId, email);
  const dropMember = db.prepare('DELETE FROM group_members WHERE group_id = ? AND email = ?');
  const removeMember = (groupId, email) => dropMember.run(groupId, email).changes > 0;

  const grantOf = (r) => ({
    id: r.id, target: { type: r.target_type, id: r.target_id }, principal: { type: r.principal_type, id: r.principal_id },
    role: r.role, createdAt: r.created_at, createdBy: r.created_by,
  });
  const readGrants = db.prepare('SELECT * FROM grants ORDER BY created_at');
  const grants = () => readGrants.all().map(grantOf);
  // Granting again to the same person or group on the same target changes their role.
  const putGrant = db.prepare(`INSERT INTO grants (id, target_type, target_id, principal_type, principal_id, role, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (target_type, target_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`);
  const readGrantFor = db.prepare('SELECT * FROM grants WHERE target_type = ? AND target_id = ? AND principal_type = ? AND principal_id = ?');
  function setGrant({ id, target, principal, role, by = null }) {
    putGrant.run(id, target.type, target.id, principal.type, principal.id, role, Date.now(), by);
    return grantOf(readGrantFor.get(target.type, target.id, principal.type, principal.id));
  }
  const dropGrant = db.prepare('DELETE FROM grants WHERE id = ?');
  const removeGrant = (id) => dropGrant.run(id).changes > 0;
  const dropTargetGrants = db.prepare('DELETE FROM grants WHERE target_type = ? AND target_id = ?');
  const removeGrantsOn = (type, id) => dropTargetGrants.run(type, id);
  const dropPrincipalGrants = db.prepare('DELETE FROM grants WHERE principal_type = ? AND principal_id = ?');

  // Whoever or whatever goes takes their memberships and grants with them.
  const dropUser = db.prepare('DELETE FROM users WHERE email = ?');
  const dropMemberships = db.prepare('DELETE FROM group_members WHERE email = ?');
  const removeUser = (email) => transaction(() => {
    dropMemberships.run(email);
    dropPrincipalGrants.run('user', email);
    return dropUser.run(email).changes > 0;
  });
  const dropGroup = db.prepare('DELETE FROM groups WHERE id = ?');
  const dropGroupMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?');
  const removeGroup = (id) => transaction(() => {
    dropGroupMembers.run(id);
    dropPrincipalGrants.run('group', id);
    return dropGroup.run(id).changes > 0;
  });

  const putMedia = db.prepare('INSERT OR IGNORE INTO media (name, kind, size, uploaded_by, created_at, crc) VALUES (?, ?, ?, ?, ?, ?)');
  const addMedia = ({ name, size, by = null, crc = null }) => putMedia.run(name, VIDEO_EXT.test(name) ? 'video' : 'image', size ?? null, by, Date.now(), crc);
  const putCrc = db.prepare('UPDATE media SET crc = ? WHERE name = ?');
  const setMediaCrc = (name, crc) => putCrc.run(crc, name);
  const readMedia = db.prepare('SELECT * FROM media WHERE name = ?');
  const media = (name) => readMedia.get(name) || null;

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

  return {
    saveBoard, boards, loadItems, summaries, deleteBoard, deletedBoards, restoreBoard, folders, saveFolders, addMedia, media, setMediaCrc, logActivity, activity, addVersion, versions, version, lastVersionAt,
    find, commentsForNotices, getState, setState, backup, close, isOpen: () => !closed,
    users, user, addUser, setAdmin, seeUser, removeUser, groups, addGroup, renameGroup, removeGroup, addMember, removeMember,
    grants, setGrant, removeGrant, removeGrantsOn,
  };
}

module.exports = { openStore };
