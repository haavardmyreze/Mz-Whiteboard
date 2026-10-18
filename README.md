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

- **Getting around the home page.** A sidebar on the left holds Home, then what you pinned (each a row
  that goes there), then each workspace with its folders and projects as a tree. A project opens to its
  Boards, Catalogue, Versions and Timeline, and the catalogue to its assets, sets and shots, the shots by
  sequence, each with a count. Only what you are in is open: the way to the page you are on is opened
  for you, and the rest close as you go elsewhere (an arrow opens a row for a look in the meantime). Above the page one slim line says where you are (Myreze / Kilo / Catalogue / Shots /
  kilo / kilo-0010), each part a link; the star at its end pins exactly what is there to Home: a board's folder, a project, a sequence, a tier of the catalogue, the catalogue, Versions, the Timeline, or an asset, set or shot.
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
- **Phone copies.** A review copy is made for looking closely at a desk, so every video also gets a phone
  copy: the same frames at the same moments, at most 720p and about 2.5 Mbit/s, a fifth of the size or less
  (a 6-second 1080p test came down from 7.2 MB to 1.6 MB). Phones (a touch screen, and a small one) and
  browsers saving data or on a slow mobile line play and keep it instead, so it arrives several times
  sooner; everybody else plays the review copy. Nobody makes them by hand: any desk browser of the team
  that can make video and has a video without one on its page (a board, the catalogue, the timeline) makes
  it in the background, one at a time, never while a video is open or while presenting. The server makes
  sure only one browser makes each, and once it has one it is put on every board and every version that
  shows that file. A review copy already as light as a phone copy is its own. Following somebody (or
  watching a presentation) on a phone stays on the same frame as on the desk, as both copies have the same.
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
  video selected on the board. Space plays and pauses even when a dropdown just used (which sequence,
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
  (`public/media.js`): whatever video you open, in a board, the catalogue, the timeline or from Home, is
  kept, and is there at once the next time. Ahead of you, in this order, it also fetches the timeline's
  next few shots as it plays, the open board's videos, the videos the page you are on shows (the
  catalogue's cards, say), and the newest version of your work, of what you are cc'd on and of what
  you pinned (Home's feed is fetched every few minutes for this, wherever you are). Your settings
  (your name at the top right) turn fetching ahead off, or any of boards, work, cc'd and pinned. Up
  to 4 GB is kept; what was wanted longest ago makes room, never what the open board, the page or
  the timeline is showing, and when nothing more can be made room for, fetching ahead stops rather
  than throwing out what is wanted. A small service worker (`public/sw.js`) answers the pages' own
  video players from the kept copies, scrubbing included, so a card scrubbed on hover or the
  timeline's next shot plays from the disk too. What is kept is listed in IndexedDB, a record a video,
  and a lock for each file keeps two tabs from fetching the same one; the list from before (in
  localStorage) is taken over the first time.
- **Seeing what is cached.** Every video card (in the catalogue, an asset's versions, the Versions
  list, Home) has a badge in its top right corner: a green tick once it is cached on this computer, a
  ring filling while it comes, a cloud while it still plays from the server. The ring a board has in
  its bar is in Home's bar too, for whatever you are looking at: the cards of the page, or with the
  timeline open, the whole timeline ("3/12 cached", then "Cached"), which is fetched in full behind the
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
  needs to hold one such image and a new colour block at the same width as a frame, so it sits flush above one as its header, notes and headings at fixed sizes
  and the brush at a fixed width (small while an image is open, so annotating stays fine), whatever the zoom was when you made them. Text is sized
  by its level (H1, H2, H3, Text), not by dragging.
- **Headings and notes.** Pick H1, H2, H3 or plain text before placing, or change the
  level of selected text from the floating toolbar.
- **Brush.** The pen is pressure sensitive on a tablet and speed sensitive with a mouse:
  slow strokes are thick, quick flicks thin out, and strokes taper at the end. Right-drag
  while drawing out on the board, or pick the eraser beside the colours (E), to erase: every drawing the stroke touches is removed. Drawings always sit above
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
  one board, through versions and the timeline, present the project instead (see below).
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

With `google` or `iap` sign-in, the people named in `ADMIN_EMAILS` get an **Admin** link on the home
page. At `/admin` they see everyone who has signed in, add people ahead of time, make other admins, put
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
which follows whoever presents it from board to player to timeline (see "Presenting it", under
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
  - **One line.** The first box takes a whole line: `kilo-0010 anim v12 bty` puts the task, number and
    view in their own boxes (on a board, which has none, the row keeps them and says so, each with a
    way back to the next number or no view; changing the name lets them go), and a file name pasted in
    is read the way a file's name is. Until it is a
    name the project has or one to the styleguide, more words are more of the name (`living room` is
    `living-room`). A shot can be said short, by the sequence of the row above (or of the last filing):
    `20` is its shot 0020, `+` its next shot on its step (`kilo+` the next of kilo), and `.` the same as
    the row above.
  - **Suggestions** come before anything is typed: what a video looks like a new version of (looking like
    the newest version of a shot and task along its length, and as long, at the same rate and size: see
    `likely.js`), then the row above, the sequence's next shot, then a shot it is only as long as (two
    shots of a sequence often are, so that alone only hints), and what had versions lately. In an empty
    box, Enter puts in the first of the first two kinds, and the box and the line under it say what that
    would be. The list opens on a click, on ↓ or as you type, not when the dialog opens, so it never
    covers the rows below. As you type, the project's names that fit, each with its tasks and how far each has
    counted (`kilo-0010 › anim  v12 → v13`), so one pick fills both; `kilo-` lists kilo's shots and its
    next one.
  - **Under each row** a line says only what its boxes do not: the version it follows, by its still,
    and the number it gets (in the import strip, which has a box for the number, only what it follows);
    for a new name what it is and where it goes (`new shot in kilo`); and how much longer or shorter it
    is than the version it follows (`12 frames shorter than v1`). A tick on the still says the piece
    looks like that version. Pointing at the still (or tabbing to it) shows the two side by side, videos
    playing together from the start, with their lengths. A row with nothing to say has no line, except
    the row being typed in, so nothing moves as you type. And anything that looks wrong, the worst first
    with the rest a click away ("+2 more"), each with its fix: a name a letter or two from one the
    project has (`klio-0010`, `kilo-010`), a name not to the styleguide (`robot`: char-robot,
    prop-robot...), a shot far past its sequence's last, a new task beside versions with none (or the
    other way round), and a video that looks like another shot than the one typed. A new sequence is
    said too, and asked about once before it is made, since a typo there makes a whole sequence. A
    short line with nothing to go by (`.` with nothing above or filed before) says so. A row cannot be
    filed while it has words that could not be read, or is a new name whose shape does not say what it
    is until that is chosen (nothing is assumed). Escape asks before closing over what was typed.
  - **Only what needs you.** Rows that need nothing from anyone (named by their own files, nothing
    wrong, not starting a sequence) fold into one line over the rest: "✓ 4 ready: kilo-0010 anim v2
    (−12f), kilo-0010 lighting v1, ...", with Show, and in the import strip File to file just those.
    What is left in sight is what needs looking at. A row's own File shows on the row under the
    pointer, or the one being worked in; "File all" is for the rest.
  - **Keys.** Ctrl+D copies the row above. Shift+Enter fills the rows below on from this one: shots
    go on in their sequence's step (kilo-0010, kilo-0020...), anything else is the same for each. A row
    its own file's name named is kept as it is, and what was done is said with an Undo. The keys are
    said in a line under the rows, and in the board's keyboard help.
  - **Taking it back.** On a board, the message that says what was filed has Undo and Change; in the
    import strip, a filed row has Undo, and is then as it was, to file again. Both take the
    filing back as if it had not been: the versions are gone, numbers and all, and so is any asset,
    set or shot made for them. Change then opens the rows again as they were. This is for straight
    after: within half an hour, and not once a version has been talked about, put on another board or
    given another view (archive or delete it then).
  - **Names from elsewhere.** A file not named to the styleguide and filed by hand offers to teach the
    project how names like it read, and fills in the rows still to go that it reads, at once (on a
    board, asked once the message about the filing has gone). What is learned is the whole name's
    pattern: `NHMoc_CHAP01_010_cmp_v111.mp4` filed as chap01-0010 v111 teaches that `nhmoc` names have
    the sequence next, then the shot, then the view (with views on), then the version, so
    `NHMoc_CHAP03_040_cmp_v009.mp4` is chap03-0040 v9. A word that changes from file to file (an artist)
    is anything; the task is learned where it was the task; a shot's number may run on after letters
    (`sh010`); a sequence named otherwise there (`KLO_010` filed as kilo-0010) is kept as that. A pattern
    needs a word of its own (`nhmoc`) or one of those sequences to know its names by. Without one, the
    first word is learned, as a sequence or one asset or set (`robot` → `char-robot`), never a word that
    says nothing (screenshot, render, final...). The project's settings list what it has learned, as
    chips to forget.
- **Numbering.** The catalogue counts versions itself: `kilo-0010 anim v1`, `v2`, `v3`, per asset, set
  or shot and task, in the order they were filed. Each task has its own count (lookdev starts at v1
  beside model v10), and versions with no task have one of their own too. A project that has no use
  for tasks says so in its settings ("Count by task" off): filing then asks for none and ignores any a
  file's name gives, and each asset, set or shot has one count. A version number in the file's name
  (`_v012`) is not used or shown; the number can be changed by hand (see below).
- **On the board.** A piece that is a version says which in its corner. When a newer one of the same
  thing has been filed since, the chip says so; click it to swap the newer one in, or to see them all.
  The layers button in the bar opens the project's catalogue beside the board: pick an asset, set or
  shot, then click a version to put it on the board.
- **Notes.** Comments on a version belong to it (see Comments above). Filing a piece takes the comments
  already made on it along. People holding a link to a board see only the notes made on that board;
  the team sees them all.
- **A project's home.** Clicking a project opens its home page, not its boards: its parts (Catalogue,
  with how many assets, sets and shots; Boards; Versions; Timeline) along the top, then Activity, the
  versions filed and comments written in it in the last two weeks, beside what was filed last (cards that
  scrub and play) and the boards last worked on. Its boards are at `#/f/<project>/boards`.
