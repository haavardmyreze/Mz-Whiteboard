# Boards by Myreze

Shared reference and work-in-progress boards for a creative team, in the spirit of
Milanote and PureRef. One machine runs the server; everyone else opens a board in their
browser. Built for standup reviews: pin up stills and playblasts, group them into frames,
open them in a viewer that steps frame by frame, and comment where it matters.

All media stays on the machine that runs the server. Nothing is sent to a cloud service.

**In development.** The app is not used in production yet: all boards, uploads and catalogues are test
data, and a new version may not read what an older one stored. Start from a fresh data folder when it
does not.

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

- **Getting around.** There is no separate home page: the app opens on the workspace you were last in
  (Myreze to begin with), and the mark in the corner goes back to it. A sidebar on the left holds what
  you pinned (each a row that goes there), then each workspace with its folders and projects as a tree. A project opens to its
  Reviews (its boards, playlists and animatics, each under it), Catalogue and Versions, and the catalogue
  to its assets, sets and shots, the shots by
  sequence, each with a count. Only what you are in is open: the way to the page you are on is opened
  for you, and the rest close as you go elsewhere (an arrow opens a row for a look in the meantime). Rows
  with nothing in them show no count. Every page opens with its title, set large: the place you are in
  (kilo-0010). Above it, one small line says how you got there (Myreze / Kilo / Catalogue / Shots / kilo),
  each part a link. The star beside the title pins exactly what is there to the sidebar: a board's folder, a
  project, a sequence, a tier of the catalogue, the catalogue, Versions, or an asset, set or
  shot. On a narrow window the sidebar is a drawer, opened with the button at the left of the bar.
- **Pinning.** Pin from a card's `...` menu or the star beside where you are; pins are kept by this
  browser and listed in the sidebar until you unpin them.
