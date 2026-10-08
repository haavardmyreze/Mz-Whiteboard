# Wipboard

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
  a still until they are played, so a board never opens on black rectangles. A video on its way in
  shows a ring that counts all of the work (making the review copy, sending it, reading it for its
  timeline) at an even pace, and is only full when the video lands. If whoever was adding it leaves
  before it is done, what is left behind says so instead of waiting for ever.
- **Review copies of video.** Every video is re-encoded in the browser before it is uploaded: H.264
  MP4 (VP9 WebM where the browser cannot encode H.264), 1080p at most, about 10 Mbps, audio kept, and a
  key frame every half second. A browser can only show a frame by decoding from the key frame before
  it, and renders and camera files often have one every few seconds, so stepping or scrubbing
  backwards through them stalls; through the review copy it is instant in both directions.
- **Frame-accurate video.** Each video knows its frame rate, read from the file when it is added. `,` and `.` step one frame
  (with Shift, one second), Space or K plays and pauses, M turns the sound on and off,
  and scrubbing lands on whole frames. Click the time on a video to switch between minutes and seconds,
  the frame number and a timecode; the choice is remembered per browser. Starting to draw or comment
  on a playing video stops it on the frame showing. Whoever follows you sees exactly the frame you stop on.
- **The viewer.** Double-click an image or video (or tap it on a phone) and it opens on its own, laid
  out like a review tool: the rest of the board is hidden behind a plain backdrop, every image and
  video on the board runs down the left edge as a strip of small numbered thumbnails, the comments on
  the open piece sit in a panel on the right, and under a video is its timeline. The bar across the
  top becomes the viewer's: the piece's name, the way to the next and the one before, its zoom, and
  Done. Nothing else lies over the piece. The comments fold away and back with the tab on their edge
  (Shift+C), so the piece can have the whole width. Esc, Done or the board's name in the bar closes it
  and the board comes back where it was. There is no tool strip in here, because there is one tool:
  a press on the piece is a brush stroke (right-drag rubs strokes out, and the brush's colours are
  beside the comment box). Zoom in with the wheel or a pinch and move around with Space and a drag, or
  the middle button (two fingers on a phone); the view never zooms out past the piece or wanders off
  it onto the board. The zoom button in the bar switches between fitting the screen and actual size,
  and zooming in on a large image loads its original. What is drawn belongs to the piece, so it moves
  and scales with it, and everyone who has it open sees it live. The laser (L, and L again for the
  brush) still points for everyone. Somebody holding a link has the hand instead of the brush.
- **One meaning per key.** In the viewer the arrow keys always go to the next or previous image or
  video (so do a click in the strip, a swipe, or, on a window too narrow for the strip, the arrows in the bar), in the order the board reads:
  frame by frame, rows first and then left to right, with loose media taking its place among the
  frames. They never scrub a video and never nudge anything in there; out on the board they nudge the
  selection. Moving through a video has its own keys (`,` and `.`), the same in the viewer and for a
  video selected on the board.
- **The timeline.** Under an open video: play, a frame back, a frame on, the time, and a track to drag
  along, drawn as the video's picture and sound: bands of its colours with its loudness above them, on
  a dark bed in both themes so the colours read the same. Every comment has a small mark above the track in its writer's colour, at the moment it is
  about; click one to go there, and the comments open on it if they were folded away. Comments about
  the same moment share one mark with their number on it, and each click goes to the next of them. Nothing lies over the picture while it is open.
