# Boards by Myreze

See README.md for what the app does, how to run it, and how the code is laid out.

## Status: in development, not in production

Every board, upload, project and catalogue entry on any server running this app is test data. Nobody
depends on it yet. Changes that break older data or older versions of the app are fine: there is no
need to migrate old databases, keep reading old settings or formats, or stay compatible with earlier
API shapes. Prefer the simpler design over carrying code for data from before. Say in the commit
message what a change no longer reads, so whoever tests knows to start from a fresh data folder.

## Working on it

- `npm test` runs the tests (node:test, no build step).
- Commit titles are plain sentences saying what changed; the body explains it in prose.
- Comments and README read as plain English about what the code does, matching what is there.
