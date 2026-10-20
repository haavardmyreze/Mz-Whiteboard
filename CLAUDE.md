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

## Design: the rules every change keeps

The app is made for artists judging their own work: the interface stays quiet so the work is what is
seen, and it should look made by hand, not from a template. The system is written at the top of
`public/style.css`; use its tokens and never add a raw size, colour or radius beside them.

- **One big thing per page.** Every page on the home side has one title (`--fs-title`, 28px); the way
  there is a small line above it, and what belongs to the place (pin, settings, the cards/rows/table
  switch) sits beside it. Nothing else on the page is as large.
- **Type.** Inter only, on the `--fs` scale: 11 captions, 12 secondary, 13 interface, 15 a heading in a
  panel or a section, 20, 28. 10px only for counts in badges and numbers on thumbnails. Weights 400,
  500, 600 (700 only for headings on the board). Large type is tightened little (at most -0.02em):
  Inter's display cut already tightens it. Names and codes are shown as written (chap01, not CHAP01);
  uppercase is kept to the sidebar's group headings and the small section labels in Your account. Rift
  is the launch type and only has the letters of the wordmark: never use it for other text.
- **Colour.** The greys carry no hue, in either theme. Ink (near-white on dark, near-black on light) is
  the main action, the tool in hand and a switch that is on; a toggle that is on is pressed in grey.
  Blue means "this one": what is selected or focused, the playhead, what is new. Red is going live and
  deleting. Never use blue or red for decoration, data, progress or state. Colour that users pick on a
  board comes from the painter's palette (`PIGMENTS` in `board.js`), shown through `mute`/`deepen`.
- **Artwork is square.** Pictures are never rounded or boxed: as cards they are prints with their label
  beneath (a hairline edge, no card box, no lift on hover). A folder is a place, so it keeps a tile.
- **Corners.** `--r-1` 3px small marks, `--r-2` 5px controls, `--r-3` 8px panels, `--r-4` 12px
  dialogs, `--r-pill` for pills; a control's corner nests in its panel's.
- **Space and depth.** A 4px grid; controls 32px tall, 28px small. A hairline first, a shadow only for
  what floats. Lists between hairlines, not in boxes: a table is a table.
- **Widths.** Four breakpoints only: 560 (phone), under 700 (narrow, as `board.js` and `viewer.js`
  measure it), 900 (sidebar becomes a drawer), 1100.
- **Say only what differs.** A label that is true of everything in a list ("Video" on every card, a zero
  count) is left out; show it where the list mixes kinds.
- **Restraint, then one bold move.** Prefer taking away. Where something should stand out, give it one
  clear means (size, ink or position), not several.
- Check visual changes in the browser, in both themes and at phone width, and in Firefox too: it is
  the team's browser.
