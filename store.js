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
-- A folder marked as a project (project = 1) owns a catalogue: the entities below. Its settings are what
-- the project is set to, as JSON, such as which naming preset its files are read by.
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  workspace TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  project INTEGER NOT NULL DEFAULT 0,
  settings TEXT
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
  deleted_at INTEGER,
  settings TEXT
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
-- files themselves are not copied; they stay in uploads/ whatever happens to the board. Notes are not
-- in it either: putting a board back moves what is on it, never what was said.
CREATE TABLE IF NOT EXISTS snapshots (
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
  version_id TEXT,
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

-- The catalogue of a project. An entity is an asset, a set or a shot; every version belongs to one. It
-- can be there before anything is filed of it. artists and cc are names (JSON arrays): who makes it, and
-- who else follows it.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  artists TEXT,
  cc TEXT,
  UNIQUE (project_id, name)
);

-- The names in each entity's artists and cc, one row each and in lower case, so that "everything this
-- person works on or follows" is a lookup rather than a search through every entity. Kept in step with
-- the entities' own lists whenever those change.
CREATE TABLE IF NOT EXISTS entity_people (
  entity_id TEXT NOT NULL,
  role TEXT NOT NULL,
  name_key TEXT NOT NULL,
  PRIMARY KEY (entity_id, role, name_key)
);
CREATE INDEX IF NOT EXISTS entity_people_by_name ON entity_people (name_key);

-- A version: one file filed under an entity, and a task if the project uses them. The number counts the
-- versions of that entity and task in the order they were filed (a version with no task has '' for
-- it, never NULL, so that the number is unique there too); hip is a version number read from
-- the file's name, kept only as a label. Its look is what a board needs to show the file (its address,
-- stills, size, length), as JSON. An archived version (hidden) is kept out of the catalogue's way; a
-- deleted one is marked, never removed, so its number is not given out again and it can be brought back.
-- (One taken back straight after it was filed from a board is removed: it never was; see unfileVersion.)
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  number INTEGER NOT NULL,
  descriptor TEXT,
  artist TEXT,
  hip INTEGER,
  media TEXT,
  thumb TEXT,
  kind TEXT NOT NULL,
  original_name TEXT,
  look TEXT NOT NULL,
  board_id TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  UNIQUE (entity_id, task, number)
);
CREATE INDEX IF NOT EXISTS versions_by_entity ON versions (entity_id, task, number);
CREATE INDEX IF NOT EXISTS versions_by_filer ON versions (lower(created_by));

-- What people say about the work. A note belongs to a version, so it is there on every board the
-- version is on, or, while a piece of media is not filed as a version, to that piece on its board.
-- board_id and item_id are where it was made; data is the note as the boards show it (its text,
-- who wrote it, the frame it is about, whether it is resolved). A deleted note is kept, marked, so that
-- undo can bring it back as its author wrote it.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  version_id TEXT,
  re TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS notes_by_version ON notes (version_id);
CREATE INDEX IF NOT EXISTS notes_by_item ON notes (board_id, item_id);
CREATE INDEX IF NOT EXISTS notes_by_thread ON notes (re);
CREATE INDEX IF NOT EXISTS notes_by_time ON notes (created_at);

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
  crc INTEGER,
  phone TEXT
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

-- A playlist: some of a project's versions, in the order they are to be looked at, as a review is run
-- through them one after another (as in ShotGrid). versions is their ids, as JSON, in that order; a
-- version deleted since is left out when the list is read.
-- One outside any project (project_id is '') is kept in a workspace and folder like a board, and its
-- versions are the files uploaded to it, filed under an entity of its own (entity_id), whose project_id
-- is the playlist's id, so that comments, numbers and the player work as they do for a project's.
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  versions TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  workspace TEXT,
  folder_id TEXT,
  entity_id TEXT
);
CREATE INDEX IF NOT EXISTS playlists_by_project ON playlists (project_id);

-- An animatic: an edit of a project's shots on tracks, played through as the cut is. doc is the whole edit as
-- JSON (its rate and shape, its tracks, its clips; see cleanAnimatic in server.js). Its clips name shots, not
-- versions, so it always plays their newest. rev counts its saves: a save made from an older one is refused.
-- folder_id is the folder of the project's reviews it is kept in (null: at the top of them), as a playlist's is.
CREATE TABLE IF NOT EXISTS animatics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  doc TEXT NOT NULL,
  rev INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  folder_id TEXT
);
CREATE INDEX IF NOT EXISTS animatics_by_project ON animatics (project_id);

