# Animatics: an edit that always plays the newest versions

**Status: planned, nothing built yet.** This is the plan for a third kind of review in a project, beside the
board and the playlist.

## What it is for

A show is cut together long before its shots are finished. Some shots loop, some could go in more than one
order, some are tried in two places, and the team needs to see how it plays as a whole. Today that means
downloading the newest version of every shot, bringing them into a video editor and cutting them there, and
doing it all again each time a shot is updated. An animatic does that cut inside the app: a timeline with
tracks that shots are dropped onto, played back as an edit. Each clip on it is a shot, not a file, so it always
plays that shot's newest version. When a version is filed, every animatic the shot is in shows it at once:
open it, press play, and the updated edit is there.

It needs, to begin with:

- several video tracks, the higher over the lower;
- fades on clips: a dissolve from one clip into another, and a fade to and from black;
- an audio file brought in to cut to (music, a temp track, a voice-over).

## How it fits with what is there

- **A third kind of review.** A project's Reviews lists boards, playlists and now animatics together, and
  New makes any of the three. An animatic's page is `#/f/<project>/reviews/<id>`, as a playlist's is, and it
  sits in the sidebar under Reviews with its own icon. Its card is a strip of its stills with thin track
  lines under it (a board's are a grid, a playlist's a strip), and its line says Animatic where other kinds
  are listed beside it. It can be renamed, pinned, duplicated ("Try another cut" is the common case: two
  orders of the same shots) and deleted from the menu beside its title.
- **Only in a project.** An animatic's clips are the project's shots, so it needs a catalogue to take them
  from. A playlist outside a project has no such thing; an animatic there is left out.
- **What it is made from.** A clip names a shot of the project, and plays its newest version. Assets and sets
  are not put on an animatic. By default that is the newest of any task, and nobody has to choose anything.
  Where it matters, the animatic's bar has a task to pick, as the Timeline has ("Any task", "anim", "comp"),
  and then every clip plays the newest of that task. It is one choice for the whole animatic, never one per
  clip. A clip shows a view (`cmp`, `bty`) where the project has them, the same way. A shot with nothing filed
  of that task plays as the Timeline's slate does.
- **Uses what the Timeline built.** The Timeline already plays the newest version of each shot one into the
  next (`viewer.js`, run mode), keeps the coming shots on this computer (`media.js`), and draws a close-up
  strip of their frames (`cuttrack.js`). The animatic reuses the cache, the frame grabbing and the time
  formats (seconds, frames, timecode, as chosen everywhere). It cannot reuse run mode's player: that shows
  one piece at a time, and an edit with tracks and dissolves shows two or more at once. So the animatic has a
  player of its own (below).

## The edit, as it is kept

One record per animatic, in a new `animatics` table in `store.js`: `id`, `project_id`, `name`, `doc`
(JSON), `rev` (a number counting its saves), `created_at`, `created_by`, `updated_at`, `updated_by`. A
separate table rather than another kind of playlist, as what it holds has nothing in common with a list of
versions.

The `doc` is the whole edit, small enough (a few KB for a long cut) to be read and written whole:

```js
{
  fps: 25,                  // the edit's own rate; every position below is in its frames
  w: 1920, h: 1080,         // the edit's shape: what is letterboxed into it
  task: null,               // the newest of which task each clip plays (null: of any)
  view: '',                 // which view of each version, where the project has views
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', mute: false, hide: false },
    { id: 'v2', kind: 'video', name: 'V2', mute: false, hide: false },
    { id: 'a1', kind: 'audio', name: 'A1', mute: false, gain: 1 },
  ],
  clips: [
    // A shot: the newest version of it (of the edit's task), from `in` frames into it, for at most `len` frames.
    { id, track: 'v1', start: 0, len: 96, in: 0, shot: '<entity id>', loop: false, fadeIn: 0, fadeOut: 12, gain: 1 },
    // A sound file brought in: an upload of its own, not a version.
    { id, track: 'a1', start: 0, len: 2400, in: 0, media: '/uploads/abc.wav', name: 'temp music.wav', fadeIn: 0, fadeOut: 50, gain: 0.8 },
  ],
}
```

- **Positions are in the edit's frames.** A clip from a video of another rate plays at its own speed and is
  mapped by time.