- **Everything is an object, shown one way.** A board, a folder, an asset, set or shot and a version
  are all listed the way a file manager lists files, and every list (a workspace, a folder,
  the catalogue, Versions, an asset, set or shot's versions) can be shown three ways, chosen with the three
  buttons at the end of the page's title (or in Your account) and remembered per browser: as cards, as
  rows (a small still beside each name, many to a screen), or as a table. As cards, each is a print with
  its label: the picture square-cornered, as the work is judged, and its name and what is known of it
  beneath, with no box around it. A card says a version is a video, or a shot, only where the list
  holds other kinds too. A table has a row for
  each, one line high, like a compact row drawn out across the page: its still (or a folder's icon) at
  its left edge, scrubbing and playing as on a card, then its name, and in columns what its card says:
  a board's items and when it was edited; a folder's kind, boards and folders; an asset, set or shot's
  versions, artists and when the last was filed; and a version's as below. It is a plain table, its rows between hairlines, set as the
  catalogue is, under the same headings ("Shots 25", then each sequence, named as it is written), with
  its column headings staying in sight as the page scrolls; a narrower window
  leaves out what matters least first, and a phone keeps the still, the name and the menu. Each row is
  selected as its card is, and where things can be selected (boards and folders, the catalogue,
  versions) its box, there under the pointer, selects it. The code is one component (objectNode and
  objectList in `public/home.js`), with each kind saying only what it is made of.
- **One bar across the top, the same on every page.** The mark in the corner goes to all boards, and
  beside it is where you are, as a path: the board, and with an image or video open, the board and
  then the piece. On the right is what can be done there, ending in the one thing set in ink (New
  board, Share, Done). New board has a folder beside it, under its arrow. What is under the bar slides
  beneath it.
- **Dark by default, light on request.** Your account, and the sun/moon button on a board or in the
  player, switch theme, remembered per browser. Everything is set in Inter, served from this machine
  (`public/fonts`), so text measures the same on every screen and nothing is fetched from the internet,
  on one scale of sizes (the `--fs` tokens in `public/style.css`). The launch and the sign-in page set
  the name in Rift. The greys carry no hue in either theme, so the interface never tints how the artwork
  reads. What is chosen or on (the tool in hand, a switch) is set in ink. Blue is kept for what is
  selected or focused, the playhead and what is new, and red for going live and for deleting.
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
- **Phone copies.** A review copy is made for looking closely at a desk, so every video also gets a phone
  copy: the same frames at the same moments, at most 720p and about 2.5 Mbit/s, a fifth of the size or less
  (a 6-second 1080p test came down from 7.2 MB to 1.6 MB). Phones (a touch screen, and a small one) and
  browsers saving data or on a slow mobile line play and keep it instead, so it arrives several times
  sooner; everybody else plays the review copy. Nobody makes them by hand: any desk browser of the team
  that can make video and has a video without one on its page (a board, the catalogue, an animatic) makes
  it in the background, one at a time, never while a video is open or while presenting. The server makes
  sure only one browser makes each, and once it has one it is put on every board and every version that
  shows that file. A review copy already as light as a phone copy is its own. Following somebody (or
  watching a presentation) on a phone stays on the same frame as on the desk, as both copies have the same.
- **The originals, kept and given back.** The file a video was made from is uploaded too, behind the
  review copy and behind anything else the board is waiting for; the video says so in its corner until
  it is there. A selected image or video, or the one that is open, downloads as it was uploaded, and
  the download button in the bar brings every image and video on the board down as one zip (a download
  that is cut off carries on where it stopped). A video whose original was larger than
  `WIPBOARD_MAX_UPLOAD_MB` comes down as its review copy, and the board says which. People
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
  video selected on the board, and so has moving through a version's extras (`[` and `]`). Space plays and pauses even when a dropdown just used (which sequence,
  which view), a button or a link in the sidebar beside the timeline still has the keyboard: it lets
  go, and the player takes the key. A dropdown gives the keyboard back once something is picked from it.
- **The timeline.** Under an open video: play, a frame back, a frame on, the time, and a track to drag
  along, drawn as the video's picture and sound: bands of its colours with its loudness above them, on
  a dark bed in both themes so the colours read the same. Every comment has a small mark above the track in its writer's colour, at the moment it is
  about; click one to go there, and the comments open on it if they were folded away. Comments about
  the same moment share one mark with their number on it, and each click goes to the next of them. Nothing lies over the picture while it is open.
  The loop button beside the sound starts a video again from the top when it reaches the end; it is on
  unless turned off, and the choice is remembered per browser. A comment's frame leads its text.
- **The board's videos are fetched ahead.** Once a board is open its videos are fetched quietly in
  the background, one at a time in the order the viewer steps through them, and kept on the
  computer's disk (up to 4 GB, the longest unused making room). Opening one then finds it there
  already, at once, this time and every time after, which is what makes scrubbing quick over the
  internet and not only on the office network. Whatever is opened has the line to itself and never
  waits for this. It needs an https address (or the server's own machine); on a plain http address,
  or with the browser asked to save data, nothing is fetched ahead. A small ring in the bar fills as
  the videos are cached, with a count beside it ("2/5 cached"), and turns to a tick and "Cached" once
  the whole board is; hover or press it and it says more.
- **Videos are kept on this computer everywhere, not only on boards.** One cache serves every page
  (`public/media.js`): whatever video you open, in a board, the catalogue or an animatic, is
  kept, and is there at once the next time. Ahead of you, in this order, it also fetches an animatic's
  next few shots as it plays, the open board's videos, the videos the page you are on shows (the
  catalogue's cards, say), and the newest version of what you pinned. Your settings
  (your name at the top right) turn fetching ahead off, or either of boards and pinned. Up
  to 4 GB is kept; what was wanted longest ago makes room, never what the open board, the page or
  an animatic is showing, and when nothing more can be made room for, fetching ahead stops rather
  than throwing out what is wanted. A small service worker (`public/sw.js`) answers the pages' own
  video players from the kept copies, scrubbing included, so a card scrubbed on hover or an
  animatic's next shot plays from the disk too. What is kept is listed in IndexedDB, a record a video,
  and a lock for each file keeps two tabs from fetching the same one.
- **Seeing what is cached.** Every video card (in the catalogue, an asset's versions, the Versions
  list) has a badge in its top right corner: a green tick once it is cached on this computer, a
  ring filling while it comes, a cloud while it still plays from the server. The ring a board has in
  its bar is in the page's bar too, for whatever you are looking at: the cards of the page, or with an
  animatic open, the whole animatic ("3/12 cached", then "Cached"), which is fetched in full behind the
  next few shots. Pressed, it says how much of it is here, what is on its way, and how full the cache is.
  A video that is more than the browser can process (a very large frame in Safari, say) is not added:
  a message names it and says which browsers to add it from instead, rather than putting the bare
  file on the board. (On a plain http address, where no browser can make review copies, videos still
  go up as they are.) A review copy that was started and then gave up part way, or came out unreadable,
  is not taken as a "never": that is usually passing (a graphics card's decoder busy with the page's
  other videos, say), so it is tried again, three times in all, before anybody is told, and then
  "Try again" is offered: in the message on a board, and on the row in a catalogue's import strip.
- **Scrubbing that does not wait for the network.** A browser keeps only a little of a paused video
  in hand and fetches the rest as it is asked for, so a scrub keeps landing on moments it has not got,
  which drags badly over a tunnel or any slow link. A video that is opened is therefore fetched whole,
  in one go, and then played from memory, without losing its place. The track shows it: lighter where
  the video is loaded, and all the way along once it is held whole. Videos over 400 MB stay on the
  server, and the ones opened longest ago go back to it once a gigabyte is held.
- **Uniform sizes.** New images come in at the same width, a new frame starts at the width it
  needs to hold one such image and a new colour block at the same width as a frame, so it sits flush above one as its header, headings at fixed sizes
  and the brush at a fixed width (small while an image is open, so annotating stays fine), whatever the zoom was when you made them. Text is sized
  by its level (H1, H2, H3, Text), not by dragging. A note is made to be read where it is made: on a
  board zoomed out, a new note comes in larger, in a few steps, so its writing is near its usual size on
  screen; zoomed in, it is the usual note. A board opens where this browser left it, unless that was in a
  window of a very different width, when it opens on everything.
- **Headings and notes.** Pick H1, H2, H3 or plain text before placing, or change the
  level of selected text from the floating toolbar.
- **Brush.** The pen is pressure sensitive on a tablet and speed sensitive with a mouse:
  slow strokes are thick, quick flicks thin out, and strokes taper at the end. Right-drag
  while drawing out on the board, or pick the eraser beside the colours (E), to erase: every drawing the stroke touches is removed. Drawings always sit above
  the content and never change a frame's size, but they attach to the piece they are drawn on and
  follow it when it moves, scales, is duplicated or deleted.
- **Headers and colour blocks.** Every frame has a header with its title and an item count; colour a
  frame and its header band takes the colour while the card stays neutral. Colour blocks (B) are
  free-standing banners for headings, left- or centre-aligned. A block is always the same height: it is made wider or narrower from its sides, and keeps its height when drawn out or scaled with other things. Their colours are a painter's
  box, each named for its pigment (graphite, cadmium red, yellow ochre, burnt sienna, viridian,
  ultramarine, quinacridone violet, Payne's grey, ivory black), and a new block starts in graphite.
- **Frames that fit their contents.** Drag an item onto a frame and the frame wraps it;
  an item joins once more than half of it is over the frame, and the frame grows to wrap it.
  Once in, it stays in until it has been pulled completely out of the frame, and the frame closes up again. Drawing a frame around
  loose items gathers them. Resizing a frame by hand switches its fit-to-content button
  off; the toolbar button turns it back on.
- **Comments.** Comments are made in the viewer, on the image or video that is open: type in the box
  at the bottom of the panel (C goes there) and press Enter; the box then lets go of the keyboard, so
  the arrows and Space work the viewer again. What is half written stays with its piece: go on to the
  next and the box is empty, come back and it is there. On a video a comment is about the frame
  showing, which the chip under the box says (click the chip to make it about the whole video
  instead); starting to type stops the video there. Each comment starts a thread that anyone can
  reply to or resolve. Type @ to be offered the people on the board, and pick one with the arrows and
  Enter; their name is marked in the comment, and they are told about it. Your own comments can be
  edited (the pencil beside them); an edited comment says so. Out on the board, whatever has comments carries a small chip in its corner:
  the number of open threads, or a tick once they are all resolved; click it to open the piece with
  its comments beside it. Comments belong to the viewer, so there is no button for them out on the
  board; Shift+C there still lists every thread on the board, and picking one opens what it is about. Who wrote a comment comes from the sign-in, not from the
  browser. Comments are kept apart from the board, as notes: taking a piece off the board takes its
  comments out of sight, and undo brings them back, still in their author's name whoever pressed undo.
  Only deleting a thread deletes it, and only whoever wrote a comment deletes it (a comment somebody
  holding a link wrote can be deleted by anyone on the board). Deleting the first comment of a thread
  deletes its replies with it, and undo brings them all back. On a piece filed as a version (see Projects, below) the comments
  belong to the version, so they are there on every board the version is on. Which board a comment was
  made on is kept with it, but not shown: what it is about is the version.
- **Drawings go with comments.** To point at something, turn on the comment's pen and circle it. A
  stroke on the open piece belongs to the comment being written, and starts one if none is: the box takes the keyboard, so
  draw, type what it is about, Enter. On a video the comment is about the frame that was drawn on,
  and its drawing shows only while the video is stopped there. Only the drawing of the comment being
  read is on the picture: pick another thread and its drawing takes the other's place, so two
  comments about the same frame never draw over one another. Whoever follows you reads the thread
  you are reading, and sees its drawing with you. What is drawn for a comment is kept with the comment,
  measured against the picture, so it goes wherever the comment goes: on a version, to every board the
  version is on and to the catalogue. It shows in the viewer only, never out on the board. A thread with
  a drawing says so under its text. Deleting a thread deletes its drawing. A drawing whose comment is
  never sent is taken away when you move on, and says so. What is drawn out on the board with the
  pen shows in the viewer too, as an ordinary drawing; "Clear drawing" in the bar asks first, and clears
  only those: what was drawn for a comment stays with its thread.
- **Smart snapping.** Dragged items snap to the edges and centres of their neighbours and
  to equal gaps, with guide lines. Toggle with S, hold Ctrl while dragging to bypass.
- **Live collaboration.** Everyone sees edits, cursors and selections as they happen.
- **Follow anyone.** Click a teammate's picture to follow their view, into the viewer and back
  out with them, with their video playing, pausing and stepping on your screen as on theirs; you
  join on the frame they are on, not at the start. In the viewer you see as much of the piece as they
  do: zoomed in where they are. Pan, zoom or open something yourself to stop; should they leave the
  board, it says so. The laser pointer (L) is visible to everyone. To take people through more than
  one board, through versions and animatics, present the project instead (see below).
- **Notifications.** The bell on the board list collects what concerns you from every board: replies
  in threads you wrote in, comments on what you added and on boards you made, and comments that
  @mention your name. Opening one goes straight to the comment. What you have read is remembered
  for you, on any device.
- **Phones, held upright.** One finger moves the board, two zoom, a tap opens an image or video and a
  swipe goes to the next. The tools sit along the bottom, labelled, with Undo and Redo at the end;
  what there is no room for (arrow, colour block, frame, laser, fit everything, snapping) is under
  More, which shows the tool from it that is in hand. Draw has an eraser beside its colours. Tap a
  selected note or heading again to write in it. The viewer opens with the hand, so looking around
  never leaves a mark: its strip holds Pan, Draw, Erase, Laser, Undo, Redo and Clear (which first
  takes back what you drew for a comment not yet sent). A tap with the brush leaves no dot, and a
  stroke that a second finger joins is taken back and becomes a pinch; after a pinch the finger
  left down keeps moving the view and never draws. A video's timeline sits just above the tools, and
  the comments come up as a sheet from the bottom. The page itself never zooms, on iPhone either.
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

With `google` or `iap` sign-in, the people named in `ADMIN_EMAILS` get an **Admin** link in Your
account. At `/admin` they see everyone who has signed in, add people ahead of time, make other admins, put
people in groups, and give people or groups a role (viewer, commenter, editor or manager) on boards and
folders in the Myreze workspace. It is three tabs: the people, a row each with their groups and when
they were last seen; the groups, a card each with who is in it and what it opens; and the permissions,
set out by the folder or board they are on. These groups and permissions are recorded but **not enforced yet**:
who gets in is still decided by the sign-in, and everyone signed in sees the whole Myreze workspace.
With the shared password (`password`) the admin area stays closed, as that sign-in does not say who
people are. With no sign-in at all (`none`, for local use) it opens on the machine that runs the server
and nowhere else, so it can be looked at and filled in before a sign-in is set up.

On a board, **Share** turns on a link that needs no sign-in, and sets what its holders can do: only
look, also read the team's comments, or also comment (under a name they type, without resolving or
deleting anything). A link can end after a day, a week or a month, can be replaced by a new one
that stops the old one at once, and can be turned off. Changing any of it applies to whoever is
watching straight away. Somebody holding a link can load only the files that board shows (never the
files its videos were made from). A project can also be presented through a link of the same kind,
which follows whoever presents it from board to player to animatic (see "Presenting it", under
Projects). Behind IAP neither kind of link exists, since nothing gets past Google's sign-in. The settings,
and how to reach the server from outside the building, are in [DEPLOY.md](DEPLOY.md); copy
`.env.example` to `.env` to set them.

### Requests from other sites

A page on another site can make a visitor's browser send requests to this server, and can even point
a name of its own at it. Two things keep that out:

- **The server answers only to its own addresses.** A request (or a live connection) has to be for an
  IP address, `localhost`, this machine's name, the address in `PUBLIC_URL`, a quick Cloudflare tunnel
  (`*.trycloudflare.com`), or a name in `ALLOWED_HOSTS` (comma separated; `*.example.com` allows
  everything under it). Anything else is answered `421`. Reaching it by another name (a DNS alias, a
  fixed tunnel without `PUBLIC_URL`) needs that name in `ALLOWED_HOSTS`. Behind IAP this is not asked:
  nothing gets through without Google's token.
- **Every change carries `X-WB: 1`.** Any request to `/api/...` other than `GET` or `HEAD`, and
  `POST /__shutdown`, without that header is refused with `403`. A page on another site cannot add a
  header without asking the server first, and this server never agrees. Scripts that call the API
  send it too (`curl -H 'X-WB: 1' ...`).

## Hosting it

For a team that is not on one network, either run it from one PC behind a tunnel with a shared
password, or deploy it to Google Cloud Run behind Google sign-in. A `Dockerfile`, a health check,
piece-by-piece uploads and an email allow list are included; see [DEPLOY.md](DEPLOY.md) for the
commands, the settings and why it should run as a single instance.

## Folders

The board list is organised in folders. Drag a board or folder onto a folder (a card, a row in the
sidebar, or a name in the path above the list) to move it, or onto the other workspace's name in the
sidebar to move it there; the `...` menu on each card has Rename,
"Move to..." and Delete. Deleting a folder only removes the folder: its boards and
subfolders move up one level. What is shared stays shared: a project, a folder with boards or folders
in it, or a board somebody else made, is moved from Myreze to a personal workspace only by an admin.
Whoever has a board or a catalogue page open that they can no longer see after a move is shown the door.

## Projects: versions and the catalogue

A folder can be made a project (the `...` menu on its card: "Make it a project"). A project keeps a
catalogue of what the team makes for it, its **assets, sets and shots**, and every **version** of them,
while its boards stay what they are: playlists for one review each, a standup, a client call. A
project cannot sit inside another one, cannot be deleted, and stays a project once something is
filed in it.

- **Filing a version.** On a board in a project, select images or videos and press Shift+V (or the
  button in the floating toolbar). Each piece has its own row: which asset, set or shot it is, and the
  task if the project counts by task. Nothing has to be named a particular way: `screenshoot_090126.png`
  is filed like anything else. What a file's name does say is filled in ahead (or what the project has
  learned about names like it, below), and so is the frame it sits in (a frame titled `kilo-0010`) and,
  for one piece, the last choice made (its task only along with it). With several, "For all" fills
  every row at once to start from; each still goes where its own row says.
  - **One line, in parts.** Each row is one line, its parts labelled once over the rows: what it is
    (`shot · kilo`, `new asset`, or "what is it?" for a new name whose shape does not say), the asset,
    set or shot, the task, the version it follows (its still), the version it is to be, and the view.
    What the page filled in and nobody said is faint (the next number, the main view, a kind read from
    a new name's shape); what was typed or read from a file's name is not. The name takes a whole line:
    `kilo-0010 anim v12 bty` puts the task, number and view in their own parts as soon as it reads one
    way only, and a file name pasted in is read the way a file's name is. A space after a name the
    project has, or a shot, moves on to the task, then the version, then the view, as a date's parts are
    typed through; a version or view typed in the task goes where it belongs; Backspace in an empty part
    goes back. Until it is a name the project has or a shot, more words are more of the name
    (`living room` is `living-room`). A shot can be said short, by the sequence of the row above (or of
    the last filing): `20` is its shot 0020, `+` its next shot on its step (`kilo+` the next of kilo),
    and `.` the same as the row above; each becomes the name it says as you go on.
  - **Suggestions** come before anything is typed: what a video looks like a new version of (looking like
    the newest version of a shot and task along its length, and as long, at the same rate and size: see
    `likely.js`), then the row above, the sequence's next shot, then a shot it is only as long as (two
    shots of a sequence often are, so that alone only hints), and what had versions lately. In an empty
    box, Enter puts in the first of the first two kinds, and the box says what that would be. The list opens on a click, on ↓ or as you type, not when the dialog opens, so it never
    covers the rows below. As you type, the project's names that fit, each with its tasks and how far each has
    counted (`kilo-0010 › anim  v12 → v13`), so one pick fills both; `kilo-` lists kilo's shots and its
    next one.
  - **Behind a mark** at the end of a row's line is what the line does not say: how much longer or
    shorter it is than the version it follows (`12 frames shorter than v1`), and anything to sort out.
    The mark is faint for a note and in the warning colour when something keeps the row from being
    filed; nothing at all when there is nothing to say. Clicking it opens a small box with all of it,
    each with its fix. What a row is shows as an icon (asset, set, shot) with a dot when it is new (in
    the warning colour when its sequence is new too), its words in the tooltip. A tick on the still of the version it follows
    says the piece looks like that version. Pointing at the still (or tabbing to it) shows the two side by side, videos
    playing together from the start, with their lengths. A row with nothing to say has no line, except
    the row being typed in, so nothing moves as you type. And anything that looks wrong, the worst first
    all of it behind the mark, each with its fix: a name a letter or two from one the
    project has (`klio-0010`, `kilo-010`), a shot written short (`kilo-10` is kilo-0010), a new name
    nothing says the kind of (asset, set or shot: asked, never assumed), a shot far past its sequence's last, a new task beside versions with none (or the
    other way round), and a video that looks like another shot than the one typed. A new sequence is
    said too, and asked about once before it is made, since a typo there makes a whole sequence. A
    short line with nothing to go by (`.` with nothing above or filed before) says so. A row cannot be
    filed while it has words that could not be read, or is a new name whose shape does not say what it
    is until that is chosen (nothing is assumed). Escape asks before closing over what was typed.
  - **Filing them.** A row's own File shows on the row under the pointer, or the one being worked in;
    "File all" is for the rest. Every row stays in sight until it is filed.
  - **Keys.** Ctrl+D copies the row above. Shift+Enter fills the rows below on from this one: shots
    go on in their sequence's step (kilo-0010, kilo-0020...), anything else is the same for each. A row
    its own file's name named is kept as it is, and what was done is said with an Undo. The keys are
    behind the ? over the rows, and in the board's keyboard help.
  - **Taking it back.** On a board, the message that says what was filed has Undo and Change; in the
    import strip, a filed row has Undo, and is then as it was, to file again. Both take the
    filing back as if it had not been: the versions are gone, numbers and all, and so is any asset,
    set or shot made for them. Change then opens the rows again as they were. This is for straight
    after: within half an hour, and not once a version has been talked about, put on another board or
    given another view (archive or delete it then).
  - **Names from elsewhere.** A file not named as the app writes names and filed by hand offers to teach
    the project how names like it read, in a dialog in the middle of the page as soon as it is filed:
    the name and what it was filed as, and what each of the files still waiting would be filed as by it.
    "Remember and fill in" keeps it and fills them in at once; "Remember" only keeps it. What is learned is the whole name's
    pattern: `NHMoc_CHAP01_010_cmp_v111.mp4` filed as chap01-0010 v111 teaches that `nhmoc` names have
    the sequence next, then the shot, then the view (with views on), then the version, so
    `NHMoc_CHAP03_040_cmp_v009.mp4` is chap03-0040 v9. A word that changes from file to file (an artist)
    is anything; the task is learned where it was the task; a shot's number may run on after letters
    (`sh010`); a sequence named otherwise there (`KLO_010` filed as kilo-0010) is kept as that. A pattern
    needs a word of its own (`nhmoc`) or one of those sequences to know its names by. Without one, the
    first word is learned, as a sequence or one asset or set (`robot` → `char-robot`), never a word that
    says nothing (screenshot, render, final...). Each pattern learned is kept beside those the project
    has by then, so two learned while filing one batch (names with a frame range and names without) are
    both kept. The project's settings list what it has learned, a row each: the name it was learned from,
    what that was filed as, and how names like it are read (psh26_ sequence _ shot _..._ version), each
    forgotten with its ×.
