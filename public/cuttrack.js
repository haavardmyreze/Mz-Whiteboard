'use strict';

// The frames an animatic's track is drawn with (animatic.js, through `frames`), taken from the shots
// themselves, here in the browser, as they come into view: the nearest to the playhead first, one at a
// time, from a copy of the video kept on this computer when there is one (media.js). Until a frame is in,
// its place has the colour the shot has there (its timeline strip), or its still. Loaded after common.js.
const WBCutTrack = (() => {
  const { clamp } = WB;
  const FRAME_W = 160; // a frame taken is this wide
  const KEEP = 500; // frames held, the least lately drawn going first
  const fromB64 = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

  // ---- frames taken from videos

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

  // The frames, for an animatic's track: `take(key)` what is in (`key(src, at)` names one), `ask(list)` for
  // those wanted, nearest first, in place of any asked before ({ key, src, at }), and `listen(fn)` to hear as
  // more come in (it gives back how to stop listening).
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

  return { frames: shared };
})();