- **The catalogue page.** A project has its Boards and its Catalogue, both in the sidebar. The catalogue
  is laid out like the project on disk: assets, sets, and shots by sequence, each with its newest
  still. An asset, set or shot opens on every version of it (where each is on a board, who filed it,
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
- **3D: the work on the venue.** A project whose settings have a model of its venue (the settings button
  beside the star on the project's home, or Project settings in its menu: a `.glb`, and once there is
  one, the name of the material its screens have and, with views, which goes on them) has a 2D / 3D switch in the
  player's bar, in the catalogue and on the timeline. In 3D the picture plays on the model's screens
  (through their own UVs), seen through the model's camera named `main`, letterboxed at that camera's frame;
  the timeline, comments, strip and sidebar are as ever, since it is the same video drawn another way. Any
  move of the view leaves the main camera: a drag (with both buttons held, it slides the camera along the
  view's plane: sideways, up and down), the wheel, W A S D (along the view, wherever it points) or Q and E
  (down, up), easing in and out as in Unreal's viewport, with the view filling the whole picture
  area and the room kept at the size it was (the lens never wider than 122.5° across). "Main camera" or V
  goes back to the main camera, and the arrow beside it lists the model's other cameras to look through.
  Each is a short glide: the letterbox opens out, or the camera moves to the frame as it closes in (none,
  if the system asks for reduced motion). A pen, eraser or laser in hand works on the frame without
  leaving it. A comment can be made from anywhere: the moment one is begun (the pen taken up, the comment
  box clicked into) the view holds still where it is, letterboxed 16:9, and that view is kept with the
  comment, so what is drawn lands on the same thing for everyone. Picking the comment glides back to it
  (turning the player to 3D if need be); a drawing shows only from there. Such a comment says
  "Drawing in 3D", or "In 3D" with no drawing. The player always opens in 2D. The room is lit from all round so nothing in it is black.
  On the project's boards the player has the same switch, for a piece that is a version and has the view
  the project puts on its model (with the main view, any catalogued picture or video): in 3D it shows that
  view's file, whichever view is on the board. A piece that is not a version, or lacks that view, shows
  no switch, and stepping to one goes back to 2D. Whoever follows you, there or through a presentation,
  goes into 3D with you.
- **Views of a version.** A version can be shown more than one way, each its own file: on projection
  work, say, the unwrapped picture (cmp) and how it looks projected (bty). A project says whether its
  versions are, and which ways, in its settings ("Several views of each version", with their names, the
  main one first: `cmp, bty`). Off (as a project starts), a version is one file, filing asks for no view,
  and a view word in a file's name is said not to be read. On, every row where files are filed has a
  View picker of just those: the main one is a version of its own, and any other goes with one. A word
  after the version in a file's name picks it (`ch04-0030_comp_erik_v110_bty.mov`), and one the project
  has not got is asked about, never guessed. The line under the row says what happens: "Adds its bty to
  kilo-0010 anim v2", or a new version shown that way only. A view goes with the row of the same file
  version in the batch, above or below it (that is filed first), else with the newest version there is
  that lacks it. A version's card lists its views. In the player, and on the timeline, a dropdown in the
  bar picks the view, by the project's names and in its order, remembered per project; a shot without
  that view shows its main one, and the bar says which is showing. Changing the view stays on the same
  moment. A project from before the setting that filed views has them as filed, its main one called by
  what most of its versions were first filed as.
- **Looking without choosing.** Move the pointer across a video's picture in the catalogue and it
  scrubs through it, as if the pointer were dragging its playhead. An asset, set or shot's picture
  plays its newest version at once ("Latest"); its name goes to its page, which has Play latest too.
- **The timeline.** A project's Timeline (in the sidebar, or above the catalogue) plays every shot in
  order, sequence by sequence, in the player, as an edit, beside the sidebar and under the page's bar,
  which stay in reach (going elsewhere from either closes the timeline): the newest version of each (of any task, or
  of one), one into the next. The next shot is loaded while one plays, so the cut to it is clean. In
  place of the side strip, the bar under the picture holds every shot as a clip as long as it lasts,
  with its still and where each sequence begins; dragging along it moves through the whole run, and the
  time is the run's, in seconds, frames or timecode as everywhere else. The player's bar picks all
  sequences or one, and the task; both are remembered. Under the whole run is a close-up of it, as on
  an editor's cut page: the playhead stays in the middle and the shots go by under it as a strip of their
  own frames, so a cut is seen coming and a moment found to the frame. Drag it to move through the run (it
  stops while held, and plays on when let go if it was playing), click to go to a moment, or use the
  wheel to move along it. It is always at the same scale, some fourteen seconds across a laptop,
  however long the edit; the buttons in its corner (or the wheel with Ctrl or Cmd) draw it out to show
  1.5, 2 or 3 times as much, still so many pixels a second, and that is remembered. Each shot has a
  plain band along its top with its name and version (in the accent colour for the shot under the
  playhead, and with the sequence's name where one begins), so the frames under it are never written
  over, and every cut is a gap down the whole height. On the whole run above it the sequences are a
  row of bands, named where there is room, the shots under them their stills, named only where wide
  enough. Its
  frames are taken from the shots in the browser as they come into view, nearest the playhead first;
  until one is in, its place has the colour the shot has there. The arrows step from shot to shot, Space plays
  and pauses, loop goes round to the first shot, and what is written is about the shot under the
  playhead, on its version, like any other comment. Stills hold for three seconds. The shot on screen
  and its version are written over the picture and in the bar, and each clip in the strip says its
  shot. Shots with nothing filed (of the task chosen) are there as a slate, held like a still, with no
  comments, as they have no version to be on; "Filed shots only" leaves them out.
- **Presenting it.** Present, in the bar of a project's pages and of its boards, makes a link to
  watch you by (`/p/<link>`): whoever opens it sees what you show, as you show it, and nothing else.
  They follow you from a board, into the viewer and out, to an asset's versions in the player, to the
  timeline and back, onto the frame you are on, playing as you play, reading the thread you read (with
  its drawing), zoomed in as far as you are, in 2D or 3D through the camera you look through, flying
  with you, and your laser. They cannot go elsewhere or look about: the corner is no way out, and their
  keys, wheel and pointer move nothing. Only what is their screen's own is in reach: the sound, full
  screen, and folding the strip and the comments away. Lists (the catalogue, Versions, a project's home)
  are never shown: while you look for the next thing, what they saw last stays behind the same cover a
  lost connection has, saying you are finding what to show next. Anything outside the project is shown
  the same way, as nothing.
  - *Smooth to watch.* A scrub reaches them as it is made (up to thirty moments a second, always the last);
    a video playing stays with yours by playing a touch quicker or slower (a tenth at most) rather than
    jumping, and only jumps when a second or more off. A video still loading (a phone on a mobile network,
    say) is not sent on to the next moment until it can play, then goes straight to where you are. Phones are
    only ever put right by a jump. Flying in 3D, your view is sent twenty times a second and played back a
    moment behind, in between, so it moves as smoothly there as here.
  - *Cached as for you.* What is shown (a board's videos, an asset's versions, the timeline's shots) is
    fetched ahead on their computer from the piece open on, and a ring in their corner says how much is
    there. The 3D view is made ready as soon as a project with a model is shown; should you turn to 3D
    before it is, they see "Loading the venue in 3D" and how much has come, over everything.
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
    link has them), the versions of the assets, sets and shots opened, the shots of the timeline played,
    and the project's model of its venue. Never the file a video was made from, and nothing once you stop.
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
  version filed in it, as the same cards an asset, set or shot's page has (cards or compact rows, as
  the button in the bar says): its still (which scrubs under the pointer and opens in the player), its
  shot (a link to it) and the rest of its label, when it was filed, and the boards it is on. The bar over
  it says how:
  - **Group by** upload time (the default: by day, and within a day by who filed a run of them), by
    sequence (assets and sets after), by asset, set or shot, by task, by who filed them, or not at all.
    **Sort** by newest or oldest filed, by name, or by version number.
  - **Narrow** to some tasks (or no task), sequences, kinds (assets, sets, shots), people who filed
    them or artists, each a menu to tick; to today, the last 7 or 30 days; to only the **newest** of each
    asset, set or shot and task; or with what is **archived** too. Clear puts it all back.
  - The search box at the top searches every version, not only those shown: the name, the task, the
    artist, who filed it, the file's own name, or "v12".
  How each project's list is asked for is kept by the browser. It comes a page at a time, "Show more"
  for the rest, and the bar says how many there are in all.
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
  names, the project's naming rules and the names it already has, and suggests what each should be:
  - Importing, it fills in each row's asset, set or shot, its task and its version (a version only when
    the file name or you give one; otherwise the next, as ever), and its view when you ask for one or the
    name says it ("the _p files are the bty view"); the View boxes then show, filled in. A small sparkle beside a row says
    Claude filled it in, and why on hover; it turns amber when the name is not the usual shape. Change
    any row by hand, or Undo them all, then file as usual.
  - In batch edit, it suggests a new name, and what each is, for each picked asset, set or shot that
    should change, using what its files were called. Untick or retype any, then save: they are renamed
    all at once, or not at all (a name the project already has, or two the same, is refused), and
    Undo puts the names back.

  Claude never files or renames anything itself. Sent to it: what you type, the files' names (not the
  files), the project's names and tasks, and what the rows say now. Haiku is used unless `AI_MODEL`
  says otherwise. The server's side is `ai.js`; the box is `public/claude.js`.

Names are read by the project's naming preset. The one there is follows the Myreze styleguide:
`_` separates parts, `-` joins words, all lower case. An asset is `char-`, `prop-`, `env-`, `veh-` or
`fx-` something, a set is `set-` something, a shot is `<sequence>-<number>` (`kilo-0010`). A file named
`<context>_<task>[_<descriptor>]_<artist>_v###` (`kilo-0010_anim_erik_v012.mov`) says all of it. The
rules are in `public/naming.js`, shared by the server and the pages, with how a typed line is read,
the corrections and near misses offered, and the rules a project learns.

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
`artists` and `cc`, and `PATCH /api/projects/<folder>/entities` takes `{ "ids": [...], "tier",
"artists": { "add" | "remove" | "set": [...] }, "cc": { ... } }` to change many at once. `GET /api/people`
lists the names the app knows, and `GET /api/feed?name=` is Home's Updates and My work (and `cc`, what you are cc'd on, each with
its newest version, for the cache to fetch ahead).
`GET /api/projects/<folder>/activity` what happened in the project in the last two weeks (versions
filed and comments, newest first), `GET /api/projects/<folder>/timeline?task=` lists the shots in order with their newest version,
`GET /api/projects/<folder>/versions?before=` the project's versions newest first, 300 a page (when
`more` is true, its `next` is what to give as `before` for the following page; a time in milliseconds
still works too); with `find=1` as the Versions page asks: `task`, `seq`, `tier`, `by`, `artist` (each a
comma separated list; an empty task is none), `since`, `q`, `newest=1`, `archived=1`, `sort` (`new`,
`old`, `name`, `number`) and `offset`, answering `total`, `more`, the next `offset` and, with the first
page, `facets` (what there is to filter by). `PATCH /api/projects/<folder>/versions` takes
`{ "edits": [{ "id", "entity", "task", "number", "artist", "hidden" }] }`, all of them or none; and
`POST /api/projects/<folder>/place` takes `{ "board", "versions": [...], "layout" }` to put versions on
one of the project's boards (`"layout": "sequences"` for a column per sequence). Filing several files
files all of them or, if any one is refused, none; so does a `PATCH` of a version.
`POST /api/projects/<folder>/likely` takes `{ "looks": [{ "key", "type", "dur", "fps", "nw", "nh", "wf" }] }`
(`wf` a video's colour strip) and answers, for each key, the shots and tasks whose newest version that
video most likely follows, with why. `POST /api/versions/<id>/unfile` takes a version back straight
after it was filed (see Taking it back). A project's catalogue (`GET /api/projects/<folder>`) gives each
entity's `heads`, the newest version of each task, beside `tops`. Its settings (`PATCH /api/folders/<id>`
with `settings`) take `tasks: false` to count without tasks, `views` (`["cmp", "bty"]`, the main one
first, or `false`; the catalogue gives the views in force as `viewList`), and `rules`, the whole list of what it has
learned (patterns, `[{ "pattern": ["nhmoc", "{seq}", "{shot}", "*", "{version}"], "seqs", "like", "as" }]`, or the
older `[{ "word", "seq" }]` and `[{ "word", "name" }]`).