- **Tracks stack.** A higher video track covers a lower one wherever both have a clip. Every clip is shown
  whole, fitted into the edit's shape on black, so a clip of another shape never lets the track under it show
  through its bars. Under everything is black.
- **A fade shows what is under the clip.** A clip's `fadeIn` and `fadeOut` (frames) fade it from and to
  whatever is beneath it. On V1 that is black: a fade to black. On V2 over a clip on V1 it is a dissolve
  between them. A dissolve between two clips side by side on one track is the cut's own: the clip after the
  cut starts half the dissolve early, over the one before, which plays half of it on past the cut, into
  frames past its out point. Where its version has no frames there, the dissolve is shorter on that side. It
  is kept as the later clip's `dissolve` (frames). Audio clips fade their sound the same way.
- **Loops.** A clip with `loop` set and a `len` longer than its version plays it round again, as many times
  as it fits, which the timeline shows as marks where it starts over.
- **Saving.** Every edit is saved as it is made (a moment after the last change), with the `rev` it was made
  from. A save against an older `rev` is refused (`409`) with the newer edit and who made it; the page takes
  that one, says who changed it, and the change that was refused is lost to the editor's undo, where it can be
  made again. Two people editing one animatic at the same moment is rare; this keeps it right without the
  board's live machinery. Live editing together can come later on the same `doc` (see Later).

## The newest version, and what happens when it changes

The server resolves each clip when the animatic is asked for: `GET /api/animatics/<id>` gives the `doc` and,
for each shot it uses, the newest version as the Timeline has it (its look: file, phone copy, still, length,
rate, colour strip; its label, `kilo-0010 anim v12`). Nothing is copied into the `doc`, so there is nothing to
keep up to date: filing a version is all it takes.

A new version is often a different length. An edit can be intricate, cut to music, with tracks lined up
against each other, so **nothing on the timeline ever moves because a version changed**. Nothing is pushed
along, ever, by anything but a person moving it.

- **The version is longer than the clip.** The clip stays as long as it was cut and plays that much of it.
- **The version is shorter than the clip.** The clip is shorter: it ends where the version ends, and what was
  after it shows what is under it (a lower track, or black). Its last frame is not held. The length it was cut
  to is kept in the `doc` all the same (`len` is "at most"), so a later version that is long enough fills it
  again, and the timeline draws the part it has lost as an empty outline, so it is plain the shot came up short.
- **A looping clip** fills its length whatever its version's length, going round as often as it needs to.
- **A clip dropped in** is as long as its version is then.

## The player

A player of its own, `public/animatic.js`, drawing the edit on the page as it plays:

- **Layers of `<video>`.** For each moment, the clips that show are worked out (the top clip of each video
  track that is not hidden, and those under it while it fades), each in a `<video>` stacked in track order in
  a box of the edit's shape, its opacity its fade. The browser blends them; nothing is drawn by hand, so it
  costs little and plays as smoothly as the Timeline does. Firefox included.
- **Only what shows is decoded.** A clip wholly covered by another (no fade between them) is left paused,
  ready on the right frame, so a stack of three tracks decodes one video most of the time and two in a
  dissolve. A small pool of video elements (about six) is shared out: the ones on screen, and the clips about
  to start, each loaded and waiting on its first frame a second and a half ahead so the cut to it is clean, as
  the Timeline's spare is.
- **One clock.** While playing, time is the Web Audio clock (`AudioContext.currentTime`), which is steady and
  is what the sound is scheduled on. Each video is kept to it: a little off and it plays a touch quicker or
  slower (as a presentation keeps those watching in step), more than a frame and a half off and it jumps.
  Stopped, every layer is put on the frame asked, so scrubbing and stepping land exactly.
- **Sound.** A sound file is fetched whole and decoded into Web Audio, where it starts on the exact sample,
  fades through a gain, and is drawn as a waveform. A shot's own sound plays from its video, its volume
  following its fade; each track's sound button mutes it. Shots in an animatic usually have no sound worth
  hearing, so a video track's sound starts muted once a sound file is in the edit, and on before.
- **Cached ahead.** The edit's videos and sound are asked of the cache (`WB.media.want`) in the order they
  play from the playhead, as the Timeline's are, and the bar has the same ring ("3/12 cached", "Cached").
- **Keys, the same as everywhere.** Space or K plays and pauses, `,` and `.` step a frame (with Shift, a
  second), the arrows go to the cut before or after, Home and End to the start and end, M the sound, and the
  loop button plays the edit round. Time shows as seconds, frames or timecode, as chosen.

