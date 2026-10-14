# Boards by Myreze

Shared reference and work-in-progress boards for a creative team, in the spirit of
Milanote and PureRef. One machine runs the server; everyone else opens a board in their
browser. Built for standup reviews: pin up stills and playblasts, group them into frames,
open them in a viewer that steps frame by frame, and comment where it matters.

All media stays on the machine that runs the server. Nothing is sent to a cloud service.

## Run it

Needs [Node.js](https://nodejs.org) 22.13 or newer (the current LTS is fine).

```bash
npm install
npm start
```

On Windows you can double-click `start.bat` instead.

The server prints the addresses to share, for example `http://MZPC-3D-003:4680`.
Anyone on the same network opens that address in Chrome, Edge or Firefox. The first time
you start it, Windows may ask whether Node.js is allowed through the firewall: allow it on
private networks, otherwise only the host machine can connect.

## What it does

- **Getting around the home page.** A sidebar on the left holds Home, then each workspace with its
  folders and projects as a tree: open a row with its arrow, go there with a click. A project opens to
  its Boards and its Catalogue, and the catalogue to its assets, sets and shots, the shots by sequence,
  each with a count. What is open in the tree is remembered, and the way to the page you are on is
  opened for you. Above the page one slim line says where you are (Myreze / Kilo / Catalogue / Shots /
  kilo / kilo-0010), each part a link; the star at its end pins that folder, project or shot to Home.
  On a narrow window the sidebar is a drawer, opened with the button at the left of the bar.
- **Home.** What you pinned (boards, folders, projects, shots), the boards you opened lately (or, until
  you have, the ones edited lately), the assets and shots you looked at in the catalogue, and every
  project. Pins and what you opened are kept by this browser. Pin from a card's `...` menu or the star.
- **Cards or compact rows.** The button beside the theme in the top bar shows boards, folders and the
  catalogue as cards, or as compact rows (a small still beside each name), remembered per browser.
- **One bar across the top, the same on every page.** The mark in the corner goes to all boards, and
  beside it is where you are, as a path: the board, and with an image or video open, the board and
  then the piece. On the right is what can be done there, ending in the one thing set in ink (New
  board, Share, Done). What is under the bar slides beneath it.
- **Dark by default, light on request.** The sun/moon button in the header switches theme and is
  remembered per browser. Everything is set in Inter, served from this machine (`public/fonts`), so text
  measures the same on every screen and nothing is fetched from the internet. The greys carry no hue in
  either theme, so the interface never tints how the artwork reads.
- **Infinite canvas.** Wheel to zoom, Space-drag or middle-drag to pan. Let go of a pan while it is still
  moving and the board runs on a little before it settles. Undo and redo ease pieces back to where they
  were instead of jumping. Both are skipped when the system asks for reduced motion.
- **Images and video.** Drop files on the board, paste screenshots from the clipboard, or
  paste an image URL. Large images get a 2K preview so heavy boards stay fast; the
  original loads when you zoom in past the preview's resolution. Videos have a play
  button in the middle and a plain scrub bar on hover to drag through them where they sit, and show
  a still until they are played, so a board never opens on black rectangles. Every file is on the
  board the moment it is chosen, as a stand-in at its own shape, laid out in an even grid, and the view
  eases out to show them all if any landed out of sight. A stand-in shows a ring that counts all of the
  work (for a video: making the review copy, sending it, reading it for its timeline) at an even pace,
  and is only full when the file lands. If whoever was adding it leaves before it is done, what is
  left behind says so instead of waiting for ever. Double-click a corner handle of a selected image or
  video and it goes back to the size it was added at, the corner across from the handle staying put.
- **Review copies of video.** Every video is re-encoded in the browser before it is uploaded: H.264
  MP4 (VP9 WebM where the browser cannot encode H.264), 1080p at most, at most 12 Mbps, audio kept, and a
  key frame every quarter of a second. A browser can only show a frame by decoding from the key frame before
  it, and renders and camera files often have one every few seconds, so stepping or scrubbing
  backwards through them stalls; through the review copy it is instant in both directions.
- **The originals, kept and given back.** The file a video was made from is uploaded too, behind the
  review copy and behind anything else the board is waiting for; the video says so in its corner until
  it is there. A selected image or video, or the one that is open, downloads as it was uploaded, and
  the download button in the bar brings every image and video on the board down as one zip (a download
  that is cut off carries on where it stopped). A video from before originals were kept, or one larger
  than `WIPBOARD_MAX_UPLOAD_MB`, comes down as its review copy, and the board says which. People
  holding a read-only link are offered neither.
- **Board settings.** The sliders button in the bar opens a small panel for what is particular to a
  board: whether every image and video shows its file name (the same for everyone on the board, and
  kept with it), and the way to its sharing, its files and its activity.
- **Activity, and going back.** The clock in the bar lists who opened a board and who changed it,
  newest first; the same thing done again within ten minutes is one line. Under it are snapshots:
  before each round of changes (whatever follows ten quiet minutes) the board is kept as it was, the
  last forty times, and any of them can be put back for everyone. What is replaced is kept as one more
  snapshot, so putting back can itself be undone. A snapshot is the board's items packed small (about
  13 KB for a board of thirty pieces); the files stay where they are. Putting one back moves what is
  on the board only: notes, and versions in a project's catalogue, stay as they are.
