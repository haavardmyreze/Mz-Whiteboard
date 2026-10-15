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
// Moving freely is flown as in Unreal Engine's viewport: W and S go along the view, wherever it points
// (looking down, W goes down), A and D sideways, Q and E straight down and up; a drag with either button
// looks about; speeds ease in and out rather than starting and stopping dead. The wheel glides along the
// view, or, with a button held, changes the speed.
//
// Try it: /lab/preview3d.html. The picture is a version filed in a project ("Filed version", or "Preview
// in 3D" in a version's menu in the app, or ?version=…), or a file dropped on the page. The model is
// dropped on the page too, and kept in this browser for next time.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// The room is tone mapped softly; the screens are not (toneMapped: false), so the picture is as filed.
renderer.toneMapping = THREE.NeutralToneMapping;

// The room is lit so that no side of anything is ever black: light from all round (a soft studio
// environment, which metal reflects too), from above and below (the hemisphere), an even floor of light
// everywhere (ambient), and one sun for shape.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1c1e);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.3;
scene.add(new THREE.HemisphereLight(0xffffff, 0x707070, 0.55));
scene.add(new THREE.AmbientLight(0xffffff, 0.22));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
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
        softened(mats[i]);
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

// A material the model does not give is fully metal in glTF, and full metal shows only reflections, so it
// comes out nearly black: nothing here is more than half metal, so light falls on all of it.
function softened(m) {
  if (m.userData.softened) return;
  m.userData.softened = true;
  if ('metalness' in m && m.metalness > 0.5 && !m.metalnessMap) m.metalness = 0.5;
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
    modelName && line('Model', modelName),
    shown && line('Showing', shown),
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

let modelName = '';
async function loadModel(url, name = '') {
  $('status').textContent = 'Loading the model…';
  modelName = name;
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
  lookAt(e.y, e.x);
  vel.set(0, 0, 0);
  camera.fov = v.fov || 60;
  camera.updateProjectionMatrix();
}

// ---- moving about, as in Unreal Engine's viewport

// Where the view points: `yaw` and `pitch` are where the hand has turned it, and the view follows a
// touch behind, so a jerky mouse still turns it smoothly.
let yaw = 0;
let pitch = 0;
let viewYaw = 0;
let viewPitch = 0;
const lookAt = (y, p) => { yaw = viewYaw = y; pitch = viewPitch = p; };
let speed = 3; // metres a second, at full speed
const vel = new THREE.Vector3(); // how fast it is going now, which eases towards what the keys ask
const EASE_IN = 0.14; // seconds to get most of the way to the speed asked
const EASE_OUT = 0.2; // and to come to rest
const LOOK_EASE = 0.035;
const UP = new THREE.Vector3(0, 1, 0);
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE']);
const held = new Set();
let drag = null;
// Leaving the main camera to move: from where it stands and looks.
const leaveMain = () => { if (throughMain && !drawing) setMain(false); };
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  if (throughMain && e.button !== 2) return;
  leaveMain();
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  yaw -= (e.clientX - drag.x) * 0.0032;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - drag.y) * 0.0032, -1.55, 1.55);
  drag = { x: e.clientX, y: e.clientY };
});
const letGo = () => { drag = null; };
canvas.addEventListener('pointerup', letGo);
canvas.addEventListener('pointercancel', letGo);
const showSpeed = () => { $('status').textContent = `Speed ${speed < 10 ? speed.toFixed(1) : Math.round(speed)} m/s`; };
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (throughMain && !drag) return;
  if (drag) {
    // With a button held, as in Unreal: the wheel sets the speed.
    speed = THREE.MathUtils.clamp(speed * (e.deltaY > 0 ? 0.85 : 1.18), 0.1, 500);
    return void showSpeed();
  }
  // Otherwise a glide along the view, that eases out like any other move.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  vel.addScaledVector(fwd, (e.deltaY > 0 ? -1 : 1) * speed * 1.2);
}, { passive: false });
const typing = (t) => t && ((t.tagName === 'INPUT' && /^(text|search)$/.test(t.type)) || t.tagName === 'SELECT');
window.addEventListener('keydown', (e) => {
  if (typing(e.target) || e.ctrlKey || e.metaKey) return;
  if (e.code === 'Space') {
    e.preventDefault();
    togglePlay();
    return;
  }
  if (e.code === 'KeyV') return void setMain(!throughMain);
  if (e.code === 'KeyP') return void setPen(!drawing);
  if (e.code === 'Escape') {
    if (!$('verPanel').hidden) return void showPanel(false);
    if (drawing) return void setPen(false);
  }
  if (e.code === 'Comma' || e.code === 'Period') {
    video.pause();
    video.currentTime = Math.max(0, video.currentTime + (e.code === 'Comma' ? -1 : 1) / 24);
    return;
  }
  if (MOVE_KEYS.has(e.code)) {
    if (drawing) return;
    leaveMain();
  }
  held.add(e.code);
});
window.addEventListener('keyup', (e) => held.delete(e.code));
window.addEventListener('blur', () => { held.clear(); drag = null; });

