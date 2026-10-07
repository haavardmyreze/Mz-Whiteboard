'use strict';

// Brings back a board deleted from the board list. Stop the server first, then:
//   node scripts/restore-board.js            lists the deleted boards, newest first
//   node scripts/restore-board.js <board id> brings that one back, at the top level of its workspace

const path = require('path');
const { openStore } = require('../store');

const dataDir = path.resolve(process.env.WIPBOARD_DATA || path.join(__dirname, '..', 'data'));
const store = openStore(dataDir);
const id = process.argv[2];
try {
  if (!id) {
    const gone = store.deletedBoards();
    if (!gone.length) console.log('No deleted boards.');
    for (const b of gone) console.log(`${b.id}  ${new Date(b.deletedAt).toLocaleString()}  ${b.name}`);
  } else if (store.restoreBoard(id)) {
    console.log(`Restored board ${id}. Start the server and it is back in the board list.`);
  } else {
    console.error(`No deleted board with the id ${id}.`);
    process.exitCode = 1;
  }
} finally {
  store.close();
}
