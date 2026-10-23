# Animatics: an edit that always plays the newest versions

**Status: built.** A third kind of review in a project, beside the board and the playlist (see README.md,
"Animatics"). The arithmetic of the edit is `public/cut.js`, the page is `public/animatic.js`, its place among
a project's reviews is in `public/home.js`, the server keeps it (`animatics` in `store.js`, cleanAnimatic and
the endpoints in `server.js`) and writes it out for a playback system (`cutfiles.js`).

## What it is for

A show is cut together long before its shots are finished. Some shots loop, some could go in more than one
order, some are tried in two places, and the team needs to see how it plays as a whole. Before this, that meant
downloading the newest version of every shot, bringing them into a video editor and cutting them there, and
doing it all again each time a shot was updated. An animatic does that cut inside the app: a timeline with
tracks that shots are dropped onto, played back as an edit. Each clip on it is a shot, not a file, so it always
plays that shot's newest version. When a version is filed, every animatic the shot is in shows it: an animatic
left open takes it in within a few seconds, and the next play is the updated edit.

## How it fits with what is there

- **A third kind of review.** A project's Reviews lists boards, playlists and animatics together, and New makes
  any of the three. An animatic's page is `#/f/<project>/animatic/<id>`, under Reviews in the sidebar with an
  icon of its own. Its card is its first stills side by side, as a playlist's is, and its line says Animatic
  where other kinds are listed beside it. It is renamed, copied ("Make a copy", for another cut of the same
  shots), set up, downloaded, pinned and deleted from the menu beside its title.
- **Only in a project, and only shots.** A clip names a shot of the project and plays its newest version: of
  any task, unless one task is picked for the whole animatic (the settings button in its bar). Nobody has to
  choose anything for it to play. Where the project shows its versions more than one way, the same button picks
  the view. A shot with nothing filed of that task plays as a slate.
- **Added to from elsewhere.** "Add to animatic…" is in a shot's menu and a shot version's menu, and "Add to
  animatic" is beside "Add to playlist" where versions are picked and in the catalogue's selection bar: the
  shots go at the end of an animatic's V1, one after another.
- **Uses what the Timeline built.** The video cache (`media.js`), the frames the Timeline's close-up takes from
  the shots (`cuttrack.js`, shared through `WBCutTrack.frames`), the time formats (seconds, frames, timecode)
  and the comment rooms of the shots (`entityRoom` in `viewer.js`). Its player is its own: the Timeline's shows
  one piece at a time, and an edit with tracks and dissolves shows two or more at once.

## The edit, as it is kept

One record per animatic, in the `animatics` table: `id`, `project_id`, `name`, `doc` (JSON), `rev` (a number
counting its saves), `created_at`, `created_by`, `updated_at`, `updated_by`. The `doc` is the whole edit, small
enough to be read and written whole:

```js
{
  fps: 25,                  // the edit's own rate; every position below is in its frames
  w: 1920, h: 1080,         // the edit's shape: what each clip is fitted into, on black
  task: null,               // the newest of which task each clip plays (null: of any)
  view: '',                 // which view of each version, where the project has views
  tracks: [
    { id: 'v1', kind: 'video', name: 'V1', mute: false, hide: false },
    { id: 'v2', kind: 'video', name: 'V2', mute: false, hide: false },
    { id: 'a1', kind: 'audio', name: 'A1', mute: false, gain: 1 },
  ],
  clips: [
    // A shot: its newest version, from `in` frames into it, for at most `len` frames.
    { id, track: 'v1', start: 0, len: 96, in: 0, shot: '<entity id>', loop: false, fadeIn: 0, fadeOut: 12, dissolve: 0, gain: 1 },
    // A sound file: an upload of its own, not a version.
    { id, track: 'a1', start: 0, len: 2400, in: 0, media: '/uploads/abc.wav', name: 'temp music.wav', dur: 96, fadeIn: 0, fadeOut: 50, dissolve: 0, gain: 0.8 },
  ],
}
```