let last = performance.now();
const key = (code) => (held.has(code) ? 1 : 0);
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (throughMain) vel.set(0, 0, 0);
  else {
    const k = 1 - Math.exp(-dt / LOOK_EASE);
    viewYaw += (yaw - viewYaw) * k;
    viewPitch += (pitch - viewPitch) * k;
    camera.rotation.set(viewPitch, viewYaw, 0);
    // Forward is wherever the view points, up and down included; sideways stays level; Q and E are
    // straight down and up.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const want = new THREE.Vector3()
      .addScaledVector(fwd, key('KeyW') - key('KeyS'))
      .addScaledVector(right, key('KeyD') - key('KeyA'))
      .addScaledVector(UP, key('KeyE') - key('KeyQ'));
    const fast = held.has('ShiftLeft') || held.has('ShiftRight') ? 3 : 1;
    if (want.lengthSq()) want.normalize().multiplyScalar(speed * fast);
    const ease = want.lengthSq() ? EASE_IN : EASE_OUT;
    vel.lerp(want, 1 - Math.exp(-dt / ease));
    if (!want.lengthSq() && vel.lengthSq() < 1e-6) vel.set(0, 0, 0);
    camera.position.addScaledVector(vel, dt);
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
    // Moving freely starts from where the main camera stands, looking where it looks.
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    lookAt(e.y, e.x);
    camera.fov = 60;
    if (drawing) setPen(false);
  }
  held.clear();
  vel.set(0, 0, 0);
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

// ---- a version filed in a project: its main picture (the unwrapped one), or another of its views

