# A 3D preview of projection work: how feasible it is

The idea: a project can have a 3D model of its venue. What is filed is always the unwrapped picture
(cmp, vr), and the player can show it on the model, walked around with W A S D, instead of needing a
rendered bty for every version. The model has a UV channel and a material slot named for the
projection area ("screen").

**Short answer: feasible, and cheap to do well for the common case.** A working spike is in
`public/lab/preview3d.html` (open `/lab/preview3d.html` on a running server, then drop a `.glb` and a
video on it). It loads a glTF/GLB, finds every mesh whose material is named `screen` (or `screen-…`),
shows the video on it through the mesh's own UVs, unlit, and lets you walk about: W A S D, Q/E down and
up, drag to look, Shift for faster, the wheel for speed, the model's own cameras as viewpoints, and an
overview. It was tried with a small test venue (a curved 150° wall, a floor, steps) and a test video:
the picture lands on the wall the right way up and the right way round, and plays.

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
3. **Comments in 3D.** A comment's moment works as now. Drawing on a 3D view is the open question:
   simplest is to keep drawing on the flat picture (switch back to draw), and have a comment made in
   3D remember the camera, so clicking it puts you back where it was seen from. Drawing straight onto
   the screen surface (ray-cast to UV, stored in picture coordinates) is possible later and would then
   show on the flat picture too.
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
- **Metres, Y up**, the glTF default. Cameras placed in the model (an audience seat, the control
  booth) become viewpoints by name.
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