- **Tracks stack.** Video tracks in the order kept, the first lowest; a higher one covers a lower wherever both
  have a clip. Every clip is shown whole on black in the edit's shape, so a clip of another shape never lets
  the track under it show through its bars. Under everything is black.
- **A fade shows what is under the clip.** On the lowest track that is black, a fade to black; over another
  clip it is a dissolve between them. A dissolve between two clips side by side on one track is the later
  one's (`dissolve`, in frames), centred on the cut: the later clip starts half of it early, over the one
  before, which plays half of it on past the cut. Where either has no frames there, the player shows its
  nearest frame for the length of the dissolve; the one before only plays on if its version reaches the cut.
  Sound clips fade the same way, and a dissolve between two of them crosses their sound over.
- **Loops.** A looping clip goes round its whole version as often as its length needs; `in` is where in the
  version it starts.
- **Saving.** Each change is saved a moment after it is made, with the `rev` it was made from. A save made from
  an older `rev` is refused (`409`) with the newer edit and who made it; the page shows that one, says who
  changed it, and keeps the change that was refused as a step back in its undo.
- **What the server keeps** is checked by cleanAnimatic: a rate from the usual ones (23.976 to 60), at least one
  video and one sound track (sixteen at most), each clip on a track of its kind, a video clip naming a shot of
  the project, a sound clip naming an uploaded sound file, fades no longer than their clip, 2,000 clips at most.

## The newest version, and what happens when it changes

`GET /api/animatics/<id>` gives the `doc` and, for each shot on it, the newest version as the animatic plays it
(its whole look: review copy, phone copy, still, length, rate, colour strip, views; and its label). Nothing of a
version is copied into the `doc`, so filing a version is all it takes. The page asks again every fifteen
seconds, and on coming back to the window, unless a change of its own is on its way.

An edit can be intricate, cut to music, with tracks lined up against each other, so **nothing on the timeline
ever moves because a version changed**, and nothing is ever pushed along by anything but a person moving it:

- **The version is longer than the clip.** The clip stays as long as it was cut and plays that much of it.
- **The version is shorter than the clip.** The clip ends where the version ends, and what is under it (a lower
  track, or black) shows after that. Its last frame is not held. The length it was cut to stays in the `doc`
  (`len` is "at most"), so a later version long enough fills it again; the timeline draws the part it lost as
  an outline saying how many frames short it came up.
- **A looping clip** fills its length whatever its version's length.
- **A clip dropped in** is as long as its version is then (a still, or a shot with nothing filed, three seconds).

## The player

- **Layers of `<video>`.** For each frame, `cut.layersAt` says which clips show, lowest first, each with its
  opacity and the frame of its version. Each is a `<video>` (or picture, or slate) stacked in that order in a
  box of the edit's shape, its opacity its fade: the browser blends them.
- **Only what is wanted is decoded.** A clip wholly covered by another is left paused unless it will be
  uncovered within a second and a half, when it plays on unseen in step so it is ready. A pool of six video
  elements is shared out among the clips showing, those about to be uncovered, and those about to start, each
  loaded and waiting on its first frame a second and a half ahead (`cut.coming`), so the cut to it is clean.
- **One clock.** Playing, time is the sound's clock (`AudioContext.currentTime`), which the sound files are
  scheduled on to the sample. Each video is kept to it: a little off and it plays up to a tenth quicker or
  slower, more than three tenths of a second off and it jumps. A looping clip's video loops by itself, so going
  round is no jump. Stopped, every layer is put on its exact frame.
- **Sound.** A sound file is fetched whole and decoded into Web Audio: it starts on the exact sample, its fades
  are ramps on a gain, and its waveform is drawn from it (scaled to its loudest moment). A shot's own sound
  plays from its video, its volume following its fade; each track's button mutes it. The first sound file in an
  edit turns the video tracks' sound off, as shots in an animatic seldom have sound worth hearing.
- **Cached ahead.** The edit's videos are asked of the cache in the order they play from the playhead.

## The editor