- **Numbering.** A version is the number its file's name says (`kilo-0010_anim_erik_v012.mov` is
  v12, and so is `NHMoc_CHAP01_010_cmp_v012` once the project has learned names like it); otherwise the
  catalogue counts on itself: `kilo-0010 anim v1`, `v2`, `v3`, per asset, set or shot and task, in the
  order they were filed. The newest is the highest number, so an older one filed later stays behind it. Each task has its own count (lookdev starts at v1
  beside model v10), and versions with no task have one of their own too. A project that has no use
  for tasks says so in its settings ("Count by task" off): filing then asks for none and ignores any a
  file's name gives, and each asset, set or shot has one count. The number can always be typed over
  before filing, and changed by hand after (see below).
- **On the board.** A piece that is a version says which in its corner. When a newer one of the same
  thing has been filed since, the chip says so; click it to swap the newer one in, or to see them all.
  The layers button in the bar opens the project's catalogue beside the board: pick an asset, set or
  shot, then click a version to put it on the board.
- **Notes.** Comments on a version belong to it (see Comments above). Filing a piece takes the comments
  already made on it along. People holding a link to a board see only the notes made on that board;
  the team sees them all.
- **A project's home.** Clicking a project opens its home page, not its boards: the big picture of
  it, how far along it is and who is on it. Its versions, boards and playlists are not there; each has
  its own page in the sidebar. Under its title, this week as one line of figures: versions filed and
  comments written (each beside the week before), and how many assets, sets and shots moved on. Then each
  part of the project in turn (its assets, its sets, and its shots a row to each sequence, in order),
  every asset, set or shot a mark toned by whether something was filed of it this week, before, or not
  yet (each opens with a click), with how many of each are filed, and under them each task the part
  has, in the order work goes through them, as a bar of how many have reached it. Beside that, its
  people: everyone who works on any of it, with what they are on and how many versions each filed this
  week; and what is waiting (set up with nothing filed, or quiet for two weeks or more). Searching from
  the home looks through the catalogue. Its reviews are at `#/f/<project>/reviews`.
