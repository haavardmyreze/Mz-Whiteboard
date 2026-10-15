# 3D: a project's work on a model of its venue

**Status: in the player.** A project's settings can hold a model of its venue; the player then has a 2D / 3D
switch (see README.md, "3D: the work on the venue"). The code is `public/view3d.js`, driven by
`public/viewer.js`; the settings dialog is in `public/home.js` (projectSettings); the server keeps the setting
(cleanProjectSettings) and a comment's `pov: 'main'` (cleanComment), and accepts `.glb` uploads.

How it fits together:

- **One video, two ways of drawing it.** The 3D view textures the screens with the player's own `<video>`
  (or `<img>`), which plays on unseen beneath the canvas. Time, stepping, scrubbing, the run's cuts and the
  cache are the player's, unchanged.
- **The main camera is the frame.** In 3D the piece box takes the main camera's shape (glTF's
  `aspectRatio`, 16:9 if none) but shows nothing itself: the venue is drawn on a canvas over the whole
  stage, through the main camera into exactly the piece box's rectangle, letterboxed on the player's dark
  ground. So the laser and pen work as on any picture, and a drawing is kept in the same units as ever; it
  is marked `pov: 'main'` and shown only in 3D through the main camera. Any move of the view (a drag that
  is not the pen's, eraser's or laser's, the wheel, a move key) flies off: the view fills the stage, its lens
  widened so the room stays the size it was, drawings hide and the pen is put down.
- **Which view goes on the screens** is the project's setting (its main one unless said), not the
  player's view dropdown, which hides in 3D.
- **Not yet:** the player opened from a board does not offer 3D (the board's pieces are its own copies,
  not the project's versions). A model replaced after comments were drawn through it would leave those
  drawings off target; keep a model once it is in use, or move its main camera with care.

---

The exploration that led here (the lab page it mentions has since been folded into the player and removed):

# A 3D preview of projection work: how feasible it is

The idea: a project can have a 3D model of its venue. What is filed is always the unwrapped picture
(cmp, vr), and the player can show it on the model, walked around with W A S D, instead of needing a
rendered bty for every version. The model has a UV channel and a material slot named for the
projection area ("screen").

**Short answer: feasible, and cheap to do well for the common case.** A working spike is in
`public/lab/preview3d.html` (open `/lab/preview3d.html` on a running server, then drop a `.glb` and a
video on it). It loads a glTF/GLB, finds every mesh whose material is named `screen` (or `screen-…`),
shows the video on it through the mesh's own UVs, unlit, and lets you fly about as in Unreal Engine's
viewport: W and S along the view wherever it points, A and D sideways, Q/E straight down and up, a drag
to look, Shift for faster, the wheel to glide (or, with a button held, to set the speed), every move
easing in and out; the model's own cameras are viewpoints, with an overview. The picture is a version
filed in a project ("Filed version", "Preview in 3D (lab)" in a version's menu in the app, or
`?version=…`), its main view to start with and its other views in a dropdown, or any file dropped on
the page. The model is kept in the browser for next time. The room is lit from all round (a soft
environment, hemisphere and ambient light, and a sun for shape), and nothing in it is more than half
metal, so no side of anything comes out black. It was tried with a small test venue (a curved 150° wall, a floor, steps) and a test video:
the picture lands on the wall the right way up and the right way round, and plays.

**One main camera.** The model has one camera that is *the* view: the one named `main`, or else its
first. Looking through it (V) the view is exactly that camera's, its place, its lens and the shape of
its frame (glTF's `aspectRatio`), letterboxed in the window, so everyone sees the same picture whatever
their screen. Moving freely is for looking about. **Drawing is only done through the main camera**
(turning the pen on, P, switches to it): a stroke is kept in that camera's frame, 0 to 1 across and
down, on the frame of the video it was drawn on. In the spike, a ring drawn round a block stays on the
block after walking off and coming back, and after the window changes size.

## Why it fits the app

- **The texture is the player's own `<video>`.** three.js draws a `VideoTexture` from any video element,
  so in the app the 3D view would be one more way of drawing the video the player already has open.
  Time, play and pause, frame stepping, scrubbing, the run's cuts, the cache: all unchanged, nothing
  to keep in sync. A still works the same way.
- **Nothing to fetch from the internet.** three.js is served from the installed package
  (`/vendor/three/…`, as mediabunny is), loaded only when the 3D view is opened. As served now it is
  about 2.1 MB (some 420 KB gzipped), and the glTF loader 120 KB more; once fetched it is cached.
- **It ties in with views.** A model can have several projection areas (`screen-left`, `screen-floor`),
  and a version several views (`left`, `floor`): each area can show the view of its name, and the
  plain `screen` the main one. A project with no model never sees any of it.

## What it takes to make it real

1. **The model, per project.** Upload a `.glb` in the project's settings (the upload route needs to
   accept `.glb`; models are typically 5–200 MB, within the upload limit), with the screen material's
   name (default `screen`). Kept in the project's settings like its naming preset. One model per
   project to start; per-sequence models later if venues differ.
2. **A "3D" switch in the player's bar**, shown only in a project that has a model, for videos and
   stills alike. The picture area becomes the WebGL canvas, drawing the open video; the timeline,
   comments and the close-up track stay as they are. Camera position remembered per project.
3. **Comments in 3D, through the main camera.** A comment's moment works as now. A comment made in
   3D says so (`pov: 'main'`), and its drawing is kept in the main camera's frame, exactly as the
   player keeps a drawing in the picture's frame today: the same ink, the same units, only another
   frame. Opening such a comment, in the player or from a notification, switches to the main camera,
   so the drawing is always seen from where it was drawn. Free movement has no pen. A comment on the
   flat picture stays on the flat picture. If the main camera is moved in a new model, drawings made
   through the old one no longer line up, so a model, once comments are drawn through it, is kept: a
   new model is a new one, and older comments keep pointing at the model and camera they were drawn in.
4. **Resolution.** Review copies are at most 1920×1080. Fine for a wall seen from the audience, soft
   for a large dome or a close look. The 3D view could ask for the original (which is kept) when it is
   not too large, or the review copy limit could be raised for projects with a model.

Rough size: the spike is under 300 lines. Settings upload and the bar switch are a day or two; comments
that remember the camera another day; drawing onto the surface is the larger, optional part.

## What to ask of the people making the models

- **glTF binary (`.glb`)**, exported from Blender, Maya, Houdini or C4D. FBX and OBJ could be read too,
  but glTF keeps material names, UVs and cameras reliably and needs no conversion.
- **One UV channel on the screen meshes**, laid out as the unwrapped picture is (0–1 covering the
  frame, top left at the top left). If the projection UVs are on a second channel, that can be chosen
  (`uv1`), but the first is simplest.
- **The projection area's material named `screen`** (or `screen-left`, `screen-top`… for several).
- **One camera named `main`**, placed where the work is judged from (the best seat, say), with its
  aspect ratio set to the shape the review should have. Its lens and frame are what every drawing is
  made through. Other cameras (the control booth, a side seat) become viewpoints to move from.
- **Metres, Y up**, the glTF default.
- **Keep it light**: a venue as blocks, no hidden detail; textures on the room are fine but not needed.

## Risks and limits

- **Lighting is not a render.** The screen is drawn as light (unlit), the room plainly lit. It shows
  where the picture lands, seams, stretching and what the audience sees, not how bright the
  projection will be or how it washes over the room. That is what bty renders are still for.
- **Very heavy models** (millions of triangles, large textures) are slow on laptops and phones; the
  guidance above avoids it. A model can be checked when it is uploaded (triangle count, size).
- **Safari** draws video textures well; older iPhones may be slow on large videos. A phone could
  default to the flat view.
- **Headless test browsers** draw WebGL in software, so a test of it can be slow; the logic around it
  (finding screens, viewpoints) can be tested without drawing.