The page is the edit playing in the middle, the project's shots down the left, the comments on the shot on
screen down the right, and under them the bar (play, step, the time, loop, the shot on screen, cut, snapping,
the settings button, sound, show all of it, comments) and the timeline: track heads on the left, a ruler, and
the tracks drawn on one canvas on the dark bed the Timeline's close-up has, in both themes.

- **Putting shots on.** Drag one from the list onto a track, double-click it (or Enter) to put it at the
  playhead on the track in use, or Add all for a sequence (at the end of V1). A new animatic can start with
  every filed shot in order. Sound files come from Add sound file… or are dropped on the page or a sound track.
- **Clips.** Each shows its shot's name and version in a band along its top and its frames under it (its colour
  strip until they come), a slate's stripes, or a sound's waveform. Loops are marked where they start over, a
  short clip's lost part is an outline, fades are slopes, dissolves a cross over the cut. Only what is picked
  is coloured (in the accent), and the playhead.
- **Working on clips.** Click picks (Shift adds, a box on empty track picks many), drag moves (to another track
  of its kind too; Alt copies), the edges trim (never past the end of the version unless it loops). Moves and
  trims line up with cuts, the playhead and the edges of clips on other tracks, with a guide line (Ctrl skips
  it). What lands on other clips writes over them (`cut.place`): one wholly under goes, one across an edge is
  trimmed, one across both is cut in two. The handles under a picked clip's band draw out its fades, or at a
  cut its dissolve. Ctrl+B cuts in two at the playhead; Delete leaves a gap. A clip's menu (right-click) has
  Loop, a second's fades, No fades, cutting at the playhead, Open the shot and Delete.
- **Undo** is each person's own, kept as the `doc` before each change.
- **Narrow windows.** Under 900 the list of shots is left out, under 700 the comments and the editing buttons
  too: the picture, its bar and the timeline are what there is room for.

## Comments

What is said is about the clip on top under the playhead, on the version it plays, as on the Timeline: so it is
there in the catalogue and on every board the version is on. The page joins the room of the shot on screen a
moment after it comes on, lists that version's threads (each with the moment it is about; a click goes there),
and writes, replies, resolves and deletes through it. Nothing can be said about a slate or a sound.

## Downloading the edit for a playback system

`GET /api/animatics/<id>/download` (the menu's "Download for a playback system…") is one zip, made as it is sent
and resumable as a board's is:

- **`<name>.otio`**, OpenTimelineIO: every track (video, then sound), gaps, clips with the part of their file
  they play, dissolves as SMPTE dissolves centred on the cut, fades as dissolves from and to a gap (black on
  the lowest track, what is under it on another, as in the app), the rate and shape. What it is (shot, version,
  loop, gains, hidden or muted tracks) is in each item's `boards` metadata.
- **`<name> <track>.edl`**, a CMX 3600 edit decision list for each track that has anything to play: cuts,
  dissolves (`D`), fades as dissolves to and from black (`BL`), reels named by shot, `* FROM CLIP NAME` lines
  naming the file, timecode from zero at the edit's rate, non-drop. It knows one track at a time, so a fade on
  a higher track becomes a fade to black there. A dissolve whose later clip has too few frames before its in
  point is shortened on that side.
- **`<name> versions.csv`**: which version each file is, when it was filed, by whom, and the file it came from.
- **The files**: each shot's newest version in the animatic's view (the file it was made from where that was
  kept, else its review copy), named by the shot (`kilo-0010.mp4`), and each sound file by its name. A shot
  with nothing filed has none and is a gap. Loops are written out as the shot again each time round.

Named by shot, the cut never needs to change when a shot is updated: the new file goes over the old one in the
playback system, which carries the app's "always the newest" over to it. Which format a given system takes in
(disguise, say) is worth asking its makers; OpenTimelineIO converts to most others.

## Later

- **Presenting it**, as the Timeline is presented: those watching follow the edit, its playhead and its sound.
- **Holding a clip to a version**, for comparing the edit as it was with as it is.
- **A black or a title card** to put on any track: a dip to black over a stack of tracks, a slate between scenes.
- **Editing together, live**, if two people working on one edit at once becomes common.
