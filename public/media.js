'use strict';

// Videos kept on this computer, for every page: a board, the catalogue, the timeline and Home.
//
// Over the internet the wait is for a video to arrive, and it is longest just when it is opened. So what
// is likely to be opened next is fetched ahead, quietly, one at a time, and kept on this machine's disk
// (the browser's Cache Storage); opening it then finds it here, this time and every time after. A file's
// address is made from what is in it, so a copy kept here can never be out of date.
//
//   get(src)              a video, whole: from the disk if it is kept, else fetched (and kept). What is
//                         opened never waits: what was being fetched ahead gives way to it.
//   want(key, srcs, opt)  what a page would like kept, in order; each page (key) says it again as it
//                         changes. opt.rank orders the lists (lower first), opt.kind is what the
//                         settings call it (boards, work, cc, pinned; others are always on), and
//                         opt.hold keeps them from being made room for while they are wanted.
//
// What is kept is listed in IndexedDB, one record a video, so pages in several tabs never write over
// each other's list; a lock for each address keeps two tabs from fetching the same one. Up to MAX is
// kept, and what was wanted longest ago makes room, never what a page is holding. A service worker
// (sw.js) answers the page's own <video> elements from the kept copies too, scrubbing included.
//
// Where the browser has nowhere to keep things (a plain http address that is not this machine), or has
// been asked to save data, nothing is fetched ahead and everything plays from the server as before.
(function () {
  const CACHE = 'wb-media-1';
  const MAX = 4 * 1024 * 1024 * 1024;  // kept across everything
  const ITEM_MAX = 400 * 1024 * 1024;   // larger than this stays on the server
  const KINDS = ['boards', 'work', 'cc', 'pinned'];
  const usable = 'caches' in window && 'indexedDB' in window && window.isSecureContext !== false;

  const store = (key, value) => {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage blocked: the choice lasts as long as the page
    }
    return undefined;
  };

  // ---- the list of what is kept (IndexedDB 'wb-media', store 'kept': { src, size, used })
  const index = new Map();
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('wb-media', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kept', { keyPath: 'src' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('kept', mode);
      const out = fn(tx.objectStore('kept'));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async function loadIndex() {
    const rows = await idb('readonly', (s) => s.getAll());
    index.clear();
    for (const r of rows || []) index.set(r.src, r);
  }
  const putRow = (row) => idb('readwrite', (s) => s.put(row)).catch(() => {});
  const delRow = (src) => idb('readwrite', (s) => s.delete(src)).catch(() => {});

  // Other tabs say when they have kept or let go of something.
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('wb-media') : null;
  const tellOthers = () => channel && channel.postMessage('changed');
  if (channel) channel.onmessage = () => loadIndex().then(changed, () => {});

  let cachep = null;
  const cache = () => {
    if (!cachep) cachep = usable ? caches.open(CACHE).catch(() => null) : Promise.resolve(null);
    return cachep;
  };

  const ready = (async () => {
    if (!usable) return false;
    try {
      await loadIndex();
      // What the boards kept before this list was in IndexedDB.
      const old = store('wb:kept');
      if (old && typeof old === 'object') {
        for (const [src, k] of Object.entries(old)) {
          if (!Array.isArray(k) || index.has(src)) continue;
          const row = { src, size: k[0] || 0, used: k[1] || Date.now() };
          index.set(src, row);
          await putRow(row);
        }
        try { localStorage.removeItem('wb:kept'); } catch { /* left as it is */ }
      }
      return !!(await cache());
    } catch {
      return false;
    }
  })();
  let available = false;
  ready.then((ok) => { available = ok; changed(); });

  // ---- listeners: a board's ring, the settings
  const listeners = new Set();
  let paintQueued = false;
  function changed() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      for (const fn of listeners) {
        try { fn(); } catch { /* one listener's trouble is its own */ }
      }
    });
  }

  // ---- settings, this browser's
  const ahead = () => store('wb:noahead') !== true;
  const kinds = () => ({ boards: true, work: true, cc: true, pinned: true, ...(store('wb:media:kinds') || {}) });
  const saveData = () => !!(navigator.connection && navigator.connection.saveData);

  // ---- keeping, and making room
  const wants = new Map(); // key -> { srcs, rank, kind, hold }
  const held = () => {
    const out = new Set();
    for (const w of wants.values()) if (w.hold) for (const s of w.srcs) out.add(s);
    return out;
  };
  const total = () => {
    let n = 0;
    for (const r of index.values()) n += r.size || 0;
    return n;
  };
  let full = false;

  async function makeRoom(size, keepSrc) {
    const keep = held();
    let used = total();
    if (used + size <= MAX) return true;
    const c = await cache();
    for (const r of [...index.values()].sort((a, b) => a.used - b.used)) {
      if (used + size <= MAX) break;
      if (keep.has(r.src) || r.src === keepSrc) continue;
      await c.delete(r.src).catch(() => {});
      index.delete(r.src);
      await delRow(r.src);
      used -= r.size || 0;
    }
    return used + size <= MAX;
  }

  let persisted = false;
  async function keep(src, blob) {
    const c = await cache();
    if (!c || !(await makeRoom(blob.size, src))) {
      full = true;
      changed();
      return false;
    }
    try {
      await c.put(src, new Response(blob, { headers: { 'Content-Type': blob.type || 'video/mp4', 'Content-Length': String(blob.size) } }));
    } catch {
      // No room after all, or no leave to keep things here.
      full = true;
      changed();
      return false;
    }
    const row = { src, size: blob.size, used: Date.now() };
    index.set(src, row);
    await putRow(row);
    tellOthers();
    changed();
    // Asked once: kept things should not be the first the browser throws out when it wants room.
    if (!persisted && navigator.storage && navigator.storage.persist) {
      persisted = true;
      navigator.storage.persist().catch(() => {});
    }
    return true;
  }

  function touch(src) {
    const row = index.get(src);
    if (!row || Date.now() - row.used < 60000) return;
    row.used = Date.now();
    putRow(row);
  }

  // Fetches a video whole, with how far it has come, into a Blob.
  async function download(src, signal, onProgress) {
    const res = await fetch(src, { signal });
    const size = Number(res.headers.get('content-length')) || 0;
    if (!res.ok || !res.body || !size || size > ITEM_MAX) throw Object.assign(new Error('not one to keep'), { keepable: false });
    const reader = res.body.getReader();
    const pieces = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(value);
      loaded += value.length;
      if (onProgress) onProgress(loaded, size);
    }
    return new Blob(pieces, { type: res.headers.get('content-type') || 'video/mp4' });
  }

  const withLock = (src, fn) => (navigator.locks ? navigator.locks.request(`wb-media:${src}`, fn) : fn());

  // ---- opening: what is opened has the line to itself
  const opening = new Map(); // src -> { loaded, total }
  let current = null;        // what is being fetched ahead: { src, ctl, done, loaded, total }
  const failed = new Set();

  async function get(src, { signal, onProgress } = {}) {
    await ready;
    const c = await cache();
    const hit = c ? await c.match(src).catch(() => null) : null;
    if (hit) {
      const blob = await hit.blob();
      if (!index.has(src)) {
        // Kept by another tab before this one heard.
        index.set(src, { src, size: blob.size, used: Date.now() });
        putRow(index.get(src));
      }
      touch(src);
      if (onProgress) onProgress(blob.size, blob.size);
      return blob;
    }
    // On its way in ahead already: that is the copy to wait for. Anything else ahead gives way.
    if (current && current.src === src) {
      await current.done;
      if (index.has(src)) return get(src, { signal, onProgress });
    } else if (current) current.ctl.abort();
    const state = { loaded: 0, total: 0 };
    opening.set(src, state);
    changed();
    try {
      const blob = await download(src, signal, (loaded, size) => {
        state.loaded = loaded;
        state.total = size;
        if (onProgress) onProgress(loaded, size);
        changed();
      });
      if (c && /^\/uploads\//.test(src)) keep(src, blob);
      return blob;
    } finally {
      opening.delete(src);
      changed();
      schedule();
    }
  }

  // ---- fetching ahead
  const RANK = { run: 1, timeline: 1.5, board: 2, page: 3, work: 4, cc: 5, pinned: 6 };
  function want(key, srcs, { rank = 5, kind = null, hold = false } = {}) {
    const list = [...new Set((srcs || []).filter((s) => typeof s === 'string' && /^\/uploads\//.test(s)))];
    const was = wants.get(key);
    if (was && was.rank === rank && was.kind === kind && was.hold === hold && was.srcs.join('\n') === list.join('\n')) return;
    if (!list.length) wants.delete(key);
    else wants.set(key, { srcs: list, rank, kind, hold });
    changed();
    schedule();
  }

  function paused() {
    if (!available) return 'unavailable';
    if (!ahead()) return 'off';
    if (saveData()) return 'data';
    if (full) return 'full';
    return null;
  }

  function nextWanted() {
    const on = kinds();
    for (const w of [...wants.values()].sort((a, b) => a.rank - b.rank)) {
      if (w.kind && on[w.kind] === false) continue;
      for (const src of w.srcs) if (!index.has(src) && !failed.has(src) && !opening.has(src)) return src;
    }
    return null;
  }

  let timer = 0;
  let running = false;
  function schedule(ms = 1500) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }
  async function run() {
    if (running || !(await ready) || paused()) return;
    running = true;
    try {
      for (;;) {
        while (opening.size) await new Promise((resolve) => setTimeout(resolve, 400));
        if (paused()) break;
        const src = nextWanted();
        if (!src) break;
        const ctl = new AbortController();
        const job = (current = { src, ctl, loaded: 0, total: 0 });
        changed();
        job.done = withLock(src, async () => {
          const c = await cache();
          // Kept by another tab while this one waited for the lock.
          const hit = await c.match(src).catch(() => null);
          if (hit) {
            await loadIndex();
            if (!index.has(src)) {
              const row = { src, size: Number(hit.headers.get('content-length')) || 0, used: Date.now() };
              index.set(src, row);
              await putRow(row);
            }
            return;
          }
          const blob = await download(src, ctl.signal, (loaded, size) => {
            job.loaded = loaded;
            job.total = size;
            changed();
          });
          await keep(src, blob);
        }).catch(() => {
          // Given up for something that was opened, it is tried again; anything else is left alone.
          if (!ctl.signal.aborted) failed.add(src);
        });
        await job.done;
        if (current === job) current = null;
        changed();
      }
    } finally {
      running = false;
      current = null;
      changed();
    }
  }

  // ---- what the settings show
  async function stats() {
    await ready;
    let bytes = 0;
    for (const r of index.values()) bytes += r.size || 0;
    return { count: index.size, bytes, last: Math.max(0, ...[...index.values()].map((r) => r.used || 0)) };
  }

  async function clear() {
    try {
      if ('caches' in window) await caches.delete(CACHE);
    } catch {
      // nothing kept, or no leave to say so
    }
    cachep = null;
    index.clear();
    failed.clear();
    full = false;
    await idb('readwrite', (s) => s.clear()).catch(() => {});
    try { localStorage.removeItem('wb:kept'); } catch { /* nothing there */ }
    tellOthers();
    changed();
  }

  // Changing the settings starts or stops what is fetched ahead.
  function setAhead(on) {
    store('wb:noahead', !on);
    full = false;
    changed();
    schedule(0);
  }
  function setKind(kind, on) {
    store('wb:media:kinds', { ...kinds(), [kind]: !!on });
    changed();
    schedule(0);
  }

  // The service worker that answers <video> elements from what is kept.
  if (usable && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // ---- showing it: the ring in a page's bar, and the badge on a card
  //
  // ring(button, scope): the button fills as what the page is about is cached, with a count beside it,
  // and turns to a tick and "Cached" once all of it is; pressed, it opens a little card with the details.
  // scope() says what the page is about: { label: 'this board', items: [{ src, name }] }, or null.
  const SVG = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    check: SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    pause: SVG('<path d="M7 4v16M17 4v16" stroke-width="3.5"/>'),
    cloud: SVG('<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z"/>'),
    kept: SVG('<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>'),
  };
  const RING = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="7"/><circle class="arc" cx="10" cy="10" r="7"/><path class="tick" d="M6.6 10.3l2.3 2.3 4.6-5"/></svg><span class="kept-label"></span>';
  const sizeLabel = (bytes) => {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    const mb = bytes / 1048576;
    return `${mb >= 10 || !bytes ? Math.round(mb).toLocaleString() : mb.toFixed(1)} MB`;
  };
  const keepable = (src) => typeof src === 'string' && /^\/uploads\//.test(src);
  // How far a video has come: 1 kept, a fraction on its way (ahead, or opened), 0 not here.
  function progressOf(src) {
    if (index.has(src)) return 1;
    if (current && current.src === src && current.total) return current.loaded / current.total;
    const o = opening.get(src);
    return o && o.total ? o.loaded / o.total : 0;
  }
  const coming = (src) => !index.has(src) && ((current && current.src === src) || opening.has(src));

  function ring(button, scope) {
    const el = WB.el;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    button.classList.add('kept-ring');
    if (!button.querySelector('.arc')) button.innerHTML = RING;
    button.type = 'button';
    const R = 2 * Math.PI * 7;
    button.querySelector('.arc').style.strokeDasharray = R;
    const pop = el('div', { class: 'menu kept-pop', role: 'dialog', 'aria-label': 'Video cache', hidden: true });
    document.body.append(pop);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => toggle());
    function toggle(show = pop.hidden) {
      show = show && !button.hidden;
      pop.hidden = !show;
      button.classList.toggle('active', show);
      button.setAttribute('aria-expanded', String(show));
      if (!show) return;
      paintPop();
      place();
    }
    function place() {
      const r = button.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      pop.style.left = `${clamp(r.right - pop.offsetWidth, 8, innerWidth - pop.offsetWidth - 8)}px`;
    }
    document.addEventListener('pointerdown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !button.contains(e.target)) toggle(false);
    }, true);
    window.addEventListener('resize', () => { if (!pop.hidden) place(); });

    // What the scope is about, as this cache sees it.
    function measure() {
      const sc = scope() || { label: '', items: [] };
      const items = (sc.items || []).filter((it) => it && it.src);
      const all = [...new Set(items.map((it) => it.src))];
      const srcs = all.filter((src) => keepable(src) && !failed.has(src));
      const here = srcs.filter((src) => index.has(src));
      const nameOf = (src) => (items.find((it) => it.src === src) || {}).name || 'A video';
      return { label: sc.label || 'this page', srcs, here, remote: all.length - srcs.length, nameOf };
    }

    function paintPop() {
      const m = measure();
      const hereBytes = m.here.reduce((sum, src) => sum + ((index.get(src) || {}).size || 0), 0);
      const allBytes = total();
      const list = m.srcs.filter(coming).map((src) => [src, progressOf(src)]);
      const k = m.srcs.length ? m.here.length / m.srcs.length : 0;
      const C = 2 * Math.PI * 17;
      const big = el('span', { class: `kp-ring${k >= 1 ? ' full' : ''}`, html: `<svg viewBox="0 0 40 40" aria-hidden="true"><circle class="track" cx="20" cy="20" r="17"/><circle class="arc" cx="20" cy="20" r="17" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - k)}"/></svg>` },
        k >= 1 ? el('span', { class: 'kp-in', html: ICON.check }) : el('b', { class: 'kp-in', text: `${Math.floor(k * 100)}%` }));
      const bar = (frac) => el('i', { class: 'kp-bar' }, el('i', { style: { width: `${clamp(frac, 0, 1) * 100}%` } }));
      pop.replaceChildren(...[
        el('div', { class: 'kp-head' }, big,
          el('div', { class: 'kp-title' }, el('b', { text: `${m.here.length} of ${m.srcs.length} ${m.srcs.length === 1 ? 'video' : 'videos'}` }), el('span', { text: `cached from ${m.label}` })),
          el('b', { class: 'kp-size', text: sizeLabel(hereBytes) })),
        paused() && m.here.length < m.srcs.length && el('div', { class: 'kp-warn', title: 'Turned off in your settings, the disk is full, or the browser is saving data' }, el('span', { html: ICON.pause }), 'Paused'),
        list.length > 0 && el('div', { class: 'kp-list' }, list.map(([src, f]) => el('div', { class: 'kp-item' },
          el('span', { class: 'kp-name', text: m.nameOf(src) }), el('span', { class: 'kp-pct', text: `${Math.floor(f * 100)}%` }), bar(f)))),
        m.remote > 0 && el('div', { class: 'kp-line', title: 'Too large to cache, or could not be cached' },
          el('span', { class: 'kp-ic', html: ICON.cloud }), el('span', { text: `${m.remote} from the server` })),
        el('div', { class: 'kp-total' },
          el('div', { class: 'kp-line' }, el('span', { class: 'kp-ic', html: ICON.kept }), el('span', { text: 'Everything cached' }),
            el('span', { class: 'kp-of', text: `${sizeLabel(allBytes)} / ${sizeLabel(MAX)}` })),
          bar(allBytes / MAX)),
      ].filter(Boolean));
    }

    function paint() {
      const m = measure();
      const n = m.srcs.length;
      button.hidden = !available || !n;
      if (button.hidden) {
        if (!pop.hidden) toggle(false);
        return;
      }
      const done = m.here.length;
      // What is on its way counts for as much of itself as has arrived.
      let part = 0;
      for (const src of m.srcs) if (coming(src)) part += progressOf(src);
      const k = clamp((done + part) / n, 0, 1);
      const full = done >= n;
      const videos = n === 1 ? 'video' : 'videos';
      button.querySelector('.arc').style.strokeDashoffset = R * (1 - k);
      button.querySelector('.kept-label').textContent = full ? 'Cached' : `${done}/${n} cached`;
      button.classList.toggle('full', full);
      button.classList.toggle('off', !!paused() && !full);
      const tip = full
        ? `${n === 1 ? 'The video' : `All ${n} videos`} of ${m.label} ${n === 1 ? 'is' : 'are'} cached on this computer, so ${n === 1 ? 'it opens and scrubs' : 'they open and scrub'} instantly`
        : paused()
          ? `${done} of ${n} ${videos} of ${m.label} cached on this computer. Caching has stopped: it is turned off, the disk is full, or the browser is saving data`
          : `Caching the videos of ${m.label} on this computer so they open and scrub instantly: ${done} of ${n} done`;
      if (button.dataset.tip !== tip) {
        button.dataset.tip = tip;
        button.title = tip;
        button.setAttribute('aria-label', tip);
      }
      if (!pop.hidden) paintPop();
    }
    listeners.add(paint);
    paint();
    return { paint, close: () => toggle(false), get open() { return !pop.hidden; } };
  }

  // A card's badge: a tick once its video is cached, a filling ring while it comes, a cloud while it
  // plays from the server. Every badge on the page is kept up to date.
  function badge(src) {
    const node = WB.el('span', { class: 'cache-badge', 'data-src': src, 'aria-hidden': 'true' });
    paintBadge(node);
    return node;
  }
  function paintBadge(node) {
    const src = node.dataset.src;
    const state = !available || !keepable(src) ? 'none' : index.has(src) ? 'cached' : coming(src) ? 'coming' : 'remote';
    node.hidden = state === 'none';
    if (node.dataset.state !== state) {
      node.dataset.state = state;
      node.innerHTML = state === 'cached' ? ICON.check : state === 'remote' ? ICON.cloud : '';
      const tip = state === 'cached' ? 'Cached on this computer: opens and scrubs instantly' : state === 'coming' ? 'Being cached on this computer' : 'Not cached: plays from the server';
      node.title = tip;
    }
    if (state === 'coming') node.style.setProperty('--p', `${Math.round(progressOf(src) * 100)}%`);
  }
  listeners.add(() => {
    for (const node of document.querySelectorAll('.cache-badge[data-src]')) paintBadge(node);
  });

  const api = {
    CACHE, MAX, ITEM_MAX, KINDS, RANK,
    ready,
    get available() { return available; },
    has: (src) => index.has(src),
    sizeOf: (src) => (index.get(src) || {}).size || 0,
    total,
    failed: (src) => failed.has(src),
    keepable,
    status: () => ({ current: current && { src: current.src, loaded: current.loaded, total: current.total }, opening, paused: paused() }),
    ring, badge, sizeLabel,
    get, want, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    stats, clear, ahead, setAhead, kinds, setKind,
  };
  window.WBMedia = api;
  // common.js's WB is a page-wide const, not a property of window.
  if (typeof WB !== 'undefined') WB.media = api;
})();
