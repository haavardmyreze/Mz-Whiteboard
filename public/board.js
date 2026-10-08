'use strict';

(async () => {
  const { el, store } = WB;
  const $ = (id) => document.getElementById(id);

  // /s/<secret> is a read-only link: anyone holding it can watch the board and nothing else.
  const viewOnly = location.pathname.startsWith('/s/');
  document.body.classList.toggle('viewonly', viewOnly);
  // What a link lets its holder do: 'view', also read comments ('comments'), or also comment ('comment').
  let shareAccess = 'view';
  const guestReads = () => viewOnly && shareAccess !== 'view';
  const guestWrites = () => viewOnly && shareAccess === 'comment';
  function setAccess(access) {
    shareAccess = access || 'view';
    document.body.classList.toggle('guest-reads', guestReads());
    document.body.classList.toggle('guest-writes', guestWrites());
  }
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
  const THUMB_MAX = 480;
  // A video's poster: big enough to look sharp filling the screen on a laptop, small enough to load at once.
  const POSTER_MAX = 1600;
  // Stills made here for videos whose own still is missing or came out black: video id -> picture.
  const fixedStill = new Map();
  const vetting = new Set();
  let vetQueue = Promise.resolve();
  // What a video looks and sounds like along its length: the colours of its picture and the loudness of its
  // sound, drawn behind the scrub bar. Made once per video by whoever opens it first, then kept with it.
  const WAVE_COLS = 512;
  const WAVE_BARS = 1024;
  const waveCache = new Map(); // src -> { c, p }
  const waving = new Set();
  let waveQueue = Promise.resolve();
  const LASER_LIFE = 450;
  const INK = ['ink', '#e5484d', '#f59e0b', '#16a34a', '#2f7df6', '#8b5cf6'];
  const NOTE_FILLS = ['note', '#fff2a8', '#ffd3d1', '#d4f1d2', '#d0e6ff', '#e7dbff'];
  // 'ink' and 'note' stand for the theme's own text and note colours, so a board reads well in either
  // theme. The literal greys and whites earlier versions stored are treated the same way.
  const isLight = () => document.documentElement.dataset.theme === 'light';
  const INK_DEFAULTS = new Set(['ink', '#f2f2f3', '#f5f5f6', '#1f1f23']);
  const NOTE_DEFAULTS = new Set(['note', '#2f2f33', '#2c2c31', '#ffffff']);
  const inkColor = (c) => (!c || INK_DEFAULTS.has(c) ? (isLight() ? '#171717' : '#ededed') : c);
  const isPlainNote = (c) => !c || NOTE_DEFAULTS.has(c);
  const noteColor = (c) => (isPlainNote(c) ? (isLight() ? '#ffffff' : '#2a2a2a') : c);
  const NOTE_INK = { light: '#1a1a1a', dark: '#f0f0f0' };

  // Colours are stored as they were picked and shown through OKLCH, where equal numbers look equally
  // light. Every block is set to one lightness, every frame header to another and every note to a
  // third, so a row of colours reads as one family, white headings are as legible on yellow as on
  // blue, and nothing shouts over the artwork. Only the hue, and how grey it is, comes from the
  // stored colour.
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const fromLinear = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  function oklchOf(hex) {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => toLinear(v / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
    return { l: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, c: Math.hypot(A, B), h: Math.atan2(B, A) };
  }
  function linearRgb(L, C, h) {
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }
  const toneCache = new Map();
  // The stored colour's hue at the given lightness, with its chroma capped. Greys keep to a range of
  // lightness instead, so black stays darker than grey.
  function tone(hex, L, maxC, grey) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return hex;
    const key = `${hex}|${L}|${maxC}|${grey}`;
    if (toneCache.has(key)) return toneCache.get(key);
    const from = oklchOf(hex);
    let l = L;
    let c = Math.min(from.c, maxC);
    let h = from.h;
    if (from.c < 0.03) {
      c = 0;
      l = Math.min(grey[1], Math.max(grey[0], from.l));
    } else if (L < 0.7 && h > 1.4 && h < 1.92) {
      // A yellow turned down this far goes olive; leaning it towards orange keeps it golden.
      h -= 0.19;
    }
    let rgb = linearRgb(l, c, h);
    // Step the chroma down until the colour fits in sRGB, rather than clipping it to a different hue.
    while (c > 0 && rgb.some((v) => v < -0.0005 || v > 1.0005)) {
      c = Math.max(0, c - 0.004);
      rgb = linearRgb(l, c, h);
    }
    const out = `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, v))))) * 255).toString(16).padStart(2, '0')).join('')}`;
    toneCache.set(key, out);
    return out;
  }
  // Heading blocks: mid-toned, so a white heading always reads.
  const mute = (hex) => (isLight() ? tone(hex, 0.57, 0.16, [0.22, 0.52]) : tone(hex, 0.53, 0.135, [0.27, 0.46]));
  // Frames sit a rung below blocks in the hierarchy: the same hues, set deeper.
  const deepen = (hex) => (isLight() ? tone(hex, 0.47, 0.13, [0.2, 0.42]) : tone(hex, 0.4, 0.1, [0.24, 0.36]));
  // Notes take the theme's side: pale paper with dark writing on light, a tinted slate with light
  // writing on dark, so a coloured note is no brighter than a plain one.
  const noteFill = (c) => (isPlainNote(c) ? noteColor(c) : isLight() ? tone(c, 0.94, 0.06, [0.9, 0.97]) : tone(c, 0.42, 0.075, [0.26, 0.4]));
  const swatchColor = (c) => (c === 'ink' ? inkColor(c) : c === 'note' ? noteColor(c) : c);
  // Vivid header colours for frames and the free-standing heading blocks.
  const BLOCK_COLORS = ['#ff6bd6', '#7ed957', '#4d7cff', '#ffd43b', '#ff9a3c', '#b388ff', '#2dd4bf', '#6b6b73', '#17171a'];
  const FRAME_COLORS = ['#8a8a93', ...BLOCK_COLORS];
  const PEN_SIZES = [4, 8, 16];
  const FRAME_PAD = 28;
  // World-unit sizes for new items: what you get does not depend on how far you are zoomed in.
  // Sized to what the standup board settled on: a still is about 750 wide, a frame holds one at 806.
  const IMG_W = 750;
  const IMG_MAX_H = 1080;
  const NOTE_W = 260;
  const NOTE_FS = 16;
  // A frame starts at the width it needs to hold one piece of media at its imported width, and a block
  // at the same width as a frame, since it usually sits above one as its header.
  const FRAME_W = IMG_W + 2 * FRAME_PAD;
  const FRAME_H = 750;
  // Every frame has a header band for its title and a count; blocks are free-standing coloured headings.
  const FRAME_HEAD = 80;
  const BLOCK_W = FRAME_W;
  const BLOCK_H = 180;
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
  const ITEM_TYPES = new Set(['image', 'video', 'note', 'text', 'frame', 'block', 'stroke']);
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
    comment: icon('<path d="M4 5h16v11H11l-5 4v-4H4z"/>'),
    check: icon('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
    fit: icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6"/>'),
    frameBack: icon('<path d="M18 5.5l-9 6.5 9 6.5z" fill="currentColor"/><path d="M6 5v14"/>'),
    frameFwd: icon('<path d="M6 5.5l9 6.5-9 6.5z" fill="currentColor"/><path d="M18 5v14"/>'),
  };
  const CURSOR_SVG = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1 1l4.5 13 2.2-5.3L13 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1"/></svg>';

  // ------------------------------------------------------------- state

  const items = new Map();       // id -> item; the shared document
  const comments = new Map();    // id -> comment; kept apart from items so they never take part in layout, snapping or fitting
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
  let following = null;
  let liveTimer = 0;
  let camAnim = 0;
  let camTimer = 0;
  let snapOn = store('wb:snap') !== false;
  let focusId = null;
  let focusReturn = null;
  let cmDirty = false;
  let penBeforeFocus = null;

  // ------------------------------------------------------------- helpers

  // Settles when the typeface text is measured in has arrived, or after two seconds without it.
  const typeface = document.fonts && document.fonts.load
    ? Promise.race([document.fonts.load('16px Inter'), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {})
    : Promise.resolve();

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round = (v) => Math.round(v * 10) / 10;
  // Somewhere text goes. A slider or a tick box is not: clicking one must not take the keyboard away from the board.
  const isTyping = (t) => t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)
    || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(t.type)));

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

  function toast(text, { sticky = false, ms = 4000 } = {}) {
    const node = el('div', { class: 'toast', text });
    $('toasts').append(node);
    const close = () => node.remove();
    if (!sticky) setTimeout(close, ms);
    return { set: (t) => { node.textContent = t; }, close };
  }

  // ------------------------------------------------------------- camera

  function applyCam() {
    if (focusId && !camEasing) keepOnFocus();
    world.style.transform = `translate(${-cam.x * cam.z}px, ${-cam.y * cam.z}px) scale(${cam.z})`;
    world.style.setProperty('--z', cam.z);
    world.style.setProperty('--inv', 1 / cam.z);
    // What sits on a piece at a size of its own (the chip that says it has comments) follows the zoom
    // within limits: close in it does not cover the piece, further out it stays large enough to read, and
    // only from very far away does it shrink away with everything else.
    world.style.setProperty('--chip', Math.min(clamp(0.55 + 0.6 * cam.z, 0.6, 1.2), cam.z * 5) / cam.z);
    let grid = 32 * cam.z;
    while (grid < 20) grid *= 4;
    vp.style.backgroundSize = `${grid}px ${grid}px`;
    vp.style.backgroundPosition = `${-cam.x * cam.z}px ${-cam.y * cam.z}px`;
    $('zoom').textContent = `${Math.round(cam.z * 100)}%`;
    if (focusId) showFocusZoom();
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
      // Not before the board has loaded and been framed: the view remembered from last time is still waiting to be read.
      // Nor while something is open in the viewer: what is remembered is where the board was left, not a close-up of one piece.
      if (!firstInit && !unframed && !focusId) store(`wb:cam:${boardId}`, { x: cam.x, y: cam.y, z: cam.z });
      checkRes();
    }, 200);
  }

  // True while the camera eases, so the clamp that keeps an open piece in view does not cut the move short.
  let camEasing = false;

  function stopCamAnim() {
    cancelAnimationFrame(camAnim);
    clearTimeout(camTimer);
    if (camEasing) {
      camEasing = false;
      if (focusId) applyCam();
    }
    coasting = false;
  }

  // Letting go of a pan while the board is still moving lets it run on a little and settle, rather
  // than stopping dead. The speed (screen pixels per millisecond) dies away over COAST_MS, so a
  // quick flick carries the view roughly its own speed times that far and a slow drag not at all.
  const COAST_MS = 65;
  let coasting = false;

  function coast(vx, vy) {
    const speed = Math.hypot(vx, vy);
    if (speed < 0.2 || calm.matches || document.hidden) return;
    // Nobody means to throw the board across the room.
    const cap = Math.min(1, 3.5 / speed);
    vx *= cap;
    vy *= cap;
    stopCamAnim();
    coasting = true;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(64, Math.max(0, now - last));
      last = now;
      const decay = Math.exp(-dt / COAST_MS);
      // The distance covered while the speed fell from where it was to where it is now.
      const travel = COAST_MS * (1 - decay);
      cam.x -= (vx * travel) / cam.z;
      cam.y -= (vy * travel) / cam.z;
      vx *= decay;
      vy *= decay;
      applyCam();
      if (Math.hypot(vx, vy) > 0.02) camAnim = requestAnimationFrame(tick);
      else coasting = false;
    };
    camAnim = requestAnimationFrame(tick);
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
    // target anyway so a follower who is not looking stays in step with the person they follow.
    camEasing = true;
    camTimer = setTimeout(() => {
      camEasing = false;
      setCam(to.x, to.y, to.z);
    }, dur + 150);
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
      else {
        clearTimeout(camTimer);
        camEasing = false;
        if (focusId) applyCam();
      }
    };
    camAnim = requestAnimationFrame(tick);
  }

  // Space kept clear of the floating chrome when framing something.
  function insets() {
    return vp.clientWidth < 700 ? { t: 64, r: 16, b: 84, l: 16 } : { t: 80, r: 32, b: 32, l: 110 };
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

  // The view a board opens on: where this browser left it, otherwise everything. A window that has no
  // size yet (opened minimised, or in a pane that is not showing) cannot be framed, so that waits
  // until it has one instead of settling on a speck in the corner and remembering it.
  let unframed = false;
  function frameFirst() {
    unframed = !vp.clientWidth || !vp.clientHeight;
    if (unframed) return;
    const saved = store(`wb:cam:${boardId}`);
    if (saved && isFinite(saved.x) && isFinite(saved.y) && saved.z > 0) setCam(saved.x, saved.y, saved.z);
    else fitAll(0);
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
    // The slider is for the pointer only. Left holding the keyboard after a click, it would turn the arrow
    // keys into a scrub and keep them from the board.
    const seek = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, tabindex: -1, 'aria-label': 'Seek' });
    // Where the video's comments and frame drawings are; filled in by placeMarks.
    const marks = el('div', { class: 'vmarks' });
    const time = el('button', { class: 'vtime', text: '0:00', title: 'Show minutes and seconds, frame number or timecode', onclick: cycleTimeMode });
    const sound = el('button', { class: 'vbtn', html: ICON.muted, title: 'Sound on / off (M)', onclick: () => { video.muted = !video.muted; } });
    video.addEventListener('volumechange', () => {
      sound.innerHTML = video.muted ? ICON.muted : ICON.sound;
      if (focusId === it.id) syncTimeline();
    });
    const tick = (at = video.currentTime) => {
      if (video.duration && !seek.matches(':active')) seek.value = Math.round((at / video.duration) * 1000);
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      if (seek.parentNode) seek.parentNode.style.setProperty('--p', `${seek.value / 10}%`);
      time.textContent = timeLabel(at, video.duration, fpsOf(it.id));
      if (focusId === it.id) syncTimeline(at);
    };
    video.wbTick = tick;
    seek.addEventListener('input', () => {
      if (!video.duration) return;
      video.currentTime = wholeFrame(it.id, (seek.value / 1000) * video.duration);
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      if (seek.parentNode) seek.parentNode.style.setProperty('--p', `${seek.value / 10}%`);
      sendMedia(it.id);
    });
    seek.addEventListener('change', () => seek.blur());
    for (const type of ['progress', 'suspend', 'loadedmetadata', 'seeked']) {
      video.addEventListener(type, () => {
        if (focusId === it.id) syncLoaded();
      });
    }
    video.addEventListener('timeupdate', () => tick());
    video.addEventListener('loadedmetadata', () => {
      tick();
      queueMarks();
      // Drawings that arrived before their video could not tell which frame it was on.
      refreshAnnotations(it.id);
    });
    // While it plays the counter follows each frame as it is shown, where the browser says which that is.
    const onFrame = (now, meta) => {
      tick(meta.mediaTime);
      if (!video.paused) video.requestVideoFrameCallback(onFrame);
    };
    video.addEventListener('seeked', () => {
      tick();
      // What was drawn for a comment shows on the frame the comment is about.
      refreshAnnotations(it.id);
    });
    // Clicks on the big button are handled by the pointer gesture so the video can still be dragged by it.
    const center = el('div', { class: 'vplay', html: ICON.play, 'aria-hidden': 'true' });
    for (const type of ['play', 'pause']) {
      video.addEventListener(type, () => {
        play.innerHTML = video.paused ? ICON.play : ICON.pause;
        center.innerHTML = video.paused ? ICON.play : ICON.pause;
        node.classList.toggle('playing', !video.paused);
        refreshAnnotations(it.id);
        if (focusId === it.id) syncTimeline();
        if (!video.paused && video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
      });
    }
    // The still the video was filed with stays over it until it is played or scrubbed, so what shows is
    // never the bare first frame, or nothing at all while it loads.
    const post = el('img', { class: 'vpost', alt: '', draggable: 'false', decoding: 'async' });
    for (const type of ['play', 'seeking']) video.addEventListener(type, () => { if (type === 'play' || video.currentTime > 0.05) node.classList.add('started'); });
    node.append(video, post, center, el('div', { class: 'vbar' }, play, el('div', { class: 'vseek' }, el('canvas', { class: 'vwave', width: WAVE_W, height: WAVE_H }), seek, marks), time, sound));
  }

  function createNode(it) {
    const node = el('div', { class: `item ${it.type}`, 'data-id': it.id });
    if (it.type === 'image') {
      node.append(el('img', { alt: it.name || '', draggable: 'false', decoding: 'async' }));
    } else if (it.type === 'video') {
      buildVideo(it, node);
    } else if (it.type === 'upload') {
      buildUpload(node);
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
    if (it.pid && (it.cid || it.fr != null)) markAnnotation(it, node);

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
      const still = fixedStill.get(it.id) || it.poster || it.th;
      vetStill(it);
      applyWave(it, node);
      if (still && video.getAttribute('poster') !== still) video.poster = still;
      const post = node.querySelector('.vpost');
      if (post && post.dataset.src !== (still || '')) {
        post.dataset.src = still || '';
        if (still) post.src = still;
        else post.removeAttribute('src');
        post.hidden = !still;
      }
      if (video.dataset.src !== it.src) {
        video.dataset.src = it.src;
        delete video.dataset.whole;
        video.src = it.src;
      }
    } else if (it.type === 'upload') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      paintUpload(node, it);
    } else if (it.type === 'note') {
      st.width = `${it.w}px`;
      st.minHeight = `${it.h || 0}px`;
      st.fontSize = `${it.fs}px`;
      st.background = noteFill(it.color);
      st.color = isLight() ? NOTE_INK.light : NOTE_INK.dark;
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
      st.setProperty('--head-ink', '#fff');
      if (!isEditing) node.firstChild.firstChild.textContent = it.title || '';
    } else if (it.type === 'block') {
      const fill = mute(it.color || BLOCK_COLORS[0]);
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      st.fontSize = `${BLOCK_FS}px`;
      st.background = fill;
      st.color = '#ffffff';
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
    if (comments.delete(id)) {
      cmDirty = true;
      return;
    }
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

  // `quiet` marks housekeeping this page does by itself, so the board is not shown as just edited.
  function sendOps(ops, quiet = false) {
    // Somebody with a link sends nothing, unless it lets them comment, and then only comments.
    if (!ops.length || (viewOnly && !(guestWrites() && ops.every((op) => op.t === 'add' && op.item.type === 'comment')))) return;
    const batch = { ops, keys: keysOf(ops), quiet };
    for (const k of batch.keys) pendingKeys.set(k, (pendingKeys.get(k) || 0) + 1);
    outbox.push(batch);
    if (online) ws.send(JSON.stringify(quiet ? { t: 'op', ops, quiet } : { t: 'op', ops }));
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
        if (op.item.type === 'comment') {
          comments.set(op.item.id, { ...op.item });
          cmDirty = true;
          if (remote && !op.item.re) toast(`${op.item.name} commented on ${hostLabel(op.item)}`);
          continue;
        }
        items.set(op.item.id, { ...op.item });
        renderItem(items.get(op.item.id));
      } else if (op.t === 'set') {
        const it = items.get(op.id) || comments.get(op.id);
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
        if (it.type === 'comment') cmDirty = true;
        else renderItem(it);
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
    if (cmDirty) {
      cmDirty = false;
      syncComments();
    }
    updateFrameCounts();
    updateOverlay();
    queueMarks();
    if (focusId) queueViewer();
    scheduleSettle();
  }

  function invert(ops) {
    const inverse = [];
    for (const op of ops) {
      if (op.t === 'add') {
        inverse.unshift({ t: 'del', ids: [op.item.id] });
      } else if (op.t === 'del') {
        for (const id of op.ids) {
          const it = items.get(id) || comments.get(id);
          if (it) inverse.unshift({ t: 'add', item: { ...it } });
        }
      } else if (op.t === 'set') {
        const it = items.get(op.id) || comments.get(op.id);
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
    // Where everything the step may move is now: what it sets, and the frames that refit around that.
    const before = new Map();
    for (const op of ops) if (op.t === 'set' && items.has(op.id)) before.set(op.id, geometry(items.get(op.id)));
    for (const id of frameIds()) if (!before.has(id)) before.set(id, geometry(items.get(id)));
    const inverse = invert(ops);
    applyOps(ops);
    sendOps(ops);
    if (inverse.length) to.push(inverse);
    refitLive(frameIds());
    glideFrom(before);
    selChanged();
  }

  // ---- undo and redo glide

  // The document changes at once, as it always has; only what is drawn takes a moment to catch up, so
  // a piece that undo sends back can be followed by eye instead of jumping. What is shown eases from
  // where the piece was to wherever the document has it now, which keeps it right if something else
  // moves the piece in the meantime.
  const GLIDE_MS = 180;
  const GLIDE_KEYS = ['x', 'y', 'w', 'h', 'fs'];
  const glides = new Map(); // id -> { from, t0, cur }: where it started, when, and where it is drawn now
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  let glideRaf = 0;
  let glideTimer = 0;

  function geometry(it) {
    const g = {};
    for (const k of GLIDE_KEYS) if (typeof it[k] === 'number') g[k] = it[k];
    return g;
  }

  function glideFrom(before) {
    if (calm.matches || document.hidden) return;
    const now = performance.now();
    for (const [id, was] of before) {
      const it = items.get(id);
      if (!it) continue;
      // Already on its way somewhere: carry on from where it is drawn, not from where it was heading.
      const from = glides.has(id) ? { ...was, ...glides.get(id).cur } : was;
      if (GLIDE_KEYS.some((k) => typeof it[k] === 'number' && typeof from[k] === 'number' && Math.abs(it[k] - from[k]) > 0.05)) {
        glides.set(id, { from, t0: now, cur: from });
      }
    }
    if (!glides.size) return;
    if (!glideRaf) glideRaf = requestAnimationFrame(glideTick);
    // A window that is covered or in the background may get no frames at all; land everything anyway.
    clearTimeout(glideTimer);
    glideTimer = setTimeout(endGlides, GLIDE_MS + 120);
  }

  function endGlides() {
    cancelAnimationFrame(glideRaf);
    clearTimeout(glideTimer);
    glideRaf = 0;
    const ids = [...glides.keys()];
    glides.clear();
    for (const id of ids) if (items.has(id) && els.has(id)) renderItem(items.get(id));
    updateOverlay();
  }

  function glideTick(now) {
    glideRaf = 0;
    for (const [id, g] of glides) {
      const it = items.get(id);
      const node = els.get(id);
      const k = clamp((now - g.t0) / GLIDE_MS, 0, 1);
      if (!it || !node || k >= 1) {
        glides.delete(id);
        if (it && node) renderItem(it);
        continue;
      }
      // Quick off the mark, settling at the end.
      const e = 1 - (1 - k) ** 3;
      const cur = {};
      let resized = false;
      for (const key of GLIDE_KEYS) {
        if (typeof it[key] !== 'number' || typeof g.from[key] !== 'number') continue;
        cur[key] = g.from[key] + (it[key] - g.from[key]) * e;
        if (key !== 'x' && key !== 'y' && Math.abs(it[key] - g.from[key]) > 0.05) resized = true;
      }
      g.cur = cur;
      // A plain move only needs its position set; a change of size is drawn in full.
      if (resized) renderItem({ ...it, ...cur });
      else node.style.transform = `translate(${cur.x}px, ${cur.y}px)`;
    }
    updateOverlay();
    if (glides.size) glideRaf = requestAnimationFrame(glideTick);
    else clearTimeout(glideTimer);
  }

  // Where a piece is drawn right now, which during a glide is not yet where the document has it. For
  // what follows a piece on screen (the selection box), never for working anything out.
  function shownBounds(it) {
    const b = bounds(it);
    const g = glides.get(it.id);
    if (!g) return b;
    return { x: g.cur.x ?? b.x, y: g.cur.y ?? b.y, w: g.cur.w ?? b.w, h: it.type === 'note' ? b.h : g.cur.h ?? b.h };
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
      // What is open in the viewer is the page being looked at, not a thing on it: it is never selected,
      // so nothing done to a selection (delete, nudge, duplicate, reorder) can reach it from in there.
      if (!items.has(id) || id === focusId) continue;
      sel.add(id);
      els.get(id).classList.add('sel');
    }
    selChanged();
  }

  function selChanged() {
    updateOverlay();
    sendP({ s: [...sel] });
  }

  function selBounds(of = bounds) {
    let r = null;
    for (const id of sel) {
      const it = items.get(id);
      if (it) r = union(r, of(it));
    }
    return r;
  }

  function updateOverlay() {
    const r = sel.size && !editing ? selBounds(shownBounds) : null;
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
    seltools.hidden = !!dragging;
    if (seltools.hidden) return;
    buildSelTools();
    const tw = seltools.offsetWidth;
    const th = seltools.offsetHeight;
    let ty = a.y - th - 12;
    if (ty < 56) ty = Math.min(a.y + h + 12, vp.clientHeight - th - 12);
    seltools.style.left = `${clamp(a.x + w / 2 - tw / 2, 90, Math.max(90, vp.clientWidth - tw - 12))}px`;
    seltools.style.top = `${Math.max(56, ty)}px`;
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
        kids.push(el('button', { class: 'swatch', style: { background: only === 'note' ? noteFill(c) : only === 'block' ? mute(c) : only === 'frame' ? (c === FRAME_COLORS[0] ? c : deepen(c)) : swatchColor(c) }, title: 'Set colour', onclick: () => colorSel(c) }));
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
    if (one && (one.type === 'image' || one.type === 'video')) kids.push(btn(ICON.focus, 'Open it, to comment and draw on it (double-click)', () => enterFocus(one.id)));
    // Only ever an address: a file here, or a picture that was pasted in by its link.
    if (one && (one.type === 'image' || one.type === 'video') && /^(\/|https?:\/\/)/.test(one.src || '')) {
      kids.push(btn(ICON.open, 'Open the original file in a new tab', () => window.open(one.src, '_blank', 'noopener')));
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
    const list = [...withDependents(ids)].map((id) => items.get(id)).filter((it) => it && !commentOf(it))
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
        // What is drawn or written on a piece goes with it, and scales as it does.
        const moved = { x: round(patch.x + (ch.x - o.b.x) * o.s), y: round(patch.y + (ch.y - o.b.y) * o.s) };
        if (o.s !== 1) Object.assign(moved, scaledSize(ch, o.s));
        ops.push({ t: 'set', id: ch.id, patch: moved });
      }
      x += o.w + gap;
      tallest = Math.max(tallest, o.h);
      inRow++;
    }
    exec(ops);
    refitLive(boxed.map((o) => o.it.fid).filter(Boolean));
  }

  // What scaling a piece by `s` does to its own size (its position is the caller's business): text by
  // its type size, a note together with its writing, a drawing together with its line weight.
  function scaledSize(it, s) {
    if (it.type === 'text') return { fs: round(it.fs * s) };
    const patch = { w: round(it.w * s), h: round((it.h || 0) * s) };
    if (it.type === 'note') patch.fs = round(it.fs * s);
    if (it.type === 'stroke') patch.size = round(it.size * s);
    return patch;
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

  // While an image is open, only it and its drawings take part in anything. Nor does what is out of sight:
  // something drawn for a comment on another frame of a video than the one showing.
  function selectable(it) {
    if (focusId && it.id !== focusId && it.pid !== focusId) return false;
    const node = els.get(it.id);
    return !node || !node.classList.contains('offframe');
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
    // Comments left on something go when it goes, replies included.
    for (const c of comments.values()) if (c.on && all.has(c.on)) all.add(c.id);
    for (const c of comments.values()) if (c.re && all.has(c.re)) all.add(c.id);
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

  // Dropping an item mostly onto a frame adds it; it stays until it is completely outside the frame.
  function updateFrameMembership(g) {
    if (!g.rest.size || !g.items.length) return;
    const touched = new Set();
    for (const id of g.items) {
      const it = items.get(id);
      if (!it) continue; // somebody else deleted it while it was being dragged
      const b = bounds(it);
      const cur = frameOf(it);
      const curId = cur && g.rest.has(cur.id) ? cur.id : null;
      // Joining is deliberate: more than half of the item has to be over a frame. Once it is in it stays
      // in, and only lets go when it is completely clear of what the frame holds.
      let next = null;
      const held = curId && g.rest.get(curId);
      if (held && (overlapArea(b, held.home) > 0 || overlapArea(b, held.r) > 0)) {
        next = curId;
      } else {
        let best = 0;
        for (const [fid, { r }] of g.rest) {
          const over = overlapArea(b, r);
          if (over > 0.5 * area(b) && over > best) {
            best = over;
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
    if (focusId) return;
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

  // Every image and video in the order the board reads. A frame counts as one piece, placed among the
  // loose media by where it sits (rows first, then left to right), and what it holds is read through
  // in the same way before moving on to the next piece.
  function mediaOrder() {
    const held = new Map();
    const pieces = [];
    for (const it of items.values()) {
      if ((it.type !== 'image' && it.type !== 'video') || it.pid) continue;
      const frame = frameOf(it);
      if (!frame) pieces.push(it);
      else if (held.has(frame.id)) held.get(frame.id).push(it);
      else {
        held.set(frame.id, [it]);
        pieces.push(frame);
      }
    }
    return readingOrder(pieces).flatMap((p) => (p.type === 'frame' ? readingOrder(held.get(p.id)) : [p]));
  }

  // Moves on to the next or previous piece of media while one is open, going round at the ends.
  // Steps pile up while a frame is being drawn and are made together, so a held key skips ahead
  // instead of building the whole view for every piece it passes.
  let stepPending = 0;
  function stepFocus(dir) {
    if (!focusId) return;
    if (!stepPending) {
      requestAnimationFrame(() => {
        const n = stepPending;
        stepPending = 0;
        const list = mediaOrder();
        const i = list.findIndex((it) => it.id === focusId);
        if (i < 0 || list.length < 2) return;
        enterFocus(list[(((i + n) % list.length) + list.length) % list.length].id);
      });
    }
    stepPending += dir;
  }

  // An open image or video fills the space between the bars. The view can zoom into it and move
  // around it, but never out past it nor off it onto the board: it is the board's viewer, not a
  // zoomed-in board, and only closing it goes back.
  //
  // Around it the viewer is laid out like a review tool: every image and video on the board down the
  // left edge, the comments on the open one in a panel on the right, and under a video its timeline.
  // What is left in the middle belongs to the piece. Measured when the layout changes, not on every
  // move of the camera.
  let viewerPad = { t: 112, r: 48, b: 48, l: 120 };
  function layoutViewer() {
    const below = timeline.hidden ? 0 : timeline.offsetHeight + 12;
    viewerPad = vp.clientWidth < 700
      ? { t: 104, r: 12, b: 20 + below, l: 12 }
      : { t: 112, r: (panel.hidden ? 0 : panel.offsetWidth) + 32, b: 32 + below, l: $('filmstrip').offsetWidth + 32 };
  }
  const focusInsets = () => viewerPad;

  // After the space around the piece has changed: a piece that filled it fills it again, and one that
  // was zoomed into stays as it was.
  function relayoutViewer() {
    if (!focusId) return;
    const fitted = !focusZoomed();
    layoutViewer();
    if (fitted) fitFocus();
    else applyCam();
  }

  // The zoom at which the open piece just fits between the bars.
  function focusFitZ() {
    const r = bounds(items.get(focusId));
    const i = focusInsets();
    return Math.min(MAX_Z, (vp.clientWidth - i.l - i.r) / Math.max(r.w, 1), (vp.clientHeight - i.t - i.b) / Math.max(r.h, 1));
  }

  const focusZoomed = () => !!focusId && cam.z > focusFitZ() * 1.02;

  // Zoom one image pixel to one screen pixel: actual size.
  function actualSizeZ(it) {
    return it.nw ? it.nw / it.w / (window.devicePixelRatio || 1) : focusFitZ() * 2;
  }

  // Applied to every view while something is open: while it fits it stays in the middle, and once it
  // is larger its edges never come in further than the bars.
  function keepOnFocus() {
    const it = items.get(focusId);
    if (!it) return;
    const r = bounds(it);
    const i = focusInsets();
    cam.z = clamp(cam.z, focusFitZ(), MAX_Z);
    const axis = (pos, size, lo, span, at) => {
      const shown = size * cam.z;
      const start = shown <= span ? lo + (span - shown) / 2 : clamp((pos - at) * cam.z, lo + span - shown, lo);
      return pos - start / cam.z;
    };
    cam.x = axis(r.x, r.w, i.l, vp.clientWidth - i.l - i.r, cam.x);
    cam.y = axis(r.y, r.h, i.t, vp.clientHeight - i.t - i.b, cam.y);
  }

  function fitFocus(dur = 0) {
    const it = focusId && items.get(focusId);
    if (it) fitRect(bounds(it), { inset: focusInsets(), dur });
  }

  // Between fitting the screen and actual size (or twice the fit, for something small), around a point.
  function toggleFocusZoom(sx = vp.clientWidth / 2, sy = vp.clientHeight / 2) {
    const it = focusId && items.get(focusId);
    if (!it) return;
    if (focusZoomed()) return fitFocus();
    const fit = focusFitZ();
    const actual = actualSizeZ(it);
    zoomAt(sx, sy, (actual > fit * 1.1 ? actual : fit * 2) / cam.z);
  }

  function showFocusZoom() {
    const it = items.get(focusId);
    if (!it) return;
    $('focuszoom').textContent = focusZoomed() ? `${Math.round((cam.z / actualSizeZ(it)) * 100)}%` : 'Fit';
  }

  // `followed` is true when it opens because the person being followed opened it.
  let preloadTimer = 0;
  function enterFocus(id, followed = false) {
    const it = items.get(id);
    if (!it || (it.type !== 'image' && it.type !== 'video')) return;
    finishEdit();
    if (!followed && following) {
      following = null;
      updateFollowUI();
    }
    stopCamAnim();
    const wasOpen = !!focusId;
    if (!focusId) {
      focusReturn = { x: cam.x, y: cam.y, z: cam.z };
      // Annotating is fine work, so the brush starts at its smallest; the usual size comes back afterwards.
      penBeforeFocus = pen.size;
      pen.size = PEN_SIZES[0];
    }
    const prev = focusId && videoOf(focusId);
    if (prev && focusId !== id) prev.pause();
    if (focusId && focusId !== id) dropWhole(focusId);
    if (focusId !== id) {
      // What was being written or read belongs to the piece before.
      dropDraft();
      activeThread = null;
    }
    focusId = id;
    // Whatever was selected on the board is left behind: nothing is selected in here.
    setSel([]);
    document.body.classList.add('focus');
    document.body.classList.toggle('focus-video', it.type === 'video');
    $('focusname').textContent = it.name || (it.type === 'video' ? 'Video' : 'Image');
    $('focusclear').title = `Delete everything drawn on this ${it.type}`;
    $('focusbar').hidden = false;
    $('filmstrip').hidden = false;
    $('timeline').hidden = it.type !== 'video';
    for (const [nid, node] of els) node.classList.toggle('dim', nid !== id && items.get(nid).pid !== id);
    // In here there is one tool, the brush: a press on the piece draws. (Somebody holding a link has the hand instead.)
    if (!wasOpen) setTool('pen');
    if (it.type === 'video') {
      // Open, it is scrubbed and stepped through: worth having all of it rather than just its start.
      // Held back a moment so stepping quickly past videos does not start loading every one of them.
      clearTimeout(preloadTimer);
      preloadTimer = setTimeout(() => {
        const video = focusId === id && videoOf(id);
        if (!video) return;
        // One fetch of the whole of it, rather than that and the browser's own reading ahead side by side.
        if (wholeable(items.get(id))) holdWhole(id);
        else video.preload = 'auto';
      }, 300);
    }
    syncFilmstrip(!wasOpen);
    syncComments();
    syncTimeline();
    syncLoaded();
    queueMarks();
    layoutViewer();
    fitFocus(followed || wasOpen ? 0 : 450);
    sendP({ f: id });
  }

  function exitFocus() {
    if (!focusId) return;
    dropWhole(focusId);
    dropDraft();
    activeThread = null;
    focusId = null;
    document.body.classList.remove('focus', 'focus-video');
    $('focusbar').hidden = true;
    $('filmstrip').hidden = true;
    $('timeline').hidden = true;
    for (const node of els.values()) node.classList.remove('dim');
    if (penBeforeFocus !== null) {
      pen.size = penBeforeFocus;
      penBeforeFocus = null;
    }
    setTool('select');
    syncComments();
    sendP({ f: null });
    const leader = following && peers.get(following);
    if (leader && leader.p.v) followView(leader.p.v, 0);
    else if (focusReturn) animateCam(focusReturn, 520);
    focusReturn = null;
  }

  // Following someone means seeing what they have open, too.
  function followFocus(id) {
    if (id && items.has(id)) {
      if (focusId !== id) enterFocus(id, true);
    } else if (focusId) {
      exitFocus();
    }
  }

  function clearDrawing() {
    const ids = [...items.values()].filter((it) => it.pid === focusId).map((it) => it.id);
    if (ids.length) exec([{ t: 'del', ids }]);
  }

  // ---- the strip down the left of the viewer: every image and video, in the order the arrows take them

  const film = $('filmstrip');
  let filmSig = '';
  let filmQueued = false;
  // The smallest picture there is of a piece: its thumbnail, else what the board shows for it.
  const stillOf = (it) => (it.type === 'video' && fixedStill.get(it.id)) || it.th || (it.type === 'video' ? it.poster : it.prev || it.src) || '';

  function queueViewer() {
    if (filmQueued) return;
    filmQueued = true;
    queueMicrotask(() => {
      filmQueued = false;
      if (!focusId) return;
      syncFilmstrip();
      syncComposer();
      paintFocusWave();
    });
  }

  // `jump` puts the open piece in view at once, as when the viewer opens; otherwise the strip glides to it.
  function syncFilmstrip(jump = false) {
    const list = mediaOrder();
    const open = new Map();
    if (canRead()) for (const c of comments.values()) if (!c.re && !c.done) open.set(c.on, (open.get(c.on) || 0) + 1);
    const sig = list.map((it) => `${it.id} ${stillOf(it)} ${open.get(it.id) || 0}`).join('|');
    if (sig !== filmSig) {
      filmSig = sig;
      film.replaceChildren(...list.map((it, i) => {
        const still = stillOf(it);
        const n = open.get(it.id);
        return el('button', { class: 'fs-item', 'data-id': it.id, title: it.name || (it.type === 'video' ? 'Video' : 'Image'), onclick: () => enterFocus(it.id) },
          el('span', { class: 'fs-num', text: String(i + 1) }),
          el('span', { class: 'fs-thumb', style: { aspectRatio: String(clamp(it.w / (it.h || 1), 0.6, 2.4)) } },
            still && el('img', { src: still, alt: '', decoding: 'async', draggable: 'false' }),
            // A video added before stills were kept for them shows its own first frame.
            !still && it.type === 'video' && it.src && el('video', { src: it.src, preload: 'metadata', muted: true, playsinline: true, tabindex: -1 }),
            it.type === 'video' && el('span', { class: 'fs-badge', html: ICON.play }),
            n && el('span', { class: 'fs-count', text: String(n), title: n > 1 ? `${n} open comments` : '1 open comment' })));
      }));
    }
    const i = list.findIndex((it) => it.id === focusId);
    $('focuspos').textContent = `${i + 1} / ${list.length}`;
    $('focusprev').disabled = $('focusnext').disabled = list.length < 2;
    for (const node of film.children) {
      const current = node.dataset.id === focusId;
      if (current === node.classList.contains('current')) continue;
      node.classList.toggle('current', current);
      if (!current) {
        node.removeAttribute('aria-current');
        continue;
      }
      node.setAttribute('aria-current', 'true');
      // Kept in the middle of the strip, so what comes next and what came before are both in sight.
      film.scrollTo({ top: node.offsetTop - (film.clientHeight - node.offsetHeight) / 2, behavior: jump || calm.matches ? 'auto' : 'smooth' });
    }
  }

  // ---- the picture and sound of a video, along its scrub bar
  const WAVE_W = 480;
  const WAVE_H = 80;

  const toB64 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(out);
  };
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  // The average colour of the top and of the bottom of a small copy of a frame.
  function frameColours(ctx) {
    const { data } = ctx.getImageData(0, 0, 16, 8);
    const sum = [0, 0, 0, 0, 0, 0];
    for (let p = 0; p < 128; p++) {
      const half = p < 64 ? 0 : 3;
      for (let c = 0; c < 3; c++) sum[half + c] += data[p * 4 + c];
    }
    return sum.map((v) => Math.round(v / 64));
  }

  // A strip with holes in it is worse than none: a missed moment takes its neighbour's colour, and if
  // more than a few are missed there is no strip at all, to be tried again another time.
  function closeHoles(cols) {
    const missed = cols.filter((c) => !c).length;
    if (missed > cols.length * 0.05) return null;
    const out = new Uint8Array(cols.length * 6);
    for (let i = 0; i < cols.length; i++) {
      let c = cols[i];
      for (let d = 1; !c && d < cols.length; d++) c = cols[i - d] || cols[i + d];
      if (!c) return null;
      out.set(c, i * 6);
    }
    return out;
  }

  // The picture at evenly spaced moments along the timeline, each column the frame that is on show at the
  // middle of its stretch. The frames are decoded here by their timestamps, and each one's own timestamp is
  // checked against the moment asked for, so a column can only ever hold the colour of its own moment.
  // (Seeking a video element and copying what it shows is not that: the browser may report the seek done
  // while the old frame is still on show, and the same colour then runs on for minutes.)
  async function colourStrip(url, dur) {
    let input;
    try {
      const mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
      input = new mb.Input({ source: new mb.UrlSource(url), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) throw new Error('cannot decode');
      const first = await track.getFirstTimestamp();
      if (!(dur > 0)) dur = await input.computeDuration();
      if (!(dur > 0)) return null;
      const step = dur / WAVE_COLS;
      const times = Array.from({ length: WAVE_COLS }, (_, i) => Math.max(first, step * (i + 0.5)));
      const sink = new mb.CanvasSink(track, { width: 16, height: 8, fit: 'fill', poolSize: 1 });
      const cols = [];
      let before = -Infinity;
      for await (const frame of sink.canvasesAtTimestamps(times)) {
        // The frame on show at a moment starts at or before it, and never before the one for the moment earlier.
        const right = frame && frame.timestamp <= times[cols.length] + 0.001 && frame.timestamp >= before;
        if (right) before = frame.timestamp;
        cols.push(right ? frameColours(frame.canvas.getContext('2d', { willReadFrequently: true })) : null);
      }
      const colours = cols.length === WAVE_COLS ? closeHoles(cols) : null;
      if (colours) return { colours, dur };
    } catch {
      // A browser that cannot decode it here still has its video element.
    } finally {
      if (input) input.dispose?.();
    }
    return colourStripByElement(url);
  }

  // The same from a video element, for a browser that cannot decode the file itself. Each seek is only
  // believed once the element says which frame it has put on show.
  async function colourStripByElement(url) {
    const video = el('video', { muted: '', playsinline: '', preload: 'auto' });
    video.muted = true;
    if (!video.requestVideoFrameCallback) return null;
    const ready = new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', reject, { once: true });
      setTimeout(reject, 20000);
    });
    video.src = url;
    try {
      await ready;
      const dur = video.duration;
      if (!(dur > 0) || !isFinite(dur)) return null;
      const canvas = el('canvas', { width: 16, height: 8 });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const step = dur / WAVE_COLS;
      const cols = [];
      let missed = 0;
      for (let i = 0; i < WAVE_COLS && missed <= WAVE_COLS * 0.05; i++) {
        const t = step * (i + 0.5);
        const shown = await new Promise((resolve) => {
          const late = setTimeout(() => resolve(null), 3000);
          video.requestVideoFrameCallback((now, meta) => { clearTimeout(late); resolve(meta.mediaTime); });
          video.currentTime = t;
        });
        if (shown != null && Math.abs(shown - t) <= Math.max(1, step * 2)) {
          ctx.drawImage(video, 0, 0, 16, 8);
          cols.push(frameColours(ctx));
        } else {
          cols.push(null);
          missed++;
        }
      }
      const colours = cols.length === WAVE_COLS ? closeHoles(cols) : null;
      return colours ? { colours, dur } : null;
    } catch {
      return null;
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  // How loud the sound is, in even steps along the video; null where there is none.
  async function soundPeaks(url, dur) {
    let input;
    try {
      const mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
      input = new mb.Input({ source: new mb.UrlSource(url), formats: mb.ALL_FORMATS });
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return null;
      const peaks = new Float32Array(WAVE_BARS);
      const sink = new mb.AudioSampleSink(track);
      for await (const sample of sink.samples()) {
        const data = new Float32Array(sample.numberOfFrames);
        sample.copyTo(data, { planeIndex: 0, format: 'f32-planar' });
        const rate = sample.sampleRate;
        for (let j = 0; j < data.length; j++) {
          const b = Math.min(WAVE_BARS - 1, Math.floor(((sample.timestamp + j / rate) / dur) * WAVE_BARS));
          const v = Math.abs(data[j]);
          if (b >= 0 && v > peaks[b]) peaks[b] = v;
        }
        sample.close();
      }
      const top = Math.max(...peaks);
      if (!(top > 0.002)) return null;
      return Uint8Array.from(peaks, (v) => Math.round(255 * Math.sqrt(v / top)));
    } catch {
      return null;
    } finally {
      if (input) input.dispose?.();
    }
  }

  // The sound as a waveform on top, the picture as flat bands of colour beneath it. It is drawn at the size
  // it is shown at, to the pixel, so no edge is ever stretched soft.
  const waveOf = new WeakMap(); // canvas -> what it shows
  const waveWatch = new ResizeObserver((entries) => { for (const e of entries) fitWave(e.target); });

  function showWave(canvas, wf) {
    if (!waveOf.has(canvas)) waveWatch.observe(canvas);
    if (waveOf.get(canvas) === wf && canvas.dataset.drawn) return;
    waveOf.set(canvas, wf);
    delete canvas.dataset.drawn;
    fitWave(canvas);
  }

  function fitWave(canvas) {
    const wf = waveOf.get(canvas);
    const box = canvas.getBoundingClientRect();
    if (!wf || box.width < 8 || box.height < 8) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(box.width * dpr);
    const h = Math.round(box.height * dpr);
    if (canvas.width === w && canvas.height === h && canvas.dataset.drawn) return;
    canvas.width = w;
    canvas.height = h;
    canvas.dataset.drawn = '1';
    drawWave(canvas, wf, dpr);
  }

  function drawWave(canvas, wf, dpr) {
    const ctx = canvas.getContext('2d');
    const { width: W, height: H } = canvas;
    const stripTop = Math.round(H * 0.62);
    const colours = fromB64(wf.c);
    const cols = colours.length / 6;
    const gap = Math.max(1, Math.round((W / cols) * 0.16));
    for (let i = 0; i < cols; i++) {
      const c = colours.subarray(i * 6, i * 6 + 6);
      const x0 = Math.round((i * W) / cols);
      const x1 = Math.round(((i + 1) * W) / cols);
      ctx.fillStyle = `rgb(${(c[0] + c[3]) >> 1},${(c[1] + c[4]) >> 1},${(c[2] + c[5]) >> 1})`;
      ctx.beginPath();
      ctx.roundRect(x0, stripTop, Math.max(1, x1 - x0 - gap), H - stripTop, Math.max(0, Math.min(Math.round(1.5 * dpr), Math.floor((x1 - x0 - gap) / 2))));
      ctx.fill();
    }
    const room = stripTop - Math.round(3 * dpr);
    const mid = room / 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, W, room);
    if (!wf.p) return;
    const peaks = fromB64(wf.p);
    const n = peaks.length;
    const at = (i) => Math.max(0.5 * dpr, (peaks[i] / 255) * (mid - dpr));
    ctx.beginPath();
    ctx.moveTo(0, mid - at(0));
    for (let i = 1; i < n; i++) ctx.lineTo((i * W) / (n - 1), mid - at(i));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo((i * W) / (n - 1), mid + at(i));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();
  }

  // Strips made before this version have fewer bars; they show until a finer one is made.
  const WAVE_VERSION = 7;
  const waveFor = (it) => {
    const own = waveCache.get(it.src);
    return own || it.wf || null;
  };

  function applyWave(it, node) {
    const wf = waveFor(it);
    if (!wf || wf.v !== WAVE_VERSION) ensureWave(it);
    if (!wf) return;
    const box = node.querySelector('.vseek');
    if (!box) return;
    box.classList.add('wave');
    showWave(box.querySelector('.vwave'), wf);
  }

  function paintFocusWave() {
    const it = focusId ? items.get(focusId) : null;
    const wf = it && it.type === 'video' ? waveFor(it) : null;
    tlTrack.classList.toggle('wave', !!wf);
    if (wf) showWave(tlWave, wf);
  }

  function ensureWave(it) {
    if (it.type !== 'video' || !it.src || !/^\/uploads\//.test(it.src) || waving.has(it.src)) return;
    waving.add(it.src);
    waveQueue = waveQueue.then(async () => {
      try {
        const strip = await colourStrip(it.src, it.dur);
        if (!strip) return;
        const { colours, dur } = strip;
        const peaks = await soundPeaks(it.src, dur);
        const wf = { v: WAVE_VERSION, c: toB64(colours), p: peaks ? toB64(peaks) : '' };
        waveCache.set(it.src, wf);
        const now = items.get(it.id);
        if (now && now.src === it.src && canWrite()) exec([{ t: 'set', id: it.id, patch: { wf } }], false);
        else if (now && els.has(it.id)) renderItem(now);
        paintFocusWave();
      } catch {
        // The bar stays plain.
      }
    });
  }

  // ---- the timeline under an open video

  // Not a slider: it never holds the keyboard, so the keys go on meaning what they mean everywhere else.
  const timeline = $('timeline');
  const tlPlay = el('button', { class: 'iconbtn', html: ICON.play, title: 'Play or pause (Space, or K)', onclick: () => toggleVideo(focusId) });
  const tlSound = el('button', { class: 'iconbtn', html: ICON.muted, title: 'Sound on / off (M)', onclick: () => toggleSound(focusId) });
  const tlTime = el('button', { class: 'tl-time', text: '0:00', title: 'Show minutes and seconds, frame number or timecode', onclick: cycleTimeMode });
  const tlMarks = el('div', { class: 'tl-marks' });
  const tlTip = el('span', { class: 'tl-tip', hidden: true });
  const tlLoaded = el('i', { class: 'tl-loaded' });
  const tlWave = el('canvas', { class: 'tl-wave', width: WAVE_W, height: WAVE_H });
  const tlTrack = el('div', { class: 'tl-track' }, tlWave, el('i', { class: 'tl-rail' }, tlLoaded, el('i', { class: 'tl-played' })), tlMarks, el('i', { class: 'tl-head' }), tlTip);
  timeline.append(
    tlPlay,
    el('button', { class: 'iconbtn', html: ICON.frameBack, title: 'Back one frame ( , )   With Shift, one second', onclick: (e) => stepVideo(focusId, -1, e.shiftKey) }),
    el('button', { class: 'iconbtn', html: ICON.frameFwd, title: 'Forward one frame ( . )   With Shift, one second', onclick: (e) => stepVideo(focusId, 1, e.shiftKey) }),
    tlTime, tlTrack, tlSound);

  // How much of the open video the browser has by now, drawn lighter along the track. Going to a moment
  // it has is immediate; anywhere else it has to be fetched first, which is what makes a scrub drag.
  // Once the video is held whole (see below) that is all of it.
  function syncLoaded() {
    const video = focusId ? videoOf(focusId) : null;
    const dur = video ? video.duration : 0;
    const parts = [];
    const it = video ? items.get(focusId) : null;
    const entry = it ? wholes.get(it.src) : null;
    if (video && video.dataset.whole === it.src) {
      // All of it is in memory.
      parts.push(el('i', { style: { left: '0', width: '100%' } }));
    } else if (dur > 0 && isFinite(dur)) {
      for (let i = 0; i < video.buffered.length; i++) {
        const from = video.buffered.start(i) / dur;
        parts.push(el('i', { style: { left: `${from * 100}%`, width: `${(video.buffered.end(i) / dur - from) * 100}%` } }));
      }
      // On its way in whole: how far that has come.
      if (entry && entry.total) parts.push(el('i', { class: 'coming', style: { left: '0', width: `${(entry.loaded / entry.total) * 100}%` } }));
    }
    tlLoaded.replaceChildren(...parts);
  }

  // ---- the open video, all of it

  // A browser keeps only a little of a paused video in hand and fetches the rest as it is asked for.
  // That suits watching, but a scrub keeps landing on moments it has not got yet, and drags until the
  // hand has been over the whole length once. So a video that is opened is fetched whole, in one go,
  // and then played from memory: every moment of it is there at once. Until it has arrived the video
  // plays from the server as before.
  const WHOLE_MAX = 400 * 1024 * 1024;   // larger than this stays on the server
  const WHOLE_KEPT = 1024 * 1024 * 1024; // how much is held in memory across videos
  const wholes = new Map();              // a video's address -> { loaded, total, url, size, ctl, ready }

  function fetchWhole(src) {
    let entry = wholes.get(src);
    if (entry) return entry;
    entry = { loaded: 0, total: 0, url: null, size: 0, ctl: new AbortController() };
    wholes.set(src, entry);
    entry.ready = (async () => {
      const res = await fetch(src, { signal: entry.ctl.signal });
      entry.total = Number(res.headers.get('content-length')) || 0;
      if (!res.ok || !res.body || !entry.total || entry.total > WHOLE_MAX) throw new Error('not one to hold in memory');
      const reader = res.body.getReader();
      const pieces = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pieces.push(value);
        entry.loaded += value.length;
        if (focusId && items.get(focusId)?.src === src) syncLoaded();
      }
      entry.size = entry.loaded;
      entry.url = URL.createObjectURL(new Blob(pieces, { type: res.headers.get('content-type') || 'video/mp4' }));
      return entry.url;
    })().catch(() => {
      entry.ctl.abort();
      if (wholes.get(src) === entry) wholes.delete(src);
      return null;
    });
    return entry;
  }

  // Puts a video on another source without a flash: the frame it shows is held over it until the same
  // frame is back, and it carries on from where it was.
  function switchSource(video, url) {
    const at = video.currentTime;
    const playing = !video.paused;
    const hold = el('canvas', { class: 'vhold', width: video.videoWidth || 1, height: video.videoHeight || 1 });
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        hold.getContext('2d').drawImage(video, 0, 0);
        video.after(hold);
      }
    } catch {
      // without the still the change shows for a moment, that is all
    }
    const settle = () => {
      clearTimeout(timer);
      hold.remove();
      video.removeEventListener('seeked', settle);
      video.removeEventListener('error', settle);
    };
    const timer = setTimeout(settle, 3000);
    video.addEventListener('error', settle);
    video.addEventListener('loadeddata', () => {
      if (playing) video.play().catch(() => {});
      if (at > 0.001) {
        video.addEventListener('seeked', settle);
        video.currentTime = at;
      } else {
        settle();
      }
    }, { once: true });
    video.src = url;
  }

  // Only what this server keeps: anything else may not let itself be fetched.
  const wholeable = (it) => !!it && it.type === 'video' && /^\/uploads\//.test(it.src || '');

  async function holdWhole(id) {
    const it = items.get(id);
    if (!wholeable(it)) return;
    const src = it.src;
    const entry = fetchWhole(src);
    entry.used = performance.now();
    const url = await entry.ready;
    // Not in the middle of a scrub, which would be thrown back to where it started.
    while (scrub) await new Promise((resolve) => setTimeout(resolve, 120));
    const video = videoOf(id);
    if (!url || !video || items.get(id)?.src !== src || video.dataset.whole === src) return;
    video.dataset.whole = src;
    switchSource(video, url);
    if (focusId === id) syncLoaded();
    // Memory is not for hoarding: the videos opened longest ago go back to playing from the server.
    let kept = 0;
    for (const e of wholes.values()) kept += e.size;
    for (const [other, e] of [...wholes].sort((a, b) => a[1].used - b[1].used)) {
      if (kept <= WHOLE_KEPT || other === src || !e.url) continue;
      for (const [nid, node] of els) {
        const v = node.classList.contains('video') ? node.firstChild : null;
        if (!v || v.dataset.whole !== other) continue;
        delete v.dataset.whole;
        switchSource(v, items.get(nid).src);
      }
      URL.revokeObjectURL(e.url);
      wholes.delete(other);
      kept -= e.size;
    }
  }

  // Going on before a video has arrived whole lets go of the fetch, rather than have every video
  // stepped past arrive at once.
  function dropWhole(id) {
    const it = items.get(id);
    const entry = it && wholes.get(it.src);
    if (!entry || entry.url) return;
    entry.ctl.abort();
    wholes.delete(it.src);
  }

  // Shows where the open video is: the playhead, the time, and which way the buttons point.
  function syncTimeline(at) {
    const video = focusId ? videoOf(focusId) : null;
    if (!video) return;
    if (at == null) at = video.currentTime;
    const dur = video.duration;
    const fps = fpsOf(focusId);
    tlTrack.style.setProperty('--p', `${(dur > 0 && isFinite(dur) ? clamp(at / dur, 0, 1) : 0) * 100}%`);
    const label = timeLabel(at, dur, fps);
    if (tlTime.textContent !== label) tlTime.textContent = label;
    const state = `${video.paused}${video.muted}`;
    if (timeline.dataset.state !== state) {
      timeline.dataset.state = state;
      tlPlay.innerHTML = video.paused ? ICON.play : ICON.pause;
      tlSound.innerHTML = video.muted ? ICON.muted : ICON.sound;
    }
    // The moment a comment written now would be about.
    if (!panel.hidden && !momentChip.hidden && !(draft && draft.at != null)) {
      const moment = fmtMoment(at, fps);
      if (momentChip.lastChild.textContent !== moment) momentChip.lastChild.textContent = moment;
    }
  }

  let scrub = null;
  function trackMoment(e) {
    const video = videoOf(focusId);
    const r = tlTrack.getBoundingClientRect();
    const k = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    return { k, at: wholeFrame(focusId, k * video.duration) };
  }
  function scrubTo(e) {
    const video = videoOf(focusId);
    const { at } = trackMoment(e);
    video.currentTime = at;
    syncTimeline(at);
    sendMedia(focusId);
  }
  const scrubbable = () => {
    const video = focusId ? videoOf(focusId) : null;
    return video && video.duration > 0 && isFinite(video.duration) ? video : null;
  };
  tlTrack.addEventListener('pointerdown', (e) => {
    const video = scrubbable();
    if (!video || e.button !== 0 || e.target.closest('.tl-mark')) return;
    e.preventDefault();
    try {
      tlTrack.setPointerCapture(e.pointerId);
    } catch {
      // capture is a nicety; the scrub still works while the pointer stays over the track
    }
    // Dragging through a playing video holds it still while the hand moves, and lets it run on after.
    scrub = { pid: e.pointerId, resume: !video.paused };
    video.pause();
    scrubTo(e);
  });
  tlTrack.addEventListener('pointermove', (e) => {
    if (!scrubbable()) return;
    const { k, at } = trackMoment(e);
    tlTip.hidden = false;
    tlTip.textContent = fmtMoment(at, fpsOf(focusId));
    tlTip.style.left = `${k * 100}%`;
    if (scrub && e.pointerId === scrub.pid) scrubTo(e);
  });
  const endScrub = (e) => {
    if (!scrub || e.pointerId !== scrub.pid) return;
    const video = scrubbable();
    if (video && scrub.resume) video.play().catch(() => {});
    scrub = null;
    tlTip.hidden = !tlTrack.matches(':hover');
    if (video) sendMedia(focusId);
  };
  tlTrack.addEventListener('pointerup', endScrub);
  tlTrack.addEventListener('pointercancel', endScrub);
  tlTrack.addEventListener('pointerleave', () => { if (!scrub) tlTip.hidden = true; });

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

  // One frame on or back; with `second`, about a second's worth of them.
  function stepVideo(id, dir, second = false) {
    const video = videoOf(id);
    if (!video) return;
    video.pause();
    const fps = fpsOf(id);
    if (fps) {
      const f = clamp(frameIndex(video.currentTime, fps) + dir * (second ? Math.round(fps) : 1), 0, lastFrame(video, fps));
      video.currentTime = frameTime(f, fps);
    } else {
      // A video whose frame rate could not be read steps a 24th of a second.
      video.currentTime = clamp(video.currentTime + dir * (second ? 1 : 1 / 24), 0, video.duration || 0);
    }
    sendMedia(id);
  }

  function toggleSound(id) {
    const video = videoOf(id);
    if (video) video.muted = !video.muted;
  }

  // Where a seek to `at` lands: on the frame showing then, when the frame rate is known.
  function wholeFrame(id, at) {
    const video = videoOf(id);
    const fps = fpsOf(id);
    return video && fps ? frameTime(Math.min(frameIndex(at, fps), lastFrame(video, fps)), fps) : at;
  }

  function seekVideo(id, at) {
    const video = videoOf(id);
    if (!video || at == null) return;
    video.pause();
    video.currentTime = at;
    sendMedia(id);
  }

  // Stops a video on the frame it is showing, so what is made on it next belongs to that frame.
  function holdFrame(id) {
    const video = videoOf(id);
    if (!video) return;
    const fps = fpsOf(id);
    if (video.paused && !fps) return;
    video.pause();
    if (fps) video.currentTime = frameTime(frameIndex(video.currentTime, fps), fps);
    sendMedia(id);
  }

  // ------------------------------------------------------------- frames

  // Rates as cameras and editors write them: a measured rate within 1.5% of one of them is the nearest.
  const RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];
  function snapRate(r) {
    if (!(r > 0) || !isFinite(r)) return 0;
    const near = RATES.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));
    return Math.abs(near - r) / near < 0.015 ? near : Math.round(r * 1000) / 1000;
  }
  const fpsOf = (id) => items.get(id)?.fps || 0;
  // A frame is on screen from its start until the next one's. Asking for its middle lands on it in every browser.
  const frameTime = (f, fps) => (f + 0.5) / fps;
  const frameIndex = (t, fps) => Math.max(0, Math.floor(t * fps + 1e-3));
  const lastFrame = (video, fps) => Math.max(0, Math.ceil((video.duration || 0) * fps - 1e-3) - 1);
  // The frame a video is stopped on; null while it plays or when its frame rate is not known.
  function heldFrame(id) {
    const video = videoOf(id);
    const fps = fpsOf(id);
    return video && fps && video.paused ? frameIndex(video.currentTime, fps) : null;
  }
  // Where a comment on a video was left: on its frame when that is known, otherwise at its time.
  const momentOf = (c) => (c.fr != null && fpsOf(c.on) ? frameTime(c.fr, fpsOf(c.on)) : c.at);

  // How many frames a second a video has, read from the file itself (a file, or the address of one).
  async function readRate(source) {
    let mb;
    try {
      mb = mediabunny || (mediabunny = await import('/vendor/mediabunny.mjs'));
    } catch {
      return 0;
    }
    const input = new mb.Input({ source: typeof source === 'string' ? new mb.UrlSource(source) : new mb.BlobSource(source), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return 0;
      return snapRate((await track.computePacketStats(120)).averagePacketRate);
    } catch {
      return 0;
    } finally {
      input.dispose();
    }
  }

  // How a moment in a video is written: minutes and seconds, the frame number, or a timecode. Frames are
  // counted from 1 the way editors show them; underneath they are counted from 0.
  const TIME_MODES = ['time', 'frame', 'tc'];
  let timeMode = TIME_MODES.includes(store('wb:timemode')) ? store('wb:timemode') : 'time';
  function fmtMoment(t, fps) {
    if (!isFinite(t)) t = 0;
    if (!fps || timeMode === 'time') return fmtTime(t);
    const f = frameIndex(t, fps);
    if (timeMode === 'frame') return `${f + 1}`;
    const base = Math.round(fps);
    const s = Math.floor(f / base);
    const two = (n) => String(n).padStart(2, '0');
    return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}:${two(f % base)}`;
  }
  function timeLabel(at, dur, fps) {
    if (!fps || timeMode === 'time') return `${fmtTime(at)} / ${fmtTime(dur)}`;
    if (timeMode === 'frame') return `${fmtMoment(at, fps)} / ${isFinite(dur) ? Math.round(dur * fps) : '–'}`;
    return fmtMoment(at, fps);
  }
  function cycleTimeMode() {
    timeMode = TIME_MODES[(TIME_MODES.indexOf(timeMode) + 1) % TIME_MODES.length];
    store('wb:timemode', timeMode);
    for (const node of els.values()) if (node.classList.contains('video')) node.firstChild.wbTick();
    // The comments say when they are about, written the same way.
    cmDirty = true;
    afterChange();
  }

  // Marks on each video's timeline where its comments and frame drawings are; clicking one goes there.
  let marksQueued = false;
  function queueMarks() {
    if (marksQueued) return;
    marksQueued = true;
    queueMicrotask(placeMarks);
  }
  function placeMarks() {
    marksQueued = false;
    const on = new Map();
    const add = (id, mark) => (on.get(id) || on.set(id, []).get(id)).push(mark);
    // Drawings first, so a comment on a drawn-on frame sits on top of its tick.
    for (const it of items.values()) {
      const fps = it.fr != null && it.pid ? fpsOf(it.pid) : 0;
      if (fps) add(it.pid, { at: frameTime(it.fr, fps), kind: 'draw', title: 'Drawing on this frame' });
    }
    if (canRead()) {
      for (const c of rootsInOrder()) {
        const at = momentOf(c);
        if (at != null) add(c.on, { at, kind: 'comment', title: `${c.name}: ${c.text}`, c });
      }
    }
    for (const [id, node] of els) {
      if (!node.classList.contains('video')) continue;
      const video = node.firstChild;
      const dur = video.duration;
      const seen = new Set();
      const kids = [];
      const open = [];
      for (const m of isFinite(dur) && dur > 0 ? on.get(id) || [] : []) {
        const left = `${clamp(m.at / dur, 0, 1) * 100}%`;
        // On the open video's timeline every comment has its own mark, in its writer's colour, and
        // picking one picks its thread.
        if (id === focusId) {
          open.push(m.c
            ? el('button', {
              class: `tl-mark comment${m.c.done ? ' done' : ''}${m.c.id === activeThread ? ' active' : ''}`, title: m.title,
              style: { left, background: hexOk(m.c.color) ? m.c.color : '#8a8a8a' }, onclick: () => pickThread(m.c.id),
            })
            : !seen.has(`draw:${Math.round(m.at * 1000)}`) && el('button', { class: 'tl-mark draw', title: m.title, style: { left }, onclick: () => seekVideo(id, m.at) }));
        }
        const key = `${m.kind}:${Math.round(m.at * 1000)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kids.push(el('button', { class: `vmark ${m.kind}`, title: m.title, style: { left }, onclick: () => seekVideo(id, m.at) }));
      }
      node.querySelector('.vmarks').replaceChildren(...kids);
      if (id === focusId) tlMarks.replaceChildren(...open.filter(Boolean));
    }
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
      video.muted = true;
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        if (!video.videoWidth) return fail();
        resolve({ w: video.videoWidth, h: video.videoHeight, video });
      };
      video.onerror = () => { clearTimeout(timer); fail(); };
      video.src = url;
    });
  }

  // A small still of an image or of a video frame, for the board list: opening the list should never
  // mean fetching originals. Best effort; without one the list falls back to what it showed before.
  async function makeThumb(source, w, h) {
    try {
      const k = Math.min(1, THUMB_MAX / Math.max(w, h));
      const canvas = el('canvas', { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) });
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
      return blob ? (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url : null;
    } catch {
      return null;
    }
  }

  const seekFrame = (video, t, settle = true) => new Promise((resolve, reject) => {
    const timer = setTimeout(reject, 5000);
    video.onseeked = () => { clearTimeout(timer); resolve(); };
    video.onerror = () => { clearTimeout(timer); reject(); };
    video.currentTime = t;
  }).then(() => (settle && video.requestVideoFrameCallback
    ? new Promise((done) => { const late = setTimeout(done, 250); video.requestVideoFrameCallback(() => { clearTimeout(late); done(); }); })
    : null));

  // How bright the frame on show is, 0 to 255; a black or not yet painted frame is close to 0.
  function brightness(video) {
    try {
      const canvas = el('canvas', { width: 32, height: 18 });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, 32, 18);
      const { data } = ctx.getImageData(0, 0, 32, 18);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      return sum / (data.length / 4);
    } catch {
      return 255;
    }
  }

  // Stops on a frame from a little way into the video, where there is more to see than on the first one,
  // and moves on if that one is black: a fade in, a slate, a frame the browser had not painted yet.
  // A video that is dark all through gets its brightest candidate.
  async function pickFrame(video) {
    const dur = video.duration || 0;
    const first = Math.max(0.01, Math.min(1, dur / 3));
    const times = [first, ...[0.1, 0.25, 0.5, 0.75, 0.9].map((k) => dur * k).filter((t) => t > 0.01 && t !== first)];
    let best = { t: first, b: -1 };
    for (const t of times) {
      try {
        await seekFrame(video, t);
      } catch {
        continue;
      }
      const b = brightness(video);
      if (b >= 14) return true;
      if (b > best.b) best = { t, b };
    }
    if (best.b < 0) return false;
    await seekFrame(video, best.t).catch(() => {});
    return true;
  }

  // A video's still can be black although the video is not: it was taken before the browser had painted a
  // frame, or on a fade in. Any still that is missing or too dark is replaced by one made from a bright
  // frame of the video itself, one video at a time.
  function vetStill(it) {
    if (it.type !== 'video' || !it.src) return;
    const key = `${it.id} ${it.src} ${it.poster || ''} ${it.th || ''}`;
    if (vetting.has(key)) return;
    vetting.add(key);
    vetQueue = vetQueue.then(async () => {
      try {
        const stored = it.th || it.poster;
        if (stored) {
          const img = await loadImage(stored).catch(() => null);
          if (img && brightness(img) >= 14) return;
        }
        const video = el('video', { muted: '', playsinline: '', preload: 'auto' });
        video.muted = true;
        const ready = new Promise((resolve, reject) => {
          video.addEventListener('loadeddata', resolve, { once: true });
          video.addEventListener('error', reject, { once: true });
          setTimeout(reject, 15000);
        });
        video.src = it.src;
        try {
          await ready;
          if (!(await pickFrame(video))) return;
          const k = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = el('canvas', { width: Math.max(1, Math.round(video.videoWidth * k)), height: Math.max(1, Math.round(video.videoHeight * k)) });
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          fixedStill.set(it.id, canvas.toDataURL('image/jpeg', 0.8));
        } finally {
          video.removeAttribute('src');
          video.load();
        }
        const now = items.get(it.id);
        if (now && els.has(it.id)) renderItem(now);
        if (focusId) queueViewer();
      } catch {
        // Without a better still the one it has stays.
      }
    });
  }

  async function videoThumb(video) {
    try {
      if (!(await pickFrame(video))) return null;
      return await makeThumb(video, video.videoWidth, video.videoHeight);
    } catch {
      return null;
    }
  }

  // Every video is turned into a review copy here, on the uploader's own machine, before it goes
  // anywhere: H.264 in an MP4 that starts playing before it has all arrived (VP9 in WebM where the
  // browser cannot encode H.264), at most 1080p, audio kept,
  // and a key frame every quarter of a second. Browsers can only show a frame by decoding from the key frame
  // before it, and renders and camera files often have one every few seconds, so stepping or scrubbing
  // backwards through them stalls. With key frames this close together it is instant both ways.
  // A browser that cannot encode video uploads the file as it is.
  const VIDEO_BITRATE = 12e6;
  const VIDEO_MIN_BITRATE = 3e6;
  const VIDEO_KEY_INTERVAL = 0.25;
  const VIDEO_LONG_SIDE = 1920;
  const VIDEO_SHORT_SIDE = 1080;
  let mediabunny;

  const fmtSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

  // Whether the key frames, as far as the first two minutes show, are never much more than a second apart.
  async function closeKeyFrames(mb, track, duration) {
    try {
      const sink = new mb.EncodedPacketSink(track);
      let last = -1;
      let keys = 0;
      let widest = 0;
      for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (packet.timestamp > 120) break;
        if (packet.type !== 'key') continue;
        if (last >= 0) widest = Math.max(widest, packet.timestamp - last);
        last = packet.timestamp;
        keys++;
      }
      return keys >= 2 ? widest <= VIDEO_KEY_INTERVAL * 2.1 : keys === 1 && duration <= VIDEO_KEY_INTERVAL * 2;
    } catch {
      return false;
    }
  }

  async function reviewCopy(file, report, note) {
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
      const bitrate = duration > 0 ? (file.size * 8) / duration : VIDEO_BITRATE;
      // Fit inside 1920x1080 (or 1080x1920), keeping the shape; encoders want even sizes.
      const k = Math.min(1, VIDEO_LONG_SIDE / Math.max(w, h), VIDEO_SHORT_SIDE / Math.min(w, h));
      const width = Math.max(2, Math.round((w * k) / 2) * 2);
      const height = Math.max(2, Math.round((h * k) / 2) * 2);
      // A file that is already H.264 within 1080p with a key frame about every half second needs no new
      // encode, only a new wrapper: seconds instead of minutes.
      if (track.codec === 'avc' && k === 1 && (await closeKeyFrames(mb, track, duration))) {
        const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({ input, output });
        if (conversion.isValid && !conversion.discardedTracks.some((d) => d.track.type === 'video')) {
          conversion.onProgress = (p) => report(p);
          await conversion.execute();
          return new File([output.target.buffer], `${file.name.replace(/\.[^.]+$/, '')}.mp4`, { type: 'video/mp4' });
        }
      }
      // Close key frames cost bits, so a lean source gets some headroom rather than losing detail.
      const target = Math.round(Math.min(VIDEO_BITRATE, Math.max(VIDEO_MIN_BITRATE, bitrate * 1.5)));
      const codec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height, bitrate: target });
      if (!codec) {
        note('This browser cannot make a review copy of video, so it is uploaded as it is. Scrubbing backwards may be slow.');
        return file;
      }
      const mp4 = codec === 'avc';
      const encode = async (hardwareAcceleration) => {
        const format = mp4 ? new mb.Mp4OutputFormat({ fastStart: 'in-memory' }) : new mb.WebMOutputFormat();
        const output = new mb.Output({ format, target: new mb.BufferTarget() });
        const conversion = await mb.Conversion.init({
          input, output,
          video: { codec, width, height, fit: 'contain', bitrate: target, keyFrameInterval: VIDEO_KEY_INTERVAL, forceTranscode: true, hardwareAcceleration },
        });
        if (!conversion.isValid) return null;
        conversion.onProgress = (p) => report(p);
        await conversion.execute();
        return output.target.buffer;
      };
      // The graphics card's encoder (NVENC, Quick Sync, AMD) is several times faster than the processor
      // where the browser has one. Otherwise, or if it gives up part way, the processor does it.
      let buffer = null;
      if (await mb.canEncodeVideo(codec, { width, height, bitrate: target, hardwareAcceleration: 'prefer-hardware' }).catch(() => false)) {
        try {
          buffer = await encode('prefer-hardware');
        } catch (err) {
          console.warn('The hardware encoder failed, using the processor:', err);
          report(0);
        }
      }
      if (!buffer) buffer = await encode('no-preference');
      if (!buffer) return file;
      const ext = mp4 ? 'mp4' : 'webm';
      return new File([buffer], `${file.name.replace(/\.[^.]+$/, '')}.${ext}`, { type: `video/${ext}` });
    } catch (err) {
      console.warn('Could not make a review copy, uploading the original:', err);
      note('Could not make a review copy of this video, so it is uploaded as it is.');
      return file;
    } finally {
      input.dispose();
    }
  }

  // The still a video shows until it is played: the frame its thumbnail is made from, large enough to fill the item.
  async function videoPoster(video) {
    const k = Math.min(1, POSTER_MAX / Math.max(video.videoWidth, video.videoHeight));
    const canvas = el('canvas', { width: Math.round(video.videoWidth * k), height: Math.round(video.videoHeight * k) });
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86));
    return blob ? (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url : null;
  }

  async function ingest(file, onProgress, { onPhase = () => {}, note = () => {} } = {}) {
    const ext = fileExt(file);
    const url = URL.createObjectURL(file);
    try {
      if (VID_EXT.test(ext)) {
        const prepared = await reviewCopy(file, onPhase, note);
        const preparedUrl = prepared === file ? url : URL.createObjectURL(prepared);
        try {
          const { w, h, video } = await probeVideo(preparedUrl);
          const th = await videoThumb(video);
          const poster = await videoPoster(video).catch(() => null);
          // Read from the file as it came: a re-encoded copy keeps the rate, but not every container records it as exactly.
          const fps = await readRate(file);
          const dur = isFinite(video.duration) ? Math.round(video.duration * 1000) / 1000 : 0;
          const up = await upload(prepared, fileExt(prepared), onProgress);
          return { type: 'video', src: up.url, nw: w, nh: h, name: file.name, ...(th && { th }), ...(poster && { poster }), ...(fps && { fps }), ...(dur && { dur }) };
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
            out.prev = (await upload(blob, EXT_BY_TYPE[blob.type] || '.webp')).url;
            out.pw = canvas.width;
          }
        } catch {
          // Without a preview the board just shows the original.
        }
      }
      if (Math.max(nw, nh) > THUMB_MAX * 1.5) {
        const th = await makeThumb(img, nw, nh);
        if (th) out.th = th;
      }
      out.src = (await upload(file, ext, onProgress)).url;
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Lays new media out in rows starting at `at`. Everything comes in at the same width.
  // Where each of several pieces of media goes, in rows from `at`; a single one is centred on it.
  function mediaRects(sizes, at, centre = true) {
    const gap = 24;
    const maxRow = clamp((vp.clientWidth * 0.9) / cam.z, IMG_W, 4 * (IMG_W + gap));
    let x = 0;
    let y = 0;
    let tallest = 0;
    const rects = sizes.map((m) => {
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
      const r = { x: at.x + x, y: at.y + y, w: round(w), h: round(h) };
      x += w + gap;
      tallest = Math.max(tallest, h);
      return r;
    });
    if (centre && rects.length === 1) {
      rects[0].x -= rects[0].w / 2;
      rects[0].y -= rects[0].h / 2;
    }
    for (const r of rects) {
      r.x = round(r.x);
      r.y = round(r.y);
    }
    return rects;
  }

  function placeMedia(made, at, centre = true) {
    if (focusId) exitFocus();
    let z = topZ();
    const rects = mediaRects(made, at, centre);
    const list = made.map((m, i) => ({ ...m, id: uid(), ...rects[i], z: ++z }));
    exec(addOps(list));
    setSel(list.map((item) => item.id));
  }

  // ---- stand-ins for videos on their way in
  // A video shows up on the board the moment it is chosen, dimmed, with a ring that fills as its review
  // copy is made and uploaded. It is a piece like any other (select it, move it, drop it into a frame) and
  // everybody on the board sees it. When the video is ready the real one takes its place.
  const RING = 2 * Math.PI * 28;
  const standIns = new Set(); // this browser's own
  const progress = new Map(); // stand-in id -> { k, ph }, from this browser and from the others

  function buildUpload(node) {
    const track = svgEl('circle', { class: 'track', cx: 32, cy: 32, r: 28 });
    const arc = svgEl('circle', { class: 'arc', cx: 32, cy: 32, r: 28, 'stroke-dasharray': RING, 'stroke-dashoffset': RING });
    const ring = svgEl('svg', { class: 'ringsvg', viewBox: '0 0 64 64' });
    ring.append(track, arc);
    node.classList.add('ghost', 'waiting');
    node.append(
      el('div', { class: 'ghostname' }),
      el('div', { class: 'ghostring' }, ring, el('div', { class: 'ghostpct' })),
      el('div', { class: 'ghostphase' }));
  }

  function paintUpload(node, it) {
    const { k = 0, ph = 'wait' } = progress.get(it.id) || {};
    const waiting = !(k > 0);
    node.classList.toggle('waiting', waiting);
    node.querySelector('.ghostname').textContent = it.name || '';
    node.querySelector('.arc').style.strokeDashoffset = RING * (1 - (waiting ? 0.25 : clamp(k, 0, 1)));
    node.querySelector('.ghostpct').textContent = waiting ? '' : `${Math.round(clamp(k, 0, 1) * 100)}%`;
    node.querySelector('.ghostphase').textContent = ph === 'up' ? 'Uploading' : ph === 'enc' ? 'Preparing' : 'Waiting';
  }

  function repaintUpload(id) {
    const it = items.get(id);
    const node = els.get(id);
    if (it && node && it.type === 'upload') paintUpload(node, it);
  }

  function shareStandIns() {
    sendP({ u: [...standIns].map((g) => ({ i: g.id, k: Math.round(g.k * 100) / 100, ph: g.ph })) });
  }

  // What the others have on its way in. They send it as it is, so every value is checked.
  function showRemoteStandIns(peer) {
    const list = Array.isArray(peer.p.u) ? peer.p.u.slice(0, 20) : [];
    const was = peer.up || new Set();
    peer.up = new Set();
    for (const u of list) {
      if (!u || typeof u.i !== 'string') continue;
      peer.up.add(u.i);
      progress.set(u.i, { k: Number(u.k) || 0, ph: u.ph });
      repaintUpload(u.i);
    }
    for (const id of was) if (!peer.up.has(id)) progress.delete(id);
  }

  function dropRemoteStandIns(id) {
    const peer = peers.get(id);
    if (!peer || !peer.up) return;
    for (const upId of peer.up) {
      progress.delete(upId);
      repaintUpload(upId);
    }
  }

  async function videoStandIn(file, rect) {
    const url = URL.createObjectURL(file);
    const id = uid();
    const g = { id, k: 0, ph: 'wait', sent: 0 };
    const stand = { type: 'upload', id, name: file.name, ...rect, z: topZ() + 1 };
    exec(addOps([stand]), false);
    standIns.add(g);
    progress.set(id, g);
    repaintUpload(id);
    shareStandIns();
    // A still from the file itself, where this browser can show it.
    const video = el('video', { muted: '', playsinline: '', preload: 'metadata' });
    video.muted = true;
    video.addEventListener('loadeddata', async () => {
      if (brightness(video) < 14) await pickFrame(video).catch(() => {});
      const node = els.get(id);
      if (node) node.prepend(video);
    }, { once: true });
    video.src = `${url}#t=0.1`;
    // `k` is how far along the whole job is: making the copy is the first 60%, the upload the rest.
    g.status = (ph, p) => {
      const k = ph === 'enc' ? 0.6 * p : ph === 'up' ? 0.6 + 0.4 * p : 0;
      const phaseChanged = ph !== g.ph;
      g.ph = ph;
      g.k = Math.max(k, 0.005);
      repaintUpload(id);
      if (phaseChanged || Math.abs(g.k - g.sent) >= 0.01) {
        g.sent = g.k;
        shareStandIns();
      }
    };
    const finish = () => {
      standIns.delete(g);
      progress.delete(id);
      shareStandIns();
      URL.revokeObjectURL(url);
    };
    // The real video takes the place of the stand-in, wherever it has been moved to, frame and all.
    g.done = (made) => {
      const was = items.get(id);
      finish();
      if (!was) return false; // it was deleted while on its way
      const item = { ...made, id, x: was.x, y: was.y, w: was.w, h: was.h, z: was.z };
      if (was.fid) item.fid = was.fid;
      const selected = sel.has(id);
      exec([{ t: 'del', ids: [id] }], false);
      exec(addOps([item]));
      if (selected) setSel([id]);
      return true;
    };
    g.fail = () => {
      finish();
      if (items.has(id)) exec([{ t: 'del', ids: [id] }], false);
    };
    return g;
  }

  async function addFiles(fileList, at) {
    const files = [...fileList].filter(fileExt);
    if (!files.length) {
      toast('Only images and MP4, WebM or MOV video can be added.');
      return;
    }
    const videos = files.filter((f) => VID_EXT.test(fileExt(f)));
    const pictures = files.filter((f) => !videos.includes(f));
    const errors = [];
    // Videos take a while, so each one is on the board straight away, ready to be placed.
    const sizes = await Promise.all(videos.map(async (f) => {
      const url = URL.createObjectURL(f);
      try {
        const { w, h } = await probeVideo(url);
        return { nw: w, nh: h };
      } catch {
        return { nw: 16, nh: 9 };
      } finally {
        URL.revokeObjectURL(url);
      }
    }));
    if (focusId) exitFocus();
    const rects = mediaRects(sizes, at, !pictures.length && videos.length === 1);
    const ghosts = await Promise.all(videos.map((f, i) => videoStandIn(f, rects[i])));
    if (pictures.length) {
      const below = rects.reduce((y, r) => Math.max(y, r.y + r.h + 24), at.y);
      const status = toast('Uploading…', { sticky: true });
      const made = [];
      for (const [i, file] of pictures.entries()) {
        const label = pictures.length > 1 ? `Uploading ${i + 1} of ${pictures.length}` : 'Uploading';
        try {
          made.push(await ingest(file, (k) => status.set(`${label} · ${Math.round(k * 100)}%`)));
        } catch (err) {
          errors.push(`${file.name}: ${err.message}`);
        }
      }
      status.close();
      if (made.length) placeMedia(made, videos.length ? { x: at.x, y: below } : at, !videos.length);
    }
    for (const [i, file] of videos.entries()) {
      const ghost = ghosts[i];
      try {
        ghost.status('enc', 0);
        const made = await ingest(file, (k) => ghost.status('up', k), {
          onPhase: (k) => ghost.status('enc', k),
          note: (text) => toast(text, { ms: 6000 }),
        });
        ghost.done(made);
      } catch (err) {
        ghost.fail();
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    for (const message of errors.slice(0, 3)) toast(message, { ms: 9000 });
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
    // The clipboard is text anybody could have written: only what looks like a piece of a board comes in.
    const pieces = list.filter((it) => it && typeof it === 'object' && typeof it.id === 'string' && ITEM_TYPES.has(it.type)
      && Number.isFinite(it.x) && Number.isFinite(it.y));
    let box = null;
    for (const it of pieces) box = union(box, { x: it.x, y: it.y, w: it.w || 200, h: it.h || 100 });
    if (!box) return;
    if (focusId) exitFocus();
    const dx = at.x - (box.x + box.w / 2);
    const dy = at.y - (box.y + box.h / 2);
    let z = topZ();
    const clones = reid(pieces)
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
    if (focusId) return void typeComment(trimmed);
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

  function beginPan(e, more = {}) {
    userMovedView();
    begin({ type: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, lx: e.clientX, ly: e.clientY, t: performance.now(), vx: 0, vy: 0, ...more }, e);
    document.body.classList.add('panning');
  }

  // With the hand, which is what somebody holding a link has in the viewer, a click on the open video
  // that went nowhere plays or pauses it. (With the brush a press on it draws.)
  function clickedOpenVideo(g, e) {
    return !!g.onPiece && !!e && e.type === 'pointerup' && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 4 && !!focusId && !!videoOf(focusId);
  }

  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vbar, a, .cchip')) return;
    // A hand on the board while Space is down is a pan, not a tap of the key.
    spaceTap = false;
    if (editing) {
      if (editing.node.contains(e.target)) return;
      finishEdit();
    }
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const p = s2w(e.clientX, e.clientY);
    if (e.pointerType === 'touch' && touchStart(e)) return;
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (viewOnly || spaceDown || tool === 'pan' || tool === 'laser'));
    e.preventDefault();
    if (gesture) return;
    // Touching the board catches it.
    if (coasting) stopCamAnim();
    if (e.button === 2 && !viewOnly && (tool === 'pen' || tool === 'arrow')) {
      const g = { type: 'erase', last: p, hit: new Set() };
      begin(g, e);
      eraserRing.hidden = false;
      eraserRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      eraseSegment(g, p, p);
      return;
    }
    if (pan) {
      const hit = e.target.closest('.item');
      return beginPan(e, { onPiece: e.button === 0 && !spaceDown && tool !== 'laser' && !!focusId && !!hit && hit.dataset.id === focusId });
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
      if (focusId) {
        // In the viewer the brush is for the piece. Off it, a finger swipes on to the next one and a
        // mouse moves the view.
        if (!onOpenPiece(e.clientX, e.clientY)) {
          if (e.pointerType === 'touch') return begin({ type: 'swipe', sx: e.clientX, sy: e.clientY }, e);
          return beginPan(e);
        }
        // Drawing on a video stops it, on the frame the drawing is about.
        holdFrame(focusId);
      }
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
      const g = { type: 'draw', arrow, pts: [p.x, p.y], ws: [w0], lt: e.timeStamp, svg, path, size, t0: performance.now() };
      begin(g, e);
      if (!arrow) path.setAttribute('d', outlinePath(g.pts, g.ws, 1, 1, size));
    }
  });

  // ---- touch: one finger looks around and opens things, two zoom. Drawing, commenting and placing
  // things work with one finger as they do with a mouse, and so does moving something already selected.
  const touches = new Map();
  let pinch = null;
  const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  function touchStart(e) {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size >= 2) {
      // A second finger turns looking around into zooming; it leaves a drawing or a move alone, unless
      // the drawing has only just begun: that was the first of two fingers arriving, not a stroke.
      if (gesture && gesture.type === 'draw' && performance.now() - gesture.t0 < 250) {
        gesture.svg.remove();
        gesture = null;
      }
      if (gesture && (gesture.type === 'pan' || gesture.type === 'swipe')) {
        gesture = null;
        document.body.classList.remove('panning');
      }
      if (!gesture && touches.size === 2) {
        const [a, b] = [...touches.values()];
        stopCamAnim();
        userMovedView();
        pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: midOf(a, b), cam: { ...cam } };
      }
      return true;
    }
    if ((tool !== 'select' && tool !== 'pan') || e.target.closest('.handle')) return false;
    const play = !!e.target.closest('.vplay');
    // In the viewer, with the hand, one finger swipes to the next piece, or moves around it once zoomed in.
    const node = e.target.closest('.item');
    const id = node ? node.dataset.id : null;
    if (focusId && !focusZoomed()) {
      begin({ type: 'swipe', sx: e.clientX, sy: e.clientY, onPiece: id === focusId }, e);
      return true;
    }
    if (!focusId && id && sel.has(id) && !viewOnly && tool === 'select') return false;
    if (coasting) stopCamAnim();
    userMovedView();
    begin({ type: 'pan', touch: true, id, play, moved: false, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, lx: e.clientX, ly: e.clientY, t: performance.now(), vx: 0, vy: 0 }, e);
    return true;
  }

  // A tap: an image or video opens (its play button plays it), anything else is selected.
  function touchTap(g) {
    let it = g.id && items.get(g.id);
    if (it && it.type === 'stroke' && it.pid) it = items.get(it.pid);
    // Open, a tap anywhere on a video plays or pauses it; on the board, only its play button does.
    if (it && it.type === 'video' && (g.play || it.id === focusId)) toggleVideo(it.id);
    else if (focusId) return;
    else if (it && (it.type === 'image' || it.type === 'video')) enterFocus(it.id);
    else if (it && !viewOnly && selectable(it)) setSel([it.id]);
    else if (!viewOnly) setSel([]);
  }

  vp.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!pinch || touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const m = midOf(a, b);
    const z = clamp((pinch.cam.z * Math.hypot(b.x - a.x, b.y - a.y)) / pinch.d0, MIN_Z, MAX_Z);
    // The point of the board first under the fingers stays under them.
    setCam(pinch.cam.x + pinch.m0.x / pinch.cam.z - m.x / z, pinch.cam.y + pinch.m0.y / pinch.cam.z - m.y / z, z);
  }, true);
  const lift = (e) => {
    if (touches.delete(e.pointerId) && touches.size < 2) pinch = null;
  };
  vp.addEventListener('pointerup', lift, true);
  vp.addEventListener('pointercancel', lift, true);

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
      if (items.get(id)?.fid) refitLive([items.get(id).fid]);
    } else {
      const sx = (west ? g.ax - p.x : p.x - g.ax) / g.r.w;
      const sy = (north ? g.ay - p.y : p.y - g.ay) / g.r.h;
      const s = Math.max(sx, sy, 16 / (Math.max(g.r.w, g.r.h) * cam.z));
      for (const id of g.ids) {
        const before = g.snap.get(id);
        const b = g.rects.get(id);
        liveSet(id, { x: round(g.ax + (b.x - g.ax) * s), y: round(g.ay + (b.y - g.ay) * s), ...scaledSize(before, s) });
      }
      refitLive(g.ids.map((id) => items.get(id)?.fid).filter(Boolean));
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
      if (g.touch && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) g.moved = true;
      setCam(g.cx - (e.clientX - g.sx) / cam.z, g.cy - (e.clientY - g.sy) / cam.z, cam.z);
      // How fast the hand is moving, smoothed over the last few moves so one jittery sample does not decide it.
      const now = performance.now();
      const dt = now - g.t;
      if (dt > 0) {
        const k = Math.min(1, dt / 40);
        g.vx += ((e.clientX - g.lx) / dt - g.vx) * k;
        g.vy += ((e.clientY - g.ly) / dt - g.vy) * k;
        g.lx = e.clientX;
        g.ly = e.clientY;
        g.t = now;
      }
    } else if (g.type === 'move') {
      dragMove(g, e, p);
    } else if (g.type === 'resize') {
      dragResize(g, p, e);
    } else if (g.type === 'marquee') {
      showMarquee(g.p0, p);
      const r = { x: Math.min(g.p0.x, p.x), y: Math.min(g.p0.y, p.y), w: Math.abs(p.x - g.p0.x), h: Math.abs(p.y - g.p0.y) };
      const ids = new Set(g.base);
      for (const it of items.values()) {
        if (!selectable(it) || it.id === focusId) continue;
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
        // Holding shift swaps what was drawn for a straight line from where it began; letting go of shift
        // brings the freehand stroke back.
        g.line = e.shiftKey ? straightLine(g.pts[0], g.pts[1], p.x, p.y) : null;
        if (g.line) g.path.setAttribute('d', outlinePath(g.line.pts, g.line.ws, 1, 1, g.size));
        else g.path.setAttribute('d', outlinePath(g.pts, g.ws, 1, 1, g.size));
      }
    }
  });

  // A brush line between two points, with enough points along it for the outline to follow.
  function straightLine(x0, y0, x1, y1) {
    const n = 12;
    const pts = [];
    for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
    return { pts, ws: new Array(n + 1).fill(0.6) };
  }

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
    } else if (g.type === 'pan') {
      if (g.touch && !g.moved) {
        if (e && e.type === 'pointerup') touchTap(g);
      } else if (clickedOpenVideo(g, e)) toggleVideo(focusId);
      // Only if the hand was still moving when it let go: a pan brought to rest stays where it was put.
      else if (e && e.type === 'pointerup' && performance.now() - g.t < 60) coast(g.vx, g.vy);
    } else if (g.type === 'swipe') {
      // In the viewer a sideways swipe goes to the next or previous piece, and a tap on a video plays or pauses it.
      const dx = e ? e.clientX - g.sx : 0;
      const dy = e ? e.clientY - g.sy : 0;
      if (e && e.type === 'pointerup' && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) stepFocus(dx < 0 ? 1 : -1);
      else if (e && e.type === 'pointerup' && g.onPiece && Math.hypot(dx, dy) < 8) toggleVideo(focusId);
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
          if (st && st.type !== 'stroke' && st.pid && !focusId && !g.moving.includes(st.pid)) liveSet(id, { pid: null });
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
      const pts = g.line ? g.line.pts : g.pts;
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
          const ws = (g.line ? g.line.ws : g.ws).slice();
          if (!g.line && ws.length > 4) [0.8, 0.6, 0.4].forEach((k, i) => { ws[ws.length - 1 - i] *= k; });
          item.ws = ws.map((v) => Math.round(v * 100) / 100);
        }
        if (focusId) {
          item.pid = focusId;
          tagComment(item);
        } else {
          const host = hostFor(item);
          item.pid = host ? host.id : null;
        }
        exec(addOps([item]));
        if (item.cid) drewForComment(e);
      }
    }
    updateOverlay();
  }

  vp.addEventListener('pointerup', endGesture);
  vp.addEventListener('pointercancel', endGesture);
  // If the browser takes the pointer away without either of those, the gesture still ends.
  vp.addEventListener('lostpointercapture', endGesture);
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
    if (viewOnly && it.type !== 'video' && it.type !== 'image') return;
    if (it.type === 'note' || it.type === 'text' || it.type === 'block') startEdit(it.id);
    else if (it.type === 'frame') { if (hit.closest('.frame-head')) startEdit(it.id); }
    else if (it.type === 'video' || it.type === 'image') enterFocus(it.id);
  });

  // Read-only: a plain click on an image or video opens it, since looking closer is the one thing to do.
  if (viewOnly) {
    let down = null;
    vp.addEventListener('pointerdown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, skip: !!e.target.closest('.vbar, a, .cchip'), play: !!e.target.closest('.vplay') } : null;
    }, true);
    vp.addEventListener('pointerup', (e) => {
      const start = down;
      down = null;
      if (!start || start.skip || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) return;
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const node = hit && hit.closest('.item');
      const it = node && items.get(node.dataset.id);
      if (!it) return;
      // The big play button plays; anywhere else on an image or video opens it.
      if (it.type === 'video' && start.play) toggleVideo(it.id);
      else if (!focusId && (it.type === 'image' || it.type === 'video')) enterFocus(it.id);
    });
  }

  // ------------------------------------------------------------- drop, paste, copy

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (viewOnly) return;
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
    if (viewOnly) return;
    dragDepth = 0;
    $('dropzone').hidden = true;
    const at = s2w(e.clientX, e.clientY);
    if (e.dataTransfer.files.length) return addFiles(e.dataTransfer.files, at);
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (text) pasteText(text.split('\n')[0], at);
  });

  document.addEventListener('paste', (e) => {
    if (viewOnly || isTyping(e.target) || !e.clipboardData) return;
    e.preventDefault();
    const at = pointer.inside ? s2w(pointer.sx, pointer.sy) : viewCenter();
    if (e.clipboardData.files.length) return addFiles(e.clipboardData.files, at);
    pasteText(e.clipboardData.getData('text/plain'), at);
  });

  function copySel(e) {
    if (isTyping(e.target) || !sel.size) return false;
    e.clipboardData.setData('text/plain', JSON.stringify({ wipboard: 1, items: [...withDependents(sel)].map((id) => items.get(id)).filter((it) => !commentOf(it)) }));
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

  // ------------------------------------------------------------- comments

  // Comments are made in the viewer. An image or a video is opened, and what people say about it is
  // kept in a panel beside it, the way a review tool does it. A comment belongs to the piece, and on a
  // video to the frame it was written on. To point at something you circle it: in the viewer a press
  // on the piece is a brush stroke, and a stroke belongs to the comment being written, starting one if
  // none is. On a video, what was drawn for a comment shows on that comment's frame only.
  // The first message starts a thread and replies hang off it. They are shared, saved and undone like
  // everything else, but kept apart from the items so they never take part in layout, snapping or
  // fitting.
  //
  // Out on the board whatever has comments carries a chip in its corner, and the same panel lists every
  // thread there is. Picking one opens what it is about.

  let hideDone = store('wb:hidedone') === true;
  let activeThread = null;  // the thread picked in the panel, by the id of its first message
  let draft = null;         // { id, on, at, fr }: the comment being written, from the first stroke drawn for it
  let drawnIds = new Set(); // the comments something has been drawn for
  let timed = true;         // whether a new comment on a video is about the frame showing
  let boardPanel = false;   // the list of every thread, out on the board
  // Beside the viewer the panel starts open, and afterwards stays as it was left.
  let viewerPanel = store('wb:cpanel') !== false;
  let sheetOpen = false;    // the same panel on a narrow screen, where it lies over the piece
  const panel = $('commentpanel');

  // Somebody holding a link reads the comments only if the link says so, and writes only if it says that too.
  const canRead = () => !viewOnly || guestReads();
  const canWrite = () => !viewOnly || guestWrites();
  const byTime = (a, b) => (a.t || 0) - (b.t || 0) || (a.id < b.id ? -1 : 1);
  const rootsInOrder = () => [...comments.values()].filter((c) => !c.re).sort(byTime);
  const repliesOf = (id) => [...comments.values()].filter((c) => c.re === id).sort(byTime);
  const hexOk = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  const drawnFor = (id) => [...items.values()].filter((it) => it.cid === id);

  function hostLabel(c) {
    const h = items.get(c.on);
    if (!h) return 'something removed';
    const first = (t) => (t || '').split('\n')[0].trim().slice(0, 32);
    const named = h.type === 'frame' ? h.title : h.type === 'image' || h.type === 'video' ? h.name : first(h.text);
    return named || { image: 'an image', video: 'a video', frame: 'a frame', note: 'a note', text: 'a heading', block: 'a block' }[h.type] || 'an item';
  }

  // ---- what is drawn for a comment

  // On a video a comment is about the frame showing: the exact frame when the rate is known, and the
  // time either way. Unless it is about the video as a whole.
  function stampMoment(c) {
    delete c.at;
    delete c.fr;
    const video = videoOf(c.on);
    if (!video || !timed) return;
    holdFrame(c.on);
    if (isFinite(video.currentTime)) c.at = Math.round(video.currentTime * 100) / 100;
    const fr = heldFrame(c.on);
    if (fr !== null) c.fr = fr;
  }

  // A stroke on the open piece belongs to the comment being written, and starts one if none is. On a
  // video that comment is about the frame its latest stroke was drawn on.
  function tagComment(item) {
    if (!draft || draft.on !== item.pid) {
      draft = { id: uid(), on: item.pid };
      // Writing a new one now, not reading that one.
      activeThread = null;
    }
    stampMoment(draft);
    item.cid = draft.id;
  }

  // After a stroke the panel is there with its box ready, so what the drawing is about can be typed at once.
  function drewForComment(e) {
    if (!panelShown() && !narrow()) togglePanel(true);
    else syncComments();
    // Not on a phone, where the keyboard would come up over the picture after every stroke.
    if (!narrow() && !(e && e.pointerType === 'touch')) setTimeout(() => composer.focus({ preventScroll: true }), 0);
  }

  // The comment something on a piece was drawn for, while there is such a comment on that piece. There
  // may not be: it was never sent, it is gone, or this is a copy of the piece, which takes the drawings
  // along but not the comments. What is left then is an ordinary drawing.
  function commentOf(it) {
    if (!it.cid) return null;
    const c = draft && draft.id === it.cid ? draft : comments.get(it.cid);
    return c && c.on === it.pid ? c : null;
  }

  function annotationShows(it) {
    const c = commentOf(it);
    if (c) {
      // What is drawn for a comment is part of the review, not of the board: it is there while its piece is open.
      if (c.on !== focusId) return false;
      const video = videoOf(c.on);
      // On an image there is no other moment to be on, and what is being drawn is in sight while it is drawn.
      if (c === draft || !video) return true;
      const at = momentOf(c);
      // About the whole video: there with its thread.
      if (at == null) return c.id === activeThread;
      return video.paused && Math.abs(video.currentTime - at) < 0.6 / (fpsOf(c.on) || 24);
    }
    // Drawn on one frame of a video before drawings went with comments: on that frame still.
    if (!it.cid && it.fr != null) return heldFrame(it.pid) === it.fr;
    return true;
  }

  function markAnnotation(it, node) {
    node.classList.toggle('offframe', !annotationShows(it));
  }

  function refreshAnnotations(hostId) {
    for (const it of items.values()) {
      if (!it.pid || (hostId && it.pid !== hostId) || (!it.cid && it.fr == null)) continue;
      const node = els.get(it.id);
      if (node) markAnnotation(it, node);
    }
  }

  // Takes back what was drawn for the comment being written.
  function discardDrawing() {
    if (!draft) return;
    const ids = drawnFor(draft.id).map((it) => it.id);
    draft = null;
    if (ids.length) exec([{ t: 'del', ids }]);
    syncComments();
  }

  // Lets go of the comment being written, as when going on to another piece. What was drawn for it is
  // not thrown away: it stays on the piece as an ordinary drawing.
  function dropDraft() {
    if (!draft) return;
    const left = draft;
    draft = null;
    if (drawnFor(left.id).length) toast('The drawing stays on the picture, without a comment', { ms: 3500 });
    refreshAnnotations(left.on);
    syncComposer();
  }

  // Whether a screen point is on the open piece, or on something drawn or written on it.
  function onOpenPiece(x, y) {
    const t = document.elementFromPoint(x, y);
    const node = t && t.closest ? t.closest('.item') : null;
    const it = node ? items.get(node.dataset.id) : null;
    return !!it && !!focusId && (it.id === focusId || it.pid === focusId);
  }

  function syncComments() {
    const roots = rootsInOrder();
    if (activeThread && !comments.has(activeThread)) activeThread = null;
    const open = roots.filter((c) => !c.done).length;
    const badge = $('commentcount');
    badge.hidden = !open;
    badge.textContent = String(open);
    renderPanel();
    refreshAnnotations();
    syncChips();
    queueMarks();
    if (focusId) queueViewer();
  }

  // ---- out on the board: what has comments says so

  // A small chip in the corner of anything with comments on it: how many threads are open, or a tick
  // once they are all resolved. Clicking it opens the piece with its comments beside it.
  const chips = new Map(); // the id of a piece -> its chip
  function syncChips() {
    const counts = new Map();
    if (canRead()) {
      for (const c of comments.values()) {
        if (c.re) continue;
        const n = counts.get(c.on) || counts.set(c.on, { open: 0, all: 0 }).get(c.on);
        n.all++;
        if (!c.done) n.open++;
      }
    }
    for (const [id, chip] of chips) {
      // Gone with its comments, or left behind on a piece that has been drawn afresh.
      if (counts.has(id) && chip.isConnected) continue;
      chip.remove();
      chips.delete(id);
    }
    for (const [id, n] of counts) {
      const node = els.get(id);
      if (!node) continue;
      let chip = chips.get(id);
      if (!chip) {
        chip = el('button', { class: 'cchip', onclick: () => openComments(id) }, el('span'), el('b'));
        node.append(chip);
        chips.set(id, chip);
      }
      chip.classList.toggle('done', !n.open);
      chip.firstChild.innerHTML = n.open ? ICON.comment : ICON.check;
      chip.lastChild.textContent = n.open ? String(n.open) : '';
      chip.title = n.open ? `${n.open > 1 ? `${n.open} open comments` : '1 open comment'}. Click to read`
        : `${n.all > 1 ? `All ${n.all} comments are` : 'The comment is'} resolved. Click to read`;
    }
  }

  function openComments(id) {
    const host = items.get(id);
    if (!host) return;
    if (host.type === 'image' || host.type === 'video') {
      enterFocus(id);
      if (!panelShown()) togglePanel(true);
    } else {
      // A comment from before they were made in the viewer, on a note or a heading.
      const first = rootsInOrder().find((c) => c.on === id);
      if (first) goToComment(first.id);
    }
  }

  // ---- the panel

  // Built once. After that only its list is drawn again, so what is being typed in it survives other
  // people's comments arriving.
  const cpTitle = el('h2');
  const cpCount = el('span', { class: 'count', hidden: true });
  const cpList = el('div', { class: 'cp-list' });
  const cpFoot = el('div', { class: 'cp-foot' });
  const composer = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Leave a comment…', 'aria-label': 'Comment' });
  const replyBox = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Reply…', 'aria-label': 'Reply' });
  const momentChip = el('button', {
    class: 'tchip', onclick: () => {
      timed = !timed;
      if (draft) stampMoment(draft);
      refreshAnnotations(focusId);
      syncComposer();
    },
  }, el('span', { html: ICON.play }), el('b'));
  // What has been drawn for the comment in the box, with a way to take it back.
  const drawnChip = el('button', { class: 'tchip drawn', title: 'Take the drawing back', onclick: discardDrawing }, el('span', { html: ICON.pen }), el('b'), el('span', { html: ICON.close }));
  // The brush is the one tool the viewer has, so its colours are here, with the reminder of what it is for.
  const cpInks = el('span', { class: 'cp-inks' });
  const cpBrush = el('div', { class: 'cp-brush' }, cpInks, el('span', { text: 'Draw on the picture to point at what you mean' }));
  const cpCompose = el('div', { class: 'cp-compose' }, cpBrush, composer,
    el('div', { class: 'cp-actions' }, momentChip, drawnChip, el('button', { class: 'btn small primary', text: 'Comment', title: 'Send (Enter)', onclick: submitComment })));
  // A link opens a piece with one click; on the board itself, where a click selects, it takes two.
  const openHow = viewOnly ? 'click' : 'double-click';
  const cpHint = el('p', { class: 'cp-hint', text: `Comments are written where the work is looked at: ${openHow} an image or video to open it.` });

  function buildInks() {
    cpInks.replaceChildren(...INK.map((c) => el('button', {
      class: `swatch${c === pen.color ? ' active' : ''}`, style: { background: swatchColor(c) }, title: 'Brush colour',
      onclick: () => {
        pen.color = c;
        // The fine brush an opened piece is drawn on with is for the viewer only; the usual size is what is kept.
        store('wb:pen', { ...pen, size: penBeforeFocus ?? pen.size });
        buildInks();
        buildToolOptions();
      },
    })));
  }

  function autosize(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }
  // Enter sends, Shift+Enter starts a new line, Esc lets go of the box and gives the keys back to the viewer.
  function wireBox(input, send) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        input.blur();
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !input.value) {
        // Nothing typed to take back, so undo is for the board: the stroke just drawn, say.
        e.preventDefault();
        if (e.shiftKey) stepHistory(redoStack, undoStack);
        else stepHistory(undoStack, redoStack);
      }
    });
    input.addEventListener('input', () => autosize(input));
  }
  wireBox(composer, submitComment);
  wireBox(replyBox, submitReply);
  // Starting to write about a video stops it, so the comment is about the frame that was showing.
  composer.addEventListener('focus', () => {
    if (focusId && timed) holdFrame(focusId);
  });

  const cpToggle = (label, title, checked, onchange) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = checked;
    box.addEventListener('change', () => onchange(box.checked));
    return el('label', { class: 'cp-show', title }, box, label);
  };
  panel.append(
    el('div', { class: 'cp-head' }, cpTitle, cpCount,
      el('button', { class: 'iconbtn', html: ICON.close, title: 'Hide the comments (Shift+C)', onclick: () => togglePanel(false) })),
    el('div', { class: 'cp-opts' },
      cpToggle('Hide resolved', 'Leave out threads that have been resolved', hideDone, (v) => {
        hideDone = v;
        store('wb:hidedone', v);
        renderPanel();
      })),
    cpList, cpFoot);

  // On a narrow screen there is no room beside the piece: the panel is a sheet over it, brought up when
  // wanted and never open to begin with.
  const narrow = () => vp.clientWidth < 700;
  const panelShown = () => canRead() && (focusId ? (narrow() ? sheetOpen : viewerPanel) : boardPanel);

  function togglePanel(show = !panelShown()) {
    if (focusId && narrow()) {
      sheetOpen = show;
    } else if (focusId) {
      viewerPanel = show;
      store('wb:cpanel', show);
    } else {
      boardPanel = show;
      if (show) $('helppanel').hidden = true;
    }
    // Beside the viewer the panel takes room from the piece, which makes the most of what is left.
    const fitted = !!focusId && !focusZoomed();
    syncComments();
    if (focusId) {
      layoutViewer();
      if (fitted) fitFocus(calm.matches ? 0 : 160);
      else applyCam();
    }
  }

  function syncComposer() {
    const video = focusId ? videoOf(focusId) : null;
    const strokes = draft && draft.on === focusId ? drawnFor(draft.id).length : 0;
    momentChip.hidden = !video;
    if (video) {
      // Once something is drawn for it, the comment is about the frame that was drawn on.
      const held = strokes && draft.at != null;
      momentChip.classList.toggle('off', !timed);
      momentChip.title = !timed ? 'The comment is about the whole video. Click to tie it to the frame showing'
        : held ? 'The comment is about the frame that was drawn on. Click to make it about the whole video'
          : 'The comment is about the frame showing. Click to make it about the whole video';
      momentChip.lastChild.textContent = fmtMoment(held ? momentOf(draft) : video.currentTime, fpsOf(focusId));
    }
    drawnChip.hidden = !strokes;
    drawnChip.children[1].textContent = strokes > 1 ? `Drawing · ${strokes}` : 'Drawing';
    composer.placeholder = strokes ? 'Say what the drawing is about…' : 'Leave a comment…';
    cpCompose.classList.toggle('drafting', strokes > 0);
    // Somebody holding a link writes comments but cannot draw.
    cpBrush.hidden = viewOnly;
  }

  function messageNode(c, root, showHost) {
    const first = c === root;
    const mine = (m) => m.name === me.name;
    const canDelete = !viewOnly && mine(c) && (!first || repliesOf(c.id).every(mine));
    const text = el('div', { class: 'msg-text' });
    fillText(text, c.text);
    const moment = first && videoOf(c.on) ? momentOf(c) : null;
    return el('div', { class: `msg${first ? '' : ' reply'}` },
      el('span', { class: 'avatar sm', style: { background: hexOk(c.color) ? c.color : '#8a8a8a' }, text: WB.initials(c.name) }),
      el('div', { class: 'msg-main' },
        el('div', { class: 'msg-top' },
          el('strong', { text: c.name }),
          c.guest && el('span', { class: 'notice-guest', text: 'Guest', title: 'Written by somebody holding a link, under a name they typed' }),
          el('span', { class: 'msg-time', text: WB.ago(c.t), title: new Date(c.t).toLocaleString() }),
          first && drawnIds.has(c.id) && el('span', { class: 'msg-drawn', html: ICON.pen, title: 'Has a drawing on the picture' }),
          el('span', { class: 'msg-acts' },
            first && !viewOnly && el('button', {
              class: `iconbtn mini${c.done ? ' active' : ''}`, html: ICON.check, title: c.done ? 'Resolved. Click to open it again' : 'Mark as resolved',
              onclick: () => exec([{ t: 'set', id: c.id, patch: { done: !c.done } }]),
            }),
            canDelete && el('button', { class: 'iconbtn mini', html: ICON.trash, title: first ? 'Delete the thread, and what was drawn for it' : 'Delete', onclick: () => removeComment(c) }))),
        first && (moment != null || showHost) && el('div', { class: 'msg-where' },
          moment != null && el('button', { class: 'tchip', title: 'Go to this frame', onclick: () => pickThread(c.id) }, el('span', { html: ICON.play }), fmtMoment(moment, fpsOf(c.on))),
          showHost && el('span', { class: 'msg-on', text: hostLabel(c) })),
        text));
  }

  function threadCard(root, showHost) {
    const active = activeThread === root.id;
    return el('div', {
      class: `cp-card${active ? ' active' : ''}${root.done ? ' done' : ''}`, 'data-id': root.id,
      onclick: (e) => {
        if (!e.target.closest('button, a, textarea')) pickThread(root.id);
      },
    },
    messageNode(root, root, showHost),
    repliesOf(root.id).map((r) => messageNode(r, root, false)),
    active && canWrite() && el('div', { class: 'cp-reply' }, replyBox, el('button', { class: 'btn small', text: 'Reply', onclick: submitReply })));
  }

  function renderPanel() {
    const shown = panelShown();
    panel.hidden = !shown;
    document.body.classList.toggle('cp-open', shown);
    $('comments').classList.toggle('active', shown);
    if (!shown) return;
    const host = focusId ? items.get(focusId) : null;
    let roots = rootsInOrder().filter((c) => (host ? c.on === host.id : items.has(c.on)));
    const any = roots.length > 0;
    const open = roots.filter((c) => !c.done).length;
    if (hideDone) roots = roots.filter((c) => !c.done);
    // Beside a video the threads follow the film; anywhere else, the order they were started in.
    if (host && host.type === 'video') roots.sort((a, b) => (momentOf(a) ?? -1) - (momentOf(b) ?? -1) || byTime(a, b));
    cpTitle.textContent = host ? 'Comments' : 'All comments';
    cpCount.hidden = !open;
    cpCount.textContent = String(open);
    const empty = any ? 'Everything here has been resolved.'
      : !host || !canWrite() ? 'No comments yet.'
        : viewOnly ? 'No comments yet. Write the first one below.'
          : 'No comments yet. Write the first one below, or draw on the picture to point at something.';
    drawnIds = new Set();
    for (const it of items.values()) if (it.cid) drawnIds.add(it.cid);
    // A reply half written keeps the keyboard and its place while the list is drawn again around it.
    const typing = document.activeElement === replyBox ? [replyBox.selectionStart, replyBox.selectionEnd] : null;
    const top = cpList.scrollTop;
    cpList.replaceChildren(...(roots.length ? roots.map((c) => threadCard(c, !host)) : [el('p', { class: 'cp-empty', text: empty })]));
    cpList.scrollTop = top;
    if (typing && replyBox.isConnected) {
      replyBox.focus({ preventScroll: true });
      replyBox.setSelectionRange(typing[0], typing[1]);
    }
    const foot = !host ? cpHint : canWrite() ? cpCompose : null;
    if (cpFoot.firstChild !== foot) cpFoot.replaceChildren(...(foot ? [foot] : []));
    cpFoot.hidden = !foot || (foot === cpHint && !canWrite());
    if (foot === cpCompose) buildInks();
    syncComposer();
  }

  function revealCard(id) {
    const card = [...cpList.children].find((node) => node.dataset.id === id);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }

  // Picks a thread: its card is raised and, on a video, the film goes to its frame, where what was drawn for it shows.
  function pickThread(id) {
    const c = comments.get(id);
    if (!c) return;
    if (c.on !== focusId) return goToComment(id);
    if (activeThread !== id) replyBox.value = '';
    activeThread = id;
    seekTo(c);
    syncComments();
    revealCard(id);
  }

  // Goes to where a comment was left. An image or video opens in the viewer, on the comment's frame,
  // with its thread picked in the panel. (A comment from before they were made in the viewer may sit on
  // a note or a heading: the board goes there, and its thread is picked in the list of them all.)
  function goToComment(id) {
    const c = comments.get(comments.get(id)?.re || id);
    const host = c && items.get(c.on);
    if (!host) return;
    if (host.type === 'image' || host.type === 'video') {
      if (focusId !== host.id) enterFocus(host.id);
    } else {
      if (focusId) exitFocus();
      userMovedView();
      fitRect(bounds(host), { dur: 420, maxZ: 1.5 });
    }
    if (activeThread !== c.id) replyBox.value = '';
    activeThread = c.id;
    seekTo(c);
    if (panelShown()) syncComments();
    else togglePanel(true);
    revealCard(c.id);
  }

  // ---- writing, resolving, deleting

  // C: to the comment box of what is open, opening what is selected first if need be.
  function startComment() {
    if (!canWrite()) return;
    if (!focusId) {
      const one = sel.size === 1 ? items.get([...sel][0]) : null;
      if (!one || (one.type !== 'image' && one.type !== 'video')) return void toast(`Open an image or video to comment on it: ${openHow} it`, { ms: 3200 });
      enterFocus(one.id);
    }
    if (!panelShown()) togglePanel(true);
    composer.focus({ preventScroll: true });
  }

  // Text pasted or dropped while a piece is open is on its way into a comment.
  function typeComment(text) {
    if (!canWrite()) return;
    if (!panelShown()) togglePanel(true);
    composer.focus({ preventScroll: true });
    composer.setRangeText(text.slice(0, 2000), composer.selectionStart, composer.selectionEnd, 'end');
    autosize(composer);
  }

  // A new thread on what is open. With something drawn for it, it is the comment the drawing was
  // waiting for, about the frame that was drawn on; otherwise it is about the frame showing.
  function submitComment() {
    const text = composer.value.trim();
    const host = focusId && items.get(focusId);
    if (!text || !host || !canWrite()) return;
    const drawn = draft && draft.on === host.id && drawnFor(draft.id).length ? draft : null;
    const item = { id: drawn ? drawn.id : uid(), type: 'comment', text: text.slice(0, 2000), name: me.name, color: me.color, t: Date.now(), done: false, on: host.id };
    if (!drawn) stampMoment(item);
    if (drawn && drawn.at != null) item.at = drawn.at;
    if (drawn && drawn.fr != null) item.fr = drawn.fr;
    composer.value = '';
    autosize(composer);
    draft = null;
    activeThread = item.id;
    replyBox.value = '';
    exec([{ t: 'add', item }]);
    // Back to the frame it is about, if the video has been moved since it was drawn on.
    if (drawn) seekTo(item);
    revealCard(item.id);
  }

  function submitReply() {
    const root = comments.get(activeThread);
    const text = replyBox.value.trim();
    if (!root || !text || !canWrite()) return;
    replyBox.value = '';
    autosize(replyBox);
    exec([{ t: 'add', item: { id: uid(), type: 'comment', text: text.slice(0, 2000), name: me.name, color: me.color, t: Date.now(), done: false, re: root.id, on: root.on } }]);
    revealCard(root.id);
  }

  // A thread goes with its replies and with what was drawn for it.
  function removeComment(c) {
    const ids = c.re ? [c.id] : [c.id, ...repliesOf(c.id).map((r) => r.id), ...drawnFor(c.id).filter((it) => it.pid === c.on).map((it) => it.id)];
    exec([{ t: 'del', ids }]);
  }

  function seekTo(c) {
    if (c.on) seekVideo(c.on, momentOf(c));
  }

  // ------------------------------------------------------------- tools and keyboard

  // Commenting is not among them: it is done in the viewer, beside what is being looked at.
  const TOOLS = [
    ['select', 'Select and move (V)', ICON.select],
    ['pan', 'Pan. Or hold Space and drag (H)', ICON.pan],
    null,
    ['upload', 'Add images or video. Or just drop or paste them', ICON.upload],
    ['note', 'Note. Click, or drag it onto the board (N)', ICON.note],
    ['text', 'Heading or text. Pick the level, then click or drag it out (T)', ICON.text],
    ['block', 'Coloured heading block. Click, or drag it onto the board (B)', ICON.block],
    ['frame', 'Frame the selection, or draw or drag out a frame (F)', ICON.frame],
    null,
    ['pen', 'Draw. Right-drag to erase (P)', ICON.pen],
    ['arrow', 'Arrow (A)', ICON.arrow],
    ['laser', 'Laser pointer, visible to everyone (L)', ICON.laser],
  ];

  const TOOL_LABELS = { select: 'Select', pan: 'Pan', upload: 'Media', note: 'Note', text: 'Heading', block: 'Block', frame: 'Frame', pen: 'Draw', arrow: 'Arrow', laser: 'Laser' };

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
    if (name === 'block') ghost.style.background = mute(BLOCK_COLORS[0]);
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
    if (!btn || e.button !== 0 || e.pointerType === 'touch' || !DRAGGABLE_TOOLS.has(btn.dataset.tool)) return;
    if (focusId) return;
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
    $('toolbar').replaceChildren(...TOOLS.filter((t) => !viewOnly || (t && (t[0] === 'pan' || t[0] === 'laser'))).map((t) => {
      if (!t) return el('span', { class: 'sep' });
      const [name, title, html] = t;
      return el('button', {
        class: 'iconbtn', 'data-tool': name, title, html,
        onclick: () => (suppressToolClick ? null : name === 'upload' ? $('filepick').click() : name === 'frame' ? activateFrame() : setTool(name)),
      }, el('span', { class: 'tl', text: TOOL_LABELS[name] }));
    }));
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
      // The fine brush an opened image starts with is for that image only; the usual size is what is kept.
      store('wb:pen', { ...pen, size: penBeforeFocus ?? pen.size });
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
    // The only tools a link has are the hand and the laser.
    if (viewOnly && name !== 'laser') name = 'pan';
    // The viewer has one tool, the brush: a press on the open piece draws. (And the laser, for pointing while talking.)
    else if (focusId && name !== 'laser') name = 'pen';
    tool = name;
    document.body.dataset.tool = name;
    for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === name);
    $('tooloptions').hidden = name !== 'pen' && name !== 'arrow' && name !== 'text';
    buildToolOptions();
    if (name !== 'select') setSel([]);
    sendP({ l: name === 'laser' ? 1 : 0 });
    requestLaser();
  }

  const TOOL_KEYS = { v: 'select', h: 'pan', n: 'note', t: 'text', b: 'block', f: 'frame', p: 'pen', a: 'arrow', l: 'laser' };

  // The video the keys are for: the open one in the viewer, the selected one out on the board.
  const keyVideo = () => (focusId ? (videoOf(focusId) ? focusId : null) : selectedVideo());

  // Space held is the hand for moving around; tapped, it plays or pauses, as in any player.
  let spaceTap = false;
  let spaceAt = 0;

  // Each key means one thing in the viewer and one thing on the board, whatever was clicked last:
  //   arrows      in the viewer, the next or previous image or video; on the board, nudge the selection
  //   , and .     one frame back or on (with Shift, a second), on the open or the selected video
  //   Space, K    play or pause
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target)) return;
    // A dialog is open over the board: its keys are its own, and Delete must not reach what is selected behind it.
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    // A control reached with Tab is pressed with Space or Enter, as anywhere else. (One clicked with the
    // mouse never keeps the focus, so on the board itself both stay canvas shortcuts.)
    if ((e.code === 'Space' || k === 'enter') && e.target.closest && e.target.closest('button, a[href], input')) return;
    // Looking around is all a read-only link allows.
    if (viewOnly) {
      const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
      const look = e.code === 'Space' || k === 'escape' || k === 'home' || k === '?' || k === 'h' || (k === 'l' && plain) || (focusId && k.startsWith('arrow'))
        || (e.shiftKey && e.code === 'Digit1') || ((e.ctrlKey || e.metaKey) && k === '0')
        || e.code === 'Comma' || e.code === 'Period' || k === 'k' || k === 'm' || (k === 'c' && plain && guestWrites()) || (k === 'c' && e.shiftKey && guestReads());
      if (!look) return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (!spaceDown) {
        spaceTap = true;
        spaceAt = performance.now();
      }
      spaceDown = true;
      document.body.classList.add('space');
      return;
    }
    const altGr = e.ctrlKey && e.altKey;
    if ((e.ctrlKey || e.metaKey) && !altGr) {
      if (k === 'z') e.shiftKey ? stepHistory(redoStack, undoStack) : stepHistory(undoStack, redoStack);
      else if (k === 'y') stepHistory(redoStack, undoStack);
      else if (k === 'a' && focusId) return;
      else if (k === 'a') { setTool('select'); setSel([...items.values()].filter((it) => selectable(it) && (focusId || !it.pid)).map((it) => it.id)); }
      else if (k === 'd') duplicate();
      else if (k === 'p') packSelection();
      else if (k === '0') {
        if (focusId) zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, actualSizeZ(items.get(focusId)) / cam.z);
        else { userMovedView(); zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1 / cam.z); }
      }
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey && !altGr) return;

    // With an image or video open the arrows go through the media, always: never a nudge, never a scrub.
    if (focusId && k.startsWith('arrow')) {
      e.preventDefault();
      return void stepFocus(k === 'arrowright' || k === 'arrowdown' ? 1 : -1);
    }

    const video = keyVideo();
    if (focusId && ((e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) || k === 'home')) fitFocus();
    else if (e.shiftKey && e.code === 'Digit1') { userMovedView(); fitAll(); }
    else if (e.shiftKey && e.code === 'Digit2') { const r = selBounds(); if (r) { userMovedView(); fitRect(r); } }
    else if (k === 'home') { userMovedView(); fitAll(); }
    else if (k === '?') toggleHelp();
    else if (k === 's' && !e.shiftKey) toggleSnap();
    else if (k === 'f' && !e.shiftKey) activateFrame();
    else if (k === 'c' && e.shiftKey) togglePanel();
    else if (k === 'c') startComment();
    else if (k === 'delete' || k === 'backspace') deleteSel();
    else if (k === 'escape') {
      // One thing at a time, the nearest first.
      if (!$('helppanel').hidden) toggleHelp();
      else if (focusId && tool === 'laser') setTool('pen');
      else if (focusId) exitFocus();
      else if (boardPanel) togglePanel(false);
      else if (tool !== 'select') setTool('select');
      else setSel([]);
    }
    else if (k === ']' || k === 'pageup') reorder(1);
    else if (k === '[' || k === 'pagedown') reorder(-1);
    else if (k.startsWith('arrow') && sel.size) {
      const step = (e.shiftKey ? 10 : 1) / cam.z;
      nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    }
    else if (k === 'enter' && sel.size === 1 && els.get([...sel][0]).querySelector('.txt')) startEdit([...sel][0]);
    else if (video && (k === 'k' || k === 'enter')) toggleVideo(video);
    else if (video && e.code === 'Comma') stepVideo(video, -1, e.shiftKey);
    else if (video && e.code === 'Period') stepVideo(video, 1, e.shiftKey);
    else if (video && k === 'm') toggleSound(video);
    // In the viewer there are no tools to change between, bar the laser, which L turns on and off.
    else if (focusId && k === 'l' && !e.shiftKey) setTool(tool === 'laser' ? 'pen' : 'laser');
    else if (TOOL_KEYS[k] && !e.shiftKey && !focusId) setTool(TOOL_KEYS[k]);
    else return;
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space') return;
    const tapped = spaceDown && spaceTap && performance.now() - spaceAt < 400;
    spaceDown = false;
    spaceTap = false;
    document.body.classList.remove('space');
    const video = tapped ? keyVideo() : null;
    if (video) toggleVideo(video);
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    spaceTap = false;
    document.body.classList.remove('space');
  });
  window.addEventListener('resize', () => (unframed ? frameFirst() : focusId ? relayoutViewer() : applyCam()));

  const HELP = [
    ['Pan', 'Space + drag, or middle drag'],
    ['Zoom', 'Mouse wheel'],
    ['Fit everything / selection', 'Shift+1 / Shift+2'],
    ['Add media', 'Drop files, or paste from the clipboard'],
    ['Place a note, heading, block or frame', 'Drag it out of the tool strip'],
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
    ['Smart snapping on / off', 'S, hold Ctrl to bypass'],
    ['Undo / redo', 'Ctrl+Z / Ctrl+Shift+Z'],
    ['Follow someone\'s view', 'Click their picture at the top'],
    ['Open an image or video in the viewer', 'Double-click it, Esc to close'],
    ['In the viewer: next / previous image or video', '→ / ←, or click one in the strip'],
    ['In the viewer: zoom, and move around', 'Wheel or pinch. Space + drag, or middle drag'],
    ['Play or pause video', 'Space or K'],
    ['Step video one frame / one second', ', and .  /  Shift + , and .'],
    ['Sound on / off', 'M'],
    ['Show time, frame number or timecode', 'Click the time on a video'],
    ['Comment on what is open', 'C, type, Enter'],
    ['Point at something in a comment', 'Draw on the picture: the drawing goes with the comment'],
    ['Erase a drawing in the viewer', 'Right-drag over it'],
    ['Laser pointer in the viewer', 'L, and L again for the brush'],
    ['Show or hide the comments', 'Shift+C'],
  ];

  function toggleHelp() {
    const help = $('helppanel');
    if (!help.children.length) {
      help.append(el('h2', { text: 'Shortcuts' }),
        el('dl', {}, HELP.flatMap(([what, keys]) => [el('dt', { text: what }), el('dd', { text: keys })])));
    }
    help.hidden = !help.hidden;
    // Out on the board the two would sit on top of each other.
    if (!help.hidden && boardPanel && !focusId) togglePanel(false);
  }
  $('help').addEventListener('click', toggleHelp);
  // A button left focused by a click would swallow Space and Enter, which are canvas shortcuts here, and
  // a tick box would too. Only for the pointer (a click made from the keyboard has no click count):
  // someone tabbing through the controls keeps their place.
  document.addEventListener('click', (e) => {
    const control = e.target.closest('button, input[type="checkbox"]');
    if (control && e.detail) control.blur();
  });
  $('zoom').addEventListener('click', () => {
    if (focusId) return fitFocus();
    userMovedView();
    fitAll();
  });

  // ------------------------------------------------------------- following

  function follow(id) {
    following = id;
    const peer = peers.get(id);
    if (peer && peer.p.f && items.has(peer.p.f)) followFocus(peer.p.f);
    else {
      if (focusId) exitFocus();
      if (peer && peer.p.v) followView(peer.p.v, 380);
    }
    updateFollowUI();
  }

  // Shows at least everything the followed person can see, whatever our window shape.
  function followView(v, dur = 140) {
    fitRect({ x: v[0], y: v[1], w: v[2], h: v[3] }, { inset: { t: 0, r: 0, b: 0, l: 0 }, dur, linear: dur < 200 });
  }

  function updateFollowUI() {
    if (following && !peers.has(following)) following = null;
    const target = peers.get(following);
    const ring = $('followring');
    ring.hidden = !target;
    if (target) ring.style.setProperty('--c', target.color);

    const pill = $('followpill');
    if (target) {
      pill.replaceChildren(
        el('i', { class: 'live', style: { background: target.color } }),
        el('span', { text: `Following ${target.name}` }),
        el('button', { class: 'btn small', text: 'Stop', onclick: userMovedView }));
    }
    pill.hidden = !target;
    renderPeers();
  }

  // ------------------------------------------------------------- peers, cursors, laser

  function renderPeers() {
    // People watching through a read-only link show as pointers on the board, not as avatars up here.
    const list = [...peers.values()].filter((peer) => !peer.viewer);
    const nodes = [
      ...list.slice(0, 8).map((peer) => el('button', {
        class: `avatar${following === peer.id ? ' following' : ''}`,
        style: { background: peer.color },
        title: `${peer.name}. Click to ${following === peer.id ? 'stop following' : 'follow their view'}`,
        text: WB.initials(peer.name),
        onclick: () => (following === peer.id ? userMovedView() : follow(peer.id)),
      })),
      list.length > 8 && el('span', { class: 'avatar more', text: `+${list.length - 8}` }),
      // Signed in, the name comes from the sign-in and is not something to change here.
      !viewOnly && (WB.info().user
        ? el('span', { class: 'avatar me fixed', style: { background: me.color }, title: `${me.name} (you)`, text: WB.initials(me.name) })
        : el('button', { class: 'avatar me', style: { background: me.color }, title: `${me.name} (you). Click to change your name`, text: WB.initials(me.name), onclick: rename })),
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
    peers.set(data.id, { id: data.id, name: data.name, color: data.color, p: data.p || {}, cur: null, viewer: !!data.viewer });
    placeCursor(peers.get(data.id));
    if (data.p && data.p.u) showRemoteStandIns(peers.get(data.id));
  }

  function dropPeer(id) {
    const peer = peers.get(id);
    if (!peer) return;
    if (peer.cur) peer.cur.remove();
    dropRemoteStandIns(id);
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
    WB.offline(false);

    for (const id of [...els.keys()]) {
      els.get(id).remove();
      els.delete(id);
    }
    items.clear();
    comments.clear();
    for (const it of msg.items) {
      if (it.type === 'comment') {
        comments.set(it.id, it);
        continue;
      }
      items.set(it.id, it);
      renderItem(it);
    }
    cmDirty = true;
    setBoardName(msg.board.name);
    // What was open may have been deleted while this window was disconnected.
    if (focusId && !items.has(focusId)) exitFocus();

    for (const id of [...peers.keys()]) dropPeer(id);
    for (const p of msg.peers) addPeer(p);

    // Anything done while disconnected is replayed on top of the server's state.
    for (const batch of queued) {
      applyOps(batch.ops);
      sendOps(batch.ops, batch.quiet);
    }
    setSel([...sel]);
    afterChange();
    refreshPeerSel();

    if (firstInit) {
      firstInit = false;
      // Frames close up around their contents as this page measures them. Notes and headings are
      // measured from the page, so this waits for the typeface: measured in a fallback face, every
      // frame holding text would come out a little wrong, for everyone.
      typeface.then(() => refitLive(frameIds()));
      frameFirst();
      // Opened from a notification: straight to the comment.
      const asked = /^#c=([\w-]+)$/.exec(location.hash);
      if (asked) {
        history.replaceState(null, '', location.pathname);
        goToComment(asked[1]);
      }
      if (viewOnly && [...items.values()].some((it) => it.type === 'image' || it.type === 'video')) {
        toast('Click an image or video to look closer', { ms: 7000 });
      }
    } else {
      applyCam();
    }
    sendP({ l: tool === 'laser' ? 1 : 0, f: focusId });
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
    } else if (msg.t === 'p') {
      const peer = peers.get(msg.id);
      if (!peer) return;
      Object.assign(peer.p, msg.p);
      if ('c' in msg.p || 'l' in msg.p) {
        placeCursor(peer);
        requestLaser();
      }
      if ('s' in msg.p) refreshPeerSel();
      if ('u' in msg.p) showRemoteStandIns(peer);
      if ('f' in msg.p && following === peer.id) followFocus(peer.p.f);
      if ('v' in msg.p && following === peer.id && !gesture) followView(peer.p.v);
    } else if (msg.t === 'laser') {
      const peer = peers.get(msg.id);
      if (peer) addRemoteLaser(peer, msg.pts);
    } else if (msg.t === 'media') {
      if (following !== msg.from) return;
      const video = videoOf(msg.id);
      if (!video) return;
      // Stopped, it shows exactly the frame of the person followed; playing, small drift is left alone rather than stutter.
      if (Math.abs(video.currentTime - msg.time) > (msg.playing ? 0.25 : 0.001)) video.currentTime = msg.time;
      if (msg.playing) video.play().catch(() => {});
      else video.pause();
    }
  }

  const metaUrl = viewOnly ? `/api/shared/${boardId}` : `/api/boards/${boardId}`;
  let dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${viewOnly ? 'share' : 'board'}=${boardId}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: me.name, color: me.color }));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      online = false;
      if (dead) return;
      if (e.code === 4003) return fatal('This board was moved to a workspace you cannot open.');
      if (e.code === 4004) return fatal('This board was deleted.');
      if (e.code === 4005) return fatal('This link is not shared any more.');
      // What the link allows changed: open it again as it is now.
      if (e.code === 4006) return location.reload();
      $('conn').hidden = false;
      WB.offline(true);
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 8000);
      checkAccess();
    };
  }

  // A connection that will not open is not always the network. The server may be answering and
  // turning this page away: the sign-in ran out (the request sends the page to sign in again), or the
  // board went while this window was disconnected. Retrying for ever would never say so.
  async function checkAccess() {
    try {
      await WB.api('GET', metaUrl);
    } catch (err) {
      if (err.status === 404) fatal(viewOnly ? 'This link is not shared any more.' : 'This board does not exist any more.');
    }
  }

  function fatal(text) {
    dead = true;
    WB.offline(false);
    document.body.replaceChildren(el('div', { class: 'fatal' },
      el('h1', { text }),
      !viewOnly && el('a', { class: 'btn primary', href: '/', text: 'Back to all boards' })));
  }

  // ------------------------------------------------------------- start

  me = await WB.askName();
  let meta;
  try {
    meta = await WB.api('GET', metaUrl);
  } catch {
    return fatal(viewOnly ? 'This link is not shared any more.' : 'This board does not exist.');
  }
  // Home opens on the workspace this board lives in.
  if (!viewOnly && meta.workspace) store('wb:workspace', meta.workspace);
  if (viewOnly) {
    setAccess(meta.access);
    $('boardname').readOnly = true;
    // The corner logo is not a way back to the team's boards for someone holding a link.
    $('back').removeAttribute('href');
    $('back').removeAttribute('title');
  }
  else $('back').href = meta.folderId ? `/#/f/${meta.folderId}` : '/';

  // ---- read-only link for this board
  if (!viewOnly && WB.info().canShare) {
    $('share').hidden = false;
    $('share').addEventListener('click', () => openShare(meta));
  }

  // Who can open the board: its workspace says who on the team, and a link, when it is on, who else
  // and what they may do there. Everything here takes effect at once; Done only closes.
  const ACCESS = [
    ['view', 'View only'],
    ['comments', 'View and read comments'],
    ['comment', 'View and comment'],
  ];
  const EXPIRY = [['never', 'Never', 0], ['1d', 'In 1 day', 864e5], ['7d', 'In 7 days', 7 * 864e5], ['30d', 'In 30 days', 30 * 864e5]];

  function openShare(meta) {
    // Never a localhost address: it would only open on this computer.
    // A configured public address first, then the address this page was opened from (a tunnel, say), then this computer's network addresses.
    const served = WB.info().shareBases || [];
    const here = /^(localhost$|127\.|\[::1\])/.test(location.hostname) ? [] : [location.origin];
    const bases = [...new Set([...served.filter((b) => b.startsWith('https:')), ...here, ...served])];
    if (!bases.length) bases.push(location.origin);
    let base = bases.includes(store('wb:sharebase')) ? store('wb:sharebase') : bases[0];
    let share = meta.share || { token: null };
    let busy = false;
    const dlg = el('dialog', { class: 'dlg share-dlg' });
    const call = async (method, path, body) => {
      if (busy) return;
      busy = true;
      try {
        const res = await WB.api(method, `/api/boards/${boardId}/share${path}`, body);
        share = method === 'DELETE' ? { token: null } : res;
        meta.share = share;
      } catch (err) {
        toast(err.message);
      }
      busy = false;
      paint();
    };
    const select = (options, value, onchange) => el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })));

    function paint() {
      const link = share.token && `${base}/s/${share.token}`;
      const input = link && el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Link', onfocus: (e) => e.target.select() });
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(link);
        } catch {
          input.select();
          document.execCommand('copy');
        }
        toast('Link copied');
      };
      const toggle = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Share with a link' });
      toggle.checked = !!share.token;
      toggle.addEventListener('change', () => call(toggle.checked ? 'POST' : 'DELETE', ''));
      const expiry = share.expiresAt
        ? [['set', `On ${new Date(share.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`], ...EXPIRY.filter((e) => e[0] !== 'set')]
        : EXPIRY;
      const team = meta.workspace === 'personal' ? 'Only you: it is in your personal workspace.' : 'Everyone on the team who can sign in.';
      dlg.replaceChildren(el('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() },
        el('h2', { text: `Share “${$('boardname').value || 'this board'}”` }),
        el('div', { class: 'share-row' }, el('span', { class: 'share-label', text: 'Team' }), el('span', { class: 'share-value', text: team })),
        el('label', { class: 'share-row share-switch' },
          el('span', { class: 'share-label', text: 'Link' }),
          el('span', { class: 'share-value', text: share.token ? 'Anyone with the link can open it, without signing in.' : 'Off. Turn it on to share outside the team.' }),
          toggle),
        link && el('div', { class: 'share-link' }, input, el('button', { type: 'button', class: 'btn primary', text: 'Copy', onclick: copy })),
        link && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'They can' }),
          select(ACCESS, share.access, (v) => call('PATCH', '', { access: v }))),
        link && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'Link ends' }),
          select(expiry, share.expiresAt ? 'set' : 'never', (v) => {
            const pick = EXPIRY.find((e) => e[0] === v);
            if (pick) call('PATCH', '', { expiresAt: pick[2] ? Date.now() + pick[2] : null });
          })),
        link && bases.length > 1 && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'Address' }),
          select(bases.map((b) => [b, b]), base, (v) => { base = v; store('wb:sharebase', base); paint(); })),
        link && !/^https:/.test(base) && el('p', { class: 'share-note', text: 'This address only works for people on the same network as this computer. For people elsewhere, set up a public address (see DEPLOY.md).' }),
        link && share.access === 'comment' && el('p', { class: 'share-note', text: 'People with the link comment under a name they type themselves. They cannot resolve or delete anything.' }),
        el('div', { class: 'dlg-actions' },
          link && el('button', { type: 'button', class: 'btn ghost share-reset', text: 'New link', title: 'Make a new link. The current one stops working at once.', onclick: () => call('POST', '/reset') }),
          el('button', { type: 'button', class: 'btn', text: 'Done', onclick: () => dlg.close() }))));
    }
    dlg.addEventListener('close', () => dlg.remove());
    paint();
    document.body.append(dlg);
    dlg.showModal();
  }
  $('themeslot').replaceWith(WB.themeButton());
  window.addEventListener('wb:theme', () => {
    for (const it of items.values()) renderItem(it);
    seltools.dataset.sig = '';
    buildToolOptions();
    updateOverlay();
    syncComments();
  });
  $('commentsicon').innerHTML = ICON.comment;
  $('comments').addEventListener('click', () => togglePanel());
  $('snap').innerHTML = ICON.snap;
  $('snap').classList.toggle('active', snapOn);
  $('snap').addEventListener('click', toggleSnap);
  $('focusdone').addEventListener('click', exitFocus);
  $('focusprev').innerHTML = ICON.prev;
  $('focusnext').innerHTML = ICON.next;
  $('focusprev').addEventListener('click', () => stepFocus(-1));
  $('focusnext').addEventListener('click', () => stepFocus(1));
  $('focusclear').addEventListener('click', clearDrawing);
  $('focuszoom').addEventListener('click', () => toggleFocusZoom());
  buildToolbar();
  setTool('select');
  applyCam();
  connect();
  // Text is measured from the page, so measure again once the typeface has arrived.
  typeface.then(updateOverlay);
})();