const api = async (url) => {
  const res = await fetch(url, { headers: { 'x-wb': '1' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status}`);
  return body;
};
let shown = '';
let versions = []; // the project's, newest first
let projectId = '';
function showPanel(on) {
  $('verPanel').hidden = !on;
  $('pickVersion').setAttribute('aria-expanded', String(on));
  if (on) {
    loadProjects().catch((err) => { $('verList').textContent = err.message; });
    $('verSearch').focus();
  }
}
async function loadProjects() {
  if ($('verProject').options.length) return;
  const lib = await api('/api/library');
  const projects = lib.folders.filter((f) => f.project).sort((a, b) => a.name.localeCompare(b.name));
  $('verProject').replaceChildren(...projects.map((f) => Object.assign(document.createElement('option'), { value: f.id, textContent: f.name })));
  const want = projectId || localStorage.getItem('wb:lab3d:project');
  if (projects.some((f) => f.id === want)) $('verProject').value = want;
  if (!projects.length) return void ($('verList').textContent = 'No projects here yet.');
  await loadVersions($('verProject').value);
}
async function loadVersions(id) {
  projectId = id;
  localStorage.setItem('wb:lab3d:project', id);
  $('verList').textContent = 'Loading…';
  versions = [];
  // A few pages is plenty to find one by.
  let next = null;
  for (let i = 0; i < 6; i++) {
    const page = await api(`/api/projects/${id}/versions${next ? `?before=${encodeURIComponent(next)}` : ''}`);
    versions.push(...page.versions);
    next = page.next;
    if (!next) break;
  }
  paintVersions();
}
function paintVersions() {
  const q = $('verSearch').value.trim().toLowerCase();
  const list = versions.filter((v) => !q || v.label.toLowerCase().includes(q) || (v.createdBy || '').toLowerCase().includes(q)).slice(0, 80);
  $('verList').replaceChildren(...(list.length ? list.map((v) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'p3-ver';
    row.innerHTML = '<img alt=""><span><b></b><i></i></span>';
    if (v.thumb) row.querySelector('img').src = v.thumb;
    row.querySelector('b').textContent = v.label;
    row.querySelector('i').textContent = [v.kind === 'video' ? 'Video' : 'Still', v.createdBy].filter(Boolean).join(' · ');
    // The list carries a short look; the version itself has all of it, its views too.
    row.addEventListener('click', async () => {
      showPanel(false);
      try {
        useVersion(await api(`/api/versions/${encodeURIComponent(v.id)}`));
      } catch (err) {
        failed('version')(err);
      }
    });
    return row;
  }) : [Object.assign(document.createElement('p'), { textContent: q ? 'Nothing matches.' : 'Nothing filed in this project yet.' })]));
}
// The version's views: its main one first. The main one is shown to start with: on projection work, the
// unwrapped picture that goes on the model.
let current = null;
function useVersion(v, view = '') {
  current = v;
  const views = [{ name: v.look.view || 'main', look: v.look }, ...(v.look.views || []).map((x) => ({ name: x.view, look: x }))];
  const pick = views.find((x) => x.name === view) || views[0];
  $('verView').hidden = views.length < 2;
  $('verView').replaceChildren(...views.map((x) => Object.assign(document.createElement('option'), { value: x.name, textContent: `View: ${x.name}`, selected: x === pick })));
  setMedia(pick.look.src, pick.look.type === 'image');
  shown = `${v.label}${views.length > 1 ? ` · ${pick.name}` : ''}`;
  $('status').textContent = '';
  const q = new URLSearchParams(location.search);
  q.set('version', v.id);
  q.delete('video');
  if (views.length > 1 && pick !== views[0]) q.set('view', pick.name);
  else q.delete('view');
  history.replaceState(null, '', `${location.pathname}?${q}`);
  if (model) report();
}
$('pickVersion').addEventListener('click', () => showPanel($('verPanel').hidden));
$('verProject').addEventListener('change', () => loadVersions($('verProject').value).catch((err) => { $('verList').textContent = err.message; }));
$('verSearch').addEventListener('input', paintVersions);
$('verSearch').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('verList').querySelector('.p3-ver');
  if (first) first.click();
});
$('verView').addEventListener('change', () => { if (current) useVersion(current, $('verView').value); $('verView').blur(); });
document.addEventListener('pointerdown', (e) => {
  if (!$('verPanel').hidden && !e.target.closest('#verPanel, #pickVersion')) showPanel(false);
});

// ---- the model, kept in this browser so the page opens on it next time

const db = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('wb-lab-3d', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kept');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function keep(key, value) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction('kept', 'readwrite');
    t.objectStore('kept').put(value, key);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
async function kept(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction('kept').objectStore('kept').get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

// ---- bringing things in: picked, dropped, or named in the address

const failed = (what) => (err) => { $('status').textContent = `Could not read the ${what}: ${err.message}`; };
const use = (file) => {
  const url = URL.createObjectURL(file);
  if (/\.(glb|gltf)$/i.test(file.name)) {
    loadModel(url, file.name).catch(failed('model'));
    keep('model', { name: file.name, blob: file }).catch(() => {});
  } else {
    current = null;
    shown = file.name;
    $('verView').hidden = true;
    setMedia(url, file.type.startsWith('image/'));
  }
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
if (q.get('version')) {
  api(`/api/versions/${encodeURIComponent(q.get('version'))}`).then((v) => {
    projectId = v.projectId;
    useVersion(v, q.get('view') || '');
  }).catch(failed('version'));
} else if (q.get('video')) setMedia(q.get('video'), /\.(png|jpe?g|webp|avif)$/i.test(q.get('video')));
if (q.get('model')) loadModel(q.get('model')).catch(failed('model'));
else {
  kept('model').then((m) => {
    if (m && m.blob && !model) loadModel(URL.createObjectURL(m.blob), `${m.name} (kept from last time)`).catch(failed('model'));
  }).catch(() => {});
}
requestAnimationFrame(frame);
window.__p3 = { scene, camera, video, screens, strokes, vel, goTo: (i) => goTo(i), main: () => mainCam };
