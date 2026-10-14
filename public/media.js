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
  const RANK = { run: 1, board: 2, page: 3, work: 4, cc: 5, pinned: 6 };
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

  const api = {
    CACHE, MAX, ITEM_MAX, KINDS, RANK,
    ready,
    get available() { return available; },
    has: (src) => index.has(src),
    sizeOf: (src) => (index.get(src) || {}).size || 0,
    total,
    failed: (src) => failed.has(src),
    keepable: (src) => typeof src === 'string' && /^\/uploads\//.test(src),
    status: () => ({ current: current && { src: current.src, loaded: current.loaded, total: current.total }, opening, paused: paused() }),
    get, want, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    stats, clear, ahead, setAhead, kinds, setKind,
  };
  window.WBMedia = api;
  // common.js's WB is a page-wide const, not a property of window.
  if (typeof WB !== 'undefined') WB.media = api;
})();
