'use strict';

// One-off, for a data folder from before the database: reads the boards and folders kept as JSON
// files (data/boards/*.json, data/folders.json) into data/wipboard.db and moves the files to
// data/legacy, where they stay as they were. Stop the server first, then:
//   node scripts/import-json.js
// Boards already in the database are left alone, so running it twice does no harm.

const fs = require('fs');
const path = require('path');
const { openStore } = require('../store');

const dataDir = path.resolve(process.env.WIPBOARD_DATA || path.join(__dirname, '..', 'data'));
const boardDir = path.join(dataDir, 'boards');
const folderFile = path.join(dataDir, 'folders.json');
const legacyDir = path.join(dataDir, 'legacy');

const ID_RE = /^[\w-]{4,40}$/;
const SHARE_RE = /^[\w-]{16,64}$/;
const space = (key) => (key === 'myreze' || (typeof key === 'string' && key.startsWith('u:') && key.length > 3) ? key : 'myreze');

function cleanBoard(raw) {
  if (!raw || !ID_RE.test(raw.id)) return null;
  const seen = new Set();
  const items = (raw.items || []).filter((it) => it && ID_RE.test(it.id) && typeof it.type === 'string' && !seen.has(it.id) && seen.add(it.id));
  return {
    id: raw.id,
    name: String(raw.name || 'Untitled').slice(0, 120),
    folderId: raw.folderId || null,
    workspace: space(raw.workspace),
    shareToken: typeof raw.shareToken === 'string' && SHARE_RE.test(raw.shareToken) ? raw.shareToken : null,
    shareAccess: null,
    shareExpires: null,
    createdAt: raw.createdAt || Date.now(),
    createdBy: null,
    updatedAt: raw.updatedAt || Date.now(),
    items,
  };
}

const store = openStore(dataDir);
try {
  const known = new Set([...store.boards(), ...store.deletedBoards()].map((b) => b.id));
  const files = fs.existsSync(boardDir) ? fs.readdirSync(boardDir).filter((f) => f.endsWith('.json')) : [];
  let imported = 0;
  if (files.length) fs.mkdirSync(path.join(legacyDir, 'boards'), { recursive: true });
  for (const name of files) {
    const from = path.join(boardDir, name);
    let board;
    try {
      board = cleanBoard(JSON.parse(fs.readFileSync(from, 'utf8')));
    } catch (err) {
      console.error(`Skipping ${name}, which cannot be read: ${err.message}`);
      continue;
    }
    if (!board) continue;
    if (!known.has(board.id)) {
      store.saveBoard(board, board.items);
      imported++;
    }
    fs.renameSync(from, path.join(legacyDir, 'boards', name));
  }
  if (fs.existsSync(folderFile)) {
    if (!store.folders().length) {
      const list = JSON.parse(fs.readFileSync(folderFile, 'utf8'));
      store.saveFolders((Array.isArray(list) ? list : []).filter((f) => f && ID_RE.test(f.id)).map((f) => ({
        id: f.id, name: String(f.name || 'Folder').slice(0, 120), parentId: f.parentId || null, workspace: space(f.workspace), createdAt: f.createdAt || Date.now(),
      })));
    }
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.renameSync(folderFile, path.join(legacyDir, 'folders.json'));
  }
  console.log(`Read ${imported} board(s) into ${store.file}. The JSON files are kept in ${legacyDir}.`);
} finally {
  store.close();
}
