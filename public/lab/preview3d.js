// A spike, not part of the app yet: how a version's unwrapped picture would look on the venue it is made
// for. A model (glTF/GLB) of the venue is loaded; every mesh whose material is named like the screen
// ("screen", or "screen-left" and so on) shows the video on its own UV channel, unlit, as projected
// light; the rest of the model is lit plainly so it reads as the room. The video is an ordinary <video>
// element, the same kind the player uses, so in the app the 3D view would be one more way of drawing the
// player's own video: time, stepping, scrubbing and comments stay as they are.
//
// The model has one main camera: the camera named "main", or else its first. Looking through it (V) the
// view is that camera's, exactly: its place, its lens, and its frame's shape, letterboxed in the window,
// so it is the same picture on every screen. Drawing (P) is only ever done through it, and what is drawn
// is kept in that frame's coordinates, on the video frame it was drawn on, so it lands on the same thing
// for everyone, every time. Moving freely is for looking about; nothing is drawn there.
//
// Try it: /lab/preview3d.html, then drop a .glb and a video (or pass ?model=…&video=… with addresses
// on this server). W A S D move, Q and E go down and up, a drag looks around, Shift is faster.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b0b);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(4, 10, 6);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 2000);
camera.rotation.order = 'YXZ';
let model = null;
let viewpoints = []; // { name, position, quaternion, fov }: where to stand, moving freely
let mainCam = null; // { name, position, quaternion, fov, aspect }: the one view drawn through
let throughMain = false;

// ---- the picture: a video (or a still) as a texture on the screens

const video = Object.assign(document.createElement('video'), { loop: true, muted: true, playsInline: true, crossOrigin: 'anonymous' });
let texture = null;
function setMedia(url, isImage) {
  if (texture) texture.dispose();
  if (isImage) {
    texture = new THREE.TextureLoader().load(url);
    video.removeAttribute('src');
  } else {
    video.src = url;
    video.play().catch(() => {});
    texture = new THREE.VideoTexture(video);
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  // glTF's UVs start at the top left of a picture; three's textures at the bottom left unless told.
  texture.flipY = false;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  applyScreens();
}

// ---- the venue

const screens = []; // { mesh, name, uv }
function applyScreens() {
  if (!model) return;
  const want = $('screenName').value.trim().toLowerCase() || 'screen';
  screens.length = 0;
  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m, i) => {
      const name = (m.userData.originalName || m.name || '').toLowerCase();
      if (!m.userData.originalName) m.userData.originalName = m.name;
      const isScreen = name === want || name.startsWith(`${want}-`) || name.startsWith(`${want}_`) || name.startsWith(`${want}.`);
      if (!isScreen) {
        if (m.userData.was) mats[i] = m.userData.was;
        return;
      }
      const was = m.userData.was || m;
      const lit = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, side: THREE.DoubleSide, color: texture ? 0xffffff : 0x333333 });
      lit.name = was.name;
      lit.userData = { originalName: was.userData.originalName || was.name, was };
      mats[i] = lit;
      screens.push({ mesh: o, name: was.name, uv: !!o.geometry.attributes.uv, uv1: !!o.geometry.attributes.uv1 });
    });
    o.material = Array.isArray(o.material) ? mats : mats[0];
  });
  report();
}

function report() {
  const box = $('report');
  const all = new Set();
  model.traverse((o) => {
    if (o.isMesh) for (const m of [].concat(o.material)) all.add(m.userData.originalName || m.name || '(unnamed)');
  });
  const noUv = screens.filter((s) => !s.uv);
  box.hidden = false;
  box.replaceChildren(...[
    line('Materials', [...all].join(', ') || 'none'),
    line('Screens', screens.length ? `${screens.length} mesh${screens.length === 1 ? '' : 'es'}: ${[...new Set(screens.map((s) => s.name))].join(', ')}` : `none named “${$('screenName').value}”`),
    noUv.length ? line('Warning', `${noUv.length} screen mesh${noUv.length === 1 ? ' has' : 'es have'} no UVs, so nothing can be shown on ${noUv.length === 1 ? 'it' : 'them'}`) : null,
    line('Main camera', mainCam ? `${mainCam.name}: ${mainCam.aspect.toFixed(3)}:1, ${mainCam.fov.toFixed(1)}° high${mainCam.guessedAspect ? ' (its shape not given in the model, so 16:9)' : ''}` : 'none: the model has no camera, so nothing can be drawn'),
    line('Viewpoints', viewpoints.map((v) => v.name).join(', ')),
  ].filter(Boolean));
}
const line = (k, v) => {
  const p = document.createElement('p');
  p.innerHTML = '<b></b> <span></span>';
  p.firstChild.textContent = k;
  p.lastChild.textContent = v;
  return p;
};