- **Frame-accurate video.** Each video knows its frame rate, read from the file when it is added. `,` and `.` step one frame
  (with Shift, one second), Space or K plays and pauses, M turns the sound on and off,
  and scrubbing lands on whole frames. Click the time on a video to switch between minutes and seconds,
  the frame number and a timecode; the choice is remembered per browser. Starting to draw or comment
  on a playing video stops it on the frame showing. Whoever follows you sees exactly the frame you stop on.
- **The viewer.** Double-click an image or video (or tap it on a phone) and it opens in the player,
  the same one that opens versions from a project's catalogue (`public/viewer.js`). It is laid
  out like a review tool: the rest of the board is hidden behind a plain backdrop, every image and
  video on the board runs down the left edge as a strip of small numbered thumbnails, the comments on
  the open piece sit in a panel on the right, and under a video is its timeline. The bar across the
  top becomes the viewer's: the piece's name, the way to the next and the one before, its zoom, and
  Done. Nothing else lies over the piece. The comments fold away and back with the tab on their edge
  (Shift+C), so the piece can have the whole width. Esc, Done or the board's name in the bar closes it
  and the board comes back where it was. It opens to look at: a drag moves the picture, and nothing is
  drawn until the pen beside the comment box is turned on (or P), as in Frame.io. With the pen on, its
  colours and the eraser show above the box, and sending the comment turns it off again. Zoom in with
  the wheel or a pinch and move around with a drag, a right-drag, Space and a drag, or
  the middle button (two fingers on a phone); the view never zooms out past the piece or wanders off
  it onto the board. The zoom button in the bar switches between fitting the screen and actual size,
  and zooming in on a large image loads its original. What is drawn belongs to the piece, so it moves
  and scales with it, and everyone who has it open sees it live. The laser (L, and L or Esc again to
  put it away) still points for everyone. Somebody holding a link has no pen.
- **One meaning per key.** In the viewer the arrow keys always go to the next or previous image or
  video (so do a click in the strip, a swipe, or, on a window too narrow for the strip, the arrows in the bar), in the order the board reads:
  frame by frame, rows first and then left to right, with loose media taking its place among the
  frames. They never scrub a video and never nudge anything in there; out on the board they nudge the
  selection. Moving through a video has its own keys (`,` and `.`), the same in the viewer and for a
  video selected on the board.
- **The timeline.** A project's Timeline (in the sidebar, or above the catalogue) plays every shot in
  order, sequence by sequence, in the player, as an edit: the newest version of each (of any task, or
  of one), one into the next. The next shot is loaded while one plays, so the cut to it is clean. In
  place of the side strip, the bar under the picture holds every shot as a clip as long as it lasts,
  with its still and where each sequence begins; dragging along it moves through the whole run, and the
  time is the run's, in seconds, frames or timecode as everywhere else. The player's bar picks all
  sequences or one, and the task; both are remembered. The arrows step from shot to shot, Space plays
  and pauses, loop goes round to the first shot, and what is written is about the shot under the
  playhead, on its version, like any other comment. Stills hold for three seconds. The shot on screen
  and its version are written over the picture and in the bar, and each clip in the strip says its
  shot. Shots with nothing filed (of the task chosen) are there as a slate, held like a still, with no
  comments, as they have no version to be on; "Filed shots only" leaves them out.
