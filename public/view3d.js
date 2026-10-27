// The player's 3D view (viewer.js): a project's model of its venue, with the piece open in the player
// shown on its projection surface. The picture is the player's own <video> or <img>, so playing, stepping,
// the timeline and comments go on as they do in 2D; this only draws it another way. An animatic's player
// (animatic.js) gives it a <canvas> instead, on which it lays the clips showing over one another, and sets
// the canvas's `fresh` each time it has drawn a new picture there. Loaded the first time
// a project with a model is looked at in 3D (three.js comes from the installed package, see server.js).
//
// What it is given is the project's setting (see cleanProjectSettings in server.js): the model, and the
// name of the material its projection surface has; every mesh with that material (or one named like it,
// "screen-left") shows the picture through its own UVs, unlit. The rest of the room is lit from all round,
// so no side of anything is ever black; how much, the shade in its corners and creases, and whether the
// screens light it too, are the player's settings (`setLook`).
//
// It opens through the model's main camera (the one the project's settings choose; without one, the camera
// named "main", or else its first): its place, lens
// and frame's shape, letterboxed where the player's piece box is (`frameOf()`), on bars darker than the
// room's ground, so it is the same picture on every screen. The model's other cameras are frames to look
// through as well, and so is the place a comment was made from (`hold()`, `goTo(pov)`, `pose()`): what is
// drawn on such a frame lands on the same thing for everyone. Any move of the view leaves the frame (a drag,
// the wheel, a move key), unless the player has a pen, eraser or laser in hand (`holds(e)`): then the view
// fills the whole picture area, to fly about as in
// Unreal Engine's viewport: W and S along the view, A and D sideways, Q and E down and up, a drag to look
// (with both buttons held, to slide along the view's plane), the wheel to glide (with a button held, to
// set the speed), every move easing in and out. Nothing is drawn while flying.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const models = new Map(); // url -> Promise of the loaded glTF, shared by every view on the page
const arrived = new Map(); // url -> how much of it has come, from 0 to 1 (null while that is not known)
// The model's file is kept on this computer with the videos (media.js): fetched once, and after that read
// from the disk on every page that shows it, whatever the browser's own cache keeps (a large model it may
// not keep at all, and then every refresh fetched it again). It is held there, never the one made room for.
// Where nothing can be kept (a plain http address), the browser fetches it as it would.
async function modelFile(url) {
  const media = window.WBMedia;
  if (media && media.keepable(url) && (await media.ready)) {
    media.want('venue', [url], { rank: media.RANK.venue, hold: true });
    let blob = null;
    try {
      blob = await media.get(url, { onProgress: (loaded, total) => arrived.set(url, total ? loaded / total : null) });
    } catch (err) {
      // Too large to keep, or no room: fetched as the browser would.
      console.warn('The venue is not kept on this computer:', err.message);
    }
    if (blob) return new GLTFLoader().parseAsync(await blob.arrayBuffer(), '');
  }
  return new GLTFLoader().loadAsync(url, (e) => arrived.set(url, e.lengthComputable && e.total ? e.loaded / e.total : null));
}
const loadModel = (url) => {
  if (!models.has(url)) {
    arrived.set(url, 0);
    const p = modelFile(url);
    p.then(() => arrived.set(url, 1), () => {
      models.delete(url);
      arrived.delete(url);
    });
    models.set(url, p);
  }
  return models.get(url);
};
// The player fetches a project's model ahead, while a piece that can be seen on it is open, so that 3D is
// there at once when asked for; and says how far it has come while it is asked for and not there yet.
export const preload = (url) => loadModel(url).catch(() => {});
export const progress = (url) => (arrived.has(url) ? arrived.get(url) : 0);

const EASE_IN = 0.14; // seconds to get most of the way to the speed asked
const EASE_OUT = 0.2; // and to come to rest
const LOOK_EASE = 0.035;
const UP = new THREE.Vector3(0, 1, 0);
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