async function loadModel(url) {
  $('status').textContent = 'Loading the model…';
  const gltf = await new GLTFLoader().loadAsync(url);
  if (model) scene.remove(model);
  model = gltf.scene;
  scene.add(model);
  model.updateMatrixWorld(true);
  // Where to stand: the model's own cameras, then a look at all of it from the front.
  viewpoints = [];
  // The shape each camera's frame is said to have (glTF's aspectRatio), by the name of its node.
  const json = gltf.parser.json;
  const shapeOf = new Map((json.nodes || []).filter((n) => n.camera != null).map((n) => [n.name, json.cameras[n.camera]?.perspective?.aspectRatio]));
  const cams = [];
  model.traverse((o) => {
    if (!o.isCamera) return;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    o.getWorldPosition(position);
    o.getWorldQuaternion(quaternion);
    const name = o.name || o.parent?.name || `Camera ${viewpoints.length + 1}`;
    const aspect = shapeOf.get(o.name) || shapeOf.get(o.parent?.name);
    cams.push({ name, position, quaternion, fov: o.fov, aspect: aspect || 16 / 9, guessedAspect: !aspect });
    viewpoints.push({ name, position, quaternion, fov: o.fov });
  });
  mainCam = cams.find((c) => c.name.toLowerCase() === 'main') || cams[0] || null;
  strokes.length = 0;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const back = new THREE.Vector3(centre.x, centre.y + size.y * 0.1, box.max.z + Math.max(size.x, size.y) * 0.6);
  // A camera, not a plain object: a camera looks down its -z, an object down its +z.
  const look = new THREE.PerspectiveCamera();
  look.position.copy(back);
  look.lookAt(centre);
  viewpoints.push({ name: 'Overview', position: back, quaternion: look.quaternion.clone(), fov: 60 });
  speed = Math.max(1, size.length() / 12);
  $('cams').replaceChildren(...viewpoints.map((v, i) => Object.assign(document.createElement('option'), { value: String(i), textContent: v.name })));
  goTo(0);
  applyScreens();
  setMain(!!mainCam);
  $('status').textContent = '';
}

function goTo(i) {
  const v = viewpoints[i];
  if (!v) return;
  if (throughMain) setMain(false);
  camera.position.copy(v.position);
  const e = new THREE.Euler().setFromQuaternion(v.quaternion, 'YXZ');
  yaw = e.y;
  pitch = e.x;
  camera.fov = v.fov || 60;
  camera.updateProjectionMatrix();
}

// ---- moving about: a drag looks, W A S D Q E move, as in a game's free camera

