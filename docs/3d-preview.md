# 3D: a project's work on a model of its venue

**Status: in the player.** A project's settings can hold a model of its venue; the player then has a 2D / 3D
switch (see README.md, "3D: the work on the venue"). The code is `public/view3d.js`, driven by
`public/viewer.js`; the settings dialog is in `public/home.js` (projectSettings); the server keeps the setting
(cleanProjectSettings) and where a comment made in 3D was made from (`pov`, cleanComment), and accepts `.glb`
uploads.

How it fits together:

- **One video, two ways of drawing it.** The 3D view textures the screens with the player's own `<video>`
  (or `<img>`), which plays on unseen beneath the canvas. Time, stepping, scrubbing, the run's cuts and the
  cache are the player's, unchanged.
- **A frame, or flying.** The view is either held on a frame or flying. A frame is one of the model's
  cameras (the one named `main`, or its first, to start with; the others are in the menu beside "Main
  camera"), with its own shape (glTF's `aspectRatio`, 16:9 if none), or the place a comment was made
  from, always 16:9. In 3D the piece box takes the frame's shape but shows nothing itself: the venue is
  drawn on a canvas over the whole stage, through the frame into exactly the piece box's rectangle,
  letterboxed on bars darker than the player's ground. So the laser and pen work as on any picture, and a
  drawing is kept in the same units as ever. Any move of the view (a drag that is not the pen's, eraser's
  or laser's, the wheel, a move key) flies off: the view fills the stage, its lens widened so the room
  stays the size it was, drawings hide and the pen is put down.
- **Comments are made from wherever the view is.** Beginning one (the pen or eraser taken up, the comment
  box clicked into, or a comment sent while flying) holds the view still where it is, framed 16:9 with the
  room kept at its size. The comment keeps that view as `pov: { p: [x, y, z], q: [x, y, z, w], fov }` (the
  camera's place, its turn as a quaternion, and its lens in degrees top to bottom); a drawing's strokes are
  in that frame. Picking the comment glides back to it, turning the player to 3D if need be, and its
  drawing shows only there. A drawing begun and not yet sent keeps its frame: beginning again goes back to
  it. Comments drawn before this through the main camera say `pov: 'main'` and still open on it.
- **Which view goes on the screens** is the project's setting (its main one unless said), not the
  player's view dropdown, which hides in 3D.
- **On a board** in such a project, the player offers 3D for a piece that is a version (catalogued) and
  has the view the project puts on the model (any version, when the project uses the main view). In 3D it
  shows that view's file, which may not be the one on the board; a piece that is not a version, or lacks
  that view, is shown as it is, and stepping to it turns the player back to 2D. The server sends each
  version a board shows with its `look3d` (boardVersion in server.js), and the board's model as `view3d`
  with its init, and again when the project's setting changes. Following someone on a board, or watching
  a presentation, follows 2D or 3D, the camera and the flight (`d` in the presence).
- **How the venue is drawn** is the viewer's own, kept by the browser (`wb:3dlook`), and set under the
  settings button beside the 3D switch (setLook in view3d.js). They start at a dim room (5%) lit by its
  screens (95%), with occlusion (59%, reaching 0.55 m) and cavity (40%). The Effects switch over them,
  off, draws the venue plainly (`PLAIN` in viewer.js: the room fully lit, no shade, no screen light) and
  keeps the settings for when it is turned on again. Room light scales the room's lights and
  its environment, never the screens. Ambient occlusion and cavity are done in screen space, as Unreal's
  and Blender's viewports do them: the room is drawn a second time with only its normals and depth (the
  screens marked to be left alone), occlusion is worked out from that at half size and smoothed, cavity
  from how the normals bend from pixel to pixel, and both are multiplied into what was drawn. Off, neither
  costs anything. All of it but the last step depends only on where the view is, so the room's normals
  and depth, the occlusion and its smoothing are kept while the view is still (a frame held while a video
  plays) and worked out again only when the view, the size or the settings change.
  Lower quality (`low` in the look, also kept in `wb:3dlook`, but not part of what Reset restores) takes
  from this and from the screen light, never from the canvas, which keeps its resolution (LOW in view3d.js):
  the normals and depth are drawn at half the size across, the occlusion is 4 samples at an eighth of the
  size instead of 16 at a half, cavity looks one step out instead of two, and the screens are cut into at
  most 4 patches instead of 32, which take the picture's colours every other frame.
- **Screen light.** Lumen traces the scene, which a browser cannot afford every frame; but a venue's light
  comes almost all from its screens, whose shape is known. So each screen is cut by its UVs into at most
  32 patches (8 by 4 cells of the picture, fewer when there are several screens), each a small lamp at
  its place, facing as the screen does, as large as its part of the screen. Every frame the picture is
  brought down to 256 by 128 and its mipmaps on the graphics card, each patch takes the mean colour of
  its cell from there, and the room's materials add what every patch gives a point, as a disc of light
  would, to their light from all round. No shadows (light goes through a wall), and no bounce; about 32
  lamps' worth of work for each pixel of the room, and none while it is off.
- **In an animatic** (docs/animatic.md), the picture is a canvas the animatic lays its clips on, over one
  another as its 2D picture blends them; `setSource` takes a `<canvas>` and takes it again each time the
  animatic sets its `fresh`. How the venue is drawn is the same settings and menu as the player's
  (`lookShown`, `listenLook`, `lookMenu` in viewer.js), and the animatic borrows one 3D view for the page.
- **Where it was left.** Closing the player (or leaving the page) keeps, for this tab and by model,
  whether it was in 3D and where the view was (`wb:3dat:<model>` in sessionStorage: a flight's place, a
  camera's number or a comment's frame); the next piece opened in the project opens that way, unless it
  is opened on a comment or to follow somebody.
- **Not yet:** a model replaced or moved after comments were made in it would leave their views (and
  drawings) off target; keep a model once it is in use.

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
- **A main camera**, placed where the work is judged from (the best seat, say), with its aspect ratio
  set to the shape the review should have. Choose it as Main camera in the project's settings (they list
  the cameras the file has); without a choice, the one named `main` is taken, or else the first. Its lens and frame are what every drawing is
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
