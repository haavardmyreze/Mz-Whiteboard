# Wipboard

Shared reference and work-in-progress boards for a creative team, in the spirit of
Milanote and PureRef. One machine runs the server; everyone else opens a board in their
browser. Built for standup reviews: pin up stills and playblasts, group them into frames,
then present the board while everyone's view follows yours.

All media stays on the machine that runs the server. Nothing is sent to a cloud service.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer.

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
- **Infinite canvas.** Wheel to zoom, Space-drag or middle-drag to pan.
- **Images and video.** Drop files on the board, paste screenshots from the clipboard, or
  paste an image URL. Large images get a 2K preview so heavy boards stay fast; the
  original loads when you zoom in past the preview's resolution. Videos have a play
  button in the middle and a scrub bar on hover. Heavy video is compressed in the browser before
  upload (H.264 MP4, 1080p at most, about 8 Mbps, audio kept) so nobody uploads gigabytes; light
  files go up untouched, and holding Shift while dropping uploads the original as it is.
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
- **Comments.** Drag the Comment tool from the strip onto an image, video, note or heading and
  drop it where on it the comment belongs (it also works on an opened image). Comments are
  always on one piece of content, show as numbered pins that follow it, and start a thread that
  anyone can reply to or resolve. On a video the comment remembers the moment it was left on,
  and clicking it jumps there. The Comments button in the top bar (Shift+C) lists every message
  oldest first. Who wrote a comment comes from the sign-in, not from the browser. Comments go
  when the thing they are on is deleted, and come back with it on undo.
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

## Hosting it

For a team that is not on one network, deploy it to Google Cloud Run behind Google sign-in. A
`Dockerfile`, a health check, piece-by-piece uploads and an email allow list are included; see
[DEPLOY.md](DEPLOY.md) for the commands, the settings and why it should run as a single instance.

## Folders

The board list is organised in folders. Drag a board or folder onto a folder, or onto a
name in the path above the list, to move it; the `...` menu on each card has Rename,
"Move to..." and Delete. Deleting a folder only removes the folder: its boards and
subfolders move up one level.

## Data and backup

Everything lives in `data/` next to the server:

| Path            | Contents                                                        |
| --------------- | --------------------------------------------------------------- |
| `data/boards/`  | One JSON file per board                                         |
| `data/folders.json` | The folder tree for the board list                          |
| `data/uploads/` | Uploaded media, named by content hash (duplicates stored once)  |
| `data/trash/`   | Boards deleted from the board list, kept for manual recovery    |

Back up by copying the `data` folder. To restore a deleted board, stop the server, move
its file from `data/trash/` to `data/boards/`, rename it to `<board id>.json` (the id is
the part of the file name before the dash and timestamp) and start the server again.

## Settings

Environment variables, all optional:

| Variable                 | Default  | Meaning                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `PORT`                   | `4680`   | Port to listen on                        |
| `HOST`                   | `0.0.0.0`| Interface to bind (`127.0.0.1` = local only) |
| `WIPBOARD_DATA`          | `./data` | Where boards and uploads are stored      |
| `WIPBOARD_MAX_UPLOAD_MB` | `1024`   | Largest accepted file                    |

## Good to know

- **There are no accounts or passwords.** Anyone who can reach the server can open, edit
  and delete every board. Run it on a trusted studio network or behind a VPN, not on the
  open internet.
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
server.js          HTTP + WebSocket server, persistence
public/board.js    The canvas: rendering, input, sync, presenting
public/home.js     Board list
public/common.js   Shared helpers
public/style.css   All styling
```