let yaw = 0;
let pitch = 0;
let speed = 3; // metres a second
const held = new Set();
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (throughMain) return;
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw -= (e.clientX - drag.x) * 0.0035;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - drag.y) * 0.0035, -1.5, 1.5);
  drag = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', () => { drag = null; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (throughMain) return;
  speed = THREE.MathUtils.clamp(speed * (e.deltaY > 0 ? 0.85 : 1.18), 0.1, 500);
  $('status').textContent = `Speed ${speed.toFixed(1)} m/s`;
}, { passive: false });
const typing = (t) => t && (t.tagName === 'INPUT' && t.type === 'text');
window.addEventListener('keydown', (e) => {
  if (typing(e.target)) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.code === 'KeyV') return void setMain(!throughMain);
  if (e.code === 'KeyP') return void setPen(!drawing);
  if (e.code === 'Escape' && drawing) return void setPen(false);
  if (e.code === 'Comma' || e.code === 'Period') {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + (e.code === 'Comma' ? -1 : 1) / 24);
    return;
  }
  held.add(e.code);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => held.clear());

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const fast = held.has('ShiftLeft') || held.has('ShiftRight') ? 4 : 1;
  const move = new THREE.Vector3(
    (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0),
    (held.has('KeyE') ? 1 : 0) - (held.has('KeyQ') ? 1 : 0),
    (held.has('KeyS') ? 1 : 0) - (held.has('KeyW') ? 1 : 0),
  );
  if (throughMain) move.set(0, 0, 0);
  else camera.rotation.set(pitch, yaw, 0);
  if (move.lengthSq()) {
    const up = move.y;
    move.y = 0;
    move.applyQuaternion(new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)));
    move.y = up;
    camera.position.addScaledVector(move.normalize(), speed * fast * dt);
  }
  resize();
  renderer.render(scene, camera);
  paintTime();
  paintInk();
  requestAnimationFrame(frame);
}
// Moving freely the picture is the whole window. Through the main camera it is that camera's frame, as
// large as fits between the bars, at the camera's own shape; the drawing lies exactly over it.
let frameRect = null;
function resize() {
  let r = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  if (throughMain && mainCam) {
    const top = 64;
    const room = { w: innerWidth - 24, h: innerHeight - top - 64 };
    const w = Math.min(room.w, room.h * mainCam.aspect);
    const h = w / mainCam.aspect;
    r = { left: (innerWidth - w) / 2, top: top + (room.h - h) / 2, width: w, height: h };
  }
  const key = `${r.left},${r.top},${r.width},${r.height},${throughMain}`;
  if (frameRect === key) return;
  frameRect = key;
  for (const node of [canvas, ink]) Object.assign(node.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  renderer.setSize(r.width, r.height, false);
  camera.aspect = throughMain && mainCam ? mainCam.aspect : r.width / r.height;
  camera.updateProjectionMatrix();
  inkFrame = -1;
}

// ---- the main camera, and drawing through it

function setMain(on) {
  throughMain = on && !!mainCam;
  document.body.classList.toggle('main', throughMain);
  $('mainView').setAttribute('aria-pressed', String(throughMain));
  $('mainView').disabled = !mainCam;
  $('pen').disabled = !mainCam;
  if (throughMain) {
    $('cams').selectedIndex = -1;
    camera.position.copy(mainCam.position);
    camera.quaternion.copy(mainCam.quaternion);
    camera.fov = mainCam.fov;
  } else {
    // Moving freely starts from where the main camera stands.
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    yaw = e.y;
    pitch = e.x;
    camera.fov = 60;
    if (drawing) setPen(false);
  }
  held.clear();
  frameRect = null;
  resize();
}

// What is drawn: strokes in the main camera's frame (0 to 1 across and down), each on a frame of the video.
const ink = $('ink');
const strokes = []; // { frame, points: [[x, y], ...] }
let drawing = false;
let inkFrame = -1;
let inkCount = -1;
const frameNow = () => Math.round((video.currentTime || 0) * 24);
function setPen(on) {
  if (on && !mainCam) return;
  if (on && !throughMain) setMain(true);
  drawing = on;
  document.body.classList.toggle('drawing', on);
  $('pen').setAttribute('aria-pressed', String(on));
  if (on) video.pause();
}
function paintInk() {
  ink.toggleAttribute('hidden', !throughMain); // an <svg> has no hidden property, only the attribute
  const f = frameNow();
  if (f === inkFrame && strokes.length === inkCount && !pen) return;
  inkFrame = f;
  inkCount = strokes.length;
  const svgNS = 'http://www.w3.org/2000/svg';
  ink.replaceChildren(...strokes.filter((st) => st.frame === f).map((st) => {
    const line = document.createElementNS(svgNS, 'polyline');
    line.setAttribute('points', st.points.map((p) => p.join(',')).join(' '));
    return line;
  }));
}
let pen = null;
const inkAt = (e) => {
  const r = ink.getBoundingClientRect();
  return [Math.round(((e.clientX - r.left) / r.width) * 10000) / 10000, Math.round(((e.clientY - r.top) / r.height) * 10000) / 10000];
};
ink.addEventListener('pointerdown', (e) => {
  if (!drawing) return;
  ink.setPointerCapture(e.pointerId);
  pen = { frame: frameNow(), points: [inkAt(e)] };
  strokes.push(pen);
});
ink.addEventListener('pointermove', (e) => { if (pen) pen.points.push(inkAt(e)); });
ink.addEventListener('pointerup', () => { pen = null; inkFrame = -1; });
$('mainView').addEventListener('click', () => { setMain(!throughMain); $('mainView').blur(); });
$('pen').addEventListener('click', () => { setPen(!drawing); $('pen').blur(); });
$('clearInk').addEventListener('click', () => {
  const f = frameNow();
  for (let i = strokes.length - 1; i >= 0; i--) if (strokes[i].frame === f) strokes.splice(i, 1);
  $('clearInk').blur();
});
window.addEventListener('resize', () => { frameRect = null; });

// ---- the video's own controls

function togglePlay() {
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function paintTime() {
  const d = video.duration || 0;
  $('time').textContent = `${fmt(video.currentTime || 0)} / ${fmt(d)}`;
  if (!scrubbing && d) $('scrub').value = String(Math.round((video.currentTime / d) * 1000));
  $('play').textContent = video.paused ? '▶' : '❚❚';
}
let scrubbing = false;
$('scrub').addEventListener('input', () => {
  scrubbing = true;
  if (video.duration) video.currentTime = (Number($('scrub').value) / 1000) * video.duration;
});
$('scrub').addEventListener('change', () => { scrubbing = false; $('scrub').blur(); });
$('play').addEventListener('click', () => { togglePlay(); $('play').blur(); });
$('cams').addEventListener('change', () => { goTo(Number($('cams').value)); $('cams').blur(); });
$('screenName').addEventListener('change', applyScreens);

// ---- bringing things in: picked, dropped, or named in the address

const use = (file) => {
  const url = URL.createObjectURL(file);
  if (/\.(glb|gltf)$/i.test(file.name)) loadModel(url).catch((err) => { $('status').textContent = `Could not read the model: ${err.message}`; });
  else setMedia(url, file.type.startsWith('image/'));
};
$('pickModel').addEventListener('change', (e) => e.target.files[0] && use(e.target.files[0]));
$('pickMedia').addEventListener('change', (e) => e.target.files[0] && use(e.target.files[0]));
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) use(f);
});
const q = new URLSearchParams(location.search);
if (q.get('screen')) $('screenName').value = q.get('screen');
if (q.get('video')) setMedia(q.get('video'), /\.(png|jpe?g|webp|avif)$/i.test(q.get('video')));
if (q.get('model')) loadModel(q.get('model')).catch((err) => { $('status').textContent = `Could not read the model: ${err.message}`; });
requestAnimationFrame(frame);
window.__p3 = { scene, camera, video, screens, strokes, goTo: (i) => goTo(i), main: () => mainCam };