// The view is held on a frame, or flying. A frame is one of the model's cameras (its main one to start
// with), or a place a comment was made from: its camera's place, turn and lens over a 16:9 frame.
//
// `onFree(on)` hears when the view leaves a frame to fly, or has come to one; `frameOf()` says where on the
// page the frame held is (a DOMRect: the player lays it out at aspect()); `seen()` where across the page the
// view is seen ({ left, right }; the whole canvas unless said); `holds(e)` says a press is the player's own
// (drawing, erasing, pointing), not a move of the view.
export function create({ onFree = () => {}, frameOf = () => null, seen = () => null, holds = () => false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'v-3d';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // The letterbox around the frame held: darker than the room's own ground, so the frame reads.
  const LETTERBOX = new THREE.Color(0x09090a);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The room is tone mapped softly; the screens are not, so the picture is as filed.
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1c1e);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  // The room's light, each at what it gives with the room light full (see setLook).
  const lights = [
    [scene, 'environmentIntensity', 0.3],
    [new THREE.HemisphereLight(0xffffff, 0x707070), 'intensity', 0.55],
    [new THREE.AmbientLight(0xffffff), 'intensity', 0.22],
    [new THREE.DirectionalLight(0xffffff), 'intensity', 1.4],
  ];
  lights[3][0].position.set(4, 10, 6);
  for (const [light] of lights.slice(1)) scene.add(light);

  // `camera` is the one flown; `view` is what is drawn through: the frame held, the flown one, or a glide
  // between them.
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 5000);
  camera.rotation.order = 'YXZ';
  const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 5000);
  let room = null; // the model in the scene
  let modelUrl = '';
  let screenName = 'screen';
  let main = { cam: true, name: '', position: new THREE.Vector3(0, 1.6, 6), quaternion: new THREE.Quaternion(), fov: 50, aspect: 16 / 9 };
  let cams = [main]; // the model's cameras: { cam, name, position, quaternion, fov, aspect }
  // The lens flying is done through, in degrees across the view as it is seen (as Unreal measures its field of
  // view), as the project sets it; 0 is the main camera's own, in degrees across its frame.
  let flyLens = 0;
  // The frame held, or come back to: a camera of `cams`, or a comment's (no `cam`; its `fov` is worked out
  // from `keep`, the lens over the whole canvas, once the player has laid out its frame).
  let fixed = main;
  let texture = null;
  let source = null;
  let free = false;
  let running = false;
  let raf = 0;

  // ---- the model

  // The model's main camera: the one the project names, else one named main, else its first.
  const mainOf = (list, chosen) => (chosen && list.find((c) => c.name === chosen)) || list.find((c) => c.name.toLowerCase() === 'main') || list[0];

  // `fov` is the lens to fly through (flyLens), where the project sets one.
  async function load({ model, screen = 'screen', camera: chosen = '', fov = 0 }) {
    screenName = (screen || 'screen').toLowerCase();
    flyLens = fov > 0 ? fov : 0;
    if (model === modelUrl && room) {
      main = mainOf(cams, chosen);
      if (fixed && fixed.cam) fixed = main;
      applyScreens();
      return survey();
    }
    const gltf = await loadModel(model);
    // Put up by another call while this one waited for it: as it is, with the view left where it is.
    if (model === modelUrl && room) return load({ model, screen, camera: chosen, fov });
    if (room) scene.remove(room);
    room = gltf.scene.clone(true);
    // Its materials are this view's own: the screens' light is put into them (see litByScreens).
    room.traverse((o) => {
      if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    });
    modelUrl = model;
    scene.add(room);
    room.updateMatrixWorld(true);
    // Its cameras, with the shape glTF says their frames have (aspectRatio; 16:9 if it says none).
    const json = gltf.parser.json;
    const shapeOf = new Map((json.nodes || []).filter((n) => n.camera != null).map((n) => [n.name, json.cameras[n.camera]?.perspective?.aspectRatio]));
    cams = [];
    room.traverse((o) => {
      if (!o.isCamera) return;
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      o.getWorldPosition(position);
      o.getWorldQuaternion(quaternion);
      const name = o.name || o.parent?.name || `Camera ${cams.length + 1}`;
      cams.push({ cam: true, name, position, quaternion, fov: o.fov, aspect: shapeOf.get(o.name) || shapeOf.get(o.parent?.name) || 16 / 9 });
    });
    const box = new THREE.Box3().setFromObject(room);
    const size = box.getSize(new THREE.Vector3());
    // No camera in the model: a look at all of it from the front stands in for one.
    if (!cams.length) {
      const centre = box.getCenter(new THREE.Vector3());
      const look = new THREE.PerspectiveCamera();
      look.position.set(centre.x, centre.y + size.y * 0.1, box.max.z + Math.max(size.x, size.y) * 0.6);
      look.lookAt(centre);
      cams.push({ cam: true, name: '', position: look.position.clone(), quaternion: look.quaternion.clone(), fov: 50, aspect: 16 / 9 });
    }
    main = mainOf(cams, chosen);
    fixed = main;
    speed = Math.max(1, size.length() / 12);
    applyScreens();
    survey();
    settle();
  }

  // Every mesh with the screen's material shows the picture; a material the model does not give is fully
  // metal in glTF, which shows only reflections and comes out nearly black, so none is more than half metal.
  const isScreen = (m) => {
    const name = ((m.userData.was || m).name || '').toLowerCase();
    return name === screenName || [`${screenName}-`, `${screenName}_`, `${screenName}.`].some((p) => name.startsWith(p));
  };
  function applyScreens() {
    if (!room) return;
    room.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m, i) => {
        const was = m.userData.was || m;
        if (!isScreen(was)) {
          mats[i] = was;
          if ('metalness' in was && was.metalness > 0.5 && !was.metalnessMap) was.metalness = 0.5;
          litByScreens(was);
          return;
        }
        const lit = m.userData.was ? m : new THREE.MeshBasicMaterial({ toneMapped: false, side: THREE.DoubleSide });
        lit.userData.was = was;
        lit.map = texture;
        lit.color.set(texture ? 0xffffff : 0x2a2a2a);
        lit.needsUpdate = true;
        mats[i] = lit;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });
  }

  // ---- how the room is drawn: its light, the shade in its corners and creases, and the screens' light
  //
  // `look` is the player's 3D settings (setLook): the room's light from 0 (dark) to 2, with 1 as it is lit
  // otherwise; ambient occlusion (`ao`, 0 to 1, reaching `aoRadius` metres) and cavity (0 to 1), both
  // shading the room and never the screens; and the light the screens throw on the room (`glow`, on or
  // off, at `glowAmount`, 1 being as bright as the picture is). `low` is for slower graphics cards, and takes
  // from what is worked out on top of the room, never from the picture drawn, which keeps its resolution
  // (LOW): the normals and depth that shade is worked from are drawn at half the size across; the occlusion
  // is 4 samples at an eighth, not 16 at a half; cavity looks one step out, not two; and the screens' light
  // is 4 lamps, not 32, taking the picture's colours every other frame.
  const look = { light: 1, ao: 0, aoRadius: 0.5, cavity: 0, glow: false, glowAmount: 1, low: false };
  const LOW = { shadeSize: 2, aoSize: 8, aoStride: 4, cavitySteps: 1, patches: 4, glowEvery: 2 };
  const FULL_QUALITY = { shadeSize: 1, aoSize: 2, aoStride: 1, cavitySteps: 2, patches: 32, glowEvery: 1 };
  const quality = () => (look.low ? LOW : FULL_QUALITY);
  function setLook(o) {
    const was = look.low;
    for (const key of Object.keys(look)) if (o && typeof o[key] === typeof look[key] && (typeof o[key] !== 'number' || Number.isFinite(o[key]))) look[key] = o[key];
    for (const [light, key, full] of lights) light[key] = full * look.light;
    // The lamps are chosen for how many there may be.
    if (room && was !== look.low) findPatches();
  }
  setLook();

  // Drawn over the whole of what is shown (`quad`, through `flat`), for the passes below.
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const QUAD_VS = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const shader = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({ vertexShader: QUAD_VS, fragmentShader, uniforms, depthTest: false, depthWrite: false, ...extra });
  function pass(material, target) {
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(quad, flat);
  }

  // The screens' light. Lumen traces the scene; a browser has to be cheaper than that, and a venue's
  // light comes almost all from its screens, which are known. So each screen is cut into patches by
  // its UVs (at most PATCHES of them all told, 4 when quality is lower, as many as fit in a grid over the
  // picture: 8 by 4, then fewer), each a small lamp at its place, facing as the screen does there, as large as its part of the
  // screen, with the colour of its part of the picture now. Every frame the picture is brought down to
  // GLOW (and its mipmaps), and each patch takes its colour from there, all on the graphics card; the
  // room's materials add what each patch gives a point (as a disc of light would: no shadows, which is
  // what keeps it cheap) to the light that comes from all round, so the room's own textures and baked
  // occlusion tint it as they do the rest.
  const PATCHES = FULL_QUALITY.patches;
  const GLOW = [256, 128];
  const patchAt = Array.from({ length: PATCHES }, () => new THREE.Vector4()); // world place, and area
  const patchFacing = Array.from({ length: PATCHES }, () => new THREE.Vector4()); // its normal
  const patchUv = Array.from({ length: PATCHES }, () => new THREE.Vector3()); // its part of the picture, and the mipmap that averages it
  const glowRT = new THREE.WebGLRenderTarget(...GLOW, { type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const patchRT = new THREE.WebGLRenderTarget(PATCHES, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const glowUniforms = {
    screenGlow: { value: 0 },
    screenPatches: { value: 0 },
    screenPatchAt: { value: patchAt },
    screenPatchFacing: { value: patchFacing },
    screenPatchColor: { value: patchRT.texture },
  };
  // The picture brought down to GLOW, each pixel the mean of four samples across it.
  const glowDown = shader(`
    uniform sampler2D map; uniform vec2 texel; varying vec2 vUv;
    void main() {
      vec2 d = texel * 0.25;
      gl_FragColor = vec4(0.25 * (texture2D(map, vUv - d).rgb + texture2D(map, vUv + d).rgb
        + texture2D(map, vUv + vec2(d.x, -d.y)).rgb + texture2D(map, vUv + vec2(-d.x, d.y)).rgb), 1.0);
    }`, { map: { value: null }, texel: { value: new THREE.Vector2(1 / GLOW[0], 1 / GLOW[1]) } });
  // Each patch's colour: one pixel each, the mean of its part of the picture.
  const glowPatches = shader(`
    uniform sampler2D glow; uniform vec3 at[${PATCHES}];
    void main() { vec3 a = at[int(gl_FragCoord.x)]; gl_FragColor = vec4(textureLod(glow, a.xy, a.z).rgb, 1.0); }`,
  { glow: { value: glowRT.texture }, at: { value: patchUv } });
  const GLOW_HEAD = `
    uniform float screenGlow; uniform int screenPatches;
    uniform vec4 screenPatchAt[${PATCHES}]; uniform vec4 screenPatchFacing[${PATCHES}];
    uniform sampler2D screenPatchColor;`;
  // A disc of area A and radiance L lights a point d away, facing it, with pi L A / (pi d^2 + A): the
  // inverse square far off, and no more than the whole disc can give up close. Each side of a screen
  // gives light, as a model's screen may face either way.
  const GLOW_BODY = `
    if (screenGlow > 0.0) {
      vec3 here = -vViewPosition;
      vec3 lit = vec3(0.0);
      for (int i = 0; i < ${PATCHES}; i++) {
        if (i >= screenPatches) break;
        vec4 at = screenPatchAt[i];
        vec3 L = (viewMatrix * vec4(at.xyz, 1.0)).xyz - here;
        float d2 = dot(L, L);
        L *= inversesqrt(max(d2, 1e-8));
        float facing = abs(dot((viewMatrix * vec4(screenPatchFacing[i].xyz, 0.0)).xyz, L)) * max(dot(normal, L), 0.0);
        lit += texelFetch(screenPatchColor, ivec2(i, 0), 0).rgb * (at.w * facing / (PI * d2 + at.w));
      }
      reflectedLight.indirectDiffuse += screenGlow * PI * lit * BRDF_Lambert(material.diffuseColor);
    }`;
  function litByScreens(m) {
    if (!m.isMeshStandardMaterial || m.userData.litByScreens) return;
    m.userData.litByScreens = true;
    m.onBeforeCompile = (s) => {
      Object.assign(s.uniforms, glowUniforms);
      s.fragmentShader = s.fragmentShader
        .replace('void main() {', `${GLOW_HEAD}\nvoid main() {`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${GLOW_BODY}`);
    };
    m.customProgramCacheKey = () => 'lit-by-screens';
    m.needsUpdate = true;
  }
  // The screens' patches, from their triangles: points spread evenly over them, gathered by mesh and by
  // the cell of the grid their UVs fall in, each cell a patch where its points are on average.
  let patches = 0;
  function findPatches() {
    patches = 0;
    const limit = quality().patches;
    const tris = [];
    let total = 0;
    let mesh = 0;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    const t = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
    room.traverse((o) => {
      if (!o.isMesh || !o.geometry.attributes.uv) return;
      const g = o.geometry;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const index = g.index;
      const count = index ? index.count : g.attributes.position.count;
      const groups = Array.isArray(o.material) && g.groups.length ? g.groups : [{ start: 0, count, materialIndex: 0 }];
      let any = false;
      for (const group of groups) {
        if (!mats[group.materialIndex] || !isScreen(mats[group.materialIndex])) continue;
        any = true;
        const end = Math.min(count, group.start + group.count);
        for (let i = group.start; i + 2 < end; i += 3) {
          for (let k = 0; k < 3; k++) {
            const n = index ? index.getX(i + k) : i + k;
            v[k].fromBufferAttribute(g.attributes.position, n).applyMatrix4(o.matrixWorld);
            t[k].fromBufferAttribute(g.attributes.uv, n);
          }
          const normal = new THREE.Vector3().subVectors(v[1], v[0]).cross(new THREE.Vector3().subVectors(v[2], v[0]));
          const area = normal.length() / 2;
          if (!(area > 0)) continue;
          tris.push({ v: v.map((x) => x.clone()), t: t.map((x) => x.clone()), normal: normal.normalize(), area, mesh });
          total += area;
        }
      }
      if (any) mesh++;
    });
    if (!total) return;
    // The points, the same each time (a fixed sequence, not chance), weighted by the area each stands for.
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const points = [];
    for (const tri of tris) {
      const n = Math.max(1, Math.round((tri.area / total) * 6000));
      for (let i = 0; i < n; i++) {
        let a = rand();
        let b = rand();
        if (a + b > 1) [a, b] = [1 - a, 1 - b];
        const c = 1 - a - b;
        points.push({
          p: new THREE.Vector3().addScaledVector(tri.v[0], c).addScaledVector(tri.v[1], a).addScaledVector(tri.v[2], b),
          u: tri.t[0].x * c + tri.t[1].x * a + tri.t[2].x * b,
          w: tri.t[0].y * c + tri.t[1].y * a + tri.t[2].y * b,
          normal: tri.normal, area: tri.area / n, mesh: tri.mesh,
        });
      }
    }
    for (const [gx, gy] of [[8, 4], [4, 4], [4, 2], [2, 2], [2, 1], [1, 1]]) {
      const cells = new Map();
      for (const x of points) {
        const key = `${x.mesh}:${THREE.MathUtils.clamp(Math.floor(x.u * gx), 0, gx - 1)}:${THREE.MathUtils.clamp(Math.floor(x.w * gy), 0, gy - 1)}`;
        let cell = cells.get(key);
        if (!cell) cells.set(key, (cell = { p: new THREE.Vector3(), normal: new THREE.Vector3(), u: 0, w: 0, area: 0 }));
        cell.p.addScaledVector(x.p, x.area);
        cell.normal.addScaledVector(x.normal, x.area);
        cell.u += x.u * x.area;
        cell.w += x.w * x.area;
        cell.area += x.area;
      }
      if (cells.size > limit && gx > 1) continue;
      const lod = Math.log2(Math.max(GLOW[0] / gx, GLOW[1] / gy));
      [...cells.values()].sort((a, b) => b.area - a.area).slice(0, limit).forEach((cell, i) => {
        patchAt[i].set(cell.p.x / cell.area, cell.p.y / cell.area, cell.p.z / cell.area, cell.area);
        if (cell.normal.lengthSq() < 1e-12) cell.normal.set(0, 1, 0);
        cell.normal.normalize();
        patchFacing[i].set(cell.normal.x, cell.normal.y, cell.normal.z, 0);
        patchUv[i].set(cell.u / cell.area, cell.w / cell.area, lod);
        patches = i + 1;
      });
      break;
    }
  }
  // Every frame the screens' light is on (every other, at lower quality, the patches keeping their colours
  // between): the picture's colours, now, into the patches.
  let glowFrame = 0;
  function glowNow() {
    glowUniforms.screenPatches.value = patches;
    glowUniforms.screenGlow.value = look.glow && texture && patches ? look.glowAmount : 0;
    if (!glowUniforms.screenGlow.value || glowFrame++ % quality().glowEvery) return;
    glowDown.uniforms.map.value = texture;
    pass(glowDown, glowRT);
    pass(glowPatches, patchRT);
    renderer.setRenderTarget(null);
  }

  // The shade in the room's corners and creases, worked out from what was drawn (screen space, as Unreal's
  // and Blender's viewports do it), and laid over it: the room is drawn again with only which way each
  // surface faces and how far it is (`facing`), the screens left out, then
  // - ambient occlusion: from each point, 16 samples in the half of a ball of `aoRadius` over its
  //   surface, turned a little from pixel to pixel in a 4 by 4 pattern, each one behind what is drawn there
  //   a little shade; at half size, then smoothed over the 4 by 4 (not across an edge in depth); with
  //   lower quality, 4 samples at an eighth of the size;
  // - cavity: where the surface's facing changes from pixel to pixel as it does into a crease, a little
  //   dark, as Blender's cavity does its valleys;
  // and what is drawn is multiplied by both. Nothing of it is done while both are off. All of it but the
  // last step depends only on where the view is, so it is worked out again only when the view, the size or
  // the settings change, not for each frame of a video played on a view held still.
  const facing = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthTexture: new THREE.DepthTexture(1, 1) });
  const aoRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const aoSmooth = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const screenMark = new THREE.ShaderMaterial({ vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(0.0); }', side: THREE.DoubleSide });
  const facingOf = new Map();
  const facingFor = (m) => {
    const key = `${m.side}:${m.flatShading ? 1 : 0}`;
    if (!facingOf.has(key)) facingOf.set(key, new THREE.MeshNormalMaterial({ side: m.side, flatShading: !!m.flatShading }));
    return facingOf.get(key);
  };
  let parts = []; // { o: a mesh of the room, as: what it is drawn with for `facing` }
  function survey() {
    parts = [];
    shaded = '';
    room.traverse((o) => {
      if (!o.isMesh) return;
      const one = (m) => (isScreen(m) ? screenMark : facingFor(m));
      parts.push({ o, as: Array.isArray(o.material) ? o.material.map(one) : one(o.material) });
    });
    findPatches();
  }
  const KERNEL = Array.from({ length: 16 }, (_, i) => {
    const t = (i + 0.5) / 16;
    const turn = i * 2.39996;
    const r = Math.sqrt(t);
    const reach = 0.1 + 0.9 * ((i + 1) / 16) ** 2;
    return new THREE.Vector3(r * Math.cos(turn), r * Math.sin(turn), Math.sqrt(1 - t)).multiplyScalar(reach);
  });
  const DEPTH = `
    #include <packing>
    uniform sampler2D tDepth; uniform sampler2D tFacing; uniform float near; uniform float far;
    float zAt(vec2 uv) { return perspectiveDepthToViewZ(texture2D(tDepth, uv).x, near, far); }`;
  const depthUniforms = () => ({ tDepth: { value: facing.depthTexture }, tFacing: { value: facing.texture }, near: { value: 0.05 }, far: { value: 5000 } });
  const occlusion = shader(`${DEPTH}
    uniform mat4 proj; uniform mat4 projInv; uniform vec3 kernel[16]; uniform int stride; uniform float radius; varying vec2 vUv;
    vec3 placeAt(vec2 uv, float d) { vec4 p = projInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
    void main() {
      float d = texture2D(tDepth, vUv).x;
      vec4 f = texture2D(tFacing, vUv);
      if (d >= 1.0 || f.a < 0.5) { gl_FragColor = vec4(1.0); return; }
      vec3 P = placeAt(vUv, d);
      vec3 N = normalize(f.xyz * 2.0 - 1.0);
      ivec2 px = ivec2(gl_FragCoord.xy) % 4;
      float turn = float((px.x * 4 + px.y) * 7 % 16) * 0.3926991;
      vec3 T = vec3(cos(turn), sin(turn), 0.0);
      T -= N * dot(T, N);
      T = dot(T, T) < 1e-4 ? cross(N, vec3(0.0, 0.0, 1.0)) : T;
      T = normalize(T);
      mat3 tbn = mat3(T, cross(N, T), N);
      float shade = 0.0;
      int taps = 16 / stride;
      for (int i = 0; i < 16; i++) {
        if (i >= taps) break;
        vec3 s = P + tbn * kernel[i * stride + stride - 1] * radius;
        vec4 o = proj * vec4(s, 1.0);
        vec2 uv = o.xy / o.w * 0.5 + 0.5;
        if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
        float z = zAt(uv);
        shade += step(s.z + 0.02 * radius, z) * smoothstep(0.0, 1.0, radius / abs(P.z - z));
      }
      gl_FragColor = vec4(vec3(1.0 - shade / float(taps)), 1.0);
    }`, { ...depthUniforms(), proj: { value: null }, projInv: { value: null }, kernel: { value: KERNEL }, stride: { value: 1 }, radius: { value: 0.5 } });
  const smoothing = shader(`${DEPTH}
    uniform sampler2D tAo; uniform vec2 texel; varying vec2 vUv;
    void main() {
      float z0 = zAt(vUv);
      float sum = 0.0;
      float n = 0.0;
      for (int x = -2; x < 2; x++) for (int y = -2; y < 2; y++) {
        vec2 uv = vUv + vec2(x, y) * texel;
        float w = step(abs(zAt(uv) - z0), 0.05 * abs(z0));
        sum += texture2D(tAo, uv).r * w;
        n += w;
      }
      gl_FragColor = vec4(vec3(n > 0.0 ? sum / n : texture2D(tAo, vUv).r), 1.0);
    }`, { ...depthUniforms(), tAo: { value: aoRT.texture }, texel: { value: new THREE.Vector2() } });
  // Laid over what is drawn: multiplied into it (so the letterbox and the screens are left as they are).
  const shading = shader(`${DEPTH}
    uniform sampler2D tAo; uniform vec2 texel; uniform float ao; uniform float cavity; uniform int steps; varying vec2 vUv;
    vec3 facingNear(vec2 uv, vec3 n0, float z0) {
      vec4 f = texture2D(tFacing, uv);
      return f.a < 0.5 || abs(zAt(uv) - z0) > 0.04 * abs(z0) ? n0 : f.xyz * 2.0 - 1.0;
    }
    void main() {
      vec4 f = texture2D(tFacing, vUv);
      if (f.a < 0.5) { gl_FragColor = vec4(1.0); return; }
      float k = 1.0;
      if (ao > 0.0) k *= pow(texture2D(tAo, vUv).r, 2.0 * ao);
      if (cavity > 0.0) {
        vec3 n = f.xyz * 2.0 - 1.0;
        float z = zAt(vUv);
        float bend = 0.0;
        for (int i = 1; i <= 2; i++) {
          if (i > steps) break;
          vec2 dx = vec2(texel.x * float(i) * 1.5, 0.0);
          vec2 dy = vec2(0.0, texel.y * float(i) * 1.5);
          bend += facingNear(vUv + dx, n, z).x - facingNear(vUv - dx, n, z).x + facingNear(vUv + dy, n, z).y - facingNear(vUv - dy, n, z).y;
        }
        k *= 1.0 - clamp(-bend * 0.4 * cavity * (2.0 / float(steps)), 0.0, 0.8);
      }
      gl_FragColor = vec4(vec3(k), 1.0);
    }`, { ...depthUniforms(), tAo: { value: aoSmooth.texture }, texel: { value: new THREE.Vector2() }, ao: { value: 0 }, cavity: { value: 0 }, steps: { value: 2 } }, {
    blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  // After the room is drawn into the part of the canvas `w` by `h` pixels that the viewport is set to.
  let shaded = ''; // what facing, aoRT and aoSmooth were last worked out for (the key below)
  function shade(w, h) {
    if (!room || !(look.ao > 0 || look.cavity > 0)) return;
    const q = quality();
    const fw = Math.ceil(w / q.shadeSize);
    const fh = Math.ceil(h / q.shadeSize);
    const aw = Math.ceil(w / q.aoSize);
    const ah = Math.ceil(h / q.aoSize);
    const key = [fw, fh, aw, ah, look.ao > 0 ? look.aoRadius : -1, q.aoStride, ...view.matrixWorld.elements, ...view.projectionMatrix.elements].join();
    for (const m of [occlusion, smoothing, shading]) {
      m.uniforms.near.value = view.near;
      m.uniforms.far.value = view.far;
    }
    if (key !== shaded) {
      shaded = key;
      if (facing.width !== fw || facing.height !== fh) facing.setSize(fw, fh);
      if (aoRT.width !== aw || aoRT.height !== ah) {
        aoRT.setSize(aw, ah);
        aoSmooth.setSize(aw, ah);
      }
      const ground = scene.background;
      scene.background = null;
      for (const p of parts) {
        p.was = p.o.material;
        p.o.material = p.as;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(facing);
      renderer.render(scene, view);
      for (const p of parts) p.o.material = p.was;
      scene.background = ground;
      if (look.ao > 0) {
        occlusion.uniforms.proj.value = view.projectionMatrix;
        occlusion.uniforms.projInv.value = view.projectionMatrixInverse;
        occlusion.uniforms.radius.value = look.aoRadius;
        occlusion.uniforms.stride.value = q.aoStride;
        pass(occlusion, aoRT);
        smoothing.uniforms.texel.value.set(1 / aoRT.width, 1 / aoRT.height);
        pass(smoothing, aoSmooth);
      }
    }
    shading.uniforms.texel.value.set(1 / facing.width, 1 / facing.height);
    shading.uniforms.ao.value = look.ao;
    shading.uniforms.cavity.value = look.cavity;
    shading.uniforms.steps.value = q.cavitySteps;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    pass(shading, null);
    renderer.autoClear = auto;
  }

  // ---- the picture: the player's own <video>, <img> or <canvas>

  let shownAt = -1; // the moment of the video the screens last took a frame of
  function setSource(el) {
    if (el === source) return;
    source = el;
    shownAt = -1;
    if (texture) texture.dispose();
    texture = null;
    if (el && el.tagName === 'VIDEO') texture = new THREE.VideoTexture(el);
    else if (el && el.tagName === 'CANVAS') {
      texture = new THREE.CanvasTexture(el);
      el.fresh = false;
    } else if (el && el.tagName === 'IMG') {
      texture = new THREE.Texture(el);
      const ready = () => { if (texture && texture.image === el) texture.needsUpdate = true; };
      if (el.complete && el.naturalWidth) ready();
      else el.addEventListener('load', ready, { once: true });
    }
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      // glTF's UVs start at the top left of a picture; three's textures at the bottom left unless told.
      texture.flipY = false;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    applyScreens();
  }

  // ---- held on a frame, or flying

  let yaw = 0;
  let pitch = 0;
  let viewYaw = 0;
  let viewPitch = 0;
  let speed = 3;
  const vel = new THREE.Vector3();
  const held = new Set();
  let shift = false;
  let drag = null;

  // Between frames, and between a frame and flying, the view glides: leaving, the letterbox opens out to the
  // whole area with the room kept at its size; going to a frame, the camera moves and turns to it as the
  // letterbox closes in. Drawings show once it is there. Without motion, if the system asks.
  const OUT_MS = 260;
  const IN_MS = 480;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  let shown = FULL; // the part of the canvas last drawn into, in fractions of it
  let glide = null; // { to: 'free' | 'fixed', t0, ms, from: rect, pos, quat, tan }
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const tanHalf = (deg) => Math.tan(THREE.MathUtils.degToRad(deg) / 2);
  const fovOf = (tan) => THREE.MathUtils.radToDeg(2 * Math.atan(tan));
  // Flying, the lens is never wider than 122.5° across, whatever the shape of the window: as
  // a lens's height in degrees, for an area of that shape.
  const MAX_ACROSS = 122.5;
  const capped = (fov, aspect) => THREE.MathUtils.clamp(fov, 20, fovOf(tanHalf(MAX_ACROSS) / aspect));
  const mix = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p });
  // Where the frame held is on the canvas, in fractions of it.
  function frameRect(r) {
    const f = frameOf();
    if (!f || !f.width || !f.height || !r.width || !r.height) return null;
    return { x: (f.left - r.left) / r.width, y: (f.top - r.top) / r.height, w: f.width / r.width, h: f.height / r.height };
  }

  // On the main camera at once, as when a model is put up.
  function settle() {
    free = false;
    glide = null;
    fixed = main;
    shown = FULL;
    vel.set(0, 0, 0);
    held.clear();
    view.position.copy(main.position);
    view.quaternion.copy(main.quaternion);
    view.fov = main.fov;
    canvas.classList.remove('free');
  }
  // Flying starts from wherever the view is (on a frame, or on its way to one), looking where it looks,
  // with the room at the size it was; the glide out then eases to the lens flown through: the one the project
  // sets (flyLens), or else the main camera's, spanning that many degrees across the view as it is seen.
  function fly() {
    if (free) return;
    free = true;
    camera.position.copy(view.position);
    camera.quaternion.copy(view.quaternion);
    const e = new THREE.Euler().setFromQuaternion(view.quaternion, 'YXZ');
    yaw = viewYaw = e.y;
    pitch = viewPitch = e.x;
    // (Kept to 122.5° across: past that the glide out eases the room in to it rather than jumping.)
    const r = canvas.getBoundingClientRect();
    const keep = tanHalf(view.fov) / shown.h;
    const aspect = r.width && r.height ? r.width / r.height : 16 / 9;
    const lens = flyLens || fovOf(tanHalf(main.fov) * main.aspect);
    camera.fov = r.width && r.height ? capped(fovOf(r.height / 2 / lensAcross(lens, r)), aspect) : fovOf(tanHalf(lens) / aspect);
    glide = calm.matches ? null : { to: 'free', t0: performance.now(), ms: OUT_MS, from: { ...shown }, tan: keep };
    canvas.classList.add('free');
    onFree(true);
  }
  // The focal length, in pixels of the canvas `r`, at which the part of it seen spans `lens` degrees across. The
  // view looks out through the canvas's middle, and the part seen need not be centred on it (the strip on one
  // side, the comments on the other), so it is found by halving, its two sides' angles added up.
  function lensAcross(lens, r) {
    const s = seen();
    const mid = r.left + r.width / 2;
    const toLeft = Math.max(1, s ? mid - s.left : r.width / 2);
    const toRight = Math.max(1, s ? s.right - mid : r.width / 2);
    const spans = (f) => THREE.MathUtils.radToDeg(Math.atan(toLeft / f) + Math.atan(toRight / f));
    let lo = 1e-3;
    let hi = 1e6;
    for (let i = 0; i < 60; i++) {
      const f = Math.sqrt(lo * hi);
      if (spans(f) > lens) lo = f;
      else hi = f;
    }
    return Math.sqrt(lo * hi);
  }
  // To a frame, from flying or from another frame: gliding from wherever the view is.
  function holdOn(target, animate = true) {
    const ms = animate && !calm.matches ? IN_MS : 0;
    free = false;
    track.length = 0;
    lag = Infinity;
    fixed = target;
    vel.set(0, 0, 0);
    held.clear();
    glide = ms ? { to: 'fixed', t0: performance.now(), ms, from: { ...shown }, pos: view.position.clone(), quat: view.quaternion.clone(), tan: tanHalf(view.fov) / shown.h } : null;
    canvas.classList.remove('free');
  }
  // A comment is made from where the view is: it holds still there, framed 16:9, with the room kept at the
  // size it was. Already on a comment's frame (or on the way to one), it stays.
  function hold() {
    if (!free && !fixed.cam) return;
    holdOn({ position: view.position.clone(), quaternion: view.quaternion.clone(), fov: null, keep: tanHalf(view.fov) / shown.h, aspect: 16 / 9 });
  }
  // A comment's frame's lens, once the player has laid the frame out: the room as large as it was.
  function settleLens(fr) {
    if (fixed.fov == null) fixed.fov = THREE.MathUtils.clamp(fovOf(fixed.keep * (fr || FULL).h), 1, 179);
  }
  // What `pov` (as kept with a comment) stands for: 'main', a camera's number in cameras(), or a place.
  function frameFor(pov) {
    if (pov === 'main') return main;
    if (Number.isInteger(pov)) return cams[pov] || null;
    if (!pov || !Array.isArray(pov.p) || !Array.isArray(pov.q) || !Number.isFinite(pov.fov)) return null;
    return { position: new THREE.Vector3(...pov.p), quaternion: new THREE.Quaternion(...pov.q).normalize(), fov: pov.fov, aspect: 16 / 9 };
  }
  // Whether frame `f` is the one held (or being glided to).
  function same(f) {
    if (f === fixed) return true;
    if (f.cam || fixed.cam) return false;
    settleLens(frameRect(canvas.getBoundingClientRect()));
    const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) < e);
    return near(fixed.position.toArray(), f.position.toArray(), 1e-3) && Math.abs(fixed.quaternion.dot(f.quaternion)) > 1 - 1e-6 && Math.abs(fixed.fov - f.fov) < 1e-2;
  }
  function goTo(pov, animate = true) {
    const target = frameFor(pov);
    if (!target || (!free && same(target))) return false;
    holdOn(target, animate);
    return true;
  }
  // Held on `pov`, and there, not on the way.
  function at(pov) {
    if (free || glide) return false;
    const f = frameFor(pov);
    return !!f && same(f);
  }
  // The comment's frame held, as kept with a comment; null on a camera of the model's, or flying.
  function pose() {
    if (free || fixed.cam) return null;
    settleLens(frameRect(canvas.getBoundingClientRect()));
    const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
    return { p: fixed.position.toArray().map((v) => r(v, 4)), q: fixed.quaternion.toArray().map((v) => r(v, 6)), fov: r(fixed.fov, 3) };
  }

  // Flying, where the view is and where it looks, as somebody following it is sent it (see steer), and when
  // (`t`, this page's clock in milliseconds), so the moves can be played back at the pace they were made.
  function flight() {
    if (!free) return null;
    const r = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
    return { p: camera.position.toArray().map((v) => r(v, 3)), q: camera.quaternion.toArray().map((v) => r(v, 5)), fov: r(camera.fov, 2), t: Math.round(performance.now()) };
  }
  // Where the view is, to be put back there another time (`place`): flown to a place ({ f }), on a camera
  // of the model's ({ c }: its number in cameras()), or on a comment's frame ({ q }).
  function where() {
    if (free) {
      const { p, q, fov } = flight();
      return { f: { p, q, fov } };
    }
    if (fixed.cam) return { c: cams.indexOf(fixed) };
    const q = pose();
    return q ? { q } : null;
  }
  function place(w) {
    if (!w) return false;
    const f = w.f;
    if (f && Array.isArray(f.p) && f.p.length === 3 && Array.isArray(f.q) && f.q.length === 4 && Number.isFinite(f.fov) && [...f.p, ...f.q].every(Number.isFinite)) {
      fly();
      glide = null;
      track.length = 0;
      vel.set(0, 0, 0);
      camera.position.fromArray(f.p);
      camera.quaternion.fromArray(f.q).normalize();
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      yaw = viewYaw = e.y;
      pitch = viewPitch = e.x;
      camera.fov = f.fov;
      return true;
    }
    if (Number.isInteger(w.c)) return goTo(w.c, false);
    if (w.q) return goTo(w.q, false);
    return false;
  }

  // Following somebody's flight: the places they were sent from are kept, and the view is put where they were
  // a moment ago (BEHIND), in between the two places either side of then. Played back that way, a move
  // is as smooth here as it was there, whatever the network did to when each place arrived.
  const BEHIND = 120; // milliseconds
  const track = [];   // { t: their clock, p, q, fov }
  let lag = Infinity; // how far behind their clock ours is, at the least seen: the time it takes to get here
  function steer(pov) {
    if (!pov || !Array.isArray(pov.p) || !Array.isArray(pov.q)) return;
    fly();
    const now = performance.now();
    const t = Number.isFinite(pov.t) ? pov.t : now;
    if (track.length && t <= track[track.length - 1].t) {
      // A clock started again (they reloaded): what was kept is no use against it.
      if (track[track.length - 1].t - t > 1000) {
        track.length = 0;
        lag = Infinity;
      } else return;
    }
    // The least delay seen of late: one place that came quickly says how quickly they can.
    lag = Math.min(lag + 0.5, now - t);
    track.push({ t, p: new THREE.Vector3(...pov.p), q: new THREE.Quaternion(...pov.q).normalize(), fov: pov.fov });
    while (track.length > 2 && track[1].t < t - 2000) track.shift();
  }
  // Where the view goes this frame, following a flight: true when it was put there.
  const here = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  function followFlight(now) {
    if (!track.length) return false;
    const when = now - lag - BEHIND;
    let i = track.length - 1;
    while (i > 0 && track[i - 1].t > when) i--;
    const b = track[i];
    const a = i > 0 ? track[i - 1] : b;
    const k = b === a || b.t <= a.t ? 1 : THREE.MathUtils.clamp((when - a.t) / (b.t - a.t), 0, 1);
    here.p.lerpVectors(a.p, b.p, k);
    here.q.slerpQuaternions(a.q, b.q, k);
    camera.position.copy(here.p);
    camera.quaternion.copy(here.q);
    if (Number.isFinite(a.fov) && Number.isFinite(b.fov)) camera.fov = a.fov + (b.fov - a.fov) * k;
    // Where flying would carry on from, should they stop being followed.
    const e = new THREE.Euler().setFromQuaternion(here.q, 'YXZ');
    yaw = viewYaw = e.y;
    pitch = viewPitch = e.x;
    vel.set(0, 0, 0);
    return true;
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // A press moves the view (and so leaves the frame held), unless it is the player's: a pen, eraser or
  // laser at work on the frame.
  canvas.addEventListener('pointerdown', (e) => {
    if (!free && holds(e)) return;
    e.stopPropagation();
    e.preventDefault();
    fly();
    drag = { x: e.clientX, y: e.clientY, pid: e.pointerId };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety
    }
  });
  // A drag looks about; with both buttons held, as in Unreal, it slides the camera along the view's own
  // plane instead (sideways, and up and down as the view stands), at a pace that goes with the flying speed.
  const PAN = 0.0015; // metres a pixel, for each metre a second of flying speed (which the wheel, a button held, sets)
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.stopPropagation();
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if ((e.buttons & 3) === 3) {
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      camera.position.addScaledVector(right, dx * speed * PAN).addScaledVector(up, -dy * speed * PAN);
      return;
    }
    yaw -= dx * 0.0032;
    pitch = THREE.MathUtils.clamp(pitch - dy * 0.0032, -1.55, 1.55);
  });
  const letGo = (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.stopPropagation();
    drag = null;
  };
  canvas.addEventListener('pointerup', letGo);
  canvas.addEventListener('pointercancel', letGo);
  canvas.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    fly();
    if (drag) {
      speed = THREE.MathUtils.clamp(speed * (e.deltaY > 0 ? 0.85 : 1.18), 0.1, 500);
      return;
    }
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    vel.addScaledVector(fwd, (e.deltaY > 0 ? -1 : 1) * speed * 1.2);
  }, { passive: false });
  // Keys come from the player, which has the keyboard (see viewer.js): true when the key was this view's.
  function key(e, down) {
    shift = e.shiftKey;
    if (!MOVE.has(e.code) || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (down) {
      fly();
      held.add(e.code);
    } else held.delete(e.code);
    return true;
  }
  const onKeyUp = (e) => {
    shift = e.shiftKey;
    held.delete(e.code);
  };
  const onBlur = () => {
    held.clear();
    drag = null;
    canvas.classList.remove('steering');
  };

  // ---- drawing, while it is shown

  const k = (code) => (held.has(code) ? 1 : 0);
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    // While the view is being steered (a drag that looks, a move key held), the pointer is out of the way.
    canvas.classList.toggle('steering', !!drag || held.size > 0);
    if (free && followFlight(now)) {
      // Following somebody's flight: put where they were (above).
    } else if (free) {
      const ease = 1 - Math.exp(-dt / LOOK_EASE);
      viewYaw += (yaw - viewYaw) * ease;
      viewPitch += (pitch - viewPitch) * ease;
      camera.rotation.set(viewPitch, viewYaw, 0);
      // Forward is wherever the view points, up and down included; sideways stays level; Q and E are
      // straight down and up.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const want = new THREE.Vector3()
        .addScaledVector(fwd, k('KeyW') - k('KeyS'))
        .addScaledVector(right, k('KeyD') - k('KeyA'))
        .addScaledVector(UP, k('KeyE') - k('KeyQ'));
      if (want.lengthSq()) want.normalize().multiplyScalar(speed * (shift ? 3 : 1));
      vel.lerp(want, 1 - Math.exp(-dt / (want.lengthSq() ? EASE_IN : EASE_OUT)));
      if (!want.lengthSq() && vel.lengthSq() < 1e-6) vel.set(0, 0, 0);
      camera.position.addScaledVector(vel, dt);
    }
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(1, 4096 / Math.max(1, r.width * dpr, r.height * dpr));
    const w = Math.max(1, Math.round(r.width * dpr * scale));
    const h = Math.max(1, Math.round(r.height * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
    // The screens take the video's frame only once it has one to give: not while it seeks, nor while it
    // changes to another source (the player swaps a video for the whole of it, see switchSource), when it
    // has none. Till then they keep the last, so a scrub, a pause or a swap never blinks. (three.js takes
    // each frame the video shows as well, where the browser says so.)
    if (texture && source && source.tagName === 'VIDEO' && source.readyState >= 2 && !source.seeking
      && (!source.paused || source.currentTime !== shownAt)) {
      texture.needsUpdate = true;
      shownAt = source.currentTime;
    }
    // A canvas is taken again only when something new was drawn on it.
    if (texture && source && source.tagName === 'CANVAS' && source.fresh) {
      texture.needsUpdate = true;
      source.fresh = false;
    }
    // What is drawn, and through what: `rect` is the part of the canvas drawn into, `tan` how tall it sees.
    const fr = frameRect(r);
    const p = glide ? Math.min(1, (now - glide.t0) / glide.ms) : 1;
    let rect;
    let tan;
    if (free) {
      view.position.copy(camera.position);
      view.quaternion.copy(camera.quaternion);
      // A window that changes shape never takes the lens past 122.5° across.
      camera.fov = capped(camera.fov, r.width / r.height);
      const q = glide ? easeOut(p) : 1;
      rect = glide ? mix(glide.from, FULL, q) : FULL;
      tan = (glide ? glide.tan + (tanHalf(camera.fov) - glide.tan) * q : tanHalf(camera.fov)) * rect.h;
    } else {
      const target = fr || FULL;
      settleLens(fr);
      const fixedTan = tanHalf(fixed.fov) / target.h; // the frame's lens, over the whole canvas
      if (glide) {
        const q = easeInOut(p);
        rect = mix(glide.from, target, q);
        view.position.lerpVectors(glide.pos, fixed.position, q);
        view.quaternion.slerpQuaternions(glide.quat, fixed.quaternion, q);
        tan = (glide.tan + (fixedTan - glide.tan) * q) * rect.h;
      } else {
        rect = target;
        view.position.copy(fixed.position);
        view.quaternion.copy(fixed.quaternion);
        tan = fixedTan * rect.h;
      }
    }
    if (glide && p >= 1) {
      const back = glide.to === 'fixed';
      glide = null;
      // There: its drawings show.
      if (back) onFree(false);
    }
    shown = rect;
    view.fov = fovOf(tan);
    view.aspect = (rect.w * r.width) / (rect.h * r.height);
    view.updateProjectionMatrix();
    glowNow();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    if (rect.x <= 0.0005 && rect.y <= 0.0005 && rect.w >= 0.999 && rect.h >= 0.999) {
      renderer.render(scene, view);
      shade(w, h);
      return;
    }
    // Letterboxed: the part drawn into, where the frame is (WebGL counts up from the bottom), and the rest
    // dark. (Drawing the room sets the clear colour to its ground, so the letterbox's is set again each time.)
    renderer.setClearColor(LETTERBOX, 1);
    renderer.clear();
    const box = [rect.x * w, h - (rect.y + rect.h) * h, rect.w * w, rect.h * h].map(Math.round);
    renderer.setViewport(...box);
    renderer.setScissor(...box);
    renderer.setScissorTest(true);
    renderer.render(scene, view);
    shade(Math.max(1, box[2]), Math.max(1, box[3]));
    renderer.setScissorTest(false);
  }
  // Made ready ahead of being shown: what draws the room and the screens compiled now, with a stand-in for
  // the picture, so the first frame shown does not wait on it.
  async function warm() {
    if (running || !room) return;
    const had = texture;
    if (!texture) {
      texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.needsUpdate = true;
      applyScreens();
    }
    try {
      // In the background where the graphics card can; otherwise at once (still before it is shown).
      if (renderer.compileAsync && renderer.extensions.has('KHR_parallel_shader_compile')) await renderer.compileAsync(scene, view);
      else renderer.compile(scene, view);
    } finally {
      if (!had && !running) {
        texture.dispose();
        texture = null;
        applyScreens();
      }
    }
  }
  function start() {
    if (running) return;
    running = true;
    last = 0;
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    onBlur();
  }

  return {
    canvas, load, setSource, start, stop, warm, key, hold, goTo, at, pose, flight, steer, where, place, setLook,
    // The shape of the frame held (or last held, flying), which the player lays its frame out at.
    aspect: () => fixed.aspect,
    // The model's cameras, by name, and which of them is held (its number), or -1.
    cameras: () => cams.map((c) => c.name),
    camera: () => (free || !fixed.cam ? -1 : cams.indexOf(fixed)),
    mainCamera: () => cams.indexOf(main),
    // Away from a frame, or on the way to one: no drawing is where it belongs.
    isFree: () => free || !!glide,
  };
}
