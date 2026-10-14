'use strict';

// The close-up track of a run, under the whole-run track, as on the cut page of an editor: the playhead
// stays in the middle and the shots go by under it as a strip of their frames, so a cut is seen coming
// and a moment can be found to the frame. Dragging it moves the run under the playhead; a click goes
// to where it was clicked; the wheel moves along it (with Ctrl or Cmd, or a pinch, it zooms), and the
// buttons in its corner zoom too. The zoom is remembered.
//
// Frames are taken from the shots themselves, here in the browser, as they come into view: the nearest
// to the playhead first, one at a time, from a copy of the video kept on this computer when there is one
// (media.js). Until a frame is in, its place has the colour the shot has there (its timeline strip),
// or its still. Loaded after common.js; used by viewer.js.
const WBCutTrack = (() => {
  const { el, clamp } = WB;
  const ZOOM_KEY = 'wb:cut:zoom';
  const ZOOM_MIN = 4; // px a second: about four minutes across a laptop's screen
  const ZOOM_MAX = 800; // a frame of 24 fps is 33 px
  const FRAME_W = 160; // a frame taken is this wide
  const KEEP = 500; // frames held, the least lately drawn going first
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  // ---- frames taken from videos, shared by every track on the page

  const frames = new Map(); // key -> canvas, in the order last drawn
  const failed = new Set(); // srcs that could not be read
  const colours = new WeakMap(); // wf -> bytes
  const images = new Map(); // src -> <img>
  let grabber = null;
  let wanted = [];
  let busy = false;
  const listeners = new Set();

  const frameKey = (src, at) => `${src}@${at.toFixed(3)}`;
  const take = (key) => {
    const f = frames.get(key);
    if (f) {
      frames.delete(key);
      frames.set(key, f);
    }
    return f;
  };
  const keep = (key, canvas) => {
    frames.set(key, canvas);
    while (frames.size > KEEP) frames.delete(frames.keys().next().value);
  };
  const told = () => { for (const f of listeners) f(); };

  const once = (target, type, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('timeout')); }, ms);
    const ok = () => { done(); resolve(); };
    const bad = () => { done(); reject(new Error('error')); };
    const done = () => {
      clearTimeout(timer);
      target.removeEventListener(type, ok);
      target.removeEventListener('error', bad);
    };
    target.addEventListener(type, ok);
    target.addEventListener('error', bad);
  });

  async function grab({ key, src, at }) {
    if (!grabber) grabber = Object.assign(document.createElement('video'), { muted: true, preload: 'auto', playsInline: true });
    const v = grabber;
    if (v.dataset.src !== src) {
      v.dataset.src = src;
      v.src = src;
      await once(v, 'loadeddata', 15000);
    }
    const to = clamp(at, 0, Math.max(0, (v.duration || at) - 0.04));
    if (Math.abs(v.currentTime - to) > 0.001) {
      v.currentTime = to;
      await once(v, 'seeked', 8000);
    }
    const w = FRAME_W;
    const h = Math.max(1, Math.round((w * (v.videoHeight || 9)) / (v.videoWidth || 16)));
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    keep(key, canvas);
  }

  async function pump() {
    if (busy) return;
    const next = wanted.find((x) => !frames.has(x.key) && !failed.has(x.src));
    if (!next) return;
    busy = true;
    try {
      await grab(next);
    } catch {
      // A file that cannot be read is not asked again; its places keep their colours.
      failed.add(next.src);
      if (grabber) {
        grabber.removeAttribute('src');
        delete grabber.dataset.src;
        grabber.load();
      }
    }
    busy = false;
    told();
    pump();
  }

  // Lets go of the video frames are taken from, when no track is left to want them.
  function idle() {
    wanted = [];
    if (!grabber) return;
    grabber.removeAttribute('src');
    grabber.load();
    grabber = null;
  }

  function imageOf(src) {
    let img = images.get(src);
    if (!img) {
      img = new Image();
      img.decoding = 'async';
      img.onload = told;
      img.src = src;
      images.set(src, img);
      if (images.size > 300) images.delete(images.keys().next().value);
    }
    return img.complete && img.naturalWidth ? img : null;
  }

  // What a shot's strip says its picture is at a moment of it, top and bottom: [r, g, b, r, g, b].
  function colourAt(piece, k) {
    const wf = piece.wf;
    if (!wf || !wf.c) return null;
    let bytes = colours.get(wf);
    if (!bytes) {
      try {
        bytes = fromB64(wf.c);
      } catch {
        bytes = new Uint8Array(0);
      }
      colours.set(wf, bytes);
    }
    const cols = Math.floor(bytes.length / 6);
    if (!cols) return null;
    const i = clamp(Math.floor(k * cols), 0, cols - 1) * 6;
    return bytes.subarray(i, i + 6);
  }

  // ---- one track

  // `onGrab()` when a hand takes hold of it (the run stops while it is moved), `onSeek(t)` to move the
  // run to a moment, `onRelease()` when it lets go.
  function create({ onGrab, onSeek, onRelease }) {
    const canvas = el('canvas', { class: 'cut-canvas' });
    const out = el('button', { type: 'button', class: 'cut-zoom', text: '−', title: 'Zoom out (Ctrl and the wheel)', 'aria-label': 'Zoom out' });
    const inn = el('button', { type: 'button', class: 'cut-zoom', text: '+', title: 'Zoom in (Ctrl and the wheel)', 'aria-label': 'Zoom in' });
    const node = el('div', { class: 'cut', role: 'slider', 'aria-label': 'Close-up of the run: drag to move through it' }, canvas, el('div', { class: 'cut-zooms' }, out, inn));
    let clips = [];
    let total = 0;
    let t = 0;
    let marks = [];
    let pps = clamp(Number(WB.store(ZOOM_KEY)) || 60, ZOOM_MIN, ZOOM_MAX);
    let W = 0;
    let H = 0;
    let dpr = 1;
    let live = false;
    let raf = 0;

    const later = () => {
      if (!raf && live) raf = requestAnimationFrame(() => { raf = 0; draw(); });
    };
    const resize = () => {
      const r = node.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      W = Math.round(r.width);
      H = Math.round(r.height);
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      draw();
    };
    const watch = new ResizeObserver(resize);

    const xOf = (at) => W / 2 + (at - t) * pps;
    const atOf = (x) => t + (x - W / 2) / pps;

    function zoom(k) {
      pps = clamp(pps * k, ZOOM_MIN, ZOOM_MAX);
      WB.store(ZOOM_KEY, Math.round(pps * 100) / 100);
      out.disabled = pps <= ZOOM_MIN;
      inn.disabled = pps >= ZOOM_MAX;
      draw();
    }
    out.addEventListener('click', () => zoom(1 / 1.6));
    inn.addEventListener('click', () => zoom(1.6));

    function draw() {
      if (!live || !W || !H) return;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0c0c0c';
      ctx.fillRect(0, 0, W, H);
      const from = atOf(0);
      const to = atOf(W);
      // Frames along the top, the shot and its version over them.
      const tileH = H;
      const want = [];
      for (const c of clips) {
        if (c.start + c.dur < from || c.start > to) continue;
        const x0 = xOf(c.start);
        const x1 = xOf(c.start + c.dur);
        const p = c.piece;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, H);
        ctx.clip();
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x0, 0, x1 - x0, H);
        if (p.empty) {
          // Nothing filed: a slate's stripes.
          ctx.strokeStyle = '#242424';
          ctx.lineWidth = 6;
          for (let x = Math.floor(Math.max(x0, 0) / 14) * 14 - H; x < Math.min(x1, W) + H; x += 14) {
            ctx.beginPath();
            ctx.moveTo(x, H);
            ctx.lineTo(x + H, 0);
            ctx.stroke();
          }
        } else {
          const aspect = p.nw && p.nh ? p.nw / p.nh : 16 / 9;
          // Seconds a frame stands for: a power of two, so the frames taken are the same ones at
          // nearby zooms. Its place is as wide as that is, about its picture's own shape.
          const span = Math.max(1 / 32, 2 ** Math.round(Math.log2((tileH * aspect) / pps)));
          const tileW = span * pps;
          const first = Math.max(0, Math.floor((from - c.start) / span));
          const last = Math.min(Math.ceil(c.dur / span), Math.ceil((to - c.start) / span));
          const still = p.type === 'video' ? null : imageOf(p.prev || p.src);
          const poster = p.type === 'video' && (p.poster || p.th) ? imageOf(p.th || p.poster) : null;
          for (let k = first; k < last; k++) {
            const local = k * span;
            const x = x0 + k * tileW;
            let pic = still;
            if (p.type === 'video') {
              // The frame at the start of its place, to the nearest 24th of a second.
              const at = Math.round(Math.min(local, Math.max(0, c.dur - 0.04)) * 24) / 24;
              const key = frameKey(p.src, at);
              pic = take(key);
              if (!pic && !failed.has(p.src)) want.push({ key, src: p.src, at, d: Math.abs(c.start + local - t) });
              if (!pic) {
                const rgb = colourAt(p, local / c.dur);
                if (rgb) {
                  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                  ctx.fillRect(x, 0, tileW, H / 2);
                  ctx.fillStyle = `rgb(${rgb[3]},${rgb[4]},${rgb[5]})`;
                  ctx.fillRect(x, H / 2, tileW, H - H / 2);
                } else if (poster) pic = poster;
              }
            }
            if (pic) drawCover(ctx, pic, x, 0, tileW, H);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.fillRect(x + tileW - 1, 0, 1, H);
          }
        }
        // Its name, held at the left of the track while the rest of it is still going by.
        const name = c.piece.name || '';
        const ver = c.piece.empty ? 'nothing filed' : versionOf(c.piece);
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const nw = ctx.measureText(name).width;
        ctx.font = '400 11px Inter, system-ui, sans-serif';
        const vw = ver ? ctx.measureText(ver).width + 6 : 0;
        const boxW = nw + vw + 12;
        const bx = clamp(Math.max(x0, 0) + 4, x0 + 4, x1 - boxW - 4);
        if (x1 - x0 > boxW + 8) {
          ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
          roundRect(ctx, bx, 4, boxW, 18, 4);
          ctx.fillStyle = '#f2f2f2';
          ctx.font = '600 11px Inter, system-ui, sans-serif';
          ctx.fillText(name, bx + 6, 17);
          if (ver) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '400 11px Inter, system-ui, sans-serif';
            ctx.fillText(ver, bx + 6 + nw + 6, 17);
          }
        }
        ctx.restore();
        // The cut: a line at the end of each shot, and a brighter one where a sequence begins.
        ctx.fillStyle = '#000';
        ctx.fillRect(Math.round(x1) - 1, 0, 2, H);
        if (c.seqStart) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
          ctx.fillRect(Math.round(x0), 0, 2, H);
          const label = String(c.piece.seq || '').toUpperCase();
          ctx.font = '700 9.5px Inter, system-ui, sans-serif';
          const lw = ctx.measureText(label).width + 8;
          if (x1 - x0 > lw + 8) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            roundRect(ctx, Math.round(x0) + 4, H - 18, lw, 14, 3);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, Math.round(x0) + 8, H - 7.5);
          }
        }
      }
      // Before the first shot and after the last: nothing.
      if (from < 0) {
        ctx.fillStyle = '#070707';
        ctx.fillRect(0, 0, xOf(0), H);
      }
      if (to > total) {
        ctx.fillStyle = '#070707';
        ctx.fillRect(xOf(total), 0, W - xOf(total), H);
      }
      // Comments, in their writers' colours, along the top.
      for (const m of marks) {
        if (m.at < from || m.at > to) continue;
        const x = xOf(m.at);
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(x - 5, 0);
        ctx.lineTo(x + 5, 0);
        ctx.lineTo(x, 7);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(x - 0.75, 0, 1.5, H);
      }
      // The playhead, which stays where it is: white edged with black, to be seen on any picture.
      const px = Math.round(W / 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(px - 2, 0, 4, H);
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 1, 0, 2, H);
      ctx.fillStyle = '#ff5a4f';
      ctx.beginPath();
      ctx.moveTo(W / 2 - 6, 0);
      ctx.lineTo(W / 2 + 6, 0);
      ctx.lineTo(W / 2, 8);
      ctx.closePath();
      ctx.fill();
      // The nearest frames first; what has gone by is not taken.
      want.sort((a, b) => a.d - b.d);
      wanted = want;
      pump();
    }

    // Holding on and moving it: the run goes with the hand, and stops while it does.
    let hold = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !clips.length) return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture is a nicety
      }
      hold = { pid: e.pointerId, x: e.clientX, t, moved: false };
      node.classList.add('held');
      onGrab();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!hold || e.pointerId !== hold.pid) return;
      const dx = e.clientX - hold.x;
      if (!hold.moved && Math.abs(dx) < 3) return;
      hold.moved = true;
      onSeek(clamp(hold.t - dx / pps, 0, total));
    });
    const letGo = (e) => {
      if (!hold || e.pointerId !== hold.pid) return;
      // A click without moving goes to the moment clicked.
      if (!hold.moved && e.type === 'pointerup') {
        const r = canvas.getBoundingClientRect();
        onSeek(clamp(atOf(e.clientX - r.left), 0, total));
      }
      hold = null;
      node.classList.remove('held');
      onRelease();
    };
    canvas.addEventListener('pointerup', letGo);
    canvas.addEventListener('pointercancel', letGo);

    // The wheel moves along it, or with Ctrl or Cmd (and a pinch, which browsers send as that) zooms.
    let wheeling = 0;
    node.addEventListener('wheel', (e) => {
      if (!clips.length) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? W : 1;
      if (e.ctrlKey || e.metaKey) return void zoom(Math.exp(-e.deltaY * px * 0.004));
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * px;
      if (!wheeling) onGrab();
      clearTimeout(wheeling);
      wheeling = setTimeout(() => { wheeling = 0; onRelease(); }, 250);
      onSeek(clamp(t + d / pps, 0, total));
    }, { passive: false });

    zoom(1);
    return {
      node,
      // The shots, as viewer.js lays the run out: [{ id, start, dur, piece }].
      setClips(list, length) {
        let seq = null;
        clips = list.map((c) => {
          const seqStart = !!c.piece.seq && c.piece.seq !== seq;
          seq = c.piece.seq;
          return { ...c, seqStart };
        });
        total = length;
        later();
      },
      // Where the run is: drawn at once, as this comes with each frame shown.
      setTime(at) {
        t = at;
        if (live) {
          cancelAnimationFrame(raf);
          raf = 0;
          draw();
        }
      },
      setMarks(list) {
        marks = list;
        later();
      },
      // Drawn and taking frames only while it is shown.
      show(on) {
        if (on === live) return;
        live = on;
        if (on) {
          listeners.add(later);
          watch.observe(node);
          resize();
        } else {
          listeners.delete(later);
          watch.disconnect();
          cancelAnimationFrame(raf);
          raf = 0;
          if (!listeners.size) idle();
        }
      },
    };
  }

  // A picture filling a place, cut to its shape from the middle.
  function drawCover(ctx, pic, x, y, w, h) {
    const pw = pic.naturalWidth || pic.width;
    const ph = pic.naturalHeight || pic.height;
    if (!pw || !ph) return;
    const k = Math.max(w / pw, h / ph);
    const sw = w / k;
    const sh = h / k;
    ctx.drawImage(pic, (pw - sw) / 2, (ph - sh) / 2, sw, sh, x, y, w, h);
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }
  // "anim v3" from a version's label "kilo-0010 anim v3".
  const versionOf = (p) => (p.label && p.name && p.label.startsWith(p.name) ? p.label.slice(p.name.length).trim() : '');

  return { create };
})();