- **The catalogue page.** A project has its Reviews and its Catalogue, both in the sidebar. The catalogue
  is laid out like the project on disk: assets, sets, and shots by sequence, each with its newest
  still. As cards, the catalogue is one grid, as a clip launcher lays out its layers: every asset, set
  and shot the print its card is anywhere else, one size whatever its length, with its name beneath (a shot's number alone) and
  what its newest version is (`anim v12`), all starting from the same edge. The shots are a row to each
  sequence, named at its left (a link to its page) with how many shots it has, its shots along it in
  order, scrolling sideways where they run past the edge; a shot with nothing filed keeps its place,
  empty, so the gaps in a sequence show. Assets and sets have no order, so theirs wrap. On a phone the
  sequence's name sits above its row. A sequence's own page, the assets' or the sets', and the rows and
  the table, list them as any other list. An asset, set or shot opens on every version of it (where each is on a board, who filed it,
  what its name said) and every note made about any of them, on any board. Click a version and it opens
  in the player, the same one a board uses, with the other versions in the strip beside it: comment and
  draw there, and it is on every board the version is on, live, as what is said on those boards is
  live there. The same is a click away from inside a board (the catalogue panel, or a version's chip).
- **Editing, archiving and deleting versions.** A version's menu on its asset, set or shot's page:
  - *Edit…* changes what it is filed as: the asset, set or shot, the task, the number, the artist and
    the description. Its name follows, on every board it is on, and its notes go with it. Moved to
    another asset or task without a number, it becomes the next version there. A number another
    version has is refused.
  - *Archive* puts it out of the way: it is left out of the catalogue (tick "Show archived" to see
    it) and no longer counts as the newest. Boards it is on keep it.
  - *Delete…* is for a version no board shows; one on a board says which, so it can be taken off
    first or archived instead. A deleted version is marked, not removed: its number is never given
    out again, and Undo brings it back. A snapshot or an undo on a board that would bring back a
    piece of it brings back plain media.
- **Bringing files in.** Drop images and videos anywhere on a project's catalogue, or press Import above
  it. Each is brought in exactly as a file dropped on a board is (`public/ingest.js`): a video gets its
  review copy, its timeline strip, its stills and its frame rate, and the file it was made from is kept
  too. A strip above the catalogue has a row for each file, with its own asset, set or shot and task,
  filled in ahead from its name (on an asset, set or shot's own page, from that one), with the same
  suggestions, line under it and keys as filing on a board. Nothing is filed until you say: File on a row, Enter in its boxes,
  or "File all" for every row that says where it goes (one still on its way in is filed when it
  arrives). "For all" fills every row at once. Each row has its version number too, filled in as the
  next one (one past the last of that asset, set or shot and task, and past the rows above it going to
  the same); type another to use it instead, and the rows below count on from it. A number that is
  taken is refused, with what has it. Another view of the row above's version is marked as going with
  it. Nothing goes on a board. Click a filed one to open it in
  the player. What a row is doing (Preparing, Uploading...) is said under its bar, so nothing on the
  row moves while it comes in; a row that did not come in has "Try again".
- **Project settings.** The settings button beside the star on the project's home, or Project settings
  in its menu, opens them as one dialog in tabs, listed down its side (across the top on a phone) so more
  can come: Versions (Count by task, Several views of each version and their names, the file names it has
  learned), Sequences (their order) and 3D (the venue model and what goes with it). Each tab's pane opens
  with its name and what it sets, and keeps one height, so the dialog does not jump from tab to tab; the
  arrow keys move along the tabs, and the dialog opens on the one last looked at. A switch or a button
  sits beside what it sets; a field or a list goes under its name, the width of the pane.
- **3D: the work on the venue.** A project whose settings have a model of its venue (the settings button
  beside the star on the project's home, or Project settings in its menu: a `.glb`, and once there is
  one, the name of the material its screens have and, with views, which goes on them) has a 2D / 3D switch in the
  player's bar, in the catalogue and in an animatic. In 3D the picture plays on the model's screens
  (through their own UVs), seen through the model's main camera, letterboxed at that camera's frame (Main
  camera in the settings lists the cameras in the file to choose from; without a choice, the one named
  `main`, or else the first);
  the timeline, comments, strip and sidebar are as ever, since it is the same video drawn another way. Any
  move of the view leaves the main camera: a drag (with both buttons held, it slides the camera along the
  view's plane: sideways, up and down), the wheel, W A S D (along the view, wherever it points) or Q and E
  (down, up), easing in and out as in Unreal's viewport, with the view filling the whole picture
  area and the room kept at the size it was (the lens never wider than 122.5° across). "Main camera"
  goes back to the main camera, and the arrow beside it lists the model's other cameras to look through.
  The keys 2 and 3 switch between the picture and the venue; in 3D, V goes to the next camera (the last
  comes round to the first), or to the main camera from a free view or a comment's frame.
  Each is a short glide: the letterbox opens out, or the camera moves to the frame as it closes in (none,
  if the system asks for reduced motion). A pen, eraser or laser in hand works on the frame without
  leaving it. A comment can be made from anywhere: the moment one is begun (the pen taken up, the comment
  box clicked into) the view holds still where it is, letterboxed 16:9, and that view is kept with the
  comment, so what is drawn lands on the same thing for everyone. Picking the comment glides back to it
  (turning the player to 3D if need be); a drawing shows only from there. Such a comment says
  "Drawing in 3D", or "In 3D" with no drawing. The player opens as it was last left in this tab, project by
  project: in 3D, where the view was (flying, on a camera of the model's or on a comment's frame), whatever
  piece it opens on, or in 2D. The settings button beside the 3D switch says how the venue is drawn,
  kept by the browser: Room light (from dark to twice as lit; the screens stay as they are), Ambient
  occlusion and how far it reaches, Cavity (a little dark in creases, as in Blender), and Screen light:
  the picture on the screens lighting the room as it plays, at a strength (no shadows: see
  docs/3d-preview.md). They start as a dim room lit by its screens, with some shade. One switch above
  them, Effects, turns them all off and greys them out: the room is then lit plainly from all round, so
  nothing in it is black, with no shade and no light from the screens. Lower quality, below them, is for a
  slower computer: the shade and the screens' light are worked out more roughly (a fraction of the
  samples, a few lamps, refreshed every other frame) while the picture keeps its full resolution; it holds
  with Effects on or off, and Reset leaves it.
  On the project's boards the player has the same switch, for a piece that is a version and has the view
  the project puts on its model (with the main view, any catalogued picture or video): in 3D it shows that
  view's file, whichever view is on the board. A piece that is not a version, or lacks that view, shows
  no switch, and stepping to one goes back to 2D. Whoever follows you, there or through a presentation,
  goes into 3D with you.
- **Views of a version.** A version can be shown more than one way, each its own file: on projection
  work, say, the unwrapped picture (cmp) and how it looks projected (bty). A project says whether its
  versions are, and which ways, in its settings ("Several views of each version", with their names, the
  main one first: `cmp, bty`). Off (as a project starts), a version is one file and filing asks for no
  view. On, every row where files are filed has a
  View picker of just those: the main one is a version of its own, and any other goes with one. A word
  after the version in a file's name picks it (`ch04-0030_comp_erik_v110_bty.mov`); one the project
  has not got makes the file an extra instead (below), with the views a click away should it have been
  meant as one. The line under the row says what happens: "Adds its bty to
  kilo-0010 anim v2", or a new version shown that way only. A view goes with the row of the same file
  version in the batch, above or below it (that is filed first), else with the newest version there is
  that lacks it. A version's card lists its views. In the player, and in an animatic, a dropdown in the
  bar picks the view, by the project's names and in its order, remembered per project; a shot without
  that view shows its main one, and the bar says which is showing. Changing the view stays on the same
  moment.
- **Extras of a version.** What is sent for one version is often more than one file: beside the shot as
  it plays, full-size stills to judge it close up (12k frames of a dome, say), or the same frame in
  another lighting, or another cut. These are a version's extras: any number of files, images or videos,
  each under a label of its own (`light-a`, `still-1043`, `warm`), none twice. They are not views: a
  view is one of the ways the project shows every version, an extra belongs to this version alone, and
  makes no version of its own. Every row where files are filed has an Extra box after the version: a
  label typed there makes the file an extra under it, and left empty the file is a version of its own.
  A word after the version in a file's name that is no view of the project's fills it in
  (`kilo-0010_comp_erik_v012_light-b.jpg`), as does one typed after the version on the row's line
  (`kilo-0010 v12 light-b`; one of the project's tasks there is still the task). The row says so behind its mark (as a stack
  of layers), with what it goes with ("Adds it to kilo-0010 comp v12 as an extra, “light-b”") and the way
  back to a version of its own. An extra goes with the version its number says, else with the version the
  nearest row above it makes, else with the newest of its asset, set or shot and task; with none there,
  or with that label taken, it is refused. Filed straight after, it can be taken back (Undo) as a version
  can, which takes back the extra only. A version's card says how many extras it has, and their labels.
  In the player, the strip lists the open piece's extras under it, set in under its number, each with
  its own count of comments; on a window too narrow for the strip, a button in the bar lists them. A click,
  or `[` and `]`, shows one in the piece's place, and the bar adds its label to the name. The arrows still
  go from piece to piece. Two files of one shape (a 3K video and its 12K still, or two lightings of a
  frame) are looked at the same way: flipping between them while zoomed in stays on the same spot at the
  same zoom, so lighting can be judged by flipping. What is said and drawn on an extra is said on it: each
  file of a version has its own comments, and picking one shows its file. An extra is looked at as it is,
  never on the venue in 3D. Whoever watches a presentation sees the extra the presenter shows.
- **Looking without choosing.** Move the pointer across a video's picture in the catalogue and it
  scrubs through it, as if the pointer were dragging its playhead. An asset, set or shot's picture
  plays its newest version at once ("Latest"); its name goes to its page, which has Play latest too.
- **Presenting it.** Present, in the bar of a project's pages and of its boards, makes a link to
  watch you by (`/p/<link>`): whoever opens it sees what you show, as you show it, and nothing else.
  They follow you from a board, into the viewer and out, to an asset's versions in the player, to an
  animatic and back, onto the frame you are on, playing as you play, reading the thread you read (with
  its drawing), zoomed in as far as you are, in 2D or 3D through the camera you look through, flying
  with you, and your laser. They cannot go elsewhere or look about: the corner is no way out, and their
  keys, wheel and pointer move nothing. Only what is their screen's own is in reach: the sound, full
  screen, and folding the strip and the comments away. Lists (the catalogue, Versions, a project's home)
  are never shown: while you look for the next thing, what they saw last stays behind the same cover a
  lost connection has, saying you are finding what to show next. Anything outside the project is shown
  the same way, as nothing.
  - *An animatic, read-only.* An animatic you have open is shown on its own page, as you see it but with
    nothing to change: no library, no tools, no comment box. Its playhead goes where yours goes and plays
    as yours plays, it is seen on the venue as you see it, and the comments beside it (where the link shows
    them) are those on the shot on screen. What you change in it reaches them within a few seconds, as it
    reaches anybody else with it open.
  - *Smooth to watch.* A scrub reaches them as it is made (up to thirty moments a second, always the last);
    a video playing stays with yours by playing a touch quicker or slower (a tenth at most) rather than
    jumping, and only jumps when a second or more off. A video still loading (a phone on a mobile network,
    say) is not sent on to the next moment until it can play, then goes straight to where you are. Phones are
    only ever put right by a jump. Flying in 3D, your view is sent twenty times a second and played back a
    moment behind, in between, so it moves as smoothly there as here.
  - *Cached as for you.* What is shown (a board's videos, an asset's versions, an animatic's shots and sounds) is
    fetched ahead on their computer from the piece open on, and a ring in their corner says how much is
    there. The 3D view is made ready as soon as a project with a model is shown; should you turn to 3D
    before it is, they see "Loading the venue in 3D" and how much has come, over everything.
  - *You see how cached they are.* In the pill at the foot of the page, each person watching is a face
    with a ring around it: how much of what you show (its videos, and the venue's 3D model where it can be
    seen on it) they have cached on their computer. A full green ring is ready to play, a filling one
    means wait, a dashed one is a browser that cannot cache (saving data, a plain http address) and plays
    from the server, and an empty one is somebody whose page is still putting up what you opened. Hover a
    face for the detail ("1 of 3 videos, 3D model 20%"). The pill says "All cached", or how many of them
    are. Turning to something else starts every ring afresh for it.
  - *One link each, per project, kept.* The same link every time, so it can go in the invitation to every
    review; it is live only while you present, and between times it says it is waiting for you (and
    picks you up once you start, without a reload). It can show only what you show, or also the
    comments on it (never which board they were made on); it can end after a day, a week or a month,
    be replaced by a new one that stops the old at once, or be turned off. It needs no sign-in: people
    type a name, which you see as they join ("2 watching" in the pill at the foot of every page, with
    their names under Link).
  - *Presenting lasts* in that browser tab, from page to page, until Stop. Reloading or going to another
    page is a moment's pause for those watching; should you be gone for more than a few seconds, they
    are told you stepped away. Another tab of yours left open says nothing to anyone.
  - *What the link can load* is only what has been shown since you started: the boards (as a read-only
    link has them), the versions of the assets, sets and shots opened, the shots and sounds of the
    animatics played, and the project's model of its venue. Never the file a video was made from, and nothing once you stop.
  - *The team sees who is presenting.* Where you are in a project, the line at the top says
    "Anna is presenting · Watch" while somebody else is, a way to watch them in a new tab.
  - A browser that will not play sound unasked plays without, and the sound button says so; a click
    turns it on.
- **Setting a project up.** "Add assets, sets & shots" above the catalogue takes names, typed or pasted
  one a line, each an asset, a set or a shot by its shape (or all of one kind, as chosen), and a run of
  shots from a sequence and its numbers (kilo, 10 to 200 by 10). They are in the catalogue and the
  sidebar at once, with nothing filed yet.
- **Artists and CC.** An asset, set or shot's page names its artists and who else is cc'd, picked from
  everyone the app knows (who signed in, filed, wrote a note or was named before) or typed. Its card
  shows its artists.
- **Versions, every one, as you want to see them.** A project's Versions (in the sidebar) lists every
  version filed in it, the same way an asset, set or shot's page lists its own: its still (which scrubs
  under the pointer and opens in the player), its shot (a link to it) and the rest of its label, when it
  was filed, and the boards it is on. Its groups are headed as the catalogue's are: each day a section,
  and within it who filed a run of them. As a table (the buttons in the top bar), a version's row has
  its name (archived, or in how many views, beside it), its task, its version, the artist, and who filed
  it and when; Name, Version and Filed sort it with a click
  (Filed again for oldest first). Double-click a version, as a card or a row, to open it in the player.
  The bar over the list has two buttons:
  - **View** (it says how it is grouped) groups by upload time (the default: by day, and within a day
    by who filed a run of them), by sequence (assets and sets after), by asset, set or shot, by task, by
    who filed them, or not at all; and sorts by newest or oldest filed, by name, or by version number.
    The groups keep their own order (sequences as they are numbered, then assets and sets; tasks and
    people by name; days newest first, or oldest first when so sorted), and the sort orders what is in
    each.
  - **Filter** narrows to some tasks (or no task), sequences, kinds (assets, sets, shots), people who
    filed them or artists; to today, the last 7 or 30 days; to only the newest of each asset, set or
    shot and task; or with what is archived too, all ticked in one panel. Each filter in force is a chip
    beside it, taken off with its ×.
  - The search box at the top searches every version, not only those shown: the name, the task, the
    artist, who filed it, the file's own name, or "v12".
  How each project's list is asked for is kept by the browser. However many there are, it shows a hundred
  at a time, with the way to the others under them (the one before and after, the first, the last and
  those around), and the bar says which of how many are shown ("101–200 of 1,234 versions"). Any change
  to the filters, the sort or the search starts again from the first page.
  Click a card to pick it (its box shows on a hover), Shift and a click for a run, or drag a box; once
  something is picked, a group's box picks all of it, and Esc lets go (as it does wherever things are
  picked). Then "Edit…" changes them all at once: moved to another asset, set or shot (one to make, by
  name), each the next number there in the order they were filed, their notes and boards going with
  them; given a task or none, an artist or none; archived or brought back. Each field leaves them as
  they are unless it says otherwise; all of them change or none do (a number taken refuses the lot),
  and Undo puts each back as it was, number and all. "Add to board" puts them on one of the project's
  boards, in rows below what is there, or "New board" makes one in the project with them on it, laid
  out as the edit is: a column for each sequence, left to right, its shots going down from first to
  last (assets and sets in columns after them). Either way they are those versions, with their notes.
  "Add to playlist" puts them at the end of one of the project's playlists, or makes a new one with them,
  and "Add to animatic" puts their shots at the end of an animatic.
- **Reviews: boards and playlists.** Both are a compilation of the project's work to show, in two ways: a
  board lays pieces out freely, and a playlist is simply some of its versions in the order a review goes
  through them, as in ShotGrid. A project's Reviews (in the sidebar, each board and playlist under it)
  lists them together, the one changed last first, with New first, which makes either kind (and so does
  the arrow beside New board in the bar). Each says which it is where both are there: a board's stills
  are a grid, a playlist's a strip, and its line says Board or Playlist. One can be made into the other:
  a board's menu has Make a playlist of it (the versions on it, in the order it reads: rows first, then
  left to right, a frame read through as one piece), and a playlist's has Lay out on a board (a new
  board with its versions in rows, in its order). Versions go on a playlist from anywhere they are listed: pick them on the Versions page, the
  catalogue or a shot's page and press Add to playlist, or use Add to playlist… in a version's menu. A
  playlist's page has Play and its versions in order: drag one to where it should go, take some off
  (Take off, with the selection; or from a version's menu, and Undo puts them back), or open one, which
  opens the playlist on it. Play opens them in the player, docked: one version at a
  time, as an asset's versions are, with the strip down the left to move between them (nothing plays on
  into the next, and there is no timeline across them), each with its own comments. In a project with a
  3D model of its venue the player has the 2D / 3D switch here too, each version shown on the model in the
  view the project puts on it. A playlist can be renamed,
  moved, deleted (its versions stay) and pinned to the sidebar, from the menu beside its title. A version deleted
  since is left off it.
- **Folders in Reviews.** A project's reviews can be kept in folders: New folder (under the arrow beside New
  board) on its Reviews page, or in one of its folders, makes one there. Boards, playlists, animatics and
  other folders go into one by being dragged onto it (its card or row, its row in the sidebar, or its name in
  the path above the page), with Move to… in their menu, or several at once with Select and Move to… (a
  playlist or an animatic is offered only the folders of its project's reviews; Reviews itself is their top).
  In the sidebar the folders are under Reviews, each opening to what it keeps. A folder lists what is in it as
  Reviews does, and what is made there (New) is put in it. Deleting a folder moves what it kept up one level.
- **Playlists outside a project.** A playlist does not need a project: New playlist, in the menu beside
  New board, makes one in any folder or at the top of a workspace, and it is listed with the boards there
  (a card says Playlist only where boards are listed beside it). With no catalogue to take versions from,
  a playlist is filled by adding files to it: Add versions on its page, or drop them anywhere on it. Each
  is brought in as a file dropped on a board is (a video gets its review copy, strip, stills and frame
  rate), one at a time in the order chosen, and becomes the playlist's next version: v1, v2, v3, as in a
  review tool, so a small piece of work such as one edit of a video is kept as one playlist that each new
  cut is added to. Play opens the newest in the player, docked as a project's playlist is, with the others
  in the strip beside it; comments, replies, drawings and @mentions are made there as on a project's
  versions, each belonging to its version and live for everyone who has the playlist open. Versions can be
  dragged into another order or taken off (Undo puts them back, and a number taken off is not given out
  again); the playlist can be renamed, moved to another folder or workspace, pinned and deleted from its
  menu, and a folder that is deleted moves its playlists up with its boards. Whoever can see the
  workspace can see the playlist. Behind it each keeps its versions under one entity of its own, named as
  the playlist is, which no project lists. There is no sharing link, presenting or filing it into a
  project yet.
- **Animatics: an edit that always plays the newest versions.** The third kind of review in a project
  (New, in its Reviews, makes one; see also [docs/animatic.md](docs/animatic.md)). An animatic is a cut of
  the project's shots on a timeline, as in an editor, made to see how a show plays before its shots are done
  without bringing every newest version into an editor each time. A clip names a shot, never a file, so it
  always plays the shot's newest version (of any task, unless a task is picked for the whole animatic in
  the settings button of its bar): file a version and every animatic the shot is in plays it, and an
  animatic left open takes it in by itself within a few seconds, as it does what somebody else saved. A new
  animatic can start empty or with every filed shot in order, each as long as its newest version. Its page
  takes the whole window under the bar, edge to edge, as a board does: where it is (Kilo / Reviews / Cut A,
  with its pin and its menu) is in the bar itself, and there is no heading. The edit plays in the middle under
  a bar of how it is seen, as the player's is: the shot on screen, what the edit plays (the settings button),
  the 2D / 3D switch and the venue's cameras, the sound, and at its ends the switches for the library (Shift+L)
  and the comments (Shift+C). The library is down the left (the project's shots, and the sound files brought
  in: drag one onto a track, double-click to put it at the playhead, or Add all for a sequence), what is said
  about the shot on screen down the right, and under them the timeline's bar and the timeline. The timeline's
  bar has its tools and snapping on the left, playing in the middle (the time, a frame back, play, a frame on,
  loop) and how the timeline is drawn on the right (compact tracks, the strip, all of it). The app's own
  sidebar makes way for it: on an animatic's page it is a drawer, opened with the button at the left of the
  bar. The library and the comments are made wider or narrower at their inner edges, and the line above the
  timeline gives it more room or less. All of it is kept by this browser. The ring in the bar says how much of
  what the animatic plays is cached on this computer, and each clip says so at the end of its name: a tick
  once it is, a ring filling while it comes, a cloud while it plays from the server.
  - *Nothing moves by itself.* A clip keeps the length it was cut to. A newer version that is longer plays
    as much of it as the clip is long; one that is shorter leaves the clip short: it ends where the version
    ends, what is under it shows after that, and the part it lost is drawn as an outline saying how many
    frames short it came up (a later version long enough fills it again). Nothing is ever pushed along: a
    clip moved or trimmed onto others writes over what it lands on, as an editor's overwrite does, and
    deleting leaves a gap. A gap is closed only when asked: click it (it is picked, in the accent) and press
    Delete, or right-click it for Close the gap, and what comes after it on its track moves back, as an
    editor's ripple delete does. The other tracks stay where they are.
  - *Tracks.* Video tracks stack, the higher over the lower; each clip is shown whole, fitted to the
    animatic's shape on black, so it covers what is under it. Each track can be hidden (the eye) or have
    its sound turned off, renamed and deleted from its menu, and more are added with the + in the corner
    above the heads, or from a track's menu (sixteen in all). A clip that loops goes round its version as often as its length needs, with a mark each time it
    starts over.
  - *Fades and dissolves.* The small handles under a picked clip's name draw out its fades. A fade shows
    what is under the clip: on the lowest track that is black, so it is a fade to or from black, and over
    another clip it is a dissolve into it. At a cut between two clips on one track the handle makes a
    dissolve centred on the cut. "Fade in and out by a second" and "No fades" are in a clip's menu (a
    right-click), with Loop, cutting in two at the playhead and opening the shot.
  - *Sound.* Add sound file… (or a WAV, MP3, M4A, AAC, OGG or FLAC file dropped on the page) brings in
    music, a temp track or a voice-over: read here, sent up as it is, and kept in the library under Sounds,
    to drag onto a sound track (onto one that is taken, it goes on the first with room, or a new one). One
    dropped from the desktop onto a sound track goes there too, where it is let go. A sound that is on no
    track can be taken out of the library. The first sound put on a track turns the shots' own sound off,
    each video track's button turns it back on. It plays through the browser's sound, which is also the
    clock the pictures keep to, so the edit stays in time with it; it is drawn as its waveform. Play waits
    for the sound and the pictures at the playhead to be ready (a moment, at most a second) and then plays
    smoothly from the first frame. A sound
    track's menu sets how loud it is.
  - *Tools*, as an editor has them, in the timeline's bar: Select (V) picks, moves and trims; Track select
    forward (A) picks every clip from the one clicked (or the place) on, on every track, and Track select
    backward (Shift+A) every clip up to it, to move together straight away (with Shift, on that track only);
    the Blade (B) cuts the clip clicked in two there (with Shift, every clip there on every track); the Hand
    (H) moves the timeline about. Esc goes back to Select.
  - *Labels.* A clip's menu (a right-click) has a row of label colours, the painter's colours a board's
    frames take: its band is that colour on the timeline and in the strip, to mark a scene, a kind of shot or
    what is to be redone.
  - *Compact tracks.* The compact button in the timeline's bar (or Shift+T) makes the tracks thin, as in
    Resolve: each clip its band alone, with its name, label and fades, to see more of a long edit at once.
  - *Working on it.* Click picks a clip (Shift adds; a box on empty track picks many), drag moves it (to
    another track of its kind too; Alt copies), and its edges trim it, never past the end of its version
    unless it loops. Edges line up with cuts, the playhead and clips on other tracks (the magnet in the bar;
    Ctrl skips it). Space or K plays, `,` and `.` step a frame (with Shift, a second), the arrows go to the
    cut before or after, Home and End to the start and end, Ctrl+B cuts in two at the playhead, Delete
    deletes, Ctrl+Z and Ctrl+Shift+Z undo and redo (each person their own), M is the sound, C writes a
    comment, Shift+C folds the comments away, and Ctrl and the wheel (or + and -, or Shift+Z for all of
    it) draw the timeline in and out. Click or drag on the ruler to move the playhead. The middle button,
    held, is a hand: the timeline goes with it, along and down. To watch the edit with the most room, the
    strip button in the bar (or T) folds the timeline into a thin strip of the whole edit across the width:
    every track a thin line with its clips along it, as an overview of the cut, and the playhead, to click or
    drag along; T again brings the timeline back. Which it was is kept by this browser. Every change is saved a moment after it is
    made; one made on an older save than somebody else's is not saved, theirs is shown, and Undo brings
    back yours.
  - *Comments* are about the clip on top under the playhead, on the version it plays, as in the player:
    they are that version's, so they are there in the catalogue and on every board it is on. A thread
    about a moment goes there when clicked.
  - *On the venue, in 3D.* In a project with a model of its venue, the 3D switch in the bar (or 3, and 2
    to come back) shows the edit on it, with the player's own 3D view and controls, the same component: the
    clips showing are laid over one
    another, fades and dissolves and all, and the venue's screens show them, each shot in the view the
    project puts on its model. Everything else goes on as in 2D: playing, scrubbing, the timeline, the
    sound. The model's cameras are beside the switch (the main one, the others under the arrow, and V goes
    on to the next), W A S D Q E and a drag fly about, and the settings button beside it is how the venue
    is drawn, the same settings as the player's. A comment begun on the venue holds the view where it is
    and keeps it, so it is seen from there, here and in the player. It opens on the venue if it was last
    seen that way (in this tab, here or in the player). A new animatic starts at the shape most of the
    project's shots are, so in a project with a venue, at the shape of the picture its screens show.
  - *Downloading it for a playback system.* "Download for a playback system…", in the menu beside its
    title, gives one zip: the cut as OpenTimelineIO (every track, the dissolves and fades, the sound and
    the frame rate), a CMX 3600 edit decision list for each track (which says one track at a time, its
    dissolves, and fades as dissolves to and from black), a list of which version each file is, and the
    files themselves: each shot's newest version (the file it was made from, where that was kept), named by
    the shot, and the sound files by their names. Loops are written out as the shot again each time round.
    As files are named by shot, a newer version put over its file in the playback system needs no new cut.
  - Its frame rate and shape are in that menu too ("Frame rate and shape…"): every position is a frame at
    its rate (it starts at the rate and shape most of the project's shots have), and changing it keeps each
    cut where it is in time. It can also be renamed, copied (to try another cut), pinned and deleted there. Editing
    wants a desk: on a narrow window the library, and then the comments, are left out.
- **Changing many at once.** Select, above the catalogue, picks assets, sets and shots with a click
  (Shift and a click for every one between), or drag on empty space to draw a box over them, as in a
  file manager (with Shift, Ctrl or Cmd it adds to what is picked; the Versions list and an asset's
  versions work the same, and in a folder a box picks boards and folders to move or delete together); the bar at the foot has Select all, Clear and Edit. Edit
  changes them together: artists and people cc'd added, taken off or set outright, and what they are
  (assets, sets or shots), showing who each field has now. What is left alone stays as each has it, and
  all of them change or none do. Esc, or Done, stops selecting.
- **Asking Claude.** With a Claude API key on the server (`ANTHROPIC_API_KEY`, see Settings), the
  import strip has "Ask Claude" and batch edit has a line to ask in. Say what the files or names are
  ("all shots of ch02, numbered in the order of their names, anim") and Claude reads the original file
  names, how the app writes names and the names the project already has, and suggests what each should be:
  - Importing, it fills in each row's asset, set or shot, its task and its version (a version only when
    the file name or you give one; otherwise the next, as ever), and its view when you ask for one or the
    name says it ("the _p files are the bty view"). Name the fields and only those are filled in
    ("fill in chapter, shot and version" leaves each row's task and view as they are); otherwise every
    field is Claude's to set or to clear. The View boxes then show, filled in. A small sparkle beside a row says
    Claude filled it in, and why on hover; it turns amber when the name is not the usual shape. Change
    any row by hand, or Undo them all, then file as usual.
  - In batch edit, it suggests a new name, and what each is, for each picked asset, set or shot that
    should change, using what its files were called. Untick or retype any, then save: they are renamed
    all at once, or not at all (a name the project already has, or two the same, is refused), and
    Undo puts the names back.

  Claude never files or renames anything itself. Sent to it: what you type, the files' names (not the
  files), the project's names and tasks, and what the rows say now. Haiku is used unless `AI_MODEL`
  says otherwise. The server's side is `ai.js`; the box is `public/claude.js`.