The newest version of an asset, set or shot and task is the one with the highest number (numbers can
be set by hand); the newest of an asset, set or shot as a whole is the latest filed of those, one per
task. Archived and deleted versions are never the newest. Cards, the timeline, a board's "newer" chip
and the feed all mean this.

`GET /api/notifications` lists comments written in the catalogue too: those have `board: null`, and
any comment about a version has its `versionId`, `entityId` and `projectId` (open it at
`#/f/<projectId>/catalogue/<entityId>`). The name of a board somebody cannot see is never given out
(`null` in its place), in notes, the feed, versions or the catalogue.

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
auth.js            Who is asking: the four sign-in modes
public/board.js    The canvas: rendering, input, sync, following
public/present.js  Presenting a project: the link, the pill, and saying what is shown as you go
public/watch.js    The page a presentation's link opens: what the presenter shows, followed, and nothing else (watch.html)
public/snap.js     Smart snapping's geometry: edges, centres, equal gaps (tested on its own)
public/cuttrack.js A run's close-up track: the playhead held in the middle, frames going by under it
public/viewer.js   The player: one piece at a time, its strip, timeline, comments and drawings; used by boards and the catalogue
public/ink.js      Drawing: pen strokes, their outlines and colours; used by boards and the player
public/ingest.js   Bringing media in: review copies of video, originals, timeline strips, stills; used by boards and the catalogue
public/filing.js   Filing pieces as versions: the same fields, suggestions and line under each row on a board (Shift+V) and in the catalogue's import
public/claude.js   Asking Claude: the box, what it said, and the mark on what it filled in
public/media.js    The video cache on this computer, with sw.js (the service worker that plays from it)
public/home.js     Board list, and a project's catalogue
public/account.js  Your account dialog: name, colour, theme, layout, the video cache, sign out
public/notices.js  The bell: notifications on the home page
public/naming.js   How file names are read for the catalogue (shared with the server)
public/common.js   Shared helpers: elements, menus, toasts, links, dialogs
public/icons.js    Every icon, drawn once
public/boot.js     Theme and layout set before the page paints
public/login.html  Sign-in page (password and Google modes)
public/style.css   All styling
public/view3d.js   The player's 3D view: a project's model of its venue, with the piece on its screens (docs/3d-preview.md)
scripts/           restore-board.js: bring back a deleted board
test/              npm test: sign-in, uploads, live sync, workspaces, links, presenting, the database, catalogue, versions, filing (reading what is typed, learned names, likeness), notes, notifications, snapping and asking Claude (against a stand-in)
```