- **The board's videos are fetched ahead.** Once a board is open its videos are fetched quietly in
  the background, one at a time in the order the viewer steps through them, and kept on the
  computer's disk (up to 4 GB, the longest unused making room). Opening one then finds it there
  already, at once, this time and every time after, which is what makes scrubbing quick over the
  internet and not only on the office network. Whatever is opened has the line to itself and never
  waits for this. It needs an https address (or the server's own machine); on a plain http address,
  or with the browser asked to save data, nothing is fetched ahead. A small ring in the bar fills as
  the videos are cached and turns to a tick once the whole board is; hover or press it and it says so.
  A video that is more than the browser can process (a very large frame in Safari, say) is not added:
  a message names it and says which browsers to add it from instead, rather than putting the bare
  file on the board. (On a plain http address, where no browser can make review copies, videos still
  go up as they are.)
- **Scrubbing that does not wait for the network.** A browser keeps only a little of a paused video
  in hand and fetches the rest as it is asked for, so a scrub keeps landing on moments it has not got,
  which drags badly over a tunnel or any slow link. A video that is opened is therefore fetched whole,
  in one go, and then played from memory, without losing its place. The track shows it: lighter where
  the video is loaded, and all the way along once it is held whole. Videos over 400 MB stay on the
  server, and the ones opened longest ago go back to it once a gigabyte is held.
- **Uniform sizes.** New images come in at the same width, a new frame starts at the width it
  needs to hold one such image and a new colour block at the same width as a frame, so it sits flush above one as its header, notes and headings at fixed sizes
  and the brush at a fixed width (small while an image is open, so annotating stays fine), whatever the zoom was when you made them. Text is sized
  by its level (H1, H2, H3, Text), not by dragging.
- **Headings and notes.** Pick H1, H2, H3 or plain text before placing, or change the
  level of selected text from the floating toolbar.
- **Brush.** The pen is pressure sensitive on a tablet and speed sensitive with a mouse:
  slow strokes are thick, quick flicks thin out, and strokes taper at the end. Right-drag
  while drawing to erase: every drawing the stroke touches is removed. Drawings always sit above
  the content and never change a frame's size, but they attach to the piece they are drawn on and
  follow it when it moves, scales, is duplicated or deleted.
- **Headers and colour blocks.** Every frame has a header with its title and an item count; colour a
  frame and its header band takes the colour while the card stays neutral. Colour blocks (B) are
  free-standing banners for headings, resizable and left- or centre-aligned.
- **Frames that fit their contents.** Drag an item onto a frame and the frame wraps it;
  an item joins once more than half of it is over the frame, and the frame grows to wrap it.
  Once in, it stays in until it has been pulled completely out of the frame, and the frame closes up again. Drawing a frame around
  loose items gathers them. Resizing a frame by hand switches its fit-to-content button
  off; the toolbar button turns it back on.
- **Comments.** Comments are made in the viewer, on the image or video that is open: type in the box
  at the bottom of the panel (C goes there) and press Enter. On a video a comment is about the frame
  showing, which the chip under the box says (click the chip to make it about the whole video
  instead); starting to type stops the video there. Each comment starts a thread that anyone can
  reply to or resolve. Out on the board, whatever has comments carries a small chip in its corner:
  the number of open threads, or a tick once they are all resolved; click it to open the piece with
  its comments beside it. Comments belong to the viewer, so there is no button for them out on the
  board; Shift+C there still lists every thread on the board, and picking one opens what it is about. Who wrote a comment comes from the sign-in, not from the
  browser. Comments go when the thing they are on is deleted, and come back with it on undo, still in
  their author's name whoever pressed undo.
- **Drawings go with comments.** To point at something, circle it. A stroke on the open piece
  belongs to the comment being written, and starts one if none is: the box takes the keyboard, so
  draw, type what it is about, Enter. On a video the comment is about the frame that was drawn on,
  and its drawing shows only while the video is stopped there. Only the drawing of the comment being
  read is on the picture: pick another thread and its drawing takes the other's place, so two
  comments about the same frame never draw over one another. Whoever follows you reads the thread
  you are reading, and sees its drawing with you. What is drawn for a comment is part
  of the review, not of the board: it shows in the viewer only, never out on the board, and a copy of
  the piece does not take it along. Deleting a thread deletes its drawing. A drawing whose comment
  was never sent is not thrown away: it stays on the piece as an ordinary drawing, there on every
  frame and out on the board too.
- **Smart snapping.** Dragged items snap to the edges and centres of their neighbours and
  to equal gaps, with guide lines. Toggle with S, hold Ctrl while dragging to bypass.
- **Live collaboration.** Everyone sees edits, cursors and selections as they happen.
- **Follow anyone.** Click a teammate's picture to follow their view, into the viewer and back
  out with them, with their video playing, pausing and stepping on your screen as on theirs. Pan,
  zoom or open something yourself to stop. The laser pointer (L) is visible to everyone.
- **Notifications.** The bell on the board list collects what concerns you from every board: replies
  in threads you wrote in, comments on what you added and on boards you made, and comments that
  @mention your name. Opening one goes straight to the comment. What you have read is remembered
  for you, on any device.
- **Phones.** One finger moves the board, two zoom, a tap opens an image or video and a swipe goes
  to the next. On the board the tools sit along the bottom. In the viewer one finger draws on the
  piece, a swipe beside it goes to the next, a video's timeline sits at the bottom, and the comments
  come up as a sheet from the bottom.
- **Tidy.** Select some images and press Ctrl+P. A vertical line becomes an evenly sized
  column, a horizontal line a row, and a grid keeps its number of columns. Select two or more
  frames and the same shortcut tidies the frames themselves, each as one piece with its contents and
  drawings, keeping their own sizes.
- **Undo / redo** per person, copy and paste between boards, duplicate with Alt-drag.

Press `?` on a board for the full shortcut list.

## Who gets in

Out of the box there is no sign-in: anyone who can reach the server can open, edit and delete every
board, which suits a trusted studio network. Set `AUTH_MODE` to change that:

| `AUTH_MODE` | Who gets in |
| ----------- | ----------- |
| `none` (default) | Everyone who can reach the server. They pick a display name |
| `password`  | Everyone who knows the one shared password (`SITE_PASSWORD`). They type a name with it |
| `google`    | Google accounts on an allow list. The app does the sign-in itself |
| `iap`       | Whoever Google Cloud's Identity-Aware Proxy lets through |

Signed in, everybody shares the **Myreze** workspace and each person also has a **Personal** one that
only they can see.

### Admin area

With `google` or `iap` sign-in, the people named in `ADMIN_EMAILS` get an **Admin** link on the home
page. At `/admin` they see everyone who has signed in, add people ahead of time, make other admins, put
people in groups, and give people or groups a role (viewer, commenter, editor or manager) on boards and
folders in the Myreze workspace. These groups and permissions are recorded but **not enforced yet**:
who gets in is still decided by the sign-in, and everyone signed in sees the whole Myreze workspace.
With the shared password (`password`) the admin area stays closed, as that sign-in does not say who
people are. With no sign-in at all (`none`, for local use) it opens on the machine that runs the server
and nowhere else, so it can be looked at and filled in before a sign-in is set up.

On a board, **Share** turns on a link that needs no sign-in, and sets what its holders can do: only
look, also read the team's comments, or also comment (under a name they type, without resolving or
deleting anything). A link can end after a day, a week or a month, can be replaced by a new one
that stops the old one at once, and can be turned off. Changing any of it applies to whoever is
watching straight away. The settings,
and how to reach the server from outside the building, are in [DEPLOY.md](DEPLOY.md); copy
`.env.example` to `.env` to set them.