- **Setting a project up.** "Add assets, sets & shots" above the catalogue takes names, typed or pasted
  one a line, each an asset, a set or a shot by its shape (or all of one kind, as chosen), and a run of
  shots from a sequence and its numbers (kilo, 10 to 200 by 10). They are in the catalogue and the
  sidebar at once, with nothing filed yet.
- **Artists and CC.** An asset, set or shot's page names its artists and who else is cc'd, picked from
  everyone the app knows (who signed in, filed, wrote a note or was named before) or typed. Its card
  shows its artists.
- **For you.** Home opens on what is relevant to you: versions filed and notes written by others, in
  the last two weeks, on the assets, sets and shots you are an artist on or cc'd on (click one to open
  it in the player), and those assets, sets and shots themselves. Signed in, you are who you signed in
  as; otherwise, the name you gave.

Names are read by the project's naming preset. The one there is follows the Myreze styleguide:
`_` separates parts, `-` joins words, all lower case. An asset is `char-`, `prop-`, `env-`, `veh-` or
`fx-` something, a set is `set-` something, a shot is `<sequence>-<number>` (`kilo-0010`). A file named
`<context>_<task>[_<descriptor>]_<artist>_v###` (`kilo-0010_anim_erik_v012.mov`) says all of it. The
rules are in `public/naming.js`, shared by the server and the pages.

## Data and backup

Everything lives in `data/` next to the server:

| Path            | Contents                                                        |
| --------------- | --------------------------------------------------------------- |
| `data/wipboard.db` | Boards, their items and snapshots, folders, projects' catalogues (assets, sets, shots and their versions) and every note, in one SQLite database (with `-wal` and `-shm` files beside it while the server runs) |
| `data/uploads/` | Uploaded media, named by content hash (duplicates stored once): pictures, videos' review copies, and the files those were made from |
| `data/backups/` | A copy of the database made each day the server runs; the last seven are kept |
| `data/.session-secret` | Signs the sign-in cookies. Made on first start with a sign-in mode; keep it private |

Changes are written 0.8 s after the last one, and only what changed is written. Everything still
unsaved is written when the server is stopped (Ctrl+C, `stop.bat`, or the host shutting it down).
A board nobody has had open for five minutes is let go of from memory and read back when someone
opens it, so the number of old boards does not slow the server down.

**Back up** by copying `data/uploads/` and the newest file in `data/backups/`, or stop the server
and copy the whole `data` folder. Copying `wipboard.db` while the server runs can catch it halfway
through a write; the files in `data/backups/` are always whole.

**Updating from before projects** moves every board's comments into the notes table and renames the
boards' history to snapshots, once, the first time the server starts. A copy of the database as it was
is put in `data/backups/` first (`wipboard-before-catalogue-<time>.db`).

**Deleted boards** are kept, only hidden. To bring one back, stop the server and run
`node scripts/restore-board.js` to list them, then `node scripts/restore-board.js <board id>`. It
comes back at the top level of its workspace.

## Searching across boards

Every item on every board is indexed by what it is, what it is called, which frame holds it and which
uploaded file it shows, so questions across boards are quick. It can be asked directly.
`GET /api/catalog` takes any of:

| Parameter | Finds |
| --------- | ----- |
| `type`    | `frame`, `image`, `video`, `note`, `text`, `block`, `stroke`, or several: `image,video` |
| `name`    | Items called exactly this, ignoring case and spacing: a frame's title, a file's name, a note's text |
| `in`      | Items inside a frame called this |
| `q`       | Words anywhere in what items are called or say; the last word may be the start of one |
| `media`   | Items showing this uploaded file (its name in `data/uploads/`) |
| `board`   | Items on this board |
| `limit`   | At most this many (200 unless set, 1000 at most) |

