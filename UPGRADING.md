# Upgrading the running server

This version keeps boards in a database (`data/wipboard.db`) instead of one JSON file per board. The
boards you have now are moved into it once, by hand, with one command. Nothing is deleted on the way.

## Steps, on the PC that runs the server

1. **Stop the server**: Ctrl+C in its window, or `stop.bat`.
2. **Back up**: copy the whole `data` folder somewhere safe.
3. **Check Node.js**: `node --version` must say **v22.13** or newer. If not, install the current LTS
   from https://nodejs.org (the server refuses to start on older versions and says so).
4. **Get the new code**: `git pull` in the Wipboard folder, then `npm install`.
5. **Move the boards into the database**, from the Wipboard folder:

   ```
   node scripts/import-json.js
   ```

   It prints how many boards it read. If your `.env` sets `WIPBOARD_DATA` to another folder, set it
   for this command too (`set WIPBOARD_DATA=D:\path\to\data` first, in the same window).
6. **Start the server** as usual (`start.bat`) and check the board list looks the way it did.

## What happens to the existing data

| What | After the upgrade |
| --- | --- |
| `data/boards/*.json`, `data/folders.json` | Read into `data/wipboard.db`, then moved to `data/legacy/`. Keep that folder until you are happy, then delete it |
| `data/uploads/` | Untouched. Every file gets catalogued on the first start |
| `data/trash/` | Boards deleted before the upgrade stay there as JSON. To bring one back, copy it into `data/boards/` as `<board id>.json` and run step 5 again |
| Read-only links | Keep working, as "View only" with no end date. Change that in the Share dialog |
| Comments, drawings, frames, notes | Carried over as they are |

## Things that only apply to new uploads

- **Videos already on boards** are not re-encoded, have no poster still (they may show black until
  played) and have no recorded frame rate (`,` and `.` step a 24th of a second, the counter shows
  minutes and seconds only). Re-upload the ones you review often to get frame stepping, frame
  drawings and fast scrubbing in both directions.
- **Notifications** about comments on "your work" and "your boards" need to know who added or made
  them, which the old files did not record. Replies and @mentions work for old boards too.

## From now on

- **Backups** are made by the server itself, once a day, in `data/backups/` (the last seven are
  kept). Back up by copying `data/uploads/` and the newest file there; do not copy `wipboard.db`
  while the server runs.
- **Deleted boards** are kept hidden: `node scripts/restore-board.js` lists them and brings one back
  (with the server stopped).
- **Cloud Run** with a bucket mounted as the data folder does not work with the database. Run it from
  the PC, as now. See [DEPLOY.md](DEPLOY.md).
