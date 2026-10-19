'use strict';

// Videos kept on this computer, for every page: a board, the catalogue, the timeline and Home.
//
// Over the internet the wait is for a video to arrive, and it is longest just when it is opened. So what
// is likely to be opened next is fetched ahead, quietly, one at a time, and kept on this machine's disk
// (the browser's Cache Storage); opening it then finds it here, this time and every time after. A file's
// address is made from what is in it, so a copy kept here can never be out of date.
//
//   get(src)              a video, whole: from the disk if it is kept, else fetched (and kept). What is
//                         opened never waits: what was being fetched ahead gives way to it. A video
//                         already on its way (ahead, or opened elsewhere on the page) is waited for, not
//                         fetched twice.
//   want(key, srcs, opt)  what a page would like kept, in order; each page (key) says it again as it
//                         changes. opt.rank orders the lists (lower first), opt.kind is what the
//                         settings call it (boards, work, cc, pinned), and opt.hold keeps them from
//                         being made room for while they are wanted, in this tab or any other.
//   whole(src)            a video held whole in memory, as an object URL, for scrubbing without waiting.
//                         Up to WHOLE_HELD is held; the longest unused are let go (onEvict says which).
//
// What is kept is listed in IndexedDB, one record a video, so pages in several tabs never write over
// each other's list; a lock for each address keeps two tabs from fetching the same one, and room is made
// under one lock for all tabs. Up to MAX is kept (less if the browser allows less), and what was wanted
// longest ago makes room, never what a page is holding. A service worker (sw.js) answers the page's own
// <video> elements from the kept copies too, scrubbing included.
//
// Where the browser has nowhere to keep things (a plain http address that is not this machine), or has
// been asked to save data, nothing is fetched ahead and everything plays from the server as before.
(function () {
  const CACHE = 'wb-media-1'; // sw.js reads the same cache: keep the two names together
  const MAX = 4 * 1024 * 1024 * 1024;  // kept across everything
  const ITEM_MAX = 400 * 1024 * 1024;   // larger than this stays on the server
  const WHOLE_HELD = 1024 * 1024 * 1024; // held in memory across videos
  const KINDS = ['boards', 'work', 'cc', 'pinned'];
  const usable = 'caches' in window && 'indexedDB' in window && window.isSecureContext !== false;
  const keepable = (src) => typeof src === 'string' && /^\/uploads\//.test(src);
  const { store, KEYS } = WB;
  const tab = WB.uid();

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

  let cachep = null;
  const cache = () => {
    if (!cachep) cachep = usable ? caches.open(CACHE).catch(() => null) : Promise.resolve(null);
    return cachep;
  };

  // ---- other tabs: what they kept or let go of, that one of them cleared everything, and what each
  // is holding (so no tab makes room by throwing out what another is playing).
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('wb-media') : null;
  const tell = (msg) => channel && channel.postMessage(msg);
  const tellOthers = () => tell({ t: 'changed' });
  const othersHold = new Map(); // tab -> { srcs: Set, at }
  if (channel) {
    channel.onmessage = ({ data }) => {
      const msg = typeof data === 'string' ? { t: data } : data || {};
      if (msg.t === 'cleared') forget();
      else if (msg.t === 'hold') {
        if (msg.srcs.length) othersHold.set(msg.tab, { srcs: new Set(msg.srcs), at: Date.now() });
        else othersHold.delete(msg.tab);
        return;
      } else if (msg.t === 'who') {
        tellHolds();
        return;
      }
      loadIndex().then(changed, () => {});
    };
  }
  function tellHolds() {
    tell({ t: 'hold', tab, srcs: [...held(true)] });
  }
  setInterval(tellHolds, 20000);
  window.addEventListener('pagehide', () => tell({ t: 'hold', tab, srcs: [] }));

  const ready = (async () => {
    if (!usable) return false;
    try {
      await loadIndex();
      tell({ t: 'who' });
      await measureQuota();
      return !!(await cache());
    } catch {
      return false;
    }
  })();
  let available = false;
  ready.then((ok) => { available = ok; changed(); });

  // ---- listeners: a page's ring, the badges, the settings
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
  const ahead = () => store(KEYS.noAhead) !== true;
  const kinds = () => ({ boards: true, work: true, cc: true, pinned: true, ...(store(KEYS.mediaKinds) || {}) });
  const saveData = () => !!(navigator.connection && navigator.connection.saveData);

  // ---- how much may be kept: MAX, or less where the browser gives this site less room
  let limit = MAX;
  async function measureQuota() {
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (!est || !est.quota) return;
      const ours = total();
      const others = Math.max(0, (est.usage || 0) - ours);
      limit = Math.max(0, Math.min(MAX, Math.floor((est.quota - others) * 0.9)));
    } catch {
      // not said: MAX it is
    }
  }

  // ---- keeping, and making room
  const wants = new Map(); // key -> { srcs, rank, kind, hold }
  function held(ownOnly = false) {
    const out = new Set();
    for (const w of wants.values()) if (w.hold) for (const s of w.srcs) out.add(s);
    // Whatever is held whole in memory here is being looked at.
    for (const src of wholes.keys()) out.add(src);
    if (!ownOnly) {
      const now = Date.now();
      for (const [t, h] of othersHold) {
        if (now - h.at > 60000) othersHold.delete(t);
        else for (const s of h.srcs) out.add(s);
      }
    }
    return out;
  }
  const total = () => {
    let n = 0;
    for (const r of index.values()) n += r.size || 0;
    return n;
  };
  // Nothing more fits, even after making room: fetching ahead waits until what is wanted changes.
  let full = false;

  // Room is made under one lock for every tab, from the list as it is now in IndexedDB.
  const roomLock = (fn) => (navigator.locks ? navigator.locks.request('wb-media:room', fn) : fn());
  async function makeRoom(size, keepSrc) {
    return roomLock(async () => {
      await loadIndex().catch(() => {});
      const keep = held();
      let used = total();
      if (used + size <= limit) return true;
      const c = await cache();
      let gone = false;
      for (const r of [...index.values()].sort((a, b) => a.used - b.used)) {
        if (used + size <= limit) break;
        if (keep.has(r.src) || r.src === keepSrc) continue;
        await c.delete(r.src).catch(() => {});
        index.delete(r.src);
        await delRow(r.src);
        used -= r.size || 0;
        gone = true;
      }
      if (gone) tellOthers();
      return used + size <= limit;
    });
  }

  let persisted = false;
  async function keep(src, blob) {
    const c = await cache();
    if (!c || !(await makeRoom(blob.size, src))) {
      full = true;
      changed();
      return false;
    }
    let put = false;
    for (let tries = 0; tries < 2 && !put; tries++) {
      try {
        await c.put(src, new Response(blob, { headers: { 'Content-Type': blob.type || 'video/mp4', 'Content-Length': String(blob.size) } }));
        put = true;
      } catch {
        // The browser has less room than it said: measure again, make room for twice as much, try once more.
        await measureQuota();
        if (tries || !(await makeRoom(blob.size * 2, src))) break;
      }
    }
    if (!put) {
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

  // Wanted again: the last to make room. A video played through the service worker says so too.
  function touch(src) {
    const row = index.get(src);
    if (!row || Date.now() - row.used < 60000) return;
    row.used = Date.now();
    putRow(row);
  }
  if (usable && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.t === 'used' && typeof e.data.src === 'string') touch(e.data.src);
    });
  }

  // A download given up on part of the way (fetching ahead gives way to whatever is opened, which on a
  // slow line, a phone's say, is every shot of a timeline) keeps what it had, and the next one for the same
  // file carries on from there. An uploaded file never changes under its name, so the pieces always fit.
  const partials = new Map(); // src -> { pieces, loaded, size, type }
  const PARTIAL_MAX = 512 * 1024 * 1024;
  function keepPartial(src, part) {
    if (!part.loaded || part.loaded >= part.size) return;
    partials.delete(src);
    partials.set(src, part);
    let sum = 0;
    for (const p of partials.values()) sum += p.loaded;
    for (const [s, p] of partials) {
      if (sum <= PARTIAL_MAX) break;
      partials.delete(s);
      sum -= p.loaded;
    }
  }

  // Fetches a video whole, with how far it has come, into a Blob. `room(size)` is asked once the size is
  // known, before anything is read: no room, and nothing more is fetched.
  async function download(src, signal, onProgress, room) {
    const had = partials.get(src);
    partials.delete(src);
    const res = await fetch(src, { signal, ...(had && { headers: { Range: `bytes=${had.loaded}-` } }) });
    // Carried on from where the last one stopped, or (the server sent it all) from the start.
    const goesOn = !!had && res.status === 206 && new RegExp(`^bytes ${had.loaded}-\\d+/${had.size}$`).test(res.headers.get('content-range') || '');
    const size = goesOn ? had.size : Number(res.headers.get('content-length')) || 0;
    const refuse = (why, permanent) => {
      if (res.body) res.body.cancel().catch(() => {});
      throw Object.assign(new Error(why), { permanent });
    };
    if (!res.ok) refuse(`not there (${res.status})`, res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
    if (!res.body || !size || size > ITEM_MAX) refuse('not one to keep', true);
    if (room && !(await room(size))) refuse('no room', false);
    const reader = res.body.getReader();
    const type = (goesOn && had.type) || res.headers.get('content-type') || 'video/mp4';
    const pieces = goesOn ? had.pieces : [];
    let loaded = goesOn ? had.loaded : 0;
    if (onProgress && loaded) onProgress(loaded, size);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pieces.push(value);
        loaded += value.length;
        if (onProgress) onProgress(loaded, size);
      }
    } catch (err) {
      keepPartial(src, { pieces, loaded, size, type });
      throw err;
    }
    if (loaded !== size) {
      keepPartial(src, { pieces, loaded, size, type });
      throw new Error('cut short');
    }
    return new Blob(pieces, { type });
  }
  // How far a file has come, counting what a download given up on had.
  const partialOf = (src) => (partials.has(src) ? partials.get(src).loaded / partials.get(src).size : 0);

  const withLock = (src, fn) => (navigator.locks ? navigator.locks.request(`wb-media:${src}`, fn) : fn());

  // ---- videos on their way: one fetch each, however many want it (a page that opened it, the fetching
  // ahead). `background` is the one being fetched ahead; the rest were opened.
  const inflight = new Map(); // src -> { src, ctl, loaded, total, background, waiters, promise }
  // Fetched and not kept: for good (not there, too large), or for now (offline), tried again later.
  const failed = new Set();
  const retryAt = new Map(); // src -> when it may be tried again
  window.addEventListener('online', () => {
    retryAt.clear();
    schedule(500);
  });
  const isFailed = (src) => failed.has(src) || (retryAt.has(src) && retryAt.get(src) > Date.now());
  function didFail(src, err) {
    if (err && err.permanent) failed.add(src);
    else {
      const was = retryAt.get(src);
      retryAt.set(src, Date.now() + (was ? 5 * 60000 : 30000));
    }
  }

  function start(src, background) {
    const ctl = new AbortController();
    const job = { src, ctl, loaded: 0, total: 0, background, waiters: 0 };
    job.promise = (async () => {
      try {
        const blob = await download(src, ctl.signal, (loaded, size) => {
          job.loaded = loaded;
          job.total = size;
          changed();
        }, background ? (size) => makeRoom(size, src) : null);
        if (keepable(src)) job.kept = keep(src, blob);
        return blob;
      } finally {
        if (inflight.get(src) === job) inflight.delete(src);
        changed();
        schedule();
      }
    })();
    job.promise.catch(() => {});
    inflight.set(src, job);
    changed();
    return job;
  }
  const backgroundJob = () => [...inflight.values()].find((j) => j.background) || null;
  const anyOpening = () => [...inflight.values()].some((j) => !j.background);

  // Waits for a promise, or for the signal to give up on it.
  const orAbort = (promise, signal) => (!signal ? promise : new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const stop = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  }));

  async function get(src, { signal, onProgress } = {}) {
    await orAbort(ready, signal);
    const c = await cache();
    const hit = c ? await c.match(src).catch(() => null) : null;
    if (hit) {
      const blob = await orAbort(hit.blob(), signal);
      if (!index.has(src)) {
        // Kept by another tab before this one heard.
        index.set(src, { src, size: blob.size, used: Date.now() });
        putRow(index.get(src));
      }
      touch(src);
      if (onProgress) onProgress(blob.size, blob.size);
      return blob;
    }
    // What is opened has the line to itself: anything else being fetched ahead gives way.
    let job = inflight.get(src);
    const bg = backgroundJob();
    if (bg && bg !== job) bg.ctl.abort();
    if (!job) job = start(src, false);
    else job.background = false; // opened now, so it is no longer only ahead
    job.waiters++;
    const tick = setInterval(() => { if (onProgress && job.total) onProgress(job.loaded, job.total); }, 200);
    try {
      return await orAbort(job.promise, signal);
    } finally {
      clearInterval(tick);
      job.waiters--;
      // Nobody wants it any more: let go of the fetch (stepped past before it arrived).
      if (signal && signal.aborted && job.waiters <= 0 && inflight.get(src) === job) job.ctl.abort();
    }
  }

  // ---- fetching ahead
  const RANK = { run: 1, timeline: 1.5, board: 2, page: 3, work: 4, cc: 5, pinned: 6 };
  let clearedQuiet = false; // just cleared: nothing is fetched again until a page says what it wants
  function want(key, srcs, { rank = 5, kind = null, hold = false } = {}) {
    const list = [...new Set((srcs || []).filter(keepable))];
    const was = wants.get(key);
    if (was && was.rank === rank && was.kind === kind && was.hold === hold && was.srcs.join('\n') === list.join('\n')) return;
    if (!list.length) wants.delete(key);
    else wants.set(key, { srcs: list, rank, kind, hold });
    // What is wanted has changed: there may be room for it now.
    full = false;
    clearedQuiet = false;
    if (hold || (was && was.hold)) tellHolds();
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
      for (const src of w.srcs) if (!index.has(src) && !isFailed(src) && !inflight.has(src)) return src;
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
    if (running || !(await ready) || paused() || clearedQuiet) return;
    running = true;
    try {
      for (;;) {
        while (anyOpening()) await new Promise((resolve) => setTimeout(resolve, 400));
        if (paused() || clearedQuiet) break;
        const src = nextWanted();
        if (!src) break;
        await withLock(src, async () => {
          const c = await cache();
          // Kept by another tab while this one waited for the lock.
          const hit = c && await c.match(src).catch(() => null);
          if (hit) {
            await loadIndex();
            if (!index.has(src)) {
              const row = { src, size: Number(hit.headers.get('content-length')) || 0, used: Date.now() };
              index.set(src, row);
              await putRow(row);
            }
            return;
          }
          const job = inflight.get(src) || start(src, true);
          try {
            await job.promise;
            await job.kept;
          } catch (err) {
            // Given up for something that was opened, it is tried again; no room stops the fetching ahead.
            if (job.ctl.signal.aborted) return;
            if (err && err.message === 'no room') full = true;
            else didFail(src, err);
          }
        });
        changed();
      }
    } finally {
      running = false;
      changed();
    }
  }

  // ---- held whole in memory, to scrub through without waiting for any of it
  const wholes = new Map(); // src -> { loaded, total, url, size, used, ctl, ready }
  const evictListeners = new Set();
  function whole(src) {
    let entry = wholes.get(src);
    if (entry) {
      entry.used = performance.now();
      return entry;
    }
    entry = { loaded: 0, total: 0, url: null, size: 0, used: performance.now(), ctl: new AbortController() };
    wholes.set(src, entry);
    entry.ready = (async () => {
      const blob = await get(src, {
        signal: entry.ctl.signal,
        onProgress: (loaded, size) => { entry.loaded = loaded; entry.total = size; },
      });
      // Let go of while it was on its way: no object URL to be forgotten.
      if (entry.ctl.signal.aborted || wholes.get(src) !== entry) throw new Error('not wanted any more');
      entry.size = blob.size;
      entry.loaded = entry.total = blob.size;
      entry.url = URL.createObjectURL(blob);
      trimWholes(src);
      changed();
      return entry.url;
    })().catch(() => {
      entry.ctl.abort();
      if (wholes.get(src) === entry) wholes.delete(src);
      return null;
    });
    return entry;
  }
  // Memory is not for hoarding: the videos opened longest ago go back to playing from where they came.
  function trimWholes(keepSrc) {
    let heldBytes = 0;
    for (const e of wholes.values()) heldBytes += e.size;
    for (const [other, e] of [...wholes].sort((a, b) => a[1].used - b[1].used)) {
      if (heldBytes <= WHOLE_HELD) break;
      if (other === keepSrc || !e.url) continue;
      for (const fn of evictListeners) {
        try { fn(other, e.url); } catch { /* the page's trouble */ }
      }
      URL.revokeObjectURL(e.url);
      wholes.delete(other);
      heldBytes -= e.size;
    }
  }
  // Going on before a video has arrived whole lets go of the fetch, rather than have every video stepped
  // past arrive at once.
  function releaseWhole(src) {
    const entry = wholes.get(src);
    if (!entry || entry.url) return;
    entry.ctl.abort();
    wholes.delete(src);
  }

  // ---- what the settings show
  async function stats() {
    await ready;
    let bytes = 0;
    for (const r of index.values()) bytes += r.size || 0;
    return { count: index.size, bytes, last: Math.max(0, ...[...index.values()].map((r) => r.used || 0)), limit };
  }

  // Everything kept here is gone, in every tab: nothing being fetched goes on, and nothing is fetched
  // again until a page says what it wants (so Clear does not fill straight back up).
  function forget() {
    cachep = null;
    index.clear();
    failed.clear();
    retryAt.clear();
    full = false;
    clearedQuiet = true;
    for (const job of inflight.values()) if (job.background) job.ctl.abort();
    changed();
  }
  async function clear() {
    forget();
    try {
      if ('caches' in window) await caches.delete(CACHE);
    } catch {
      // nothing kept, or no leave to say so
    }
    await idb('readwrite', (s) => s.clear()).catch(() => {});
    tell({ t: 'cleared' });
    changed();
  }

  // Changing the settings starts or stops what is fetched ahead.
  function setAhead(on) {
    store(KEYS.noAhead, !on);
    full = false;
    clearedQuiet = false;
    if (!on) for (const job of inflight.values()) if (job.background) job.ctl.abort();
    changed();
    schedule(0);
  }
  function setKind(kind, on) {
    store(KEYS.mediaKinds, { ...kinds(), [kind]: !!on });
    full = false;
    clearedQuiet = false;
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
  const ICON = WB.iconSet(20); // icons.js
  const RING = '<svg viewBox="0 0 20 20" aria-hidden="true"><circle class="track" cx="10" cy="10" r="7"/><circle class="arc" cx="10" cy="10" r="7"/><path class="tick" d="M6.6 10.3l2.3 2.3 4.6-5"/></svg><span class="kept-label"></span>';
  const sizeLabel = WB.bytes;
  // How far a video has come: 1 kept, a fraction on its way (ahead, or opened), 0 not here.
  function progressOf(src) {
    if (index.has(src)) return 1;
    const job = inflight.get(src);
    return job && job.total ? job.loaded / job.total : partialOf(src);
  }
  const coming = (src) => !index.has(src) && (inflight.has(src) || partials.has(src));

  function ring(button, scope) {
    const el = WB.el;
    const { clamp } = WB;
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
        paused() && m.here.length < m.srcs.length && el('div', { class: 'kp-warn' }, el('span', { html: ICON.pause }),
          { off: 'Paused: turned off in your settings', data: 'Paused: the browser is saving data', full: 'Paused: no more room on this device', unavailable: 'Not kept: this browser cannot' }[paused()] || 'Paused'),
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
      const why = { off: 'it is turned off in your settings', data: 'the browser is saving data (data saver, or low data mode)', full: 'this device has no more room for it', unavailable: 'this browser cannot keep videos here' }[paused()];
      const tip = full
        ? `${n === 1 ? 'The video' : `All ${n} videos`} of ${m.label} ${n === 1 ? 'is' : 'are'} cached on this computer, so ${n === 1 ? 'it opens and scrubs' : 'they open and scrub'} instantly`
        : paused()
          ? `${done} of ${n} ${videos} of ${m.label} cached on this computer. Caching has stopped: ${why}`
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
    status: () => {
      const bg = backgroundJob();
      return { current: bg && { src: bg.src, loaded: bg.loaded, total: bg.total }, opening: new Map([...inflight].filter(([, j]) => !j.background)), paused: paused() };
    },
    whole, releaseWhole, wholeEntry: (src) => wholes.get(src), onEvict: (fn) => { evictListeners.add(fn); return () => evictListeners.delete(fn); },
    WHOLE_HELD,
    ring, badge, sizeLabel,
    get, want, on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    stats, clear, ahead, setAhead, kinds, setKind,
  };
  window.WBMedia = api;
  // common.js's WB is a page-wide const, not a property of window.
  if (typeof WB !== 'undefined') WB.media = api;
})();