For example `/api/catalog?type=frame&name=desk` is every frame titled "Desk" on every board, and
`/api/catalog?in=desk&type=image,video` is every image and video inside one. Each result has the
item, its board, the frame it is in, when it was added and by whom. `GET /api/catalog/media/<file>`
describes an uploaded file (its size, original name, size in pixels, length and frame rate, who
uploaded it) and lists every board it is on. Only boards in workspaces the person asking can see are
searched, and deleted boards never are.

A project's catalogue has its own: `GET /api/projects/<folder>` (its assets, sets and shots),
`GET /api/entities/<id>` (one of them, every version and every note), `GET`, `PATCH` and `DELETE
/api/versions/<id>` (`PATCH` takes `entity`, `task`, `number`, `artist`, `descriptor`, `hidden`, or
`{ "deleted": false }` to bring a deleted one back), and `POST /api/projects/<folder>/versions` to file
versions (each file may say its own `entity`, `task` and `number`; the catalogue's `tops` says the
highest number each task of each entity has reached). `POST /api/projects/<folder>/entities` takes
`{ "names": [...], "tier" }` to set many up at once; `PATCH /api/entities/<id>` takes `name`, `tier`,
`artists` and `cc`. `GET /api/people` lists the names the app knows, and `GET /api/feed?name=` is
Home's For you. `GET /api/projects/<folder>/timeline?task=` lists the shots in order with their newest
version.

## Settings

Environment variables, or lines in a `.env` file next to `server.js`. All optional:

| Variable                 | Default  | Meaning                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `PORT`                   | `4680`   | Port to listen on                        |
| `HOST`                   | `0.0.0.0`| Interface to bind (`127.0.0.1` = local only) |
| `WIPBOARD_DATA`          | `./data` | Where boards and uploads are stored      |
| `WIPBOARD_MAX_UPLOAD_MB` | `1024`   | Largest accepted file. A video's original above this is not kept, only its review copy |
| `AUTH_MODE`              | `none`   | Who gets in, see above. Its own settings are listed in [DEPLOY.md](DEPLOY.md) |

## Good to know

- **Without `AUTH_MODE` there are no accounts or passwords.** Anyone who can reach the server can
  open, edit and delete every board. Run it that way on a trusted studio network or behind a VPN,
  never on the open internet; for anything else pick a sign-in mode.
- **Video must be something the browser can decode**: H.264 or HEVC MP4/MOV, or WebM. ProRes and
  DNxHD are rejected with a message; export an H.264 file instead. The review copy is made in the
  browser (Chrome, Edge and Safari do it well); where a browser cannot, the file is uploaded as it is
  and scrubbing backwards through it may be slow.
- **Images must be browser formats**: PNG, JPEG, WebP, GIF, AVIF, BMP, SVG. EXR, TIFF and
  PSD are not supported.
- Two people editing the same property of the same item at the same moment: the last
  write to reach the server wins, and everyone converges on it.
- Uploaded files are never deleted automatically, even when the item is removed from a
  board (undo and other boards may still reference them).

## Layout

```
server.js          HTTP + WebSocket server, boards in memory
store.js           The database: boards, items, folders, projects' catalogues and notes
notifications.js   What each person is told about, worked out from the notes
auth.js            Who is asking: the four sign-in modes
public/board.js    The canvas: rendering, input, sync, following
public/viewer.js   The player: one piece at a time, its strip, timeline, comments and drawings; used by boards and the catalogue
public/ingest.js   Bringing media in: review copies of video, originals, timeline strips, stills; used by boards and the catalogue
public/home.js     Board list, and a project's catalogue
public/naming.js   How file names are read for the catalogue (shared with the server)
public/common.js   Shared helpers
public/login.html  Sign-in page (password and Google modes)
public/style.css   All styling
scripts/           restore-board.js: bring back a deleted board
test/              npm test: sign-in, uploads, live sync, workspaces, links, the database, catalogue, versions, notes and notifications
```