## Hosting it

For a team that is not on one network, either run it from one PC behind a tunnel with a shared
password, or deploy it to Google Cloud Run behind Google sign-in. A `Dockerfile`, a health check,
piece-by-piece uploads and an email allow list are included; see [DEPLOY.md](DEPLOY.md) for the
commands, the settings and why it should run as a single instance.

## Folders

The board list is organised in folders. Drag a board or folder onto a folder, or onto a
name in the path above the list, to move it; the `...` menu on each card has Rename,
"Move to..." and Delete. Deleting a folder only removes the folder: its boards and
subfolders move up one level.

## Data and backup

Everything lives in `data/` next to the server:

| Path            | Contents                                                        |
| --------------- | --------------------------------------------------------------- |
| `data/wipboard.db` | Boards, their items, folders and the catalogue, in one SQLite database (with `-wal` and `-shm` files beside it while the server runs) |
| `data/uploads/` | Uploaded media, named by content hash (duplicates stored once)  |
| `data/backups/` | A copy of the database made each day the server runs; the last seven are kept |
| `data/legacy/`  | Boards and folders from before the database, as they were. They were read in once and are no longer used |
| `data/.session-secret` | Signs the sign-in cookies. Made on first start with a sign-in mode; keep it private |

Changes are written 0.8 s after the last one, and only what changed is written. Everything still
unsaved is written when the server is stopped (Ctrl+C, `stop.bat`, or the host shutting it down).
A board nobody has had open for five minutes is let go of from memory and read back when someone
opens it, so the number of old boards does not slow the server down.

**Back up** by copying `data/uploads/` and the newest file in `data/backups/`, or stop the server
and copy the whole `data` folder. Copying `wipboard.db` while the server runs can catch it halfway
through a write; the files in `data/backups/` are always whole.

**Deleted boards** are kept, only hidden. To bring one back, stop the server and run
`node scripts/restore-board.js` to list them, then `node scripts/restore-board.js <board id>`. It
comes back at the top level of its workspace.

**Upgrading from the JSON files** (step by step in [UPGRADING.md](UPGRADING.md)). Versions before the database kept each board in
`data/boards/*.json` and the folders in `data/folders.json`. Stop the server and run
`node scripts/import-json.js` once: it reads them into the database and moves the files to
`data/legacy/`. The server says so at startup if it finds any. A board deleted back then is still a
JSON file in `data/trash/`; copy it into `data/boards/` as `<board id>.json` and run the script again.

## The catalogue

Every item on every board is indexed by what it is, what it is called, which frame holds it and which
uploaded file it shows, so questions across boards are quick. For now the catalogue is there for the
features that will use it, and can be asked directly. `GET /api/catalog` takes any of:

| Parameter | Finds |
| --------- | ----- |
| `type`    | `frame`, `image`, `video`, `note`, `text`, `block`, `comment`, `stroke`, or several: `image,video` |
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

## Settings

Environment variables, or lines in a `.env` file next to `server.js`. All optional:

| Variable                 | Default  | Meaning                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `PORT`                   | `4680`   | Port to listen on                        |
| `HOST`                   | `0.0.0.0`| Interface to bind (`127.0.0.1` = local only) |
| `WIPBOARD_DATA`          | `./data` | Where boards and uploads are stored      |
| `WIPBOARD_MAX_UPLOAD_MB` | `1024`   | Largest accepted file                    |
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
store.js           The database: boards, items, folders and the catalogue
notifications.js   What each person is told about, worked out from the comments
auth.js            Who is asking: the four sign-in modes
public/board.js    The canvas: rendering, input, sync, the viewer, following
public/home.js     Board list
public/common.js   Shared helpers
public/login.html  Sign-in page (password and Google modes)
public/style.css   All styling
scripts/           restore-board.js: bring back a deleted board; import-json.js: boards from before the database
test/              npm test: sign-in, uploads, live sync, workspaces, links, the database, catalogue and notifications
```