-- A link to watch somebody present a project: whoever opens it sees what they show, as they show it, and
-- nothing else. One per person per project, so the same link can be sent ahead of every review. The owner
-- is who presents: their sign-in's id, or where nobody signs in, the name they go by.
CREATE TABLE IF NOT EXISTS presentations (
  token TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  owner_name TEXT,
  access TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, owner)
);
`;

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac)$/i;
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
    // The catalogue version it shows, when it is one.
    version_id: typeof it.ver === 'string' ? it.ver : null,
  };
}

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'wipboard.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Playlists and animatics made before they could be kept in folders lack the columns that place them.
  for (const [table, column] of [['playlists', 'workspace'], ['playlists', 'folder_id'], ['playlists', 'entity_id'], ['animatics', 'folder_id']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
  }

  // One write, all or nothing. Called again from inside one (filing several versions at once, say), it
  // is part of the outer one: whatever goes wrong anywhere undoes all of it.
  let depth = 0;
  function transaction(fn) {
    if (depth) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      depth = 0;
    }
  }

  const putBoard = db.prepare(`
    INSERT INTO boards (id, name, folder_id, workspace, share_token, share_access, share_expires, created_at, created_by, updated_at, settings)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, folder_id = excluded.folder_id, workspace = excluded.workspace,
      share_token = excluded.share_token, share_access = excluded.share_access, share_expires = excluded.share_expires,
      updated_at = excluded.updated_at, settings = excluded.settings, deleted_at = NULL`);
  const putItem = db.prepare(`
    INSERT INTO items (board_id, id, data, type, label, label_key, frame_id, parent_id, media, thumb, created_at, created_by, updated_at, version_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (board_id, id) DO UPDATE SET data = excluded.data, type = excluded.type, label = excluded.label,
      label_key = excluded.label_key, frame_id = excluded.frame_id, parent_id = excluded.parent_id, media = excluded.media,
      thumb = excluded.thumb, updated_at = excluded.updated_at, version_id = excluded.version_id`);
  const dropItem = db.prepare('DELETE FROM items WHERE board_id = ? AND id = ?');
  // What the board learns about a file fills in what the upload alone could not say, and never overwrites.
  const learnMedia = db.prepare(`
    UPDATE media SET original_name = coalesce(original_name, ?), width = coalesce(width, ?), height = coalesce(height, ?),
      duration = coalesce(duration, ?), fps = coalesce(fps, ?) WHERE name = ?`);

  function writeItem(boardId, it, by, now) {
    const d = derive(it);
    putItem.run(boardId, it.id, JSON.stringify(it), d.type, d.label, d.label_key, d.frame_id, d.parent_id, d.media, d.thumb, now, by || null, now, d.version_id);
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
      // Notes are kept apart (see below), whatever the board holds of them to show.
      for (const it of changed) if (it.type !== 'comment') writeItem(board.id, it, creators.get(it.id), now);
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

  // ---------------------------------------------------------------- activity and snapshots

  const ACTIVITY_SAME = 10 * 60 * 1000; // the same person doing the same thing again within this is one line
  const ACTIVITY_KEPT = 300;            // lines kept for a board
  const SNAPSHOTS_KEPT = 40;            // snapshots kept for a board
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

  const putSnapshot = db.prepare('INSERT OR REPLACE INTO snapshots (board_id, at, who, count, sig, items) VALUES (?, ?, ?, ?, ?, ?)');
  const newestSnapshot = db.prepare('SELECT at, sig FROM snapshots WHERE board_id = ? ORDER BY at DESC LIMIT 1');
  const listSnapshots = db.prepare('SELECT at, who, count FROM snapshots WHERE board_id = ? ORDER BY at DESC');
  const readSnapshot = db.prepare('SELECT items FROM snapshots WHERE board_id = ? AND at = ?');
  const trimSnapshots = db.prepare('DELETE FROM snapshots WHERE board_id = ? AND at NOT IN (SELECT at FROM snapshots WHERE board_id = ? ORDER BY at DESC LIMIT ?)');
  // Keeps the board as it is now, unless that is exactly what was kept last. Says whether it did.
  // Notes are left out: they are not the board's to put back.
  function addSnapshot(boardId, list, who, count, now = Date.now()) {
    const json = JSON.stringify(list.filter((it) => it.type !== 'comment'));
    const sig = crypto.createHash('sha1').update(json).digest('hex');
    const last = newestSnapshot.get(boardId);
    if (last && last.sig === sig) return false;
    putSnapshot.run(boardId, now, who || null, count, sig, zlib.gzipSync(json));
    trimSnapshots.run(boardId, boardId, SNAPSHOTS_KEPT);
    return true;
  }
  const snapshots = (boardId) => listSnapshots.all(boardId);
  const lastSnapshotAt = (boardId) => newestSnapshot.get(boardId)?.at || 0;
  function snapshot(boardId, at) {
    const row = readSnapshot.get(boardId, at);
    return row ? JSON.parse(zlib.gunzipSync(row.items).toString('utf8')) : null;
  }

  const readItems = db.prepare('SELECT data FROM items WHERE board_id = ? ORDER BY rowid');
  // An item that cannot be read is left out (and said so), rather than keep the whole board from opening.
  const loadItems = (boardId) => readItems.all(boardId).flatMap((r) => {
    try {
      return [JSON.parse(r.data)];
    } catch {
      console.error(`An item on board ${boardId} could not be read, so it is left out.`);
      return [];
    }
  });

  // What the board list shows for boards nobody has open: how many things are on each, and its first stills.
  const readCounts = db.prepare("SELECT board_id, count(*) AS n FROM items WHERE type != 'stroke' GROUP BY board_id");
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

  // ---- a project deleted (by an admin): its catalogue goes with it, every version and what was said about
  // them, its playlists, animatics and links to present it. Its boards are deleted as boards are (server.js).
  const dropProject = [
    'DELETE FROM notes WHERE version_id IN (SELECT v.id FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ?)',
    'DELETE FROM versions WHERE entity_id IN (SELECT id FROM entities WHERE project_id = ?)',
    'DELETE FROM entity_people WHERE entity_id IN (SELECT id FROM entities WHERE project_id = ?)',
    'DELETE FROM entities WHERE project_id = ?',
    'DELETE FROM playlists WHERE project_id = ?',
    'DELETE FROM animatics WHERE project_id = ?',
    'DELETE FROM presentations WHERE project_id = ?',
  ].map((q) => db.prepare(q));
  const deleteProject = (id) => transaction(() => { for (const q of dropProject) q.run(id); });

  // ---- links to watch a project being presented

  const presentationOf = (r) => ({ token: r.token, projectId: r.project_id, owner: r.owner, ownerName: r.owner_name, access: r.access, expiresAt: r.expires_at, createdAt: r.created_at });
  const readPresentations = db.prepare('SELECT * FROM presentations');
  const presentations = () => readPresentations.all().map(presentationOf);
  const putPresentation = db.prepare(`INSERT INTO presentations (token, project_id, owner, owner_name, access, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token) DO UPDATE SET owner_name = excluded.owner_name, access = excluded.access, expires_at = excluded.expires_at`);
  const savePresentation = (p) => putPresentation.run(p.token, p.projectId, p.owner, p.ownerName || null, p.access, p.expiresAt || null, p.createdAt);
  const dropPresentation = db.prepare('DELETE FROM presentations WHERE token = ?');
  const deletePresentation = (token) => dropPresentation.run(token).changes > 0;

  // ---- playlists

  // projectId is '' for a playlist outside any project, which has a workspace, a folder (or none: the top
  // level) and the entity its versions are filed under instead.
  const playlistOf = (r) => ({
    id: r.id, projectId: r.project_id, name: r.name, versions: JSON.parse(r.versions), createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at,
    workspace: r.workspace, folderId: r.folder_id, entityId: r.entity_id,
  });
  const readPlaylists = db.prepare('SELECT * FROM playlists WHERE project_id = ? ORDER BY updated_at DESC');
  const playlists = (projectId) => readPlaylists.all(projectId).map(playlistOf);
  const loosePlaylists = () => playlists('');
  const readPlaylist = db.prepare('SELECT * FROM playlists WHERE id = ?');
  const playlist = (id) => {
    const r = readPlaylist.get(id);
    return r ? playlistOf(r) : null;
  };
  const putPlaylist = db.prepare('INSERT INTO playlists (id, project_id, name, versions, created_at, created_by, updated_at, workspace, folder_id, entity_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  function addPlaylist({ id, projectId = '', name, versions = [], workspace = null, folderId = null, by = null, at = Date.now() }) {
    return transaction(() => {
      // One outside a project files its versions under an entity of its own, named as it is.
      const entity = projectId ? null : addEntity({ id: `${id}e`, projectId: id, type: 'asset', name, by });
      putPlaylist.run(id, projectId, name, JSON.stringify(versions), at, by, at, workspace, folderId, entity ? entity.id : null);
      return playlist(id);
    });
  }
  const updatePlaylist = db.prepare('UPDATE playlists SET name = ?, versions = ?, workspace = ?, folder_id = ?, updated_at = ? WHERE id = ?');
  // Renamed, moved (one outside a project), or its versions given anew (in their new order); what is left
  // out stays as it was. A moved one's `folderId` may be null: the top of its workspace.
  function setPlaylist(id, { name, versions, workspace, folderId } = {}, at = Date.now()) {
    const p = playlist(id);
    if (!p) return null;
    transaction(() => {
      updatePlaylist.run(name ?? p.name, JSON.stringify(versions ?? p.versions), workspace ?? p.workspace, folderId !== undefined ? folderId : p.folderId, at, id);
      if (name && name !== p.name && p.entityId) setEntity(p.entityId, { name });
    });
    return playlist(id);
  }
  const dropPlaylist = db.prepare('DELETE FROM playlists WHERE id = ?');
  const deletePlaylist = (id) => dropPlaylist.run(id).changes > 0;

  // ---- animatics

  const animaticOf = (r) => ({
    id: r.id, projectId: r.project_id, name: r.name, doc: JSON.parse(r.doc), rev: r.rev,
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by, folderId: r.folder_id,
  });
  const readAnimatics = db.prepare('SELECT * FROM animatics WHERE project_id = ? ORDER BY updated_at DESC');
  const animatics = (projectId) => readAnimatics.all(projectId).map(animaticOf);
  const readAnimatic = db.prepare('SELECT * FROM animatics WHERE id = ?');
  const animatic = (id) => {
    const r = readAnimatic.get(id);
    return r ? animaticOf(r) : null;
  };
  const putAnimatic = db.prepare('INSERT INTO animatics (id, project_id, name, doc, rev, created_at, created_by, updated_at, updated_by, folder_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)');
  function addAnimatic({ id, projectId, name, doc, folderId = null, by = null, at = Date.now() }) {
    putAnimatic.run(id, projectId, name, JSON.stringify(doc), at, by, at, by, folderId);
    return animatic(id);
  }
  const updateAnimatic = db.prepare('UPDATE animatics SET name = ?, doc = ?, rev = ?, updated_at = ?, updated_by = ?, folder_id = ? WHERE id = ? AND rev = ?');
  // Renamed, moved to another folder of the reviews (`folderId`, null: their top), or its edit saved. An edit
  // is saved only over the save it was made from (`rev`): one made from an older save is refused (null), as
  // somebody else has saved since. A rename or a move alone needs no `rev`.
  function setAnimatic(id, { name, doc, rev, folderId } = {}, by = null, at = Date.now()) {
    const a = animatic(id);
    if (!a) return null;
    if (doc !== undefined && rev !== a.rev) return null;
    const next = doc !== undefined ? a.rev + 1 : a.rev;
    const done = updateAnimatic.run(name ?? a.name, JSON.stringify(doc ?? a.doc), next, at, doc !== undefined ? by : a.updatedBy,
      folderId !== undefined ? folderId : a.folderId, id, a.rev).changes > 0;
    return done ? animatic(id) : null;
  }
  const dropAnimatic = db.prepare('DELETE FROM animatics WHERE id = ?');
  const deleteAnimatic = (id) => dropAnimatic.run(id).changes > 0;

  const readFolders = db.prepare('SELECT * FROM folders');
  const folders = () => readFolders.all().map((r) => ({
    id: r.id, name: r.name, parentId: r.parent_id, workspace: r.workspace, createdAt: r.created_at,
    project: !!r.project, settings: r.settings ? JSON.parse(r.settings) : {},
  }));
  const clearFolders = db.prepare('DELETE FROM folders');
  const putFolder = db.prepare('INSERT INTO folders (id, name, parent_id, workspace, created_at, project, settings) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // The whole tree at once: it is small, and changes to it come one click at a time.
  function saveFolders(list) {
    transaction(() => {
      clearFolders.run();
      for (const f of list) {
        putFolder.run(f.id, f.name, f.parentId || null, f.workspace, f.createdAt, f.project ? 1 : 0,
          f.settings && Object.keys(f.settings).length ? JSON.stringify(f.settings) : null);
      }
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
  const addMedia = ({ name, size, by = null, crc = null }) => putMedia.run(name, VIDEO_EXT.test(name) ? 'video' : AUDIO_EXT.test(name) ? 'audio' : 'image', size ?? null, by, Date.now(), crc);
  const putCrc = db.prepare('UPDATE media SET crc = ? WHERE name = ?');
  const setMediaCrc = (name, crc) => putCrc.run(crc, name);
  const readMedia = db.prepare('SELECT * FROM media WHERE name = ?');
  const media = (name) => readMedia.get(name) || null;
  const putPhone = db.prepare('UPDATE media SET phone = ? WHERE name = ?');
  const setMediaPhone = (name, phone) => putPhone.run(phone, name).changes > 0;
  // The pieces on boards that show an uploaded file, as last written: [{ boardId, id }].
  const readItemsWith = db.prepare('SELECT board_id, id FROM items WHERE media = ?');
  const itemsWithMedia = (name) => readItemsWith.all(name).map((r) => ({ boardId: r.board_id, id: r.id }));

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

  // ---------------------------------------------------------------- projects: entities and versions

  const names = (json) => {
    try {
      const list = JSON.parse(json || '[]');
      return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const entityOf = (r) => ({
    id: r.id, projectId: r.project_id, type: r.type, name: r.name, createdAt: r.created_at, createdBy: r.created_by,
    artists: names(r.artists), cc: names(r.cc),
  });
  // No task is '' in the database (see SCHEMA) and null everywhere else.
  const taskKey = (task) => task || '';

  // Which version is the newest, wherever that is asked (an entity's card, the timeline, a board's chip
  // saying a newer one is there): of one task, the one with the highest number; of an entity
  // as a whole, the most recently filed of those, one per task. Archived and deleted versions are never
  // the newest. A number can be set by hand, so within a task it is the number, not when it was filed,
  // that says which comes after which.
  const LIVE = 'v.hidden = 0 AND v.deleted_at IS NULL';
  const HEAD = 'v.number = (SELECT max(w.number) FROM versions w WHERE w.entity_id = v.entity_id AND w.task = v.task AND w.hidden = 0 AND w.deleted_at IS NULL)';
  const NEWEST_FIRST = 'v.created_at DESC, v.number DESC, v.id DESC';

  // What a card shows of a version: enough to scrub through it, or play it. A version shown more than one
  // way (its passes: the unwrapped picture and how it looks projected, say) has each of them, the same way.
  const glanceLook = (l) => {
    const { type, src, poster, th, dur, fps, nw, nh, pass } = l;
    return { type, src, poster, th, dur, fps, nw, nh, ...(pass && { pass }) };
  };
  const glanceOf = (v) => {
    const look = glanceLook(v.look);
    if (Array.isArray(v.look.passes) && v.look.passes.length) look.passes = v.look.passes.map(glanceLook);
    return { id: v.id, task: v.task, number: v.number, kind: v.kind, at: v.createdAt, look };
  };
  // What the cards of some entities show, in one go rather than one entity at a time: how many versions
  // each has, when the last came, its newest version and its still (the newest's, or else that of the
  // last one filed that has one). `pick` is SQL that gives the ids of the entities, with its `args`.
  function cards(pick, args) {
    const out = new Map();
    const of = (id) => out.get(id) || out.set(id, { versions: 0, latestAt: null, thumb: null, newest: null }).get(id);
    for (const r of db.prepare(`SELECT v.entity_id, count(*) AS n, max(v.created_at) AS latest FROM versions v
      WHERE ${LIVE} AND v.entity_id IN (${pick}) GROUP BY v.entity_id`).all(...args)) {
      Object.assign(of(r.entity_id), { versions: r.n, latestAt: r.latest });
    }
    for (const r of db.prepare(`SELECT * FROM (SELECT v.*, row_number() OVER (PARTITION BY v.entity_id ORDER BY ${NEWEST_FIRST}) AS place
      FROM versions v WHERE ${LIVE} AND ${HEAD} AND v.entity_id IN (${pick})) WHERE place = 1`).all(...args)) {
      const c = of(r.entity_id);
      c.newest = glanceOf(versionOf(r));
      c.thumb = r.thumb;
    }
    for (const r of db.prepare(`SELECT entity_id, thumb FROM (SELECT v.entity_id, v.thumb, row_number() OVER (PARTITION BY v.entity_id ORDER BY ${NEWEST_FIRST}) AS place
      FROM versions v WHERE ${LIVE} AND v.thumb IS NOT NULL AND v.entity_id IN (${pick})) WHERE place = 1`).all(...args)) {
      const c = of(r.entity_id);
      if (!c.thumb) c.thumb = r.thumb;
    }
    return out;
  }
  const noCard = { versions: 0, latestAt: null, thumb: null, newest: null };
  // The cards of some entities, by id.
  const entityCards = (ids) => (ids.length ? cards(ids.map(() => '?').join(', '), ids) : new Map());

  // The highest number each task of each entity has reached (deleted versions too: their numbers are
  // not given out again), so the next one can be said ahead: { task (or '' for none): number }.
  const readTops = db.prepare('SELECT v.entity_id, v.task, max(v.number) AS top FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? GROUP BY v.entity_id, v.task');
  const readEntities = db.prepare('SELECT * FROM entities WHERE project_id = ? ORDER BY name');
  // The newest version of each task of each entity of a project: what the next one filed there follows.
  const readHeads = db.prepare(`SELECT v.* FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? AND ${LIVE} AND ${HEAD}`);
  const streamHeads = (projectId) => readHeads.all(projectId).map(versionOf);
  // A project's entities, each as its card shows it (see cards above), how far each task has counted, and
  // the newest version of each task ({ task (or ''): { id, number, thumb, at, look } }), with enough of
  // its look to play it beside a piece about to follow it, and to say how their lengths differ.
  const headLook = (raw) => {
    const { type, src, lo, poster, dur, fps, nw, nh, pass, passes, attachments } = JSON.parse(raw);
    return { type, src, ...(lo && { lo }), poster, dur, fps, nw, nh, passNames: [pass || '', ...(passes || []).map((x) => x.pass)], attachmentNames: (attachments || []).map((x) => x.label) };
  };
  const entities = (projectId) => {
    const tops = new Map();
    for (const t of readTops.all(projectId)) (tops.get(t.entity_id) || tops.set(t.entity_id, {}).get(t.entity_id))[taskKey(t.task)] = t.top;
    const heads = new Map();
    for (const r of readHeads.all(projectId)) (heads.get(r.entity_id) || heads.set(r.entity_id, {}).get(r.entity_id))[r.task] = { id: r.id, number: r.number, thumb: r.thumb, at: r.created_at, look: headLook(r.look) };
    const shown = cards('SELECT id FROM entities WHERE project_id = ?', [projectId]);
    return readEntities.all(projectId).map((r) => ({ ...entityOf(r), ...(shown.get(r.id) || noCard), tops: tops.get(r.id) || {}, heads: heads.get(r.id) || {} }));
  };
  // A project's versions, newest filed first (archived and deleted ones left out), each with its entity,
  // a page at a time. `after` is where the page before ended: the [created_at, number, id] of its last.
  const readProjectVersions = db.prepare(`SELECT v.*, e.name AS entity_name, e.type AS entity_type FROM versions v JOIN entities e ON e.id = v.entity_id
    WHERE e.project_id = ? AND v.deleted_at IS NULL AND v.hidden = 0 AND (v.created_at, v.number, v.id) < (?, ?, ?)
    ORDER BY v.created_at DESC, v.number DESC, v.id DESC LIMIT ?`);
  const projectVersions = (projectId, { after = [Number.MAX_SAFE_INTEGER, 0, ''], limit = 300 } = {}) =>
    readProjectVersions.all(projectId, after[0], after[1], after[2], limit).map((r) => ({ ...versionOf(r), entityName: r.entity_name, entityType: r.entity_type }));
  // A project's versions as its Versions page asks for them: those of some tasks, sequences, types, filers
  // or artists, filed since a time, matching words, only the newest of each entity and task, archived ones
  // too, in an order, a page at a time ({ list, total }). Each filter given as a list takes any of it; ''
  // in `tasks` is no task. A sequence is the shots whose name is it and a number.
  //   sort: 'new' (newest filed first, the default), 'old', 'name' (by entity, then task, newest first), 'number'
  function findVersions(projectId, { tasks, seqs, types, by, artists, since, q, newest = false, archived = false, sort = 'new', offset = 0, limit = 300 } = {}) {
    const where = ['e.project_id = ?', 'v.deleted_at IS NULL'];
    const args = [projectId];
    const anyOf = (col, list) => {
      where.push(`${col} IN (${list.map(() => '?').join(', ')})`);
      args.push(...list);
    };
    if (!archived) where.push('v.hidden = 0');
    if (tasks && tasks.length) anyOf('v.task', tasks.map(taskKey));
    if (types && types.length) anyOf('e.type', types);
    if (by && by.length) anyOf('lower(v.created_by)', by.map((n) => String(n).toLowerCase()));
    if (artists && artists.length) anyOf('v.artist', artists);
    if (seqs && seqs.length) {
      where.push(`(e.type = 'shot' AND (${seqs.map(() => "(substr(e.name, 1, length(?) + 1) = ? || '-' AND substr(e.name, length(?) + 2) <> '' AND substr(e.name, length(?) + 2) NOT GLOB '*[^0-9]*')").join(' OR ')}))`);
      for (const q2 of seqs) args.push(q2, q2, q2, q2);
    }
    if (since) {
      where.push('v.created_at >= ?');
      args.push(since);
    }
    for (const word of String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      // Each word somewhere: the entity, the task, the artist, who filed it, the file's own name, or "v12".
      where.push("(e.name LIKE ? ESCAPE '\\' OR v.task LIKE ? ESCAPE '\\' OR coalesce(v.artist, '') LIKE ? ESCAPE '\\' OR lower(coalesce(v.created_by, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(v.original_name, '')) LIKE ? ESCAPE '\\' OR 'v' || v.number = ?)");
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like, like, like, word);
    }
    if (newest) where.push(HEAD);
    const order = { old: 'v.created_at ASC, v.number ASC, v.id ASC', name: 'e.name ASC, v.task ASC, v.number DESC', number: 'v.number DESC, v.created_at DESC' }[sort] || NEWEST_FIRST;
    const from = `FROM versions v JOIN entities e ON e.id = v.entity_id WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT count(*) AS n ${from}`).get(...args).n;
    const list = db.prepare(`SELECT v.*, e.name AS entity_name, e.type AS entity_type ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map((r) => ({ ...versionOf(r), entityName: r.entity_name, entityType: r.entity_type }));
    return { list, total };
  }
  // Who has filed versions in a project, each once.
  const readFilers = db.prepare('SELECT DISTINCT v.created_by AS name FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? AND v.deleted_at IS NULL AND v.created_by IS NOT NULL ORDER BY v.created_by');
  const projectFilers = (projectId) => readFilers.all(projectId).map((r) => r.name);
  // The newest version of an entity and task, as a card shows it; for a project's timeline.
  const readNewestOfTask = db.prepare(`SELECT * FROM versions v WHERE v.entity_id = ? AND v.task = ? AND ${LIVE} ORDER BY v.number DESC LIMIT 1`);
  const newestOfTask = (entityId, task) => {
    const r = readNewestOfTask.get(entityId, taskKey(task));
    return r ? glanceOf(versionOf(r)) : null;
  };
  const readEntity = db.prepare('SELECT * FROM entities WHERE id = ?');
  const entity = (id) => {
    const r = readEntity.get(id);
    return r ? entityOf(r) : null;
  };
  const readEntityNamed = db.prepare('SELECT * FROM entities WHERE project_id = ? AND name = ?');
  const entityNamed = (projectId, name) => {
    const r = readEntityNamed.get(projectId, name);
    return r ? entityOf(r) : null;
  };
  const putEntity = db.prepare('INSERT INTO entities (id, project_id, type, name, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, name) DO NOTHING');
  // Made, or the one of that name the project has already.
  function addEntity({ id, projectId, type, name, by = null }) {
    putEntity.run(id, projectId, type, name, Date.now(), by);
    return entityNamed(projectId, name);
  }
  const dropPeople = db.prepare('DELETE FROM entity_people WHERE entity_id = ?');
  const putPerson = db.prepare('INSERT OR IGNORE INTO entity_people (entity_id, role, name_key) VALUES (?, ?, ?)');
  // Renames it, moves it to another type, or says who works on it and who follows it.
  const putEntityFields = db.prepare('UPDATE entities SET name = ?, type = ?, artists = ?, cc = ? WHERE id = ?');
  function setEntity(id, { name, type, artists, cc }) {
    const e = entity(id);
    if (!e) return { ok: false };
    const to = { name: name ?? e.name, type: type ?? e.type, artists: artists ?? e.artists, cc: cc ?? e.cc };
    if (to.name !== e.name) {
      const have = entityNamed(e.projectId, to.name);
      if (have) return { ok: false, taken: have };
    }
    transaction(() => {
      putEntityFields.run(to.name, to.type, JSON.stringify(to.artists), JSON.stringify(to.cc), id);
      dropPeople.run(id);
      for (const [role, list] of [['artist', to.artists], ['cc', to.cc]]) for (const n of list) if (n.trim()) putPerson.run(id, role, n.trim().toLowerCase());
    });
    return { ok: true, entity: entity(id) };
  }
  // What happened in a project, newest first, from `upTo` (a time) back to `since`:
  // versions filed and notes written on them, at most `limit` of each. Each note says whose work its
  // version is (who filed it, and the artist it names). The server makes the pages of its Activity of these.
  // Those made at `upTo` itself are only the ones whose id is below `versionBelow` or `noteBelow` (none unless
  // said), so that a page ending among many made at one moment goes on from the one it ended at.
  const readFiled = db.prepare(`SELECT v.* FROM versions v JOIN entities e ON e.id = v.entity_id
    WHERE e.project_id = ? AND v.deleted_at IS NULL AND (v.created_at < ? OR (v.created_at = ? AND v.id < ?)) AND v.created_at >= ?
    ORDER BY v.created_at DESC, v.id DESC LIMIT ?`);
  const readSaid = db.prepare(`SELECT n.*, v.entity_id AS entity_id, v.created_by AS version_by, v.artist AS version_artist
    FROM notes n JOIN versions v ON v.id = n.version_id JOIN entities e ON e.id = v.entity_id
    WHERE e.project_id = ? AND v.deleted_at IS NULL AND n.deleted_at IS NULL AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?)) AND n.created_at >= ?
    ORDER BY n.created_at DESC, n.id DESC LIMIT ?`);
  function happenings(projectId, { upTo = Number.MAX_SAFE_INTEGER, since = 0, limit = 100, versionBelow = '', noteBelow = '' } = {}) {
    return {
      versions: readFiled.all(projectId, upTo, upTo, versionBelow, since, limit).map(versionOf),
      notes: readSaid.all(projectId, upTo, upTo, noteBelow, since, limit).map((row) => ({ ...noteOf(row), entityId: row.entity_id, versionBy: row.version_by, versionArtist: row.version_artist })),
    };
  }
  // The names of everyone who has written in a thread (its first note's id), in lower case.
  const readThread = db.prepare('SELECT data FROM notes WHERE (id = ? OR re = ?) AND deleted_at IS NULL');
  const threadNames = (root) => new Set(readThread.all(root, root).map((r) => String(JSON.parse(r.data).name || '').trim().toLowerCase()).filter(Boolean));
  // Everyone the app knows by name: who signed in, who filed or wrote something, who is named on an entity.
  function people() {
    const out = new Set();
    for (const u of readUsers.all()) if (u.name) out.add(u.name);
    for (const r of db.prepare('SELECT DISTINCT created_by AS n FROM versions WHERE created_by IS NOT NULL UNION SELECT DISTINCT created_by FROM notes WHERE created_by IS NOT NULL').all()) out.add(r.n);
    for (const r of db.prepare('SELECT artists, cc FROM entities WHERE artists IS NOT NULL OR cc IS NOT NULL').all()) for (const n of [...names(r.artists), ...names(r.cc)]) out.add(n);
    return [...out].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }
  const countEntities = db.prepare('SELECT count(*) AS n FROM entities WHERE project_id = ?');
  const entityCount = (projectId) => countEntities.get(projectId).n;

  const versionOf = (r) => ({
    id: r.id, entityId: r.entity_id, task: r.task || null, number: r.number, descriptor: r.descriptor, artist: r.artist, hip: r.hip,
    media: r.media, thumb: r.thumb, kind: r.kind, originalName: r.original_name, look: JSON.parse(r.look), boardId: r.board_id,
    createdAt: r.created_at, createdBy: r.created_by, hidden: !!r.hidden, deletedAt: r.deleted_at || null,
  });
  const nextNumber = db.prepare('SELECT coalesce(max(number), 0) + 1 AS n FROM versions WHERE entity_id = ? AND task = ?');
  const putVersion = db.prepare(`INSERT INTO versions (id, entity_id, task, number, descriptor, artist, hip, media, thumb, kind, original_name, look, board_id, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const readVersion = db.prepare('SELECT * FROM versions WHERE id = ?');
  const version = (id) => {
    const r = readVersion.get(id);
    return r ? versionOf(r) : null;
  };
  // Who has a number: a deleted version keeps its own, so that bringing it back finds it free.
  const readHolder = db.prepare('SELECT * FROM versions WHERE entity_id = ? AND task = ? AND number = ?');
  const holder = (entityId, task, number) => {
    const r = readHolder.get(entityId, taskKey(task), number);
    return r ? versionOf(r) : null;
  };
  // Files a piece of media as the next version of an entity (and task). The number is counted here:
  // one more than the last of that entity and task, in the order they were filed.
  // `number`, when given, is the one it is to have; a number another version of that entity and task has
  // (or had, before it was deleted) is refused with that version.
  function addVersion({ id, entityId, task = null, number: asked = null, descriptor = null, artist = null, hip = null, media = null, thumb = null, kind, originalName = null, look, boardId = null, by = null, at = Date.now() }) {
    return transaction(() => {
      if (asked != null) {
        const taken = holder(entityId, task, asked);
        if (taken) throw Object.assign(new Error('That number is taken'), { taken });
      }
      const number = asked ?? nextNumber.get(entityId, taskKey(task)).n;
      putVersion.run(id, entityId, taskKey(task), number, descriptor, artist, hip, media, thumb, kind, originalName, JSON.stringify(look), boardId, at, by);
      return version(id);
    });
  }
  const readVersionsOf = db.prepare('SELECT * FROM versions WHERE entity_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, number DESC');
  const versionsOf = (entityId) => readVersionsOf.all(entityId).map(versionOf);
  const putHidden = db.prepare('UPDATE versions SET hidden = ? WHERE id = ?');
  const hideVersion = (id, hidden) => putHidden.run(hidden ? 1 : 0, id).changes > 0;
  const putPlace = db.prepare('UPDATE versions SET entity_id = ?, task = ?, number = ?, descriptor = ?, artist = ? WHERE id = ?');
  // Where a version would be filed after an edit: moved to another entity or task without a number, it is
  // the next of those; and whichever other version has that number already, if one does.
  function placeFor(v, { entityId, task, number }) {
    const to = { entityId: entityId ?? v.entityId, task: task !== undefined ? task : v.task };
    const moved = to.entityId !== v.entityId || taskKey(to.task) !== taskKey(v.task);
    to.number = number ?? (moved ? nextNumber.get(to.entityId, taskKey(to.task)).n : v.number);
    const taken = holder(to.entityId, to.task, to.number);
    return { ...to, taken: taken && taken.id !== v.id ? taken : null };
  }
  // Changes what a version is filed as (see placeFor); a number some other version has is refused, with that version.
  function editVersion(id, { entityId, task, number, descriptor, artist }) {
    return transaction(() => {
      const v = version(id);
      if (!v) return { ok: false };
      const to = placeFor(v, { entityId, task, number });
      if (to.taken) return { ok: false, taken: to.taken };
      putPlace.run(to.entityId, taskKey(to.task), to.number, descriptor !== undefined ? descriptor : v.descriptor, artist !== undefined ? artist : v.artist, id);
      return { ok: true, version: version(id) };
    });
  }
  // Another pass of a version (see glanceOf): kept with its look, under its name.
  const putLook = db.prepare('UPDATE versions SET look = ? WHERE id = ?');
  const setLook = (id, look) => putLook.run(JSON.stringify(look), id).changes > 0;
  // The versions whose look (or one of its passes) shows an uploaded file, deleted ones too.
  const readWithFile = db.prepare('SELECT id FROM versions WHERE look LIKE ?');
  const versionsWithFile = (src) => readWithFile.all(`%${JSON.stringify(src).slice(1, -1)}%`).map((r) => r.id);
  function addPass(id, look) {
    const v = version(id);
    if (!v) return null;
    putLook.run(JSON.stringify({ ...v.look, passes: [...(v.look.passes || []), look] }), id);
    return version(id);
  }
  // An attachment of a version (see cleanLook in server.js), under its label, with when it came and who
  // brought it. Null when the version has an attachment of that label already.
  const hasAttachment = (look, label) => (look.attachments || []).some((x) => x.label === label);
  // `board` is the board it was filed from, if it was.
  function addAttachment(id, look, by = null, board = null) {
    const v = version(id);
    if (!v || hasAttachment(v.look, look.label)) return null;
    putLook.run(JSON.stringify({ ...v.look, attachments: [...(v.look.attachments || []), { ...look, at: Date.now(), ...(by && { by }), ...(board && { board }) }] }), id);
    return version(id);
  }
  // The names of the passes a project's versions are shown in, each once.
  const readPasses = db.prepare(`SELECT DISTINCT name FROM (
      SELECT json_extract(v.look, '$.pass') AS name FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? AND v.deleted_at IS NULL
      UNION SELECT json_extract(j.value, '$.pass') FROM versions v JOIN entities e ON e.id = v.entity_id, json_each(v.look, '$.passes') j WHERE e.project_id = ? AND v.deleted_at IS NULL
    ) WHERE name IS NOT NULL ORDER BY name`);
  const projectPasses = (projectId) => readPasses.all(projectId, projectId).map((r) => r.name);
  const putGone = db.prepare('UPDATE versions SET deleted_at = ? WHERE id = ?');
  const deleteVersion = (id) => putGone.run(Date.now(), id).changes > 0;
  const restoreVersion = (id) => putGone.run(null, id).changes > 0;
  const readNewest = db.prepare(`SELECT v.id, v.number FROM versions v WHERE v.entity_id = ? AND v.task = ? AND ${LIVE} ORDER BY v.number DESC LIMIT 1`);
  // The newest version of an entity and task (see above): what a board points out is there.
  const newestVersion = (entityId, task) => readNewest.get(entityId, taskKey(task)) || null;
  const readTasks = db.prepare("SELECT DISTINCT v.task FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? AND v.task <> '' ORDER BY v.task");
  const projectTasks = (projectId) => readTasks.all(projectId).map((r) => r.task);
  const readArtists = db.prepare('SELECT DISTINCT v.artist FROM versions v JOIN entities e ON e.id = v.entity_id WHERE e.project_id = ? AND v.artist IS NOT NULL ORDER BY v.artist');
  const projectArtists = (projectId) => readArtists.all(projectId).map((r) => r.artist);
  // The boards each of some versions is on, as last written (boards deleted are not counted), most
  // recently changed first: { version id: [{ id, name, workspace }] }.
  function boardsWithVersions(versionIds) {
    const ids = [...new Set(versionIds)];
    const out = new Map(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = db.prepare(`SELECT DISTINCT i.version_id, b.id, b.name, b.workspace, b.updated_at FROM items i JOIN boards b ON b.id = i.board_id
      WHERE i.version_id IN (${ids.map(() => '?').join(', ')}) AND b.deleted_at IS NULL ORDER BY b.updated_at DESC, b.id`).all(...ids);
    for (const r of rows) out.get(r.version_id).push({ id: r.id, name: r.name, workspace: r.workspace });
    return out;
  }
  const boardsWithVersion = (versionId) => boardsWithVersions([versionId]).get(versionId);

  // ---------------------------------------------------------------- notes

  const noteOf = (r) => ({
    id: r.id, boardId: r.board_id, itemId: r.item_id, versionId: r.version_id, re: r.re, data: JSON.parse(r.data),
    createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, deletedAt: r.deleted_at,
  });
  const readNote = db.prepare('SELECT * FROM notes WHERE id = ?');
  const note = (id) => {
    const r = readNote.get(id);
    return r ? noteOf(r) : null;
  };
  const putNote = db.prepare(`INSERT INTO notes (id, board_id, item_id, version_id, re, data, created_at, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  function addNote({ id, boardId, itemId, versionId = null, re = null, data, by = null, at = Date.now() }) {
    putNote.run(id, boardId, itemId, versionId, re, JSON.stringify(data), at, by, at);
    return note(id);
  }
  const putNoteData = db.prepare('UPDATE notes SET data = ?, updated_at = ? WHERE id = ?');
  const setNote = (id, data) => putNoteData.run(JSON.stringify(data), Date.now(), id).changes > 0;
  const putNoteGone = db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?');
  const putRepliesGone = db.prepare('UPDATE notes SET deleted_at = ? WHERE re = ? AND deleted_at IS NULL');
  const putRepliesBack = db.prepare('UPDATE notes SET deleted_at = NULL WHERE re = ? AND deleted_at = ?');
  // Deleting the note a thread starts with deletes the thread: its replies go with it, marked at the
  // same moment, so that bringing the first note back brings back those replies too (and not ones
  // deleted on their own before). Says whether anything was deleted.
  function deleteNote(id) {
    const n = note(id);
    if (!n || n.deletedAt) return false;
    const now = Date.now();
    transaction(() => {
      putNoteGone.run(now, id);
      if (!n.re) putRepliesGone.run(now, id);
    });
    return true;
  }
  function restoreNote(id) {
    const n = note(id);
    if (!n || !n.deletedAt) return false;
    transaction(() => {
      putNoteGone.run(null, id);
      if (!n.re) putRepliesBack.run(id, n.deletedAt);
    });
    return true;
  }
  // A piece filed as a version takes the notes made on it with it: from then on they are the version's.
  // Filed as an attachment of one, they say which (`att` in a note's data, as a note made on it there does).
  const putNotesFiled = db.prepare('UPDATE notes SET version_id = ? WHERE board_id = ? AND item_id = ? AND version_id IS NULL');
  const putNotesFiledOn = db.prepare("UPDATE notes SET version_id = ?, data = json_set(data, '$.att', ?) WHERE board_id = ? AND item_id = ? AND version_id IS NULL");
  const fileNotes = (boardId, itemId, versionId, att = null) => (att ? putNotesFiledOn.run(versionId, att, boardId, itemId) : putNotesFiled.run(versionId, boardId, itemId)).changes;
  // Notes on a version that were not written on the piece it was filed from: written since, elsewhere.
  const readNotesSince = db.prepare('SELECT count(*) AS n FROM notes WHERE version_id = ? AND NOT (board_id IS ? AND item_id IS ?)');
  const notesBesides = (versionId, boardId, itemId) => readNotesSince.get(versionId, boardId, itemId).n;
  // A version taken back just after it was filed from a board, as if it never had been: the notes that
  // went with it are the piece's again, and it is gone, number and all, so the next one filed there has
  // its number. So is the entity it was filed under, when that was made for it and has nothing else.
  const putNotesUnfiled = db.prepare('UPDATE notes SET version_id = NULL WHERE version_id = ? AND board_id = ? AND item_id = ?');
  const dropVersion = db.prepare('DELETE FROM versions WHERE id = ?');
  const countVersions = db.prepare('SELECT count(*) AS n FROM versions WHERE entity_id = ?');
  const dropEntity = db.prepare('DELETE FROM entities WHERE id = ?');
  function unfileVersion(id, itemId, { madeSince = Infinity } = {}) {
    return transaction(() => {
      const v = version(id);
      if (!v) return null;
      putNotesUnfiled.run(id, v.boardId, itemId);
      dropVersion.run(id);
      const e = entity(v.entityId);
      const dropped = !!e && e.createdAt >= madeSince && !e.artists.length && !e.cc.length && countVersions.get(e.id).n === 0 && dropEntity.run(e.id).changes > 0;
      return { entityId: v.entityId, entityDropped: dropped };
    });
  }
  // An attachment taken back just after it was added (see unfileVersion): the notes that went with it are the
  // piece's again. Notes made on it since are counted first, and refuse it (`notesOnAttachment`).
  const putAttachmentNotesUnfiled = db.prepare("UPDATE notes SET version_id = NULL, data = json_remove(data, '$.att') WHERE version_id = ? AND board_id = ? AND item_id = ? AND json_extract(data, '$.att') = ?");
  const readAttachmentNotes = db.prepare("SELECT count(*) AS n FROM notes WHERE version_id = ? AND json_extract(data, '$.att') = ? AND NOT (board_id IS ? AND item_id IS ?)");
  const notesOnAttachment = (versionId, label, boardId, itemId) => readAttachmentNotes.get(versionId, label, boardId, itemId).n;
  function unfileAttachment(id, label, boardId, itemId) {
    return transaction(() => {
      const v = version(id);
      if (!v || !hasAttachment(v.look, label)) return false;
      if (boardId) putAttachmentNotesUnfiled.run(id, boardId, itemId, label);
      const attachments = v.look.attachments.filter((x) => x.label !== label);
      const look = { ...v.look, attachments };
      if (!attachments.length) delete look.attachments;
      putLook.run(JSON.stringify(look), id);
      return true;
    });
  }
  // Every note a board shows: those on its media that is not filed, and those on the versions it holds.
  const readLooseNotes = db.prepare('SELECT * FROM notes WHERE board_id = ? AND version_id IS NULL AND deleted_at IS NULL');
  function notesForBoard(boardId, versionIds = []) {
    const ids = [...new Set(versionIds)];
    const rows = readLooseNotes.all(boardId);
    if (ids.length) rows.push(...db.prepare(`SELECT * FROM notes WHERE version_id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL`).all(...ids));
    return rows.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)).map(noteOf);
  }
  // The notes on some versions, with the name and workspace of the board each was made on.
  function notesOfVersions(versionIds) {
    if (!versionIds.length) return [];
    return db.prepare(`SELECT n.*, b.name AS board_name, b.workspace AS board_workspace FROM notes n LEFT JOIN boards b ON b.id = n.board_id
      WHERE n.deleted_at IS NULL AND n.version_id IN (${versionIds.map(() => '?').join(', ')}) ORDER BY n.created_at`).all(...versionIds)
      .map((r) => ({ ...noteOf(r), boardName: r.board_name, boardWorkspace: r.board_workspace }));
  }

  // ---------------------------------------------------------------- notifications

  // Every note whose thread has had one since `since`, made on a board in these workspaces or, in the
  // catalogue (on no board), on a version of a project in them; with what each was made on and who
  // added that (for a note in the catalogue, who filed the version), who made the board, and the
  // version, entity and project when it is about one. Older notes in those threads come too: a new
  // reply needs the thread it is in.
  function commentsForNotices(spaces, since) {
    const list = spaces.map(() => '?').join(', ');
    return db.prepare(`
      SELECT n.data, n.id, n.re, n.created_at, n.board_id, b.name AS board_name, b.created_by AS board_by,
        coalesce(h.created_by, CASE WHEN n.board_id = '' THEN v.created_by END) AS host_by, h.type AS host_type, h.label AS host_label,
        v.id AS version_id, v.task AS version_task, v.number AS version_number, e.id AS entity_id, e.name AS entity_name, e.project_id,
        pl.id AS playlist_id
      FROM notes n
      LEFT JOIN boards b ON b.id = n.board_id
      LEFT JOIN items h ON h.board_id = n.board_id AND h.id = n.item_id
      LEFT JOIN versions v ON v.id = n.version_id
      LEFT JOIN entities e ON e.id = v.entity_id
      LEFT JOIN folders f ON f.id = e.project_id
      LEFT JOIN playlists pl ON pl.id = e.project_id
      WHERE n.deleted_at IS NULL
        AND ((b.id IS NOT NULL AND b.deleted_at IS NULL AND b.workspace IN (${list}))
          OR (n.board_id = '' AND v.deleted_at IS NULL AND coalesce(f.workspace, pl.workspace) IN (${list})))
        AND coalesce(n.re, n.id) IN (SELECT coalesce(re, id) FROM notes WHERE deleted_at IS NULL AND created_at > ?)`).all(...spaces, ...spaces, since)
      .map((r) => ({ ...r, version_task: r.version_task || null, comment: { ...JSON.parse(r.data), id: r.id, ...(r.re && { re: r.re }) } }));
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
    saveBoard, boards, loadItems, summaries, deleteBoard, deletedBoards, restoreBoard, folders, saveFolders, addMedia, media, setMediaCrc, logActivity, activity,
    addSnapshot, snapshots, snapshot, lastSnapshotAt,
    transaction, entities, streamHeads, findVersions, projectFilers, entityCards, newestOfTask, projectVersions, entity, entityNamed, addEntity, setEntity, happenings, threadNames, people, entityCount,
    addVersion, addPass, addAttachment, projectPasses, version, versionsOf, hideVersion, editVersion, placeFor, numberHolder: holder, deleteVersion, restoreVersion, newestVersion, projectTasks, projectArtists, boardsWithVersion, boardsWithVersions,
    note, addNote, setNote, deleteNote, restoreNote, fileNotes, notesBesides, unfileVersion, notesOnAttachment, unfileAttachment, notesForBoard, notesOfVersions,
    find, commentsForNotices, getState, setState, backup, close, isOpen: () => !closed,
    users, user, addUser, setAdmin, seeUser, removeUser, groups, addGroup, renameGroup, removeGroup, addMember, removeMember,
    grants, setGrant, removeGrant, removeGrantsOn,
    deleteProject, presentations, savePresentation, deletePresentation, setMediaPhone, itemsWithMedia, setLook, versionsWithFile,
    playlists, loosePlaylists, playlist, addPlaylist, setPlaylist, deletePlaylist,
    animatics, animatic, addAnimatic, setAnimatic, deleteAnimatic,
  };
}

module.exports = { openStore };