## The editor

The page is the player above and the timeline below, beside the sidebar and under the page's bar, as the
Timeline is docked. A panel on the left lists what can go on it.

- **What can go on it.** The project's shots by sequence, each with its newest still (which scrubs under the pointer, as cards do) and a search box. Drag one onto a track, or several at
  once, which go one after another. Double-click puts one at the playhead on the track in use. Elsewhere,
  "Add to animatic…" in a shot's or version's menu, and beside "Add to playlist" where versions are picked,
  puts them at the end of an animatic's V1 (or makes a new one with them). "Add file…" at the panel's foot, or
  a sound file dropped on the timeline, brings in audio.
- **A start.** A new animatic can start empty or "from the Timeline": every shot of a sequence (or of all) in
  order on V1, each as long as its newest version, so the first cut is there in one step and the work is
  changing it.
- **Tracks.** Video tracks above, sound tracks below, a line between them. Each has a header with its name,
  its sound button and (video) its eye; "Add track" at the foot of each half, and a track's menu takes it away.
- **Clips.** Each shows its shot's name and the rest of its version's label in a plain band along its top, and
  its frames under it (taken as `cuttrack.js` takes them, from the copy kept on this computer); a sound clip
  shows its waveform. Loops show where they start over, the part a short version leaves empty shows as an outline, and a fade is a slope drawn
  in its top corner. Nothing on a clip is coloured but what is selected (blue edge).
- **Working on clips.** Click picks (Shift adds, a box over empty track picks many), drag moves (to another
  track too), Alt and a drag copies, and an edge drags to trim: the left edge moves the in point, the right
  the length (never past the end of its version, unless it loops). Moves and trims snap to cuts, to the
  playhead and to the edges of clips on other tracks, with a guide line (Ctrl held stops it, as on a board).
  Ctrl+B cuts the clip under the playhead in two. Delete leaves a gap. Nothing closes gaps or pushes clips
  along on its own; a move only ever moves what is picked. The small
  handle at a clip's top corner drags out its fade; dragged across a cut it makes a dissolve. A clip's menu
  has Loop, Fade in and out by a second, Open the shot (its page in the catalogue) and Delete.
- **Undo.** Ctrl+Z and Ctrl+Shift+Z, each person their own, kept as the `doc` before each change (it is
  small, so this is simple and exact).
- **Zoom and scroll.** The wheel scrolls, with Ctrl or Cmd it zooms about the pointer, and the playhead is
  dragged along the ruler. The edit's length, the playhead's time and the zoom are in a strip along the top
  of the timeline.
- **Phones and narrow windows.** Editing needs a desk: under 900 the editor folds away to the player and
  an overview strip of the edit, as the Timeline has it, to watch and comment.

The design rules hold: tokens from `style.css` only, controls 32px (28 small), hairlines between tracks
rather than boxes, a clip is a strip of its own picture with nothing drawn over the picture, ink for the tool
in hand, blue for what is picked, the playhead and what is new, red only for deleting.

## Comments

What is said in an animatic is said about the clip on top under the playhead, on the version it plays, as on
the Timeline: so it is there in the catalogue and on every board the version is on, and the team sees notes
made in a review of the edit where they work. The comments panel, drawings and @mentions are the player's
own (`roomNotes` and `entityRoom` in `viewer.js`), joined to the shot under the playhead a beat after it
comes on screen. A comment on a slate, or on a sound clip, is not possible, as neither has a version.

## The code

- `store.js`: the `animatics` table, and `animatics(projectId)`, `animatic(id)`, `addAnimatic`,
  `setAnimatic(id, { name, doc }, rev)` (refusing an old `rev`), `deleteAnimatic`.
