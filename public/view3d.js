// The player's 3D view (viewer.js): a project's model of its venue, with the piece open in the player
// shown on its projection surface. The picture is the player's own <video> or <img>, so playing, stepping,
// the timeline and comments go on as they do in 2D; this only draws it another way. Loaded the first time
// a project with a model is looked at in 3D (three.js comes from the installed package, see server.js).
//
// What it is given is the project's setting (see cleanProjectSettings in server.js): the model, and the
// name of the material its projection surface has; every mesh with that material (or one named like it,
// "screen-left") shows the picture through its own UVs, unlit. The rest of the room is lit from all round,
// so no side of anything is ever black.
//
// It opens through the model's main camera (the camera named "main", or else its first): its place, lens
// and frame's shape, letterboxed where the player's piece box is
// (`frameOf()`), on bars darker than the room's ground, so it is the same picture on every screen and what is drawn on it lands on the same thing
// for everyone. Any move of the view leaves it (a drag, the wheel, a move key), unless the player has a pen,
// eraser or laser in hand (`holds(e)`): then the view fills the whole picture area, to fly about as in
// Unreal Engine's viewport: W and S along the view, A and D sideways, Q and E down and up, a drag to look,
// the wheel to glide (with a button held, to set the speed), every move easing in and out. Nothing is
// drawn while flying.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const models = new Map(); // url -> Promise of the loaded glTF, shared by every view on the page
const loadModel = (url) => {
  if (!models.has(url)) {
    const p = new GLTFLoader().loadAsync(url);
    p.catch(() => models.delete(url));
    models.set(url, p);
  }
  return models.get(url);
};

const EASE_IN = 0.14; // seconds to get most of the way to the speed asked
const EASE_OUT = 0.2; // and to come to rest
const LOOK_EASE = 0.035;
const UP = new THREE.Vector3(0, 1, 0);
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);

