'use strict';

// The player. One piece of media at a time, laid out like a review tool: the piece in the middle,
// everything there is to open in a strip down the left, the comments on the open piece in a panel on
// the right, and under a video its timeline, drawn as its picture and sound. A press on the piece draws,
// and what is drawn belongs to the comment being written. The laser points for everyone watching.
//
// It is the same wherever media is opened: a board opens its images and videos in it, and the
// catalogue opens an asset's, set's or shot's versions in it. Whoever opens it (the host) says what there
// is to show and what has been said about it, and hears what the viewer does:
//
//   WBViewer.create({
//     me: () => ({ name, color }),
//     title: () => 'Standup',             what the bar calls where the media is; a click there closes
//     media: () => [piece],               in the order the arrows take them:
//                                         { id, type: 'image'|'video', src, prev?, pw?, th?, poster?, nw, nh,
//                                           fps?, dur?, wf?, name?, label?, orig? }
//     notes: () => [comment],             { id, on, re?, text, name, color, t, done, at?, fr?, drawing?, edited?,
//                                           guest?, obn? }, on any of the pieces
//     drawings: (id) => [stroke],         drawings on the piece that are not a comment's, if the host has them
//     can: { read, write, draw, member }  functions: read comments, write them, draw, act as one of the team
//     add(comment), set(id, patch), remove(ids)      what is said, done (the host keeps and shares it)
//     undo(), redo(), erase(ids), clear(id), download(piece)               all optional
//     names: () => [{ name, color }]      who may be named with an @, besides those who have commented
//     onOpen(id), onClose(), onMedia(id, playing, time), onThread(id), onLaser(id, pts), onInteract(), onWhole(id, url)
//     view3d: { key, model, screen }      a project with a model of its venue: the piece can be seen on it in 3D
//     onMode3d(on)                        it has turned to 3D or back (the host may show the pieces another way)
//   })
//
// Drawings are measured against the piece: its width is 1000, its height in proportion. A stroke is a
// box (x, y, w, h), its points within the box from 0 to 1, how wide its line is along them (ws, times
// `size`), and its colour.
const WBViewer = (() => {
  const { el, store } = WB;
  const { clamp, uid } = WB;
  const { hexOk } = WB;
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const { INK, LASER_LIFE, inkColor, isLight } = WBInk;
  const UNITS = 1000;

  const ICON = WB.iconSet(20); // icons.js

  // Drawing: see ink.js.
  const { svgEl, fillText, pathData, outlinePath, strokeNode, makeStroke, strokePoints, pointSegDist } = WBInk;

  // ---------------------------------------------------------------- time: frames and how a moment is written

  // A frame is on screen from its start until the next one's. Asking for its middle lands on it in every browser.
  const frameTime = (f, fps) => (f + 0.5) / fps;
  const frameIndex = (t, fps) => Math.max(0, Math.floor(t * fps + 1e-3));
  // A length that runs a little past the last frame, as one rounded to the millisecond does, is not a frame more.
  const lastFrame = (video, fps) => Math.max(0, Math.ceil((video.duration || 0) * fps - 0.25) - 1);

  function fmtTime(s) {
    if (!isFinite(s)) return '0:00';
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  // Minutes and seconds, the frame number (counted from 1, as editors do), or a timecode. Chosen per browser.
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
  // Everything that shows a time hears of the change (a board's own videos too).
  function cycleTimeMode() {
    timeMode = TIME_MODES[(TIME_MODES.indexOf(timeMode) + 1) % TIME_MODES.length];
    store('wb:timemode', timeMode);
    window.dispatchEvent(new Event('wb:timemode'));
  }

  // ---------------------------------------------------------------- going to a moment
  //
  // A video asked for a new moment while it is still finding the last one starts over. Firefox does so
  // every time, and under a moving hand it finishes few of the seeks it begins: the picture follows in
  // jumps. So a video is asked for one moment at a time. What is asked of it meanwhile waits, the latest
  // taking the place of the one before, and is gone to once the frame it was finding has been shown.
  const bound = new WeakMap();    // a video finding a moment -> { next: where to go after, if anywhere }
  const changing = new WeakMap(); // a video on its way to another source -> { at: where it is to be once there }
  function goTo(video, at) {
    // Never quite to the end: a looping video put on its end has ended, starts again from its first
    // frame, and a scrub held past the end would flick between the two.
    if (video.duration > 0 && isFinite(video.duration)) at = Math.max(0, Math.min(at, video.duration - 0.02));
    const moving = changing.get(video);
    if (moving) {
      moving.at = at;
      return;
    }
    const busy = bound.get(video);
    if (busy) {
      busy.next = at;
      return;
    }
    // A seek this short may land on the frame already showing, and then there is no new one to see.
    const state = { next: null, seen: false, far: Math.abs(at - video.currentTime) > 0.1 };
    bound.set(video, state);
    if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(() => { state.seen = true; });
    const arrived = () => {
      clearTimeout(late);
      video.removeEventListener('seeked', shown);
      if (bound.get(video) !== state) return;
      bound.delete(video);
      setTimeout(() => checkShown(video, state), 250);
      if (state.next != null) goTo(video, state.next);
    };
    // A beat later, not at once: the frame is put on show just after the seek is said to be done.
    const shown = () => setTimeout(arrived, 0);
    // A video that never says so (it failed, or was given another source) is not waited on for long.
    const late = setTimeout(arrived, 500);
    video.addEventListener('seeked', shown, { once: true });
    video.currentTime = at;
  }

  // Safari now and then stops putting a stopped video's frames on screen: it goes on seeking, the
  // playhead and the time move, and the picture stays where it was until the video is played. So once
  // this browser is known to say when a stopped video shows a new frame, a seek that showed none is
  // followed by what playing does, with the sound off and stopped again at once, back on its moment.
  let seekShows = false;
  const unsticking = new WeakSet();
  function checkShown(video, state) {
    if (state.seen) {
      if (video.paused) seekShows = true;
      return;
    }
    if (!seekShows || !state.far || document.hidden || !video.paused || video.readyState < 2 || changing.has(video) || unsticking.has(video)) return;
    unsticking.add(video);
    const want = whereOf(video);
    const muted = video.muted;
    video.muted = true;
    const done = () => {
      video.muted = muted;
      setTimeout(() => unsticking.delete(video), 1000);
    };
    video.play().then(() => {
      video.pause();
      done();
      goTo(video, bound.get(video)?.next ?? want);
    }, done);
  }

  // Where a video is, or is about to be.
  const whereOf = (video) => bound.get(video)?.next ?? changing.get(video)?.at ?? video.currentTime;

  // Puts a video on another source without a flash: the frame it shows is held over it until the same
  // frame is back, and it carries on from where it was.
  function switchSource(video, url) {
    const state = { at: whereOf(video) };
    bound.delete(video);
    changing.set(video, state);
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
      if (changing.get(video) === state) changing.delete(video);
    };
    const timer = setTimeout(settle, 3000);
    video.preload = 'auto';
    video.addEventListener('error', settle);
    video.addEventListener('loadeddata', () => {
      if (playing) video.play().catch(() => {});
      if (changing.get(video) === state && state.at > 0.001) {
        video.addEventListener('seeked', settle);
        video.currentTime = state.at;
      } else {
        settle();
      }
    }, { once: true });
    video.src = url;
  }

  // ---------------------------------------------------------------- the picture and sound of a video
  //
  // The sound as a waveform on top, the picture as flat bands of colour beneath it, from the strip read
  // when the video came in (`wf`, see ingest.js). Drawn at the size it is shown at, to the pixel.
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
  const waveOf = new WeakMap();
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
    // On a white panel colours wash out, so in the light theme the strip keeps a dark bed of its own,
    // like a strip of film, and reads as it does in the dark one.
    if (isLight()) {
      ctx.fillStyle = '#161616';
      ctx.fillRect(0, 0, W, H);
    }
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

  // ---------------------------------------------------------------- a video, whole
  //
  // A browser keeps only a little of a paused video in hand and fetches the rest as it is asked for, so a
  // scrub keeps landing on moments it has not got and drags until the hand has been over the whole length
  // once. A video that is opened is therefore had whole, in one go, and played from memory: media.js holds
  // it (from the copy kept on this computer if there is one) and lets the longest unused go.
  const fetchWhole = (src) => WB.media.whole(src);
  const releaseWhole = (src) => WB.media.releaseWhole(src);

  // ---------------------------------------------------------------- the viewer itself

  // One player to a page. Whoever opens something in it is its host; `use` hands it to another (the
  // board hands it to the catalogue to show an asset's versions, and takes it back after).
  function create(first) {
    let opts = first;
    let can = null;
    function setHost(next) {
      opts = next;
      can = { read: () => true, write: () => true, draw: () => true, member: () => true, ...(next.can || {}) };
    }
    // A run (`host.run`): the pieces are shots in order, played through one after another like an edit, with
    // a strip of them all under the picture in place of the side strip. Stills are held a few seconds.
    const runMode = () => !!opts.run;
    const STILL = 3;
    setHost(first);
    const me = () => opts.me();

    // ---- the frame around the piece
    // Classes, not ids, so a page may hold more than one player: each is styled within its own root.
    const filmId = `v-film-${WB.uid()}`;
    const panelId = `v-panel-${WB.uid()}`;
    const film = el('nav', { id: filmId, class: 'v-film chrome', 'aria-label': 'Images and video' });
    const filmTab = el('button', { class: 'v-fstab', 'aria-controls': filmId, onclick: () => toggleFilm() });
    const filmGrip = el('div', { class: 'fs-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Width of the strip', title: 'Drag to widen and see names. Double-click to put it back' });
    const timeline = el('div', { class: 'v-timeline chrome', hidden: true });
    const panel = el('aside', { id: panelId, class: 'v-panel chrome', 'aria-label': 'Comments', hidden: true });
    const cpTabIcon = el('span', { class: 'v-cptab-icon' });
    const cpTabCount = el('span', { class: 'v-cptab-count count', hidden: true });
    const cpTab = el('button', { class: 'v-cptab', title: 'Show the comments (Shift+C)', 'aria-controls': panelId, 'aria-expanded': 'false', onclick: () => togglePanel() }, cpTabIcon, cpTabCount);
    const pieceBox = el('div', { class: 'v-piece' });
    const ink = svgEl('svg', { class: 'v-ink' });
    const laserCanvas = el('canvas', { class: 'v-laser' });
    // In a run: which shot is on screen, and which version of it, over the picture.
    const runCap = el('div', { class: 'v-runcap', hidden: true });
    const stage = el('div', { class: 'v-stage' }, pieceBox, laserCanvas, runCap);
    const nameEl = el('span', { class: 'v-name' });
    const posEl = el('span', { class: 'v-pos' });
    const prevBtn = el('button', { class: 'iconbtn', html: ICON.prev, title: 'Previous (←)', onclick: () => step(-1) });
    const nextBtn = el('button', { class: 'iconbtn', html: ICON.next, title: 'Next (→)', onclick: () => step(1) });
    const crumb = el('button', { class: 'bar-crumb', title: 'Back (Esc)', onclick: () => close() });
    const clearBtn = el('button', { class: 'btn ghost v-clear', text: 'Clear drawing', onclick: () => clearDrawing() });
    const extras = el('span', { class: 'v-extras' });
    const dlBtn = el('button', { class: 'iconbtn', html: ICON.download, title: 'Download the original media', onclick: () => opts.download && open && opts.download(open) });
    const zoomBtn = el('button', { class: 'btn ghost v-zoom', text: 'Fit', title: 'Fit to the screen, or actual size', onclick: () => toggleZoom() });
    const doneBtn = el('button', { class: 'btn primary', text: 'Done', title: 'Close (Esc)', onclick: () => close() });
    // In a project with a model of its venue, the piece can be seen on it (view3d.js): 2D or 3D, and, having
    // flown off in 3D, the way back to the main camera.
    const d2Btn = el('button', { class: 'btn', text: '2D', title: 'The picture as it is', 'aria-pressed': 'true', onclick: () => set3d(false) });
    const d3Btn = el('button', { class: 'btn', text: '3D', title: 'The picture on the venue, in 3D', 'aria-pressed': 'false', onclick: () => set3d(true) });
    const dims = el('span', { class: 'bar-group v-dims', hidden: true }, d2Btn, d3Btn);
    const camBtn = el('button', { class: 'btn ghost v-cam', html: `${ICON.focus}<span>Main camera</span>`, title: 'Back to the main camera (V)', hidden: true, onclick: () => backToMain() });
    const bar = el('header', { class: 'appbar chrome v-bar' },
      el('a', { class: 'brand', href: '/', title: 'All boards' }, el('span', { class: 'logomark', html: (document.querySelector('[data-logo-slot] svg') || {}).outerHTML || '' }), el('span', { class: 'wordmark', text: 'Boards' })),
      el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' }), crumb,
      el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' }),
      el('span', { class: 'stepper' }, prevBtn, posEl, nextBtn),
      nameEl, el('div', { class: 'spacer' }), clearBtn, camBtn, extras, dims,
      el('span', { class: 'bar-group' }, dlBtn, zoomBtn),
      WB.themeButton(), doneBtn);
    // On a phone there is no room for the panel's brush: the viewer's own few tools sit along the bottom.
    const tools = el('nav', { class: 'chrome v-tools' });
    // The next shot of a run waits here, loaded and on its first frame, to take over at the cut.
    const spareBox = el('div', { class: 'v-spare', 'aria-hidden': 'true' });
    const root = el('div', { class: `viewer${opts.run ? ' run' : ''}`, hidden: true }, stage, bar, film, filmTab, filmGrip, timeline, panel, cpTab, tools, spareBox);
    document.body.append(root);

    let pieces = [];
    let notes = [];
    let open = null;      // the piece open
    let media = null;     // its <img> or <video>
    let W = 1000;         // its size, as it is laid out
    let H = 562;
    const cam = { s: 1, x: 0, y: 0 };
    let tool = 'pan';
    let draft = null;     // { id, on, at, fr, strokes }: the comment being written, from its first stroke
    const unstroked = []; // strokes taken back from the draft, for redo
    let activeThread = null;
    let timed = true;
    let hideDone = store('wb:hidedone') === true;
    let viewerPanel = store('wb:cpanel') !== false;
    let sheetOpen = false;
    let filmOff = store('wb:filmoff') === true;
    // A video starts again from the top when it reaches the end, unless that is turned off (remembered).
    let looping = store('wb:loop') !== false;
    let editingId = null;
    const typed = new Map(); // piece id -> what its comment box held
    const fullRes = new Set();

    const narrow = () => innerWidth < 700;
    const units = () => UNITS / W; // drawing units in one piece pixel
    const fpsOf = (id) => pieces.find((p) => p.id === id)?.fps || 0;
    const byTime = (a, b) => (a.t || 0) - (b.t || 0) || (a.id < b.id ? -1 : 1);
    const roots = () => notes.filter((c) => !c.re).sort(byTime);
    const repliesOf = (id) => notes.filter((c) => c.re === id).sort(byTime);
    const noteById = (id) => notes.find((c) => c.id === id) || null;
    const momentOf = (c) => (c.fr != null && fpsOf(c.on) ? frameTime(c.fr, fpsOf(c.on)) : c.at);
    const videoOpen = () => (media && media.tagName === 'VIDEO' ? media : null);
    const interact = () => opts.onInteract && opts.onInteract();
    const toast = (text, o) => (opts.toast ? opts.toast(text, o) : null);

    // ---- opening and closing

    function readHost() {
      pieces = (opts.media() || []).filter((p) => p && (p.type === 'image' || p.type === 'video'));
      notes = can.read() ? (opts.notes() || []) : [];
      if (runMode()) layoutRun();
    }

    // ---- a run: where each shot starts and how long it is
    let runClips = [];     // { id, start, dur, piece }
    let runTotal = 0;
    let runPlaying = false;
    let runErrors = 0; // shots in a row that would not play
    let spare = null;      // { id, video }: the next shot, loaded
    let stillAt = 0;       // how long a still has been showing, in a run
    let stillRaf = 0;
    const measured = new Map();
    function layoutRun() {
      let at = 0;
      runClips = pieces.map((p) => {
        const dur = p.type === 'video' ? (p.dur > 0 ? p.dur : measured.get(p.id) || 4) : STILL;
        const c = { id: p.id, start: at, dur, piece: p };
        at += dur;
        return c;
      });
      runTotal = at;
      // A video whose length was not recorded is measured, and the run laid out again with it.
      for (const p of pieces) {
        if (p.type !== 'video' || p.dur > 0 || measured.has(p.id)) continue;
        measured.set(p.id, 4);
        const probe = el('video', { preload: 'metadata', src: p.src });
        probe.addEventListener('error', () => {
          probe.removeAttribute('src');
          probe.load();
        });
        probe.addEventListener('loadedmetadata', () => {
          if (probe.duration > 0 && isFinite(probe.duration)) measured.set(p.id, probe.duration);
          probe.removeAttribute('src');
          probe.load();
          if (open && runMode()) {
            layoutRun();
            paintRun(true);
            syncTimeline();
          }
        }, { once: true });
      }
    }
    const clipOf = (id) => runClips.find((c) => c.id === id) || null;
    const runAt = () => {
      const c = open && clipOf(open.id);
      if (!c) return 0;
      const video = videoOpen();
      return c.start + (video ? whereOf(video) : stillAt);
    };
    // The next shot is loaded while this one plays, so the cut to it is clean.
    function prepareSpare() {
      const i = runClips.findIndex((c) => c.id === open.id);
      // The shots after this one are kept on this computer ahead of the cut to them (media.js).
      const coming = [...runClips.slice(i), ...(looping ? runClips.slice(0, i) : [])].slice(0, 6);
      WB.media.want('run', coming.filter((c) => c.piece.type === 'video').map((c) => c.piece.src), { rank: WB.media.RANK.run, hold: true });
      const next = runClips[i + 1] || (looping ? runClips[0] : null);
      if (spare && (!next || spare.id !== next.id || spare.src !== next.piece.src)) dropSpare();
      if (!next || next.piece.type !== 'video' || next.id === open.id || spare) return;
      const video = makeVideo(next.piece);
      video.muted = !!(videoOpen() && videoOpen().muted);
      spare = { id: next.id, src: next.piece.src, video };
      spareBox.replaceChildren(video);
    }
    function dropSpare() {
      if (!spare) return;
      spare.video.removeAttribute('src');
      spare.video.load();
      spare.video.remove();
      spare = null;
    }
    // On to the next shot, at its start; round to the first at the end, if looping.
    function runOn() {
      if (!runMode() || !runPlaying || !open) return;
      const i = runClips.findIndex((c) => c.id === open.id);
      let next = runClips[i + 1];
      if (!next) {
        if (!looping) {
          runPlaying = false;
          syncTimeline();
          return;
        }
        next = runClips[0];
      }
      if (next.id === open.id) {
        const v = videoOpen();
        if (v) goTo(v, 0);
        stillAt = 0;
        playOpen();
        return;
      }
      show(next.id);
    }
    function playOpen() {
      const video = videoOpen();
      cancelAnimationFrame(stillRaf);
      // A browser that will not play it (no sound allowed yet, say) stops the run rather than leaving
      // it saying it plays.
      if (video) {
        return void video.play().catch(() => {
          if (videoOpen() !== video) return;
          runPlaying = false;
          syncTimeline();
        });
      }
      let last = performance.now();
      const tick = (now) => {
        if (!runPlaying || !open || videoOpen()) return;
        stillAt += (now - last) / 1000;
        last = now;
        if (stillAt >= STILL) {
          stillAt = 0;
          runOn();
          return;
        }
        syncTimeline();
        stillRaf = requestAnimationFrame(tick);
      };
      stillRaf = requestAnimationFrame(tick);
    }
    // Moves the run to a moment of it: the shot there opens, on that moment.
    function runSeek(t) {
      if (!runClips.length) return;
      t = clamp(t, 0, Math.max(0, runTotal - 0.001));
      let c = runClips[0];
      for (const x of runClips) if (t >= x.start) c = x;
      if (!open || open.id !== c.id) show(c.id);
      const local = t - c.start;
      const video = videoOpen();
      if (video) goTo(video, Math.min(local, c.dur));
      else stillAt = Math.min(local, STILL - 0.01);
      syncTimeline();
    }

    // `followed` is true when it opens because the person being followed opened it.
    function show(id, { followed = false, thread = null } = {}) {
      readHost();
      const piece = pieces.find((p) => p.id === id);
      if (!piece) return false;
      if (!followed) interact();
      const was = open;
      if (!was) {
        root.hidden = false;
        document.body.classList.add('focus');
        // Whatever opened it (a card, a thumbnail) is behind it now, and must not keep the keyboard: Space
        // on it would open it again.
        if (document.activeElement && !root.contains(document.activeElement) && document.activeElement !== document.body) document.activeElement.blur();
        // It opens to look at, not to draw on: drawing is turned on from the comment box (its pen), or with P.
        tool = 'pan';
        syncTools();
      }
      if (!was || was.id !== id) {
        if (was) leavePiece(was);
        switchTyped(was && was.id, id);
        activeThread = null;
        open = piece;
        mount(piece);
      }
      // A project last looked at in 3D opens in 3D.
      if (!was) {
        paintDims();
        if (has3d() && store(key3d()) === true) set3d(true, { remember: false });
      }
      document.body.classList.toggle('focus-video', piece.type === 'video');
      if (runMode() && (!was || was.id !== id)) {
        stillAt = 0;
        prepareSpare();
      }
      paintAll();
      layout();
      fit();
      if (runMode() && runPlaying && (!was || was.id !== id)) playOpen();
      if (thread) pickThread(thread);
      if (opts.onOpen) opts.onOpen(id);
      return true;
    }

    function close() {
      if (!open) return;
      WB.media.want('run', []);
      const was = open;
      leavePiece(was);
      switchTyped(was.id, null);
      open = null;
      activeThread = null;
      if (media) media.remove();
      unload(media);
      media = null;
      pieceBox.replaceChildren();
      runPlaying = false;
      cancelAnimationFrame(stillRaf);
      dropSpare();
      cut.show(false);
      if (three) {
        three.stop();
        three.canvas.remove();
      }
      in3d = false;
      root.classList.remove('in3d');
      root.hidden = true;
      document.body.classList.remove('focus', 'focus-video', 'cp-open');
      closeNames();
      trails.clear();
      if (opts.onClose) opts.onClose(was.id);
    }

    function leavePiece(piece) {
      const video = videoOpen();
      if (video) video.pause();
      clearTimeout(wholeTimer);
      if (piece.type === 'video' && piece.src) releaseWhole(piece.src);
      if (draft && draft.strokes.length) toast('The drawing was taken away: it had no comment', { ms: 3500 });
      draft = null;
      unstroked.length = 0;
    }

    let wholeTimer = 0;
    // A video put away lets go of its decoder and its connection now, not whenever it is collected.
    const unload = (v) => {
      if (!v || v.tagName !== 'VIDEO') return;
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
    function mount(piece) {
      const old = media;
      fullRes.delete(piece.id);
      if (piece.type === 'video') {
        let video;
        if (spare && spare.id === piece.id && spare.src === piece.src) {
          video = spare.video;
          spare = null;
        } else video = makeVideo(piece);
        media = video;
        // Open, it is scrubbed and stepped through: worth having all of it. Held back a moment so stepping
        // quickly past videos does not start fetching every one of them. A run playing through is not
        // switched over mid-shot (that would jump back a moment at each cut): it is had whole once paused.
        if (!(runMode() && runPlaying)) wholeTimer = setTimeout(() => holdWhole(piece), 300);
      } else {
        media = el('img', { alt: piece.name || '', draggable: 'false', decoding: 'async', src: piece.prev || piece.src });
      }
      arrange();
      if (old !== media) unload(old);
    }

    // What the piece box holds: the picture at its own size, or, in 3D, the venue drawn at the main
    // camera's shape over the picture (which plays on unseen, and is what the venue shows).
    function arrange() {
      if (!open) return;
      const as3d = in3d && !!three;
      if (as3d) {
        W = 1600;
        H = Math.round(W / three.aspect());
      } else {
        W = open.nw || 1000;
        H = open.nh || W * 0.5625;
      }
      pieceBox.style.width = `${W}px`;
      pieceBox.style.height = `${H}px`;
      ink.setAttribute('viewBox', `0 0 ${UNITS} ${(UNITS * H) / W}`);
      // In 3D the venue fills the stage, under the piece box, which keeps the main camera's frame (and
      // what is drawn in it) but shows nothing of its own.
      pieceBox.replaceChildren(media, ink);
      root.classList.toggle('in3d', as3d);
      if (as3d) {
        if (three.canvas.parentNode !== stage) stage.prepend(three.canvas);
        three.setSource(media);
        three.start();
      } else if (three) {
        three.stop();
        three.canvas.remove();
      }
    }

    // ---- 3D: the piece on the project's model of its venue (view3d.js)

    let in3d = false;
    let three = null; // the 3D view, made the first time it is asked for
    const has3d = () => !!(opts.view3d && opts.view3d.model);
    const key3d = () => `wb:3d:${opts.view3d.key || ''}`;
    async function set3d(on, { remember = true } = {}) {
      on = !!on && has3d() && !!open;
      if (on === in3d) return;
      if (on) {
        d3Btn.disabled = true;
        try {
          if (!three) {
            three = (await import('/view3d.js')).create({
              onFree: () => { if (tool === 'pen' || tool === 'eraser') setTool('pan'); paintDims(); paintInk(); },
              frameOf: () => pieceBox.getBoundingClientRect(),
              // Drawing, erasing and pointing are done through the main camera; any other press moves the view.
              holds: (e) => e.button === 0 && !spaceDown && (tool === 'pen' || tool === 'eraser' || tool === 'laser'),
            });
          }
          await three.load(opts.view3d);
        } catch (err) {
          console.warn('The 3D view could not be opened:', err);
          toast("The project's 3D model could not be opened", { ms: 5000 });
          return;
        } finally {
          d3Btn.disabled = false;
        }
        if (!open) return;
      }
      // A drawing half made belongs to the view it was made in.
      if (draft && draft.strokes.length) {
        discardDrawing();
        toast('The drawing was taken away: it was made in the other view', { ms: 3500 });
      }
      in3d = on;
      if (remember) store(key3d(), on);
      if (three) three.setFree(false);
      if (opts.onMode3d) opts.onMode3d(on);
      arrange();
      layout();
      fit();
      paintDims();
      paintAll();
    }
    function backToMain() {
      if (!three || !three.isFree()) return;
      three.setFree(false, true);
      paintDims();
      paintInk();
    }
    function paintDims() {
      dims.hidden = !has3d();
      d2Btn.setAttribute('aria-pressed', String(!in3d));
      d3Btn.setAttribute('aria-pressed', String(in3d));
      camBtn.hidden = !(in3d && three && three.isFree());
    }
    // Drawn in 3D, a drawing is seen through the main camera only; drawn on the picture, on the picture only.
    const drawnHere = (c) => (c.pov === 'main' ? in3d && !!three && !three.isFree() : !in3d);

    function makeVideo(piece) {
      const video = el('video', { playsinline: '', preload: 'auto' });
      // In a run, the run loops, not the shot.
      video.loop = looping && !runMode();
      if (piece.poster || piece.th) video.poster = piece.poster || piece.th;
      video.src = piece.src;
      const mine = () => media === video;
      for (const type of ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange']) video.addEventListener(type, () => { if (!mine()) return; syncTimeline(); if (type !== 'timeupdate') { paintMarks(); paintInk(); } });
      for (const type of ['progress', 'suspend']) video.addEventListener(type, () => { if (mine()) syncLoaded(); });
      for (const type of ['play', 'pause', 'volumechange']) video.addEventListener(type, () => { if (!mine()) return; syncTimeline(); paintInk(); });
      video.addEventListener('ended', () => { if (mine()) runOn(); });
      // A shot that cannot be played (gone, not allowed, a format this browser lacks) is passed over in a
      // run playing through, as long as some shot still plays.
      video.addEventListener('error', () => {
        if (!mine() || !runMode() || !runPlaying) return;
        if (++runErrors >= runClips.length) {
          runErrors = 0;
          runPlaying = false;
          syncTimeline();
          return;
        }
        runOn();
      });
      video.addEventListener('playing', () => { runErrors = 0; });
      const onFrame = (now, meta) => {
        if (!mine()) return;
        syncTimeline(video.duration > 0 && isFinite(video.duration) ? meta.mediaTime % video.duration : meta.mediaTime);
        if (!video.paused) video.requestVideoFrameCallback(onFrame);
      };
      video.addEventListener('play', () => { if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onFrame); });
      return video;
    }

    async function holdWhole(piece) {
      if (!WB.media.keepable(piece.src)) return;
      const entry = fetchWhole(piece.src);
      if (!entry) return;
      entry.used = performance.now();
      const poll = setInterval(syncLoaded, 250);
      const url = await entry.ready;
      clearInterval(poll);
      const video = videoOpen();
      // Not in the middle of a scrub, which would be thrown back to where it started.
      while (scrub) await new Promise((resolve) => setTimeout(resolve, 120));
      if (!url || !video || open !== piece || video.dataset.whole === piece.src) return;
      video.dataset.whole = piece.src;
      switchSource(video, url);
      syncLoaded();
      if (opts.onWhole) opts.onWhole(piece.id, url);
    }

    // A video let go of from memory while it is open goes back to playing from where it came.
    WB.media.onEvict((src) => {
      const video = videoOpen();
      if (video && video.dataset.whole === src && open) {
        delete video.dataset.whole;
        switchSource(video, open.src);
      }
    });

    // Moves on to the next or previous piece, going round at the ends. Steps pile up while a frame is
    // being drawn and are made together, so a held key skips ahead.
    let stepPending = 0;
    function step(dir) {
      if (!open) return;
      if (!stepPending) {
        requestAnimationFrame(() => {
          const n = stepPending;
          stepPending = 0;
          const i = pieces.findIndex((p) => p.id === open.id);
          if (i < 0 || pieces.length < 2) return;
          show(pieces[(((i + n) % pieces.length) + pieces.length) % pieces.length].id);
        });
      }
      stepPending += dir;
    }

    // The host says what there is has changed: the pieces, or what has been said about them.
    let refreshQueued = false;
    function refresh() {
      if (!open || refreshQueued) return;
      refreshQueued = true;
      queueMicrotask(() => {
        refreshQueued = false;
        if (!open) return;
        readHost();
        const now = pieces.find((p) => p.id === open.id);
        if (!now) return void close();
        // Another file under the same piece (a newer version swapped in, a video given its original): shown afresh.
        // Another view of the same version is the same moment seen another way: it stays on that moment.
        if (now.src !== open.src || now.type !== open.type) {
          const was = videoOpen();
          const keepAt = was && now.shownView !== open.shownView ? whereOf(was) : null;
          leavePiece(open);
          open = now;
          mount(now);
          layout();
          fit();
          const video = videoOpen();
          if (video && keepAt != null) {
            video.addEventListener('loadedmetadata', () => {
              goTo(video, keepAt);
              if (runMode() && runPlaying && media === video) playOpen();
            }, { once: true });
          } else if (runMode() && runPlaying) playOpen();
          if (runMode()) prepareSpare();
        } else {
          open = now;
        }
        if (activeThread && !noteById(activeThread)) activeThread = null;
        if (editingId && !noteById(editingId)) editingId = null;
        paintAll();
      });
    }

    // A run's shot is its name; its version is the rest of its label ("anim v3"), or that it has none.
    const versionPart = (p) => (p.empty ? 'nothing filed yet' : (p.label || '').startsWith(`${p.name} `) ? p.label.slice(p.name.length + 1) : p.label || '');
    function paintAll() {
      if (!open) return;
      // Shown one of several ways: which, since a shot without the view chosen shows its main one.
      const way = open.viewNames && open.viewNames.length > 1 ? open.shownView || 'main' : '';
      nameEl.textContent = [runMode() && open.name ? [open.name, versionPart(open)].filter(Boolean).join(' · ')
        : open.label || open.name || (open.type === 'video' ? 'Video' : 'Image'), way].filter(Boolean).join(' · ');
      // A version's file name is still there, on a hover over its label.
      nameEl.title = open.label && open.name && open.name !== open.label ? open.name : '';
      runCap.hidden = !runMode();
      if (runMode()) runCap.replaceChildren(el('b', { text: open.name || '' }), el('span', { class: open.empty ? 'none' : '', text: versionPart(open) }));
      crumb.textContent = opts.title ? opts.title() : '';
      // Shown whenever the host downloads, and only greyed out for what has no file (a run's slate), so
      // the bar does not shift as the pieces change.
      dlBtn.hidden = !opts.download;
      dlBtn.disabled = !WB.media.keepable(open.src);
      dlBtn.title = dlBtn.disabled ? 'Nothing to download: nothing is filed yet' : 'Download the original media';
      clearBtn.hidden = !opts.clear || !can.member();
      clearBtn.disabled = !plainDrawings().length;
      timeline.hidden = open.type !== 'video' && !runMode();
      timeline.classList.toggle('still', open.type !== 'video');
      if (runMode()) paintRun();
      else paintFilm();
      renderPanel();
      paintMarks();
      paintInk();
      syncTimeline();
      syncLoaded();
      paintWave();
      syncTools();
    }

    // ---- the camera: where the piece is on screen
    //
    // The open piece fills the space between the bars. The view zooms into it and moves around it, never
    // out past it nor off it.

    let pad = { t: 72, r: 40, b: 32, l: 132 };
    // Whether something fixed in place is on screen (offsetParent says nothing about those).
    const shown = (node) => !node.hidden && node.getClientRects().length > 0;
    // Docked (`host.dock`), the player leaves the page's own bar and sidebar showing: it keeps the
    // whole window to work in, and is cut away, seen and touched, where they are.
    const dockedBy = () => {
      if (!root.classList.contains('docked')) return { l: 0, t: 0 };
      const cs = getComputedStyle(root);
      return { l: parseFloat(cs.getPropertyValue('--dock-l')) || 0, t: parseFloat(cs.getPropertyValue('--dock-t')) || 0 };
    };
    function layout() {
      const below = timeline.hidden ? 0 : timeline.offsetHeight + 12;
      const top = bar.offsetHeight || 48;
      const d = dockedBy();
      pad = narrow()
        ? { t: d.t + top + 16, r: 12, b: bottomChrome() + 12, l: d.l + 12 }
        : { t: d.t + top + 24, r: (panel.hidden ? 0 : panel.offsetWidth) + 40, b: 32 + below, l: d.l + (filmOff || !shown(film) ? 0 : film.offsetWidth) + 40 };
    }
    function bottomChrome() {
      const tops = [timeline, tools].filter(shown).map((n) => n.getBoundingClientRect().top);
      return tops.length ? Math.max(0, innerHeight - Math.min(...tops)) : 8;
    }
    const fitS = () => Math.min((innerWidth - pad.l - pad.r) / Math.max(W, 1), (innerHeight - pad.t - pad.b) / Math.max(H, 1));
    const maxS = () => Math.max(fitS() * 16, 8);
    const zoomed = () => cam.s > fitS() * 1.02;
    const actualS = () => (open && open.nw ? 1 / (window.devicePixelRatio || 1) : fitS() * 2);

    function keepOn() {
      cam.s = clamp(cam.s, fitS(), maxS());
      const axis = (pos, size, lo, span) => {
        const shown = size * cam.s;
        return shown <= span ? lo + (span - shown) / 2 : clamp(pos, lo + span - shown, lo);
      };
      cam.x = axis(cam.x, W, pad.l, innerWidth - pad.l - pad.r);
      cam.y = axis(cam.y, H, pad.t, innerHeight - pad.t - pad.b);
    }

    function applyCam() {
      keepOn();
      pieceBox.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
      zoomBtn.textContent = zoomed() ? `${Math.round((cam.s / actualS()) * 100)}%` : 'Fit';
      // A large picture shows its preview until it is zoomed past it, then its original.
      if (open && open.type === 'image' && open.prev && media && !fullRes.has(open.id) && cam.s * W * (window.devicePixelRatio || 1) > (open.pw || 2048) * 1.1) {
        fullRes.add(open.id);
        media.src = open.src;
      }
      requestLaser();
    }

    // The scale it was last fitted at: a window that changes size keeps a fitted piece fitted, which comparing
    // with the new window's fit would not tell (a smaller window makes the old fit look zoomed in).
    let fittedAt = 0;
    function fit() {
      cam.s = fitS();
      fittedAt = cam.s;
      cam.x = pad.l;
      cam.y = pad.t;
      applyCam();
    }

    function zoomAt(sx, sy, factor) {
      const s = clamp(cam.s * factor, fitS(), maxS());
      cam.x = sx - ((sx - cam.x) * s) / cam.s;
      cam.y = sy - ((sy - cam.y) * s) / cam.s;
      cam.s = s;
      applyCam();
    }

    function toggleZoom(sx = innerWidth / 2, sy = innerHeight / 2) {
      if (!open) return;
      if (zoomed()) return fit();
      const f = fitS();
      const a = actualS();
      zoomAt(sx, sy, (a > f * 1.1 ? a : f * 2) / cam.s);
    }

    function relayout() {
      if (!open) return;
      const fitted = cam.s <= fittedAt * 1.02;
      layout();
      if (fitted) fit();
      else applyCam();
    }
    window.addEventListener('resize', relayout);

    // Screen to drawing units on the piece, and back.
    const toUnits = (sx, sy) => ({ x: ((sx - cam.x) / cam.s) * units(), y: ((sy - cam.y) / cam.s) * units() });
    const toScreen = (u) => ({ x: cam.x + (u.x / units()) * cam.s, y: cam.y + (u.y / units()) * cam.s });
    const onPiece = (sx, sy) => sx >= cam.x && sy >= cam.y && sx <= cam.x + W * cam.s && sy <= cam.y + H * cam.s;

    // ---- the strip down the left

    function syncFilmTab() {
      document.body.classList.toggle('film-off', filmOff);
      filmTab.innerHTML = filmOff ? ICON.next : ICON.prev;
      filmTab.title = filmOff ? 'Show the strip (Shift+F)' : 'Hide the strip (Shift+F)';
      filmTab.setAttribute('aria-expanded', String(!filmOff));
    }
    function toggleFilm(showIt = filmOff) {
      filmOff = !showIt;
      store('wb:filmoff', filmOff);
      syncFilmTab();
      relayout();
      if (showIt) paintFilm(true);
    }
    function setFilmWidth(w, keep = true) {
      if (w != null) w = Math.round(clamp(w, 64, 360));
      if (w == null) document.body.style.removeProperty('--fsw');
      else document.body.style.setProperty('--fsw', `${w}px`);
      if (keep) store('wb:fsw', w);
      relayout();
    }
    syncFilmTab();
    if (Number.isFinite(store('wb:fsw'))) setFilmWidth(store('wb:fsw'), false);
    dragEdge(filmGrip, (x) => setFilmWidth(x, false), () => setFilmWidth(film.offsetWidth));
    filmGrip.addEventListener('dblclick', () => setFilmWidth(null));
    filmGrip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      setFilmWidth(film.offsetWidth + (e.key === 'ArrowRight' ? 24 : -24));
    });

    function dragEdge(grip, move, end) {
      grip.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          grip.setPointerCapture(e.pointerId);
        } catch {
          // without it the drag lasts only while the pointer stays on the edge
        }
        grip.classList.add('held');
        const onMove = (m) => move(m.clientX);
        const onEnd = () => {
          grip.classList.remove('held');
          grip.removeEventListener('pointermove', onMove);
          grip.removeEventListener('pointerup', onEnd);
          grip.removeEventListener('pointercancel', onEnd);
          end();
        };
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onEnd);
        grip.addEventListener('pointercancel', onEnd);
      });
    }

    const stillOf = (p) => p.th || (p.type === 'video' ? p.poster : p.prev || p.src) || '';
    let filmSig = '';
    function paintFilm(recentre = false) {
      const openCount = new Map();
      for (const c of roots()) if (!c.done) openCount.set(c.on, (openCount.get(c.on) || 0) + 1);
      const sig = pieces.map((p) => `${p.id} ${stillOf(p)} ${openCount.get(p.id) || 0} ${p.label || p.name || ''}`).join('|');
      if (sig !== filmSig) {
        filmSig = sig;
        film.replaceChildren(...pieces.map((p, i) => {
          const still = stillOf(p);
          const n = openCount.get(p.id);
          const kind = p.type === 'video' ? 'Video' : 'Image';
          return el('button', { class: 'fs-item', 'data-id': p.id, title: p.label || p.name || kind, onclick: () => show(p.id) },
            el('span', { class: 'fs-num', text: String(i + 1) }),
            el('span', { class: 'fs-thumb', style: { aspectRatio: String(clamp((p.nw || 16) / (p.nh || 9), 0.6, 2.4)) } },
              still && el('img', { src: still, alt: '', decoding: 'async', draggable: 'false' }),
              p.type === 'video' && el('span', { class: 'fs-badge', html: ICON.play }),
              n && el('span', { class: 'fs-count', text: String(n), title: n > 1 ? `${n} open comments` : '1 open comment' })),
            el('span', { class: 'fs-label' },
              el('span', { class: 'fs-name', text: p.label || p.name || kind }),
              el('span', { class: 'fs-kind', text: p.type === 'video' && p.dur ? `${kind} · ${fmtTime(p.dur)}` : kind })));
        }));
        recentre = true;
      }
      const i = pieces.findIndex((p) => p.id === open.id);
      posEl.textContent = `${i + 1} / ${pieces.length}`;
      posEl.style.minWidth = `${String(pieces.length).length * 2 + 3}ch`;
      prevBtn.disabled = nextBtn.disabled = pieces.length < 2;
      for (const node of film.children) {
        const current = node.dataset.id === open.id;
        if (current === node.classList.contains('current') && !(current && recentre)) continue;
        node.classList.toggle('current', current);
        if (!current) {
          node.removeAttribute('aria-current');
          continue;
        }
        node.setAttribute('aria-current', 'true');
        film.scrollTo({ top: node.offsetTop - (film.clientHeight - node.offsetHeight) / 2, behavior: recentre || calm.matches ? 'auto' : 'smooth' });
      }
    }

    // ---- the timeline under a video

    const tlPlay = el('button', { class: 'iconbtn', html: ICON.play, title: 'Play or pause (Space, or K)', onclick: () => togglePlay() });
    const tlSound = el('button', { class: 'iconbtn', html: ICON.muted, title: 'Sound on / off (M)', onclick: () => toggleSound() });
    const tlLoop = el('button', { class: 'iconbtn tl-loop', html: ICON.loop, onclick: () => setLooping(!looping) });
    function setLooping(on) {
      looping = on;
      store('wb:loop', on);
      const video = videoOpen();
      if (video) video.loop = on && !runMode();
      tlLoop.classList.toggle('active', on);
      tlLoop.setAttribute('aria-pressed', String(on));
      tlLoop.title = on ? 'Looping: starts again at the end. Click to stop at the end' : 'Stops at the end. Click to loop';
      if (typeof spare !== 'undefined' && open && runMode()) prepareSpare();
    }
    setLooping(looping);
    const tlTime = el('button', { class: 'tl-time', text: '0:00', title: 'Show minutes and seconds, frame number or timecode', onclick: cycleTimeMode });
    const tlMarks = el('div', { class: 'tl-marks' });
    const tlTip = el('span', { class: 'tl-tip', hidden: true });
    const tlLoaded = el('i', { class: 'tl-loaded' });
    const tlWave = el('canvas', { class: 'tl-wave', width: 480, height: 80 });
    const tlRun = el('div', { class: 'tl-run' });
    const tlTrack = el('div', { class: 'tl-track' }, tlWave, tlRun, el('i', { class: 'tl-rail' }, tlLoaded, el('i', { class: 'tl-played' })), tlMarks, el('i', { class: 'tl-head' }), tlTip);
    // A run's strip: every shot as a clip as long as it lasts, with its still, and where each sequence
    // begins. It is the track: dragging along it moves through the whole run.
    let runSig = '';
    function paintRun(force = false) {
      cut.show(true);
      const sig = runClips.map((c) => `${c.id}:${c.dur.toFixed(2)}:${c.piece.poster || c.piece.th || ''}`).join('|');
      if (force || sig !== runSig) {
        runSig = sig;
        const pct = (at) => `${(at / runTotal) * 100}%`;
        // Along the top, the sequences: a band each, shaded in turn, named where there is room.
        const seqs = [];
        for (const c of runClips) {
          const last = seqs[seqs.length - 1];
          if (last && last.seq === (c.piece.seq || '')) last.end = c.start + c.dur;
          else seqs.push({ seq: c.piece.seq || '', start: c.start, end: c.start + c.dur });
        }
        const band = el('span', { class: 'tl-seqs' }, seqs.map((q, i) => el('i', {
          class: `tl-seq${i % 2 ? ' odd' : ''}`, 'data-seq': q.seq, title: q.seq,
          style: { left: pct(q.start), width: pct(q.end - q.start) },
        }, el('b', { text: q.seq }))));
        // Under it, every shot as its stills, cut from the next by a line; its name only where it fits.
        let seq = null;
        const clipEls = runClips.map((c) => {
          const still = stillOf(c.piece);
          const starts = !!c.piece.seq && c.piece.seq !== seq;
          seq = c.piece.seq;
          return el('i', {
            class: `tl-clip${starts ? ' seq-start' : ''}${c.piece.empty ? ' empty' : ''}`, 'data-id': c.id, title: c.piece.label || c.piece.name || '',
            style: { left: pct(c.start), width: pct(c.dur) },
          },
          el('span', { class: 'tl-clippic', style: still && !c.piece.empty ? { backgroundImage: `url("${still}")` } : {} }),
          el('span', { class: 'tl-clipname' }, el('b', { text: c.piece.name || '' }), !c.piece.empty && el('span', { text: versionPart(c.piece) })));
        });
        tlRun.classList.toggle('one-seq', seqs.length < 2 && !seqs[0]?.seq);
        tlRun.replaceChildren(band, el('span', { class: 'tl-clips' }, clipEls), el('i', { class: 'tl-window' }));
        cut.setClips(runClips, runTotal);
        paintCutMarks();
      }
      const atClip = runClips.find((c) => c.id === (open && open.id));
      for (const n of tlRun.querySelectorAll('.tl-clip')) n.classList.toggle('at', n.dataset.id === (open && open.id));
      for (const n of tlRun.querySelectorAll('.tl-seq')) n.classList.toggle('at', !!atClip && n.dataset.seq === (atClip.piece.seq || ''));
      const i = runClips.findIndex((c) => c.id === (open && open.id));
      posEl.textContent = `${i + 1} / ${runClips.length}`;
      posEl.style.minWidth = `${String(runClips.length).length * 2 + 3}ch`;
      prevBtn.disabled = nextBtn.disabled = runClips.length < 2;
    }
    // Under the whole run, a close-up of it with the playhead held in the middle (cuttrack.js).
    let cutHold = null;
    const cut = WBCutTrack.create({
      onGrab: () => {
        interact();
        cutHold = { resume: runPlaying || !!(videoOpen() && !videoOpen().paused) };
        runPlaying = false;
        cancelAnimationFrame(stillRaf);
        if (videoOpen()) videoOpen().pause();
      },
      onSeek: (t) => {
        runSeek(t);
        told();
      },
      onRelease: () => {
        if (cutHold && cutHold.resume) {
          runPlaying = true;
          playOpen();
        }
        cutHold = null;
        syncTimeline();
        told();
      },
      onZoom: () => syncTimeline(),
    });
    // Comments on any shot of the run, where they are in it.
    function paintCutMarks() {
      if (!runMode()) return;
      const list = [];
      for (const c of roots()) {
        const clip = clipOf(c.on);
        const at = clip && momentOf(c);
        if (at == null) continue;
        list.push({ at: clip.start + Math.min(at, clip.dur), color: hexOk(c.color) ? c.color : '#8a8a8a' });
      }
      cut.setMarks(list);
    }
    timeline.append(tlPlay,
      el('button', { class: 'iconbtn tl-step', html: ICON.frameBack, title: 'Back one frame ( , )   With Shift, one second', onclick: (e) => stepFrame(-1, e.shiftKey) }),
      el('button', { class: 'iconbtn tl-step', html: ICON.frameFwd, title: 'Forward one frame ( . )   With Shift, one second', onclick: (e) => stepFrame(1, e.shiftKey) }),
      tlTime, tlTrack, tlLoop, tlSound, cut.node);
    window.addEventListener('wb:theme', () => {
      delete tlWave.dataset.drawn;
      fitWave(tlWave);
      paintInk();
    });
    window.addEventListener('wb:timemode', () => { if (open) { syncTimeline(); renderPanel(); syncComposer(); } });

    function paintWave() {
      const wf = open && open.type === 'video' ? open.wf : null;
      tlTrack.classList.toggle('wave', !!wf);
      if (wf) showWave(tlWave, wf);
    }

    function syncTimeline(at) {
      const video = videoOpen();
      if (!open || (!video && !runMode())) return;
      if (at == null && video) at = whereOf(video);
      const dur = video ? video.duration : STILL;
      if (video && changing.has(video) && !(dur > 0)) return;
      const fps = fpsOf(open.id);
      // In a run, the track and the time are the run's: where this shot starts, and on from there.
      const c = runMode() ? clipOf(open.id) : null;
      const here = c ? c.start + (video ? at : stillAt) : at;
      const span = c ? runTotal : dur;
      tlTrack.style.setProperty('--p', `${(span > 0 && isFinite(span) ? clamp(here / span, 0, 1) : 0) * 100}%`);
      if (c) {
        cut.setTime(here);
        // The stretch the close-up shows, marked on the whole run.
        tlTrack.style.setProperty('--w', `${clamp(cut.span() / (runTotal || 1), 0, 1) * 100}%`);
      }
      const label = timeLabel(here, span, fps);
      if (tlTime.textContent !== label) tlTime.textContent = label;
      const playing = runMode() ? runPlaying || (video && !video.paused) : !video.paused;
      const state = `${!playing}${video ? video.muted : ''}`;
      if (timeline.dataset.state !== state) {
        timeline.dataset.state = state;
        tlPlay.innerHTML = playing ? ICON.pause : ICON.play;
        if (video) tlSound.innerHTML = video.muted ? ICON.muted : ICON.sound;
      }
      // The moment a comment written now would be about.
      if (!panel.hidden && !momentChip.hidden && !(draft && draft.at != null)) {
        const moment = fmtMoment(at, fps);
        if (momentChip.lastChild.textContent !== moment) momentChip.lastChild.textContent = moment;
      }
    }

    // How much of the video the browser has, drawn lighter along the track; all of it once it is held whole.
    function syncLoaded() {
      const video = videoOpen();
      const parts = [];
      if (video && video.dataset.whole === open.src) {
        parts.push(el('i', { style: { left: '0', width: '100%' } }));
      } else if (video && video.duration > 0 && isFinite(video.duration)) {
        const dur = video.duration;
        for (let i = 0; i < video.buffered.length; i++) {
          const from = video.buffered.start(i) / dur;
          parts.push(el('i', { style: { left: `${from * 100}%`, width: `${(video.buffered.end(i) / dur - from) * 100}%` } }));
        }
        const entry = WB.media.wholeEntry(open.src);
        if (entry && entry.total) parts.push(el('i', { class: 'coming', style: { left: '0', width: `${(entry.loaded / entry.total) * 100}%` } }));
      }
      tlLoaded.replaceChildren(...parts);
    }

    // Playing, stopping and moving the video. Only what this hand does is told to the host.
    function told() {
      const video = videoOpen();
      if (!video || !opts.onMedia) return;
      opts.onMedia(open.id, !video.paused, whereOf(video));
    }
    function togglePlay() {
      const video = videoOpen();
      if (runMode() && open) {
        interact();
        runPlaying = video ? video.paused : !runPlaying;
        if (runPlaying) {
          // From the very end, the run starts again.
          if (!runClips.some((c) => c.start > runAt() - 0.01) && video && video.duration - whereOf(video) < 0.1) runSeek(0);
          playOpen();
        } else {
          if (video) video.pause();
          cancelAnimationFrame(stillRaf);
          if (video) holdWhole(open);
        }
        syncTimeline();
        told();
        return;
      }
      if (!video) return;
      interact();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      told();
    }
    function toggleSound() {
      const video = videoOpen();
      if (video) video.muted = !video.muted;
      if (spare && video) spare.video.muted = video.muted;
    }
    function stepFrame(dir, second = false) {
      const video = videoOpen();
      if (!video) return;
      interact();
      runPlaying = false;
      video.pause();
      const fps = fpsOf(open.id);
      if (fps) goTo(video, frameTime(clamp(frameIndex(whereOf(video), fps) + dir * (second ? Math.round(fps) : 1), 0, lastFrame(video, fps)), fps));
      else goTo(video, clamp(whereOf(video) + dir * (second ? 1 : 1 / 24), 0, video.duration || 0));
      told();
    }
    function wholeFrame(at) {
      const video = videoOpen();
      const fps = fpsOf(open.id);
      return video && fps ? frameTime(Math.min(frameIndex(at, fps), lastFrame(video, fps)), fps) : at;
    }
    function seek(at) {
      const video = videoOpen();
      if (!video || at == null) return;
      runPlaying = false;
      video.pause();
      goTo(video, at);
      told();
    }
    // Stops the video on the frame it is showing, so what is made on it next belongs to that frame.
    // A run stopped where it is: drawing or writing on a shot stays on that shot, still or video.
    function stopRun() {
      if (!runMode() || !runPlaying) return;
      runPlaying = false;
      cancelAnimationFrame(stillRaf);
      const video = videoOpen();
      if (video) video.pause();
      syncTimeline();
    }
    function holdFrame() {
      stopRun();
      const video = videoOpen();
      if (!video) return;
      const fps = fpsOf(open.id);
      if (video.paused && !fps) return;
      const at = fps ? frameTime(frameIndex(whereOf(video), fps), fps) : null;
      if (video.paused && Math.abs(at - whereOf(video)) < 0.001) return;
      video.pause();
      if (at != null) goTo(video, at);
      told();
    }
    const heldFrame = () => {
      const video = videoOpen();
      const fps = fpsOf(open.id);
      return video && fps && video.paused ? frameIndex(whereOf(video), fps) : null;
    };
    const atEnd = () => {
      const video = videoOpen();
      return !!video && video.duration - whereOf(video) < 1.5 / (fpsOf(open.id) || 24);
    };

    // Dragging along the track. A press on a mark picks its comment, unless the hand then moves.
    let scrub = null;
    let markPress = null;
    let dragFromMark = false;
    const scrubbable = () => {
      if (runMode() && open && runTotal > 0) return videoOpen() || tlTrack;
      const video = videoOpen();
      return video && video.duration > 0 && isFinite(video.duration) ? video : null;
    };
    function trackMoment(e) {
      const video = videoOpen();
      const r = tlTrack.getBoundingClientRect();
      const k = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      if (runMode()) return { k, at: k * runTotal };
      return { k, at: wholeFrame(k * video.duration) };
    }
    function scrubTo(e) {
      const { at } = trackMoment(e);
      if (runMode()) {
        runSeek(at);
        return told();
      }
      goTo(videoOpen(), at);
      syncTimeline(at);
      told();
    }
    function beginScrub(e, video) {
      try {
        tlTrack.setPointerCapture(e.pointerId);
      } catch {
        // capture is a nicety
      }
      interact();
      scrub = { pid: e.pointerId, resume: runMode() ? runPlaying : !video.paused };
      if (runMode()) {
        runPlaying = false;
        cancelAnimationFrame(stillRaf);
      }
      if (videoOpen()) videoOpen().pause();
      scrubTo(e);
    }
    tlTrack.addEventListener('pointerdown', (e) => {
      const video = scrubbable();
      if (!video || e.button !== 0) return;
      dragFromMark = false;
      const held = document.activeElement;
      if (held && held.tagName === 'TEXTAREA' && panel.contains(held)) held.blur();
      if (e.target.closest('.tl-mark')) {
        markPress = { pid: e.pointerId, x: e.clientX };
        return;
      }
      e.preventDefault();
      beginScrub(e, video);
    });
    tlTrack.addEventListener('pointermove', (e) => {
      const video = scrubbable();
      if (!video) return;
      if (markPress && e.pointerId === markPress.pid && Math.abs(e.clientX - markPress.x) > 3) {
        markPress = null;
        dragFromMark = true;
        beginScrub(e, video);
      }
      const { k, at } = trackMoment(e);
      tlTip.hidden = false;
      tlTip.textContent = runMode() ? `${fmtMoment(at, fpsOf(open.id))}${runClipAt(at) ? ` · ${runClipAt(at).piece.label || ''}` : ''}` : fmtMoment(at, fpsOf(open.id));
      tlTip.style.left = `${k * 100}%`;
      if (scrub && e.pointerId === scrub.pid) scrubTo(e);
    });
    tlTrack.addEventListener('click', (e) => {
      if (!dragFromMark) return;
      dragFromMark = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    const runClipAt = (t) => {
      let c = null;
      for (const x of runClips) if (t >= x.start) c = x;
      return c;
    };
    const endScrub = (e) => {
      if (markPress && e.pointerId === markPress.pid) markPress = null;
      if (!scrub || e.pointerId !== scrub.pid) return;
      if (runMode()) {
        if (scrub.resume) {
          runPlaying = true;
          playOpen();
        }
        scrub = null;
        tlTip.hidden = !tlTrack.matches(':hover');
        syncTimeline();
        return void told();
      }
      const video = scrubbable();
      if (video && scrub.resume && !atEnd()) video.play().catch(() => {});
      scrub = null;
      tlTip.hidden = !tlTrack.matches(':hover');
      if (video) told();
    };
    tlTrack.addEventListener('pointerup', endScrub);
    tlTrack.addEventListener('pointercancel', endScrub);
    tlTrack.addEventListener('pointerleave', () => { if (!scrub) tlTip.hidden = true; });

    // A mark above the track for every comment, in its writer's colour. Comments about the same moment
    // share a mark that says how many they are, and each click on it goes to the next of them.
    function paintMarks() {
      paintCutMarks();
      const video = videoOpen();
      const dur = video ? video.duration : 0;
      if (!video || !(dur > 0) || !isFinite(dur)) return void tlMarks.replaceChildren();
      const c0 = runMode() ? clipOf(open.id) : null;
      const leftOf = (at) => `${clamp(c0 ? (c0.start + at) / runTotal : at / dur, 0, 1) * 100}%`;
      const stacks = new Map();
      for (const c of roots()) {
        if (c.on !== open.id) continue;
        const at = momentOf(c);
        if (at == null) continue;
        const key = Math.round(at * 1000);
        (stacks.get(key) || stacks.set(key, { left: leftOf(at), threads: [] }).get(key)).threads.push(c);
      }
      tlMarks.replaceChildren(...[...stacks.values()].map(({ left, threads }) => {
        const reading = threads.findIndex((c) => c.id === activeThread);
        const shown = threads[Math.max(reading, 0)];
        const many = threads.length > 1;
        const title = many ? `${threads.length} comments at this moment. Click again for the next` : `${shown.name}: ${shown.text}`;
        return el('button', {
          class: `tl-mark comment${threads.every((c) => c.done) ? ' done' : ''}${reading >= 0 ? ' active' : ''}`, title, 'aria-label': title,
          style: { left, background: hexOk(shown.color) ? shown.color : '#8a8a8a' },
          onclick: () => pickThread(threads[(reading + 1) % threads.length].id),
        }, many && el('span', { class: 'tl-n', text: String(threads.length) }));
      }));
    }

    // ---- what is drawn on the piece

    const plainDrawings = () => (open && opts.drawings ? opts.drawings(open.id) || [] : []);

    // What was drawn for a comment shows with its thread: on an image whenever the thread is picked, on a
    // video when it is stopped on the comment's frame (or always, for one about the whole video). What is
    // being drawn shows while it is drawn. Ordinary drawings always show.
    function threadDrawingShows(c) {
      if (!c || !Array.isArray(c.drawing) || c.on !== open.id || !drawnHere(c)) return false;
      const video = videoOpen();
      const at = video ? momentOf(c) : null;
      if (at == null) return true;
      return video.paused && Math.abs(whereOf(video) - at) < 0.6 / (fpsOf(c.on) || 24);
    }

    let calling = null; // { id, until }: the thread whose drawing glows when it comes into sight
    let erasing = null; // what an eraser stroke is taking away
    function paintInk(live) {
      if (!open) return;
      const k = units();
      const nodes = [];
      const add = (s, cls, key) => {
        const g = strokeNode(s);
        if (cls) g.setAttribute('class', cls);
        if (key && erasing && erasing.hit.has(key)) g.classList.add('erased');
        nodes.push(g);
      };
      if (!in3d) for (const s of plainDrawings()) add(s, 'plain', `p:${s.id}`);
      const c = activeThread && noteById(activeThread);
      if (threadDrawingShows(c)) {
        const glow = calling && calling.id === c.id && performance.now() < calling.until;
        for (const s of c.drawing) add(s, glow ? 'callout' : '');
        if (glow) calling = null;
      }
      if (draft && draft.on === open.id && drawnHere(draft)) draft.strokes.forEach((s, i) => add(s, '', `d:${i}`));
      if (live) nodes.push(live);
      ink.replaceChildren(...nodes);
      ink.style.setProperty('--k', String(k));
    }

    // The brush, in the viewer, is as heavy as the piece is large: a set part of its longer side, so a line
    // looks the same on every piece.
    const brushSize = () => 4 * Math.max(1, H / W);
    let pen = store('wb:pen') || { color: INK[1] };
    if (!INK.includes(pen.color)) pen = { ...pen, color: INK[1] };

    // A stroke on the piece belongs to the comment being written, and starts one if none is. On a video
    // that comment is about the frame its latest stroke was drawn on.
    function stampMoment(c) {
      delete c.at;
      delete c.fr;
      const video = videoOpen();
      if (!video || !timed) return;
      holdFrame();
      if (isFinite(whereOf(video))) c.at = Math.round(whereOf(video) * 100) / 100;
      const fr = heldFrame();
      if (fr !== null) c.fr = fr;
    }

    function addDraftStroke(stroke) {
      if (!draft || draft.on !== open.id) {
        draft = { id: uid(), on: open.id, strokes: [], ...(in3d && { pov: 'main' }) };
        activeThread = null;
      }
      stampMoment(draft);
      draft.strokes.push(stroke);
      unstroked.length = 0;
      paintInk();
      // The panel is there with its box ready, so what the drawing is about can be typed at once.
      if (!panelShown() && !narrow()) togglePanel(true);
      else renderPanel();
      if (!narrow()) setTimeout(() => composer.focus({ preventScroll: true }), 0);
    }

    function discardDrawing() {
      if (!draft) return 0;
      const n = draft.strokes.length;
      draft = null;
      paintInk();
      renderPanel();
      return n;
    }

    function undo() {
      if (draft && draft.strokes.length) {
        unstroked.push(draft.strokes.pop());
        if (!draft.strokes.length) draft = null;
        paintInk();
        renderPanel();
      } else if (opts.undo) {
        opts.undo();
      }
    }
    function redo() {
      if (unstroked.length && open) {
        if (!draft || draft.on !== open.id) draft = { id: uid(), on: open.id, strokes: [], ...(in3d && { pov: 'main' }) };
        draft.strokes.push(unstroked.pop());
        paintInk();
        renderPanel();
      } else if (opts.redo) {
        opts.redo();
      }
    }

    async function clearDrawing() {
      const n = plainDrawings().length;
      if (!n || !opts.clear) return;
      const sure = await WB.dialog({
        title: n === 1 ? 'Clear the drawing?' : `Clear ${n} drawings?`,
        text: `Everything drawn on this ${open.type} that is not part of a comment is deleted, for everyone. Drawings that belong to comments stay with their threads.`,
        ok: 'Clear',
        danger: true,
      });
      if (sure && open) opts.clear(open.id);
    }

    // ---- the laser: a trail that fades, for everyone watching

    const trails = new Map(); // who -> { color, pts: [{ x, y, t }] } in drawing units on the open piece
    const laserOut = [];
    let laserRaf = 0;
    let laserSend = 0;
    let pointerAt = null;
    function requestLaser() {
      if (!laserRaf) laserRaf = requestAnimationFrame(drawLaser);
    }
    function addLaser(key, color, p, t = performance.now()) {
      let trail = trails.get(key);
      if (!trail) trails.set(key, (trail = { color, pts: [] }));
      trail.pts.push({ x: p.x, y: p.y, t });
      requestLaser();
    }
    function drawLaser() {
      laserRaf = 0;
      const dpr = window.devicePixelRatio || 1;
      const w = innerWidth;
      const h = innerHeight;
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
        const P = trail.pts.map((q) => ({ ...toScreen(q), k: Math.max(0, 1 - (now - q.t) / LASER_LIFE) }));
        ctx.strokeStyle = trail.color;
        ctx.shadowColor = trail.color;
        ctx.shadowBlur = 6;
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
      ctx.globalAlpha = 1;
      if (tool === 'laser' && pointerAt) {
        ctx.shadowColor = me().color;
        ctx.shadowBlur = 9;
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = me().color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pointerAt.x, pointerAt.y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      if (trails.size) laserRaf = requestAnimationFrame(drawLaser);
    }
    function sendLaser() {
      if (laserSend) return;
      laserSend = setTimeout(() => {
        laserSend = 0;
        if (laserOut.length && open && opts.onLaser) opts.onLaser(open.id, laserOut.splice(0));
        else laserOut.length = 0;
      }, 25);
    }

    // ---- tools: the brush, the eraser, the laser, and the hand

    function setTool(name) {
      if ((name === 'pen' || name === 'eraser') && in3d && three && three.isFree()) backToMain();
      if (!can.draw() && (name === 'pen' || name === 'eraser')) name = 'pan';
      tool = name;
      root.dataset.tool = name;
      syncTools();
      requestLaser();
    }
    function syncTools() {
      if (!cpPen) return;
      const drawing = tool === 'pen' || tool === 'eraser';
      cpPen.classList.toggle('active', drawing);
      cpPen.setAttribute('aria-pressed', String(drawing));
      cpPen.title = drawing ? 'Stop drawing (P)' : 'Draw on the picture, to point at what you mean (P)';
      cpEraser.classList.toggle('active', tool === 'eraser');
      cpBrush.hidden = !can.draw() || !drawing;
      root.dataset.tool = tool;
      const acts = [
        ['pan', 'Pan', ICON.pan, () => setTool('pan')],
        can.draw() && ['pen', 'Draw', ICON.pen, () => setTool('pen')],
        can.draw() && ['eraser', 'Erase', ICON.eraser, () => setTool('eraser')],
        ['laser', 'Laser', ICON.laser, () => setTool('laser')],
        can.draw() && ['undo', 'Undo', ICON.undo, undo],
        can.draw() && ['redo', 'Redo', ICON.redo, redo],
        can.draw() && ['clear', 'Clear', ICON.trash, () => (draft && draft.strokes.length ? (discardDrawing(), toast('Your drawing was taken back', { ms: 2000 })) : clearDrawing())],
      ].filter(Boolean);
      tools.replaceChildren(...acts.map(([name, label, html, run]) => el('button', { class: `iconbtn${tool === name ? ' active' : ''}`, title: label, html, onclick: run }, el('span', { class: 'tl', text: label }))));
    }

    // ---- the pointer on the piece

    let gesture = null;
    let spaceDown = false;
    let spaceTap = false;
    let spaceAt = 0;
    const touches = new Map();
    let pinch = null;

    function begin(g, e) {
      gesture = { ...g, pid: e.pointerId };
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // without capture a gesture ends when the pointer leaves
      }
    }

    // In 3D a press on the view is the view's, even one that flies it (which goes no further): whatever has the
    // keyboard (a comment half typed, say) lets go of it first, so the keys move the view. What was typed stays.
    stage.addEventListener('pointerdown', () => {
      if (!open || !in3d) return;
      const held = document.activeElement;
      if (held && held !== document.body && (WB.isTyping(held) || !root.contains(held) || held.matches('button, a[href], select'))) held.blur();
    }, true);
    stage.addEventListener('pointerdown', (e) => {
      if (!open) return;
      const held = document.activeElement;
      if (held && held !== document.body && !root.contains(held)) held.blur();
      else if (held && held.tagName === 'TEXTAREA') held.blur();
      closeNames();
      e.preventDefault();
      if (e.pointerType === 'touch') {
        if (e.isPrimary) {
          touches.clear();
          pinch = null;
        }
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try {
          stage.setPointerCapture(e.pointerId);
        } catch {
          // as above
        }
        if (touches.size >= 2) {
          // A second finger turns whatever the first was doing into a pinch; a stroke it began is taken back.
          gesture = null;
          paintInk();
          if (touches.size === 2) {
            const [a, b] = [...touches.values()];
            pinch = { d0: Math.hypot(b.x - a.x, b.y - a.y) || 1, m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cam: { ...cam } };
            interact();
          }
          return;
        }
      }
      if (gesture) return;
      const on = onPiece(e.clientX, e.clientY);
      const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (spaceDown || tool === 'pan' || tool === 'laser'));
      if (e.button === 0 && tool === 'eraser' && can.draw()) {
        erasing = { hit: new Set(), last: toUnits(e.clientX, e.clientY) };
        begin({ type: 'erase' }, e);
        eraseAt(erasing.last, erasing.last);
        return;
      }
      if (pan) {
        // With the hand, one finger on a phone swipes on to the next piece while it fits, and moves around it once zoomed in.
        if (e.pointerType === 'touch' && !zoomed()) return begin({ type: 'swipe', sx: e.clientX, sy: e.clientY, onPiece: on }, e);
        interact();
        return begin({ type: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, onPiece: on && e.button === 0 && !spaceDown && tool !== 'laser', moved: false }, e);
      }
      if (e.button !== 0 || tool !== 'pen') return;
      if (!on || !can.draw()) {
        if (e.pointerType === 'touch') return begin({ type: 'swipe', sx: e.clientX, sy: e.clientY }, e);
        interact();
        return begin({ type: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false }, e);
      }
      holdFrame();
      const p = toUnits(e.clientX, e.clientY);
      const w0 = e.pointerType === 'pen' && e.pressure > 0 ? 0.25 + 0.75 * e.pressure : 0.5;
      begin({ type: 'draw', pts: [p.x, p.y], ws: [w0], lt: e.timeStamp, t0: performance.now(), touch: e.pointerType === 'touch', sx: e.clientX, sy: e.clientY, far: 0 }, e);
      paintLive();
    });

    function paintLive() {
      const g = gesture;
      const pts = g.line ? g.line.pts : g.pts;
      const ws = g.line ? g.line.ws : g.ws;
      const path = svgEl('path', { d: outlinePath(pts, ws, 1, 1, brushSize()), fill: inkColor(pen.color) });
      paintInk(path);
    }

    // A brush line between two points, with enough points along it for the outline to follow.
    function straightLine(x0, y0, x1, y1) {
      const n = 12;
      const pts = [];
      for (let i = 0; i <= n; i++) pts.push(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n);
      return { pts, ws: new Array(n + 1).fill(0.6) };
    }

    function eraseAt(a, b) {
      const r = (12 / cam.s) * units();
      const hits = (s) => strokePoints(s).some((q) => pointSegDist(q, a, b) <= r + (s.size || 0) / 2);
      for (const s of plainDrawings()) if (hits(s)) erasing.hit.add(`p:${s.id}`);
      if (draft && draft.on === open.id) draft.strokes.forEach((s, i) => { if (hits(s)) erasing.hit.add(`d:${i}`); });
      paintInk();
    }

    stage.addEventListener('pointermove', (e) => {
      if (!open) return;
      pointerAt = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinch && touches.size >= 2) {
          const [a, b] = [...touches.values()];
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const s = clamp((pinch.cam.s * Math.hypot(b.x - a.x, b.y - a.y)) / pinch.d0, fitS(), maxS());
          cam.x = m.x - ((pinch.m0.x - pinch.cam.x) * s) / pinch.cam.s;
          cam.y = m.y - ((pinch.m0.y - pinch.cam.y) * s) / pinch.cam.s;
          cam.s = s;
          applyCam();
          return;
        }
      }
      if (tool === 'laser') {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [e]) {
          const q = toUnits(ev.clientX, ev.clientY);
          addLaser('me', me().color, q);
          laserOut.push(Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10);
        }
        sendLaser();
      }
      const g = gesture;
      if (!g || e.pointerId !== g.pid) return;
      if (g.type === 'pan') {
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 4) g.moved = true;
        cam.x = g.cx + (e.clientX - g.sx);
        cam.y = g.cy + (e.clientY - g.sy);
        applyCam();
      } else if (g.type === 'erase') {
        const q = toUnits(e.clientX, e.clientY);
        eraseAt(erasing.last, q);
        erasing.last = q;
      } else if (g.type === 'draw') {
        g.far = Math.max(g.far, Math.hypot(e.clientX - g.sx, e.clientY - g.sy));
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [e]) {
          const q = toUnits(ev.clientX, ev.clientY);
          const n = g.pts.length;
          const dist = Math.hypot(q.x - g.pts[n - 2], q.y - g.pts[n - 1]);
          const px = (dist / units()) * cam.s;
          if (px < 1.5) continue;
          // Slow, deliberate strokes lay down more ink; quick flicks thin out.
          const speed = px / Math.max(1, ev.timeStamp - g.lt);
          const target = ev.pointerType === 'pen' && ev.pressure > 0 ? 0.25 + 0.75 * ev.pressure : 0.18 + 0.82 * Math.exp(-speed * 0.45);
          g.ws.push(g.ws[g.ws.length - 1] * 0.6 + target * 0.4);
          g.pts.push(q.x, q.y);
          g.lt = ev.timeStamp;
        }
        // Holding shift swaps what was drawn for a straight line from where it began.
        const p = toUnits(e.clientX, e.clientY);
        g.line = e.shiftKey ? straightLine(g.pts[0], g.pts[1], p.x, p.y) : null;
        paintLive();
      }
    });

    function endGesture(e) {
      if (e && e.pointerType === 'touch' && touches.delete(e.pointerId) && pinch) {
        if (touches.size < 2) pinch = null;
        return;
      }
      const g = gesture;
      if (!g || (e && e.pointerId !== g.pid)) return;
      gesture = null;
      const up = !!e && e.type === 'pointerup';
      if (g.type === 'pan') {
        if (up && !g.moved && g.onPiece && videoOpen()) togglePlay();
      } else if (g.type === 'swipe') {
        const dx = e ? e.clientX - g.sx : 0;
        const dy = e ? e.clientY - g.sy : 0;
        if (up && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
        else if (up && g.onPiece && Math.hypot(dx, dy) < 8 && videoOpen()) togglePlay();
      } else if (g.type === 'erase') {
        const hit = erasing ? erasing.hit : new Set();
        erasing = null;
        if (up && hit.size) {
          if (draft) {
            draft.strokes = draft.strokes.filter((s, i) => !hit.has(`d:${i}`));
            if (!draft.strokes.length) draft = null;
          }
          const plain = [...hit].filter((k) => k.startsWith('p:')).map((k) => k.slice(2));
          if (plain.length && opts.erase) opts.erase(plain);
          renderPanel();
        }
        paintInk();
      } else if (g.type === 'draw') {
        // A finger that only touched, or was taken away by the browser, meant no mark.
        if (g.touch && (!up || (g.far < 6 && performance.now() - g.t0 < 350))) return void paintInk();
        const pts = g.line ? g.line.pts : g.pts;
        const ws = (g.line ? g.line.ws : g.ws).slice();
        // The stroke ends in a flick: the last few points taper off.
        if (!g.line && ws.length > 4) [0.8, 0.6, 0.4].forEach((k, i) => { ws[ws.length - 1 - i] *= k; });
        addDraftStroke(makeStroke(pts, ws, brushSize(), pen.color, false));
      }
    }
    stage.addEventListener('pointerup', endGesture);
    stage.addEventListener('pointercancel', endGesture);
    stage.addEventListener('lostpointercapture', (e) => { if (gesture && e.pointerId === gesture.pid) endGesture(e); });
    stage.addEventListener('pointerleave', () => { pointerAt = null; requestLaser(); });
    stage.addEventListener('contextmenu', (e) => e.preventDefault());
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!open) return;
      interact();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      zoomAt(e.clientX, e.clientY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }, { passive: false });
    for (const type of ['gesturestart', 'gesturechange']) root.addEventListener(type, (e) => e.preventDefault());

    // ---- the comments
    //
    // The panel lists the threads on the open piece. The first message starts a thread and replies hang
    // off it. Built once; after that only its list is drawn again, so what is being typed survives other
    // people's comments arriving.

    const cpTitle = el('h2', { text: 'Comments' });
    const cpCount = el('span', { class: 'count', hidden: true });
    const cpList = el('div', { class: 'cp-list' });
    cpList.addEventListener('click', (e) => {
      if (!activeThread || e.target.closest('.cp-card, button, a, textarea, input')) return;
      activeThread = null;
      replyBox.value = '';
      afterThread();
    });
    const cpFoot = el('div', { class: 'cp-foot' });
    const composer = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Leave a comment…', 'aria-label': 'Comment' });
    const replyBox = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Reply…', 'aria-label': 'Reply' });
    const editBox = el('textarea', { rows: 1, maxlength: 2000, 'aria-label': 'Edit comment' });
    const momentChip = el('button', {
      class: 'tchip', onclick: () => {
        timed = !timed;
        if (draft) stampMoment(draft);
        paintInk();
        syncComposer();
      },
    }, el('span', { html: ICON.play }), el('b'));
    const drawnChip = el('button', { class: 'tchip drawn', title: 'Take the drawing back', onclick: discardDrawing }, el('span', { html: ICON.scribble }), el('b'), el('span', { html: ICON.close }));
    const cpInks = el('span', { class: 'cp-inks' });
    // Drawing is something a comment does, as in Frame.io: the pen beside the box turns it on, its colours
    // and the eraser show while it is on, and sending the comment turns it off again.
    const cpPen = el('button', { class: 'iconbtn mini cp-pen', 'aria-pressed': 'false', html: ICON.pen, onclick: () => setTool(tool === 'pen' || tool === 'eraser' ? 'pan' : 'pen') });
    const cpEraser = el('button', { class: 'iconbtn mini', title: 'Eraser: drag over a drawing to remove it (E)', html: ICON.eraser, onclick: () => setTool(tool === 'eraser' ? 'pen' : 'eraser') });
    const cpBrush = el('div', { class: 'cp-brush', hidden: true }, cpInks, cpEraser);
    const cpCompose = el('div', { class: 'cp-compose' }, cpBrush, composer,
      el('div', { class: 'cp-actions' }, cpPen, momentChip, drawnChip, el('button', { class: 'btn small primary', text: 'Comment', title: 'Send (Enter)', onclick: submitComment })));

    function buildInks() {
      cpInks.replaceChildren(...INK.map((c) => el('button', {
        class: `swatch${c === pen.color ? ' active' : ''}`, style: { background: inkColor(c) }, title: 'Brush colour',
        onclick: () => {
          pen = { ...pen, color: c };
          store('wb:pen', { ...(store('wb:pen') || {}), color: c });
          buildInks();
          if (tool !== 'pen') setTool('pen');
        },
      })));
    }

    function autosize(input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    }
    // Enter sends, Shift+Enter starts a new line, Esc lets go of the box and gives the keys back to the viewer.
    function wireBox(input, send, cancel = () => input.blur()) {
      input.addEventListener('keydown', (e) => {
        if (mention && mention.input === input && !e.isComposing && mentionKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !input.value) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        }
      });
      input.addEventListener('input', () => {
        autosize(input);
        offerNames(input);
      });
      input.addEventListener('click', () => offerNames(input));
      input.addEventListener('blur', () => { if (mention && mention.input === input) closeNames(); });
    }

    // ---- @mentions: names offered while typing, and marked in what was written
    const mentionMenu = el('div', { class: 'menu mention-menu', role: 'listbox', 'aria-label': 'People', hidden: true });
    document.body.append(mentionMenu);
    let mention = null;
    const nameColors = new Map();
    function knownNames() {
      const names = new Map();
      const add = (n, color) => {
        const name = String(n || '').trim();
        if (!name || names.has(name.toLowerCase())) return;
        names.set(name.toLowerCase(), name);
        if (hexOk(color)) nameColors.set(name, color);
      };
      for (const p of (opts.names ? opts.names() : [])) add(p.name, p.color);
      for (const c of notes) if (!c.guest) add(c.name, c.color);
      return names;
    }
    function offerNames(input) {
      const before = input.value.slice(0, input.selectionStart);
      const m = /(^|\s)@([\p{L}\p{N}_.-]*)$/u.exec(before);
      if (!m || input.selectionStart !== input.selectionEnd) return closeNames();
      const q = m[2].toLowerCase();
      const names = knownNames();
      names.delete(me().name.trim().toLowerCase());
      const list = [...names.values()].filter((n) => n.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).sort((a, b) => a.localeCompare(b)).slice(0, 6);
      if (!list.length) return closeNames();
      const keep = mention && mention.input === input ? list.indexOf(mention.list[mention.i]) : -1;
      mention = { input, start: before.length - m[2].length - 1, list, i: Math.max(0, keep) };
      paintNames();
    }
    function paintNames() {
      const { input, list, i } = mention;
      mentionMenu.replaceChildren(...list.map((name, n) => el('button', {
        class: `menu-item${n === i ? ' active' : ''}`, role: 'option', 'aria-selected': String(n === i), type: 'button',
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => pickName(name),
      }, WB.avatar(name, nameColors.get(name)), el('span', { text: name }))));
      mentionMenu.hidden = false;
      const r = input.getBoundingClientRect();
      mentionMenu.style.left = `${Math.round(clamp(r.left, 8, innerWidth - mentionMenu.offsetWidth - 8))}px`;
      mentionMenu.style.top = `${Math.round(Math.max(8, r.top - mentionMenu.offsetHeight - 6))}px`;
    }
    function closeNames() {
      mention = null;
      mentionMenu.hidden = true;
    }
    function pickName(name) {
      const { input, start } = mention;
      closeNames();
      input.focus({ preventScroll: true });
      input.setRangeText(`@${name} `, start, input.selectionStart, 'end');
      autosize(input);
    }
    function mentionKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        mention.i = (mention.i + (e.key === 'ArrowDown' ? 1 : -1) + mention.list.length) % mention.list.length;
        paintNames();
        return true;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        pickName(mention.list[mention.i]);
        return true;
      }
      if (e.key === 'Escape') {
        closeNames();
        return true;
      }
      return false;
    }
    const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function mentionPattern() {
      const words = new Set();
      for (const name of [...knownNames().values(), me().name]) {
        words.add(name.trim());
        words.add(name.trim().split(/\s+/)[0]);
      }
      const alts = [...words].filter((w) => w.length >= 2).sort((a, b) => b.length - a.length).map(escapeRe);
      return alts.length ? new RegExp(`@(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') : null;
    }
    function markMentions(node, re) {
      if (!re) return;
      const mine = new Set([me().name.trim().toLowerCase(), me().name.trim().split(/\s+/)[0].toLowerCase()]);
      for (const t of [...node.childNodes]) {
        if (t.nodeType !== Node.TEXT_NODE) continue;
        const parts = [];
        let last = 0;
        re.lastIndex = 0;
        for (let m = re.exec(t.data); m; m = re.exec(t.data)) {
          if (m.index > last) parts.push(t.data.slice(last, m.index));
          parts.push(el('span', { class: `mention${mine.has(m[0].slice(1).toLowerCase()) ? ' me' : ''}`, text: m[0] }));
          last = m.index + m[0].length;
        }
        if (!parts.length) continue;
        if (last < t.data.length) parts.push(t.data.slice(last));
        t.replaceWith(...parts);
      }
    }

    // ---- your own comment, reworded in place
    function startEdit(c) {
      editingId = c.id;
      editBox.value = c.text;
      renderPanel();
      editBox.focus({ preventScroll: true });
      editBox.setSelectionRange(editBox.value.length, editBox.value.length);
      autosize(editBox);
    }
    function endEdit(save) {
      const c = noteById(editingId);
      const text = editBox.value.trim().slice(0, 2000);
      editingId = null;
      editBox.blur();
      if (save && c && text && text !== c.text) opts.set(c.id, { text, edited: Date.now() });
      else renderPanel();
    }
    wireBox(composer, submitComment);
    wireBox(replyBox, submitReply);
    wireBox(editBox, () => endEdit(true), () => endEdit(false));

    // What is half written in the comment box belongs to the piece it was written on.
    function switchTyped(from, to) {
      if (from && composer.value.trim()) typed.set(from, composer.value);
      else if (from) typed.delete(from);
      composer.value = (to && typed.get(to)) || '';
      autosize(composer);
    }
    // Starting to write about a video stops it, so the comment is about the frame that was showing.
    composer.addEventListener('focus', () => {
      if (!open) return;
      stopRun();
      if (timed) holdFrame();
    });

    const cpToggle = (label, title, checked, onchange) => {
      const box = el('input', { type: 'checkbox' });
      box.checked = checked;
      box.addEventListener('change', () => onchange(box.checked));
      return el('label', { class: 'cp-show', title }, box, label);
    };
    const cpGrip = el('div', { class: 'cp-grip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Width of the comments', title: 'Drag to make the comments wider or narrower. Double-click to put them back' });
    panel.append(
      // No close button here: the tab at the side shows and hides the comments, and "Done" closes the player.
      el('div', { class: 'cp-head' }, cpTitle, cpCount),
      el('div', { class: 'cp-opts' },
        cpToggle('Hide resolved', 'Leave out threads that have been resolved', hideDone, (v) => {
          hideDone = v;
          store('wb:hidedone', v);
          renderPanel();
        })),
      cpList, cpFoot, cpGrip);

    function setPanelWidth(w, keep = true) {
      if (w != null) w = Math.round(clamp(w, 260, 720));
      if (w == null) document.body.style.removeProperty('--cpw');
      else document.body.style.setProperty('--cpw', `${w}px`);
      if (keep) store('wb:cpw', w);
      relayout();
    }
    if (Number.isFinite(store('wb:cpw'))) setPanelWidth(store('wb:cpw'), false);
    dragEdge(cpGrip, (x) => setPanelWidth(panel.getBoundingClientRect().right - x, false), () => setPanelWidth(panel.offsetWidth));
    cpGrip.addEventListener('dblclick', () => setPanelWidth(null));

    const panelShown = () => can.read() && (narrow() ? sheetOpen : viewerPanel);
    function togglePanel(showIt = !panelShown()) {
      if (narrow()) sheetOpen = showIt;
      else {
        viewerPanel = showIt;
        store('wb:cpanel', showIt);
      }
      const fitted = !zoomed();
      renderPanel();
      layout();
      if (fitted) fit();
      else applyCam();
    }

    function syncComposer() {
      const video = videoOpen();
      const strokes = draft && open && draft.on === open.id ? draft.strokes.length : 0;
      momentChip.hidden = !video;
      if (video) {
        const held = strokes && draft.at != null;
        momentChip.classList.toggle('off', !timed);
        momentChip.title = !timed ? 'The comment is about the whole video. Click to tie it to the frame showing'
          : held ? 'The comment is about the frame that was drawn on. Click to make it about the whole video'
            : 'The comment is about the frame showing. Click to make it about the whole video';
        momentChip.lastChild.textContent = fmtMoment(held ? momentOf(draft) : whereOf(video), fpsOf(open.id));
      }
      drawnChip.hidden = !strokes;
      drawnChip.children[1].textContent = strokes > 1 ? `Drawing · ${strokes}` : 'Drawing';
      composer.placeholder = strokes ? 'Say what the drawing is about…' : 'Leave a comment…';
      cpCompose.classList.toggle('drafting', strokes > 0);
      cpPen.hidden = !can.draw();
      cpBrush.hidden = !can.draw() || (tool !== 'pen' && tool !== 'eraser');
    }

    function messageNode(c, root0, mentions) {
      const first = c === root0;
      const mine = (m) => m.name === me().name;
      const member = can.member();
      const canDelete = member && mine(c) && (!first || repliesOf(c.id).every(mine));
      const editing = c.id === editingId;
      const text = editing
        ? el('div', { class: 'msg-edit' }, editBox, el('div', { class: 'msg-edit-acts' },
          el('button', { class: 'btn small ghost', text: 'Cancel', title: 'Keep it as it was (Esc)', onclick: () => endEdit(false) }),
          el('button', { class: 'btn small primary', text: 'Save', title: 'Save (Enter)', onclick: () => endEdit(true) })))
        : el('div', { class: 'msg-text' });
      const moment = first && open.type === 'video' ? momentOf(c) : null;
      if (!editing) {
        fillText(text, c.text);
        markMentions(text, mentions);
        // The frame it is about leads the text, as in Frame.io, so the line above keeps room for the name.
        if (moment != null) text.prepend(el('button', { class: 'tchip', title: 'Go to this frame', onclick: () => pickThread(c.id) }, el('span', { html: ICON.play }), fmtMoment(moment, fpsOf(c.on))));
      }
      return el('div', { class: `msg${first ? '' : ' reply'}` },
        WB.avatar(c.name, c.color),
        el('div', { class: 'msg-main' },
          el('div', { class: 'msg-top' },
            el('strong', { text: c.name }),
            c.guest && el('span', { class: 'notice-guest', text: 'Guest', title: 'Written by somebody holding a link, under a name they typed' }),
            el('span', { class: 'msg-time', text: WB.ago(c.t), title: new Date(c.t).toLocaleString() }),
            c.edited && el('span', { class: 'msg-edited', text: 'edited', title: `Edited ${new Date(c.edited).toLocaleString()}` }),
            el('span', { class: 'msg-acts' },
              member && mine(c) && !editing && el('button', { class: 'iconbtn mini', html: ICON.pen, title: 'Edit', onclick: () => startEdit(c) }),
              first && member && el('button', {
                class: `iconbtn mini${c.done ? ' active' : ''}`, html: ICON.check, title: c.done ? 'Resolved. Click to open it again' : 'Mark as resolved',
                onclick: () => opts.set(c.id, { done: !c.done }),
              }),
              canDelete && el('button', { class: 'iconbtn mini', html: ICON.trash, title: first ? 'Delete the thread, and what was drawn for it' : 'Delete', onclick: () => removeComment(c) }))),
          text,
          first && Array.isArray(c.drawing) && el('span', { class: 'msg-drawn', title: c.pov ? 'Has a drawing, made in 3D through the main camera. Pick the thread to see it' : 'Has a drawing on the picture. Pick the thread to see it' }, el('span', { html: ICON.scribble }), c.pov ? 'Drawing in 3D' : 'Drawing')));
    }

    function threadCard(c, mentions) {
      const active = activeThread === c.id;
      return el('div', {
        class: `cp-card${active ? ' active' : ''}${c.done ? ' done' : ''}`, 'data-id': c.id,
        onclick: (e) => { if (!e.target.closest('button, a, textarea')) pickThread(c.id); },
      },
      messageNode(c, c, mentions),
      repliesOf(c.id).map((r) => messageNode(r, c, mentions)),
      active && can.write() && el('div', { class: 'cp-reply' }, replyBox, el('button', { class: 'btn small', text: 'Reply', onclick: submitReply })));
    }

    function renderPanel() {
      if (!open) return;
      const shown = panelShown();
      panel.hidden = !shown;
      document.body.classList.toggle('cp-open', shown);
      cpTab.hidden = !can.read();
      cpTab.title = `${shown ? 'Hide' : 'Show'} the comments (Shift+C)`;
      cpTab.setAttribute('aria-expanded', String(shown));
      cpTabIcon.innerHTML = shown ? ICON.next : ICON.comment;
      let list = roots().filter((c) => c.on === open.id);
      const openN = list.filter((c) => !c.done).length;
      cpTabCount.hidden = !openN;
      cpTabCount.textContent = String(openN);
      if (!shown) return;
      const any = list.length > 0;
      if (hideDone) list = list.filter((c) => !c.done);
      if (open.type === 'video') list.sort((a, b) => (momentOf(a) ?? -1) - (momentOf(b) ?? -1) || byTime(a, b));
      cpCount.hidden = !openN;
      cpCount.textContent = String(openN);
      const empty = any ? [ICON.check, 'All resolved'] : [ICON.comment, 'No comments yet'];
      const held = [replyBox, editBox].find((box) => document.activeElement === box);
      const typing = held && [held.selectionStart, held.selectionEnd];
      const top = cpList.scrollTop;
      const mentions = mentionPattern();
      cpList.replaceChildren(...(list.length ? list.map((c) => threadCard(c, mentions)) : [el('p', { class: 'cp-empty' }, el('span', { html: empty[0] }), el('span', { text: empty[1] }))]));
      cpList.scrollTop = top;
      if (typing && held.isConnected) {
        held.focus({ preventScroll: true });
        held.setSelectionRange(typing[0], typing[1]);
      }
      const foot = can.write() ? cpCompose : null;
      if (cpFoot.firstChild !== foot) cpFoot.replaceChildren(...(foot ? [foot] : []));
      cpFoot.hidden = !foot;
      if (foot) buildInks();
      syncComposer();
    }

    function revealCard(id) {
      const card = [...cpList.children].find((node) => node.dataset.id === id);
      if (card) card.scrollIntoView({ block: 'nearest' });
    }

    function afterThread() {
      if (opts.onThread) opts.onThread(activeThread);
      renderPanel();
      paintMarks();
      paintInk();
    }

    // Picks a thread: its card is raised and, on a video, the film goes to its frame, where what was drawn for it shows.
    function pickThread(id) {
      const c = noteById(id);
      const rootNote = c && (c.re ? noteById(c.re) : c);
      if (!rootNote) return;
      if (rootNote.on !== open.id) return void show(rootNote.on, { thread: rootNote.id });
      // Its drawing is seen in the view it was drawn in: in 3D through the main camera, or on the picture.
      if (Array.isArray(rootNote.drawing)) {
        if (rootNote.pov === 'main' && has3d()) {
          if (!in3d) set3d(true).then(() => paintInk());
          else backToMain();
        } else if (!rootNote.pov && in3d) set3d(false);
      }
      if (activeThread !== rootNote.id) replyBox.value = '';
      activeThread = rootNote.id;
      calling = { id: rootNote.id, until: performance.now() + 4000 };
      seek(momentOf(rootNote));
      if (!panelShown()) togglePanel(true);
      afterThread();
      revealCard(rootNote.id);
    }

    // A new thread on what is open. With something drawn for it, it is the comment the drawing was
    // waiting for, about the frame that was drawn on; otherwise it is about the frame showing.
    function submitComment() {
      const text = composer.value.trim();
      if (!text || !open || !can.write()) return;
      const drawn = draft && draft.on === open.id && draft.strokes.length ? draft : null;
      const c = { id: drawn ? drawn.id : uid(), type: 'comment', text: text.slice(0, 2000), name: me().name, color: me().color, t: Date.now(), done: false, on: open.id };
      if (drawn) {
        if (drawn.at != null) c.at = drawn.at;
        if (drawn.fr != null) c.fr = drawn.fr;
        c.drawing = drawn.strokes;
        if (drawn.pov) c.pov = drawn.pov;
      } else {
        stampMoment(c);
      }
      composer.value = '';
      autosize(composer);
      typed.delete(open.id);
      composer.blur();
      draft = null;
      unstroked.length = 0;
      activeThread = c.id;
      replyBox.value = '';
      opts.add(c);
      if (drawn) seek(momentOf(c));
      if (tool === 'pen' || tool === 'eraser') setTool('pan');
      revealCard(c.id);
    }

    function submitReply() {
      const rootNote = noteById(activeThread);
      const text = replyBox.value.trim();
      if (!rootNote || !text || !can.write()) return;
      replyBox.value = '';
      autosize(replyBox);
      replyBox.blur();
      opts.add({ id: uid(), type: 'comment', text: text.slice(0, 2000), name: me().name, color: me().color, t: Date.now(), done: false, re: rootNote.id, on: rootNote.on });
      revealCard(rootNote.id);
    }

    // A thread goes with its replies, and with what was drawn for it.
    function removeComment(c) {
      opts.remove(c.re ? [c.id] : [c.id, ...repliesOf(c.id).map((r) => r.id)]);
    }

    // C: to the comment box.
    function startComment() {
      if (!open || !can.write()) return;
      if (!panelShown()) togglePanel(true);
      composer.focus({ preventScroll: true });
    }

    function typeComment(text) {
      if (!open || !can.write()) return;
      if (!panelShown()) togglePanel(true);
      composer.focus({ preventScroll: true });
      composer.setRangeText(text.slice(0, 2000), composer.selectionStart, composer.selectionEnd, 'end');
      autosize(composer);
    }

    // ---- keys
    //
    // In the viewer each key means one thing: the arrows go to the next or previous piece, `,` and `.` step
    // a frame (with Shift, a second), Space or K plays and pauses, M is the sound. Keys the viewer has no
    // use for are left to the page.
    const { isTyping } = WB;
    // Space plays even when a control clicked a moment ago (a dropdown in the bar, a button or a link in the
    // page's sidebar beside a docked player) still has the keyboard: it lets go, and the player takes the key.
    // Only somewhere text is typed, a dialog or a menu keeps Space.
    const heldControl = (t) => t instanceof Element && t.matches('select, button, a[href], input[type="checkbox"], input[type="radio"], input[type="range"]')
      && !t.closest('dialog, .wb-menu, .notices, [role="menu"], [role="dialog"]');
    window.addEventListener('keydown', (e) => {
      let released = false;
      if (open && e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && heldControl(e.target) && !document.querySelector('dialog[open]')
        && (root.contains(e.target) || root.classList.contains('docked'))) {
        e.target.blur();
        released = true;
      }
      if (!open || (!released && isTyping(e.target)) || document.querySelector('dialog[open]')) return;
      // Docked beside the page's own sidebar and bar, what has the keyboard there keeps its keys.
      if (!released && root.classList.contains('docked') && e.target instanceof Element && e.target !== document.body && !root.contains(e.target)) return;
      const k = e.key.toLowerCase();
      // In 3D, W A S D Q E fly (unless a pen is in hand) and V goes back to the main camera.
      if (in3d && three && tool !== 'pen' && tool !== 'eraser' && three.key(e, true)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        paintDims();
        paintInk();
        return;
      }
      if (in3d && three && k === 'v' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return void backToMain();
      }
      // Enter works a button that has the keyboard; Space always plays and pauses, even when a button
      // clicked a moment ago still has it.
      if (k === 'enter' && e.target.closest && e.target.closest('button, a[href], input')) return;
      // A button clicked a moment ago still has the keyboard, and a key press makes the browser ring it in
      // blue. A key the player takes is the player's, so the button lets go of it.
      const done = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const held = document.activeElement;
        if (held && held !== document.body && root.contains(held) && held.matches('button, a[href]')) held.blur();
      };
      if (e.code === 'Space') {
        if (!spaceDown) {
          spaceTap = true;
          spaceAt = performance.now();
        }
        spaceDown = true;
        root.classList.add('space-held');
        return done();
      }
      const altGr = e.ctrlKey && e.altKey;
      if ((e.ctrlKey || e.metaKey) && !altGr) {
        if (k === 'z' && can.draw()) e.shiftKey ? redo() : undo();
        else if (k === 'y' && can.draw()) redo();
        else if (k === '0') zoomAt(innerWidth / 2, innerHeight / 2, actualS() / cam.s);
        else if (k === 'a') { /* nothing to select in here */ }
        else return;
        return done();
      }
      if (e.altKey && !altGr) return;
      if (k.startsWith('arrow')) {
        step(k === 'arrowright' || k === 'arrowdown' ? 1 : -1);
        return done();
      }
      if ((e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) || k === 'home') fit();
      else if (k === 'escape') {
        if (tool !== 'pan') setTool('pan');
        else close();
      } else if (k === 'f' && e.shiftKey) toggleFilm();
      else if (k === 'c' && e.shiftKey) { if (can.read()) togglePanel(); }
      else if (k === 'c' && !e.shiftKey) startComment();
      else if ((videoOpen() || runMode()) && (k === 'k' || k === 'enter')) togglePlay();
      else if (videoOpen() && e.code === 'Comma') stepFrame(-1, e.shiftKey);
      else if (videoOpen() && e.code === 'Period') stepFrame(1, e.shiftKey);
      else if (videoOpen() && k === 'm') toggleSound();
      else if (k === 'l' && !e.shiftKey) setTool(tool === 'laser' ? 'pan' : 'laser');
      else if (k === 'e' && !e.shiftKey && can.draw()) setTool(tool === 'eraser' ? 'pen' : 'eraser');
      else if (k === 'p' && !e.shiftKey && can.draw()) setTool(tool === 'pen' || tool === 'eraser' ? 'pan' : 'pen');
      else if (k === 'h' && !e.shiftKey) setTool('pan');
      else if (k === 'delete' || k === 'backspace' || k === 'v' || k === 'n' || k === 't' || k === 'b' || k === 'f' || k === 'a' || k === 's') { /* the board's, not the viewer's */ }
      else return;
      done();
    }, true);
    window.addEventListener('keyup', (e) => {
      if (e.code !== 'Space' || !spaceDown) return;
      e.preventDefault();
      const tapped = spaceTap && performance.now() - spaceAt < 400;
      spaceDown = false;
      spaceTap = false;
      root.classList.remove('space-held');
      if (open && tapped && (videoOpen() || runMode())) togglePlay();
    }, true);
    window.addEventListener('blur', () => {
      spaceDown = false;
      root.classList.remove('space-held');
    });
    // Text pasted while a piece is open is on its way into a comment.
    window.addEventListener('paste', (e) => {
      if (!open || isTyping(e.target)) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text || text.startsWith('{"wipboard"')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      typeComment(text.trim());
    }, true);

    setTool('pan');

    return {
      open: show,
      close,
      use(next) {
        close();
        setHost(next);
        paintDims();
        root.classList.toggle('run', runMode());
        root.classList.toggle('docked', !!next.dock);
      },
      host: () => opts,
      refresh,
      isOpen: () => !!open,
      current: () => (open ? open.id : null),
      extras,
      startComment,
      typeComment,
      // Where a comment was left: what it is on opens, on the comment's frame, with its thread picked.
      openComment(id) {
        readHost();
        const c = notes.find((n) => n.id === id);
        const rootNote = c && (c.re ? notes.find((n) => n.id === c.re) : c);
        if (!rootNote) return false;
        if (!open || open.id !== rootNote.on) show(rootNote.on);
        if (open && open.id === rootNote.on) pickThread(rootNote.id);
        return true;
      },
      // What the person followed is doing: their piece, their moment, their thread.
      follow(id, { thread } = {}) {
        if (id && pieces.concat(opts.media() || []).some((p) => p.id === id)) {
          if (!open || open.id !== id) show(id, { followed: true });
        } else if (open) {
          close();
        }
        if (open && thread !== undefined) {
          const c = typeof thread === 'string' ? noteById(thread) : null;
          const next = c && !c.re && c.on === open.id ? c.id : null;
          if (next !== activeThread) {
            activeThread = next;
            renderPanel();
            paintMarks();
            paintInk();
            if (next) revealCard(next);
          }
        }
      },
      followMedia(id, playing, time) {
        const video = open && open.id === id ? videoOpen() : null;
        if (!video) return;
        if (Math.abs(whereOf(video) - time) > (playing ? 0.25 : 0.001)) goTo(video, time);
        if (playing) video.play().catch(() => {});
        else video.pause();
      },
      laser(key, color, id, flat) {
        if (!open || open.id !== id || !Array.isArray(flat)) return;
        const n = flat.length / 2;
        const now = performance.now();
        for (let i = 0; i < n; i++) addLaser(key, color, { x: flat[i * 2], y: flat[i * 2 + 1] }, now - (n - 1 - i) * (25 / n));
      },
      togglePanel,
      thread: () => activeThread,
      // Where the open video is, for whoever follows from now on.
      moment() {
        const video = videoOpen();
        return video ? [open.id, Math.round(whereOf(video) * 1000) / 1000, video.paused ? 0 : 1] : null;
      },
    };
  }

  // ---------------------------------------------------------------- a version's views
  //
  // A version may be shown more than one way: the unwrapped picture (cmp, vr) and how it looks projected
  // (bty, or bty-left, top, side...), each its own file. Its look is the main one, with the others in
  // `views`. Most have none, and then nothing here is ever seen.
  const MEDIA_KEYS = ['type', 'src', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name'];
  // Its views' names, the main one first ('' when the main one has none).
  const viewsOf = (look) => [look.view || '', ...(look.views || []).map((v) => v.view)];
  // The look of a version as seen in `view`: that view's file, or the main one's when it has none of that
  // name. `shownView` says which it is.
  function inView(look, view) {
    const { views, ...main } = look;
    const pick = view && view !== main.view && (views || []).find((v) => v.view === view);
    if (!pick) return { ...main, shownView: main.view || '', viewNames: viewsOf(look) };
    const out = { ...main };
    for (const k of MEDIA_KEYS) delete out[k];
    return { ...out, ...pick, name: pick.name || main.name, shownView: pick.view, viewNames: viewsOf(look) };
  }
  const viewLabel = (name) => name || 'Main';
  // The picker for which view: a dropdown for the bar, of `names`, at `value`.
  function viewPicker(names, value, onPick) {
    const sel = el('select', { class: 'v-pick v-viewpick', 'aria-label': 'Which view', title: 'Which view of each version to show' },
      names.map((n) => el('option', { value: n, text: viewLabel(n), ...(n === value && { selected: true }) })));
    sel.addEventListener('change', () => onPick(sel.value));
    return sel;
  }

  // ---------------------------------------------------------------- an asset, set or shot's versions
  //
  // Opens the versions of one entity of a project's catalogue in a player, at `version` (or the newest).
  // What is said about them is live: everyone who has the entity open, here or on any board a version is
  // on, sees it as it is written, and what is written here is there on those boards.
  // An entity's room: the live notes on its versions. `onNotes(list)` hears every change; `send(ops)`
  // adds, changes and deletes them; `close()` leaves.
  function entityRoom(entityId, me, onNotes) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let ws = null;
    let closed = false;
    let again = 0;
    let wait = 1500;
    const outbox = [];
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(`${proto}://${location.host}/ws?entity=${encodeURIComponent(entityId)}`);
      ws.addEventListener('open', () => {
        wait = 1500;
        ws.send(JSON.stringify({ t: 'hello', name: me.name, color: me.color }));
        for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
      });
      ws.addEventListener('message', (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'init' || msg.t === 'notes') onNotes(msg.notes);
      });
      // Dropped: tried again, waiting longer each time (up to half a minute), never once closed.
      ws.addEventListener('close', () => {
        if (closed) return;
        again = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 30000);
      });
    };
    connect();
    return {
      send(ops) {
        const msg = { t: 'op', ops };
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
        else outbox.push(msg);
      },
      close() {
        closed = true;
        clearTimeout(again);
        if (ws) ws.close();
      },
    };
  }

  // What a host whose notes live in entity rooms does with them: shown at once here, and the room says
  // what it came to.
  // `getRoom(pieceId)` is the room of the piece a new comment is on.
  function roomNotes(viewer, getRoom, getNotes, setNotes) {
    return {
      add: (c) => {
        const room = getRoom(c.on);
        setNotes([...getNotes(), c]);
        viewer.refresh();
        room?.send([{ t: 'add', item: c }]);
      },
      set: (id, patch) => {
        setNotes(getNotes().map((n) => (n.id === id ? { ...n, ...patch } : n)));
        viewer.refresh();
        getRoom()?.send([{ t: 'set', id, patch }]);
      },
      remove: async (ids) => {
        const sure = await WB.dialog({ title: 'Delete it?', text: 'It goes for everyone, on every board the version is on.', ok: 'Delete', danger: true });
        if (!sure) return;
        setNotes(getNotes().filter((n) => !ids.includes(n.id)));
        viewer.refresh();
        getRoom()?.send([{ t: 'del', ids }]);
      },
      download: (p) => {
        const a = el('a', { href: p.orig || p.src, download: (p.name || p.label || 'media').replace(/\.[^.]+$/, '') + (/\.[a-z0-9]+$/i.exec(p.orig || p.src)?.[0] || '') });
        document.body.append(a);
        a.click();
        a.remove();
      },
    };
  }

  // ---------------------------------------------------------------- an asset, set or shot's versions
  //
  // Opens the versions of one entity of a project's catalogue in a player, at `version` (or the newest).
  // What is said about them is live: everyone who has the entity open, here or on any board a version is
  // on, sees it as it is written, and what is written here is there on those boards.
  // `title` is where the entity is (its project), for the bar; `dock` keeps a page's own bar and sidebar.
  async function openEntity(viewer, entityId, { version = null, me, title = null, dock = false, onClose = () => {} } = {}) {
    const page = await WB.api('GET', `/api/entities/${entityId}`);
    const versions = page.versions.filter((v) => !v.hidden || v.id === version);
    if (!versions.length) throw new Error('There is nothing filed under it yet');
    // Oldest first, so the arrows go forward in time; the newest of each task last.
    versions.sort((a, b) => (a.task || '').localeCompare(b.task || '') || a.number - b.number);
    // Each in the view last chosen in this project, where it has that view.
    const viewKey = `wb:view:${page.entity.projectId}`;
    let view = WB.store(viewKey) || '';
    const piecesIn = (name) => versions.map((v) => {
      const look = inView(v.look, name);
      return { ...look, id: v.id, type: look.type || v.kind, label: v.label, name: look.name || v.originalName };
    });
    // In 3D, each is shown in the view the project puts on its model (its main one unless the project says).
    const preview3d = page.project && page.project.settings && page.project.settings.preview3d;
    let in3d = false;
    let pieces = piecesIn(view);
    // A version shown more than one way has the way to choose in the bar; one shown one way, nothing.
    const showPicker = (id) => {
      const p = pieces.find((x) => x.id === id);
      const names = p ? p.viewNames : [];
      viewer.extras.replaceChildren(...(names.length > 1 ? [viewPicker(names, p.shownView, (name) => {
        view = name;
        WB.store(viewKey, name);
        pieces = piecesIn(in3d ? preview3d.view : view);
        viewer.refresh();
      })] : []));
    };
    const shape = (list) => list.map((n) => (n.type === 'comment' ? n : { ...n, type: 'comment', on: n.versionId, obn: n.board && n.board.id ? n.board.name : 'the catalogue' }));
    let notes = shape(page.notes);
    const room = entityRoom(entityId, me, (list) => {
      notes = list;
      viewer.refresh();
    });
    viewer.use({
      me: () => me,
      dock,
      title: () => (title ? `${title} · ${page.entity.name}` : page.entity.name),
      media: () => pieces,
      notes: () => notes,
      can: { member: () => true },
      ...roomNotes(viewer, () => room, () => notes, (next) => { notes = next; }),
      ...(preview3d && preview3d.model && {
        view3d: { ...preview3d, key: page.entity.projectId },
        onMode3d: (on) => {
          in3d = on;
          pieces = piecesIn(on ? preview3d.view : view);
          viewer.refresh();
        },
      }),
      onOpen: showPicker,
      onClose: () => {
        room.close();
        viewer.extras.replaceChildren();
        onClose();
      },
    });
    viewer.open(version && pieces.some((p) => p.id === version) ? version : pieces[pieces.length - 1].id);
  }

  // ---------------------------------------------------------------- a project's shots, played through
  //
  // Opens the shots of a project in a player as an edit: the newest version of each (of `task`, or of
  // any), in order, sequence by sequence, played one into the next. What is said is about the shot under
  // the playhead, live, through its room. A shot with nothing filed may come as a slate (`empty`): it is
  // seen and held like a still, and nothing is written or drawn on it, as it has no version to be on.
  async function openRun(viewer, { load, me, title, choices, dock = false, view3d = null, onMode3d = null, onClose = () => {} }) {
    let pieces = await load();
    if (!pieces.length) throw new Error('There are no shots to play yet');
    const onSlate = () => !!(pieces.find((x) => x.id === viewer.current()) || {}).empty;
    let notes = [];
    let room = null;
    let roomOf = null;
    let joinTimer = 0;
    const join = (entityId) => {
      clearTimeout(joinTimer);
      if (entityId === roomOf) return;
      if (room) room.close();
      roomOf = entityId;
      notes = [];
      room = entityRoom(entityId, me, (list) => {
        notes = list;
        viewer.refresh();
      });
    };
    // The room follows the shot on screen; a beat later, so playing through does not hop every room.
    // Coming back to the shot whose room is open before that beat is up stays in it.
    const follow = (id) => {
      const p = pieces.find((x) => x.id === id);
      clearTimeout(joinTimer);
      if (!p || p.entityId === roomOf) return;
      joinTimer = setTimeout(() => join(p.entityId), roomOf ? 400 : 0);
    };
    // A comment goes to the room of the shot it is on, joined there and then if the beat is not up yet.
    const roomFor = (pieceId) => {
      const p = pieces.find((x) => x.id === pieceId);
      if (p && p.entityId !== roomOf) join(p.entityId);
      return room;
    };
    viewer.use({
      run: true,
      dock,
      me: () => me,
      title,
      media: () => pieces,
      notes: () => notes,
      can: { member: () => true, write: () => !onSlate(), draw: () => !onSlate() },
      ...roomNotes(viewer, (pieceId) => (pieceId ? roomFor(pieceId) : room), () => notes, (next) => { notes = next; }),
      onOpen: follow,
      ...(view3d && { view3d, onMode3d }),
      onClose: () => {
        clearTimeout(joinTimer);
        if (room) room.close();
        viewer.extras.replaceChildren();
        onClose();
      },
    });
    // The run's own choices go in the bar: which sequence, which task. A new choice starts it again.
    // A choice that only changes how the shots are seen (`keep`: which view) stays where the run is.
    if (choices) {
      viewer.extras.replaceChildren(...choices(async ({ keep = false } = {}) => {
        const next = await load();
        if (!next.length) return void WB.dialog({ title: 'Nothing to play', text: 'No shot there has anything filed yet.', ok: 'OK', cancellable: false });
        const at = viewer.current();
        pieces = next;
        if (keep && pieces.some((p) => p.id === at)) viewer.refresh();
        else viewer.open(pieces[0].id);
      }));
    }
    viewer.open(pieces[0].id);
  }

  return {
    create, openEntity, openRun, entityRoom, inView, viewPicker, ICON, INK, inkColor, pathData, outlinePath, strokeNode, fmtTime, fmtMoment, timeLabel, cycleTimeMode,
    frameTime, frameIndex, lastFrame, goTo, whereOf, changing, switchSource, fetchWhole, releaseWhole, showWave,
    timeMode: () => timeMode,
  };
})();
