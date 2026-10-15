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
// The view is through the model's main camera (the camera named "main", or else its first): its place,
// lens and frame's shape, so it is the same picture on every screen, and what is drawn on it lands on the
// same thing for everyone. It can be left to fly about as in Unreal Engine's viewport: W and S along the
// view, A and D sideways, Q and E down and up, a drag to look, the wheel to glide (with a button held, to
// set the speed), every move easing in and out. Nothing is drawn while flying.
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

// `onFree(on)` hears when the view leaves the main camera to fly, or comes back to it.
export function create({ onFree = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'v-3d';
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
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

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 5000);
  camera.rotation.order = 'YXZ';
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
    toMain();
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

  function setSource(el) {
    if (el === source) return;
    source = el;
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

  function toMain() {
    camera.position.copy(main.position);
    camera.quaternion.copy(main.quaternion);
    camera.fov = main.fov;
    camera.aspect = main.aspect;
    camera.updateProjectionMatrix();
    vel.set(0, 0, 0);
    held.clear();
  }
  function setFree(on, tell = true) {
    if (on === free) return;
    free = on;
    if (free) {
      // Flying starts from where the main camera stands, looking where it looks.
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      yaw = viewYaw = e.y;
      pitch = viewPitch = e.x;
    } else toMain();
    canvas.classList.toggle('free', free);
    if (tell) onFree(free);
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  // Flying, the pointer is the view's; through the main camera a press goes on to the player (to move
  // the picture, or draw), except a right-drag, which starts flying, as in Unreal.
  canvas.addEventListener('pointerdown', (e) => {
    if (!free && e.button !== 2) return;
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
    if (!free) return;
    e.preventDefault();
    e.stopPropagation();
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
  };

  // ---- drawing, while it is shown

  const k = (code) => (held.has(code) ? 1 : 0);
  let last = 0;
  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
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
    // As sharp as it is on screen, the player's zoom included.
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(1, 4096 / Math.max(1, r.width * dpr, r.height * dpr));
    const w = Math.max(1, Math.round(r.width * dpr * scale));
    const h = Math.max(1, Math.round(r.height * dpr * scale));
    if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
    renderer.render(scene, camera);
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
    isFree: () => free,
    setFree: (on) => setFree(on, false),
  };
}