// `onFree(on)` hears when the view leaves the main camera to fly, or comes back to it; `frameOf()` says
// where on the page the main camera's frame is (a DOMRect); `holds(e)` says a press is the player's own
// (drawing, erasing, pointing), not a move of the view.
export function create({ onFree = () => {}, frameOf = () => null, holds = () => false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'v-3d';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  // The letterbox around the main camera's frame: darker than the room's own ground, so the frame reads.
  const LETTERBOX = new THREE.Color(0x09090a);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // The room is tone mapped softly; the screens are not, so the picture is as filed.
  renderer.toneMapping = THREE.NeutralToneMapping;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1b1c1e);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.3;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x707070, 0.55));
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  // `camera` is the one flown; `view` is what is drawn through: the main camera, the flown one, or a glide
  // between them.
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 5000);
  camera.rotation.order = 'YXZ';
  const view = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 5000);
  let room = null; // the model in the scene
  let modelUrl = '';
  let screenName = 'screen';
  let main = { position: new THREE.Vector3(0, 1.6, 6), quaternion: new THREE.Quaternion(), fov: 50, aspect: 16 / 9 };
  let texture = null;
  let source = null;
  let free = false;
  let running = false;
  let raf = 0;

  // ---- the model

  async function load({ model, screen = 'screen' }) {
    screenName = (screen || 'screen').toLowerCase();
    if (model === modelUrl && room) return applyScreens();
    const gltf = await loadModel(model);
    if (room) scene.remove(room);
    room = gltf.scene.clone(true);
    modelUrl = model;
    scene.add(room);
    room.updateMatrixWorld(true);
    // The main camera, with the shape glTF says its frame has (aspectRatio; 16:9 if it says none).
    const json = gltf.parser.json;
    const shapeOf = new Map((json.nodes || []).filter((n) => n.camera != null).map((n) => [n.name, json.cameras[n.camera]?.perspective?.aspectRatio]));
    const cams = [];
    room.traverse((o) => {
      if (!o.isCamera) return;
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      o.getWorldPosition(position);
      o.getWorldQuaternion(quaternion);
      const name = o.name || o.parent?.name || '';
      cams.push({ name, position, quaternion, fov: o.fov, aspect: shapeOf.get(o.name) || shapeOf.get(o.parent?.name) || 16 / 9 });
    });
    const box = new THREE.Box3().setFromObject(room);
    const size = box.getSize(new THREE.Vector3());
    // No camera in the model: a look at all of it from the front stands in for one.
    if (!cams.length) {
      const centre = box.getCenter(new THREE.Vector3());
      const look = new THREE.PerspectiveCamera();
      look.position.set(centre.x, centre.y + size.y * 0.1, box.max.z + Math.max(size.x, size.y) * 0.6);
      look.lookAt(centre);
      cams.push({ name: '', position: look.position.clone(), quaternion: look.quaternion.clone(), fov: 50, aspect: 16 / 9 });
    }
    main = cams.find((c) => c.name.toLowerCase() === 'main') || cams[0];
    speed = Math.max(1, size.length() / 12);
    applyScreens();
    settle();
  }

  // Every mesh with the screen's material shows the picture; a material the model does not give is fully
  // metal in glTF, which shows only reflections and comes out nearly black, so none is more than half metal.
  function applyScreens() {
    if (!room) return;
    room.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m, i) => {
        const was = m.userData.was || m;
        const name = (was.name || '').toLowerCase();
        const isScreen = name === screenName || [`${screenName}-`, `${screenName}_`, `${screenName}.`].some((p) => name.startsWith(p));
        if (!isScreen) {
          mats[i] = was;
          if ('metalness' in was && was.metalness > 0.5 && !was.metalnessMap) was.metalness = 0.5;
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

  // ---- the picture: the player's own <video> or <img>

  let shownAt = -1; // the moment of the video the screens last took a frame of
  function setSource(el) {
    if (el === source) return;
    source = el;
    shownAt = -1;
    if (texture) texture.dispose();
    texture = null;
    if (el && el.tagName === 'VIDEO') texture = new THREE.VideoTexture(el);
    else if (el && el.tagName === 'IMG') {
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

  // ---- looking through the main camera, or flying

  let yaw = 0;
  let pitch = 0;
  let viewYaw = 0;
  let viewPitch = 0;
  let speed = 3;
  const vel = new THREE.Vector3();
  const held = new Set();
  let shift = false;
  let drag = null;

  // Between the main camera and flying the view glides: leaving, the letterbox opens out to the whole area
  // with the room kept at its size; coming back, the camera moves and turns back to the main one as the
  // letterbox closes in on its frame. Drawings show once it is there. Without motion, if the system asks.
  const OUT_MS = 260;
  const IN_MS = 480;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const FULL = { x: 0, y: 0, w: 1, h: 1 };
  let shown = FULL; // the part of the canvas last drawn into, in fractions of it
  let glide = null; // { to: 'free' | 'main', t0, ms, from: rect, pos, quat, tan }
  const easeOut = (t) => 1 - (1 - t) ** 3;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const tanHalf = (deg) => Math.tan(THREE.MathUtils.degToRad(deg) / 2);
  const fovOf = (tan) => THREE.MathUtils.radToDeg(2 * Math.atan(tan));
  // Flying, the lens is never wider than 115° across, whatever the shape of the window: as
  // a lens's height in degrees, for an area of that shape.
  const MAX_ACROSS = 115;
  const capped = (fov, aspect) => THREE.MathUtils.clamp(fov, 20, fovOf(tanHalf(MAX_ACROSS) / aspect));
  const mix = (a, b, p) => ({ x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, w: a.w + (b.w - a.w) * p, h: a.h + (b.h - a.h) * p });
  // Where the main camera's frame is on the canvas, in fractions of it.
  function frameRect(r) {
    const f = frameOf();
    if (!f || !f.width || !f.height || !r.width || !r.height) return null;
    return { x: (f.left - r.left) / r.width, y: (f.top - r.top) / r.height, w: f.width / r.width, h: f.height / r.height };
  }

  // On the main camera at once, as when a model is put up.
  function settle() {
    free = false;
    glide = null;
    shown = FULL;
    vel.set(0, 0, 0);
    held.clear();
    view.position.copy(main.position);
    view.quaternion.copy(main.quaternion);
    view.fov = main.fov;
    canvas.classList.remove('free');
  }
  function setFree(on, { tell = true, animate = true } = {}) {
    if (on === free) return;
    free = on;
    const ms = animate && !calm.matches ? (on ? OUT_MS : IN_MS) : 0;
    if (free) {
      // Flying starts from wherever the view is (on the main camera, or on its way back to it), looking
      // where it looks, with the room at the size it was: the lens over the whole area is the one the view
      // had over the part of it shown.
      camera.position.copy(view.position);
      camera.quaternion.copy(view.quaternion);
      const e = new THREE.Euler().setFromQuaternion(view.quaternion, 'YXZ');
      yaw = viewYaw = e.y;
      pitch = viewPitch = e.x;
      // (Kept to 115° across: past that the glide out eases the room in to it rather than jumping.)
      const r = canvas.getBoundingClientRect();
      const keep = tanHalf(view.fov) / shown.h;
      camera.fov = capped(fovOf(keep), r.width && r.height ? r.width / r.height : 16 / 9);
      glide = ms ? { to: 'free', t0: performance.now(), ms, from: { ...shown }, tan: keep } : null;
    } else {
      vel.set(0, 0, 0);
      held.clear();
      glide = ms ? { to: 'main', t0: performance.now(), ms, from: { ...shown }, pos: view.position.clone(), quat: view.quaternion.clone(), tan: tanHalf(view.fov) / shown.h } : null;
    }
    canvas.classList.toggle('free', free);
    if (tell) onFree(free);
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // A press moves the view (and so leaves the main camera), unless it is the player's: a pen, eraser or
  // laser at work through the main camera.
  canvas.addEventListener('pointerdown', (e) => {
    if (!free && holds(e)) return;
    e.stopPropagation();
    e.preventDefault();
    if (!free) setFree(true);
    drag = { x: e.clientX, y: e.clientY, pid: e.pointerId };
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    e.stopPropagation();
    yaw -= (e.clientX - drag.x) * 0.0032;
    pitch = THREE.MathUtils.clamp(pitch - (e.clientY - drag.y) * 0.0032, -1.55, 1.55);
    drag.x = e.clientX;
    drag.y = e.clientY;
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
    if (!free) setFree(true);
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
      if (!free) setFree(true);
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
    if (free) {
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
    // What is drawn, and through what: `rect` is the part of the canvas drawn into, `tan` how tall it sees.
    const fr = frameRect(r);
    const p = glide ? Math.min(1, (now - glide.t0) / glide.ms) : 1;
    let rect;
    let tan;
    if (free) {
      view.position.copy(camera.position);
      view.quaternion.copy(camera.quaternion);
      // A window that changes shape never takes the lens past 115° across.
      camera.fov = capped(camera.fov, r.width / r.height);
      const q = glide ? easeOut(p) : 1;
      rect = glide ? mix(glide.from, FULL, q) : FULL;
      tan = (glide ? glide.tan + (tanHalf(camera.fov) - glide.tan) * q : tanHalf(camera.fov)) * rect.h;
    } else {
      const target = fr || FULL;
      const mainTan = tanHalf(main.fov) / target.h; // the main camera's lens, over the whole canvas
      if (glide) {
        const q = easeInOut(p);
        rect = mix(glide.from, target, q);
        view.position.lerpVectors(glide.pos, main.position, q);
        view.quaternion.slerpQuaternions(glide.quat, main.quaternion, q);
        tan = (glide.tan + (mainTan - glide.tan) * q) * rect.h;
      } else {
        rect = target;
        view.position.copy(main.position);
        view.quaternion.copy(main.quaternion);
        tan = mainTan * rect.h;
      }
    }
    if (glide && p >= 1) {
      const back = glide.to === 'main';
      glide = null;
      // There: its drawings show.
      if (back) onFree(false);
    }
    shown = rect;
    view.fov = fovOf(tan);
    view.aspect = (rect.w * r.width) / (rect.h * r.height);
    view.updateProjectionMatrix();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    if (rect.x <= 0.0005 && rect.y <= 0.0005 && rect.w >= 0.999 && rect.h >= 0.999) {
      renderer.render(scene, view);
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
    renderer.setScissorTest(false);
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
    canvas, load, setSource, start, stop, key,
    aspect: () => main.aspect,
    // Away from the main camera, or still on the way back to it: its drawings are not where they belong.
    isFree: () => free || !!glide,
    // From the player: at once (opening 3D), or gliding (back to the main camera).
    setFree: (on, animate = false) => setFree(on, { tell: false, animate }),
  };
}