### Names

Every project is made of the same things, written one way, so there is nothing to set up:

- **Assets and sets**, named in plain words: lower case, words joined by `-` (`char-robot`,
  `harbour`). Whether one is an asset or a set is something it has, not something its name has to say:
  it is chosen when it is made. A new name is guessed to be what the project's names starting with the
  same word are (`char-dog` is an asset where `char-robot` is one); when nothing says, it is asked.
  The icon at the start of a filing row shows what it is, and a new one's icon can be clicked to say
  otherwise: it opens a menu of asset, set and shot, with a tick on what it is taken to be.
- **Sequences and their shots**: a shot is `<sequence>-<four digits>` (`kilo-0010`, `chap01-0020`), its
  sequence everything before the number. Everything that counts shots goes by this: `20`, `+`, the next
  shot, Shift+Enter, the timeline. Sequences go in the order their names sort (chap2 before chap10), unless
  the project gives them another: Order, under Sequences in its settings (the sliders beside the
  project's title), lists them first to last, each moved up or down with its arrows, or put back By name.
  Sequences named for what they are (kine, haus, elec) are put in story order there. The timeline plays
  them in that order, and the catalogue, the sidebar, the project's home, the Versions page grouped by
  sequence, its filters, and a new board laid out as the edit all list them so; a sequence the order
  does not name yet comes after those it does.

A file's name is read as the app writes names: `<name>[_<task>][_<descriptor>][_<artist>]_v###[_<view>]`
(`kilo-0010_anim_erik_v012_bty.mov`). Its name counts when it is a shot, one the project has, or one
whose kind the project's names say (`char-dog_rig_v002.mov` where there is a `char-robot`); a row not
named yet is read again whenever something is filed, so filing one file can name the others. Files named
any other way (`NHMoc_CHAP01_010_cmp_v111.mp4`) are filed by hand once and the project learns how names
like them read (Names from elsewhere, above): from then on they fill in by themselves.

All of this is `public/naming.js`, shared by the server and the pages: how names are written and read,
how a typed line is read, the corrections and near misses offered, and the rules a project learns.

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

**Updating.** The app is in development: a new version may not read a database an older one wrote,
and nothing is moved across for it. Start from a fresh `data` folder when it does not.

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
`artists` and `cc`, and `PATCH /api/projects/<folder>/entities` takes `{ "ids": [...], "tier",
"artists": { "add" | "remove" | "set": [...] }, "cc": { ... } }` to change many at once. `GET /api/people`
lists the names the app knows.
`GET /api/projects/<folder>/activity` what happened in the project in the last two weeks (versions
filed and comments, newest first),
`GET /api/projects/<folder>/versions?before=` the project's versions newest first, 300 a page, each with
the boards it is on (when
`more` is true, its `next` is what to give as `before` for the following page; a time in milliseconds
still works too); with `find=1` as the Versions page asks: `task`, `seq`, `tier`, `by`, `artist` (each a
comma separated list; an empty task is none), `since`, `q`, `newest=1`, `archived=1`, `sort` (`new`,
`old`, `name`, `number`) and `offset`, answering `total`, `more`, the next `offset` and, with the first
page, `facets` (what there is to filter by). `PATCH /api/projects/<folder>/versions` takes
`{ "edits": [{ "id", "entity", "task", "number", "artist", "hidden" }] }`, all of them or none; and
`POST /api/projects/<folder>/place` takes `{ "board", "versions": [...], "layout" }` to put versions on
one of the project's boards (`"layout": "sequences"` for a column per sequence). An animatic is
`GET /api/projects/<folder>/animatics` and `POST` with `{ "name", "doc" }`, `{ "name", "from": "shots" }` (every shot with something filed, in order),
`{ "name", "shots": [...] }` (shots, or versions standing for their shots) or `{ "name", "copy": <id> }`, each
with a `"folderId"` (a folder of the project's reviews) if it is to be kept in one, as a project's playlist takes;
`GET /api/animatics/<id>` gives its `doc` (rate, shape, task, view, tracks and clips, every position in
frames), its `rev` and the newest version of each of its shots; `PATCH` takes `{ "name" }`, `{ "folderId" }`
(moved among the project's reviews, as a project's playlist's `PATCH` takes too), `{ "doc", "rev" }`
(refused with `409` and the newer one when `rev` is not the last save) or `{ "add": [...] }`, and
`GET /api/animatics/<id>/download` is its zip for a playback system. Filing several files
files all of them or, if any one is refused, none; so does a `PATCH` of a version.
`POST /api/projects/<folder>/likely` takes `{ "looks": [{ "key", "type", "dur", "fps", "nw", "nh", "wf" }] }`
(`wf` a video's colour strip) and answers, for each key, the shots and tasks whose newest version that
video most likely follows, with why. `POST /api/versions/<id>/unfile` takes a version back straight
after it was filed (see Taking it back). A project's catalogue (`GET /api/projects/<folder>`) gives each
entity's `heads`, the newest version of each task, beside `tops`. Its settings (`PATCH /api/folders/<id>`
with `settings`) take `tasks: false` to count without tasks, `views` (`["cmp", "bty"]`, the main one
first, or `false`; the catalogue gives the views in force as `viewList`), and `rules`, the whole list of what it has
learned (patterns, `[{ "pattern": ["nhmoc", "{seq}", "{shot}", "*", "{version}"], "seqs", "like", "as" }]`, or, from a
first word alone, `[{ "word", "seq" }]` and `[{ "word", "name" }]`).

The newest version of an asset, set or shot and task is the one with the highest number (numbers can
be set by hand); the newest of an asset, set or shot as a whole is the latest filed of those, one per
task. Archived and deleted versions are never the newest. Cards, the timeline and a board's "newer" chip
all mean this.

`GET /api/notifications` lists comments written in the catalogue too: those have `board: null`, and
any comment about a version has its `versionId`, `entityId` and `projectId` (open it at
`#/f/<projectId>/catalogue/<entityId>`). The name of a board somebody cannot see is never given out
(`null` in its place), in notes, versions or the catalogue.

A board's live connection (`/ws?board=<id>`): the page says `{ t: 'hello', name, color, cid }`, where
`cid` is made afresh for each page load (at most 40 characters) and kept across its reconnections, and
numbers each round of changes it sends, `{ t: 'op', ops, seq }`, counting up from 1. A round already
applied (sent again after a dropped connection) is not applied twice. Each round is answered
`{ t: 'ack', seq }`; where the server made something else of what was sent (a comment stamped with
its author, a version the board may not show, a deletion refused), the server's own version comes
just before the ack, to the sender alone, as `{ t: 'op', ops, fix: true }`. When a board is put back to
a snapshot, everybody on it is sent `init` again with `restored: true`.

## Settings

Environment variables, or lines in a `.env` file next to `server.js`. All optional:

| Variable                 | Default  | Meaning                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `PORT`                   | `4680`   | Port to listen on                        |
| `HOST`                   | `0.0.0.0`| Interface to bind (`127.0.0.1` = local only) |
| `WIPBOARD_DATA`          | `./data` | Where boards and uploads are stored      |
| `WIPBOARD_MAX_UPLOAD_MB` | `1024`   | Largest accepted file. A video's original above this is not kept, only its review copy |
| `AUTH_MODE`              | `none`   | Who gets in, see above. Its own settings are listed in [DEPLOY.md](DEPLOY.md) |
| `ALLOWED_HOSTS`          |          | Other names the server may be reached by (see "Requests from other sites") |
| `ANTHROPIC_API_KEY`      |          | Turns on asking Claude when importing and in batch edit (see "Asking Claude"). Kept on the server |
| `AI_MODEL`               | `claude-haiku-5-5` | The Claude model asked; `claude-sonnet-5-5` is slower and costlier, and better at sorting out muddled names |
| `TRUST_PROXY`            |          | Set when a proxy is in front: `cloudflare` (a Cloudflare tunnel; believes `CF-Connecting-IP`) or `1` (believes the last address in `X-Forwarded-For`). Without it the connection's own address is who is counted for wrong passwords and uploads |

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
  board (undo and other boards may still reference them). A file whose upload was never finished is
  swept up an hour after its last piece came; each person (or address) has at most 20 files on their
  way in at once. A piece of a file has five minutes to arrive.
- A board's pieces show files uploaded here, pictures written into them, or (an image added by its
  address) a picture on another site; their stills and previews are always made here.

## Layout

```
server.js          HTTP + WebSocket server, boards in memory
store.js           The database: boards, items, folders, projects' catalogues and notes
notifications.js   What each person is told about, worked out from the notes
ai.js              Asking Claude for names: the prompt, the Claude API, checking what it answers
likely.js          Which shot a video is most likely a new version of, by its length and picture
cutfiles.js        An animatic's cut written out: OpenTimelineIO, CMX 3600 edit decision lists, the list of versions
auth.js            Who is asking: the four sign-in modes
public/board.js    The canvas: rendering, input, sync, following
public/present.js  Presenting a project: the link, the pill, and saying what is shown as you go
public/watch.js    The page a presentation's link opens: what the presenter shows, followed, and nothing else (watch.html)
public/snap.js     Smart snapping's geometry: edges, centres, equal gaps (tested on its own)
public/cuttrack.js A run's close-up track, and the frames every track draws
public/cut.js      An animatic's arithmetic: what shows and is heard at each frame, and its changes (tested on its own)
public/animatic.js An animatic's page: its player, its timeline, the shots to put on it and their comments; watched too
public/viewer.js   The player: one piece at a time, its strip, timeline, comments and drawings; used by boards and the catalogue
public/ink.js      Drawing: pen strokes, their outlines and colours; used by boards and the player
public/ingest.js   Bringing media in: review copies of video, originals, timeline strips, stills; used by boards and the catalogue
public/filing.js   Filing pieces as versions: the same line of parts, suggestions and notes under each row on a board (Shift+V) and in the catalogue's import
public/claude.js   Asking Claude: the box, what it said, and the mark on what it filled in
public/media.js    The video cache on this computer, with sw.js (the service worker that plays from it)
public/home.js     Workspaces and folders of boards, and a project's pages
public/account.js  Your account dialog: name, colour, theme, layout, the video cache, sign out
public/notices.js  The bell: notifications in the bar
public/naming.js   How names are written and file names read (shared with the server)
public/common.js   Shared helpers: elements, menus, toasts, links, dialogs
public/icons.js    Every icon, drawn once
public/boot.js     Theme and layout set before the page paints
public/login.html  Sign-in page (password and Google modes)
public/style.css   All styling
public/view3d.js   The player's 3D view: a project's model of its venue, with the piece on its screens (docs/3d-preview.md)
scripts/           restore-board.js: bring back a deleted board
test/              npm test: sign-in, uploads, live sync, workspaces, links, presenting, the database, catalogue, versions, filing (reading what is typed, learned names, likeness), notes, notifications, snapping, animatics (their edit, their arithmetic, their cut written out) and asking Claude (against a stand-in)
```
