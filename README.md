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

- **Infinite canvas.** Wheel to zoom, Space-drag or middle/right-drag to pan.
- **Images and video.** Drop files on the board, paste screenshots from the clipboard, or
  paste an image URL. Large images get a 2K preview so heavy boards stay fast; the
  original loads when you zoom in past the preview's resolution.
- **Notes, headings, frames, pen, arrows.** Frames are named sections; dragging one
  carries its contents.
- **Live collaboration.** Everyone sees edits, cursors and selections as they happen.
- **Present mode.** Press *Present* and everyone on the board follows your view. Arrow
  keys step through frames in reading order (or through the media if there are no
  frames). The laser pointer (L) is visible to everyone. Video you play or scrub plays for
  everyone following you.
- **Follow anyone.** Click a teammate's avatar to follow their view outside a
  presentation. Pan or zoom yourself to stop.
- **Tidy.** Select a pile of images and press Ctrl+P to pack them into a neat grid.
- **Undo / redo** per person, copy and paste between boards, duplicate with Alt-drag.

Press `?` on a board for the full shortcut list.

## Data and backup

Everything lives in `data/` next to the server:

| Path            | Contents                                                        |
| --------------- | --------------------------------------------------------------- |
| `data/boards/`  | One JSON file per board                                         |
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
| `WIPBOARD_MAX_UPLOAD_MB` | `2048`   | Largest accepted file                    |

## Good to know

- **There are no accounts or passwords.** Anyone who can reach the server can open, edit
  and delete every board. Run it on a trusted studio network or behind a VPN, not on the
  open internet.
- **Video must be browser-playable**: H.264 MP4 or WebM. ProRes and DNxHD `.mov` files are
  rejected with a message; export an H.264 review copy instead.
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
