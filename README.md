# Wipboard

Shared reference and work-in-progress boards for a creative team, in the spirit of
Milanote and PureRef. One machine runs the server; everyone else opens a board in their
browser. Built for standup reviews: pin up stills and playblasts, group them into frames,
then present the board while everyone's view follows yours.

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
  button in the middle and a scrub bar on hover. Heavy video is compressed in the browser before
  upload (H.264 MP4, 1080p at most, about 8 Mbps, audio kept) so nobody uploads gigabytes; light
  files go up untouched, and holding Shift while dropping uploads the original as it is.
- **Frame-accurate video.** Each video knows its frame rate, read from the file when it is added (videos
  added before that learn it the first time someone opens or plays them). `,` and `.` step one frame,
  and scrubbing lands on whole frames. Click the time on a video to switch between minutes and seconds,
  the frame number and a timecode; the choice is remembered per browser. Open a video, pause on a frame
  and draw or write on it: what you make belongs to that frame and only shows when the video is stopped
  there, like frame annotations in a review tool. Starting to draw or comment on a playing video stops
  it on the frame showing. The timeline shows a mark for every comment and every drawn-on frame; click
  one to go there. When presenting, the people following see exactly the frame you stop on.
- **Open an image and draw on it.** Double-click an image: the rest of the board dims and
  you can annotate it with the brush or arrows. The drawing belongs to the image, so it
  moves and scales with it, and everyone sees it live. Esc or Done closes it and the view returns to where it was.
  While one is open, the arrow keys (or the arrows in the bar above it) go to the next or previous image or video,
  in the order the board reads: frame by frame, rows first and then left to right, with loose media taking its place among the frames.
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
- **Comments.** Pick the Comment tool (C) and click an image, video, note or heading where the
  comment belongs, or drag the tool from the strip and drop it there (both also work on an opened image). Comments are
  always on one piece of content, show as numbered pins that follow it, and start a thread that
  anyone can reply to or resolve. On a video the comment remembers the frame it was left on,
  and clicking it jumps there. The Comments button in the top bar (Shift+C) lists every message
  oldest first. Who wrote a comment comes from the sign-in, not from the browser. Comments go
  when the thing they are on is deleted, and come back with it on undo, still in their author's name
  whoever pressed undo.
- **Smart snapping.** Dragged items snap to the edges and centres of their neighbours and
  to equal gaps, with guide lines. Toggle with S, hold Ctrl while dragging to bypass.
- **Live collaboration.** Everyone sees edits, cursors and selections as they happen.
- **Present mode.** Press *Present* and everyone on the board follows your view. Arrow
  keys step through frames in reading order (or through the media if there are no
  frames). The laser pointer (L) is visible to everyone. Video you play or scrub plays for
  everyone following you.
- **Follow anyone.** Click a teammate's avatar to follow their view outside a
  presentation. Pan or zoom yourself to stop.
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
only they can see. On a board, **Share** makes a view-only link that needs no sign-in. The settings,
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
comes back at the top level of its workspace. Boards deleted before the database are still in
`data/trash/` as JSON files: to bring one back, stop the server, copy it into `data/boards/` named
`<board id>.json` and start the server, which reads it in.

**Upgrading from the JSON files.** The first start of this version reads `data/boards/*.json` and
`data/folders.json` into the database and moves the files to `data/legacy/`. Nothing else is needed.

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
- **Video must be browser-playable**: H.264 MP4 or WebM. ProRes and DNxHD `.mov` files are
  rejected with a message; export an H.264 review copy instead. Compression runs in the browser
  (Chrome, Edge and Safari do it well); where a browser cannot, the file is uploaded as it is.
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
auth.js            Who is asking: the four sign-in modes
public/board.js    The canvas: rendering, input, sync, presenting
public/home.js     Board list
public/common.js   Shared helpers
public/login.html  Sign-in page (password and Google modes)
public/style.css   All styling
scripts/           restore-board.js: bring back a deleted board
test/              npm test: sign-in, uploads, live sync, workspaces, read-only links, the database and catalogue
```
