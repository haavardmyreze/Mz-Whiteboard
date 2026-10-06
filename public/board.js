'use strict';

(async () => {
  const { el, store } = WB;
  const $ = (id) => document.getElementById(id);

  const boardId = location.pathname.split('/').filter(Boolean)[1];
  const vp = $('viewport');
  const world = $('world');
  const framesLayer = $('frames');
  const itemsLayer = $('items');
  const cursorsLayer = $('cursors');
  const selbox = $('selbox');
  const seltools = $('seltools');
  const marquee = $('marquee');

  const MIN_Z = 0.02;
  const MAX_Z = 16;
  const PREVIEW_MAX = 2048;
  const LASER_LIFE = 900;
  const INK = ['#f2f2f3', '#f2545b', '#f5b83d', '#4fbf73', '#3d9df2', '#a78bfa'];
  const NOTE_FILLS = ['#2f2f33', '#f4d35e', '#f28b82', '#81c995', '#8ab4f8', '#c58af9'];
  const FRAME_COLORS = ['#8a8a93', ...INK.slice(1)];
  const PEN_SIZES = [3, 6, 12];
  const COLORABLE = new Set(['note', 'text', 'frame', 'stroke']);
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
  const VID_EXT = /\.(mp4|m4v|webm|mov)$/i;
  const EXT_BY_TYPE = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  };

  const icon = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    select: icon('<path d="M5 3l5.5 16 2.5-6.5L19.5 10z"/>'),
    pan: icon('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
    upload: icon('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-8 9"/>'),
    note: icon('<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>'),
    text: icon('<path d="M5 7V4h14v3M12 4v16M9 20h6"/>'),
    frame: icon('<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>'),
    pen: icon('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
    arrow: icon('<path d="M5 19L19 5M9 5h10v10"/>'),
    laser: icon('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/>'),
    boards: icon('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>'),
    prev: icon('<path d="M15 5l-7 7 7 7"/>'),
    next: icon('<path d="M9 5l7 7-7 7"/>'),
    front: icon('<rect x="8" y="8" width="12" height="12" rx="1.5" fill="currentColor"/><path d="M4 14V5a1 1 0 0 1 1-1h9"/>'),
    back: icon('<rect x="4" y="4" width="12" height="12" rx="1.5"/><path d="M20 10v9a1 1 0 0 1-1 1h-9" stroke-dasharray="2 3"/>'),
    tidy: icon('<rect x="3" y="4" width="8" height="7" rx="1"/><rect x="13" y="4" width="8" height="7" rx="1"/><rect x="3" y="13" width="5" height="7" rx="1"/><rect x="10" y="13" width="11" height="7" rx="1"/>'),
    dup: icon('<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    open: icon('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    trash: icon('<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
    play: icon('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
    pause: icon('<path d="M7 4v16M17 4v16" stroke-width="3.5"/>'),
    muted: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>'),
    sound: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 8a5 5 0 0 1 0 8"/>'),
  };
  const CURSOR_SVG = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1 1l4.5 13 2.2-5.3L13 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1"/></svg>';

  // ------------------------------------------------------------- state

  const items = new Map();       // id -> item; the shared document
  const els = new Map();         // id -> DOM node
  const sel = new Set();
  const peers = new Map();       // id -> { id, name, color, p, cur }
  const fullRes = new Set();     // image ids swapped from preview to original
  const undoStack = [];
  const redoStack = [];
  const outbox = [];             // op batches sent but not yet acknowledged
  const pendingKeys = new Map(); // "id:key" -> unacknowledged local writes
  const liveSets = new Map();    // id -> patch waiting for the next network flush
  const cam = { x: 0, y: 0, z: 1 };
  const pointer = { sx: innerWidth / 2, sy: innerHeight / 2, inside: false };
  const pen = store('wb:pen') || { color: INK[1], size: PEN_SIZES[1] };

  let me = null;
  let ws = null;
  let online = false;
  let myId = null;
  let firstInit = true;
  let retry = 500;
  let tool = 'select';
  let gesture = null;
  let editing = null;
  let spaceDown = false;
  let presenter = null;
  let presenting = false;
  let presentId = null;
  let following = null;
  let liveTimer = 0;
  let camAnim = 0;
  let camTimer = 0;

  // ------------------------------------------------------------- helpers

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v) => Math.round(v * 10) / 10;
  const isTyping = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

  // crypto.randomUUID needs HTTPS; boards are usually served over plain HTTP on the LAN.
  function uid() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  function s2w(sx, sy) {
    return { x: sx / cam.z + cam.x, y: sy / cam.z + cam.y };
  }

  function w2s(x, y) {
    return { x: (x - cam.x) * cam.z, y: (y - cam.y) * cam.z };
  }

  function viewRect() {
    return { x: cam.x, y: cam.y, w: vp.clientWidth / cam.z, h: vp.clientHeight / cam.z };
  }

  function viewCenter() {
    return s2w(vp.clientWidth / 2, vp.clientHeight / 2);
  }

  function union(a, b) {
    if (!a) return { ...b };
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  function intersects(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function contains(a, b) {
    return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
  }

  // Notes and text size themselves to their content, so their box comes from layout.
  function bounds(it) {
    const node = els.get(it.id);
    if (it.type === 'text') {
      return { x: it.x, y: it.y, w: node ? node.offsetWidth : it.fs * 4, h: node ? node.offsetHeight : it.fs * 1.2 };
    }
    if (it.type === 'note') return { x: it.x, y: it.y, w: it.w, h: node ? node.offsetHeight : it.h || it.fs * 3 };
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }

  function topZ() {
    let z = 0;
    for (const it of items.values()) if ((it.z || 0) > z) z = it.z;
    return z;
  }

  function luminance(hex) {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  }

  function toast(text, { sticky = false, ms = 4000 } = {}) {
    const node = el('div', { class: 'toast', text });
    $('toasts').append(node);
    const close = () => node.remove();
    if (!sticky) setTimeout(close, ms);
    return { set: (t) => { node.textContent = t; }, close };
  }

  // ------------------------------------------------------------- camera

  function applyCam() {
    world.style.transform = `translate(${-cam.x * cam.z}px, ${-cam.y * cam.z}px) scale(${cam.z})`;
    world.style.setProperty('--z', cam.z);
    world.style.setProperty('--inv', 1 / cam.z);
    let grid = 32 * cam.z;
    while (grid < 20) grid *= 4;
    vp.style.backgroundSize = `${grid}px ${grid}px`;
    vp.style.backgroundPosition = `${-cam.x * cam.z}px ${-cam.y * cam.z}px`;
    $('zoom').textContent = `${Math.round(cam.z * 100)}%`;
    updateOverlay();
    for (const peer of peers.values()) placeCursor(peer);
    const v = viewRect();
    sendP({ v: [round(v.x), round(v.y), round(v.w), round(v.h)] });
    scheduleSettle();
  }

  let settleTimer = 0;
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      store(`wb:cam:${boardId}`, { x: cam.x, y: cam.y, z: cam.z });
      checkRes();
    }, 200);
  }

  function stopCamAnim() {
    cancelAnimationFrame(camAnim);
    clearTimeout(camTimer);
  }

  function setCam(x, y, z) {
    stopCamAnim();
    cam.x = x;
    cam.y = y;
    cam.z = clamp(z, MIN_Z, MAX_Z);
    applyCam();
  }

  function zoomAt(sx, sy, factor) {
    const p = s2w(sx, sy);
    const z = clamp(cam.z * factor, MIN_Z, MAX_Z);
    setCam(p.x - sx / z, p.y - sy / z, z);
  }

  function animateCam(to, dur, linear) {
    stopCamAnim();
    if (document.hidden) return setCam(to.x, to.y, to.z);
    // Occluded or background windows may get no animation frames at all; land on the
    // target anyway so a follower who is not looking stays in step with the presenter.
    camTimer = setTimeout(() => setCam(to.x, to.y, to.z), dur + 150);
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const z0 = cam.z;
    const c0 = { x: cam.x + vw / 2 / z0, y: cam.y + vh / 2 / z0 };
    const c1 = { x: to.x + vw / 2 / to.z, y: to.y + vh / 2 / to.z };
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = linear ? k : k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      cam.z = z0 * Math.pow(to.z / z0, e);
      cam.x = c0.x + (c1.x - c0.x) * e - vw / 2 / cam.z;
      cam.y = c0.y + (c1.y - c0.y) * e - vh / 2 / cam.z;
      applyCam();
      if (k < 1) camAnim = requestAnimationFrame(tick);
      else clearTimeout(camTimer);
    };
    camAnim = requestAnimationFrame(tick);
  }

  // Space kept clear of the floating chrome when framing something.
  function insets() {
    return presenting ? { t: 56, r: 24, b: 84, l: 24 } : { t: 92, r: 24, b: 24, l: 80 };
  }

  function fitRect(r, { inset = insets(), dur = 380, linear = false, maxZ = MAX_Z } = {}) {
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const aw = Math.max(50, vw - inset.l - inset.r);
    const ah = Math.max(50, vh - inset.t - inset.b);
    const z = clamp(Math.min(aw / Math.max(r.w, 1), ah / Math.max(r.h, 1)), MIN_Z, maxZ);
    const to = { x: r.x + r.w / 2 - (inset.l + aw / 2) / z, y: r.y + r.h / 2 - (inset.t + ah / 2) / z, z };
    if (dur) animateCam(to, dur, linear);
    else setCam(to.x, to.y, to.z);
  }

  function fitAll(dur = 380) {
    let r = null;
    for (const it of items.values()) r = union(r, bounds(it));
    if (!r) return setCam(-vp.clientWidth / 2, -vp.clientHeight / 2, 1);
    fitRect(r, { dur, maxZ: 1.5 });
  }

  // Any manual pan or zoom means the viewer wants their own view back.
  function userMovedView() {
    stopCamAnim();
    if (following) {
      following = null;
      updateFollowUI();
    }
  }

  // ------------------------------------------------------------- rendering

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

  function fillText(node, text) {
    node.replaceChildren();
    if (!text) return;
    text.split(URL_RE).forEach((part, i) => {
      if (!part) return;
      node.append(i % 2 ? el('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }) : part);
    });
  }

  function pathData(pts, sx, sy, arrow, size) {
    const n = pts.length / 2;
    const X = (i) => pts[i * 2] * sx;
    const Y = (i) => pts[i * 2 + 1] * sy;
    const f = (v) => v.toFixed(1);
    let d = `M${f(X(0))} ${f(Y(0))}`;
    if (n === 1) return `${d}h0.01`;
    if (n === 2) {
      d += `L${f(X(1))} ${f(Y(1))}`;
    } else {
      for (let i = 1; i < n - 1; i++) {
        d += `Q${f(X(i))} ${f(Y(i))} ${f((X(i) + X(i + 1)) / 2)} ${f((Y(i) + Y(i + 1)) / 2)}`;
      }
      d += `L${f(X(n - 1))} ${f(Y(n - 1))}`;
    }
    if (arrow) {
      const tx = X(n - 1);
      const ty = Y(n - 1);
      const ang = Math.atan2(ty - Y(0), tx - X(0));
      const len = size * 4.5;
      d += `M${f(tx - len * Math.cos(ang - 0.45))} ${f(ty - len * Math.sin(ang - 0.45))}L${f(tx)} ${f(ty)}`;
      d += `L${f(tx - len * Math.cos(ang + 0.45))} ${f(ty - len * Math.sin(ang + 0.45))}`;
    }
    return d;
  }

  function fmtTime(s) {
    if (!isFinite(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  function buildVideo(it, node) {
    const video = el('video', { playsinline: true, loop: true, preload: 'metadata' });
    video.muted = true;
    const play = el('button', { class: 'vbtn', html: ICON.play, title: 'Play / pause (K)', onclick: () => toggleVideo(it.id) });
    const seek = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Seek' });
    const time = el('span', { class: 'vtime', text: '0:00' });
    const mute = el('button', {
      class: 'vbtn', html: ICON.muted, title: 'Sound on / off',
      onclick: () => { video.muted = !video.muted; mute.innerHTML = video.muted ? ICON.muted : ICON.sound; },
    });
    const tick = () => {
      if (video.duration && !seek.matches(':active')) seek.value = Math.round((video.currentTime / video.duration) * 1000);
      time.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    };
    seek.addEventListener('input', () => {
      if (!video.duration) return;
      video.currentTime = (seek.value / 1000) * video.duration;
      sendMedia(it.id);
    });
    video.addEventListener('timeupdate', tick);
    video.addEventListener('loadedmetadata', tick);
    for (const type of ['play', 'pause']) {
      video.addEventListener(type, () => {
        play.innerHTML = video.paused ? ICON.play : ICON.pause;
        node.classList.toggle('playing', !video.paused);
      });
    }
    node.append(video, el('div', { class: 'vbar' }, play, seek, time, mute));
  }

  function createNode(it) {
    const node = el('div', { class: `item ${it.type}`, 'data-id': it.id });
    if (it.type === 'image') {
      node.append(el('img', { alt: it.name || '', draggable: 'false', decoding: 'async' }));
    } else if (it.type === 'video') {
      buildVideo(it, node);
    } else if (it.type === 'note' || it.type === 'text') {
      node.append(el('div', { class: 'txt', spellcheck: 'false' }));
    } else if (it.type === 'frame') {
      node.append(el('div', { class: 'frame-title txt', spellcheck: 'false' }),
        el('i', { class: 'edge t' }), el('i', { class: 'edge r' }), el('i', { class: 'edge b' }), el('i', { class: 'edge l' }));
    } else if (it.type === 'stroke') {
      const svg = svgEl('svg');
      svg.append(svgEl('path', { class: 'hit' }), svgEl('path', { class: 'ink' }));
      node.append(svg);
    }
    return node;
  }

  function renderItem(it) {
    let node = els.get(it.id);
    if (!node) {
      node = createNode(it);
      els.set(it.id, node);
      (it.type === 'frame' ? framesLayer : itemsLayer).append(node);
    }
    const st = node.style;
    st.transform = `translate(${it.x}px, ${it.y}px)`;
    st.zIndex = it.z || 0;
    const isEditing = editing && editing.id === it.id;

    if (it.type === 'image') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const img = node.firstChild;
      const src = it.prev && !fullRes.has(it.id) ? it.prev : it.src;
      if (img.dataset.src !== src) {
        img.dataset.src = src;
        img.src = src;
      }
    } else if (it.type === 'video') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const video = node.firstChild;
      if (video.dataset.src !== it.src) {
        video.dataset.src = it.src;
        video.src = it.src;
      }
    } else if (it.type === 'note') {
      const fill = it.color || NOTE_FILLS[0];
      st.width = `${it.w}px`;
      st.minHeight = `${it.h || 0}px`;
      st.fontSize = `${it.fs}px`;
      st.background = fill;
      st.color = luminance(fill) > 0.55 ? '#1b1b1c' : '#f2f2f3';
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'text') {
      st.fontSize = `${it.fs}px`;
      st.color = it.color || INK[0];
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'frame') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      st.setProperty('--c', it.color || FRAME_COLORS[0]);
      if (!isEditing) node.firstChild.textContent = it.title || '';
    } else if (it.type === 'stroke') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const [hit, ink] = node.firstChild.children;
      const d = pathData(it.pts, it.w, it.h, it.arrow, it.size);
      hit.setAttribute('d', d);
      hit.style.strokeWidth = `calc(${it.size}px + 14px * var(--inv))`;
      ink.setAttribute('d', d);
      ink.style.stroke = it.color || INK[0];
      ink.style.strokeWidth = `${it.size}px`;
    }
  }

  function removeItem(id) {
    if (editing && editing.id === id) editing = null;
    items.delete(id);
    sel.delete(id);
    fullRes.delete(id);
    const node = els.get(id);
    if (node) node.remove();
    els.delete(id);
  }

  // Boards show a downscaled preview until an image is zoomed past its resolution.
  function checkRes() {
    const dpr = window.devicePixelRatio || 1;
    const view = viewRect();
    for (const it of items.values()) {
      if (it.type !== 'image' || !it.prev || fullRes.has(it.id)) continue;
      if (it.w * cam.z * dpr > (it.pw || PREVIEW_MAX) * 1.1 && intersects(view, it)) {
        fullRes.add(it.id);
        renderItem(it);
      }
    }
  }

  // ------------------------------------------------------------- shared document

  function keysOf(ops) {
    const keys = [];
    for (const op of ops) {
      if (op.t === 'set') for (const k of Object.keys(op.patch)) keys.push(`${op.id}:${k}`);
    }
    return keys;
  }

  function sendOps(ops) {
    if (!ops.length) return;
    const batch = { ops, keys: keysOf(ops) };
    for (const k of batch.keys) pendingKeys.set(k, (pendingKeys.get(k) || 0) + 1);
    outbox.push(batch);
    if (online) ws.send(JSON.stringify({ t: 'op', ops }));
  }

  function onAck() {
    const batch = outbox.shift();
    if (!batch) return;
    for (const k of batch.keys) {
      const n = pendingKeys.get(k) - 1;
      if (n > 0) pendingKeys.set(k, n);
      else pendingKeys.delete(k);
    }
  }

  // The server applies ops in arrival order. A remote write that reaches us while our own
  // write to the same property is still unacknowledged was applied before ours, so it lost.
  function applyOps(ops, remote = false) {
    for (const op of ops) {
      if (op.t === 'add') {
        items.set(op.item.id, { ...op.item });
        renderItem(items.get(op.item.id));
      } else if (op.t === 'set') {
        const it = items.get(op.id);
        if (!it) continue;
        let patch = op.patch;
        if (remote) {
          const live = liveSets.get(op.id);
          patch = {};
          for (const k of Object.keys(op.patch)) {
            if (pendingKeys.has(`${op.id}:${k}`) || (live && k in live)) continue;
            patch[k] = op.patch[k];
          }
        }
        Object.assign(it, patch);
        renderItem(it);
      } else if (op.t === 'del') {
        for (const id of op.ids) removeItem(id);
      } else if (op.t === 'meta') {
        setBoardName(op.patch.name);
      }
    }
    afterChange();
  }

  function afterChange() {
    $('hint').hidden = items.size > 0;
    updateOverlay();
    scheduleSettle();
    if (presenting) updatePresentBar();
  }

  function invert(ops) {
    const inverse = [];
    for (const op of ops) {
      if (op.t === 'add') {
        inverse.unshift({ t: 'del', ids: [op.item.id] });
      } else if (op.t === 'del') {
        for (const id of op.ids) {
          const it = items.get(id);
          if (it) inverse.unshift({ t: 'add', item: { ...it } });
        }
      } else if (op.t === 'set') {
        const it = items.get(op.id);
        if (!it) continue;
        const patch = {};
        for (const k of Object.keys(op.patch)) patch[k] = it[k] ?? null;
        inverse.unshift({ t: 'set', id: op.id, patch });
      }
    }
    return inverse;
  }

  function pushUndo(inverse) {
    if (!inverse.length) return;
    undoStack.push(inverse);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }

  function exec(ops, record = true) {
    flushLive();
    const inverse = invert(ops);
    applyOps(ops);
    sendOps(ops);
    if (record) pushUndo(inverse);
  }

  function stepHistory(from, to) {
    finishEdit();
    flushLive();
    const ops = from.pop();
    if (!ops) return;
    const inverse = invert(ops);
    applyOps(ops);
    sendOps(ops);
    if (inverse.length) to.push(inverse);
    selChanged();
  }

  // Continuous edits (drags, typing) apply locally at once and reach the network in batches.
  function liveSet(id, patch) {
    const it = items.get(id);
    if (!it) return;
    Object.assign(it, patch);
    renderItem(it);
    const queued = liveSets.get(id);
    if (queued) Object.assign(queued, patch);
    else liveSets.set(id, { ...patch });
    if (!liveTimer) liveTimer = setTimeout(flushLive, 40);
  }

  function flushLive() {
    clearTimeout(liveTimer);
    liveTimer = 0;
    if (!liveSets.size) return;
    const ops = [];
    for (const [id, patch] of liveSets) ops.push({ t: 'set', id, patch });
    liveSets.clear();
    sendOps(ops);
  }

  function snapshot(ids) {
    const snap = new Map();
    for (const id of ids) {
      const it = items.get(id);
      if (it) snap.set(id, { ...it });
    }
    return snap;
  }

  // Turns everything a gesture changed since `snap` into a single undo step.
  function recordSince(snap) {
    flushLive();
    const inverse = [];
    for (const [id, before] of snap) {
      const it = items.get(id);
      if (!it) continue;
      const patch = {};
      for (const k of new Set([...Object.keys(before), ...Object.keys(it)])) {
        if (before[k] !== it[k]) patch[k] = before[k] ?? null;
      }
      if (Object.keys(patch).length) inverse.push({ t: 'set', id, patch });
    }
    pushUndo(inverse);
  }

  // ------------------------------------------------------------- selection

  function setSel(ids) {
    for (const id of sel) {
      const node = els.get(id);
      if (node) node.classList.remove('sel');
    }
    sel.clear();
    for (const id of ids) {
      if (!items.has(id)) continue;
      sel.add(id);
      els.get(id).classList.add('sel');
    }
    selChanged();
  }

  function selChanged() {
    updateOverlay();
    sendP({ s: [...sel] });
  }

  function selBounds() {
    let r = null;
    for (const id of sel) {
      const it = items.get(id);
      if (it) r = union(r, bounds(it));
    }
    return r;
  }

  function updateOverlay() {
    const r = sel.size && !editing ? selBounds() : null;
    if (!r) {
      selbox.hidden = true;
      seltools.hidden = true;
      return;
    }
    const a = w2s(r.x, r.y);
    const w = r.w * cam.z;
    const h = r.h * cam.z;
    selbox.hidden = false;
    selbox.style.transform = `translate(${a.x}px, ${a.y}px)`;
    selbox.style.width = `${w}px`;
    selbox.style.height = `${h}px`;

    const dragging = gesture && gesture.type !== 'pan';
    seltools.hidden = !!dragging || presenting;
    if (seltools.hidden) return;
    buildSelTools();
    const tw = seltools.offsetWidth;
    const th = seltools.offsetHeight;
    let ty = a.y - th - 14;
    if (ty < 64) ty = Math.min(a.y + h + 14, vp.clientHeight - th - 12);
    seltools.style.left = `${clamp(a.x + w / 2 - tw / 2, 72, Math.max(72, vp.clientWidth - tw - 12))}px`;
    seltools.style.top = `${Math.max(64, ty)}px`;
  }

  function buildSelTools() {
    const list = [...sel].map((id) => items.get(id)).filter(Boolean);
    const types = new Set(list.map((it) => it.type));
    const sig = `${[...types].sort().join()}|${Math.min(list.length, 2)}`;
    if (seltools.dataset.sig === sig) return;
    seltools.dataset.sig = sig;

    const btn = (html, title, onclick) => el('button', { class: 'iconbtn', html, title, onclick });
    const kids = [];
    if (list.some((it) => COLORABLE.has(it.type))) {
      const only = types.size === 1 ? [...types][0] : null;
      const palette = only === 'note' ? NOTE_FILLS : only === 'frame' ? FRAME_COLORS : INK;
      for (const c of palette) {
        kids.push(el('button', { class: 'swatch', style: { background: c }, title: 'Set colour', onclick: () => colorSel(c) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    kids.push(btn(ICON.front, 'Bring to front ( ] or PgUp )', () => reorder(1)), btn(ICON.back, 'Send to back ( [ or PgDn )', () => reorder(-1)));
    if (list.length > 1) kids.push(btn(ICON.tidy, 'Tidy into a grid (Ctrl+P)', packSelection));
    kids.push(btn(ICON.dup, 'Duplicate (Ctrl+D)', duplicate));
    if (list.length === 1 && (types.has('image') || types.has('video'))) {
      kids.push(btn(ICON.open, 'Open the original file in a new tab', () => window.open(list[0].src, '_blank', 'noopener')));
    }
    kids.push(btn(ICON.trash, 'Delete (Del)', deleteSel));
    seltools.replaceChildren(...kids);
  }

  // ------------------------------------------------------------- item actions

  function colorSel(color) {
    const ops = [];
    for (const id of sel) {
      if (COLORABLE.has(items.get(id).type)) ops.push({ t: 'set', id, patch: { color } });
    }
    if (ops.length) exec(ops);
  }

  function reorder(dir) {
    const list = [...sel].map((id) => items.get(id)).sort((a, b) => (a.z || 0) - (b.z || 0));
    if (!list.length) return;
    let z = 0;
    if (dir > 0) {
      z = topZ();
      exec(list.map((it) => ({ t: 'set', id: it.id, patch: { z: ++z } })));
    } else {
      for (const it of items.values()) z = Math.min(z, it.z || 0);
      z -= list.length;
      exec(list.map((it) => ({ t: 'set', id: it.id, patch: { z: z++ } })));
    }
  }

  function cloneItems(ids, offset) {
    let z = topZ();
    return ids.map((id) => items.get(id)).filter(Boolean)
      .sort((a, b) => (a.z || 0) - (b.z || 0))
      .map((it) => ({ ...it, id: uid(), x: round(it.x + offset), y: round(it.y + offset), z: ++z }));
  }

  function duplicate() {
    if (!sel.size) return;
    const clones = cloneItems([...sel], 24 / cam.z);
    exec(clones.map((item) => ({ t: 'add', item })));
    setSel(clones.map((c) => c.id));
  }

  function deleteSel() {
    if (sel.size) exec([{ t: 'del', ids: [...sel] }]);
  }

  // Rows first, then left to right: the order people read a board in.
  function readingOrder(list) {
    const boxed = list.map((it) => ({ it, b: bounds(it) })).sort((a, b) => a.b.y - b.b.y);
    const rows = [];
    for (const o of boxed) {
      const row = rows[rows.length - 1];
      if (row && o.b.y < row.y + row.h * 0.5) row.list.push(o);
      else rows.push({ y: o.b.y, h: o.b.h, list: [o] });
    }
    return rows.flatMap((row) => row.list.sort((a, b) => a.b.x - b.b.x)).map((o) => o.it);
  }

  // PureRef-style pack: media is normalised to one height and flowed into rows.
  // Frames and drawn annotations stay put; moving them would change what they mean.
  function packSelection() {
    const list = readingOrder([...sel].map((id) => items.get(id))
      .filter((it) => it && it.type !== 'frame' && it.type !== 'stroke'));
    if (list.length < 2) return;
    const isMedia = (it) => it.type === 'image' || it.type === 'video';
    const boxed = list.map((it) => ({ it, b: bounds(it) }));
    const origin = boxed.reduce((r, o) => union(r, o.b), null);
    const heights = (boxed.some((o) => isMedia(o.it)) ? boxed.filter((o) => isMedia(o.it)) : boxed)
      .map((o) => o.b.h).sort((a, b) => a - b);
    const rowH = heights[Math.floor(heights.length / 2)];
    const gap = Math.max(4, Math.round(rowH * 0.05));
    let area = 0;
    let widest = 0;
    for (const o of boxed) {
      o.s = isMedia(o.it) ? rowH / o.b.h : 1;
      o.w = o.b.w * o.s;
      o.h = o.b.h * o.s;
      area += (o.w + gap) * (o.h + gap);
      widest = Math.max(widest, o.w);
    }
    const maxRow = Math.max(widest, Math.sqrt(area * 1.7));
    const ops = [];
    let x = 0;
    let y = 0;
    let tallest = 0;
    for (const o of boxed) {
      if (x > 0 && x + o.w > maxRow) {
        x = 0;
        y += tallest + gap;
        tallest = 0;
      }
      const patch = { x: round(origin.x + x), y: round(origin.y + y) };
      if (o.s !== 1) Object.assign(patch, { w: round(o.w), h: round(o.h) });
      ops.push({ t: 'set', id: o.it.id, patch });
      x += o.w + gap;
      tallest = Math.max(tallest, o.h);
    }
    exec(ops);
  }

  function nudge(dx, dy) {
    const ops = [];
    for (const id of movingIds()) {
      const it = items.get(id);
      ops.push({ t: 'set', id, patch: { x: round(it.x + dx), y: round(it.y + dy) } });
    }
    exec(ops);
  }

  // Dragging a frame carries along whatever sits inside it.
  function movingIds() {
    const ids = new Set(sel);
    for (const id of sel) {
      const frame = items.get(id);
      if (!frame || frame.type !== 'frame') continue;
      for (const it of items.values()) {
        if (ids.has(it.id)) continue;
        const b = bounds(it);
        const inside = it.type === 'frame'
          ? contains(frame, b)
          : contains(frame, { x: b.x + b.w / 2, y: b.y + b.h / 2, w: 0, h: 0 });
        if (inside) ids.add(it.id);
      }
    }
    return ids;
  }

  // ------------------------------------------------------------- text editing

  function startEdit(id, isNew = false) {
    finishEdit();
    const it = items.get(id);
    const node = els.get(id).querySelector('.txt');
    const key = it.type === 'frame' ? 'title' : 'text';
    editing = { id, key, node, before: it[key] || '', isNew };
    node.textContent = it[key] || '';
    try {
      node.contentEditable = 'plaintext-only';
    } catch {
      node.contentEditable = 'true';
    }
    node.focus();
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    node.oninput = () => {
      liveSet(id, { [key]: node.innerText.replace(/\n$/, '') });
    };
    node.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey && it.type !== 'note')) {
        e.preventDefault();
        node.blur();
      }
    };
    node.onblur = finishEdit;
    updateOverlay();
  }

  function finishEdit() {
    if (!editing) return;
    const { id, key, node, before, isNew } = editing;
    editing = null;
    node.oninput = node.onkeydown = node.onblur = null;
    node.contentEditable = 'false';
    getSelection().removeAllRanges();
    flushLive();
    const it = items.get(id);
    if (!it) return;
    const after = it[key] || '';
    if (it.type !== 'frame' && !after.trim()) {
      // An emptied note is removed; undo restores it with the text it had.
      it[key] = before;
      exec([{ t: 'del', ids: [id] }], !isNew);
      return;
    }
    if (isNew) pushUndo([{ t: 'del', ids: [id] }]);
    else if (after !== before) pushUndo([{ t: 'set', id, patch: { [key]: before } }]);
    renderItem(it);
    updateOverlay();
  }

  function createTextItem(type, p, text = '') {
    const base = { id: uid(), type, x: round(p.x), y: round(p.y), text, z: topZ() + 1 };
    const item = type === 'note'
      ? { ...base, w: round(240 / cam.z), h: 0, fs: round(15 / cam.z), color: NOTE_FILLS[0] }
      : { ...base, fs: round(32 / cam.z), color: INK[0] };
    if (text) {
      exec([{ t: 'add', item }]);
      setSel([item.id]);
      return;
    }
    applyOps([{ t: 'add', item }]);
    sendOps([{ t: 'add', item }]);
    setSel([item.id]);
    startEdit(item.id, true);
  }

  // ------------------------------------------------------------- video

  function videoOf(id) {
    const node = els.get(id);
    return node && node.classList.contains('video') ? node.firstChild : null;
  }

  function sendMedia(id) {
    const video = videoOf(id);
    if (video) wsSend({ t: 'media', id, playing: !video.paused, time: video.currentTime });
  }

  function toggleVideo(id) {
    const video = videoOf(id);
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    sendMedia(id);
  }

  function stepVideo(id, dir) {
    const video = videoOf(id);
    if (!video) return;
    video.pause();
    video.currentTime = clamp(video.currentTime + dir / 24, 0, video.duration || 0);
    sendMedia(id);
  }

  function selectedVideo() {
    if (sel.size !== 1) return null;
    const it = items.get([...sel][0]);
    return it && it.type === 'video' ? it.id : null;
  }

  // ------------------------------------------------------------- adding media

  function fileExt(file) {
    const m = /\.[a-z0-9]+$/i.exec(file.name || '');
    const ext = m ? m[0].toLowerCase() : '';
    if (IMG_EXT.test(ext) || VID_EXT.test(ext)) return ext;
    return EXT_BY_TYPE[file.type] || '';
  }

  function upload(blob, ext, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?name=file${ext}`);
      xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // fall through to the generic error
        }
        if (xhr.status === 200) resolve(data);
        else reject(new Error(data.error || 'Upload failed'));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(blob);
    });
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This image could not be read'));
      img.src = url;
    });
  }

  function probeVideo(url) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const fail = () => reject(new Error('This browser cannot play that video. Export H.264 MP4 or WebM instead'));
      const timer = setTimeout(fail, 15000);
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!video.videoWidth) return fail();
        resolve({ w: video.videoWidth, h: video.videoHeight });
      };
      video.onerror = () => { clearTimeout(timer); fail(); };
      video.src = url;
    });
  }

  async function ingest(file, onProgress) {
    const ext = fileExt(file);
    const url = URL.createObjectURL(file);
    try {
      if (VID_EXT.test(ext)) {
        const { w, h } = await probeVideo(url);
        const up = await upload(file, ext, onProgress);
        return { type: 'video', src: up.url, nw: w, nh: h, name: file.name };
      }
      const img = await loadImage(url);
      const nw = img.naturalWidth || 512;
      const nh = img.naturalHeight || 512;
      const out = { type: 'image', nw, nh, name: file.name };
      if (Math.max(nw, nh) > PREVIEW_MAX * 1.25 && ext !== '.gif' && ext !== '.svg') {
        try {
          const k = PREVIEW_MAX / Math.max(nw, nh);
          const canvas = el('canvas', { width: Math.round(nw * k), height: Math.round(nh * k) });
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
          if (blob) {
            out.prev = (await upload(blob, '.webp')).url;
            out.pw = canvas.width;
          }
        } catch {
          // Without a preview the board just shows the original.
        }
      }
      out.src = (await upload(file, ext, onProgress)).url;
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Lays new media out in rows starting at `at`, sized to read well at the current zoom.
  function placeMedia(made, at) {
    const target = Math.min(vp.clientHeight * 0.4, 420) / cam.z;
    const gap = 16 / cam.z;
    const maxRow = (vp.clientWidth * 0.9) / cam.z;
    let z = topZ();
    let x = 0;
    let y = 0;
    let tallest = 0;
    const list = made.map((m) => {
      const h = Math.min(target, m.nh / cam.z);
      const w = h * (m.nw / m.nh);
      if (x > 0 && x + w > maxRow) {
        x = 0;
        y += tallest + gap;
        tallest = 0;
      }
      const item = { ...m, id: uid(), x: at.x + x, y: at.y + y, w: round(w), h: round(h), z: ++z };
      x += w + gap;
      tallest = Math.max(tallest, h);
      return item;
    });
    if (list.length === 1) {
      list[0].x -= list[0].w / 2;
      list[0].y -= list[0].h / 2;
    }
    for (const item of list) {
      item.x = round(item.x);
      item.y = round(item.y);
    }
    exec(list.map((item) => ({ t: 'add', item })));
    setSel(list.map((item) => item.id));
  }

  async function addFiles(fileList, at) {
    const files = [...fileList].filter(fileExt);
    if (!files.length) {
      toast('Only images and MP4, WebM or MOV video can be added.');
      return;
    }
    const status = toast('Uploading…', { sticky: true });
    const made = [];
    const errors = [];
    for (const [i, file] of files.entries()) {
      const label = files.length > 1 ? `Uploading ${i + 1} of ${files.length}` : 'Uploading';
      try {
        made.push(await ingest(file, (k) => status.set(`${label} · ${Math.round(k * 100)}%`)));
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    status.close();
    for (const message of errors.slice(0, 3)) toast(message, { ms: 9000 });
    if (made.length) placeMedia(made, at);
  }

  async function addImageUrl(url, at) {
    try {
      const img = await loadImage(url);
      placeMedia([{ type: 'image', src: url, nw: img.naturalWidth || 512, nh: img.naturalHeight || 512, name: url }], at);
    } catch {
      createTextItem('note', at, url);
    }
  }

  function pasteItems(list, at) {
    let box = null;
    for (const it of list) box = union(box, { x: it.x, y: it.y, w: it.w || 200, h: it.h || 100 });
    if (!box) return;
    const dx = at.x - (box.x + box.w / 2);
    const dy = at.y - (box.y + box.h / 2);
    let z = topZ();
    const clones = list.filter((it) => it && typeof it.type === 'string')
      .map((it) => ({ ...it, id: uid(), x: round(it.x + dx), y: round(it.y + dy), z: ++z }));
    exec(clones.map((item) => ({ t: 'add', item })));
    setSel(clones.map((c) => c.id));
  }

  function pasteText(text, at) {
    if (text.startsWith('{"wipboard"')) {
      try {
        const data = JSON.parse(text);
        if (data.wipboard === 1 && Array.isArray(data.items)) return pasteItems(data.items, at);
      } catch {
        // not ours after all; treat it as plain text
      }
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^https?:\/\/\S+$/.test(trimmed) && IMG_EXT.test(trimmed.split(/[?#]/)[0])) return addImageUrl(trimmed, at);
    createTextItem('note', at, trimmed.slice(0, 20000));
  }

  // ------------------------------------------------------------- pointer input

  function begin(g, e) {
    gesture = g;
    g.pid = e.pointerId;
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety; the gesture still works without it
    }
    updateOverlay();
  }

  function showMarquee(a, b) {
    const p = w2s(Math.min(a.x, b.x), Math.min(a.y, b.y));
    marquee.hidden = false;
    marquee.style.transform = `translate(${p.x}px, ${p.y}px)`;
    marquee.style.width = `${Math.abs(b.x - a.x) * cam.z}px`;
    marquee.style.height = `${Math.abs(b.y - a.y) * cam.z}px`;
  }

  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vbar, a')) return;
    if (editing) {
      if (editing.node.contains(e.target)) return;
      finishEdit();
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const p = s2w(e.clientX, e.clientY);
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (spaceDown || tool === 'pan' || tool === 'laser'));
    e.preventDefault();
    if (gesture) return;
    if (pan) {
      userMovedView();
      begin({ type: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y }, e);
      document.body.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'select') {
      const handle = e.target.closest('.handle');
      if (handle) return beginResize(handle.dataset.h, e);
      const node = e.target.closest('.item');
      const id = node && node.dataset.id;
      if (id && e.shiftKey) {
        const next = new Set(sel);
        if (!next.delete(id)) next.add(id);
        setSel(next);
      } else if (id) {
        const wasSelected = sel.has(id);
        if (!wasSelected) setSel([id]);
        begin({ type: 'move', p0: p, sx: e.clientX, sy: e.clientY, started: false, id, wasSelected, alt: e.altKey }, e);
      } else {
        const base = e.shiftKey ? new Set(sel) : new Set();
        if (!e.shiftKey) setSel([]);
        begin({ type: 'marquee', p0: p, base }, e);
      }
    } else if (tool === 'note' || tool === 'text') {
      createTextItem(tool, p);
      setTool('select');
    } else if (tool === 'frame') {
      begin({ type: 'frame', p0: p, p1: p }, e);
    } else if (tool === 'pen' || tool === 'arrow') {
      const size = pen.size / cam.z;
      const path = svgEl('path', { fill: 'none', stroke: pen.color, 'stroke-width': size, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      const svg = svgEl('svg', { class: 'drawing' });
      svg.append(path);
      itemsLayer.append(svg);
      begin({ type: 'draw', arrow: tool === 'arrow', pts: [p.x, p.y], svg, path, size }, e);
    }
  });

  function beginResize(h, e) {
    const r = selBounds();
    const ids = [...sel];
    const single = ids.length === 1 ? items.get(ids[0]) : null;
    // Frames and notes reshape freely; everything else keeps its proportions.
    const free = !!single && (single.type === 'frame' || single.type === 'note') && !e.shiftKey;
    begin({
      type: 'resize', h, r, free,
      ax: h.includes('w') ? r.x + r.w : r.x,
      ay: h.includes('n') ? r.y + r.h : r.y,
      snap: snapshot(ids),
      rects: new Map(ids.map((id) => [id, bounds(items.get(id))])),
    }, e);
  }

  function dragMove(g, e, p) {
    if (!g.started) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
      g.started = true;
      if (g.alt) {
        const clones = cloneItems([...sel], 0);
        const ops = clones.map((item) => ({ t: 'add', item }));
        applyOps(ops);
        sendOps(ops);
        g.clones = clones.map((c) => c.id);
        setSel(g.clones);
      }
      g.snap = snapshot(movingIds());
    }
    const dx = p.x - g.p0.x;
    const dy = p.y - g.p0.y;
    for (const [id, before] of g.snap) liveSet(id, { x: round(before.x + dx), y: round(before.y + dy) });
    updateOverlay();
  }

  function dragResize(g, p) {
    const west = g.h.includes('w');
    const north = g.h.includes('n');
    if (g.free) {
      const [id] = g.snap.keys();
      const min = 40 / cam.z;
      const w = Math.max(min, west ? g.ax - p.x : p.x - g.ax);
      const h = Math.max(min, north ? g.ay - p.y : p.y - g.ay);
      liveSet(id, { x: round(west ? g.ax - w : g.ax), y: round(north ? g.ay - h : g.ay), w: round(w), h: round(h) });
    } else {
      const sx = (west ? g.ax - p.x : p.x - g.ax) / g.r.w;
      const sy = (north ? g.ay - p.y : p.y - g.ay) / g.r.h;
      const s = Math.max(sx, sy, 16 / (Math.max(g.r.w, g.r.h) * cam.z));
      for (const [id, before] of g.snap) {
        const b = g.rects.get(id);
        const patch = { x: round(g.ax + (b.x - g.ax) * s), y: round(g.ay + (b.y - g.ay) * s) };
        if (before.type === 'text') {
          patch.fs = round(before.fs * s);
        } else {
          patch.w = round(before.w * s);
          patch.h = round((before.h || 0) * s);
          if (before.type === 'note') patch.fs = round(before.fs * s);
          if (before.type === 'stroke') patch.size = round(before.size * s);
        }
        liveSet(id, patch);
      }
    }
    updateOverlay();
  }

  vp.addEventListener('pointermove', (e) => {
    pointer.sx = e.clientX;
    pointer.sy = e.clientY;
    pointer.inside = true;
    const p = s2w(e.clientX, e.clientY);
    sendP({ c: [round(p.x), round(p.y)] });
    if (tool === 'laser') addLaserPoint('me', me.color, p);

    const g = gesture;
    if (!g || e.pointerId !== g.pid) return;
    if (g.type === 'pan') {
      setCam(g.cx - (e.clientX - g.sx) / cam.z, g.cy - (e.clientY - g.sy) / cam.z, cam.z);
    } else if (g.type === 'move') {
      dragMove(g, e, p);
    } else if (g.type === 'resize') {
      dragResize(g, p);
    } else if (g.type === 'marquee') {
      showMarquee(g.p0, p);
      const r = { x: Math.min(g.p0.x, p.x), y: Math.min(g.p0.y, p.y), w: Math.abs(p.x - g.p0.x), h: Math.abs(p.y - g.p0.y) };
      const ids = new Set(g.base);
      for (const it of items.values()) {
        const b = bounds(it);
        if (it.type === 'frame' ? contains(r, b) : intersects(r, b)) ids.add(it.id);
      }
      setSel(ids);
    } else if (g.type === 'frame') {
      g.p1 = p;
      showMarquee(g.p0, p);
    } else if (g.type === 'draw') {
      if (g.arrow) {
        g.pts = [g.pts[0], g.pts[1], p.x, p.y];
      } else {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = s2w(ev.clientX, ev.clientY);
          const n = g.pts.length;
          if (Math.hypot(q.x - g.pts[n - 2], q.y - g.pts[n - 1]) >= 1.5 / cam.z) g.pts.push(q.x, q.y);
        }
      }
      g.path.setAttribute('d', pathData(g.pts, 1, 1, g.arrow, g.size));
    }
  });

  function endGesture(e) {
    const g = gesture;
    if (!g || (e && e.pointerId !== g.pid)) return;
    gesture = null;
    marquee.hidden = true;
    document.body.classList.remove('panning');

    if (g.type === 'move') {
      if (!g.started) {
        if (g.wasSelected && sel.size > 1) setSel([g.id]);
      } else if (g.clones) {
        flushLive();
        pushUndo([{ t: 'del', ids: g.clones }]);
      } else {
        recordSince(g.snap);
      }
    } else if (g.type === 'resize') {
      recordSince(g.snap);
    } else if (g.type === 'frame') {
      let r = { x: Math.min(g.p0.x, g.p1.x), y: Math.min(g.p0.y, g.p1.y), w: Math.abs(g.p1.x - g.p0.x), h: Math.abs(g.p1.y - g.p0.y) };
      if (r.w < 24 / cam.z || r.h < 24 / cam.z) {
        const w = 960 / cam.z;
        const h = 540 / cam.z;
        r = { x: g.p0.x - w / 2, y: g.p0.y - h / 2, w, h };
      }
      const item = { id: uid(), type: 'frame', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), title: '', color: FRAME_COLORS[0], z: 0 };
      exec([{ t: 'add', item }]);
      setTool('select');
      setSel([item.id]);
      startEdit(item.id);
    } else if (g.type === 'draw') {
      g.svg.remove();
      const pts = g.pts;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x0 = Math.min(x0, pts[i]);
        x1 = Math.max(x1, pts[i]);
        y0 = Math.min(y0, pts[i + 1]);
        y1 = Math.max(y1, pts[i + 1]);
      }
      const w = Math.max(x1 - x0, 1);
      const h = Math.max(y1 - y0, 1);
      if (!g.arrow || Math.hypot(x1 - x0, y1 - y0) > 8 / cam.z) {
        const norm = pts.map((v, i) => Math.round((i % 2 ? (v - y0) / h : (v - x0) / w) * 10000) / 10000);
        exec([{
          t: 'add',
          item: { id: uid(), type: 'stroke', x: round(x0), y: round(y0), w: round(w), h: round(h), pts: norm, color: pen.color, size: round(g.size), arrow: g.arrow, z: topZ() + 1 },
        }]);
      }
    }
    updateOverlay();
  }

  vp.addEventListener('pointerup', endGesture);
  vp.addEventListener('pointercancel', endGesture);
  vp.addEventListener('pointerleave', () => {
    pointer.inside = false;
    sendP({ c: null });
  });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());

  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    userMovedView();
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  vp.addEventListener('dblclick', (e) => {
    if (tool !== 'select' || editing) return;
    const node = e.target.closest('.item');
    const it = node && items.get(node.dataset.id);
    if (!it) return;
    if (it.type === 'note' || it.type === 'text' || it.type === 'frame') startEdit(it.id);
    else if (it.type === 'video') toggleVideo(it.id);
    else if (it.type === 'image') fitRect(bounds(it), { inset: { t: 64, r: 24, b: 24, l: presenting ? 24 : 80 } });
  });

  // ------------------------------------------------------------- drop, paste, copy

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    if ([...e.dataTransfer.types].includes('Files')) $('dropzone').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('dropzone').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    const at = s2w(e.clientX, e.clientY);
    if (e.dataTransfer.files.length) return addFiles(e.dataTransfer.files, at);
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) pasteText(text.split('\n')[0], at);
  });

  document.addEventListener('paste', (e) => {
    if (isTyping(e.target) || !e.clipboardData) return;
    e.preventDefault();
    const at = pointer.inside ? s2w(pointer.sx, pointer.sy) : viewCenter();
    if (e.clipboardData.files.length) return addFiles(e.clipboardData.files, at);
    pasteText(e.clipboardData.getData('text/plain'), at);
  });

  function copySel(e) {
    if (isTyping(e.target) || !sel.size) return false;
    e.clipboardData.setData('text/plain', JSON.stringify({ wipboard: 1, items: [...sel].map((id) => items.get(id)) }));
    e.preventDefault();
    return true;
  }
  document.addEventListener('copy', copySel);
  document.addEventListener('cut', (e) => {
    if (copySel(e)) deleteSel();
  });

  $('filepick').addEventListener('change', (e) => {
    addFiles(e.target.files, viewCenter());
    e.target.value = '';
  });

  // ------------------------------------------------------------- tools and keyboard

  const TOOLS = [
    ['select', 'Select and move (V)', ICON.select],
    ['pan', 'Pan (H, hold Space, or drag with the middle or right button)', ICON.pan],
    null,
    ['upload', 'Add images or video (or just drop or paste them)', ICON.upload],
    ['note', 'Note (N)', ICON.note],
    ['text', 'Heading text (T)', ICON.text],
    ['frame', 'Frame, a named section and a stop when presenting (F)', ICON.frame],
    null,
    ['pen', 'Draw (P)', ICON.pen],
    ['arrow', 'Arrow (A)', ICON.arrow],
    ['laser', 'Laser pointer, visible to everyone (L)', ICON.laser],
  ];

  function buildToolbar() {
    $('toolbar').replaceChildren(...TOOLS.map((t) => {
      if (!t) return el('span', { class: 'sep' });
      const [name, title, html] = t;
      return el('button', {
        class: 'iconbtn', 'data-tool': name, title, html,
        onclick: () => (name === 'upload' ? $('filepick').click() : setTool(name)),
      });
    }));
    $('back').innerHTML = ICON.boards;
    $('pprev').innerHTML = ICON.prev;
    $('pnext').innerHTML = ICON.next;
    buildToolOptions();
  }

  function buildToolOptions() {
    const savePen = () => {
      store('wb:pen', pen);
      buildToolOptions();
    };
    $('tooloptions').replaceChildren(
      ...INK.map((c) => el('button', {
        class: `swatch${c === pen.color ? ' active' : ''}`, style: { background: c }, title: 'Ink colour',
        onclick: () => { pen.color = c; savePen(); },
      })),
      el('span', { class: 'sep' }),
      ...PEN_SIZES.map((s) => el('button', {
        class: `iconbtn${s === pen.size ? ' active' : ''}`, title: 'Line weight',
        onclick: () => { pen.size = s; savePen(); },
      }, el('i', { class: 'dot', style: { width: `${s + 3}px`, height: `${s + 3}px` } }))));
  }

  function setTool(name) {
    tool = name;
    document.body.dataset.tool = name;
    for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === name);
    $('tooloptions').hidden = name !== 'pen' && name !== 'arrow';
    $('plaser').classList.toggle('active', name === 'laser');
    if (name !== 'select') setSel([]);
    sendP({ l: name === 'laser' ? 1 : 0 });
  }

  const TOOL_KEYS = { v: 'select', h: 'pan', n: 'note', t: 'text', f: 'frame', p: 'pen', a: 'arrow', l: 'laser' };

  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    const k = e.key.toLowerCase();
    if (e.code === 'Space') {
      e.preventDefault();
      spaceDown = true;
      document.body.classList.add('space');
      return;
    }
    const altGr = e.ctrlKey && e.altKey;
    if ((e.ctrlKey || e.metaKey) && !altGr) {
      if (k === 'z') e.shiftKey ? stepHistory(redoStack, undoStack) : stepHistory(undoStack, redoStack);
      else if (k === 'y') stepHistory(redoStack, undoStack);
      else if (k === 'a') { setTool('select'); setSel([...items.keys()]); }
      else if (k === 'd') duplicate();
      else if (k === 'p') packSelection();
      else if (k === '0') { userMovedView(); zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1 / cam.z); }
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey && !altGr) return;

    if (presenting) {
      if (k === 'arrowright' || k === 'arrowdown' || k === 'pagedown') return void (e.preventDefault(), moveStep(1));
      if (k === 'arrowleft' || k === 'arrowup' || k === 'pageup') return void (e.preventDefault(), moveStep(-1));
      if (k === 'escape') return void stopPresenting();
      if (k === 'l') return void setTool(tool === 'laser' ? 'select' : 'laser');
    }

    const video = selectedVideo();
    if (e.shiftKey && e.code === 'Digit1') { userMovedView(); fitAll(); }
    else if (e.shiftKey && e.code === 'Digit2') { const r = selBounds(); if (r) { userMovedView(); fitRect(r); } }
    else if (k === 'home') { userMovedView(); fitAll(); }
    else if (k === '?') toggleHelp();
    else if (k === 'delete' || k === 'backspace') deleteSel();
    else if (k === 'escape') {
      if (!$('helppanel').hidden) toggleHelp();
      else if (tool !== 'select') setTool('select');
      else setSel([]);
    }
    else if (k === ']' || k === 'pageup') reorder(1);
    else if (k === '[' || k === 'pagedown') reorder(-1);
    else if (k.startsWith('arrow') && sel.size) {
      const step = (e.shiftKey ? 10 : 1) / cam.z;
      nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    }
    else if (video && (k === 'k' || k === 'enter')) toggleVideo(video);
    else if (video && k === ',') stepVideo(video, -1);
    else if (video && k === '.') stepVideo(video, 1);
    else if (k === 'enter' && sel.size === 1 && els.get([...sel][0]).querySelector('.txt')) startEdit([...sel][0]);
    else if (TOOL_KEYS[k] && !e.shiftKey) setTool(TOOL_KEYS[k]);
    else return;
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    spaceDown = false;
    document.body.classList.remove('space');
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    document.body.classList.remove('space');
  });
  window.addEventListener('resize', applyCam);

  const HELP = [
    ['Pan', 'Space + drag, middle or right drag'],
    ['Zoom', 'Mouse wheel'],
    ['Fit everything / selection', 'Shift+1 / Shift+2'],
    ['Focus an image', 'Double-click it'],
    ['Add media', 'Drop files, or paste from the clipboard'],
    ['Note / Heading / Frame', 'N / T / F'],
    ['Draw / Arrow / Laser', 'P / A / L'],
    ['Edit text', 'Double-click or Enter'],
    ['Duplicate', 'Ctrl+D, or Alt + drag'],
    ['Tidy selection into a grid', 'Ctrl+P'],
    ['Bring to front / send to back', '] / [  or  PgUp / PgDn'],
    ['Scale a note with its text', 'Shift + drag a corner'],
    ['Play or pause video', 'Double-click or K'],
    ['Step video one frame', ', and .'],
    ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'],
    ['Presenting: next / previous', '→ / ←'],
  ];

  function toggleHelp() {
    const panel = $('helppanel');
    if (!panel.children.length) {
      panel.append(el('h2', { text: 'Shortcuts' }),
        el('dl', {}, HELP.flatMap(([what, keys]) => [el('dt', { text: what }), el('dd', { text: keys })])));
    }
    panel.hidden = !panel.hidden;
  }
  $('help').addEventListener('click', toggleHelp);
  // A focused button would swallow Space and Enter, which are canvas shortcuts here.
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (button) button.blur();
  });
  $('zoom').addEventListener('click', () => {
    userMovedView();
    fitAll();
  });

  // ------------------------------------------------------------- presenting and following

  function steps() {
    const all = [...items.values()];
    let list = all.filter((it) => it.type === 'frame');
    if (!list.length) list = all.filter((it) => it.type === 'image' || it.type === 'video');
    return readingOrder(list);
  }

  function goStep(i) {
    const list = steps();
    if (!list.length) {
      presentId = null;
      fitAll();
    } else {
      const it = list[clamp(i, 0, list.length - 1)];
      presentId = it.id;
      fitRect(bounds(it), { dur: 450 });
    }
    updatePresentBar();
  }

  function moveStep(dir) {
    const i = steps().findIndex((it) => it.id === presentId);
    goStep(i < 0 ? 0 : i + dir);
  }

  function updatePresentBar() {
    const list = steps();
    const i = list.findIndex((it) => it.id === presentId);
    const it = list[i];
    const label = it ? it.title || (it.type === 'frame' ? 'Untitled frame' : it.name) || '' : '';
    $('pstep').textContent = list.length
      ? `${i < 0 ? '–' : i + 1} / ${list.length}${label ? `  ·  ${label}` : ''}`
      : 'Nothing to step through yet';
    $('pprev').disabled = i <= 0;
    $('pnext').disabled = i < 0 || i >= list.length - 1;
  }

  function startPresenting() {
    finishEdit();
    const list = steps();
    const start = Math.max(0, list.findIndex((it) => sel.has(it.id)));
    presenting = true;
    following = null;
    document.body.classList.add('presenting');
    $('presentbar').hidden = false;
    $('present').textContent = 'Stop presenting';
    setTool('select');
    setSel([]);
    wsSend({ t: 'present', on: true });
    goStep(start);
    updateFollowUI();
  }

  function stopPresenting(tell = true) {
    if (!presenting) return;
    presenting = false;
    document.body.classList.remove('presenting');
    $('presentbar').hidden = true;
    $('present').textContent = 'Present';
    if (tool === 'laser') setTool('select');
    if (tell) wsSend({ t: 'present', on: false });
    updateOverlay();
  }

  $('present').addEventListener('click', () => (presenting ? stopPresenting() : startPresenting()));
  $('pexit').addEventListener('click', () => stopPresenting());
  $('pprev').addEventListener('click', () => moveStep(-1));
  $('pnext').addEventListener('click', () => moveStep(1));
  $('plaser').addEventListener('click', () => setTool(tool === 'laser' ? 'select' : 'laser'));

  function follow(id) {
    following = id;
    const peer = peers.get(id);
    if (peer && peer.p.v) followView(peer.p.v, 380);
    updateFollowUI();
  }

  // Shows at least everything the followed person can see, whatever our window shape.
  function followView(v, dur = 140) {
    fitRect({ x: v[0], y: v[1], w: v[2], h: v[3] }, { inset: { t: 0, r: 0, b: 0, l: 0 }, dur, linear: dur < 200 });
  }

  function onPresenter(id) {
    presenter = id;
    if (id && id !== myId) {
      stopPresenting(false);
      follow(id);
      const peer = peers.get(id);
      if (peer) toast(`${peer.name} started presenting. You are following their view.`);
    } else if (!id && following) {
      following = null;
    }
    updateFollowUI();
  }

  function updateFollowUI() {
    if (following && !peers.has(following)) following = null;
    const target = peers.get(following);
    const ring = $('followring');
    ring.hidden = !target;
    if (target) ring.style.setProperty('--c', target.color);

    const pill = $('followpill');
    const host = presenter && presenter !== myId ? peers.get(presenter) : null;
    if (host) {
      const on = following === host.id;
      pill.replaceChildren(
        el('i', { class: 'live', style: { background: host.color } }),
        el('span', { text: `${host.name} is presenting` }),
        el('button', { class: 'btn small', text: on ? 'Stop following' : 'Follow', onclick: () => (on ? userMovedView() : follow(host.id)) }));
    } else if (target) {
      pill.replaceChildren(
        el('i', { class: 'live', style: { background: target.color } }),
        el('span', { text: `Following ${target.name}` }),
        el('button', { class: 'btn small', text: 'Stop', onclick: userMovedView }));
    }
    pill.hidden = !host && !target;
    renderPeers();
  }

  // ------------------------------------------------------------- peers, cursors, laser

  function renderPeers() {
    const list = [...peers.values()];
    const nodes = [
      ...list.slice(0, 8).map((peer) => el('button', {
        class: `avatar${following === peer.id ? ' following' : ''}${presenter === peer.id ? ' presenting' : ''}`,
        style: { background: peer.color },
        title: `${peer.name}${presenter === peer.id ? ' (presenting)' : ''}. Click to ${following === peer.id ? 'stop following' : 'follow their view'}`,
        text: WB.initials(peer.name),
        onclick: () => (following === peer.id ? userMovedView() : follow(peer.id)),
      })),
      list.length > 8 && el('span', { class: 'avatar more', text: `+${list.length - 8}` }),
      el('button', { class: 'avatar me', style: { background: me.color }, title: `${me.name} (you). Click to change your name`, text: WB.initials(me.name), onclick: rename }),
    ];
    $('peers').replaceChildren(...nodes.filter(Boolean));
  }

  async function rename() {
    const before = me.name;
    me = await WB.askName(true);
    if (me.name !== before) location.reload();
  }

  function placeCursor(peer) {
    const c = peer.p.c;
    if (!c) {
      if (peer.cur) peer.cur.hidden = true;
      return;
    }
    if (!peer.cur) {
      peer.cur = el('div', { class: 'cursor', html: CURSOR_SVG }, el('span', { text: peer.name }));
      peer.cur.style.setProperty('--c', peer.color);
      cursorsLayer.append(peer.cur);
    }
    const s = w2s(c[0], c[1]);
    peer.cur.hidden = false;
    peer.cur.classList.toggle('laser', !!peer.p.l);
    peer.cur.style.transform = `translate(${s.x}px, ${s.y}px)`;
  }

  function refreshPeerSel() {
    for (const node of world.querySelectorAll('.peersel')) node.classList.remove('peersel');
    for (const peer of peers.values()) {
      for (const id of peer.p.s || []) {
        const node = els.get(id);
        if (!node) continue;
        node.classList.add('peersel');
        node.style.setProperty('--peer', peer.color);
      }
    }
  }

  function addPeer(data) {
    peers.set(data.id, { id: data.id, name: data.name, color: data.color, p: data.p || {}, cur: null });
    placeCursor(peers.get(data.id));
  }

  function dropPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.cur) peer.cur.remove();
    peers.delete(id);
    trails.delete(id);
  }

  const trails = new Map();
  const laserCanvas = $('laser');
  let laserRaf = 0;

  function addLaserPoint(key, color, p) {
    let trail = trails.get(key);
    if (!trail) trails.set(key, (trail = { color, pts: [] }));
    trail.pts.push({ x: p.x, y: p.y, t: performance.now() });
    if (!laserRaf) laserRaf = requestAnimationFrame(drawLaser);
  }

  function drawLaser() {
    laserRaf = 0;
    const dpr = window.devicePixelRatio || 1;
    const w = vp.clientWidth;
    const h = vp.clientHeight;
    if (laserCanvas.width !== Math.round(w * dpr) || laserCanvas.height !== Math.round(h * dpr)) {
      laserCanvas.width = Math.round(w * dpr);
      laserCanvas.height = Math.round(h * dpr);
    }
    const ctx = laserCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    const now = performance.now();
    for (const [key, trail] of trails) {
      while (trail.pts.length && now - trail.pts[0].t > LASER_LIFE) trail.pts.shift();
      if (!trail.pts.length) {
        trails.delete(key);
        continue;
      }
      ctx.strokeStyle = trail.color;
      ctx.shadowColor = trail.color;
      ctx.shadowBlur = 14;
      for (let i = 1; i < trail.pts.length; i++) {
        const a = w2s(trail.pts[i - 1].x, trail.pts[i - 1].y);
        const b = w2s(trail.pts[i].x, trail.pts[i].y);
        const k = 1 - (now - trail.pts[i].t) / LASER_LIFE;
        ctx.globalAlpha = k;
        ctx.lineWidth = 2 + 5 * k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      const last = trail.pts[trail.pts.length - 1];
      const head = w2s(last.x, last.y);
      ctx.globalAlpha = Math.min(1, (1 - (now - last.t) / LASER_LIFE) * 2);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(head.x, head.y, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (trails.size) laserRaf = requestAnimationFrame(drawLaser);
  }

  // ------------------------------------------------------------- connection

  function wsSend(msg) {
    if (online) ws.send(JSON.stringify(msg));
  }

  const presenceOut = {};
  let presenceTimer = 0;
  function sendP(patch) {
    Object.assign(presenceOut, patch);
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => {
      presenceTimer = 0;
      wsSend({ t: 'p', p: { ...presenceOut } });
      for (const k of Object.keys(presenceOut)) delete presenceOut[k];
    }, 40);
  }

  function setBoardName(name) {
    document.title = `${name} · Wipboard`;
    if (document.activeElement !== $('boardname')) $('boardname').value = name;
  }

  $('boardname').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'Untitled';
    e.target.value = name;
    document.title = `${name} · Wipboard`;
    sendOps([{ t: 'meta', patch: { name } }]);
  });
  $('boardname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
  });

  function onInit(msg) {
    finishEdit();
    flushLive();
    const queued = outbox.splice(0);
    pendingKeys.clear();
    myId = msg.you;
    online = true;
    retry = 500;
    $('conn').hidden = true;

    for (const id of [...els.keys()]) {
      els.get(id).remove();
      els.delete(id);
    }
    items.clear();
    for (const it of msg.items) {
      items.set(it.id, it);
      renderItem(it);
    }
    setBoardName(msg.board.name);

    for (const id of [...peers.keys()]) dropPeer(id);
    for (const p of msg.peers) addPeer(p);

    // Anything done while disconnected is replayed on top of the server's state.
    for (const batch of queued) {
      applyOps(batch.ops);
      sendOps(batch.ops);
    }
    setSel([...sel]);
    afterChange();
    refreshPeerSel();

    if (firstInit) {
      firstInit = false;
      const saved = store(`wb:cam:${boardId}`);
      if (saved && isFinite(saved.x) && isFinite(saved.y) && saved.z > 0) setCam(saved.x, saved.y, saved.z);
      else fitAll(0);
    } else {
      applyCam();
    }
    sendP({ l: tool === 'laser' ? 1 : 0 });
    if (presenting) wsSend({ t: 'present', on: true });
    else onPresenter(msg.presenter);
    updateFollowUI();
  }

  function onMessage(msg) {
    if (msg.t === 'init') {
      onInit(msg);
    } else if (msg.t === 'op') {
      applyOps(msg.ops, true);
      refreshPeerSel();
    } else if (msg.t === 'ack') {
      onAck();
    } else if (msg.t === 'join') {
      addPeer(msg.peer);
      updateFollowUI();
    } else if (msg.t === 'leave') {
      dropPeer(msg.id);
      refreshPeerSel();
      updateFollowUI();
    } else if (msg.t === 'presenter') {
      onPresenter(msg.id);
    } else if (msg.t === 'p') {
      const peer = peers.get(msg.id);
      if (!peer) return;
      Object.assign(peer.p, msg.p);
      if ('c' in msg.p || 'l' in msg.p) {
        placeCursor(peer);
        if (peer.p.l && peer.p.c && 'c' in msg.p) addLaserPoint(peer.id, peer.color, { x: peer.p.c[0], y: peer.p.c[1] });
      }
      if ('s' in msg.p) refreshPeerSel();
      if ('v' in msg.p && following === peer.id && !gesture) followView(peer.p.v);
    } else if (msg.t === 'media') {
      if (following !== msg.from) return;
      const video = videoOf(msg.id);
      if (!video) return;
      if (Math.abs(video.currentTime - msg.time) > 0.25) video.currentTime = msg.time;
      if (msg.playing) video.play().catch(() => {});
      else video.pause();
    }
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?board=${boardId}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: me.name, color: me.color }));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      online = false;
      if (e.code === 4004) return fatal('This board was deleted.');
      $('conn').hidden = false;
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 8000);
    };
  }

  function fatal(text) {
    document.body.replaceChildren(el('div', { class: 'fatal' },
      el('h1', { text }),
      el('a', { class: 'btn primary', href: '/', text: 'Back to all boards' })));
  }

  // ------------------------------------------------------------- start

  me = await WB.askName();
  try {
    await WB.api('GET', `/api/boards/${boardId}`);
  } catch {
    return fatal('This board does not exist.');
  }
  buildToolbar();
  setTool('select');
  applyCam();
  connect();
})();