- `server.js`:
  - `GET /api/projects/<id>/animatics`, and `POST` with `{ name, doc }` or `{ name, from: 'timeline', seq }`;
    the project's catalogue (`GET /api/projects/<id>`) lists them beside its playlists for the Reviews page.
  - `GET /api/animatics/<id>`: the `doc`, its `rev`, and the newest versions it plays. `PATCH { name }`, `PATCH { doc, rev }` (409 with the newer one when `rev` is old), `DELETE`.
    - `cleanAnimatic(doc)`, as `cleanLook` and `cleanComment` are: known fields only, whole numbers in range,
    at most 16 tracks and 2,000 clips, each clip's shot one of the project's shots, each sound file one on
    this server.
  - Sound uploads: `.wav`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.flac` added to `UPLOAD_EXTS` and `MIME`, kept in
    `media` as kind `audio` with their length.
- `public/cut.js` (new, plain functions with no page, so it is tested on its own as `snap.js` is): what shows
  at a moment and at what opacity, which frame of its version a clip shows then (loops included), how much
  of a clip its version fills, the clips to load ahead, snapping, moving, trimming, cutting.
- `public/animatic.js` (new): the page, the player and the editor.
- `public/ingest.js`: bringing a sound file in (no review copy: its length and a waveform are read in the
  browser, and the file goes up as it is).
- `public/home.js`: the Reviews list, New animatic, the card, the sidebar row, the page's route and menu,
  "Add to animatic…".
- `public/icons.js`, `public/style.css`, `public/index.html` (the new scripts), README.md.
- `test/server.test.js`: making, reading, saving, the `rev` refusal, a clip following a new version, what is
  refused by `cleanAnimatic`, sound uploads. `test/cut.test.js`: the timeline's arithmetic.

## In what order

Each step is something that can be tried in the browser.

1. **The record and the server.** The table, the endpoints, `cleanAnimatic`, resolving the newest versions,
   sound uploads, with their tests. An animatic can be made "from the Timeline" and read back.
2. **The timeline's arithmetic** (`cut.js`) with its tests: what shows when, fades, dissolves, loops,
   clips cut short by their versions.
3. **Playing it.** The page, listed in Reviews and the sidebar, with the player: layers, the one clock, sound,
   the cache, the keys, and the timeline drawn but not yet editable. A cut made from the Timeline plays, with
   a sound file under it.
4. **Editing it.** The panel of shots, drag on, move, trim, cut, delete, tracks, snapping, undo, saving with
   `rev`.
5. **Fades and dissolves**, drawn and dragged on the clips.
6. **Comments** on the clip under the playhead.

## Later

- **Downloading the edit for a playback system**, such as disguise: a file describing the cut, and the files
  it plays (see below).
- **Presenting it**, as the Timeline is presented: those watching follow the edit, its playhead and its
  sound. The link's files are the edit's.
- **Holding a clip to a version**, for comparing the edit as it was with as it is.
- **A black or a title card** to put on any track: a dip to black over a stack of tracks, a slate between
  scenes.
- **Editing together, live**, if two people working on one edit at once becomes common.

Not planned: following the length of a version by pushing clips along, holding a version's last frame, a
mark for what is new since somebody last looked, a task per clip, assets and sets on the timeline, and
downloading the edit as one video.

## Downloading the edit as a file

The aim is that a cut made here goes straight into a playback system, such as disguise, rather than being
rebuilt there. Which format depends on what the system takes in, which has to be found out first: no
documentation was found saying disguise imports an EDL, so it is worth asking them what it does take in, and
whether its API could be used to build its timeline instead. The likely formats, and what each can carry:

- **CMX 3600 EDL**, the old plain-text one: one video track per file (so one file for each track), cuts,
  dissolves and fades to and from black, sources named by reel and timecode. A dissolve on a higher track over
  a lower one cannot be said in it, and neither can a loop (it would be written out as the shot again, as
  many times as it plays).
- **OpenTimelineIO** (`.otio`, JSON) or **Final Cut Pro XML**: every track, every transition, the sound, in one
  file. Most editors and conform tools read one of them, and OpenTimelineIO converts to the others.

What it means for the plan now, so that writing any of them out later is simple:

- **Positions are whole frames at the edit's own rate**, as planned. The edit's rate should be the playback
  system's (25, 50, 60), chosen when the animatic is made.
- **The `doc` already has the shape all of them share**: tracks, clips with where they sit and which part of
  their source they use, and fades. Nothing needs to change in it.
- **The files go with it, named by shot, not by version.** The download would be the cut and the newest
  version of every shot it plays, each named for its shot (`kilo-0010.mp4`), as the zip of a board already is.
  The cut then never needs to change when a shot is updated: the new file is put over the old one in the
  playback system, which is this app's own idea of "always the newest", carried over. Exactly which version
  each file is goes in a comment in the cut and in a list beside it.
- **Source timecode** is counted from zero at the start of each file, as versions carry none of their own.
