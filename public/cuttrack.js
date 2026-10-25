'use strict';

// The close-up track of a run, under the whole-run track, as on the cut page of an editor: the playhead
// stays in the middle and the shots go by under it as a strip of their frames, so a cut is seen coming
// and a moment can be found to the frame. Dragging it moves the run under the playhead; a click goes
// to where it was clicked; the wheel moves along it. It is always at the same scale, whatever the length
// of the run: a few seconds each side of the playhead. It can be drawn out to show up to three times as
// much (the buttons in its corner, or the wheel with Ctrl or Cmd), and that too is so many pixels a second,
// never a share of the run. Along its top each shot has a plain band with its name and version, so the
// frames under it are never written over, and every cut is a gap down the whole height.
//
// Frames are taken from the shots themselves, here in the browser, as they come into view: the nearest
// to the playhead first, one at a time, from a copy of the video kept on this computer when there is one
// (media.js). Until a frame is in, its place has the colour the shot has there (its timeline strip),
// or its still. Loaded after common.js; used by viewer.js, and its frames by an animatic's track too
// (animatic.js, through `frames`).
const WBCutTrack = (() => {
  const { el, clamp } = WB;
  const PPS = 60; // px a second, close in: some fourteen seconds across a laptop's screen, six across a phone's
  const ZOOMS = [1, 1.5, 2, 3]; // how far it can be drawn out: up to three times as much in the same width
  const HEAD = 19; // the band along the top with each shot's name
  const GAP = 3; // the cut between two shots
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
    let zoom = ZOOMS.includes(WB.store('wb:cutzoom')) ? WB.store('wb:cutzoom') : 1;
    let pps = PPS / zoom;
    const zoomOut = el('button', { type: 'button', class: 'cut-zbtn', text: '−', title: 'Show more of the run (Ctrl + wheel)', 'aria-label': 'Show more of the run', onclick: () => setZoom(1) });
    const zoomIn = el('button', { type: 'button', class: 'cut-zbtn', text: '+', title: 'Show less of the run, closer (Ctrl + wheel)', 'aria-label': 'Show less of the run, closer', onclick: () => setZoom(-1) });
    const zoomLabel = el('span', { class: 'cut-zlabel' });
    const zoomBox = el('span', { class: 'cut-zoom' }, zoomOut, zoomLabel, zoomIn);
    // A click on the zoom buttons is theirs, not a move along the track.
    zoomBox.addEventListener('pointerdown', (e) => e.stopPropagation());
    const node = el('div', { class: 'cut', role: 'slider', 'aria-label': 'Close-up of the run: drag to move through it' }, canvas, zoomBox);
    let clips = [];
    let total = 0;
    let t = 0;
    let marks = [];
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

    // One step further out (+1) or in (-1), kept for the next time.
    function setZoom(dir) {
      const i = clamp(ZOOMS.indexOf(zoom) + dir, 0, ZOOMS.length - 1);
      zoom = ZOOMS[i];
      pps = PPS / zoom;
      WB.store('wb:cutzoom', zoom);
      paintZoom();
      draw();
    }
    function paintZoom() {
      zoomOut.disabled = zoom === ZOOMS[ZOOMS.length - 1];
      zoomIn.disabled = zoom === ZOOMS[0];
      zoomLabel.textContent = `${zoom}×`;
      zoomBox.title = `Showing ${zoom === 1 ? 'the closest view' : `${zoom} times as much as close in`}`;
    }
    paintZoom();

    function draw() {
      if (!live || !W || !H) return;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0c0c0c';
      ctx.fillRect(0, 0, W, H);
      const from = atOf(0);
      const to = atOf(W);
      // Each shot: a band along the top with its name, and its frames under the band.
      const tileY = HEAD + 1;
      const tileH = H - tileY;
      const want = [];
      const at = clips.find((c) => t >= c.start && t < c.start + c.dur) || clips[clips.length - 1];
      clips.forEach((c, i) => {
        if (c.start + c.dur < from || c.start > to) return;
        // The cut is a gap: each shot is drawn short of the next by it.
        const x0 = xOf(c.start) + (i ? GAP / 2 : 0);
        const x1 = xOf(c.start + c.dur) - (i < clips.length - 1 ? GAP / 2 : 0);
        if (x1 <= x0) return;
        const p = c.piece;
        const here = c === at;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, x1 - x0, H);
        ctx.clip();
        // The band: shots shaded in turn, so neighbours never run together, and the one at the playhead
        // light, in ink, as the tool in hand is.
        ctx.fillStyle = here ? '#e6e6e6' : i % 2 ? '#2b2b2b' : '#333';
        ctx.fillRect(x0, 0, x1 - x0, HEAD);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(x0, tileY, x1 - x0, tileH);
        if (p.empty) {
          // Nothing filed: a slate's stripes.
          ctx.strokeStyle = '#242424';
          ctx.lineWidth = 6;
          for (let x = Math.floor(Math.max(x0, 0) / 14) * 14 - tileH; x < Math.min(x1, W) + tileH; x += 14) {
            ctx.beginPath();
            ctx.moveTo(x, H);
            ctx.lineTo(x + tileH, tileY);
            ctx.stroke();
          }
        } else {
          const aspect = p.nw && p.nh ? p.nw / p.nh : 16 / 9;
          // A frame in its picture's own shape, standing for the seconds that wide a place is.
          const tileW = tileH * aspect;
          const span = tileW / pps;
          const sx = xOf(c.start);
          const first = Math.max(0, Math.floor((from - c.start) / span));
          const last = Math.min(Math.ceil(c.dur / span), Math.ceil((to - c.start) / span));
          const still = p.type === 'video' ? null : imageOf(p.prev || p.src);
          const poster = p.type === 'video' && (p.poster || p.th) ? imageOf(p.th || p.poster) : null;
          for (let k = first; k < last; k++) {
            const local = k * span;
            const x = sx + k * tileW;
            let pic = still;
            if (p.type === 'video') {
              // The frame at the start of its place, to the nearest 24th of a second.
              const fat = Math.round(Math.min(local, Math.max(0, c.dur - 0.04)) * 24) / 24;
              const key = frameKey(p.src, fat);
              pic = take(key);
              if (!pic && !failed.has(p.src)) want.push({ key, src: p.src, at: fat, d: Math.abs(c.start + local - t) });
              if (!pic) {
                const rgb = colourAt(p, local / c.dur);
                if (rgb) {
                  ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                  ctx.fillRect(x, tileY, tileW, tileH / 2);
                  ctx.fillStyle = `rgb(${rgb[3]},${rgb[4]},${rgb[5]})`;
                  ctx.fillRect(x, tileY + tileH / 2, tileW, tileH - tileH / 2);
                } else if (poster) pic = poster;
              }
            }
            if (pic) drawCover(ctx, pic, x, tileY, tileW, tileH);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
            ctx.fillRect(x + tileW - 1, tileY, 1, tileH);
          }
        }
        // In the band: where a sequence begins, its name; then the shot's, and its version. Held at the left
        // of the track while the rest of the shot is still going by.
        const seq = c.seqStart ? String(p.seq || '') : '';
        const name = p.name || '';
        const ver = p.empty ? 'nothing filed' : versionOf(p);
        ctx.font = '600 10px Inter, system-ui, sans-serif';
        const sw = seq ? ctx.measureText(seq).width + 8 : 0;
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        const nw = ctx.measureText(name).width;
        ctx.font = '400 11px Inter, system-ui, sans-serif';
        const vw = ver ? ctx.measureText(ver).width + 6 : 0;
        const textW = (sw ? sw + 6 : 0) + nw + vw;
        let tx = clamp(Math.max(x0, 0) + 6, x0 + 6, Math.max(x0 + 6, x1 - textW - 6));
        const ink = here ? '#111' : '#f2f2f2';
        const quiet = here ? 'rgba(0, 0, 0, 0.6)' : 'rgba(255, 255, 255, 0.6)';
        const baseline = HEAD / 2 + 4;
        if (seq) {
          ctx.fillStyle = here ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.9)';
          roundRect(ctx, tx, 3, sw, HEAD - 6, 3);
          ctx.fillStyle = '#111';
          ctx.font = '600 10px Inter, system-ui, sans-serif';
          ctx.fillText(seq, tx + 4, baseline - 0.5);
          tx += sw + 6;
        }
        ctx.fillStyle = ink;
        ctx.font = '600 11px Inter, system-ui, sans-serif';
        ctx.fillText(name, tx, baseline);
        if (ver) {
          ctx.fillStyle = quiet;
          ctx.font = '400 11px Inter, system-ui, sans-serif';
          ctx.fillText(ver, tx + nw + 6, baseline);
        }
        ctx.restore();
        // A sequence begins: a bright line down the cut before it.
        if (c.seqStart && i) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.fillRect(Math.round(xOf(c.start)) - 1, 0, 2, H);
        }
      });
      // Before the first shot and after the last: nothing.
      if (from < 0) {
        ctx.fillStyle = '#070707';
        ctx.fillRect(0, 0, xOf(0), H);
      }
      if (to > total) {
        ctx.fillStyle = '#070707';
        ctx.fillRect(xOf(total), 0, W - xOf(total), H);
      }
      // Comments, in their writers' colours, down the frames.
      for (const m of marks) {
        if (m.at < from || m.at > to) continue;
        const x = xOf(m.at);
        ctx.fillStyle = m.color;
        ctx.beginPath();
        ctx.moveTo(x - 5, tileY);
        ctx.lineTo(x + 5, tileY);
        ctx.lineTo(x, tileY + 7);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(x - 0.75, tileY, 1.5, tileH);
      }
      // The playhead, which stays where it is: white edged with black, to be seen on any picture, its head in
      // the accent, as every playhead's is.
      const px = Math.round(W / 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
      ctx.fillRect(px - 2, 0, 4, H);
      ctx.fillStyle = '#fff';
      ctx.fillRect(px - 1, 0, 2, H);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#5ba0fa';
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

    // The wheel moves along it; with Ctrl or Cmd (or a pinch) it draws the track in or out.
    let wheeling = 0;
    let zoomWheel = 0;
    node.addEventListener('wheel', (e) => {
      if (!clips.length) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // A pinch comes as many small steps: they add up to one zoom step at a time.
        zoomWheel += e.deltaY;
        if (Math.abs(zoomWheel) >= 40) {
          setZoom(zoomWheel > 0 ? 1 : -1);
          zoomWheel = 0;
        }
        return;
      }
      const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? W : 1;
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * px;
      if (!wheeling) onGrab();
      clearTimeout(wheeling);
      wheeling = setTimeout(() => { wheeling = 0; onRelease(); }, 250);
      onSeek(clamp(t + d / pps, 0, total));
    }, { passive: false });

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

  // The frames, for an animatic's track: `take(key)` what is in (`key(src, at)` names one), `ask(list)` for
  // those wanted, nearest first, in place of any asked before ({ key, src, at }), and `listen(fn)` to hear as
  // more come in (it gives back how to stop listening). A page shows one of the two kinds of track at a time.
  const shared = {
    key: frameKey,
    take,
    ask(list) {
      wanted = list;
      pump();
    },
    listen(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        if (!listeners.size) idle();
      };
    },
    colourAt,
    imageOf,
    drawCover,
  };

  return { create, frames: shared };
})();
