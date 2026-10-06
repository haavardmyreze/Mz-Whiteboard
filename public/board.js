'use strict';

(async () => {
  const { el, store } = WB;
  const $ = (id) => document.getElementById(id);

  const boardId = location.pathname.split('/').filter(Boolean)[1];
  const vp = $('viewport');
  const world = $('world');
  const framesLayer = $('frames');
  const itemsLayer = $('items');
  const inksLayer = $('inks'); // drawings, always above the content whatever its order
  const cursorsLayer = $('cursors');
  const selbox = $('selbox');
  const seltools = $('seltools');
  const marquee = $('marquee');

  const MIN_Z = 0.02;
  const MAX_Z = 16;
  const PREVIEW_MAX = 2048;
  const LASER_LIFE = 450;
  const INK = ['ink', '#e5484d', '#f59e0b', '#16a34a', '#2f7df6', '#8b5cf6'];
  const NOTE_FILLS = ['note', '#fff2a8', '#ffd3d1', '#d4f1d2', '#d0e6ff', '#e7dbff'];
  // 'ink' and 'note' stand for the theme's own text and note colours, so a board reads well in either
  // theme. The literal greys and whites earlier versions stored are treated the same way.
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const INK_DEFAULTS = new Set(['ink', '#f2f2f3', '#f5f5f6', '#1f1f23']);
  const NOTE_DEFAULTS = new Set(['note', '#2f2f33', '#2c2c31', '#ffffff']);
  const inkColor = (c) => (!c || INK_DEFAULTS.has(c) ? (isLight() ? '#1f1f23' : '#f2f2f3') : c);
  const noteColor = (c) => (!c || NOTE_DEFAULTS.has(c) ? (isLight() ? '#ffffff' : '#2c2c31') : c);
  // Colours are stored vivid and shown a little softer, more so in the dark theme, so headings and
  // notes sit calmly beside the artwork instead of competing with it.
  const shadeCache = new Map();
  // Moves a #rrggbb colour in HSL: saturation and lightness are scaled by the given factors.
  function shade(hex, satK, lightK) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex;
    const key = `${hex}|${satK}|${lightK}`;
    if (shadeCache.has(key)) return shadeCache.get(key);
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) / 255;
    const g = ((n >> 8) & 255) / 255;
    const bl = (n & 255) / 255;
    const max = Math.max(r, g, bl);
    const min = Math.min(r, g, bl);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - bl) / d + (g < bl ? 6 : 0) : max === g ? (bl - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    s = Math.min(1, s * satK);
    const nl = Math.min(1, l * lightK);
    const q = nl < 0.5 ? nl * (1 + s) : nl + s - nl * s;
    const p = 2 * nl - q;
    const chan = (t) => {
      const u = (t + 1) % 1;
      const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
      return Math.round(v * 255).toString(16).padStart(2, '0');
    };
    const grey = [nl, nl, nl].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    const out = `#${s === 0 ? grey : chan(h + 1 / 3) + chan(h) + chan(h - 1 / 3)}`;
    shadeCache.set(key, out);
    return out;
  }
  // Colours are stored vivid and shown a little softer, more so in the dark theme, so headings and
  // notes sit calmly beside the artwork instead of competing with it.
  const mute = (hex) => (isLight() ? shade(hex, 0.78, 1) : shade(hex, 0.55, 0.82));
  // Frames sit a rung below blocks in the hierarchy: the same hues, set deeper.
  const deepen = (hex) => shade(mute(hex), 0.9, 0.62);
  const swatchColor = (c) => (c === 'ink' ? inkColor(c) : c === 'note' ? noteColor(c) : c);
  // Vivid header colours for frames and the free-standing heading blocks.
  const BLOCK_COLORS = ['#ff6bd6', '#7ed957', '#4d7cff', '#ffd43b', '#ff9a3c', '#b388ff', '#2dd4bf', '#6b6b73', '#17171a', '#f4f4f5'];
  const FRAME_COLORS = ['#8a8a93', ...BLOCK_COLORS.filter((c) => c !== '#f4f4f5')];
  const PEN_SIZES = [4, 8, 16];
  const FRAME_PAD = 28;
  // World-unit sizes for new items: what you get does not depend on how far you are zoomed in.
  const IMG_W = 480;
  const IMG_MAX_H = 720;
  const NOTE_W = 260;
  const NOTE_FS = 16;
  const FRAME_W = 800;
  const FRAME_H = 500;
  // Every frame has a header band for its title and a count; blocks are free-standing coloured headings.
  const FRAME_HEAD = 80;
  const BLOCK_W = 480;
  const BLOCK_H = 104;
  const BLOCK_FS = 56;
  const SNAP_PX = 7;
  // Sizes are screen pixels at the zoom the text was created at.
  const TEXT_LEVELS = [
    { lvl: 1, label: 'H1', size: 56, title: 'Heading 1' },
    { lvl: 2, label: 'H2', size: 36, title: 'Heading 2' },
    { lvl: 3, label: 'H3', size: 24, title: 'Heading 3' },
    { lvl: 0, label: 'Text', size: 18, title: 'Plain text' },
  ];
  const levelSize = (lvl) => (TEXT_LEVELS.find((l) => l.lvl === lvl) || TEXT_LEVELS[1]).size;
  const COLORABLE = new Set(['note', 'text', 'frame', 'block', 'stroke']);
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
  const VID_EXT = /\.(mp4|m4v|webm|mov)$/i;
  const EXT_BY_TYPE = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif',
    'image/bmp': '.bmp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  };

  const icon = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    select: icon('<path d="M5 3l5.5 16 2.5-6.5L19.5 10z"/>'),
    pan: icon('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
    upload: icon('<rect x="3" y="5" width="18" height="14"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-8 9"/>'),
    note: icon('<path d="M5 4h14v10l-5 6H5z"/><path d="M14 20v-6h5"/>'),
    text: icon('<path d="M5 7V4h14v3M12 4v16M9 20h6"/>'),
    frame: icon('<path d="M7 3v18M17 3v18M3 7h18M3 17h18"/>'),
    pen: icon('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
    arrow: icon('<path d="M5 19L19 5M9 5h10v10"/>'),
    laser: icon('<circle cx="12" cy="12" r="3" fill="currentColor"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M5.6 18.4l2-2M16.4 7.6l2-2"/>'),
    boards: icon('<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>'),
    prev: icon('<path d="M15 5l-7 7 7 7"/>'),
    next: icon('<path d="M9 5l7 7-7 7"/>'),
    front: icon('<rect x="8" y="8" width="12" height="12" fill="currentColor"/><path d="M4 14V5a1 1 0 0 1 1-1h9"/>'),
    back: icon('<rect x="4" y="4" width="12" height="12"/><path d="M20 10v9a1 1 0 0 1-1 1h-9" stroke-dasharray="2 3"/>'),
    tidy: icon('<rect x="3" y="4" width="8" height="7"/><rect x="13" y="4" width="8" height="7"/><rect x="3" y="13" width="5" height="7"/><rect x="10" y="13" width="11" height="7"/>'),
    dup: icon('<rect x="8" y="8" width="12" height="12"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
    open: icon('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    trash: icon('<path d="M4 7h16M10 4h4M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
    play: icon('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
    pause: icon('<path d="M7 4v16M17 4v16" stroke-width="3.5"/>'),
    muted: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 9l5 6M22 9l-5 6"/>'),
    sound: icon('<path d="M4 9v6h4l5 4V5L8 9zM17 8a5 5 0 0 1 0 8"/>'),
    focus: icon('<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><circle cx="12" cy="12" r="2.5"/>'),
    block: icon('<rect x="3" y="7" width="18" height="10"/><path d="M8 12h8"/>'),
    alignL: icon('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
    alignC: icon('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
    snap: icon('<path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><path d="M6 7h4M14 7h4"/>'),
    fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6"/>'),
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
  const textPref = store('wb:text') || { lvl: 2 };
  if (!PEN_SIZES.includes(pen.size)) pen.size = PEN_SIZES.reduce((a, b) => (Math.abs(b - pen.size) < Math.abs(a - pen.size) ? b : a));

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
  let snapOn = store('wb:snap') !== false;
  let focusId = null;
  let focusReturn = null;

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
    if (laserActive()) requestLaser();
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
      // Moving the centre in step with the visible size, not with time, keeps every point on a
      // straight line across the screen while the view zooms.
      const span = 1 / to.z - 1 / z0;
      const u = Math.abs(span) < 1e-9 ? e : (1 / cam.z - 1 / z0) / span;
      cam.x = c0.x + (c1.x - c0.x) * u - vw / 2 / cam.z;
      cam.y = c0.y + (c1.y - c0.y) * u - vh / 2 / cam.z;
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

  // Outline of a brush stroke whose width follows `ws` (a 0..1 multiplier of `size` per point).
  function outlinePath(pts, ws, sx, sy, size) {
    const n = pts.length / 2;
    const f = (v) => v.toFixed(2);
    const P = [];
    const R = [];
    for (let i = 0; i < n; i++) {
      P.push([pts[i * 2] * sx, pts[i * 2 + 1] * sy]);
      R.push(Math.max(0.15, size * (ws[i] ?? 1)) / 2);
    }
    if (n === 1) {
      const [x, y] = P[0];
      return `M${f(x - R[0])} ${f(y)}a${f(R[0])} ${f(R[0])} 0 1 0 ${f(2 * R[0])} 0a${f(R[0])} ${f(R[0])} 0 1 0 ${f(-2 * R[0])} 0z`;
    }
    const A = [];
    const B = [];
    let tx = 1;
    let ty = 0;
    for (let i = 0; i < n; i++) {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(n - 1, i + 1)];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 1e-6) {
        tx = (b[0] - a[0]) / len;
        ty = (b[1] - a[1]) / len;
      }
      A.push([P[i][0] - ty * R[i], P[i][1] + tx * R[i]]);
      B.push([P[i][0] + ty * R[i], P[i][1] - tx * R[i]]);
    }
    const side = (S) => {
      let d = '';
      for (let i = 1; i < S.length - 1; i++) {
        d += `Q${f(S[i][0])} ${f(S[i][1])} ${f((S[i][0] + S[i + 1][0]) / 2)} ${f((S[i][1] + S[i + 1][1]) / 2)}`;
      }
      return `${d}L${f(S[S.length - 1][0])} ${f(S[S.length - 1][1])}`;
    };
    const last = n - 1;
    let d = `M${f(A[0][0])} ${f(A[0][1])}${side(A)}`;
    d += `A${f(R[last])} ${f(R[last])} 0 0 0 ${f(B[last][0])} ${f(B[last][1])}`;
    d += side(B.slice().reverse());
    d += `A${f(R[0])} ${f(R[0])} 0 0 0 ${f(A[0][0])} ${f(A[0][1])}Z`;
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
    // Clicks on the big button are handled by the pointer gesture so the video can still be dragged by it.
    const center = el('div', { class: 'vplay', html: ICON.play, 'aria-hidden': 'true' });
    for (const type of ['play', 'pause']) {
      video.addEventListener(type, () => {
        play.innerHTML = video.paused ? ICON.play : ICON.pause;
        center.innerHTML = video.paused ? ICON.play : ICON.pause;
        node.classList.toggle('playing', !video.paused);
      });
    }
    node.append(video, center, el('div', { class: 'vbar' }, play, seek, time, mute));
  }

  function createNode(it) {
    const node = el('div', { class: `item ${it.type}`, 'data-id': it.id });
    if (it.type === 'image') {
      node.append(el('img', { alt: it.name || '', draggable: 'false', decoding: 'async' }));
    } else if (it.type === 'video') {
      buildVideo(it, node);
    } else if (it.type === 'note' || it.type === 'text' || it.type === 'block') {
      node.append(el('div', { class: 'txt', spellcheck: 'false' }));
    } else if (it.type === 'frame') {
      node.append(
        el('div', { class: 'frame-head' }, el('div', { class: 'frame-title txt', spellcheck: 'false' }), el('div', { class: 'frame-sub' })),
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
      (it.type === 'frame' ? framesLayer : it.type === 'stroke' ? inksLayer : itemsLayer).append(node);
    }
    const st = node.style;
    st.transform = `translate(${it.x}px, ${it.y}px)`;
    st.zIndex = it.z || 0;
    const isEditing = editing && editing.id === it.id;
    node.classList.toggle('dim', !!focusId && it.id !== focusId && it.pid !== focusId);

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
      const fill = mute(noteColor(it.color));
      st.width = `${it.w}px`;
      st.minHeight = `${it.h || 0}px`;
      st.fontSize = `${it.fs}px`;
      st.background = fill;
      st.color = luminance(fill) > 0.55 ? '#1b1b1c' : '#f2f2f3';
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'text') {
      node.dataset.lvl = it.lvl ?? 2;
      st.fontSize = `${it.fs}px`;
      st.color = inkColor(it.color);
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'frame') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const tinted = !!it.color && it.color !== FRAME_COLORS[0];
      const headColor = tinted ? deepen(it.color) : FRAME_COLORS[0];
      st.setProperty('--c', headColor);
      node.dataset.tint = tinted ? '1' : '';
      st.setProperty('--head-ink', tinted && luminance(headColor) > 0.55 ? '#1b1b1c' : '#fff');
      if (!isEditing) node.firstChild.firstChild.textContent = it.title || '';
    } else if (it.type === 'block') {
      const fill = mute(it.color || BLOCK_COLORS[0]);
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      st.fontSize = `${BLOCK_FS}px`;
      st.background = fill;
      st.color = luminance(fill) > 0.55 ? '#1b1b1c' : '#ffffff';
      node.dataset.align = it.align || 'center';
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'stroke') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const [hit, ink] = node.firstChild.children;
      const d = pathData(it.pts, it.w, it.h, it.arrow, it.size);
      hit.setAttribute('d', d);
      hit.style.strokeWidth = `calc(${it.size}px + 14px * var(--inv))`;
      const color = inkColor(it.color);
      if (it.ws) {
        // Brush strokes are a filled outline so their width can vary along the line.
        ink.setAttribute('d', outlinePath(it.pts, it.ws, it.w, it.h, it.size));
        ink.style.fill = color;
        ink.style.stroke = 'none';
      } else {
        ink.setAttribute('d', d);
        ink.style.fill = 'none';
        ink.style.stroke = color;
        ink.style.strokeWidth = `${it.size}px`;
      }
    }
  }

  function removeItem(id) {
    if (focusId === id) exitFocus();
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
    updateFrameCounts();
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
    refitLive(frameIds());
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
  function recordSince(snap, extra = []) {
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
    pushUndo([...extra, ...inverse]);
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
    selbox.classList.toggle('noresize', [...sel].some((id) => items.get(id)?.type === 'text'));
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
    const one = list.length === 1 ? list[0] : null;
    const sig = `${[...types].sort().join()}|${Math.min(list.length, 2)}|${one ? `${one.lvl ?? ''}${one.auto ?? ''}${one.align ?? ''}` : ''}`;
    if (seltools.dataset.sig === sig) return;
    seltools.dataset.sig = sig;

    const btn = (html, title, onclick) => el('button', { class: 'iconbtn', html, title, onclick });
    const kids = [];
    if (list.some((it) => COLORABLE.has(it.type))) {
      const only = types.size === 1 ? [...types][0] : null;
      const palette = only === 'note' ? NOTE_FILLS : only === 'frame' ? FRAME_COLORS : only === 'block' ? BLOCK_COLORS : INK;
      for (const c of palette) {
        kids.push(el('button', { class: 'swatch', style: { background: only === 'note' ? mute(noteColor(c)) : only === 'block' ? mute(c) : only === 'frame' ? (c === FRAME_COLORS[0] ? c : deepen(c)) : swatchColor(c) }, title: 'Set colour', onclick: () => colorSel(c) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    if (types.has('text')) {
      for (const l of TEXT_LEVELS) {
        kids.push(el('button', { class: `lvl${one && (one.lvl ?? 2) === l.lvl ? ' active' : ''}`, title: l.title, text: l.label, onclick: () => setLevel(l.lvl) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    if (one && one.type === 'block') {
      for (const [a, html, title] of [['left', ICON.alignL, 'Align left'], ['center', ICON.alignC, 'Centre']]) {
        kids.push(el('button', { class: `iconbtn${(one.align || 'center') === a ? ' active' : ''}`, html, title, onclick: () => exec([{ t: 'set', id: one.id, patch: { align: a } }]) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    if (one && one.type === 'frame') {
      kids.push(el('button', {
        class: `iconbtn${one.auto === false ? '' : ' active'}`, html: ICON.fit, onclick: toggleAutoFit,
        title: one.auto === false ? 'Fit to content: off. Click to make the frame wrap what is inside it' : 'Fit to content: on. The frame follows what is inside it',
      }), el('span', { class: 'sep' }));
    }
    kids.push(btn(ICON.front, 'Bring to front ( ] or PgUp )', () => reorder(1)), btn(ICON.back, 'Send to back ( [ or PgDn )', () => reorder(-1)));
    if (list.length > 1) kids.push(btn(ICON.tidy, 'Tidy into a grid (Ctrl+P)', packSelection));
    kids.push(btn(ICON.dup, 'Duplicate (Ctrl+D)', duplicate));
    if (one && (one.type === 'image' || one.type === 'video')) kids.push(btn(ICON.focus, 'Open it and draw on it (double-click)', () => enterFocus(one.id)));
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

  // Copies of the items plus whatever travels with them (frame contents, drawings on images).
  function cloneItems(ids, offset) {
    let z = topZ();
    const list = [...withDependents(ids)].map((id) => items.get(id)).filter(Boolean)
      .sort((a, b) => (a.z || 0) - (b.z || 0));
    const picked = new Set(ids);
    const copies = reid(list).map((it) => ({ ...it, x: round(it.x + offset), y: round(it.y + offset), z: ++z }));
    return { all: copies, primary: copies.filter((_, i) => picked.has(list[i].id)).map((c) => c.id) };
  }

  function duplicate() {
    if (!sel.size) return;
    const { all, primary } = cloneItems([...sel], 24 / cam.z);
    exec(addOps(all));
    setSel(primary);
  }

  function deleteSel() {
    if (sel.size) exec(delOps(sel));
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

  // Groups rects that share a lane along one axis: each group is a row (or a column).
  function lanes(boxed, lo, len) {
    const groups = [];
    for (const o of boxed.slice().sort((p, q) => lo(p.b) - lo(q.b))) {
      const a0 = lo(o.b);
      const a1 = a0 + len(o.b);
      const g = groups.find((x) => Math.min(x.hi, a1) - Math.max(x.lo, a0) >= 0.4 * Math.min(x.hi - x.lo, len(o.b)));
      if (g) {
        g.n++;
        g.lo = Math.min(g.lo, a0);
        g.hi = Math.max(g.hi, a1);
      } else {
        groups.push({ lo: a0, hi: a1, n: 1 });
      }
    }
    return groups;
  }

  // Reads the current arrangement: a vertical line stays a column, a horizontal one stays a row,
  // and a grid keeps the number of columns it already has.
  function detectShape(boxed) {
    const n = boxed.length;
    const columns = lanes(boxed, (r) => r.x, (r) => r.w);
    const rows = lanes(boxed, (r) => r.y, (r) => r.h);
    const perRow = Math.max(...rows.map((g) => g.n));
    if (columns.length === 1 && rows.length > 1) return { cols: 1 };
    if (rows.length === 1 && columns.length > 1) return { cols: n };
    if (perRow <= 1) return { cols: 1 };
    // A heap with no structure gets a roughly square grid.
    if (columns.length === 1 && rows.length === 1) return { cols: Math.ceil(Math.sqrt(n * 1.6)) };
    return { cols: Math.min(n, perRow) };
  }

  // Tidying frames treats each as one piece: they keep their own sizes, are laid out in the shape they
  // already have (a column, a row or a grid), and carry their contents and drawings along.
  function packFrames(frames) {
    const ordered = readingOrder(frames);
    const boxed = ordered.map((it) => ({ it, b: bounds(it) }));
    const origin = boxed.reduce((r, o) => union(r, o.b), null);
    const { cols } = detectShape(boxed);
    const gap = 48;
    const ops = [];
    let x = 0;
    let y = 0;
    let tallest = 0;
    let inRow = 0;
    for (const o of boxed) {
      if (inRow === cols) {
        x = 0;
        y += tallest + gap;
        tallest = 0;
        inRow = 0;
      }
      const dx = round(origin.x + x - o.b.x);
      const dy = round(origin.y + y - o.b.y);
      if (dx || dy) {
        for (const id of withDependents([o.it.id])) {
          const part = items.get(id);
          ops.push({ t: 'set', id, patch: { x: round(part.x + dx), y: round(part.y + dy) } });
        }
      }
      x += o.b.w + gap;
      tallest = Math.max(tallest, o.b.h);
      inRow++;
    }
    if (ops.length) exec(ops);
  }

  // PureRef-style pack: media is normalised to one size and laid out in the shape it already has.
  // Frames and drawn annotations stay put; moving them would change what they mean.
  function packSelection() {
    const frames = [...sel].map((id) => items.get(id)).filter((it) => it && it.type === 'frame');
    if (frames.length >= 2) return packFrames(frames);
    const list = readingOrder([...sel].map((id) => items.get(id))
      .filter((it) => it && it.type !== 'frame' && it.type !== 'stroke'));
    if (list.length < 2) return;
    const isMedia = (it) => it.type === 'image' || it.type === 'video';
    const boxed = list.map((it) => ({ it, b: bounds(it) }));
    const origin = boxed.reduce((r, o) => union(r, o.b), null);
    const { cols } = detectShape(boxed);
    const median = (values) => values.slice().sort((p, q) => p - q)[Math.floor(values.length / 2)];
    const refs = boxed.some((o) => isMedia(o.it)) ? boxed.filter((o) => isMedia(o.it)) : boxed;
    // A column shares one width; rows share one height.
    const colW = median(refs.map((o) => o.b.w));
    const rowH = median(refs.map((o) => o.b.h));
    const gap = Math.max(8, Math.round((cols === 1 ? colW : rowH) * 0.05));
    for (const o of boxed) {
      o.s = isMedia(o.it) ? (cols === 1 ? colW / o.b.w : rowH / o.b.h) : 1;
      o.w = o.b.w * o.s;
      o.h = o.b.h * o.s;
    }
    const ops = [];
    let x = 0;
    let y = 0;
    let tallest = 0;
    let inRow = 0;
    for (const o of boxed) {
      if (inRow === cols) {
        x = 0;
        y += tallest + gap;
        tallest = 0;
        inRow = 0;
      }
      const patch = { x: round(origin.x + x), y: round(origin.y + y) };
      if (o.s !== 1) Object.assign(patch, { w: round(o.w), h: round(o.h) });
      ops.push({ t: 'set', id: o.it.id, patch });
      for (const ch of items.values()) {
        if (ch.pid !== o.it.id) continue;
        const moved = { x: round(patch.x + (ch.x - o.b.x) * o.s), y: round(patch.y + (ch.y - o.b.y) * o.s) };
        if (o.s !== 1) Object.assign(moved, { w: round(ch.w * o.s), h: round(ch.h * o.s), size: round(ch.size * o.s) });
        ops.push({ t: 'set', id: ch.id, patch: moved });
      }
      x += o.w + gap;
      tallest = Math.max(tallest, o.h);
      inRow++;
    }
    exec(ops);
    refitLive(boxed.map((o) => o.it.fid).filter(Boolean));
  }

  function nudge(dx, dy) {
    const ops = [];
    for (const id of movingIds()) {
      const it = items.get(id);
      ops.push({ t: 'set', id, patch: { x: round(it.x + dx), y: round(it.y + dy) } });
    }
    exec(ops);
  }

  // ------------------------------------------------------------- frames, drawings, snapping

  const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const hasPoint = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  const area = (r) => r.w * r.h;
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  // Distance between two rects: 0 when they touch or overlap.
  const rectGap = (a, b) => Math.hypot(
    Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)),
    Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)),
  );

  // True when at least half of the item's bounding box is over the rect.
  const halfIn = (it, r) => {
    const b = bounds(it);
    return overlapArea(b, r) >= 0.5 * area(b);
  };
  const rectDiffers = (a, b) => Math.abs(a.x - b.x) > 0.05 || Math.abs(a.y - b.y) > 0.05
    || Math.abs(a.w - b.w) > 0.05 || Math.abs(a.h - b.h) > 0.05;

  function frameOf(it) {
    const f = it.fid && items.get(it.fid);
    return f && f.type === 'frame' ? f : null;
  }

  // While an image is open, only it and its drawings take part in anything.
  function selectable(it) {
    return !focusId || it.id === focusId || it.pid === focusId;
  }

  function frameIds() {
    return [...items.values()].filter((it) => it.type === 'frame').map((it) => it.id);
  }

  // Everything that travels with the given items: frame contents and the drawings on images.
  function withDependents(ids) {
    const out = new Set(ids);
    for (const id of ids) {
      const it = items.get(id);
      if (it && it.type === 'frame') for (const m of membersOf(id)) out.add(m.id);
    }
    for (const it of items.values()) if (it.pid && out.has(it.pid)) out.add(it.id);
    return out;
  }

  const movingIds = () => withDependents(sel);

  function hugRect(list) {
    let r = null;
    for (const it of list) r = union(r, bounds(it));
    return r && { x: round(r.x - FRAME_PAD), y: round(r.y - FRAME_PAD - FRAME_HEAD), w: round(r.w + 2 * FRAME_PAD), h: round(r.h + 2 * FRAME_PAD + FRAME_HEAD) };
  }

  function membersOf(frameId, { extra = [], excl = null } = {}) {
    const list = [];
    for (const it of items.values()) {
      if (it.fid === frameId && it.type !== 'frame' && it.type !== 'block' && it.type !== 'stroke' && !(excl && excl.has(it.id))) list.push(it);
    }
    for (const it of extra) if (it.fid === frameId && it.type !== 'block' && it.type !== 'stroke') list.push(it);
    return list;
  }

  // Ops that resize auto-fit frames so they wrap what they hold.
  function refitOps(frameIdList, opts = {}) {
    const ops = [];
    for (const id of new Set(frameIdList)) {
      const f = items.get(id);
      if (!f || f.type !== 'frame' || f.auto === false || (opts.excl && opts.excl.has(id))) continue;
      const r = hugRect(membersOf(id, opts));
      if (r && rectDiffers(f, r)) ops.push({ t: 'set', id, patch: r });
    }
    return ops;
  }

  function refitLive(frameIdList) {
    for (const op of refitOps(frameIdList)) liveSet(op.id, op.patch);
  }

  // The smallest frame that contains the point.
  function frameAt(p) {
    let best = null;
    for (const it of items.values()) {
      if (it.type === 'frame' && hasPoint(it, p) && (!best || area(it) < area(best))) best = it;
    }
    return best;
  }

  // Copies items under fresh ids, keeping frame and drawing links between the copies.
  function reid(list) {
    const map = new Map(list.map((it) => [it.id, uid()]));
    return list.map((it) => {
      const c = { ...it, id: map.get(it.id) };
      for (const key of ['fid', 'pid']) {
        if (!c[key]) continue;
        if (map.has(c[key])) c[key] = map.get(c[key]);
        else delete c[key];
      }
      return c;
    });
  }

  // The smallest frame that has at least half of the item over it.
  function frameHolding(it) {
    let best = null;
    for (const fr of items.values()) {
      if (fr.type === 'frame' && halfIn(it, fr) && (!best || area(fr) < area(best))) best = fr;
    }
    return best;
  }

  // Loose items that land inside a frame become part of it.
  function autoJoin(list) {
    for (const it of list) {
      if (it.type === 'frame' || it.type === 'block' || it.type === 'stroke' || it.pid || it.fid) continue;
      const f = frameHolding(it);
      if (f) it.fid = f.id;
    }
  }

  function addOps(list) {
    autoJoin(list);
    return [
      ...list.map((item) => ({ t: 'add', item })),
      ...refitOps(list.map((it) => it.fid).filter(Boolean), { extra: list }),
    ];
  }

  function delOps(ids) {
    const all = new Set(ids);
    for (const it of items.values()) if (it.pid && all.has(it.pid)) all.add(it.id);
    const frames = [...all].map((id) => items.get(id)).filter((it) => it && it.fid).map((it) => it.fid);
    return [{ t: 'del', ids: [...all] }, ...refitOps(frames, { excl: all })];
  }

  // Runs live edits and records everything they changed as one undo step.
  function transact(fn) {
    flushLive();
    const snap = snapshot(items.keys());
    fn();
    recordSince(snap);
  }

  // Claims the loose items inside a frame's outline and releases members that are now outside it.
  function adoptInside(frameId) {
    const f = items.get(frameId);
    for (const it of items.values()) {
      if (it.type === 'frame' || it.type === 'block' || it.type === 'stroke' || it.pid) continue;
      const inside = halfIn(it, f);
      const cur = frameOf(it);
      if (cur && cur.id === frameId && !inside) liveSet(it.id, { fid: null });
      else if (!cur && inside) liveSet(it.id, { fid: frameId });
    }
  }

  function toggleAutoFit() {
    const f = sel.size === 1 ? items.get([...sel][0]) : null;
    if (!f || f.type !== 'frame') return;
    if (f.auto === false) {
      transact(() => {
        liveSet(f.id, { auto: true });
        adoptInside(f.id);
        refitLive([f.id]);
      });
    } else {
      exec([{ t: 'set', id: f.id, patch: { auto: false } }]);
    }
  }

  // Where each frame's own area is while its dragged members are away: the outline of the
  // members that stay, or the frame as it was when none do.
  function restRects(moving, dragSet) {
    const rest = new Map();
    for (const f of items.values()) {
      if (f.type !== 'frame' || moving.has(f.id)) continue;
      const home = { x: f.x, y: f.y, w: f.w, h: f.h };
      let r = home;
      if (f.auto !== false) {
        const others = membersOf(f.id, { excl: dragSet });
        if (others.length) r = hugRect(others);
      }
      rest.set(f.id, { r, home });
    }
    return rest;
  }

  // Dropping an item onto a frame adds it; dragging it well clear of the frame takes it out.
  function updateFrameMembership(g) {
    if (!g.rest.size || !g.items.length) return;
    const touched = new Set();
    for (const id of g.items) {
      const it = items.get(id);
      const b = bounds(it);
      const cur = frameOf(it);
      const curId = cur && g.rest.has(cur.id) ? cur.id : null;
      // The frame grows to take an item in, so bringing one close is enough to join; leaving
      // takes a deliberate pull, about half the item's own size clear of what stays.
      const joinGap = 80 / cam.z;
      const leaveGap = Math.max(160 / cam.z, 0.5 * Math.max(b.w, b.h));
      let next = null;
      if (curId && rectGap(b, g.rest.get(curId).r) <= leaveGap) {
        next = curId;
      } else {
        let best = Infinity;
        for (const [fid, { r }] of g.rest) {
          const gap = rectGap(b, r);
          if (gap <= joinGap && gap < best) {
            best = gap;
            next = fid;
          }
        }
      }
      if (next !== curId) {
        liveSet(id, { fid: next });
        updateFrameCounts();
      }
      if (curId) touched.add(curId);
      if (next) touched.add(next);
    }
    for (const fid of touched) {
      const f = items.get(fid);
      if (!f || f.auto === false) continue;
      const members = membersOf(fid);
      const r = members.length ? hugRect(members) : g.rest.get(fid).home;
      if (rectDiffers(f, r)) liveSet(fid, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
  }

  // A drawing attaches to whatever it touches, even slightly, and only floats free when it is
  // clear of everything. Content outranks a frame (a mark on an image that sits in a frame follows the
  // image), and between two pieces of content it goes with the one it crosses most.
  function hostFor(drawing) {
    const pts = drawing.pts;
    const n = pts.length / 2;
    const at = (i) => ({ x: drawing.x + pts[i * 2] * drawing.w, y: drawing.y + pts[i * 2 + 1] * drawing.h });
    // Walk along the line in small steps so a long stroke is judged by its whole length.
    const samples = [at(0)];
    for (let i = 0; i < n - 1; i++) {
      const p = at(i);
      const q = at(i + 1);
      const steps = clamp(Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 4), 1, 80);
      for (let k = 1; k <= steps; k++) samples.push({ x: p.x + ((q.x - p.x) * k) / steps, y: p.y + ((q.y - p.y) * k) / steps });
    }
    const reach = (drawing.size || 0) / 2;
    let best = null;
    let bestTier = -1;
    let bestHits = 0;
    for (const it of items.values()) {
      if (it.type === 'stroke' || it.id === drawing.id || !selectable(it)) continue;
      const zone = grow(bounds(it), reach);
      let hits = 0;
      for (const s of samples) if (hasPoint(zone, s)) hits++;
      if (!hits) continue;
      const tier = it.type === 'frame' ? 0 : 1;
      if (tier > bestTier || (tier === bestTier && (hits > bestHits || (hits === bestHits && (it.z || 0) > (best.z || 0))))) {
        best = it;
        bestTier = tier;
        bestHits = hits;
      }
    }
    return best;
  }

  // Makes a frame (gathering loose pieces inside it) or a colour block covering `r`, and starts
  // naming it. Shared by drawing one out with the tool and dropping one from the toolbar.
  function makeFrameLike(kind, r) {
    if (kind === 'block') {
      const block = { id: uid(), type: 'block', x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h), text: '', color: BLOCK_COLORS[0], fs: BLOCK_FS, align: 'center', z: topZ() + 1 };
      exec(addOps([block]));
      setTool('select');
      setSel([block.id]);
      startEdit(block.id);
      return;
    }
    // A frame drawn around loose pieces gathers them, and the frame closes in on them.
    const gathered = [...items.values()].filter((it) => it.type !== 'frame' && it.type !== 'block' && it.type !== 'stroke' && !it.pid && !frameOf(it) && selectable(it) && halfIn(it, r));
    const hug = hugRect(gathered);
    const box = hug || r;
    const item = { id: uid(), type: 'frame', x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), title: '', color: FRAME_COLORS[0], z: 0, auto: true };
    exec([{ t: 'add', item }, ...gathered.map((it) => ({ t: 'set', id: it.id, patch: { fid: item.id } }))]);
    setTool('select');
    setSel([item.id]);
    startEdit(item.id);
  }

  // Drawings made before they could attach are matched up once, the first time a board is opened.
  function attachLegacyStrokes() {
    for (const st of items.values()) {
      if (st.type !== 'stroke' || st.pid !== undefined) continue;
      const host = hostFor(st);
      liveSet(st.id, { pid: host ? host.id : null });
    }
  }

  // The small line under a frame's title counts what is in it.
  function updateFrameCounts() {
    const n = new Map();
    for (const it of items.values()) if (it.fid && it.type !== 'frame' && it.type !== 'block' && it.type !== 'stroke') n.set(it.fid, (n.get(it.fid) || 0) + 1);
    for (const it of items.values()) {
      if (it.type !== 'frame') continue;
      const sub = els.get(it.id) && els.get(it.id).querySelector('.frame-sub');
      if (!sub) continue;
      const c = n.get(it.id) || 0;
      sub.textContent = c ? `${c} ${c === 1 ? 'item' : 'items'}` : 'Empty';
    }
  }

  // With items selected the frame button wraps them; otherwise it is the draw-a-frame tool.
  function frameSelection() {
    if (focusId) return false;
    const members = [...sel].map((id) => items.get(id)).filter((it) => it && it.type !== 'frame' && it.type !== 'block' && it.type !== 'stroke' && !it.pid);
    if (!members.length) return false;
    const previous = members.map((it) => it.fid).filter(Boolean);
    const box = hugRect(members);
    const item = { id: uid(), type: 'frame', x: box.x, y: box.y, w: box.w, h: box.h, title: '', color: FRAME_COLORS[0], z: 0, auto: true };
    exec([{ t: 'add', item }, ...members.map((it) => ({ t: 'set', id: it.id, patch: { fid: item.id } }))]);
    refitLive(previous);
    setSel([item.id]);
    startEdit(item.id);
    return true;
  }

  function activateFrame() {
    if (!frameSelection()) setTool('frame');
  }

  // ---- smart snapping

  const guidePath = $('guidepath');

  function toggleSnap() {
    snapOn = !snapOn;
    store('wb:snap', snapOn);
    $('snap').classList.toggle('active', snapOn);
    if (!snapOn) clearGuides();
    toast(snapOn ? 'Snapping on' : 'Snapping off', { ms: 1200 });
  }

  // Snapping follows the hierarchy of the board: a frame lines up with other frames before it looks at
  // blocks or content, a block with other blocks before frames, content with other content first.
  const snapKind = (it) => (it.type === 'frame' ? 'frame' : it.type === 'block' ? 'block' : 'content');

  function snapOrder(ids) {
    const kinds = new Set([...ids].map((id) => items.get(id)).filter((it) => it && it.type !== 'stroke').map(snapKind));
    if (kinds.has('frame')) return ['frame', 'block', 'content'];
    if (kinds.has('block')) return ['block', 'frame', 'content'];
    return ['content', 'block', 'frame'];
  }

  function snapTargets(exclude) {
    const view = grow(viewRect(), 400 / cam.z);
    // The frame that wraps the pieces being moved follows them, so its edges are no use as a guide;
    // every other frame, auto-fit or not, is something to line up with.
    const ownFrames = new Set([...exclude].map((id) => items.get(id) && items.get(id).fid).filter(Boolean));
    const out = [];
    for (const it of items.values()) {
      if (exclude.has(it.id) || it.type === 'stroke' || !selectable(it)) continue;
      if (it.type === 'frame' && ownFrames.has(it.id)) continue;
      const b = bounds(it);
      if (intersects(view, b)) out.push({ ...b, kind: snapKind(it) });
    }
    return out;
  }

  const spanOverlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0;
  const spanMid = (a0, a1, b0, b1) => (Math.max(a0, b0) + Math.min(a1, b1)) / 2;

  // Nearest alignment or equal-spacing position along one axis. Rects arrive as
  // { p, s, q, c }: position and size along the axis, position and size across it.
  function snapAxis(m, ts, thr, spacing) {
    const cands = [];
    const lines = (t) => [t.p, t.p + t.s / 2, t.p + t.s];
    const mLines = lines(m);
    const across = (a, b) => spanMid(a.q, a.q + a.c, b.q, b.q + b.c);
    const seg = (p0, p1, q) => ({ p0, p1, q });
    for (const t of ts) {
      for (const a of lines(t)) {
        for (const b of mLines) {
          const d = a - b;
          if (Math.abs(d) <= thr) cands.push({ d, draw: (f) => [{ p: a, q0: Math.min(f.q, t.q), q1: Math.max(f.q + f.c, t.q + t.c) }] });
        }
      }
    }
    if (spacing && ts.length <= 120) {
      for (const A of ts) {
        for (const B of ts) {
          const gap = B.p - (A.p + A.s);
          if (A === B || gap < 1 || !spanOverlap(A.q, A.q + A.c, B.q, B.q + B.c)) continue;
          const ab = seg(A.p + A.s, B.p, across(A, B));
          const nearA = spanOverlap(m.q, m.q + m.c, A.q, A.q + A.c);
          const nearB = spanOverlap(m.q, m.q + m.c, B.q, B.q + B.c);
          let d = B.p + B.s + gap - m.p;
          if (nearB && Math.abs(d) <= thr) cands.push({ d, draw: (f) => [ab, seg(B.p + B.s, f.p, across(B, f))] });
          d = A.p - gap - m.s - m.p;
          if (nearA && Math.abs(d) <= thr) cands.push({ d, draw: (f) => [ab, seg(f.p + f.s, A.p, across(f, A))] });
          d = A.p + A.s + (gap - m.s) / 2 - m.p;
          if (nearA && nearB && gap > m.s && Math.abs(d) <= thr) {
            cands.push({ d, draw: (f) => [seg(A.p + A.s, f.p, across(A, f)), seg(f.p + f.s, B.p, across(f, B))] });
          }
        }
      }
    }
    if (!cands.length) return null;
    let d = 0;
    let best = Infinity;
    for (const c of cands) {
      if (Math.abs(c.d) < best) {
        best = Math.abs(c.d);
        d = c.d;
      }
    }
    const fin = { ...m, p: m.p + d };
    return { d, guides: cands.filter((c) => Math.abs(c.d - d) < 0.01).flatMap((c) => c.draw(fin)) };
  }

  // Nudges a rect onto nearby edges, centres and equal gaps. Returns the offset and what to draw.
  function snapMove(r, targets, spacing = true, order = ['content', 'block', 'frame']) {
    const thr = SNAP_PX / cam.z;
    const ax = (t) => ({ p: t.x, s: t.w, q: t.y, c: t.h });
    const ay = (t) => ({ p: t.y, s: t.h, q: t.x, c: t.w });
    // Each axis takes the first kind in priority order that has anything to snap to.
    const groups = order.map((kind) => targets.filter((t) => t.kind === kind)).filter((g) => g.length);
    const first = (axis, convert) => {
      for (const g of groups) {
        const found = snapAxis(convert(r), g.map(convert), thr, spacing);
        if (found) return found;
      }
      return null;
    };
    const sx = first('x', ax);
    const sy = first('y', ay);
    const guides = [];
    for (const g of sx ? sx.guides : []) {
      guides.push('q0' in g ? { x1: g.p, y1: g.q0, x2: g.p, y2: g.q1 } : { x1: g.p0, y1: g.q, x2: g.p1, y2: g.q, gap: true });
    }
    for (const g of sy ? sy.guides : []) {
      guides.push('q0' in g ? { x1: g.q0, y1: g.p, x2: g.q1, y2: g.p } : { x1: g.q, y1: g.p0, x2: g.q, y2: g.p1, gap: true });
    }
    return { dx: sx ? sx.d : 0, dy: sy ? sy.d : 0, guides };
  }

  function drawGuides(list) {
    let d = '';
    for (const g of list) {
      const a = w2s(g.x1, g.y1);
      const b = w2s(g.x2, g.y2);
      d += `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
      if (!g.gap) continue;
      d += g.y1 === g.y2
        ? `M${a.x.toFixed(1)} ${(a.y - 5).toFixed(1)}v10M${b.x.toFixed(1)} ${(b.y - 5).toFixed(1)}v10`
        : `M${(a.x - 5).toFixed(1)} ${a.y.toFixed(1)}h10M${(b.x - 5).toFixed(1)} ${b.y.toFixed(1)}h10`;
    }
    guidePath.setAttribute('d', d);
  }

  function clearGuides() {
    guidePath.setAttribute('d', '');
  }

  // ---- opening an image to draw on it

  function enterFocus(id) {
    const it = items.get(id);
    if (!it || (it.type !== 'image' && it.type !== 'video')) return;
    finishEdit();
    if (!focusId) focusReturn = { x: cam.x, y: cam.y, z: cam.z };
    focusId = id;
    document.body.classList.add('focus');
    $('focusname').textContent = it.name || 'Image';
    $('focusbar').hidden = false;
    for (const [nid, node] of els) node.classList.toggle('dim', nid !== id && items.get(nid).pid !== id);
    $('focushint').textContent = it.type === 'image' ? 'Draw to annotate' : 'Pick a tool to annotate';
    userMovedView();
    // A video starts on the select tool so its play button still works.
    setTool(it.type === 'image' ? 'pen' : 'select');
    if (it.type === 'video') setSel([id]);
    fitRect(bounds(it), { inset: { t: 100, r: 48, b: presenting ? 96 : 56, l: presenting ? 48 : 100 }, dur: 520 });
  }

  function exitFocus() {
    if (!focusId) return;
    focusId = null;
    document.body.classList.remove('focus');
    $('focusbar').hidden = true;
    for (const node of els.values()) node.classList.remove('dim');
    if (tool === 'pen' || tool === 'arrow') setTool('select');
    if (focusReturn) {
      animateCam(focusReturn, 520);
      focusReturn = null;
    }
  }

  function clearDrawing() {
    const ids = [...items.values()].filter((it) => it.pid === focusId).map((it) => it.id);
    if (ids.length) exec([{ t: 'del', ids }]);
  }

  function setLevel(lvl) {
    const ops = [];
    for (const id of sel) {
      const it = items.get(id);
      if (it && it.type === 'text') {
        ops.push({ t: 'set', id, patch: { lvl, fs: round(it.fs * (levelSize(lvl) / levelSize(it.lvl ?? 2))) } });
      }
    }
    if (!ops.length) return;
    exec(ops);
    refitLive(ops.map((op) => items.get(op.id).fid).filter(Boolean));
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
    node.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    node.oninput = () => {
      liveSet(id, { [key]: node.innerText.replace(/\n$/, '') });
      if (it.fid) refitLive([it.fid]);
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
    if (it.type !== 'frame' && it.type !== 'block' && !after.trim()) {
      // An emptied note is removed; undo restores it with the text it had.
      it[key] = before;
      exec(delOps([id]), !isNew);
      return;
    }
    if (isNew) pushUndo([{ t: 'del', ids: [id] }]);
    else if (after !== before) pushUndo([{ t: 'set', id, patch: { [key]: before } }]);
    renderItem(it);
    if (it.fid) refitLive([it.fid]);
    updateOverlay();
  }

  function createTextItem(type, p, text = '') {
    const base = { id: uid(), type, x: round(p.x), y: round(p.y), text, z: topZ() + 1 };
    const frame = frameAt(p);
    if (frame) base.fid = frame.id;
    const item = type === 'note'
      ? { ...base, w: NOTE_W, h: 0, fs: NOTE_FS, color: NOTE_FILLS[0] }
      : { ...base, fs: levelSize(textPref.lvl), lvl: textPref.lvl, color: INK[0] };
    if (text) {
      exec(addOps([item]));
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

  // Files go up in pieces, in order. Hosting front ends cap the size of a request (Cloud Run allows
  // about 32 MB), so nothing larger than a piece is ever sent at once; the server joins them when the
  // last one lands. A dropped piece is retried instead of restarting the file.
  const UPLOAD_PIECE = 8 * 1024 * 1024;

  function sendPiece(piece, query, onSent) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?${query}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded); };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // fall through to the generic error
        }
        if (xhr.status === 200) resolve(data);
        else reject(Object.assign(new Error(data.error || 'Upload failed'), { fatal: xhr.status < 500 }));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(piece);
    });
  }

  async function upload(blob, ext, onProgress) {
    const id = uid();
    let offset = 0;
    let result = {};
    do {
      const end = Math.min(blob.size, offset + UPLOAD_PIECE);
      const query = `name=file${ext}&uid=${id}&offset=${offset}&done=${end >= blob.size ? 1 : 0}`;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await sendPiece(blob.slice(offset, end), query, (sent) => {
            if (onProgress) onProgress((offset + sent) / Math.max(1, blob.size));
          });
          break;
        } catch (err) {
          if (err.fatal || attempt >= 3) throw err;
          await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        }
      }
      offset = end;
    } while (offset < blob.size);
    return result;
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

  // Heavy video is re-encoded here, on the uploader's own machine, before it goes anywhere: H.264 in an
  // MP4, at most 1080p, about 8 Mbps, audio kept. Light files go up untouched (encoding twice only loses
  // quality), and anything this browser cannot decode or encode falls back to uploading as it is.
  const VIDEO_BITRATE = 8e6;
  const VIDEO_LIGHT_BITRATE = 12e6;
  const VIDEO_SMALL = 40 * 1024 * 1024;
  const VIDEO_LONG_SIDE = 1920;
  const VIDEO_SHORT_SIDE = 1080;
  let mediabunny;

  const fmtSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

  async function optimiseVideo(file, report, note) {
    if (file.size < VIDEO_SMALL) return file;
    let mb;
    try {
      mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
    } catch {
      return file;
    }
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return file;
      const w = track.displayWidth;
      const h = track.displayHeight;
      const duration = await input.computeDuration();
      const bitrate = duration > 0 ? (file.size * 8) / duration : 0;
      const oversized = Math.max(w, h) > VIDEO_LONG_SIDE || Math.min(w, h) > VIDEO_SHORT_SIDE;
      if (!oversized && bitrate <= VIDEO_LIGHT_BITRATE) return file;

      // Fit inside 1920x1080 (or 1080x1920), keeping the shape; encoders want even sizes.
      const k = Math.min(1, VIDEO_LONG_SIDE / Math.max(w, h), VIDEO_SHORT_SIDE / Math.min(w, h));
      const width = Math.max(2, Math.round((w * k) / 2) * 2);
      const height = Math.max(2, Math.round((h * k) / 2) * 2);
      const target = Math.min(VIDEO_BITRATE, bitrate || VIDEO_BITRATE);
      if (!(await mb.canEncodeVideo('avc', { width, height, bitrate: target }))) {
        note('This browser cannot compress video, so it is uploaded as it is.');
        return file;
      }

      const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
      const conversion = await mb.Conversion.init({ input, output, video: { codec: 'avc', width, height, fit: 'contain', bitrate: target } });
      if (!conversion.isValid) return file;
      conversion.onProgress = (p) => report(p);
      await conversion.execute();

      const out = new File([output.target.buffer], `${file.name.replace(/\.[^.]+$/, '')}.mp4`, { type: 'video/mp4' });
      if (out.size >= file.size) return file;
      note(`Video compressed from ${fmtSize(file.size)} to ${fmtSize(out.size)}.`);
      return out;
    } catch (err) {
      console.warn('Video compression failed, uploading the original:', err);
      note('Could not compress this video, so it is uploaded as it is.');
      return file;
    } finally {
      input.dispose();
    }
  }

  async function ingest(file, onProgress, { original = false, onPhase = () => {}, note = () => {} } = {}) {
    const ext = fileExt(file);
    const url = URL.createObjectURL(file);
    try {
      if (VID_EXT.test(ext)) {
        const prepared = original ? file : await optimiseVideo(file, onPhase, note);
        const preparedUrl = prepared === file ? url : URL.createObjectURL(prepared);
        try {
          const { w, h } = await probeVideo(preparedUrl);
          const up = await upload(prepared, fileExt(prepared), onProgress);
          return { type: 'video', src: up.url, nw: w, nh: h, name: file.name };
        } finally {
          if (preparedUrl !== url) URL.revokeObjectURL(preparedUrl);
        }
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

  // Lays new media out in rows starting at `at`. Everything comes in at the same width.
  function placeMedia(made, at) {
    const gap = 24;
    const maxRow = clamp((vp.clientWidth * 0.9) / cam.z, IMG_W, 4 * (IMG_W + gap));
    let z = topZ();
    let x = 0;
    let y = 0;
    let tallest = 0;
    const list = made.map((m) => {
      let w = IMG_W;
      let h = IMG_W * (m.nh / m.nw);
      if (h > IMG_MAX_H) {
        h = IMG_MAX_H;
        w = h * (m.nw / m.nh);
      }
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
    exec(addOps(list));
    setSel(list.map((item) => item.id));
  }

  // Hold Shift while dropping to upload video exactly as it is, without compressing it first.
  async function addFiles(fileList, at, { original = false } = {}) {
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
        made.push(await ingest(file, (k) => status.set(`${label} · ${Math.round(k * 100)}%`), {
          original,
          onPhase: (k) => status.set(`${files.length > 1 ? `File ${i + 1} of ${files.length}: ` : ''}Compressing video · ${Math.round(k * 100)}%`),
          note: (text) => toast(text, { ms: 6000 }),
        }));
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
    const clones = reid(list.filter((it) => it && typeof it.type === 'string'))
      .map((it) => ({ ...it, x: round(it.x + dx), y: round(it.y + dy), z: ++z }));
    exec(addOps(clones));
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

  // ---- eraser: right-drag while drawing removes every drawing the stroke touches

  const eraserRing = $('eraser');
  const ERASER_R = 12; // screen pixels

  function pointSegDist(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function segmentsCross(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
  }

  function segSegDist(a, b, c, d) {
    if (segmentsCross(a, b, c, d)) return 0;
    return Math.min(pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
  }

  // Does the eraser's path from a to b come within `reach` of the drawn line?
  function strokeTouched(it, a, b, reach) {
    const half = it.size / 2 + reach;
    if (Math.max(a.x, b.x) < it.x - half || Math.min(a.x, b.x) > it.x + it.w + half
      || Math.max(a.y, b.y) < it.y - half || Math.min(a.y, b.y) > it.y + it.h + half) return false;
    const n = it.pts.length / 2;
    const P = (i) => ({ x: it.x + it.pts[i * 2] * it.w, y: it.y + it.pts[i * 2 + 1] * it.h });
    if (n === 1) return pointSegDist(P(0), a, b) <= half;
    for (let i = 0; i < n - 1; i++) {
      if (segSegDist(a, b, P(i), P(i + 1)) <= half) return true;
    }
    return false;
  }

  function eraseSegment(g, a, b) {
    const reach = ERASER_R / cam.z;
    for (const it of items.values()) {
      if (it.type !== 'stroke' || g.hit.has(it.id) || !selectable(it)) continue;
      if (!strokeTouched(it, a, b, reach)) continue;
      g.hit.add(it.id);
      els.get(it.id).classList.add('erased');
    }
  }

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
    if (e.button === 2 && (tool === 'pen' || tool === 'arrow')) {
      const g = { type: 'erase', last: p, hit: new Set() };
      begin(g, e);
      eraserRing.hidden = false;
      eraserRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      eraseSegment(g, p, p);
      return;
    }
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
        begin({ type: 'move', p0: p, sx: e.clientX, sy: e.clientY, started: false, id, wasSelected, alt: e.altKey, playBtn: !!e.target.closest('.vplay') }, e);
      } else {
        const base = e.shiftKey ? new Set(sel) : new Set();
        if (!e.shiftKey) setSel([]);
        begin({ type: 'marquee', p0: p, base }, e);
      }
    } else if (tool === 'note' || tool === 'text') {
      createTextItem(tool, p);
      setTool('select');
    } else if (tool === 'frame' || tool === 'block') {
      begin({ type: 'frame', kind: tool, p0: p, p1: p }, e);
    } else if (tool === 'pen' || tool === 'arrow') {
      const arrow = tool === 'arrow';
      const size = pen.size;
      const path = svgEl('path', arrow
        ? { fill: 'none', stroke: inkColor(pen.color), 'stroke-width': size, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
        : { fill: inkColor(pen.color) });
      const svg = svgEl('svg', { class: 'drawing' });
      svg.append(path);
      inksLayer.append(svg);
      // Brush width follows pen pressure when there is any, otherwise how fast the stroke moves.
      const w0 = e.pointerType === 'pen' && e.pressure > 0 ? 0.25 + 0.75 * e.pressure : 0.5;
      const g = { type: 'draw', arrow, pts: [p.x, p.y], ws: [w0], lt: e.timeStamp, svg, path, size };
      begin(g, e);
      if (!arrow) path.setAttribute('d', outlinePath(g.pts, g.ws, 1, 1, size));
    }
  });

  function beginResize(h, e) {
    const r = selBounds();
    const ids = [...sel];
    // Drawings on a scaled image scale with it.
    for (const it of items.values()) if (it.pid && sel.has(it.pid)) ids.push(it.id);
    const single = sel.size === 1 ? items.get([...sel][0]) : null;
    // Frames and notes reshape freely; everything else keeps its proportions.
    const free = !!single && (single.type === 'frame' || single.type === 'note' || single.type === 'block') && !e.shiftKey;
    begin({
      type: 'resize', h, r, free, ids,
      single: single ? single.id : null,
      frameId: free && single.type === 'frame' ? single.id : null,
      ax: h.includes('w') ? r.x + r.w : r.x,
      ay: h.includes('n') ? r.y + r.h : r.y,
      snap: snapshot(items.keys()),
      targets: snapTargets(new Set(ids)),
      order: snapOrder(ids),
      rects: new Map(ids.map((id) => [id, bounds(items.get(id))])),
    }, e);
  }

  function dragMove(g, e, p) {
    if (!g.started) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4) return;
      g.started = true;
      g.snap = snapshot(items.keys());
      if (g.alt) {
        const { all, primary } = cloneItems([...sel], 0);
        const ops = all.map((item) => ({ t: 'add', item }));
        applyOps(ops);
        sendOps(ops);
        g.clones = all.map((c) => c.id);
        setSel(primary);
      }
      const moving = movingIds();
      g.moving = [...moving];
      g.start = new Map(g.moving.map((id) => [id, { x: items.get(id).x, y: items.get(id).y }]));
      const solid = g.moving.filter((id) => items.get(id).type !== 'stroke');
      g.box = (solid.length ? solid : g.moving).reduce((r, id) => union(r, bounds(items.get(id))), null);
      g.targets = snapTargets(moving);
      g.order = snapOrder(moving);
      // Loose items being dragged on their own may join or leave frames; frames' own contents just ride along.
      g.items = [...sel].filter((id) => {
        const it = items.get(id);
        return it.type !== 'frame' && it.type !== 'block' && it.type !== 'stroke' && !it.pid && !(it.fid && moving.has(it.fid));
      });
      g.rest = restRects(moving, new Set(g.items));
    }
    let dx = p.x - g.p0.x;
    let dy = p.y - g.p0.y;
    if (snapOn && !(e.ctrlKey || e.metaKey) && g.targets.length) {
      const s = snapMove({ x: g.box.x + dx, y: g.box.y + dy, w: g.box.w, h: g.box.h }, g.targets, true, g.order);
      dx += s.dx;
      dy += s.dy;
      drawGuides(s.guides);
    } else {
      clearGuides();
    }
    for (const id of g.moving) {
      const o = g.start.get(id);
      liveSet(id, { x: round(o.x + dx), y: round(o.y + dy) });
    }
    updateFrameMembership(g);
    updateOverlay();
  }

  function dragResize(g, p, e) {
    if (snapOn && !(e.ctrlKey || e.metaKey) && g.targets.length) {
      const s = snapMove({ x: p.x, y: p.y, w: 0, h: 0 }, g.targets, false, g.order);
      p = { x: p.x + s.dx, y: p.y + s.dy };
      drawGuides(s.guides);
    } else {
      clearGuides();
    }
    const west = g.h.includes('w');
    const north = g.h.includes('n');
    if (g.free) {
      const id = g.single;
      const min = 40 / cam.z;
      const w = Math.max(min, west ? g.ax - p.x : p.x - g.ax);
      const h = Math.max(min, north ? g.ay - p.y : p.y - g.ay);
      liveSet(id, { x: round(west ? g.ax - w : g.ax), y: round(north ? g.ay - h : g.ay), w: round(w), h: round(h) });
      if (items.get(id).fid) refitLive([items.get(id).fid]);
    } else {
      const sx = (west ? g.ax - p.x : p.x - g.ax) / g.r.w;
      const sy = (north ? g.ay - p.y : p.y - g.ay) / g.r.h;
      const s = Math.max(sx, sy, 16 / (Math.max(g.r.w, g.r.h) * cam.z));
      for (const id of g.ids) {
        const before = g.snap.get(id);
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
      refitLive(g.ids.map((id) => items.get(id).fid).filter(Boolean));
    }
    updateOverlay();
  }

  vp.addEventListener('pointermove', (e) => {
    pointer.sx = e.clientX;
    pointer.sy = e.clientY;
    pointer.inside = true;
    const p = s2w(e.clientX, e.clientY);
    sendP({ c: [round(p.x), round(p.y)] });
    if (tool === 'laser') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const q = s2w(ev.clientX, ev.clientY);
        addLaserPoint('me', me.color, q);
        laserOut.push(Math.round(q.x * 100) / 100, Math.round(q.y * 100) / 100);
      }
      scheduleLaserSend();
    }

    const g = gesture;
    if (!g || e.pointerId !== g.pid) return;
    if (g.type === 'erase') {
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of events.length ? events : [e]) {
        const q = s2w(ev.clientX, ev.clientY);
        eraseSegment(g, g.last, q);
        g.last = q;
      }
      eraserRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    } else if (g.type === 'pan') {
      setCam(g.cx - (e.clientX - g.sx) / cam.z, g.cy - (e.clientY - g.sy) / cam.z, cam.z);
    } else if (g.type === 'move') {
      dragMove(g, e, p);
    } else if (g.type === 'resize') {
      dragResize(g, p, e);
    } else if (g.type === 'marquee') {
      showMarquee(g.p0, p);
      const r = { x: Math.min(g.p0.x, p.x), y: Math.min(g.p0.y, p.y), w: Math.abs(p.x - g.p0.x), h: Math.abs(p.y - g.p0.y) };
      const ids = new Set(g.base);
      for (const it of items.values()) {
        if (!selectable(it)) continue;
        const b = bounds(it);
        if (it.type === 'frame' ? contains(r, b) : intersects(r, b)) ids.add(it.id);
      }
      for (const id of [...ids]) {
        const st = items.get(id);
        if (st && st.type === 'stroke' && st.pid && ids.has(st.pid)) ids.delete(id);
      }
      setSel(ids);
    } else if (g.type === 'frame') {
      g.p1 = p;
      showMarquee(g.p0, p);
    } else if (g.type === 'draw') {
      if (g.arrow) {
        g.pts = [g.pts[0], g.pts[1], p.x, p.y];
        g.path.setAttribute('d', pathData(g.pts, 1, 1, true, g.size));
      } else {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const q = s2w(ev.clientX, ev.clientY);
          const n = g.pts.length;
          const dist = Math.hypot(q.x - g.pts[n - 2], q.y - g.pts[n - 1]);
          if (dist < 1.5 / cam.z) continue;
          // Slow, deliberate strokes lay down more ink; quick flicks thin out.
          const speed = (dist * cam.z) / Math.max(1, ev.timeStamp - g.lt);
          const target = ev.pointerType === 'pen' && ev.pressure > 0
            ? 0.25 + 0.75 * ev.pressure
            : 0.18 + 0.82 * Math.exp(-speed * 0.45);
          g.ws.push(g.ws[g.ws.length - 1] * 0.6 + target * 0.4);
          g.pts.push(q.x, q.y);
          g.lt = ev.timeStamp;
        }
        g.path.setAttribute('d', outlinePath(g.pts, g.ws, 1, 1, g.size));
      }
    }
  });

  function endGesture(e) {
    const g = gesture;
    if (!g || (e && e.pointerId !== g.pid)) return;
    gesture = null;
    marquee.hidden = true;
    document.body.classList.remove('panning');

    if (g.type === 'erase') {
      eraserRing.hidden = true;
      // Everything the stroke touched goes in one undo step.
      if (g.hit.size) exec(delOps([...g.hit]));
    } else if (g.type === 'move') {
      clearGuides();
      if (!g.started) {
        if (g.playBtn) toggleVideo(g.id);
        else if (g.wasSelected && sel.size > 1) setSel([g.id]);
      } else if (g.clones) {
        recordSince(g.snap, [{ t: 'del', ids: g.clones }]);
      } else {
        for (const id of g.moving) {
          const st = items.get(id);
          if (!st || st.type !== 'stroke' || g.moving.includes(st.pid)) continue;
          const host = hostFor(st);
          const pid = host ? host.id : null;
          if (pid !== (st.pid ?? null)) liveSet(id, { pid });
        }
        recordSince(g.snap);
      }
    } else if (g.type === 'resize') {
      clearGuides();
      if (g.frameId) {
        // A frame sized by hand stops following its contents; what it holds follows its new outline.
        liveSet(g.frameId, { auto: false });
        adoptInside(g.frameId);
      }
      recordSince(g.snap);
    } else if (g.type === 'frame') {
      const isBlock = g.kind === 'block';
      const defW = isBlock ? BLOCK_W : FRAME_W;
      const defH = isBlock ? BLOCK_H : FRAME_H;
      let r = { x: Math.min(g.p0.x, g.p1.x), y: Math.min(g.p0.y, g.p1.y), w: Math.abs(g.p1.x - g.p0.x), h: Math.abs(g.p1.y - g.p0.y) };
      if (r.w < 24 / cam.z || r.h < 24 / cam.z) {
        r = { x: g.p0.x - defW / 2, y: g.p0.y - defH / 2, w: defW, h: defH };
      }
      makeFrameLike(g.kind, r);
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
        const item = { id: uid(), type: 'stroke', x: round(x0), y: round(y0), w: round(w), h: round(h), pts: norm, color: pen.color, size: round(g.size), arrow: g.arrow, z: topZ() + 1 };
        if (!g.arrow) {
          // The stroke ends in a flick: the last few points taper off.
          const ws = g.ws.slice();
          if (ws.length > 4) [0.8, 0.6, 0.4].forEach((k, i) => { ws[ws.length - 1 - i] *= k; });
          item.ws = ws.map((v) => Math.round(v * 100) / 100);
        }
        if (focusId) {
          item.pid = focusId;
        } else {
          const host = hostFor(item);
          item.pid = host ? host.id : null;
        }
        exec(addOps([item]));
      }
    }
    updateOverlay();
  }

  vp.addEventListener('pointerup', endGesture);
  vp.addEventListener('pointercancel', endGesture);
  vp.addEventListener('pointerleave', () => {
    pointer.inside = false;
    sendP({ c: null });
    requestLaser();
  });
  vp.addEventListener('contextmenu', (e) => e.preventDefault());
  // Focusing text that sits off-screen would scroll the canvas element itself; the camera is the only thing that moves.
  vp.addEventListener('scroll', () => {
    vp.scrollLeft = 0;
    vp.scrollTop = 0;
  });

  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    userMovedView();
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
  }, { passive: false });

  // The canvas holds the pointer while a button is down, so the event's target is the canvas
  // itself; the item has to be found from where the cursor is.
  vp.addEventListener('dblclick', (e) => {
    if (tool !== 'select' || editing) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const node = hit && hit.closest('.item');
    let it = node && items.get(node.dataset.id);
    if (it && it.type === 'stroke' && it.pid) it = items.get(it.pid);
    if (!it) return;
    if (it.type === 'note' || it.type === 'text' || it.type === 'block') startEdit(it.id);
    else if (it.type === 'frame') { if (hit.closest('.frame-head')) startEdit(it.id); }
    else if (it.type === 'video' || it.type === 'image') enterFocus(it.id);
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
    if (e.dataTransfer.files.length) return addFiles(e.dataTransfer.files, at, { original: e.shiftKey });
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
    e.clipboardData.setData('text/plain', JSON.stringify({ wipboard: 1, items: [...withDependents(sel)].map((id) => items.get(id)) }));
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
    ['pan', 'Pan. Or hold Space and drag (H)', ICON.pan],
    null,
    ['upload', 'Add images or video (or just drop or paste them)', ICON.upload],
    ['note', 'Note. Click, or drag it onto the board (N)', ICON.note],
    ['text', 'Heading or text. Pick the level, then click or drag it out (T)', ICON.text],
    ['block', 'Coloured heading block. Click, or drag it onto the board (B)', ICON.block],
    ['frame', 'Frame the selection, or draw or drag out a frame (F)', ICON.frame],
    null,
    ['pen', 'Draw. Right-drag to erase (P)', ICON.pen],
    ['arrow', 'Arrow (A)', ICON.arrow],
    ['laser', 'Laser pointer, visible to everyone (L)', ICON.laser],
  ];

  const TOOL_LABELS = { select: 'Select', pan: 'Pan', upload: 'Image', note: 'Note', text: 'Heading', block: 'Block', frame: 'Frame', pen: 'Draw', arrow: 'Arrow', laser: 'Laser' };

  // Drag a note, heading, block or frame out of the strip and drop it where you want it, instead of
  // choosing the tool and then clicking. A plain click on the tool still works as before.
  const DRAGGABLE_TOOLS = new Set(['note', 'text', 'block', 'frame']);
  let toolDrag = null;
  let suppressToolClick = false;

  function overBoard(x, y) {
    const t = document.elementFromPoint(x, y);
    return !!t && vp.contains(t);
  }

  function makeToolGhost(name) {
    const size = {
      note: [NOTE_W, NOTE_W * 0.45],
      text: [levelSize(textPref.lvl) * 4.5, levelSize(textPref.lvl) * 1.35],
      block: [BLOCK_W, BLOCK_H],
      frame: [FRAME_W, FRAME_H],
    }[name];
    // Shown at the size it will land at, kept to a sensible size on screen.
    const k = Math.min(cam.z, 520 / Math.max(...size));
    const ghost = el('div', { class: `tool-ghost ${name}`, text: TOOL_LABELS[name] });
    ghost.style.width = `${Math.max(48, size[0] * k)}px`;
    ghost.style.height = `${Math.max(28, size[1] * k)}px`;
    document.body.append(ghost);
    return ghost;
  }

  function endToolDrag() {
    if (toolDrag && toolDrag.ghost) toolDrag.ghost.remove();
    document.body.classList.remove('dragging-tool');
    toolDrag = null;
  }

  function dropTool(name, p) {
    setTool('select');
    if (name === 'note') createTextItem('note', { x: p.x - NOTE_W / 2, y: p.y - 28 });
    else if (name === 'text') createTextItem('text', { x: p.x - 40, y: p.y - 28 });
    else if (name === 'block') makeFrameLike('block', { x: p.x - BLOCK_W / 2, y: p.y - BLOCK_H / 2, w: BLOCK_W, h: BLOCK_H });
    else makeFrameLike('frame', { x: p.x - FRAME_W / 2, y: p.y - FRAME_H / 2, w: FRAME_W, h: FRAME_H });
  }

  $('toolbar').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn || e.button !== 0 || e.pointerType === 'touch' || focusId || !DRAGGABLE_TOOLS.has(btn.dataset.tool)) return;
    toolDrag = { tool: btn.dataset.tool, x0: e.clientX, y0: e.clientY, ghost: null };
  });
  window.addEventListener('pointermove', (e) => {
    if (!toolDrag) return;
    if (!toolDrag.ghost) {
      if (Math.hypot(e.clientX - toolDrag.x0, e.clientY - toolDrag.y0) < 6) return;
      toolDrag.ghost = makeToolGhost(toolDrag.tool);
      document.body.classList.add('dragging-tool');
    }
    toolDrag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
    toolDrag.ghost.classList.toggle('off', !overBoard(e.clientX, e.clientY));
  });
  window.addEventListener('pointerup', (e) => {
    if (!toolDrag) return;
    const drag = toolDrag;
    const dragged = !!drag.ghost;
    const drop = dragged && overBoard(e.clientX, e.clientY);
    endToolDrag();
    if (!dragged) return;
    suppressToolClick = true;
    setTimeout(() => { suppressToolClick = false; }, 0);
    if (drop) dropTool(drag.tool, s2w(e.clientX, e.clientY));
  });
  window.addEventListener('keydown', (e) => {
    if (toolDrag && e.key === 'Escape') {
      endToolDrag();
      e.stopPropagation();
    }
  }, true);

  function buildToolbar() {
    $('toolbar').replaceChildren(...TOOLS.map((t) => {
      if (!t) return el('span', { class: 'sep' });
      const [name, title, html] = t;
      return el('button', {
        class: 'iconbtn', 'data-tool': name, title, html,
        onclick: () => (suppressToolClick ? null : name === 'upload' ? $('filepick').click() : name === 'frame' ? activateFrame() : setTool(name)),
      }, el('span', { class: 'tl', text: TOOL_LABELS[name] }));
    }));
    $('back').innerHTML = ICON.boards;
    $('pprev').innerHTML = ICON.prev;
    $('pnext').innerHTML = ICON.next;
    buildToolOptions();
  }

  function buildToolOptions() {
    if (tool === 'text') {
      $('tooloptions').replaceChildren(...TEXT_LEVELS.map((l) => el('button', {
        class: `lvl${l.lvl === textPref.lvl ? ' active' : ''}`, title: l.title, text: l.label,
        onclick: () => { textPref.lvl = l.lvl; store('wb:text', textPref); buildToolOptions(); },
      })));
      return;
    }
    const savePen = () => {
      store('wb:pen', pen);
      buildToolOptions();
    };
    $('tooloptions').replaceChildren(
      ...INK.map((c) => el('button', {
        class: `swatch${c === pen.color ? ' active' : ''}`, style: { background: swatchColor(c) }, title: 'Ink colour',
        onclick: () => { pen.color = c; savePen(); },
      })),
      el('span', { class: 'sep' }),
      ...PEN_SIZES.map((s) => el('button', {
        class: `iconbtn${s === pen.size ? ' active' : ''}`, title: 'Line weight',
        onclick: () => { pen.size = s; savePen(); },
      }, el('i', { class: 'dot', style: { width: `${s + 3}px`, height: `${s + 3}px` } }))));
  }

  function setTool(name) {
    // While an image is open there is nothing to place notes or frames on.
    if (focusId && (name === 'note' || name === 'text' || name === 'frame' || name === 'block')) return;
    tool = name;
    document.body.dataset.tool = name;
    for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === name);
    $('tooloptions').hidden = name !== 'pen' && name !== 'arrow' && name !== 'text';
    buildToolOptions();
    $('plaser').classList.toggle('active', name === 'laser');
    if (name !== 'select') setSel([]);
    sendP({ l: name === 'laser' ? 1 : 0 });
    requestLaser();
  }

  const TOOL_KEYS = { v: 'select', h: 'pan', n: 'note', t: 'text', b: 'block', f: 'frame', p: 'pen', a: 'arrow', l: 'laser' };

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
      else if (k === 'a') { setTool('select'); setSel([...items.values()].filter((it) => selectable(it) && (focusId || !it.pid)).map((it) => it.id)); }
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
      if (k === 'escape') return void (focusId ? exitFocus() : stopPresenting());
      if (k === 'l') return void setTool(tool === 'laser' ? 'select' : 'laser');
    }

    const video = selectedVideo();
    if (e.shiftKey && e.code === 'Digit1') { userMovedView(); fitAll(); }
    else if (e.shiftKey && e.code === 'Digit2') { const r = selBounds(); if (r) { userMovedView(); fitRect(r); } }
    else if (k === 'home') { userMovedView(); fitAll(); }
    else if (k === '?') toggleHelp();
    else if (k === 's' && !e.shiftKey) toggleSnap();
    else if (k === 'f' && !e.shiftKey) activateFrame();
    else if (k === 'delete' || k === 'backspace') deleteSel();
    else if (k === 'escape') {
      if (!$('helppanel').hidden) toggleHelp();
      else if (focusId) exitFocus();
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
    ['Pan', 'Space + drag, or middle drag'],
    ['Zoom', 'Mouse wheel'],
    ['Fit everything / selection', 'Shift+1 / Shift+2'],
    ['Open an image or video and draw on it', 'Double-click it, Esc to close'],
    ['Smart snapping on / off', 'S, hold Ctrl to bypass'],
    ['Add media', 'Drop files, or paste from the clipboard'],
    ['Place a note, heading, block or frame', 'Drag it out of the tool strip'],
    ['Upload video without compressing', 'Hold Shift while dropping'],
    ['Note / Heading / Colour block', 'N / T / B'],
    ['Frame the selection, or draw a frame', 'F'],
    ['Change heading level', 'Select it, then H1 / H2 / H3 / Text'],
    ['Draw / Arrow / Laser', 'P / A / L'],
    ['Erase drawings', 'Right-drag while drawing'],
    ['Edit text', 'Double-click or Enter'],
    ['Duplicate', 'Ctrl+D, or Alt + drag'],
    ['Tidy into a grid (frames tidy as whole pieces)', 'Ctrl+P'],
    ['Bring to front / send to back', '] / [  or  PgUp / PgDn'],
    ['Scale a note with its text', 'Shift + drag a corner'],
    ['Play or pause video', 'Click the play button, or K'],
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
    const label = it && it.type !== 'frame' ? it.name || '' : '';
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
    requestLaser();
  }

  const trails = new Map();
  const laserCanvas = $('laser');
  const laserOut = [];
  let laserRaf = 0;
  let laserSend = 0;

  const laserActive = () => tool === 'laser' || trails.size > 0 || [...peers.values()].some((peer) => peer.p.l);

  function requestLaser() {
    if (!laserRaf) laserRaf = requestAnimationFrame(drawLaser);
  }

  function scheduleLaserSend() {
    if (laserSend) return;
    laserSend = setTimeout(() => {
      laserSend = 0;
      if (laserOut.length) wsSend({ t: 'laser', pts: laserOut.splice(0) });
    }, 25);
  }

  function addLaserPoint(key, color, p, t = performance.now()) {
    let trail = trails.get(key);
    if (!trail) trails.set(key, (trail = { color, pts: [] }));
    trail.pts.push({ x: p.x, y: p.y, t });
    requestLaser();
  }

  // A remote pointer's points arrive in batches; spread them over the interval they covered.
  function addRemoteLaser(peer, flat) {
    const n = flat.length / 2;
    const now = performance.now();
    for (let i = 0; i < n; i++) {
      addLaserPoint(peer.id, peer.color, { x: flat[i * 2], y: flat[i * 2 + 1] }, now - (n - 1 - i) * (25 / n));
    }
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
    ctx.lineJoin = 'round';
    const now = performance.now();
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    for (const [key, trail] of trails) {
      while (trail.pts.length && now - trail.pts[0].t > LASER_LIFE) trail.pts.shift();
      if (!trail.pts.length) {
        trails.delete(key);
        continue;
      }
      const P = trail.pts.map((q) => {
        const sp = w2s(q.x, q.y);
        return { x: sp.x, y: sp.y, k: Math.max(0, 1 - (now - q.t) / LASER_LIFE) };
      });
      ctx.strokeStyle = trail.color;
      ctx.shadowColor = trail.color;
      ctx.shadowBlur = 6;
      // Curves through the midpoints keep the trail smooth however sparse the samples are.
      for (let i = 1; i < P.length; i++) {
        const a = i === 1 ? P[0] : mid(P[i - 1], P[i]);
        const b = i === P.length - 1 ? P[i] : mid(P[i], P[i + 1]);
        ctx.globalAlpha = P[i].k;
        ctx.lineWidth = 1 + 2.2 * P[i].k;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(P[i].x, P[i].y, b.x, b.y);
        ctx.stroke();
      }
    }
    // The dot stays put while the pointer rests; only the trail fades.
    const heads = [];
    if (tool === 'laser' && pointer.inside) heads.push({ x: pointer.sx, y: pointer.sy, color: me.color });
    for (const peer of peers.values()) {
      if (!peer.p.l || !peer.p.c) continue;
      const sp = w2s(peer.p.c[0], peer.p.c[1]);
      heads.push({ x: sp.x, y: sp.y, color: peer.color });
    }
    ctx.globalAlpha = 1;
    for (const head of heads) {
      ctx.shadowColor = head.color;
      ctx.shadowBlur = 9;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = head.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(head.x, head.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
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
      // Frames made before they had headers close up around their contents again, headers included.
      refitLive(frameIds());
      attachLegacyStrokes();
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
        requestLaser();
      }
      if ('s' in msg.p) refreshPeerSel();
      if ('v' in msg.p && following === peer.id && !gesture) followView(peer.p.v);
    } else if (msg.t === 'laser') {
      const peer = peers.get(msg.id);
      if (peer) addRemoteLaser(peer, msg.pts);
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
  let meta;
  try {
    meta = await WB.api('GET', `/api/boards/${boardId}`);
  } catch {
    return fatal('This board does not exist.');
  }
  $('back').href = meta.folderId ? `/#/f/${meta.folderId}` : '/';
  $('themeslot').replaceWith(WB.themeButton());
  window.addEventListener('wb:theme', () => {
    for (const it of items.values()) renderItem(it);
    seltools.dataset.sig = '';
    buildToolOptions();
    updateOverlay();
  });
  $('snap').innerHTML = ICON.snap;
  $('snap').classList.toggle('active', snapOn);
  $('snap').addEventListener('click', toggleSnap);
  $('focusdone').addEventListener('click', exitFocus);
  $('focusclear').addEventListener('click', clearDrawing);
  buildToolbar();
  setTool('select');
  applyCam();
  connect();
})();
