'use strict';

(async () => {
  const { el, store } = WB;
  // Bringing files in is the same everywhere: see ingest.js.
  const { IMG_EXT, VID_EXT, fileExt, upload, loadImage, probeVideo, brightness, pickFrame, beyondThisBrowser, tellRefused, ingest, videoWave } = WBIngest;
  const $ = (id) => document.getElementById(id);

  // /s/<secret> is a read-only link: anyone holding it can watch the board and nothing else.
  // /p/<secret>/b/<board> is a board somebody is presenting (see watch.js, which holds it in a frame): it
  // is watched as through a read-only link, but only ever where the presenter is, following them.
  const watchToken = (/^\/p\/([\w-]+)\/b\/[\w-]+\/?$/.exec(location.pathname) || [])[1] || null;
  const spectating = !!watchToken;
  const viewOnly = location.pathname.startsWith('/s/') || spectating;
  document.body.classList.toggle('viewonly', viewOnly);
  document.body.classList.toggle('spectating', spectating);
  // What a link lets its holder do: 'view', also read comments ('comments'), or also comment ('comment').
  let shareAccess = 'view';
  const guestReads = () => viewOnly && shareAccess !== 'view';
  const guestWrites = () => viewOnly && shareAccess === 'comment';
  function setAccess(access) {
    shareAccess = access || 'view';
    document.body.classList.toggle('guest-reads', guestReads());
    document.body.classList.toggle('guest-writes', guestWrites());
  }
  const boardId = location.pathname.split('/').filter(Boolean)[spectating ? 3 : 1];
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
  // Ink colours, and the shape of a drawn line: see ink.js, shared with the player.
  const { INK, LASER_LIFE, isLight, inkColor, svgEl, fillText, pathData, outlinePath, pointSegDist, tone, mute, deepen, PIGMENTS } = WBInk;
  const NOTE_FILLS = ['note', '#fff2a8', '#ffd3d1', '#d4f1d2', '#d0e6ff', '#e7dbff'];
  // 'ink' and 'note' stand for the theme's own text and note colours, so a board reads well in either theme.
  const isPlainNote = (c) => c === 'note';
  const noteColor = (c) => (isPlainNote(c) ? (isLight() ? '#ffffff' : '#2a2a2a') : c);
  const NOTE_INK = { light: '#1a1a1a', dark: '#f0f0f0' };

  // Notes take the theme's side: pale paper with dark writing on light, a tinted slate with light
  // writing on dark, so a coloured note is no brighter than a plain one.
  const noteFill = (c) => (isPlainNote(c) ? noteColor(c) : isLight() ? tone(c, 0.94, 0.06, [0.9, 0.97]) : tone(c, 0.42, 0.075, [0.26, 0.4]));
  const swatchColor = (c) => (c === 'ink' ? inkColor(c) : c === 'note' ? noteColor(c) : c);
  const BLOCK_COLORS = PIGMENTS.map(([c]) => c);
  // A frame starts untinted; its header can take any pigment but graphite, which is next to untinted.
  const FRAME_COLORS = ['#8a8a93', ...BLOCK_COLORS.slice(1)];
  const PIGMENT_NAMES = new Map([['#8a8a93', 'No colour'], ...PIGMENTS]);
  const PEN_SIZES = [4, 8, 16];
  const FRAME_PAD = 28;
  // World-unit sizes for new items: what you get does not depend on how far you are zoomed in.
  // Sized to what the standup board settled on: a still is about 750 wide, a frame holds one at 806.
  const IMG_W = 750;
  const IMG_MAX_H = 1080;
  const NOTE_W = 260;
  const NOTE_FS = 16;
  // A note is made to be read where it is made: on a board zoomed out, a new note is made larger, in a few
  // steps (so notes made at about the same zoom match), until its writing is near its usual size on screen.
  // Zoomed in, it is the usual note.
  const NOTE_STEPS = [1, 1.5, 2, 3, 4, 6];
  // A frame starts at the width it needs to hold one piece of media at its imported width, and a block
  // at the same width as a frame, since it usually sits above one as its header.
  const FRAME_W = IMG_W + 2 * FRAME_PAD;
  const FRAME_H = 750;
  // Every frame has a header band for its title and a count; blocks are free-standing coloured headings.
  const FRAME_HEAD = 80;
  const BLOCK_W = FRAME_W;
  // A block is a band, as tall as one line of its heading: only its width changes.
  const BLOCK_H = 120;
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
  const noteScale = () => NOTE_STEPS.find((s) => s * cam.z >= 0.8) || NOTE_STEPS[NOTE_STEPS.length - 1];
  const COLORABLE = new Set(['note', 'text', 'frame', 'block', 'stroke']);
  const ITEM_TYPES = new Set(['image', 'video', 'note', 'text', 'frame', 'block', 'stroke']);
  const ICON = WB.iconSet(20); // icons.js
  const CURSOR_SVG = '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M1 1l4.5 13 2.2-5.3L13 6.5z" fill="var(--c)" stroke="#fff" stroke-width="1"/></svg>';

  // ------------------------------------------------------------- state

  const items = new Map();       // id -> item; the shared document
  const comments = new Map();    // id -> comment; kept apart from items so they never take part in layout, snapping or fitting
  const versionInfo = new Map(); // catalogue version id -> what it is called, and whether there is a newer one (see the catalogue below)
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

  let me = null;
  let ws = null;
  let online = false;
  let firstInit = true;
  let booted = false;
  let orderDirty = true;         // the pieces' reading order (mediaOrder) needs working out again            // the board's panels and tools exist: until then the keys do nothing
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
  let cmDirty = false;
  let project = null;            // the project this board is in, if it is in one: { id, name, naming }
  let showPresent = () => {};    // the bar's Present button, shown on a board in a project (see presenting, below)

  // ------------------------------------------------------------- helpers

  // Settles when the typeface text is measured in has arrived, or after two seconds without it.
  const typeface = document.fonts && document.fonts.load
    ? Promise.race([document.fonts.load('16px Inter'), new Promise((resolve) => setTimeout(resolve, 2000))]).catch(() => {})
    : Promise.resolve();

  const { clamp, uid, isTyping } = WB;
  const round = (v) => Math.round(v * 10) / 10;

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
    if (it.type === 'block') return { x: it.x, y: it.y, w: it.w, h: BLOCK_H };
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }

  function topZ() {
    let z = 0;
    for (const it of items.values()) if ((it.z || 0) > z) z = it.z;
    return z;
  }

  const toast = WB.toast;

  // ------------------------------------------------------------- camera

  function applyCam() {
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
    updateOverlay();
    for (const peer of peers.values()) placeCursor(peer);
    const v = viewRect();
    sendP({ v: [round(v.x), round(v.y), round(v.w), round(v.h)] });
    scheduleSettle();
    if (laserActive()) requestLaser();
    scheduleCull();
  }

  // Browsers allow a page only so many video players (a phone very few), so a video far off screen lets
  // go of its player and shows its still; coming back into view, it takes one again. One that is
  // playing keeps it.
  let cullTimer = 0;
  function scheduleCull() {
    clearTimeout(cullTimer);
    cullTimer = setTimeout(cull, 300);
  }
  function cull() {
    const v = viewRect();
    const m = Math.max(v.w, v.h) * 0.5;
    const near = { x: v.x - m, y: v.y - m, w: v.w + 2 * m, h: v.h + 2 * m };
    for (const it of items.values()) {
      if (it.type !== 'video') continue;
      const node = els.get(it.id);
      const video = node && node.firstChild;
      if (!video || video.tagName !== 'VIDEO') continue;
      const close = intersects(near, it);
      if (!close && !video.dataset.parked && video.paused) {
        video.dataset.parked = '1';
        delete video.dataset.whole;
        video.removeAttribute('src');
        video.load();
        node.classList.remove('started');
      } else if (close && video.dataset.parked) {
        delete video.dataset.parked;
        video.src = video.dataset.src;
      }
    }
  }

  let settleTimer = 0;
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // Not before the board has loaded and been framed: the view remembered from last time is still waiting to be read.
      // Nor while something is open in the viewer: what is remembered is where the board was left, not a close-up of one piece.
      if (!firstInit && !unframed) store(`wb:cam:${boardId}`, { x: cam.x, y: cam.y, z: cam.z, w: vp.clientWidth });
      checkRes();
    }, 200);
  }

  function stopCamAnim() {
    cancelAnimationFrame(camAnim);
    clearTimeout(camTimer);
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
    // While frames keep coming the move is theirs to finish, however slowly they come.
    let lastFrame = performance.now();
    const land = () => {
      if (performance.now() - lastFrame < 250) {
        camTimer = setTimeout(land, 250);
        return;
      }
      setCam(to.x, to.y, to.z);
    };
    camTimer = setTimeout(land, dur + 150);
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const z0 = cam.z;
    const c0 = { x: cam.x + vw / 2 / z0, y: cam.y + vh / 2 / z0 };
    const c1 = { x: to.x + vw / 2 / to.z, y: to.y + vh / 2 / to.z };
    // How much of the move has been shown, in milliseconds. A slow frame (the whole board coming back
    // into sight at once when the viewer closes, say) takes it no further than a quick one would, so
    // the move slows down for a moment instead of jumping ahead. The first frame shows where it starts.
    let shown = 0;
    let last = 0;
    const tick = (now) => {
      if (last) shown += Math.min(now - last, 40);
      last = now;
      lastFrame = performance.now();
      const k = Math.min(1, shown / dur);
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

  // The view a board opens on: where this browser left it, otherwise everything. A view left in a window
  // of a very different width (a phone turned, a window made narrow) would cut the board off at one side,
  // so then it opens on everything too. A window that has no size yet (opened minimised, or in a pane
  // that is not showing) cannot be framed, so that waits until it has one instead of settling on a speck
  // in the corner and remembering it.
  let unframed = false;
  function frameFirst() {
    unframed = !vp.clientWidth || !vp.clientHeight;
    if (unframed) return;
    const saved = store(`wb:cam:${boardId}`);
    const sameWidth = saved && saved.w > 0 && saved.w / vp.clientWidth > 0.75 && saved.w / vp.clientWidth < 1.33;
    if (sameWidth && isFinite(saved.x) && isFinite(saved.y) && saved.z > 0) setCam(saved.x, saved.y, saved.z);
    else fitAll(0);
  }

  // Any manual pan or zoom means the viewer wants their own view back.
  function userMovedView() {
    stopCamAnim();
    stopFollowing();
  }

  function stopFollowing() {
    if (!following || spectating) return;
    following = null;
    updateFollowUI();
  }

  // ------------------------------------------------------------- rendering

  function buildVideo(it, node) {
    const video = el('video', { playsinline: true, loop: true, preload: 'metadata' });
    video.muted = true;
    const play = el('button', { class: 'vbtn', html: ICON.play, title: 'Play / pause (K)', onclick: () => toggleVideo(it.id) });
    // The slider is for the pointer only. Left holding the keyboard after a click, it would turn the arrow
    // keys into a scrub and keep them from the board.
    const seek = el('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, tabindex: -1, 'aria-label': 'Seek' });
    // Where the video's comments are; filled in by placeMarks.
    const marks = el('div', { class: 'vmarks' });
    const time = el('button', { class: 'vtime', text: '0:00', title: 'Show minutes and seconds, frame number or timecode', onclick: cycleTimeMode });
    const sound = el('button', { class: 'vbtn', html: ICON.muted, title: 'Sound on / off (M)', onclick: () => { video.muted = !video.muted; } });
    video.addEventListener('volumechange', () => {
      sound.innerHTML = video.muted ? ICON.muted : ICON.sound;
    });
    const tick = (at = whereOf(video)) => {
      // On its way to another source it has no length for a moment: what is showing stays as it is.
      if (changing.has(video) && !(video.duration > 0)) return;
      if (video.duration && !seek.matches(':active')) seek.value = Math.round((at / video.duration) * 1000);
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      if (seek.parentNode) seek.parentNode.style.setProperty('--p', `${seek.value / 10}%`);
      time.textContent = timeLabel(at, video.duration, fpsOf(it.id));
    };
    video.wbTick = tick;
    seek.addEventListener('input', () => {
      if (!video.duration) return;
      const at = wholeFrame(it.id, (seek.value / 1000) * video.duration);
      goTo(video, at);
      seek.style.setProperty('--p', `${seek.value / 10}%`);
      if (seek.parentNode) seek.parentNode.style.setProperty('--p', `${seek.value / 10}%`);
      // The time follows the hand, not the picture, which may still be on its way.
      time.textContent = timeLabel(at, video.duration, fpsOf(it.id));
      sendMedia(it.id);
    });
    seek.addEventListener('change', () => seek.blur());
    // Taken hold of, the video is wanted whole: from the disk if it is kept there, otherwise fetched, so
    // that the next drag through it does not wait for the network. It changes over once the hand lets go.
    // A playing video is held still while the hand moves and runs on after, as on the timeline. Left
    // running it would be past its end, and so back at its start, under a hand that holds it at the end.
    let resume = false;
    seek.addEventListener('pointerdown', () => {
      boardScrub = it.id;
      resume = !video.paused;
      video.pause();
      holdWhole(it.id);
    });
    for (const type of ['pointerup', 'pointercancel', 'change']) {
      seek.addEventListener(type, () => {
        if (boardScrub !== it.id) return;
        boardScrub = null;
        if (resume && !atEndOf(it.id)) video.play().catch(() => {});
        resume = false;
        sendMedia(it.id);
      });
    }
    video.addEventListener('timeupdate', () => tick());
    video.addEventListener('loadedmetadata', () => {
      tick();
      queueMarks();
    });
    // While it plays the counter follows each frame as it is shown, where the browser says which that is.
    const onFrame = (now, meta) => {
      // Firefox goes on counting past the end of a video that has started over.
      tick(video.duration > 0 && isFinite(video.duration) ? meta.mediaTime % video.duration : meta.mediaTime);
      if (!video.paused) video.requestVideoFrameCallback(onFrame);
    };
    video.addEventListener('seeked', () => {
      tick();
    });
    // Clicks on the big button are handled by the pointer gesture so the video can still be dragged by it.
    const center = el('div', { class: 'vplay', html: ICON.play, 'aria-hidden': 'true' });
    for (const type of ['play', 'pause']) {
      video.addEventListener(type, () => {
        play.innerHTML = video.paused ? ICON.play : ICON.pause;
        center.innerHTML = video.paused ? ICON.play : ICON.pause;
        node.classList.toggle('playing', !video.paused);
        if (!video.paused && video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame);
      });
    }
    // The still the video was filed with stays over it until it is played or scrubbed, so what shows is
    // never the bare first frame, or nothing at all while it loads.
    const post = el('img', { class: 'vpost', alt: '', draggable: 'false', decoding: 'async' });
    // From then on the video has no still of its own either. Safari goes on showing a video's poster
    // through every seek until it is played, so a video that was moved to another source while stopped
    // (as an open one is, once it has arrived whole) would sit on its still while the playhead moved.
    for (const type of ['play', 'seeking']) {
      video.addEventListener(type, () => {
        if (type !== 'play' && !(video.currentTime > 0.05)) return;
        node.classList.add('started');
        video.removeAttribute('poster');
      });
    }
    node.append(video, post, center, el('div', { class: 'vbar' }, play, el('div', { class: 'vseek' }, seek, marks), time, sound));
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
    if (it.type === 'image' || it.type === 'video') {
      node.dataset.name = it.name || '';
      paintVerChip(node, it);
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
      const still = it.poster || it.th;
      if (still && !node.classList.contains('started') && video.getAttribute('poster') !== still) video.poster = still;
      const post = node.querySelector('.vpost');
      if (post && post.dataset.src !== (still || '')) {
        post.dataset.src = still || '';
        if (still) post.src = still;
        else post.removeAttribute('src');
        post.hidden = !still;
      }
      // Its phone copy on a phone (see WB.playable), its review copy otherwise.
      const plays = WB.playable(it);
      if (video.dataset.src !== plays) {
        video.dataset.src = plays;
        delete video.dataset.whole;
        delete video.dataset.parked;
        video.src = plays;
        queueAhead();
        scheduleCull();
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
      node.dataset.lvl = it.lvl;
      st.fontSize = `${it.fs}px`;
      st.color = inkColor(it.color);
      if (!isEditing) fillText(node.firstChild, it.text);
    } else if (it.type === 'frame') {
      st.width = `${it.w}px`;
      st.height = `${it.h}px`;
      const tinted = it.color !== FRAME_COLORS[0];
      const headColor = tinted ? deepen(it.color) : FRAME_COLORS[0];
      st.setProperty('--c', headColor);
      node.dataset.tint = tinted ? '1' : '';
      st.setProperty('--head-ink', '#fff');
      if (!isEditing) node.firstChild.firstChild.textContent = it.title || '';
    } else if (it.type === 'block') {
      const fill = mute(it.color);
      st.width = `${it.w}px`;
      st.height = `${BLOCK_H}px`;
      st.fontSize = `${BLOCK_FS}px`;
      st.background = fill;
      st.color = '#ffffff';
      node.dataset.align = it.align;
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
    if (editing && editing.id === id) editing = null;
    items.delete(id);
    sel.delete(id);
    fullRes.delete(id);
    const node = els.get(id);
    if (node) node.remove();
    els.delete(id);
  }

  // Boards show a downscaled preview until an image is zoomed past its resolution, and go back to it
  // once the image is shown small again: every original opened in the viewer and kept would make the
  // whole board heavier to move around, most of all when the viewer closes and all of it comes back.
  function checkRes() {
    const dpr = window.devicePixelRatio || 1;
    const view = viewRect();
    for (const it of items.values()) {
      if (it.type !== 'image' || !it.prev) continue;
      if (fullRes.has(it.id)) {
        if (it.w * cam.z * dpr < it.pw * 0.75) {
          fullRes.delete(it.id);
          renderItem(it);
        }
      } else if (it.w * cam.z * dpr > it.pw * 1.1 && intersects(view, it)) {
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
  // Every batch this page sends is numbered, under a name for this page that lasts across reconnects
  // (`cid`). The server applies a number only once and says which it has applied, so a batch sent again
  // after a dropped connection is never applied twice, and an ack always settles the right batch.
  const cid = uid();
  let seq = 0;
  const sendBatch = (b) => ws.send(JSON.stringify({ t: 'op', ops: b.ops, seq: b.seq, ...(b.quiet && { quiet: true }) }));

  function sendOps(ops, quiet = false) {
    // Somebody with a link sends nothing, unless it lets them comment, and then only comments.
    if (!ops.length || (viewOnly && !(guestWrites() && ops.every((op) => op.t === 'add' && op.item.type === 'comment')))) return;
    const batch = { ops, keys: keysOf(ops), quiet, seq: ++seq };
    for (const k of batch.keys) pendingKeys.set(k, (pendingKeys.get(k) || 0) + 1);
    outbox.push(batch);
    if (online) sendBatch(batch);
  }

  // Settles every batch up to the one acked (an ack without a number, from an older server, settles the
  // oldest).
  function onAck(msg = {}) {
    while (outbox.length && (msg.seq == null ? true : outbox[0].seq <= msg.seq)) {
      const batch = outbox.shift();
      for (const k of batch.keys) {
        const n = pendingKeys.get(k) - 1;
        if (n > 0) pendingKeys.set(k, n);
        else pendingKeys.delete(k);
      }
      if (msg.seq == null) break;
    }
  }

  // The server applies ops in arrival order. A remote write that reaches us while our own
  // write to the same property is still unacknowledged was applied before ours, so it lost.
  function applyOps(ops, remote = false) {
    for (const op of ops) {
      if (op.t === 'add') {
        if (op.item.type === 'comment') {
          // Told only of a comment that is new here: not one brought along with a version put on the
          // board, nor one that has only been resolved or moved to another piece showing its version.
          const fresh = remote === true && !op.item.re && !comments.has(op.item.id);
          comments.set(op.item.id, { ...op.item });
          cmDirty = true;
          if (fresh) toast(`${op.item.name} commented on ${hostLabel(op.item)}`);
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
        if (typeof op.patch.name === 'string') setBoardName(op.patch.name);
        if (op.patch.settings) applySettings(op.patch.settings);
      }
    }
    afterChange(ops);
  }

  // Keys that only move or size a piece: a peer dragging something changes nothing else, and its many
  // small ops a second should not recount frames, rebuild the marks on every video or the open viewer.
  const GEOMETRY = new Set(['x', 'y', 'w', 'h', 'z', 'auto']);
  const onlyGeometry = (ops) => !!ops && ops.every((op) => op.t === 'set' && !comments.has(op.id) && Object.keys(op.patch || {}).every((k) => GEOMETRY.has(k)));
  // Whether the ops change which piece is in which frame (or what pieces there are).
  const reframes = (ops) => !ops || ops.some((op) => op.t !== 'set' || 'fid' in (op.patch || {}) || 'type' in (op.patch || {}));

  // After the document changed: `ops` when it is known what changed, to do only what that needs.
  function afterChange(ops) {
    $('hint').hidden = items.size > 0;
    const marksToo = cmDirty || !ops || ops.some((op) => op.t !== 'set' || 'dur' in (op.patch || {}) || 'src' in (op.patch || {}));
    if (cmDirty) {
      cmDirty = false;
      syncComments();
    }
    if (reframes(ops)) updateFrameCounts();
    updateOverlay();
    if (marksToo) queueMarks();
    if (!onlyGeometry(ops) && viewer.isOpen()) viewer.refresh();
    orderDirty = true;
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
    syncHistory();
  }

  // The undo and redo buttons, there for a phone, where there is no keyboard to press Ctrl+Z on.
  function syncHistory() {
    for (const [act, stack] of [['undo', undoStack], ['redo', redoStack]]) {
      const b = $('toolbar').querySelector(`[data-act="${act}"]`);
      if (b) b.disabled = !stack.length;
    }
  }

  function exec(ops, record = true) {
    flushLive();
    const inverse = invert(ops);
    applyOps(ops);
    sendOps(ops);
    if (record) pushUndo(inverse);
  }

  function stepHistory(from, to) {
    // A nudge still being made is a step of its own first.
    if (nudging) {
      clearTimeout(nudging.timer);
      const done = nudging;
      nudging = null;
      recordSince(done.snap);
    }
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
    syncHistory();
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

  // What this hand has changed during each gesture that is going on: id -> the keys it set. A gesture's
  // undo takes back only those, never what somebody else changed on the board meanwhile.
  const touching = new Set();

  // Continuous edits (drags, typing) apply locally at once and reach the network in batches.
  function liveSet(id, patch) {
    const it = items.get(id);
    if (!it) return;
    for (const t of touching) {
      if (!t.has(id)) t.set(id, new Set());
      for (const k of Object.keys(patch)) t.get(id).add(k);
    }
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

  // The board as it was when a gesture began, and from then on a note of what this hand changes in it.
  function snapshot(ids) {
    const snap = new Map();
    for (const id of ids) {
      const it = items.get(id);
      if (it) snap.set(id, { ...it });
    }
    snap.touched = new Map();
    touching.add(snap.touched);
    return snap;
  }

  // Turns what this hand changed since `snap` into a single undo step: the keys it set, back to what
  // they were. A peer moving something else, or recolouring what was being dragged, is left alone.
  function recordSince(snap, extra = []) {
    flushLive();
    touching.delete(snap.touched);
    const inverse = [];
    for (const [id, keys] of snap.touched || []) {
      const before = snap.get(id);
      const it = items.get(id);
      if (!before || !it) continue;
      const patch = {};
      for (const k of keys) if (before[k] !== it[k]) patch[k] = before[k] ?? null;
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

  function selBounds(of = bounds) {
    let r = null;
    for (const id of sel) {
      const it = items.get(id);
      if (it) r = union(r, of(it));
    }
    return r;
  }

  const narrow = () => vp.clientWidth < 700;
  // How much of the bottom of the screen the tools take on a phone.
  function bottomChrome() {
    const tb = $('toolbar');
    return tb.offsetParent ? Math.max(0, vp.clientHeight - tb.getBoundingClientRect().top) : 8;
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
    // One frame can be stretched from any side; one note from its left or right (its text decides its
    // height); one block only from its left or right, as its height is fixed.
    const one = sel.size === 1 ? items.get([...sel][0]) : null;
    selbox.classList.toggle('sides', !!one && one.type === 'frame');
    selbox.classList.toggle('sides-x', !!one && (one.type === 'note' || one.type === 'block'));
    selbox.classList.toggle('width-only', !!one && one.type === 'block');
    selbox.style.transform = `translate(${a.x}px, ${a.y}px)`;
    selbox.style.width = `${w}px`;
    selbox.style.height = `${h}px`;

    const dragging = gesture && gesture.type !== 'pan';
    seltools.hidden = !!dragging;
    if (seltools.hidden) return;
    buildSelTools();
    const tw = seltools.offsetWidth;
    const th = seltools.offsetHeight;
    // Clear of the strip of tools: down the left on a wide screen, along the bottom on a phone.
    const phone = narrow();
    const edge = phone ? 8 : 90;
    let ty = a.y - th - 12;
    if (ty < 56) ty = Math.min(a.y + h + 12, vp.clientHeight - th - 12 - (phone ? bottomChrome() : 0));
    seltools.style.left = `${clamp(a.x + w / 2 - tw / 2, edge, Math.max(edge, vp.clientWidth - tw - (phone ? 8 : 12)))}px`;
    seltools.style.top = `${Math.max(56, ty)}px`;
  }

  function buildSelTools() {
    const list = [...sel].map((id) => items.get(id)).filter(Boolean);
    const types = new Set(list.map((it) => it.type));
    const one = list.length === 1 ? list[0] : null;
    // Blocks, however many, are aligned together.
    const blocks = types.size === 1 && types.has('block') ? list : null;
    const align = blocks && blocks.every((it) => it.align === blocks[0].align) ? blocks[0].align : null;
    const sig = `${[...types].sort().join()}|${Math.min(list.length, 2)}|${one ? `${one.lvl}${one.auto}` : ''}|${align}|${project ? fileable(list).length : 0}`;
    if (seltools.dataset.sig === sig) return;
    seltools.dataset.sig = sig;

    const btn = (html, title, onclick) => el('button', { class: 'iconbtn', html, title, onclick });
    const kids = [];
    if (list.some((it) => COLORABLE.has(it.type))) {
      const only = types.size === 1 ? [...types][0] : null;
      const palette = only === 'note' ? NOTE_FILLS : only === 'frame' ? FRAME_COLORS : only === 'block' ? BLOCK_COLORS : INK;
      for (const c of palette) {
        kids.push(el('button', { class: 'swatch', style: { background: only === 'note' ? noteFill(c) : only === 'block' ? mute(c) : only === 'frame' ? (c === FRAME_COLORS[0] ? c : deepen(c)) : swatchColor(c) }, title: (only === 'block' || only === 'frame') && PIGMENT_NAMES.get(c) || 'Set colour', onclick: () => colorSel(c) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    if (types.has('text')) {
      for (const l of TEXT_LEVELS) {
        kids.push(el('button', { class: `lvl${one && one.lvl === l.lvl ? ' active' : ''}`, title: l.title, text: l.label, onclick: () => setLevel(l.lvl) }));
      }
      kids.push(el('span', { class: 'sep' }));
    }
    if (blocks) {
      for (const [a, html, title] of [['left', ICON.alignL, 'Align left'], ['center', ICON.alignC, 'Centre']]) {
        kids.push(el('button', { class: `iconbtn${align === a ? ' active' : ''}`, html, title, onclick: () => alignBlocks(a) }));
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
    if (one && onServer(one)) kids.push(btn(ICON.download, downloadTitle(one), () => downloadPiece(one.id)));
    if (project && !viewOnly && fileable(list).length) kids.push(btn(ICON.file, fileable(list).length > 1 ? `File these ${fileable(list).length} as versions in ${project.name} (Shift+V)` : `File as a version in ${project.name} (Shift+V)`, () => fileSelection()));
    kids.push(btn(ICON.trash, 'Delete (Del)', deleteSel));
    seltools.replaceChildren(...kids);
  }

  // ------------------------------------------------------------- item actions

  function alignBlocks(align) {
    const ops = [];
    for (const id of sel) {
      const it = items.get(id);
      if (it && it.type === 'block' && it.align !== align) ops.push({ t: 'set', id, patch: { align } });
    }
    if (ops.length) exec(ops);
  }

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
    if (it.type === 'block') return { w: round(it.w * s), h: BLOCK_H };
    const patch = { w: round(it.w * s), h: round((it.h || 0) * s) };
    if (it.type === 'note') patch.fs = round(it.fs * s);
    if (it.type === 'stroke') patch.size = round(it.size * s);
    return patch;
  }

  // Nudges a moment apart are one move: one undo step, and sent together, however long the key is held.
  let nudging = null; // { snap, timer }
  function nudge(dx, dy) {
    const ids = movingIds();
    if (!nudging) nudging = { snap: snapshot(ids) };
    for (const id of ids) {
      const it = items.get(id);
      if (!it) continue;
      if (!nudging.snap.has(id)) nudging.snap.set(id, { ...it });
      liveSet(id, { x: round(it.x + dx), y: round(it.y + dy) });
    }
    updateOverlay();
    clearTimeout(nudging.timer);
    nudging.timer = setTimeout(() => {
      const done = nudging;
      nudging = null;
      recordSince(done.snap);
    }, 600);
  }

  // ------------------------------------------------------------- frames, drawings, snapping

  const hasPoint = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });
  const area = (r) => r.w * r.h;
  const overlapArea = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

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

  // Everything on the board can be selected. (Kept as the one place to say otherwise.)
  const selectable = (it) => !!it;

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
    let bestRank = -1;
    let bestHits = 0;
    for (const it of items.values()) {
      if (it.type === 'stroke' || it.id === drawing.id || !selectable(it)) continue;
      const zone = grow(bounds(it), reach);
      let hits = 0;
      for (const s of samples) if (hasPoint(zone, s)) hits++;
      if (!hits) continue;
      const rank = it.type === 'frame' ? 0 : 1;
      if (rank > bestRank || (rank === bestRank && (hits > bestHits || (hits === bestHits && (it.z || 0) > (best.z || 0))))) {
        best = it;
        bestRank = rank;
        bestHits = hits;
      }
    }
    return best;
  }

  // Makes a frame (gathering loose pieces inside it) or a colour block covering `r`, and starts
  // naming it. Shared by drawing one out with the tool and dropping one from the toolbar.
  function makeFrameLike(kind, r) {
    if (kind === 'block') {
      // Drawn out, a block takes the width drawn; its height is always the same.
      const block = { id: uid(), type: 'block', x: round(r.x), y: round(r.y + (r.h - BLOCK_H) / 2), w: round(r.w), h: BLOCK_H, text: '', color: BLOCK_COLORS[0], fs: BLOCK_FS, align: 'center', z: topZ() + 1 };
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

  // Nudges a rect onto nearby edges, centres and equal gaps (snap.js). Returns the offset and what to draw.
  const snapMove = (r, targets, spacing = true, order) => WBSnap.move(r, targets, SNAP_PX / cam.z, spacing, order);

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

  // ---- the viewer
  //
  // Double-click an image or video (or tap it on a phone) and it opens in the player, viewer.js: the same
  // one the catalogue opens versions in. The board tells it what there is to open, in the order the board
  // reads, and what has been said about it. What is said, drawn, played and pointed at in it comes back
  // here, to be shared with everyone on the board and undone like anything else.

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

  // What is drawn on a piece out on the board, measured against the piece as the viewer measures it
  // (its width is 1000).
  function drawingsOn(id) {
    const host = items.get(id);
    if (!host || !(host.w > 0)) return [];
    const k = 1000 / host.w;
    return [...items.values()].filter((it) => it.type === 'stroke' && it.pid === id).map((st) => ({
      id: st.id, x: (st.x - host.x) * k, y: (st.y - host.y) * k, w: st.w * k, h: st.h * k, pts: st.pts, ws: st.ws, size: st.size * k, color: st.color, arrow: st.arrow,
    }));
  }

  // In a project with a model of its venue, a catalogued piece can be seen on it in the player: in 3D it
  // shows the version's pass the project puts on the model (see boardVersion in server.js), which may be
  // another file than the one on the board. A piece that is not a version, or has no such pass, is not.
  let board3d = null;  // the project's model: { model, screen, pass, key }, or null
  let shown3d = false; // the player is in 3D
  const look3dOf = (it) => (it && it.ver && versionInfo.get(it.ver) && versionInfo.get(it.ver).look3d) || null;
  const pieceOf = (it) => {
    const piece = {
      // Played from its phone copy on a phone; `full` is the review copy, the same video whichever is played.
      id: it.id, type: it.type, src: WB.playable(it), full: it.src, prev: it.prev, pw: it.pw, th: it.th, poster: it.poster, nw: it.nw || it.w, nh: it.nh || it.h,
      fps: it.fps, dur: it.dur, wf: it.wf, name: it.name, orig: it.orig, label: it.ver && versionInfo.get(it.ver) ? versionInfo.get(it.ver).label : null,
    };
    // A version with attachments: all its files, any of which the player can show in the piece's place, and
    // which of them the piece itself is.
    const files = it.ver && versionInfo.get(it.ver) && versionInfo.get(it.ver).files;
    if (files) Object.assign(piece, { files, att: it.att || '' });
    const look = shown3d && look3dOf(it);
    if (!look || look.src === it.src || look.type !== it.type) return piece;
    const { pass, ...media } = look;
    return { ...piece, prev: undefined, pw: undefined, th: undefined, poster: undefined, ...media, src: WB.playable(look), full: look.src, wf: undefined, orig: undefined, shownPass: pass || '3d' };
  };

  let openId = null; // what is open in the viewer
  const boardHost = {
    me: () => me,
    title: () => $('boardname').value || 'Board',
    media: () => mediaOrder().map(pieceOf),
    comments: () => [...comments.values()],
    drawings: drawingsOn,
    can: { read: () => canRead(), write: () => canWrite(), draw: () => !viewOnly, member: () => !viewOnly },
    add: (c) => exec([{ t: 'add', item: c }]),
    set: (id, patch) => exec([{ t: 'set', id, patch }]),
    remove: (ids) => exec([{ t: 'del', ids }]),
    undo: () => stepHistory(undoStack, redoStack),
    redo: () => stepHistory(redoStack, undoStack),
    erase: (ids) => exec(delOps(ids)),
    clear: (id) => exec([{ t: 'del', ids: [...items.values()].filter((it) => it.type === 'stroke' && it.pid === id).map((it) => it.id) }]),
    // Another of its version's files shown in the piece's place comes down as that file.
    download: viewOnly ? null : (p) => ((p.shownAtt || '') !== (p.att || '') ? saveAs(p.orig || p.full || p.src, (p.name || p.shownAtt).replace(/\.[^.]+$/, '') + (/\.[a-z0-9]+$/i.exec(p.orig || p.full || p.src)?.[0] || '')) : downloadPiece(p.id)),
    names: () => [...peers.values()].filter((p) => !p.viewer).map((p) => ({ name: p.name, color: p.color })),
    toast,
    onOpen: (id) => {
      openId = id;
      finishEdit();
      setSel([]);
      viewer.barSlot.append($('peers'));
      renderPanel();
      sendP({ f: id });
      queueAhead();
    },
    onClose: () => {
      openId = null;
      $('topbar').querySelector('.bar-group.board-only').before($('peers'));
      renderPanel();
      sendP({ f: null, t: null, d: null });
      sent3d = 'null';
      const leader = following && peers.get(following);
      if (leader && leader.p.v) followView(leader.p.v, 0);
    },
    onMedia: (id, playing, time) => {
      wsSend({ t: 'media', id, playing, time });
      // Kept in the presence too, so whoever starts following later lands on the same frame.
      sendP({ m: [id, Math.round(time * 1000) / 1000, playing ? 1 : 0] });
    },
    onThread: (id) => sendP({ t: id }),
    onLaser: (id, pts) => wsSend({ t: 'laser', pts, on: id }),
    onInteract: () => stopFollowing(),
    locked: spectating,
    onWhole: (id, url) => mendStrip(id, url),
    get view3d() { return board3d; },
    can3d: (p) => !!look3dOf(items.get(p.id)),
    onMode3d: (on) => {
      shown3d = on;
      viewer.refresh();
    },
  };
  const viewer = WBViewer.create(boardHost);
  // How far into the open piece the view is, for whoever follows: they see what is zoomed in on.
  let zoomSent = 'null';
  viewer.watch((type, ...args) => {
    if (type === 'zoom' && viewer.isOpen() && viewer.host() === boardHost) {
      const z = viewer.zoom();
      if (JSON.stringify(z) !== zoomSent) sendP({ z });
      zoomSent = JSON.stringify(z);
    }
    if (type === '3d' && viewer.isOpen() && viewer.host() === boardHost) send3d();
    // Watching a presentation, the page around this one is told the sound had to go, and how far the venue
    // has come while 3D loads (it says so over everything).
    if (type === 'muted' && spectating) window.parent.postMessage({ wb: 'muted' }, location.origin);
    if (type === '3dload' && spectating) window.parent.postMessage({ wb: '3dload', k: args[0] }, location.origin);
  });
  // How the open piece is seen in 3D, for whoever follows: 2D or 3D, the camera, a comment's frame, or
  // flying (sent as the view moves).
  let sent3d = 'null';
  function send3d() {
    const d = viewer.isOpen() && viewer.host() === boardHost ? viewer.view3d() : null;
    // (When a place in a flight was taken does not make it another place.)
    const sig = JSON.stringify(d && d.f ? { ...d, f: { ...d.f, t: 0 } } : d);
    if (sig !== sent3d) sendP({ d });
    sent3d = sig;
  }
  setInterval(() => { if (shown3d) send3d(); }, 50);
  if (spectating) {
    window.addEventListener('message', (e) => {
      if (e.origin === location.origin && e.data && e.data.wb === 'sound') viewer.sound(!!e.data.on);
    });
  }

  // An asset, set or shot's versions, from the catalogue, in the same player; closed, it is the board's again.
  async function lookAtEntity(entityId, version) {
    try {
      await WBViewer.openEntity(viewer, entityId, { version, me, onClose: () => viewer.use(boardHost) });
    } catch (err) {
      toast(err.message);
      viewer.use(boardHost);
    }
  }

  function enterFocus(id) {
    const it = items.get(id);
    if (!it || (it.type !== 'image' && it.type !== 'video')) return;
    viewer.open(id);
  }

  // Following someone means seeing what they have open, too.
  function followFocus(id) {
    viewer.follow(id && items.has(id) ? id : null);
  }

  // ---- the open video, all of it

  // A browser keeps only a little of a paused video in hand and fetches the rest as it is asked for.
  // That suits watching, but a scrub keeps landing on moments it has not got yet, and drags until the
  // hand has been over the whole length once. So a video that is opened is fetched whole, in one go,
  // and then played from memory: every moment of it is there at once. Until it has arrived the video
  // plays from the server as before.
  // media.js holds them, for the board and the player alike, and lets the longest unused go: a video on
  // the board let go of goes back to playing from where it came.

  // ---- the board's videos, kept on this machine
  //
  // Once a board is open its videos are fetched ahead, quietly, one at a time and in the order the viewer
  // steps through them, and kept on this computer (media.js, which keeps for every page). Opening one
  // then finds it there, this time and every time after. What is on the open board is never made room for.
  const media = WB.media;
  const KEPT_MAX = media.MAX;

  let aheadTimer = 0;
  function queueAhead() {
    paintKept();
    // Somebody looking through a link is not given gigabytes they did not ask for: what they open is kept.
    // Watching a presentation is different: whoever presents is about to open them.
    if (viewOnly && !spectating) return;
    clearTimeout(aheadTimer);
    aheadTimer = setTimeout(() => {
      // From the piece that is open onwards, since the next one is the likeliest to be wanted next.
      const order = mediaOrder().filter(wholeable);
      const from = Math.max(0, order.findIndex((it) => it.id === openId));
      media.want(`board:${boardId}`, [...order.slice(from), ...order.slice(0, from)].map((it) => WB.playable(it)), { rank: media.RANK.board, kind: 'boards', hold: true });
      phones.poke();
    }, 1000);
  }

  // The ring in the bar: how much of this board's video is on this computer already (media.js).
  let keptRing = null;
  // The ring is painted on every progress tick: what it measures is worked out again only when the board changed.
  let ringItems = [];
  let boardLoaded = false; // the board's pieces have come: before that its videos are not yet known
  keptRing = media.ring($('kept'), () => {
    if (orderDirty && boardLoaded) {
      orderDirty = false;
      ringItems = mediaOrder().filter((it) => it.type === 'video').map((it) => ({ src: WB.playable(it), name: it.name }));
      // Watching a presentation, the page around this one shows how much of the board is cached.
      if (spectating) window.parent.postMessage({ wb: 'scope', items: ringItems }, location.origin);
    }
    return { label: 'this board', items: ringItems };
  });
  function paintKept() {
    if (keptRing) keptRing.paint();
  }

  // Only what this server keeps: anything else may not let itself be fetched.
  const wholeable = (it) => !!it && it.type === 'video' && media.keepable(WB.playable(it));
  media.onEvict((src) => {
    for (const [nid, node] of els) {
      const v = node.classList.contains('video') ? node.firstChild : null;
      if (!v || v.dataset.whole !== src) continue;
      delete v.dataset.whole;
      WBViewer.switchSource(v, WB.playable(items.get(nid)));
    }
  });

  // The board's videos without a phone copy get one, made here when this is a desk browser that can and
  // has nothing better to do (ingest.js): not while a video is open, nor while presenting.
  const phones = WBIngest.phoneCopies(() => (viewOnly || viewer.isOpen() || WBPresent.token() ? []
    : mediaOrder().filter((it) => it.type === 'video' && !it.lo && media.keepable(it.src)).map((it) => it.src)));

  async function holdWhole(id) {
    const it = items.get(id);
    if (!wholeable(it)) return;
    const src = WB.playable(it);
    const url = await media.whole(src).ready;
    // Not in the middle of a scrub, which would be thrown back to where it started.
    while (boardScrub === id) await new Promise((resolve) => setTimeout(resolve, 120));
    const video = videoOf(id);
    if (!url || !video || WB.playable(items.get(id)) !== src || video.dataset.whole === src) return;
    video.dataset.whole = src;
    WBViewer.switchSource(video, url);
    mendStrip(id, url);
  }

  // A video that came in without the strip for its timeline, because the browser it was added from could
  // not read it, is given one by the first browser that can, when it is opened there.
  const mending = new Set();
  async function mendStrip(id, url) {
    const it = items.get(id);
    if (!it || it.wf || viewOnly || mending.has(it.src)) return;
    mending.add(it.src);
    try {
      const wf = await videoWave(await (await fetch(url)).blob(), null, it.dur || 0, undefined, false);
      const now = items.get(id);
      if (wf && now && now.src === it.src && !now.wf) exec([{ t: 'set', id, patch: { wf } }], false);
    } catch {
      // it stays plain
    }
  }

  // Whether a video is on its last frame. Let go there, it stays there: to run on from the end is to be
  // back at the start at once.
  function atEndOf(id) {
    const video = videoOf(id);
    return !!video && video.duration - whereOf(video) < 1.5 / (fpsOf(id) || 24);
  }

  let boardScrub = null; // the video whose bar out on the board is being dragged

  function setLevel(lvl) {
    const ops = [];
    for (const id of sel) {
      const it = items.get(id);
      if (it && it.type === 'text') {
        ops.push({ t: 'set', id, patch: { lvl, fs: round(it.fs * (levelSize(lvl) / levelSize(it.lvl))) } });
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
      ? { ...base, w: NOTE_W * noteScale(), h: 0, fs: NOTE_FS * noteScale(), color: NOTE_FILLS[0] }
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

  // Seeking, frames and how a moment is written are the player's (viewer.js); a video out on the board
  // goes by the same.
  const { goTo, whereOf, changing, frameTime, frameIndex, lastFrame, timeLabel, cycleTimeMode } = WBViewer;
  window.addEventListener('wb:timemode', () => {
    for (const node of els.values()) if (node.classList.contains('video')) node.firstChild.wbTick();
  });

  // Only ever called when this hand plays, stops or moves a video, never when it follows someone else's.
  function sendMedia(id) {
    const video = videoOf(id);
    if (!video) return;
    // Playing, stopping or moving it here is no longer watching what the person followed is watching.
    stopFollowing();
    const at = whereOf(video);
    wsSend({ t: 'media', id, playing: !video.paused, time: at });
    sendP({ m: [id, Math.round(at * 1000) / 1000, video.paused ? 0 : 1] });
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
      const f = clamp(frameIndex(whereOf(video), fps) + dir * (second ? Math.round(fps) : 1), 0, lastFrame(video, fps));
      goTo(video, frameTime(f, fps));
    } else {
      goTo(video, clamp(whereOf(video) + dir * (second ? 1 : 1 / 24), 0, video.duration || 0));
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
    goTo(video, at);
    sendMedia(id);
  }

  const fpsOf = (id) => items.get(id)?.fps || 0;
  // Where a comment on a video was left: on its frame when that is known, otherwise at its time.
  const momentOf = (c) => (c.fr != null && fpsOf(c.on) ? frameTime(c.fr, fpsOf(c.on)) : c.at);

  // Marks on each video's scrub bar out on the board where its comments are; clicking one goes there.
  let marksQueued = false;
  function queueMarks() {
    if (marksQueued) return;
    marksQueued = true;
    queueMicrotask(placeMarks);
  }
  function placeMarks() {
    marksQueued = false;
    const on = new Map();
    if (canRead()) {
      for (const c of rootsInOrder()) {
        const at = momentOf(c);
        if (at != null) (on.get(c.on) || on.set(c.on, []).get(c.on)).push({ at, title: `${c.name}: ${c.text}` });
      }
    }
    for (const [id, node] of els) {
      if (!node.classList.contains('video')) continue;
      const dur = node.firstChild.duration;
      const seen = new Set();
      const kids = [];
      for (const m of isFinite(dur) && dur > 0 ? on.get(id) || [] : []) {
        const moment = Math.round(m.at * 1000);
        if (seen.has(moment)) continue;
        seen.add(moment);
        kids.push(el('button', { class: 'vmark', title: m.title, style: { left: `${clamp(m.at / dur, 0, 1) * 100}%` }, onclick: () => seekVideo(id, m.at) }));
      }
      node.querySelector('.vmarks').replaceChildren(...kids);
    }
  }

  function selectedVideo() {
    if (sel.size !== 1) return null;
    const it = items.get([...sel][0]);
    return it && it.type === 'video' ? it.id : null;
  }

  // The size an image or video is given when it is added: a set width, unless that would make it too tall.
  function mediaSize(m) {
    let w = IMG_W;
    let h = IMG_W * (m.nh / m.nw);
    if (h > IMG_MAX_H) {
      h = IMG_MAX_H;
      w = h * (m.nw / m.nh);
    }
    return { w, h };
  }

  // Where each of several pieces of media goes, in rows from `at`, all at the same width; a single one is centred on it.
  // Several make a roughly even grid (two side by side, seven as four and three), whatever the zoom.
  function mediaRects(sizes, at, centre = true) {
    const gap = 24;
    const cols = clamp(Math.ceil(Math.sqrt(sizes.length * 1.5)), 1, 6);
    const maxRow = cols * (IMG_W + gap);
    let x = 0;
    let y = 0;
    let tallest = 0;
    const rects = sizes.map((m) => {
      const { w, h } = mediaSize(m);
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
    viewer.close();
    let z = topZ();
    const rects = mediaRects(made, at, centre);
    const list = made.map((m, i) => ({ ...m, id: uid(), ...rects[i], z: ++z }));
    exec(addOps(list));
    setSel(list.map((item) => item.id));
    bringIntoView(rects);
  }

  // What was just added is shown. If any of it is out of sight the view eases to take it all in, never
  // closer in than it was; what is already in sight is left where it is.
  function bringIntoView(rects) {
    const r = rects.reduce((u, b) => union(u, b), null);
    if (!r || openId) return;
    const i = insets();
    const seen = { x: cam.x + i.l / cam.z, y: cam.y + i.t / cam.z, w: (vp.clientWidth - i.l - i.r) / cam.z, h: (vp.clientHeight - i.t - i.b) / cam.z };
    if (contains(seen, r)) return;
    userMovedView();
    fitRect(r, { maxZ: cam.z, dur: calm.matches ? 0 : 380 });
  }

  // ---- stand-ins for media on its way in
  // An image or video shows up on the board the moment it is chosen, dimmed, with a ring that fills as it
  // is prepared and uploaded (a video's review copy is made first). It is a piece like any other (select
  // it, move it, drop it into a frame) and everybody on the board sees it. When the file has landed the
  // real piece takes its place.
  const RING = 2 * Math.PI * 28;
  const standIns = new Set(); // this browser's own
  const progress = new Map(); // stand-in id -> { k, ph }, from this browser and from the others
  // How fast this browser made and sent its last video: seconds of encoding for a second of video, and
  // seconds to send a megabyte. The ring is paced by them, so they are kept from one video to the next.
  const pace = { enc: 0.3, up: 0.02, ...store('wb:pace') };
  pace.enc = clamp(Number(pace.enc) || 0.3, 0.02, 20);
  pace.up = clamp(Number(pace.up) || 0.02, 0.0005, 20);
  // Each says what is being done, not how far along it is: the last step, reading the video for its
  // timeline, is often the longest of the three, and "finishing" at 13% was no way to say so.
  const PHASES = { enc: 'Preparing', up: 'Uploading', fin: 'Building timeline' };
  // A stand-in nobody is working on any more is said to be so, once it has been that way this long.
  const ORPHAN_MS = 8000;
  const orphans = new Map(); // stand-in id -> when it was first seen with nobody behind it

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
    const stopped = orphaned(it.id);
    const waiting = !stopped && !(k > 0);
    node.classList.toggle('waiting', waiting);
    node.classList.toggle('stopped', stopped);
    node.querySelector('.ghostname').textContent = it.name || '';
    node.querySelector('.arc').style.strokeDashoffset = RING * (1 - (stopped ? 0 : waiting ? 0.25 : clamp(k, 0, 1)));
    // Full only when it is: until then there is always a little left to say so.
    node.querySelector('.ghostpct').textContent = stopped || waiting ? '' : `${k >= 1 ? 100 : Math.min(99, Math.round(k * 100))}%`;
    node.querySelector('.ghostphase').textContent = stopped ? `Upload interrupted${viewOnly ? '' : '. Delete this and add the file again'}` : PHASES[ph] || 'Waiting';
  }

  // Whether a stand-in has been left behind: whoever was adding the video closed the board or lost it
  // part way, so nothing is coming. It takes a moment to be sure, since word of who is working on what
  // comes a little after the stand-in itself.
  function orphaned(id) {
    if (progress.has(id)) {
      orphans.delete(id);
      return false;
    }
    const since = orphans.get(id);
    if (since == null) {
      orphans.set(id, performance.now());
      setTimeout(() => (items.has(id) ? repaintUpload(id) : orphans.delete(id)), ORPHAN_MS + 50);
      return false;
    }
    return performance.now() - since >= ORPHAN_MS;
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
    for (const id of was) {
      if (peer.up.has(id)) continue;
      progress.delete(id);
      repaintUpload(id);
    }
  }

  function dropRemoteStandIns(id) {
    const peer = peers.get(id);
    if (!peer || !peer.up) return;
    for (const upId of peer.up) {
      progress.delete(upId);
      repaintUpload(upId);
    }
  }

  async function standIn(file, rect, isVideo) {
    const url = URL.createObjectURL(file);
    const id = uid();
    const g = { id, k: 0, ph: 'wait', sent: 0 };
    const stand = { type: 'upload', id, name: file.name, ...rect, z: topZ() + 1 };
    exec(addOps([stand]), false);
    standIns.add(g);
    progress.set(id, g);
    repaintUpload(id);
    shareStandIns();
    // A picture from the file itself, where this browser can show it.
    if (isVideo) {
      const video = el('video', { muted: '', playsinline: '', preload: 'metadata' });
      video.muted = true;
      video.addEventListener('loadeddata', async () => {
        if (brightness(video) < 14) await pickFrame(video).catch(() => {});
        const node = els.get(id);
        if (node) node.prepend(video);
      }, { once: true });
      video.src = `${url}#t=0.1`;
    } else {
      const node = els.get(id);
      if (node) node.prepend(el('img', { src: url, alt: '', draggable: 'false', decoding: 'async' }));
    }
    // `k` is how far along the whole job is: making the review copy, then sending it while its timeline
    // strip is read. Each part counts for the time it is expected to take, so the ring moves at an even
    // pace; it never goes back, and it is only full when the video is about to land.
    const part = { enc: 0, up: 0, strip: 0 };
    const began = {};
    const took = {};
    let job = null;
    let secs = { enc: 0, up: 1, strip: 1 };
    // `kind` is 'encode', 'wrap' or 'none' for a video, 'image' for an image, which only has its upload.
    g.plan = (kind, dur, bytes) => {
      const mb = Math.max(0, bytes) / 1048576;
      dur = dur > 0 && isFinite(dur) ? dur : 0;
      job = { kind, dur, mb };
      secs = {
        enc: kind === 'encode' ? Math.max(1, dur * pace.enc) : kind === 'wrap' ? 0.2 + mb * 0.004 : 0,
        up: 0.1 + mb * pace.up,
        strip: kind === 'image' ? 0 : 1.5 + dur * 0.012,
      };
      began.enc = performance.now();
    };
    g.status = (name, p) => {
      const now = performance.now();
      if (!(name in began)) began[name] = now;
      part[name] = clamp(p, 0, 1);
      if (p >= 1 && !(name in took)) took[name] = (now - began[name]) / 1000;
      // The upload and the strip go on side by side, so what is left of the two is the longer of what is left of each.
      const both = Math.max(secs.up, secs.strip);
      const left = Math.max(secs.up * (1 - part.up), secs.strip * (1 - part.strip));
      const k = (secs.enc * part.enc + both - left) / (secs.enc + both);
      const ph = !('up' in began) ? 'enc' : part.up < 1 || !secs.strip ? 'up' : 'fin';
      const phaseChanged = ph !== g.ph;
      g.ph = ph;
      g.k = Math.max(g.k, k, 0.005);
      // Word of progress can come many times a frame; the ring only needs it when it would show.
      if (phaseChanged || g.k >= 1 || g.k - (g.shown || 0) >= 0.002) {
        g.shown = g.k;
        repaintUpload(id);
      }
      if (phaseChanged || Math.abs(g.k - g.sent) >= 0.01) {
        g.sent = g.k;
        shareStandIns();
      }
    };
    const learn = () => {
      if (!job) return;
      if (job.kind === 'encode' && job.dur > 1 && took.enc > 0) pace.enc = clamp(took.enc / job.dur, 0.02, 20);
      if (job.mb >= 1 && took.up > 0) pace.up = clamp(took.up / job.mb, 0.0005, 20);
      store('wb:pace', pace);
    };
    const finish = () => {
      standIns.delete(g);
      progress.delete(id);
      shareStandIns();
      URL.revokeObjectURL(url);
    };
    // The real piece takes the place of the stand-in, wherever it has been moved to, frame and all.
    g.done = (made) => {
      const was = items.get(id);
      learn();
      finish();
      if (!was) return false; // it was deleted while on its way
      const item = { ...made, id, x: was.x, y: was.y, w: was.w, h: was.h, z: was.z };
      if (was.fid) item.fid = was.fid;
      const selected = sel.has(id);
      exec([{ t: 'del', ids: [id] }], false);
      exec(addOps([item]));
      if (selected) setSel([...sel, id]);
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
    const errors = [];
    // Each file is on the board straight away, as a stand-in at its own shape, so a drop always shows
    // where things go. For that its size is read first: an image's from the picture, a video's from its
    // first frame.
    const probed = await Promise.all(files.map(async (f) => {
      const isVideo = VID_EXT.test(fileExt(f));
      const url = URL.createObjectURL(f);
      try {
        if (!isVideo) {
          const img = await loadImage(url);
          return { file: f, isVideo, nw: img.naturalWidth || 512, nh: img.naturalHeight || 512 };
        }
        const { w, h } = await probeVideo(url);
        // One this browser can show but cannot make a review copy of is turned away before anything is
        // put on the board for it. (One it cannot even show gets its own message further on.)
        return { file: f, isVideo, nw: w, nh: h, beyond: await beyondThisBrowser(f) };
      } catch (err) {
        if (!isVideo) {
          errors.push(`${f.name}: ${err.message}`);
          return null;
        }
        return { file: f, isVideo, nw: 16, nh: 9 };
      } finally {
        URL.revokeObjectURL(url);
      }
    }));
    tellRefused(probed.filter((p) => p && p.beyond).map((p) => ({ name: p.file.name, dims: p.beyond })));
    const accepted = probed.filter((p) => p && !p.beyond);
    if (!accepted.length) {
      for (const message of errors.slice(0, 3)) toast(message, { ms: 9000 });
      return;
    }
    viewer.close();
    const rects = mediaRects(accepted, at, accepted.length === 1);
    const ghosts = await Promise.all(accepted.map((p, i) => standIn(p.file, rects[i], p.isVideo)));
    bringIntoView(rects);
    // Images are quick, so they land first; videos follow, one at a time. Those that looked fine and then
    // could not be finished are said together, once they have all been tried.
    const order = accepted.map((p, i) => ({ ...p, ghost: ghosts[i] })).sort((a, b) => a.isVideo - b.isVideo);
    const late = [];
    for (const { file, isVideo, ghost } of order) {
      try {
        if (!isVideo) ghost.plan('image', 0, file.size);
        ghost.status(isVideo ? 'enc' : 'up', 0);
        const made = await ingest(file, (k) => ghost.status('up', k), isVideo ? {
          onPhase: (k) => ghost.status('enc', k),
          onStrip: (k) => ghost.status('strip', k),
          onPlan: ghost.plan,
        } : {});
        const landed = ghost.done(made);
        if (landed && isVideo && !made.orig) keepOriginal(ghost.id, file);
      } catch (err) {
        ghost.fail();
        if (err.refused) late.push({ name: file.name, dims: err.dims, transient: !!err.transient, file });
        else errors.push(`${file.name}: ${err.message}`);
      }
    }
    for (const message of errors.slice(0, 3)) toast(message, { ms: 9000 });
    // Put back where they were meant to go, as near as can be.
    tellRefused(late, (again) => again.length && addFiles(again, at));
  }

  // ---- the file a video was made from
  //
  // What goes on the board for a video is its review copy. The file it was made from is kept as well, for
  // whoever needs the real thing: once the copy has landed the original follows it up, one at a time and
  // behind everything the board is waiting for. The video says so in its corner until it is there.
  // Whoever closes the board before then leaves the video with its copy only.
  const originals = [];       // waiting to go up: { id, file }
  let keepingNow = false;
  const keeping = () => keepingNow || originals.length > 0;
  const megabytes = WB.bytes;

  function showKeeping(id, k) {
    const node = els.get(id);
    if (!node) return;
    if (k == null) delete node.dataset.keep;
    else node.dataset.keep = `${Math.min(99, Math.round(k * 100))}%`;
  }

  function keepOriginal(id, file) {
    if (!WBFiling.originalFits(file)) {
      toast(`${file.name} is ${megabytes(file.size)}, more than is kept here (${megabytes(WB.info().maxUpload)}), so only its review copy is on the board.`, { ms: 10000 });
      return;
    }
    originals.push({ id, file });
    showKeeping(id, 0);
    sendOriginals();
  }

  async function sendOriginals() {
    if (keepingNow) return;
    keepingNow = true;
    try {
      while (originals.length) {
        const { id, file } = originals[0];
        const there = () => items.get(id)?.type === 'video';
        try {
          // Deleted meanwhile, there is nothing to keep it for.
          if (there()) {
            const up = await upload(file, fileExt(file), (k) => showKeeping(id, k), true);
            if (up.url && there()) exec([{ t: 'set', id, patch: { orig: up.url } }], false);
          }
        } catch (err) {
          toast(`The original of ${file.name} could not be kept (${err.message}). Its review copy is on the board.`, { ms: 10000 });
        }
        originals.shift();
        showKeeping(id, null);
        selChanged();
      }
    } finally {
      keepingNow = false;
    }
  }

  // Leaving while a file is still on its way up would lose it.
  window.addEventListener('beforeunload', (e) => {
    if (!standIns.size && !keeping()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---- taking files off the board
  //
  // A piece comes down as it was uploaded: a picture is its own original, a video is the file it was made
  // from where that was kept, and otherwise the copy the board plays. All of a board's come down as one
  // zip, put together by the server. Whoever holds a link to the board is offered neither.
  const onServer = (it) => !!it && (it.type === 'image' || it.type === 'video') && WB.media.keepable(it.src);
  const waitingToBeKept = (id) => originals.some((o) => o.id === id);

  function saveAs(url, name) {
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  function downloadPiece(id) {
    const it = items.get(id);
    if (!onServer(it)) return toast('This one is not kept here: it was added by its address.');
    const url = it.orig || it.src;
    const stem = (it.name || it.type).replace(/\.[^.]+$/, '');
    saveAs(url, stem + (/\.[a-z0-9]+$/i.exec(url)?.[0] || ''));
    if (it.type === 'video' && !it.orig) {
      toast(waitingToBeKept(id) ? 'The original is still on its way up, so this is the review copy.' : 'The original of this video was not kept, so this is the review copy.', { ms: 7000 });
    }
  }

  const downloadTitle = (it) => (it.type === 'image' || it.orig ? 'Download the original media'
    : waitingToBeKept(it.id) ? 'Download the review copy (the original is still on its way up)'
      : 'Download the review copy (the original was not kept)');

  async function downloadBoard() {
    const pieces = [...items.values()].filter(onServer);
    if (!pieces.length) return toast('There are no images or videos on this board to download.');
    // Asked after first, so that what cannot be had is said here and not by a download that fails.
    const there = await fetch(`/api/boards/${boardId}/media.zip`, { method: 'HEAD' }).then((res) => res.ok, () => false);
    if (!there) return toast('The zip could not be made just now. If the server has just been updated, it needs restarting first.', { ms: 9000 });
    const files = new Set(pieces.map((it) => it.orig || it.src)).size;
    const copies = new Set(pieces.filter((it) => it.type === 'video' && !it.orig).map((it) => it.src)).size;
    saveAs(`/api/boards/${boardId}/media.zip`, '');
    toast(`Downloading ${files} ${files === 1 ? 'file' : 'files'} as a zip.${copies ? ` ${copies === 1 ? 'One video is' : `${copies} videos are`} there as the review copy: ${keeping() ? 'the original is not here, or not yet' : 'the original was not kept'}.` : ''}`, { ms: 9000 });
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
    viewer.close();
    const dx = at.x - (box.x + box.w / 2);
    const dy = at.y - (box.y + box.h / 2);
    let z = topZ();
    const clones = reid(pieces)
      .map((it) => ({ ...it, x: round(it.x + dx), y: round(it.y + dy), z: ++z }));
    exec(addOps(clones));
    setSel(clones.map((c) => c.id));
    bringIntoView(clones.map(bounds));
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

  // ---- eraser: right-drag while drawing out on the board removes every drawing the stroke touches

  const eraserRing = $('eraser');
  const ERASER_R = 12; // screen pixels

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

  vp.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.vbar, a, .cchip, .vchip')) return;
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
    if (!viewOnly && ((e.button === 2 && (tool === 'pen' || tool === 'arrow')) || (e.button === 0 && tool === 'eraser'))) {
      const g = { type: 'erase', last: p, hit: new Set(), touch: e.pointerType === 'touch' };
      begin(g, e);
      eraserRing.hidden = false;
      eraserRing.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
      eraseSegment(g, p, p);
      return;
    }
    if (pan) return beginPan(e);
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
        begin({ type: 'move', p0: p, sx: e.clientX, sy: e.clientY, started: false, id, wasSelected, alt: e.altKey, playBtn: !!e.target.closest('.vplay'), touch: e.pointerType === 'touch' }, e);
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
      const g = { type: 'draw', arrow, pts: [p.x, p.y], ws: [w0], lt: e.timeStamp, svg, path, size, t0: performance.now(), touch: e.pointerType === 'touch', sx: e.clientX, sy: e.clientY, far: 0 };
      begin(g, e);
      if (!arrow) path.setAttribute('d', outlinePath(g.pts, g.ws, 1, 1, size));
    }
  });

  // ---- touch: one finger looks around and opens things, two zoom. Drawing, commenting and placing
  // things work with one finger as they do with a mouse, and so does moving something already selected.
  const touches = new Map();
  let pinch = null;
  const midOf = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // A stroke or an erase begun with a finger that turns out to be the first of two is taken back: the
  // fingers were reaching for the view, not for the picture. Nothing of it is kept or sent.
  function dropTouchMark() {
    const g = gesture;
    if (!g || !g.touch) return false;
    if (g.type === 'draw') g.svg.remove();
    else if (g.type === 'erase') {
      for (const id of g.hit) els.get(id)?.classList.remove('erased');
      eraserRing.hidden = true;
    } else return false;
    gesture = null;
    return true;
  }

  function startPinch() {
    const [a, b] = [...touches.values()];
    stopCamAnim();
    userMovedView();
    pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: midOf(a, b), cam: { ...cam } };
  }

  function touchStart(e) {
    // The first finger down starts afresh: a finger whose lifting was never heard of (it let go over
    // something that has since gone) must not turn the next one-finger drag into a lopsided pinch.
    if (e.isPrimary) {
      touches.clear();
      pinch = null;
    }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Every finger on the board stays the board's until it lets go, whatever it passes over.
    try {
      vp.setPointerCapture(e.pointerId);
    } catch {
      // as in begin()
    }
    if (touches.size >= 2) {
      // A second finger turns looking around, drawing or erasing into zooming. It leaves a move or a
      // resize of something selected alone.
      dropTouchMark();
      if (gesture && (gesture.type === 'pan' || gesture.type === 'swipe')) {
        gesture = null;
        document.body.classList.remove('panning');
      }
      if (!gesture && touches.size === 2) startPinch();
      return true;
    }
    if ((tool !== 'select' && tool !== 'pan') || e.target.closest('.handle')) return false;
    const play = !!e.target.closest('.vplay');
    const node = e.target.closest('.item');
    const id = node ? node.dataset.id : null;
    if (id && sel.has(id) && !viewOnly && tool === 'select') return false;
    if (coasting) stopCamAnim();
    userMovedView();
    const g = { type: 'pan', touch: true, id, play, moved: false, sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, lx: e.clientX, ly: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    begin(g, e);
    // A finger held still selects, as Shift and a click do: held on a piece it is added to what is
    // selected (or taken out), held on empty board it draws a box that adds what it touches.
    if (!viewOnly && tool === 'select') g.hold = setTimeout(() => longPress(g, e.clientX, e.clientY), 450);
    return true;
  }
  function longPress(g, x, y) {
    if (gesture !== g || g.moved || touches.size !== 1) return;
    if (navigator.vibrate) navigator.vibrate(12);
    let it = g.id && items.get(g.id);
    if (it && it.type === 'stroke' && it.pid) it = items.get(it.pid);
    if (it && selectable(it)) {
      const next = new Set(sel);
      if (next.has(it.id)) next.delete(it.id);
      else next.add(it.id);
      setSel([...next]);
      gesture = null;
      return;
    }
    const p0 = s2w(x, y);
    gesture = { type: 'marquee', p0, base: new Set(sel), pid: g.pid, touch: true };
    showMarquee(p0, p0);
  }

  // A tap: an image or video opens (its play button plays it), anything else is selected.
  function touchTap(g) {
    let it = g.id && items.get(g.id);
    if (it && it.type === 'stroke' && it.pid) it = items.get(it.pid);
    // Out on the board only a video's play button plays it; a tap anywhere else on it opens it.
    if (it && it.type === 'video' && g.play) toggleVideo(it.id);
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
  // Heard on the window, so a finger is let go of wherever it is lifted.
  const lift = (e) => {
    if (e.pointerType !== 'touch' || !touches.delete(e.pointerId)) return;
    if (touches.size >= 2) return startPinch();
    const pinched = !!pinch;
    pinch = null;
    // The finger still down after a pinch carries on moving the view, as a hand would. It never draws,
    // and lifting it is not a tap.
    if (pinched && touches.size === 1 && !gesture) {
      const [[pointerId, at]] = [...touches];
      beginPan({ pointerId, clientX: at.x, clientY: at.y }, { touch: true, moved: true });
    }
  };
  window.addEventListener('pointerup', lift, true);
  window.addEventListener('pointercancel', lift, true);
  // iOS Safari zooms the whole page on a pinch, whatever the page asks, unless the gesture is refused.
  // The board does its own zooming; the page itself never zooms.
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());

  function beginResize(h, e) {
    const r = selBounds();
    const ids = [...sel];
    // Drawings on a scaled image scale with it.
    for (const it of items.values()) if (it.pid && sel.has(it.pid)) ids.push(it.id);
    const single = sel.size === 1 ? items.get([...sel][0]) : null;
    // Frames and notes reshape freely; everything else keeps its proportions.
    // A side handle stretches one way only, Shift or not.
    const free = !!single && (single.type === 'frame' || single.type === 'note' || single.type === 'block') && (!e.shiftKey || h.length === 1);
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
      // A side handle changes one dimension; the other stays as it was.
      const w = /[ew]/.test(g.h) ? Math.max(min, west ? g.ax - p.x : p.x - g.ax) : g.r.w;
      const h = /[ns]/.test(g.h) ? Math.max(min, north ? g.ay - p.y : p.y - g.ay) : g.r.h;
      const patch = {};
      if (/[ew]/.test(g.h)) Object.assign(patch, { x: round(west ? g.ax - w : g.ax), w: round(w) });
      if (/[ns]/.test(g.h)) Object.assign(patch, { y: round(north ? g.ay - h : g.ay), h: round(h) });
      liveSet(id, patch);
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

  // A double-click on a handle puts every image and video selected back to the size it was added at.
  // As when the handle is dragged, the corner across from it stays where it is, and what is drawn on
  // a piece scales with it.
  function resetMediaSize(h) {
    const snap = snapshot(items.keys());
    const before = new Map();
    for (const it of items.values()) if (it.type === 'frame') before.set(it.id, geometry(it));
    const fids = [];
    for (const id of sel) {
      const it = items.get(id);
      if (!it || (it.type !== 'image' && it.type !== 'video') || !(it.w > 0 && it.h > 0)) continue;
      const size = mediaSize({ nw: it.nw || it.w, nh: it.nh || it.h });
      const s = size.w / it.w;
      if (Math.abs(s - 1) < 0.001) continue;
      const ax = h.includes('w') ? it.x + it.w : it.x;
      const ay = h.includes('n') ? it.y + it.h : it.y;
      for (const part of [it, ...[...items.values()].filter((o) => o.pid === id)]) {
        const b = bounds(part);
        before.set(part.id, geometry(part));
        // The piece itself lands on exactly the size it was added at; what is on it goes by the same scale.
        const to = part === it ? { w: round(size.w), h: round(size.h) } : scaledSize(part, s);
        liveSet(part.id, { x: round(ax + (b.x - ax) * s), y: round(ay + (b.y - ay) * s), ...to });
      }
      if (it.fid) fids.push(it.fid);
    }
    refitLive(fids);
    recordSince(snap);
    glideFrom(before);
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
      if (g.touch && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 8) {
        g.moved = true;
        clearTimeout(g.hold);
      }
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
      g.far = Math.max(g.far, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
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
      // A finger the browser took away erased nothing.
      if (g.touch && (!e || e.type !== 'pointerup')) for (const id of g.hit) els.get(id)?.classList.remove('erased');
      // Everything the stroke touched goes in one undo step.
      else if (g.hit.size) exec(delOps([...g.hit]));
    } else if (g.type === 'pan') {
      clearTimeout(g.hold);
      if (g.touch && !g.moved) {
        if (e && e.type === 'pointerup') touchTap(g);
      }
      // Only if the hand was still moving when it let go: a pan brought to rest stays where it was put.
      else if (e && e.type === 'pointerup' && performance.now() - g.t < 60) coast(g.vx, g.vy);
    } else if (g.type === 'move') {
      clearGuides();
      if (!g.started) {
        if (g.playBtn) toggleVideo(g.id);
        else if (g.wasSelected && sel.size > 1) setSel([g.id]);
        // There is no double-click under a finger: a tap on the note or heading already selected writes in it.
        else if (g.touch && g.wasSelected && e && e.type === 'pointerup' && ['note', 'text', 'block'].includes(items.get(g.id)?.type)) startEdit(g.id);
      } else if (g.clones) {
        recordSince(g.snap, [{ t: 'del', ids: g.clones }]);
      } else {
        for (const id of g.moving) {
          const st = items.get(id);
          if (st && st.type !== 'stroke' && st.pid && !g.moving.includes(st.pid)) liveSet(id, { pid: null });
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
      if (r.w < 24 / cam.z || (!isBlock && r.h < 24 / cam.z)) {
        r = { x: g.p0.x - defW / 2, y: g.p0.y - defH / 2, w: defW, h: defH };
      }
      makeFrameLike(g.kind, r);
    } else if (g.type === 'draw') {
      g.svg.remove();
      // A finger that only touched, or was taken away by the browser, meant no mark: a tap to look,
      // the start of a pinch, a system gesture. (A pen or a mouse can still set down a dot.)
      if (g.touch && ((!e || e.type !== 'pointerup') || (g.far < 6 && performance.now() - g.t0 < 350))) return void updateOverlay();
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
        const item = { id: uid(), type: 'stroke', x: round(x0), y: round(y0), w: round(w), h: round(h), pts: norm, color: pen.color, size: Math.round(g.size * 100) / 100, arrow: g.arrow, z: topZ() + 1 };
        if (!g.arrow) {
          // The stroke ends in a flick: the last few points taper off.
          const ws = (g.line ? g.line.ws : g.ws).slice();
          if (!g.line && ws.length > 4) [0.8, 0.6, 0.4].forEach((k, i) => { ws[ws.length - 1 - i] *= k; });
          item.ws = ws.map((v) => Math.round(v * 100) / 100);
        }
        const host = hostFor(item);
        item.pid = host ? host.id : null;
        exec(addOps([item]));
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

  // A mouse wheel zooms, as it always has. Two fingers on a trackpad pan, sideways too, and a pinch
  // (which the browser sends as a wheel with Ctrl held) zooms. A trackpad is told by its fine, sideways
  // or fractional steps, and once told is remembered for the rest of that gesture.
  let padUntil = 0;
  vp.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (spectating) return;
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? vp.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    userMovedView();
    if (e.ctrlKey) return void zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
    const now = performance.now();
    if (e.deltaMode === 0 && (dx !== 0 || !Number.isInteger(e.deltaY) || Math.abs(dy) < 40)) padUntil = now + 400;
    if (now < padUntil) {
      padUntil = now + 400;
      cam.x += dx / cam.z;
      cam.y += dy / cam.z;
      applyCam();
      return;
    }
    zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0015));
  }, { passive: false });

  // The canvas holds the pointer while a button is down, so the event's target is the canvas
  // itself; the item has to be found from where the cursor is.
  // With the hand, a double-click still opens an image or video; nothing is edited with it.
  vp.addEventListener('dblclick', (e) => {
    if ((tool !== 'select' && tool !== 'pan') || editing) return;
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const handle = hit && hit.closest('.handle');
    if (handle) {
      if (tool === 'select' && !viewOnly) resetMediaSize(handle.dataset.h);
      return;
    }
    const node = hit && hit.closest('.item');
    let it = node && items.get(node.dataset.id);
    if (it && it.type === 'stroke' && it.pid) it = items.get(it.pid);
    if (!it) return;
    if ((viewOnly || tool === 'pan') && it.type !== 'video' && it.type !== 'image') return;
    if (it.type === 'note' || it.type === 'text' || it.type === 'block') startEdit(it.id);
    else if (it.type === 'frame') { if (hit.closest('.frame-head')) startEdit(it.id); }
    else if (it.type === 'video' || it.type === 'image') enterFocus(it.id);
  });

  // Read-only: a plain click on an image or video opens it, since looking closer is the one thing to do.
  if (viewOnly) {
    let down = null;
    vp.addEventListener('pointerdown', (e) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY, skip: !!e.target.closest('.vbar, a, .cchip, .vchip'), play: !!e.target.closest('.vplay') } : null;
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
      else if (it.type === 'image' || it.type === 'video') enterFocus(it.id);
    });
  }

  // ------------------------------------------------------------- drop, paste, copy

  let dragDepth = 0;
  // A link pressed with the pointer moving a little (a folder in the bar, say) is dragged by the browser,
  // and let go over the board it would land as a note of its address. What is dragged from this page
  // itself is never dropped on it.
  let ownDrag = false;
  document.addEventListener('dragstart', () => { ownDrag = true; });
  document.addEventListener('dragend', () => { ownDrag = false; });
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
    dragDepth = 0;
    $('dropzone').hidden = true;
    if (viewOnly || ownDrag) return void (ownDrag = false);
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
    e.clipboardData.setData('text/plain', JSON.stringify({ wipboard: 1, items: [...withDependents(sel)].map((id) => items.get(id)).filter(Boolean) }));
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
  //
  // Comments are made in the viewer (viewer.js), on the image or video that is open there. They are
  // shared, saved and undone like everything else, but kept apart from the items so they never take part
  // in layout, snapping or fitting. Out on the board whatever has comments carries a chip in its corner,
  // and Shift+C lists every thread on the board; picking one opens what it is about.

  let boardPanel = false;   // the list of every thread, out on the board
  const panel = $('threadpanel');

  // Somebody holding a link reads the comments only if the link says so, and writes only if it says that too.
  const canRead = () => !viewOnly || guestReads();
  const canWrite = () => !viewOnly || guestWrites();
  const byTime = (a, b) => (a.t || 0) - (b.t || 0) || (a.id < b.id ? -1 : 1);
  const rootsInOrder = () => [...comments.values()].filter((c) => !c.re).sort(byTime);
  const repliesOf = (id) => [...comments.values()].filter((c) => c.re === id).sort(byTime);
  // A link opens a piece with one click; on the board itself, where a click selects, it takes two.
  const openHow = viewOnly ? 'click' : 'double-click';

  function hostLabel(c) {
    const h = items.get(c.on);
    if (!h) return 'something removed';
    return h.name || (h.type === 'video' ? 'a video' : 'an image');
  }

  function syncComments() {
    syncChips();
    queueMarks();
    renderPanel();
    viewer.refresh();
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
    enterFocus(id);
    if (viewer.current() === id) viewer.togglePanel(true);
  }

  // ---- every thread on the board, out on the board (Shift+C)

  const cpList = el('div', { class: 'cp-list' });
  panel.append(
    el('div', { class: 'cp-head' }, el('h2', { text: 'All comments' }),
      el('button', { class: 'iconbtn', html: ICON.close, title: 'Hide the comments (Shift+C)', onclick: () => togglePanel(false) })),
    cpList,
    el('div', { class: 'cp-foot' }, el('p', { class: 'cp-hint', text: `Comments are written where the work is looked at: ${openHow} an image or video to open it.` })));

  function renderPanel() {
    const shown = boardPanel && canRead() && !openId;
    panel.hidden = !shown;
    if (!shown) return;
    const roots = rootsInOrder().filter((c) => items.has(c.on));
    cpList.replaceChildren(...(roots.length ? roots.map((c) => {
      const replies = repliesOf(c.id).length;
      const text = el('div', { class: 'msg-text' });
      fillText(text, c.text);
      return el('div', { class: `cp-card${c.done ? ' done' : ''}`, 'data-id': c.id, onclick: () => viewer.openComment(c.id) },
        el('div', { class: 'msg' },
          WB.avatar(c.name, c.color),
          el('div', { class: 'msg-main' },
            el('div', { class: 'msg-top' }, el('strong', { text: c.name }), el('span', { class: 'msg-time', text: WB.ago(c.t) }),
              c.done && el('span', { class: 'msg-edited', text: 'resolved' })),
            el('div', { class: 'msg-where' }, el('span', { class: 'msg-on', text: hostLabel(c) })),
            text,
            replies > 0 && el('span', { class: 'msg-edited', text: replies === 1 ? '1 reply' : `${replies} replies` }))));
    }) : [el('p', { class: 'cp-empty' }, el('span', { html: ICON.comment }), el('span', { text: 'No comments yet' }))]));
  }

  function togglePanel(show = !boardPanel) {
    boardPanel = show;
    if (show) closeHelp();
    renderPanel();
  }

  // C: open what is selected, and go to its comment box.
  function startComment() {
    if (!canWrite()) return;
    const one = sel.size === 1 ? items.get([...sel][0]) : null;
    if (!one || (one.type !== 'image' && one.type !== 'video')) return void toast(`Open an image or video to comment on it: ${openHow} it`, { ms: 3200 });
    enterFocus(one.id);
    viewer.startComment();
  }

  // ------------------------------------------------------------- tools and keyboard

  // Commenting is not among them: it is done in the viewer, beside what is being looked at.
  // The last field says where a tool is shown, as classes the stylesheet reads:
  //   wide       only where there is room for the strip down the left; on a phone it is under More
  //   in-viewer  on a phone it is in the strip along the bottom of the viewer too
  //   v-only     on a phone, only in the viewer
  //   phone      only on a phone
  const TOOLS = [
    ['select', 'Select and move (V)', ICON.select],
    ['pan', 'Pan. Or hold Space and drag (H)', ICON.pan, 'wide in-viewer'],
    null,
    ['upload', 'Add images or video. Or just drop or paste them', ICON.upload],
    ['note', 'Note. Click, or drag it onto the board (N)', ICON.note],
    ['text', 'Heading or text. Pick the level, then click or drag it out (T)', ICON.text],
    ['block', 'Coloured heading block. Click, or drag it onto the board (B)', ICON.block, 'wide'],
    ['frame', 'Frame the selection, or draw or drag out a frame (F)', ICON.frame, 'wide'],
    null,
    ['pen', 'Draw. Right-drag to erase (P)', ICON.pen, 'in-viewer'],
    ['eraser', 'Erase drawings (E)', ICON.eraser, 'v-only in-viewer'],
    ['arrow', 'Arrow (A)', ICON.arrow, 'wide'],
    ['laser', 'Laser pointer, visible to everyone (L)', ICON.laser, 'wide in-viewer'],
  ];
  // What a phone has no keyboard for, at the end of the strip along the bottom.
  const TOOL_ACTS = [
    ['more', 'More tools', ICON.more, 'phone', (e) => openToolMenu(e.currentTarget)],
    ['undo', 'Undo (Ctrl+Z)', ICON.undo, 'phone in-viewer', () => stepHistory(undoStack, redoStack)],
    ['redo', 'Redo (Ctrl+Shift+Z)', ICON.redo, 'phone in-viewer', () => stepHistory(redoStack, undoStack)],
  ];
  // The tools a phone keeps under More, which stands in for whichever of them is in hand.
  const MORE_TOOLS = ['arrow', 'block', 'frame', 'laser'];

  const TOOL_LABELS = { select: 'Select', pan: 'Pan', upload: 'Media', note: 'Note', text: 'Heading', block: 'Block', frame: 'Frame', pen: 'Draw', eraser: 'Erase', arrow: 'Arrow', laser: 'Laser', undo: 'Undo', redo: 'Redo', more: 'More' };

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
      note: [NOTE_W * noteScale(), NOTE_W * noteScale() * 0.45],
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
    if (name === 'note') createTextItem('note', { x: p.x - (NOTE_W * noteScale()) / 2, y: p.y - 28 * noteScale() });
    else if (name === 'text') createTextItem('text', { x: p.x - 40, y: p.y - 28 });
    else if (name === 'block') makeFrameLike('block', { x: p.x - BLOCK_W / 2, y: p.y - BLOCK_H / 2, w: BLOCK_W, h: BLOCK_H });
    else makeFrameLike('frame', { x: p.x - FRAME_W / 2, y: p.y - FRAME_H / 2, w: FRAME_W, h: FRAME_H });
  }

  $('toolbar').addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (!btn || e.button !== 0 || e.pointerType === 'touch' || !DRAGGABLE_TOOLS.has(btn.dataset.tool)) return;
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
    const pick = (name) => (suppressToolClick ? null : name === 'upload' ? $('filepick').click() : name === 'frame' ? activateFrame() : setTool(name));
    $('toolbar').replaceChildren(
      ...TOOLS.filter((t) => !viewOnly || (t && (t[0] === 'pan' || t[0] === 'laser'))).map((t) => {
        if (!t) return el('span', { class: 'sep' });
        const [name, title, html, where = ''] = t;
        return el('button', { class: `iconbtn ${where}`, 'data-tool': name, title, html, onclick: () => pick(name) },
          el('span', { class: 'tl', text: TOOL_LABELS[name] }));
      }),
      // More goes with the tools; undo, redo and Clear come after a rule.
      ...(viewOnly ? [] : TOOL_ACTS.flatMap(([act, title, html, where, run]) => [
        act === 'undo' && el('span', { class: 'sep phone in-viewer' }),
        el('button', { class: `iconbtn ${where}`, 'data-act': act, title, html, onclick: run }, el('span', { class: 'tl', text: TOOL_LABELS[act] })),
      ]).filter(Boolean)));
    buildToolOptions();
    syncHistory();
  }

  // More, on a phone: the tools there is no room for in the strip, and what the bar leaves out.
  function openToolMenu(anchor) {
    closeToolMenu();
    const item = (html, label, run, on = false) => el('button', {
      class: `menu-item${on ? ' on' : ''}`, role: 'menuitem', type: 'button',
      onclick: (e) => {
        e.stopPropagation();
        closeToolMenu();
        run();
      },
    }, el('span', { class: 'mi-icon', html }), el('span', { text: label }));
    const menu = el('div', { class: 'menu tool-menu', role: 'menu' },
      item(ICON.arrow, 'Arrow', () => setTool('arrow'), tool === 'arrow'),
      item(ICON.block, 'Colour block', () => setTool('block'), tool === 'block'),
      item(ICON.frame, sel.size ? 'Frame the selection' : 'Frame', activateFrame, tool === 'frame'),
      item(ICON.laser, 'Laser pointer', () => setTool('laser'), tool === 'laser'),
      el('span', { class: 'menu-sep' }),
      item(ICON.fit, 'Fit everything', () => { userMovedView(); fitAll(); }),
      item(ICON.snap, snapOn ? 'Smart snapping: on' : 'Smart snapping: off', toggleSnap, snapOn));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${clamp(r.right - menu.offsetWidth, 8, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.max(8, r.top - menu.offsetHeight - 8)}px`;
    anchor.classList.add('open');
    setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0);
  }
  function closeOutside(e) {
    if (!e.target.closest('.tool-menu')) closeToolMenu();
  }
  function closeToolMenu() {
    for (const m of document.querySelectorAll('.tool-menu')) m.remove();
    $('toolbar').querySelector('[data-act="more"]')?.classList.remove('open');
    document.removeEventListener('pointerdown', closeOutside, true);
  }

  function buildToolOptions() {
    if (tool === 'text') {
      $('tooloptions').replaceChildren(...TEXT_LEVELS.map((l) => el('button', {
        class: `lvl${l.lvl === textPref.lvl ? ' active' : ''}`, title: l.title, text: l.label,
        onclick: () => { textPref.lvl = l.lvl; store('wb:text', textPref); buildToolOptions(); },
      })));
      return;
    }
    // Choosing a colour or a weight while erasing is picking the brush back up.
    const savePen = () => {
      store('wb:pen', pen);
      if (tool === 'eraser') setTool(lastDraw);
      else buildToolOptions();
    };
    $('tooloptions').replaceChildren(
      ...INK.map((c) => el('button', {
        class: `swatch${c === pen.color ? ' active' : ''}`, style: { background: swatchColor(c) }, title: 'Ink colour',
        onclick: () => { pen.color = c; savePen(); },
      })),
      el('span', { class: 'sep' }),
      ...PEN_SIZES.map((s) => el('button', {
        class: `iconbtn${s === pen.size && tool !== 'eraser' ? ' active' : ''}`, title: 'Line weight',
        onclick: () => { pen.size = s; savePen(); },
      }, el('i', { class: 'dot', style: { width: `${s + 3}px`, height: `${s + 3}px` } }))),
      el('span', { class: 'sep' }),
      el('button', {
        class: `iconbtn${tool === 'eraser' ? ' active' : ''}`, title: 'Eraser: drag over a drawing to remove it (E)', html: ICON.eraser,
        onclick: () => setTool(tool === 'eraser' ? lastDraw : 'eraser'),
      }));
  }

  let lastDraw = 'pen';
  function setTool(name) {
    // The only tools a link has are the hand and the laser.
    if (viewOnly && name !== 'laser') name = 'pan';
    // The viewer's tools: the brush for the piece, the eraser, the laser for pointing while talking, and
    // on a phone the hand for looking around.
    tool = name;
    if (name === 'pen' || name === 'arrow') lastDraw = name;
    document.body.dataset.tool = name;
    for (const b of $('toolbar').querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === name);
    // More stands in for the tool from under it that is in hand.
    const more = $('toolbar').querySelector('[data-act="more"]');
    if (more) {
      const under = MORE_TOOLS.includes(name);
      more.classList.toggle('active', under);
      more.firstElementChild.outerHTML = under ? ICON[name] : ICON.more;
      more.lastElementChild.textContent = under ? TOOL_LABELS[name] : TOOL_LABELS.more;
    }
    $('tooloptions').hidden = name !== 'pen' && name !== 'arrow' && name !== 'eraser' && name !== 'text';
    buildToolOptions();
    if (name !== 'select') setSel([]);
    sendP({ l: name === 'laser' ? 1 : 0 });
    requestLaser();
  }

  const TOOL_KEYS = { v: 'select', h: 'pan', n: 'note', t: 'text', b: 'block', f: 'frame', p: 'pen', e: 'eraser', a: 'arrow', l: 'laser' };

  // Space held is the hand for moving around; tapped, it plays or pauses, as in any player.
  let spaceTap = false;
  let spaceAt = 0;

  // Each key means one thing in the viewer and one thing on the board, whatever was clicked last:
  //   arrows      in the viewer, the next or previous image or video; on the board, nudge the selection
  //   , and .     one frame back or on (with Shift, a second), on the open or the selected video
  //   Space, K    play or pause
  window.addEventListener('keydown', (e) => {
    // Watching a presentation, nothing here is to be steered.
    if (!booted || isTyping(e.target) || spectating) return;
    // With something open the keys are the viewer's, bar the shortcuts list.
    if (viewer.isOpen() && e.key !== '?') return;
    // A dialog is open over the board: its keys are its own, and Delete must not reach what is selected behind it.
    if (document.querySelector('dialog[open]')) return;
    const k = e.key.toLowerCase();
    // A control reached with Tab is pressed with Space or Enter, as anywhere else. (One clicked with the
    // mouse never keeps the focus, so on the board itself both stay canvas shortcuts.)
    if ((e.code === 'Space' || k === 'enter') && e.target.closest && e.target.closest('button, a[href], input')) return;
    // Looking around is all a read-only link allows.
    if (viewOnly) {
      const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
      const look = e.code === 'Space' || k === 'escape' || k === 'home' || k === '?' || k === 'h' || (k === 'l' && plain)
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
      document.body.classList.add('space-held');
      return;
    }
    const altGr = e.ctrlKey && e.altKey;
    if ((e.ctrlKey || e.metaKey) && !altGr) {
      if (k === 'z') e.shiftKey ? stepHistory(redoStack, undoStack) : stepHistory(undoStack, redoStack);
      else if (k === 'y') stepHistory(redoStack, undoStack);
      else if (k === 'a') { setTool('select'); setSel([...items.values()].filter((it) => selectable(it) && !it.pid).map((it) => it.id)); }
      else if (k === 'd') duplicate();
      else if (k === 'p') packSelection();
      else if (k === '0') {
        userMovedView();
        zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1 / cam.z);
      }
      else return;
      e.preventDefault();
      return;
    }
    if (e.altKey && !altGr) return;

    const video = selectedVideo();
    if (e.shiftKey && e.code === 'Digit1') { userMovedView(); fitAll(); }
    else if (e.shiftKey && e.code === 'Digit2') { const r = selBounds(); if (r) { userMovedView(); fitRect(r); } }
    else if (k === 'home') { userMovedView(); fitAll(); }
    else if (k === '?') toggleHelp();
    else if (k === 's' && !e.shiftKey) toggleSnap();
    else if (k === 'f' && !e.shiftKey) activateFrame();
    else if (k === 'c' && e.shiftKey) togglePanel();
    else if (k === 'c') startComment();
    else if (k === 'v' && e.shiftKey) fileSelection();
    else if (k === 'delete' || k === 'backspace') deleteSel();
    else if (k === 'escape') {
      // One thing at a time, the nearest first.
      if (!$('helppanel').hidden) toggleHelp();
      else if (!$('actpanel').hidden) toggleActivity(false);
      else if (keptRing && keptRing.open) keptRing.close();
      else if (!catPanel.hidden) toggleCatalogue(false);
      else if (!$('setpanel').hidden) toggleSettings(false);
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
    else if (TOOL_KEYS[k] && !e.shiftKey) setTool(TOOL_KEYS[k]);
    else return;
    e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || (viewer.isOpen() && !spaceDown)) return;
    const tapped = spaceDown && spaceTap && performance.now() - spaceAt < 400;
    spaceDown = false;
    spaceTap = false;
    document.body.classList.remove('space-held');
    const video = tapped ? selectedVideo() : null;
    if (video) toggleVideo(video);
  });
  window.addEventListener('blur', () => {
    spaceDown = false;
    spaceTap = false;
    document.body.classList.remove('space-held');
  });
  window.addEventListener('resize', () => (unframed ? frameFirst() : applyCam()));

  // The shortcuts, by what they are for, as keys rather than sentences. What wants explaining is in
  // the guide, the last tab, and nowhere else: the tools themselves stay quiet.
  const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  // Keys held together: ⇧⌘Z on a Mac, Ctrl+Shift+Z elsewhere.
  const combo = (...keys) => (MAC
    ? keys.map((k) => ({ shift: '⇧', mod: '⌘', alt: '⌥' })[k] || k).join('')
    : keys.map((k) => ({ shift: 'Shift', mod: 'Ctrl', alt: 'Alt' })[k] || k).join('+'));
  // A key is written as it is; anything after a tilde is said in words.
  const HELP = [
    { id: 'board', label: 'Board', icon: ICON.pan, rows: [
      ['Pan', 'Space', '~+ drag'],
      ['Zoom', '~wheel or pinch'],
      ['Fit everything', combo('shift', '1')],
      ['Fit selection', combo('shift', '2')],
      ['Undo', combo('mod', 'Z')],
      ['Redo', MAC ? combo('shift', 'mod', 'Z') : combo('mod', 'shift', 'Z')],
      ['Snapping', 'S'],
      ['Move without snapping', '~hold', combo('mod')],
      ['Follow someone', '~click their avatar'],
    ] },
    { id: 'make', label: 'Create', icon: ICON.note, rows: [
      ['Note', 'N'],
      ['Heading', 'T'],
      ['Colour block', 'B'],
      ['Frame', 'F'],
      ['Draw', 'P'],
      ['Arrow', 'A'],
      ['Laser', 'L'],
      ['Erase', 'E', '~or right-drag'],
      ['Add media', '~drop or paste'],
      ['Edit text', 'Enter', '~or double-click'],
    ] },
    { id: 'arrange', label: 'Arrange', icon: ICON.tidy, rows: [
      ['Duplicate', combo('mod', 'D'), '~or', combo('alt'), '~+ drag'],
      ['Tidy into a grid', combo('mod', 'P')],
      ['File as a version', combo('shift', 'V')],
      ['…then copy the row above', combo('mod', 'D')],
      ['…then fill in the rows below', combo('shift', 'Enter')],
      ['Bring to front', ']'],
      ['Send to back', '['],
      ['Scale a note with its text', combo('shift'), '~+ drag a corner'],
    ] },
    { id: 'viewer', label: 'Viewer', icon: ICON.focus, rows: [
      ['Open', '~double-click'],
      ['Close', 'Esc'],
      ['Previous / next', '←', '→'],
      ['Comment', 'C'],
      ['Show comments', combo('shift', 'C')],
    ['Show the strip', combo('shift', 'F')],
      ['Mention', '@'],
      ['Laser, then brush', 'L'],
      ['Erase a drawing', 'E'],
      ['Picture, or the venue in 3D', '2', '3'],
      ['Next camera in 3D', 'V'],
    ] },
    { id: 'video', label: 'Video', icon: ICON.play, rows: [
      ['Play / pause', 'Space', '~or', 'K'],
      ['One frame', ',', '.'],
      ['One second', combo('shift', ','), combo('shift', '.')],
      ['Sound', 'M'],
      ['Time, frame or timecode', '~click the time'],
    ] },
    { id: 'guide', label: 'Guide', icon: ICON.help, guide: [
      [ICON.stack, 'Versions', 'On a board in a project, select images or videos and file them as versions of an asset, set or shot (Shift+V). Their comments go with them, and show on every board the version is on. The catalogue button adds versions to the board.'],
      [ICON.comment, 'Comments with drawings', 'Draw on the open image or video while writing a comment, and the drawing belongs to it: it shows when the comment is read, on the frame it is about.'],
      [ICON.kept, 'Video cache', `The videos on boards you open, and the newest of your work, of what you are cc'd on and of what you pinned, are saved on this computer, so they open and scrub at once. Up to ${KEPT_MAX / 1024 ** 3} GB in all; the ones opened longest ago make room.`],
      [ICON.activity, 'Snapshots', 'Before each round of changes the board is kept as it was. Putting one back keeps what is there now as a snapshot too, so nothing is lost. Comments and catalogue versions are not touched; sticky notes go back with everything else.'],
      [ICON.download, 'Originals', 'Video is made lighter on upload so it plays smoothly for review. The file it came from is kept, and is what is downloaded.'],
      [ICON.link, 'Sharing', 'A link lets people outside the team look, read the comments or comment, without signing in, until you turn it off or it runs out.'],
      [ICON.tag, 'File names', 'Board settings can show every image and video with its file name, for everyone on the board.'],
    ] },
  ];
  let helpTab = HELP.some((t) => t.id === store('wb:helptab')) ? store('wb:helptab') : 'board';

  function keyChips(parts) {
    return parts.map((part) => (part.startsWith('~')
      ? el('span', { class: 'kb-say', text: part.slice(1) })
      : WB.keys(part)));
  }

  function paintHelp() {
    const help = $('helppanel');
    const tab = HELP.find((t) => t.id === helpTab);
    help.replaceChildren(
      el('div', { class: 'act-head' }, el('h2', { text: 'Help' }),
        el('button', { class: 'iconbtn', html: ICON.close, title: 'Close (Esc)', onclick: () => toggleHelp() })),
      el('div', { class: 'help-tabs', role: 'tablist' }, HELP.map((t) => el('button', {
        class: `help-tab${t.id === helpTab ? ' on' : ''}`, role: 'tab', 'aria-selected': String(t.id === helpTab), title: t.label,
        onclick: () => { helpTab = t.id; store('wb:helptab', t.id); paintHelp(); },
      }, el('span', { class: 'help-ic', html: t.icon }), el('span', { text: t.label })))),
      tab.guide
        ? el('div', { class: 'guide' }, tab.guide.map(([ic, title, text]) => el('section', {},
          el('span', { class: 'guide-ic', html: ic }), el('div', {}, el('h3', { text: title }), el('p', { text })))))
        : el('dl', { class: 'keys' }, tab.rows.flatMap(([what, ...keys]) => [el('dt', { text: what }), el('dd', {}, keyChips(keys))])));
  }

  function closeHelp() {
    $('helppanel').hidden = true;
    $('help').classList.remove('active');
  }

  function toggleHelp() {
    const help = $('helppanel');
    help.hidden = !help.hidden;
    $('help').classList.toggle('active', !help.hidden);
    if (!help.hidden) {
      paintHelp();
      toggleActivity(false);
      toggleSettings(false);
      toggleCatalogue(false);
    }
    // Out on the board the two would sit on top of each other.
    if (!help.hidden && boardPanel) togglePanel(false);
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
    userMovedView();
    fitAll();
  });

  // ------------------------------------------------------------- following

  function follow(id) {
    following = id;
    const peer = peers.get(id);
    if (peer && peer.p.f && items.has(peer.p.f)) {
      followFocus(peer.p.f);
      followThread(peer.p.t);
      catchUp(peer);
      followZoom(peer.p.z);
      follow3d(peer.p.d);
    } else {
      viewer.close();
      if (peer && peer.p.v) followView(peer.p.v, 380);
    }
    updateFollowUI();
  }

  // Starting to follow, or following into another piece, lands on the moment of the video the person
  // followed has open, playing or stopped as theirs is. Played on since they last touched it, it is where
  // it has got to by now.
  function catchUp(peer) {
    const m = peer.p.m;
    if (!Array.isArray(m) || m[0] !== openId || !Number.isFinite(m[1])) return;
    const it = items.get(openId);
    let at = m[1] + (m[2] ? (performance.now() - (peer.mAt || performance.now())) / 1000 : 0);
    if (it && it.dur > 0) at %= it.dur;
    viewer.followMedia(openId, !!m[2], at);
  }

  // ...and seeing it as they do, in 2D or on the model in 3D.
  function follow3d(d) {
    if (openId) viewer.follow3d(d || null);
  }

  // Following someone means seeing as much of the piece as they do: zoomed in where they are.
  function followZoom(z) {
    if (openId) requestAnimationFrame(() => viewer.followZoom(z === undefined ? null : z));
  }

  // Watching a presentation, the presenter is followed from the moment they are on the board, and again
  // whenever they come back to it.
  let lead = null;
  function followLead() {
    if (!spectating || !lead) return;
    const peer = [...peers.values()].find((p) => p.lead === lead);
    if (peer && following !== peer.id) follow(peer.id);
  }

  // Following someone means reading the thread they are reading: a drawing only shows with its thread.
  function followThread(id) {
    if (openId) viewer.follow(openId, { thread: typeof id === 'string' ? id : null });
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
        class: `avatar${following === peer.id ? ' following' : ''}${peer.lead ? ' presenting' : ''}`,
        style: { background: peer.color },
        title: `${peer.name}${peer.lead ? ', presenting the project' : ''}. Click to ${following === peer.id ? 'stop following' : 'follow their view'}`,
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
    peers.set(data.id, { id: data.id, name: data.name, color: data.color, p: data.p || {}, mAt: performance.now(), cur: null, viewer: !!data.viewer, lead: data.lead || null });
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
    document.title = `${name} · Boards`;
    if (document.activeElement !== $('boardname')) $('boardname').value = name;
  }

  $('boardname').addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'Untitled';
    e.target.value = name;
    document.title = `${name} · Boards`;
    sendOps([{ t: 'meta', patch: { name } }]);
  });
  $('boardname').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') e.target.blur();
  });

  function onInit(msg) {
    finishEdit();
    flushLive();
    // A snapshot put back: the board is now what it was then, for everyone. What this page had not yet
    // had acked is dropped rather than laid over it, and undo starts afresh (an undo from before would
    // take back changes the board no longer has, and bring things back that the snapshot took away).
    const queued = msg.restored ? [] : outbox.splice(0);
    if (msg.restored) {
      outbox.length = 0;
      undoStack.length = 0;
      redoStack.length = 0;
    }
    pendingKeys.clear();
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
    versionInfo.clear();
    for (const v of msg.versions || []) versionInfo.set(v.id, v);
    board3d = msg.view3d || null;
    // The board's project has a model of its venue: the 3D view is made ready now, so it is there when asked for.
    if (board3d && [...versionInfo.values()].some((v) => v.look3d)) {
      viewer.prepare3d(board3d);
      // Watching a presentation, the page around this one counts the model among what is cached.
      if (spectating) window.parent.postMessage({ wb: 'model', src: board3d.model }, location.origin);
    }
    project = msg.project || null;
    $('catalogue').hidden = !project || viewOnly;
    showPresent();
    if (!project && !catPanel.hidden) toggleCatalogue(false);
    for (const it of msg.items) {
      if (it.type === 'comment') {
        comments.set(it.id, it);
        continue;
      }
      items.set(it.id, it);
      renderItem(it);
    }
    cmDirty = true;
    boardLoaded = true;
    orderDirty = true;
    setBoardName(msg.board.name);
    applySettings(msg.board.settings || {}, true);
    // What was open may have been deleted while this window was disconnected.

    for (const id of [...peers.keys()]) dropPeer(id);
    for (const p of msg.peers) addPeer(p);
    lead = msg.lead || null;

    // Anything done while disconnected is sent again, with the numbers it had: what the server already
    // applied before the connection dropped it acks and leaves alone. It is laid over the server's state
    // here too, until the acks come.
    for (const batch of queued) {
      applyOps(batch.ops);
      for (const k of batch.keys) pendingKeys.set(k, (pendingKeys.get(k) || 0) + 1);
      outbox.push(batch);
      sendBatch(batch);
    }
    if (msg.restored && !firstInit) toast('A snapshot was put back. Undo starts afresh from here.', { ms: 6000 });
    setSel([...sel]);
    afterChange();
    paintKept();
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
        viewer.openComment(asked[1]);
      }
      if (viewOnly && !spectating && [...items.values()].some((it) => it.type === 'image' || it.type === 'video')) {
        toast('Click an image or video to look closer', { ms: 7000 });
      }
    } else {
      applyCam();
    }
    sendP({ l: tool === 'laser' ? 1 : 0, f: openId, t: openId ? viewer.thread() : null });
    // After a dropped connection the others have forgotten what is on its way in from here.
    if (standIns.size) shareStandIns();
    updateFollowUI();
    followLead();
  }

  function onMessage(msg) {
    if (msg.t === 'init') {
      onInit(msg);
    } else if (msg.t === 'op') {
      // The server's own copy of ops this page sent, where it changed them (a version it would not keep,
      // a comment it rewrote): they are what everyone else has, so they win over what is still unacked.
      applyOps(msg.ops, msg.fix ? false : msg.sync ? 'sync' : true);
      refreshPeerSel();
    } else if (msg.t === 'ack') {
      onAck(msg);
    } else if (msg.t === 'versions') {
      learnVersions(msg.list);
      viewer.refresh();
    } else if (msg.t === 'view3d') {
      board3d = msg.view3d || null;
      learnVersions(msg.versions);
      viewer.refresh();
    } else if (msg.t === 'join') {
      addPeer(msg.peer);
      updateFollowUI();
      followLead();
    } else if (msg.t === 'lead') {
      const peer = peers.get(msg.id);
      if (peer) peer.lead = msg.lead || null;
      renderPeers();
      followLead();
    } else if (msg.t === 'leave') {
      // Whoever was being followed went: said, rather than the view just stopping.
      const gone = following === msg.id && !spectating && peers.get(msg.id);
      dropPeer(msg.id);
      refreshPeerSel();
      updateFollowUI();
      if (gone) toast(`${gone.name} left the board`, { ms: 3500 });
    } else if (msg.t === 'p') {
      const peer = peers.get(msg.id);
      if (!peer) return;
      Object.assign(peer.p, msg.p);
      if ('m' in msg.p) peer.mAt = performance.now();
      if ('c' in msg.p || 'l' in msg.p) {
        placeCursor(peer);
        requestLaser();
      }
      if ('s' in msg.p) refreshPeerSel();
      if ('u' in msg.p) showRemoteStandIns(peer);
      if ('f' in msg.p && following === peer.id) {
        followFocus(peer.p.f);
        catchUp(peer);
        follow3d(peer.p.d);
      }
      if ('t' in msg.p && following === peer.id) followThread(peer.p.t);
      if ('z' in msg.p && following === peer.id) followZoom(peer.p.z);
      if ('d' in msg.p && following === peer.id) follow3d(peer.p.d);
      if ('v' in msg.p && following === peer.id && !gesture) followView(peer.p.v);
    } else if (msg.t === 'laser') {
      const peer = peers.get(msg.id);
      // Pointed at a piece open in the viewer, or somewhere on the board.
      if (peer && msg.on) viewer.laser(peer.id, peer.color, msg.on, msg.pts);
      else if (peer) addRemoteLaser(peer, msg.pts);
    } else if (msg.t === 'media') {
      if (following !== msg.from) return;
      if (openId === msg.id) return void viewer.followMedia(msg.id, msg.playing, msg.time);
      const video = videoOf(msg.id);
      if (!video) return;
      // Stopped, it shows exactly the frame of the person followed; playing, small drift is left alone rather than stutter.
      if (Math.abs(whereOf(video) - msg.time) > (msg.playing ? 0.25 : 0.001)) goTo(video, msg.time);
      if (msg.playing) video.play().catch(() => {});
      else video.pause();
    }
  }

  const metaUrl = spectating ? `/api/watch/${watchToken}` : viewOnly ? `/api/shared/${boardId}` : `/api/boards/${boardId}`;
  let dead = false;

  function connect() {
    if (dead) return;
    const where = spectating ? `watch=${watchToken}&board=${boardId}` : `${viewOnly ? 'share' : 'board'}=${boardId}`;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${where}`);
    // Presenting the project, this page is where the people watching follow you on the board.
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: me.name, color: me.color, cid, ...(!viewOnly && WBPresent.token() && { present: WBPresent.token() }) }));
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      online = false;
      if (dead || away) return;
      if (e.code === 4003) return fatal('This board was moved to a workspace you cannot open.');
      if (e.code === 4004) return fatal('This board was deleted.');
      if (e.code === 4005) return fatal('This link is not shared any more.');
      // Watching a presentation that has gone on to something else: the page around this one moves on.
      if (spectating && e.code === 4007) return void (dead = true);
      // What the link allows changed: open it again as it is now.
      if (e.code === 4006) return location.reload();
      $('conn').hidden = false;
      WB.offline(true);
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 8000);
      checkAccess();
    };
  }

  // Leaving the page lets go of the connection, so nobody is shown on the board who is not there. A
  // browser may keep a page as it was, to come back to with Back, and a connection it is left holding
  // stays open all that while: each time somebody went out and came in again there was one more of them.
  // A page that is come back to that way joins again.
  let away = false;
  window.addEventListener('pagehide', () => {
    away = true;
    if (ws) ws.close();
  });
  window.addEventListener('pageshow', (e) => {
    if (!away) return;
    away = false;
    if (e.persisted) connect();
  });

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

  // Watching a presentation, this page goes by the name given on the page around it (watch.js), never asks.
  const watcher = (() => {
    try {
      return spectating && JSON.parse(sessionStorage.getItem('wb:watcher'));
    } catch {
      return null;
    }
  })();
  me = watcher && watcher.name ? watcher : spectating ? { name: 'Viewer', color: WB.colors[0] } : await WB.askName();
  let meta;
  try {
    meta = await WB.api('GET', metaUrl);
  } catch {
    return fatal(viewOnly ? 'This link is not shared any more.' : 'This board does not exist.');
  }
  // The boards page opens on the workspace this board lives in, and the board is remembered as opened lately.
  if (!viewOnly && meta.workspace) store('wb:workspace', meta.workspace);
  if (!viewOnly) WB.remember({ kind: 'board', id: boardId });
  if (viewOnly) {
    setAccess(meta.access);
    $('boardname').readOnly = true;
    // The corner logo is not a way back to the team's boards for someone holding a link.
    $('back').removeAttribute('href');
    $('back').removeAttribute('title');
  }
  else {
    $('back').href = meta.folderId ? WB.href.abs(WB.href.folder(meta.folderId)) : '/';
    // Where the board is, between the logo and its name: the folders (or the project) it is in, each a
    // way back to it.
    if (meta.folderId) {
      WB.api('GET', '/api/library').then((lib) => {
        const byId = new Map(lib.folders.map((f) => [f.id, f]));
        const trail = [];
        for (let f = byId.get(meta.folderId); f && trail.length < 8; f = byId.get(f.parentId)) trail.unshift(f);
        // Back from a board of a project is to the project's reviews, where the board is listed.
        if (byId.get(meta.folderId)?.project) $('back').href = WB.href.abs(WB.href.reviews(meta.folderId));
        $('boardname').before(...trail.flatMap((f) => [
          el('a', { class: 'bar-crumb board-folder', draggable: 'false', href: WB.href.abs(WB.href.folder(f.id)), text: f.name, title: f.project ? `The ${f.name} project` : `The ${f.name} folder` }),
          el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' }),
        ]));
      }).catch(() => { /* the logo still goes back */ });
    }
  }

  // ---- what this board is set to
  //
  // A board has a few settings of its own, the same for everyone on it and kept with it:
  //   names   every image and video shows its file name
  // They are changed from the board's menu in the bar, which is also the way to its sharing, its files
  // and its activity.
  let boardSettings = {};
  function applySettings(patch, whole = false) {
    boardSettings = whole ? { ...patch } : { ...boardSettings, ...patch };
    document.body.classList.toggle('show-names', !!boardSettings.names);
    if (!$('setpanel').hidden) paintSettings();
  }
  function setBoardSetting(key, value) {
    applySettings({ [key]: value });
    sendOps([{ t: 'meta', patch: { settings: { [key]: value } } }]);
  }

  const setPanel = $('setpanel');
  function paintSettings() {
    const names = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Show file names' });
    names.checked = !!boardSettings.names;
    names.addEventListener('change', () => setBoardSetting('names', names.checked));
    const shared = !!(meta.share && meta.share.token);
    const files = new Set([...items.values()].filter(onServer).map((it) => it.orig || it.src)).size;
    // Going on to one of the others puts this away first.
    const go = (ic, label, value, run, disabled = false) => el('button', {
      type: 'button', class: 'set-row', disabled, onclick: () => { toggleSettings(false); run(); },
    }, el('span', { class: 'set-ic', html: ic }), el('span', { class: 'set-label', text: label }), value, el('span', { class: 'set-go', html: ICON.chevron }));
    setPanel.replaceChildren(
      el('div', { class: 'act-head' }, el('h2', { text: 'Board settings' }),
        el('button', { class: 'iconbtn', html: ICON.close, title: 'Close (Esc)', onclick: () => toggleSettings(false) })),
      el('div', { class: 'set-group' },
        el('label', { class: 'set-row', title: 'Every image and video shows its file name, for everyone on this board' },
          el('span', { class: 'set-ic', html: ICON.tag }), el('span', { class: 'set-label', text: 'File names' }), names)),
      el('div', { class: 'set-group' },
        WB.info().canShare && go(ICON.link, 'Sharing',
          el('span', { class: `set-chip${shared ? ' on' : ''}`, text: shared ? 'Link on' : 'Team only' }), () => openShare(meta)),
        go(ICON.download, 'Download originals',
          el('span', { class: 'set-value', text: files ? `${files} ${files === 1 ? 'file' : 'files'} · zip` : 'Nothing yet' }), downloadBoard, !files),
        go(ICON.activity, 'Activity and snapshots', null, () => toggleActivity(true)),
        // Here too, for a phone, where the bar has no room for its own button.
        go(ICON.help, 'Guide and shortcuts', null, () => toggleHelp())));
  }

  // A panel in the corner, like the shortcuts and the activity, and in their place: one of them at a time.
  function toggleSettings(show = setPanel.hidden) {
    setPanel.hidden = !show;
    $('boardmenu').classList.toggle('active', show);
    if (!show) return;
    closeHelp();
    toggleActivity(false);
    toggleCatalogue(false);
    if (boardPanel) togglePanel(false);
    paintSettings();
  }

  // ------------------------------------------------------------- the catalogue
  //
  // A board in a project folder can file its images and videos as versions of the project's assets,
  // sets and shots, and take versions from the catalogue onto itself. A piece that shows a version says
  // which in its corner ("kilo-0010 anim v5"), and says so when a newer one has been filed since. What
  // is said about a version is said about it on every board it is on (see the comments in server.js).
  //
  // Nothing has to be named for this: filing asks only which asset, set or shot it is (and the task, if
  // the project uses them). What the file's name, the frame it is in, and the last choice made here say
  // is filled in ahead.

  const N = window.WBNaming;

  function learnVersions(list) {
    const ids = new Set();
    for (const v of list || []) {
      versionInfo.set(v.id, v);
      ids.add(v.id);
    }
    for (const it of items.values()) {
      if (!ids.has(it.ver)) continue;
      const node = els.get(it.id);
      if (node) paintVerChip(node, it);
    }
    viewer.refresh();
    seltools.dataset.sig = '';
    updateOverlay();
  }


  function paintVerChip(node, it) {
    const v = it.ver ? versionInfo.get(it.ver) : null;
    let chip = node.querySelector(':scope > .vchip');
    node.classList.toggle('filed', !!v);
    if (!v) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = el('button', { class: 'vchip', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); verMenu(it.id, chip); } },
        el('span', { class: 'vchip-label' }), el('span', { class: 'vchip-new' }));
      node.append(chip);
    }
    chip.firstChild.textContent = v.label;
    chip.lastChild.textContent = v.newest ? `v${v.newest.number}` : '';
    chip.classList.toggle('stale', !!v.newest);
    chip.title = v.newest
      ? `${v.label}. Version ${v.newest.number} has been filed since. Click to swap it in`
      : `${v.label}${v.artist ? `, by ${v.artist}` : ''}. Click for more`;
  }


  // What can be done from a version's chip: swap in the newer one, look it up in the catalogue.
  function verMenu(id, anchor) {
    const it = items.get(id);
    const v = it && versionInfo.get(it.ver);
    if (!v) return;
    WB.menu(anchor, [
      el('div', { class: 'vmenu-head' }, el('b', { text: v.label }),
        el('span', { text: [v.artist && `by ${v.artist}`, v.descriptor].filter(Boolean).join(' · ') || 'In the catalogue' })),
      v.newest && !viewOnly && [`Swap in v${v.newest.number}`, () => swapVersion(id, v.newest.id)],
      !viewOnly && ['Look through all its versions', () => lookAtEntity(v.entityId, v.id)],
      !viewOnly && ['Put another version on the board', () => toggleCatalogue(true, v.entityId)],
      !viewOnly && { href: WB.href.abs(WB.href.catalogue(v.projectId, { entity: v.entityId })), label: 'Its page in the catalogue' },
    ], { cls: 'vmenu', align: 'left' });
  }

  // The piece shows another version of the same thing, in its place and at its width. One that is an
  // image where the other was a video goes in beside it instead.
  async function swapVersion(id, toId) {
    let v;
    try {
      v = await WB.api('GET', `/api/versions/${toId}`);
    } catch (err) {
      return toast(err.message);
    }
    const it = items.get(id);
    if (!it) return;
    versionInfo.set(v.id, v);
    if (v.look.type !== it.type) return placeMedia([{ ...v.look, ver: v.id }], { x: it.x + it.w + 40, y: it.y + it.h / 2 });
    const patch = { ver: v.id };
    for (const key of ['src', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name']) patch[key] = v.look[key] ?? null;
    if (v.look.nw && v.look.nh) patch.h = round(it.w * (v.look.nh / v.look.nw));
    exec([{ t: 'set', id, patch }]);
    toast(`Now ${v.label}`, { ms: 2500 });
  }

  // The images and videos among these that could be filed: on the server, and not a version already.
  const fileable = (list) => list.filter((it) => onServer(it) && !(it.ver && versionInfo.has(it.ver)));

  async function fileSelection() {
    if (!project || viewOnly) return;
    const list = fileable([...sel].map((id) => items.get(id)).filter(Boolean));
    if (!list.length) return void toast(project ? 'Select images or videos to file them as versions' : 'Put this board in a project folder to file versions');
    let cat;
    try {
      cat = await WB.api('GET', `/api/projects/${project.id}`);
    } catch (err) {
      return toast(err.message);
    }
    openFiling(list, cat);
  }

  // The dialog that files pieces as versions. Each piece says on its own row which asset, set or shot it
  // is, and the task if any: filled in ahead from its name (or what the project has learned about names
  // like it), else the frame it is in, else (for one piece) the last choice, and its task with that only
  // when it is the last choice's. Several pieces are never lumped together: each goes where its row
  // says. `prefill` (by piece) is what the rows said before, when filing is changed straight after or
  // was refused (`problem` then says why).
  function openFiling(list, cat, prefill = null, problem = null) {
    const settings = (cat.project && cat.project.settings) || {};
    const useTasks = settings.tasks !== false;
    const rules = settings.rules || [];
    const remembered = store(`wb:file:${project.id}`) || null;
    const known = (name) => !!name && (cat.entities.some((e) => e.name === name) || !!N.typeByShape(name));
    // The fields are the catalogue importer's too (filing.js).
    const rows = [];
    const shared = {
      useTasks, remembered, getEntities: () => cat.entities, getTasks: () => cat.tasks, passes: cat.passList || null,
      peers: () => rows.map((row) => row.f), rules: () => rules, onChange: () => paint(),
    };

    const dlg = el('dialog', { class: `dlg file-dlg${list.length > 1 ? ' many' : ''}` });
    const hint = el('span', { class: 'file-hint' });
    // What a key did to the rows, with its Undo: said here, since a toast would be behind the dialog.
    const status = el('p', { class: 'file-status', role: 'status', hidden: true });
    let statusGone = 0;
    shared.say = (text, undo) => {
      clearTimeout(statusGone);
      status.replaceChildren(el('span', { text }), undo ? el('button', { type: 'button', class: 'file-fix', text: 'Undo', onclick: () => { undo(); status.hidden = true; paint(); } }) : '');
      status.hidden = false;
      statusGone = setTimeout(() => { status.hidden = true; }, 10000);
    };
    const ok = el('button', { type: 'submit', class: 'btn primary', text: list.length > 1 ? `File ${list.length}` : 'File' });
    for (const it of list) {
      const parsed = N.parse(it.name || '', cat.entities);
      const ruled = !parsed.entity && N.byRules(it.name || '', rules, cat.tasks);
      const frame = frameOf(it);
      const fromFrame = frame && known(N.tokenize(frame.title)) ? N.tokenize(frame.title) : null;
      const before = prefill && prefill.get(it.id);
      const lastOne = list.length === 1 && remembered ? remembered.entity || '' : '';
      const entity = before ? before.entity : parsed.entity || (ruled && ruled.entity) || fromFrame || lastOne;
      const f = WBFiling.fields({
        ...shared,
        label: it.name || 'it',
        entity,
        task: before ? before.task || '' : parsed.task || (ruled && ruled.task) || (entity && remembered && entity === remembered.entity && entity === lastOne ? remembered.task || '' : ''),
        named: !before && !!(parsed.entity || ruled), piece: () => it,
        number: before ? before.number : (ruled && ruled.number) || (parsed.entity && parsed.hip) || null,
        pass: before ? before.pass : parsed.pass || (ruled && ruled.pass),
      });
      const row = { it, f, ent: f.ent, task: f.task, type: f.type, taught: !parsed.entity && !(ruled && ruled.rule.pattern) };
      row.node = el('div', { class: 'file-row' },
        el('img', { src: it.th || it.prev || (it.type === 'image' ? it.src : it.poster) || '', alt: '' }),
        el('span', { class: 'file-name', text: it.name || (it.type === 'video' ? 'Video' : 'Image'), title: it.name || '' }),
        el('span', { class: 'file-fields' }, f.line));
      rows.push(row);
    }
    const nameOf = (row) => row.f.name();
    for (const row of rows) row.f.sync();
    // What each video looks like a new version of, asked of the server: first among its suggestions.
    WBFiling.findLikely(project.id, list.map((it) => ({ key: it.id, look: it }))).then((answers) => {
      for (const row of rows) if (answers[row.it.id]) row.f.setLikely(answers[row.it.id]);
    });

    // For several, one answer for them all, to start from.
    const fill = WBFiling.forAll({
      ...shared,
      apply: (ent, task) => {
        for (const row of rows) {
          if (ent) row.ent.value = ent;
          if (task) row.task.value = task;
          WBFiling.changed();
          row.f.settle();
          row.f.sync();
        }
        paint();
      },
    });

    function paint() {
      for (const row of rows) row.f.sync();
      const missing = rows.filter((row) => !nameOf(row)).length;
      const unsure = rows.filter((row) => nameOf(row) && !row.f.ready()).length;
      ok.disabled = missing + unsure > 0;
      // Only what keeps it from being filed, in a few words: the rows themselves say the rest.
      hint.textContent = [missing && `${missing} to name`, unsure && `${unsure} to sort out`].filter(Boolean).join(' · ');
      hint.hidden = !hint.textContent;
    }

    let confirmed = false;
    dlg.append(el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        for (const row of rows) row.f.settle();
        if (rows.some((row) => !row.f.ready())) return paint();
        // A new sequence is said out loud once before it is made.
        if (!(await WBFiling.confirmSequences(rows.map((row) => row.f)))) return;
        confirmed = true;
        dlg.close();
      },
    },
    el('div', { class: 'file-dlg-head' }, el('h2', { text: list.length > 1 ? `File ${list.length} pieces as versions` : 'File as a version' }), WBFiling.keysButton()),
    list.length > 1 && fill,
    el('div', { class: 'file-rows' },
      // What each part of the rows' lines is, said once over them.
      el('div', { class: 'file-row file-labels-row' }, el('span'), el('span'), el('span', { class: 'file-fields' }, WBFiling.lineHead({ useTasks, passes: cat.passList || null }))),
      rows.map((row) => row.node)),
    status,
    el('div', { class: 'dlg-actions' }, hint,
      el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), ok)));
    dlg.addEventListener('close', async () => {
      dlg.remove();
      if (!confirmed) return;
      // A version number typed on a row's line goes with it, and so does the version another pass goes
      // with; otherwise the next. Its pass is said (null for the main one), and so is an attachment's label: the
      // server finds the version it goes with as the row does, unless a number is typed.
      const files = rows.map((row) => ({
        board: boardId, item: row.it.id, entity: row.f.entity(), task: row.f.taskName(), pass: row.f.passName(),
        ...(row.f.attachmentName() && { attachment: row.f.attachmentName() }),
        ...((row.f.typedNumber() || row.f.passName()) && { number: row.f.number() }),
      }));
      const said = new Map(rows.map((row) => [row.it.id, { entity: nameOf(row), task: row.f.taskName(), number: row.f.typedNumber(), pass: row.f.passName() || row.f.attachmentName() }]));
      try {
        const res = await WB.api('POST', `/api/projects/${project.id}/versions`, { files, by: me.name });
        const last = rows[rows.length - 1];
        store(`wb:file:${project.id}`, { entity: nameOf(last), task: last.f.taskName() });
        learnVersions(res.versions);
        // Taken back as if it had not been: every one of them, or none. The attachments first, then what they went with.
        const unfile = async () => {
          for (const v of [...res.versions].sort((a, b) => !!b.filedAttachment - !!a.filedAttachment)) await WB.api('POST', `/api/versions/${v.id}/unfile`, { by: me.name, ...(v.filedAttachment && { attachment: v.filedAttachment }) });
        };
        const named = (v) => (v.filedAttachment ? `${v.label} · ${v.filedAttachment}` : v.label);
        const filed = toast(res.versions.length === 1 ? `Filed as ${named(res.versions[0])}` : `Filed ${res.versions.length}: ${res.versions.map(named).join(', ')}`, {
          ms: 20000, key: 'filed',
          action: [
            { label: 'Undo', run: async () => { await unfile(); toast(res.versions.length === 1 ? 'Not filed after all' : `${res.versions.length} not filed after all`); } },
            { label: 'Change…', run: async () => { await unfile(); openFiling(list, await WB.api('GET', `/api/projects/${project.id}`), said); } },
          ],
        });
        // A piece named some other way teaches how such names are read, if it is wanted: asked straight
        // away, in the middle of the page; the message about the filing waits under it.
        const taught = rows.find((row) => row.taught && row.it.name);
        if (taught) {
          WBFiling.offerRule({
            filename: taught.it.name, rules, tasks: cat.tasks,
            filed: { entity: nameOf(taught), task: taught.f.taskName(), number: res.versions[rows.indexOf(taught)].number, pass: taught.f.passName(), passes: cat.passList || [] },
            save: (rule) => WB.api('PATCH', `/api/folders/${project.id}`, { settings: { addRules: [rule] } }),
          });
        }
      } catch (err) {
        // Nothing was filed: the rows come back as they were, to put right, saying why.
        openFiling(list, cat, said, err.message);
      }
    });
    // Escape closes it, but not over what has been typed without asking.
    let typed = false;
    dlg.addEventListener('input', () => { typed = true; });
    dlg.addEventListener('cancel', async (e) => {
      if (!typed) return;
      e.preventDefault();
      const sure = await WB.dialog({ title: 'Close without filing?', text: 'What the rows say is not kept.', ok: 'Close', danger: true });
      if (sure) dlg.close();
    });
    paint();
    if (problem) {
      status.replaceChildren(el('span', { text: `Nothing was filed: ${problem}` }));
      status.classList.add('warn');
      status.hidden = false;
    }
    document.body.append(dlg);
    dlg.showModal();
    const first = rows.find((row) => !nameOf(row));
    (first ? first.ent : rows.length === 1 && useTasks ? rows[0].task : ok).focus();
  }

  // ---- the catalogue beside the board: the project's assets, sets and shots, and their versions, to
  // put on the board with a click

  const catPanel = $('catpanel');
  let catSeen = null;     // what the project's catalogue was when last asked
  let catEntity = null;   // the entity open in the panel, by id
  let catQuery = '';
  const catBody = el('div', { class: 'cat-body' });
  const catSearch = el('input', { type: 'search', placeholder: 'Find an asset, set or shot', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find' });
  catSearch.addEventListener('input', () => { catQuery = catSearch.value.trim().toLowerCase(); paintCatalogue(); });
  // Escape in the search clears it, and once it is clear puts the panel away.
  catSearch.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (catSearch.value) {
      catSearch.value = '';
      catQuery = '';
      paintCatalogue();
    } else {
      catSearch.blur();
      toggleCatalogue(false);
    }
  });
  const catTitle = el('h2');
  catPanel.append(
    el('div', { class: 'act-head' }, catTitle,
      el('button', { class: 'iconbtn', html: ICON.close, title: 'Close (Esc)', onclick: () => toggleCatalogue(false) })),
    el('label', { class: 'cat-search' }, el('span', { html: ICON.search }), catSearch),
    // The other way round: pieces on the board filed into the catalogue.
    !viewOnly && el('p', { class: 'cat-tip' }, el('span', { html: ICON.file }), 'To file images or videos on the board as versions, select them and press ', WB.keys('Shift+V'), '.'),
    catBody);

  const thumbOf = (src) => (src ? el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }) : el('span', { class: 'cat-nothumb', html: ICON.stack }));

  // Each paint is numbered: a slow answer for a view already left (a quick click on, then back) is dropped.
  let catPaint = 0;
  async function paintCatalogue() {
    if (!project) return;
    catTitle.textContent = project.name;
    if (catEntity) return paintCatEntity();
    const ticket = ++catPaint;
    if (!catSeen) {
      try {
        catSeen = await WB.api('GET', `/api/projects/${project.id}`);
      } catch (err) {
        if (ticket === catPaint) catBody.replaceChildren(el('p', { class: 'act-none', text: err.message }));
        return;
      }
      if (ticket !== catPaint) return;
    }
    // Typed as it is spoken ("kilo 0010") or as it is written (kilo-0010), it finds the same.
    const q = catQuery ? WBNaming.tokenize(catQuery) : '';
    const shown = catSeen.entities.filter((e) => !q || e.name.includes(q));
    const groups = catSeen.types.map((t) => [t, shown.filter((e) => e.type === t.id)]).filter(([, list]) => list.length);
    catBody.replaceChildren(...(groups.length ? groups.map(([t, list]) => el('section', { class: 'cat-group' },
      el('h3', {}, t.label, el('span', { class: 'tally', text: String(list.length) })),
      el('div', { class: 'cat-grid' }, list.map((e) => el('button', { type: 'button', class: 'cat-tile', title: `${e.name}: ${e.versions} ${e.versions === 1 ? 'version' : 'versions'}`, onclick: () => { catEntity = e.id; paintCatalogue(); } },
        thumbOf(e.thumb), el('span', { class: 'cat-name', text: e.name }), el('span', { class: 'cat-meta', text: e.versions ? `${e.versions} ${e.versions === 1 ? 'version' : 'versions'}` : 'Nothing filed' }))))))
      : [el('p', { class: 'act-none' }, el('span', { html: ICON.stack }), el('span', { text: catQuery ? 'Nothing by that name' : 'Nothing filed in this project yet. Select images or videos on the board and file them (Shift+V).' }))]));
  }

  async function paintCatEntity() {
    const ticket = ++catPaint;
    let page;
    try {
      page = await WB.api('GET', `/api/entities/${catEntity}`);
    } catch (err) {
      if (ticket !== catPaint) return;
      catEntity = null;
      return paintCatalogue();
    }
    if (ticket !== catPaint) return;
    const here = new Set([...items.values()].map((it) => it.ver).filter(Boolean));
    const shown = page.versions.filter((v) => !v.hidden);
    catBody.replaceChildren(
      el('button', { type: 'button', class: 'cat-back', onclick: () => { catEntity = null; paintCatalogue(); } }, el('span', { html: ICON.prev }), 'All of the project'),
      el('div', { class: 'cat-ent' }, el('b', { text: page.entity.name }), el('span', { text: `${page.entity.type} · ${shown.length} ${shown.length === 1 ? 'version' : 'versions'}` })),
      shown.length ? el('div', { class: 'cat-versions' }, shown.map((v) => el('div', { class: `cat-ver${here.has(v.id) ? ' here' : ''}` },
        el('button', {
          type: 'button', class: 'cat-put', title: here.has(v.id) ? `${v.label} is on this board. Click to put it on again` : `Put ${v.label} on the board`,
          onclick: () => {
            placeMedia([{ ...v.look, ver: v.id }], viewCenter());
            // Now on the board: the list says so.
            setTimeout(() => { if (catEntity === page.entity.id && !catPanel.hidden) paintCatEntity(); }, 0);
          },
        }, thumbOf(v.thumb), el('span', { class: 'cat-name', text: v.label }),
        el('span', { class: 'cat-meta', text: [v.artist, WB.ago(v.createdAt)].filter(Boolean).join(' · ') })),
        here.has(v.id) && el('span', { class: 'cat-here', text: 'On the board' }),
        el('button', { type: 'button', class: 'iconbtn mini cat-look', html: ICON.focus, title: 'Open it, to look, comment and draw', onclick: () => { toggleCatalogue(false); lookAtEntity(page.entity.id, v.id); } }))))
        : el('p', { class: 'act-none', text: 'No versions yet' }));
  }

  function toggleCatalogue(show = catPanel.hidden, entityId) {
    catPanel.hidden = !show;
    $('catalogue').classList.toggle('active', show);
    if (!show) return;
    closeHelp();
    toggleActivity(false);
    toggleSettings(false);
    if (boardPanel) togglePanel(false);
    catSeen = null;
    if (entityId !== undefined) catEntity = entityId;
    paintCatalogue();
  }

  // ---- what has happened on this board
  //
  // Who opened it and who changed it, newest first; the same thing done again within a few minutes is
  // one line. Under that, the board as it was before each round of changes: any of them can be gone
  // back to, and what is replaced is kept as one more, so going back can itself be gone back on.
  const HAPPENED = {
    open: [ICON.eye, () => 'opened'],
    link: [ICON.link, () => 'looked through the link'],
    edit: [ICON.pen, (n) => (n === 1 ? '1 change' : `${n} changes`)],
    comment: [ICON.comment, () => 'commented'],
    file: [ICON.file, () => 'filed a version'],
    restore: [ICON.restore, () => 'put back a snapshot'],
  };
  const whenExactly = (at) => new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  // Today and yesterday by name, the time to the minute.
  function whenShort(at) {
    const d = new Date(at);
    const day = new Date(d).setHours(0, 0, 0, 0);
    const today = new Date().setHours(0, 0, 0, 0);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (day === today) return `Today ${time}`;
    if (today - day === 864e5) return `Yesterday ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) })}, ${time}`;
  }
  // The same name always has the same colour, so a person is found at a glance down the list.
  const hueOf = (name) => [...String(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  const actPanel = $('actpanel');
  const actBody = el('div', { class: 'act-body' });
  let actTab = 'events';
  let actSeen = null;
  const actTabs = el('div', { class: 'seg', role: 'tablist' });
  actPanel.append(
    el('div', { class: 'act-head' }, el('h2', { text: 'Activity' }),
      el('button', { class: 'iconbtn', html: ICON.close, title: 'Close (Esc)', onclick: () => toggleActivity(false) })),
    actTabs, actBody);

  async function putBack(v) {
    const sure = await WB.dialog({
      title: 'Put the board back?',
      text: `Everything on it goes back to ${whenExactly(v.at)}, for everyone. What is there now is kept as a snapshot too. Comments and catalogue versions stay as they are.`,
      ok: 'Put it back',
    });
    if (!sure) return;
    try {
      await WB.api('POST', `/api/boards/${boardId}/snapshots/${v.at}/restore`, { by: me.name });
      toast(`The board is as it was on ${whenExactly(v.at)}.`, { ms: 7000 });
      paintActivity();
    } catch (err) {
      toast(err.message);
    }
  }

  function paintActTabs() {
    const n = actSeen ? actSeen.snapshots.length : 0;
    actTabs.replaceChildren(...[['events', ICON.activity, 'Activity'], ['snapshots', ICON.restore, n ? `Snapshots · ${n}` : 'Snapshots']].map(([id, ic, label]) => el('button', {
      class: `seg-btn${actTab === id ? ' on' : ''}`, role: 'tab', 'aria-selected': String(actTab === id),
      onclick: () => { actTab = id; paintActTabs(); paintActBody(); },
    }, el('span', { class: 'seg-ic', html: ic }), el('span', { text: label }))));
  }

  function paintActBody() {
    if (!actSeen) return;
    if (actTab === 'events') {
      const events = actSeen.events.filter((e) => HAPPENED[e.what]);
      return actBody.replaceChildren(events.length
        ? el('ul', { class: 'act-list' }, events.map((e) => el('li', {},
          el('span', { class: 'act-av', style: { background: `hsl(${hueOf(e.who)} 42% 48%)` }, text: WB.initials(e.who) }),
          el('span', { class: 'act-what' }, el('b', { text: e.who }),
            el('span', { class: 'act-did' }, el('span', { class: 'act-ic', html: HAPPENED[e.what][0] }), HAPPENED[e.what][1](e.n))),
          el('time', { text: WB.ago(e.at), title: whenExactly(e.at) }))))
        : el('p', { class: 'act-none' }, el('span', { html: ICON.activity }), el('span', { text: 'Nothing yet' })));
    }
    const snaps = actSeen.snapshots;
    actBody.replaceChildren(snaps.length
      ? el('ol', { class: 'act-list versions' }, snaps.map((v) => el('li', {},
        el('i', { class: 'ver-dot' }),
        el('span', { class: 'act-what' }, el('b', { text: whenShort(v.at), title: whenExactly(v.at) }),
          el('span', { class: 'act-did', text: `${v.count} ${v.count === 1 ? 'item' : 'items'}${v.who ? ` · before ${v.who}` : ''}` })),
        el('button', { type: 'button', class: 'iconbtn', html: ICON.restore, title: 'Put the board back to this', onclick: () => putBack(v) }))))
      : el('p', { class: 'act-none' }, el('span', { html: ICON.restore }), el('span', { text: 'No snapshots yet' })));
  }

  async function paintActivity() {
    try {
      actSeen = await WB.api('GET', `/api/boards/${boardId}/activity`);
    } catch (err) {
      return actBody.replaceChildren(el('p', { class: 'act-none', text: err.message }));
    }
    paintActTabs();
    paintActBody();
  }

  // A panel in the corner, like the shortcuts, and in their place: one of the two at a time.
  function toggleActivity(show = actPanel.hidden) {
    actPanel.hidden = !show;
    $('activity').classList.toggle('active', show);
    if (!show) return;
    closeHelp();
    toggleSettings(false);
    toggleCatalogue(false);
    if (boardPanel) togglePanel(false);
    paintActTabs();
    paintActivity();
  }

  // ---- read-only link for this board
  if (!viewOnly && WB.info().canShare) {
    $('share').hidden = false;
    $('share').addEventListener('click', () => openShare(meta));
  }

  // ---- presenting the project this board is in (present.js): the people watching see the board where you
  // are on it, and follow you off it to the catalogue's player or the timeline, and back.
  if (!viewOnly && WB.info().canShare) {
    WBPresent.init({
      me: () => me,
      viewer: () => viewer,
      project: () => project,
      page: () => (project ? { k: 'board', board: boardId } : { k: 'idle' }),
    });
    const presentBtn = WBPresent.button();
    presentBtn.classList.add('board-only');
    presentBtn.hidden = true;
    $('share').before(presentBtn);
    showPresent = () => { presentBtn.hidden = !project; };
    showPresent();
    WBPresent.onChange((token) => wsSend({ t: 'lead', present: token }));
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
    const bases = WB.shareBases();
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
      // Turning a link off breaks it for everyone who has it: asked first.
      toggle.addEventListener('change', async () => {
        if (toggle.checked) return call('POST', '');
        const sure = await WB.dialog({ title: 'Turn the link off?', text: 'Everyone who has it loses access at once. Turning it on again makes a new link.', ok: 'Turn off', danger: true });
        if (sure) call('DELETE', '');
        else toggle.checked = true;
      });
      const expiry = share.expiresAt
        ? [['set', `On ${new Date(share.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`], ...EXPIRY]
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
          link && el('button', { type: 'button', class: 'btn ghost share-reset', text: 'New link', title: 'Make a new link. The current one stops working at once.', onclick: async () => {
            const sure = await WB.dialog({ title: 'Make a new link?', text: 'The current link stops working at once, for everyone who has it.', ok: 'Make a new link', danger: true });
            if (sure) call('POST', '/reset');
          } }),
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
  $('snap').innerHTML = ICON.snap;
  $('snap').classList.toggle('active', snapOn);
  $('snap').addEventListener('click', toggleSnap);
  if (!viewOnly) {
    for (const [id, run, ic] of [['boardmenu', () => toggleSettings(), ICON.settings], ['activity', () => toggleActivity(), ICON.activity]]) {
      $(id).innerHTML = ic;
      $(id).hidden = false;
      $(id).addEventListener('click', run);
    }
    $('catalogue').innerHTML = ICON.stack;
    $('catalogue').addEventListener('click', () => toggleCatalogue());
  }
  buildToolbar();
  setTool('select');
  applyCam();
  connect();
  booted = true;
  // Text is measured from the page, so measure again once the typeface has arrived.
  typeface.then(updateOverlay);
})();
