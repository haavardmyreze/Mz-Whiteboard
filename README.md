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
- **Home.** Three things, and nothing else. What you pinned (boards, folders, projects, shots) along
  the top. Updates: in the last two weeks, comments on your work (yours too, as "You", never marked
  new), new versions of it by others, and new versions of what you are cc'd on, newest first; what came since you last marked them read is
  marked, and All, Comments and New versions narrow it. Click one to open it in the player. Beside it,
  My work: the assets, sets and shots you are an artist on or have filed versions of. Every card is the
  catalogue's own: it scrubs under the pointer and plays the latest. Pin from a card's `...` menu or
  the star beside where you are; pins and what is read are kept by this browser.
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
- **Changing many at once.** Select, above the catalogue, picks assets, sets and shots with a click
  (Shift and a click for every one between); the bar at the foot has Select all, Clear and Edit. Edit
  changes them together: artists and people cc'd added, taken off or set outright, and what they are
  (assets, sets or shots), showing who each field has now. What is left alone stays as each has it, and
  all of them change or none do. Esc, or Done, stops selecting.
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
