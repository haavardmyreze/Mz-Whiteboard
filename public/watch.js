'use strict';

// Watching somebody present a project (/p/<token>, see present.js and "presenting a project" in server.js).
// Whatever they show is shown here, as they show it: a board (its read-only page, in a frame, following
// them on it), an asset, set or shot's versions in the player, or an animatic, read-only. Nothing here is
// to be steered: no going elsewhere, no looking about. Only what is this screen's own is in reach: the
// sound, full screen, and folding the comments and the strip away.
(async () => {
  const { el } = WB;
  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split('/').filter(Boolean)[1];
  const stage = $('stage');
  const card = $('card');
  const note = $('note');
  const status = $('status');
  const ICON = WB.iconSet(18);

  let info = null;      // what the link is: { project, presenter, access, live }
  let me = null;
  let ws = null;
  let retry = 800;
  let dead = false;
  let live = false;
  let away = false;
  let scene = null;     // what is shown now, as the presenter's page said it
  let shownKey = '';    // which of it is mounted here
  let mounting = null;  // the scene being put up, while its pieces load
  let state = {};       // what the presenter's player is doing (see cleanPlayer in server.js)
  let stateAt = 0;      // when that was said, for a video playing on since
  let comments = [];
  const commentListeners = new Set();
  let frame = null;     // the board's page, when a board is shown
  let cut = null;       // the animatic's page, when an animatic is shown
  let cutItems = [];    // the files it plays, as it says them
  let soundOn = false;

  const viewer = WBViewer.create({ me: () => me, title: () => '', media: () => [], comments: () => [], locked: true, add() {}, set() {}, remove() {} });
  viewer.watch((type, k) => {
    if (type === '3dload') return void loading3d(k);
    if (type === 'open') keptRing.paint();
    if (type !== 'muted' || !soundOn) return;
    soundOn = false;
    paintStatus();
  });

  // How much of what is shown is cached on this computer (media.js's ring, as in the app's own bar): the
  // board's videos, an asset's versions, an animatic's shots and sounds. What is shown is fetched ahead too,
  // from the piece open on, so the presenter's next one is likelier to be here already.
  let frameItems = [];
  const shownItems = () => {
    if (scene && scene.k === 'board') return frameItems;
    if (scene && scene.k === 'animatic') return cutItems;
    if (!viewer.isOpen()) return [];
    return (viewer.host().media() || []).filter((p) => p.type === 'video').map((p) => ({ src: p.src, name: p.label || p.name }));
  };
  const keptBtn = el('button', { class: 'watch-kept' });
  const keptRing = WB.media.ring(keptBtn, () => ({ label: 'what is shown', items: shownItems() }));

  // The same, told to the presenter, who sees it as a ring around each face: how much of what is shown
  // (its videos, and the project's model of its venue where it can be seen on it) is cached here, so they
  // know whether to wait before playing. While what is shown is still being put up, it says so instead.
  let modelSrc = null;   // the project's model, once what is shown can be seen on it
  let scoped = false;    // the board in the frame has said which videos it has
  let cacheSig = '';
  let cacheTimer = 0;
  function cacheNow() {
    if (mounting || (scene && scene.k === 'board' && !scoped)) return { wait: 1 };
    const srcs = shownItems().map((x) => x.src);
    const videos = WB.media.tally(srcs);
    const model = modelSrc ? WB.media.tally([modelSrc]) : { n: 0, k: 0 };
    const all = WB.media.tally(modelSrc ? [...srcs, modelSrc] : srcs);
    return {
      k: all.n ? Math.round(all.k * 100) / 100 : 1,
      v: [videos.done, videos.n],
      m: model.n ? Math.round(model.k * 100) / 100 : null,
      off: all.done < all.n ? WB.media.status().paused : null,
    };
  }
  function tellCache() {
    cacheTimer = 0;
    if (!ws || ws.readyState !== 1) return;
    const now = cacheNow();
    const sig = JSON.stringify(now);
    if (sig === cacheSig) return;
    cacheSig = sig;
    ws.send(JSON.stringify({ t: 'cache', ...now }));
  }
  // However often the cache moves, no more than a couple of times a second; a change of what is shown at once.
  function cacheSoon(atOnce = false) {
    if (atOnce) clearTimeout(cacheTimer);
    else if (cacheTimer) return;
    cacheTimer = setTimeout(tellCache, atOnce ? 0 : 400);
  }
  WB.media.on(() => cacheSoon());
  // Once a video is on this device it plays and scrubs without waiting on the network, which on a phone is
  // the whole difference. So everything shown in this visit stays wanted, not only what is shown now: what
  // is shown now first (from the piece open on), then what was shown before, latest first, in case the
  // presenter goes back to it.
  const shownBefore = []; // src, the latest shown first
  function fetchAhead() {
    keptRing.paint();
    cacheSoon();
    if (!scene) return;
    const items = shownItems().map((x) => x.src);
    const open = viewer.isOpen() ? items.indexOf((viewer.host().media() || []).find((p) => p.id === viewer.current())?.src) : 0;
    const from = Math.max(0, open);
    const now = [...items.slice(from), ...items.slice(0, from)];
    for (const src of [...now].reverse()) {
      const i = shownBefore.indexOf(src);
      if (i >= 0) shownBefore.splice(i, 1);
      shownBefore.unshift(src);
    }
    // A board fetches its own (board.js, in the frame), and so does an animatic (animatic.js); the rest of the
    // visit comes after what is shown now.
    if (scene.k !== 'board' && scene.k !== 'animatic') WB.media.want('watch', now, { rank: WB.media.RANK.board, hold: true });
    WB.media.want('watch:before', shownBefore.filter((src) => !now.includes(src)), { rank: WB.media.RANK.page, hold: true });
  }
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.wb === 'scope' && Array.isArray(e.data.items)) {
      frameItems = e.data.items.filter((x) => x && typeof x.src === 'string');
      scoped = true;
      fetchAhead();
      cacheSoon(true);
    } else if (e.data.wb === 'model' && typeof e.data.src === 'string') {
      modelSrc = e.data.src;
      cacheSoon();
    } else if (e.data.wb === '3dload') loading3d(e.data.k);
  });

  // The venue loading for 3D (here, or on the board in the frame): over everything, how much has come.
  // Only when it takes a moment: 3D made ready ahead (as it usually is) comes up without a flash of it.
  let venue = false;
  let venueTimer = 0;
  let venueSaid = '';
  function loading3d(k) {
    const on = k !== false && k !== undefined;
    venueSaid = `Loading the venue in 3D…${typeof k === 'number' ? ` ${Math.round(k * 100)}%` : ''}`;
    if (!on) {
      clearTimeout(venueTimer);
      venueTimer = 0;
      const was = venue;
      venue = false;
      if (was) paintNote();
      return;
    }
    if (venue) return void WB.waiting(venueSaid);
    if (!venueTimer) {
      venueTimer = setTimeout(() => {
        venueTimer = 0;
        venue = true;
        WB.waiting(venueSaid);
      }, 300);
    }
  }

  // ---- what is said on the screen besides what is shown

  function fatal(text) {
    dead = true;
    WB.waiting(null);
    if (ws) ws.close();
    viewer.close();
    stage.replaceChildren();
    status.hidden = true;
    note.hidden = true;
    showCard(text, 'The link may have been turned off or replaced, or it ran out. Ask whoever sent it for a new one.');
  }
  function showCard(title, text, ...more) {
    card.replaceChildren(el('div', { class: 'watch-card-in' },
      el('span', { class: 'logomark', html: (document.querySelector('[data-logo-slot] svg') || {}).outerHTML || '' }),
      el('h1', { text: title }), text && el('p', { text }), ...more));
    card.hidden = false;
  }
  const presenter = () => (info && info.presenter && info.presenter.name) || 'The presenter';

  function paintStatus() {
    status.hidden = false;
    const dot = el('i', { class: `live${live && !away ? '' : ' off'}` });
    const says = !live ? `Waiting for ${presenter()}` : away ? `${presenter()} stepped away` : `${presenter()} is presenting`;
    status.replaceChildren(dot,
      el('span', { class: 'watch-says', text: says }),
      el('span', { class: 'watch-project', text: info ? info.project.name : '' }),
      keptBtn,
      el('button', {
        class: `iconbtn${soundOn ? '' : ' off'}`, html: soundOn ? ICON.sound : ICON.muted,
        title: soundOn ? 'Sound on. Click to turn it off (M)' : 'Sound off. Click to turn it on (M)', onclick: () => setSound(!soundOn),
      }),
      document.fullscreenEnabled && el('button', { class: 'iconbtn', html: ICON.fit, title: 'Full screen', onclick: toggleFull }));
  }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  // Sound is this screen's to choose. A browser that will not play sound unasked plays it without.
  function setSound(on) {
    soundOn = on;
    viewer.sound(on);
    if (cut) cut.sound(on);
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ wb: 'sound', on }, location.origin);
    paintStatus();
  }
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey && !WB.isTyping(e.target)) setSound(!soundOn);
  });
  // A frame's board says when its player had to go without sound.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || e.data.wb !== 'muted') return;
    if (soundOn) {
      soundOn = false;
      paintStatus();
    }
  });

  // Between things to show (a list of the catalogue, say), what was shown last stays, and a line says why.
  // Over the whole of it, the same cover a lost connection has (WB.waiting): what was shown last stays behind
  // it, blurred, until the next thing.
  function paintNote() {
    note.hidden = true;
    if (venue) return;
    const idle = live && !away && scene && scene.k === 'idle' && shownKey;
    if (live && away && shownKey) WB.waiting(`${presenter()} stepped away. It goes on when they are back.`);
    else if (idle) WB.waiting(`${presenter()} is finding what to show next…`);
    else WB.waiting(null);
  }
  function paintWaiting() {
    if (dead) return;
    if (!live) {
      tearDown();
      showCard(`${info.project.name}`, `${presenter()} is not presenting right now. This page follows them once they start: leave it open.`);
    } else if (!shownKey && !mounting) {
      showCard(`${info.project.name}`, `${presenter()} is presenting, and is about to show something.`);
    } else card.hidden = true;
    paintNote();
    paintStatus();
  }

  // ---- what is shown

  function tearDown() {
    frameItems = [];
    scoped = false;
    modelSrc = null;
    WB.media.want('watch', []);
    if (venue) loading3d(false);
    shownKey = '';
    mounting = null;
    viewer.close();
    if (frame) frame.remove();
    frame = null;
    if (cut) cut.close();
    cut = null;
    cutItems = [];
    stage.replaceChildren();
  }
  const keyOf = (s) => (!s || s.k === 'idle' ? '' : s.k === 'board' ? `b:${s.board}` : s.k === 'entity' ? `e:${s.entity}` : s.k === 'animatic' ? `a:${s.animatic}` : '');

  async function show(next) {
    scene = next;
    const key = keyOf(next);
    // The presenter is told how this stands for each new word of theirs about what is shown.
    cacheSig = '';
    cacheSoon(true);
    if (!key) return paintWaiting();
    if (key === shownKey || (mounting && mounting.key === key)) {
      if (next.k === 'entity' && shownKey === key) viewer.host().setPass?.(next.pass);
      paintNote();
      return apply();
    }
    tearDown();
    const job = { key };
    mounting = job;
    cacheSoon(true);
    paintWaiting();
    try {
      if (next.k === 'board') {
        frame = el('iframe', { class: 'watch-board', src: `/p/${encodeURIComponent(token)}/b/${encodeURIComponent(next.board)}`, allow: 'autoplay; fullscreen', 'aria-label': 'The board being presented' });
        frame.addEventListener('load', () => { if (frame && frame.contentWindow) frame.contentWindow.postMessage({ wb: 'sound', on: soundOn }, location.origin); });
        stage.replaceChildren(frame);
      } else if (next.k === 'entity') {
        const page = await WB.api('GET', `/api/watch/${token}/entity/${next.entity}`);
        if (mounting !== job) return;
        // The project has a model of its venue: 3D is made ready now, before the presenter turns to it.
        const venue3d = page.project.settings && page.project.settings.preview3d;
        if (venue3d && venue3d.model) {
          viewer.prepare3d({ ...venue3d, key: page.project.id });
          modelSrc = venue3d.model;
        }
        await WBViewer.openEntity(viewer, next.entity, {
          version: typeof state.f === 'string' ? state.f : null, me, title: info.project.name,
          follow: { page, pass: next.pass, room: commentRoom, read: info.access === 'comments' },
        });
      } else if (next.k === 'animatic') {
        // The animatic's own page, read-only, its edit from the link: it plays where the presenter's plays.
        const source = `/api/watch/${token}/animatic/${encodeURIComponent(next.animatic)}`;
        const page = await WB.api('GET', source);
        if (mounting !== job) return;
        const venue3d = page.project.settings && page.project.settings.preview3d;
        if (venue3d && venue3d.model) modelSrc = venue3d.model;
        cut = WBAnimatic.open(stage, {
          project: page.project, id: page.animatic.id, me,
          watched: { source, room: commentRoom, comments: info.access === 'comments' },
          onScope: (scope) => {
            cutItems = scope ? scope.items : [];
            fetchAhead();
          },
        });
      }
    } catch (err) {
      if (mounting !== job) return;
      mounting = null;
      showCard('This could not be shown', err.message);
      return;
    }
    if (mounting !== job) return;
    mounting = null;
    shownKey = key;
    viewer.sound(soundOn);
    if (cut) cut.sound(soundOn);
    paintWaiting();
    apply();
    fetchAhead();
    cacheSoon(true);
  }

  // Whoever is watching is shown what the presenter's player does: the piece, 2D or 3D, the moment, the
  // thread, the zoom. A video playing has played on since it was said. In an animatic, where its playhead is
  // and how the venue is seen.
  function apply(patch = state) {
    if (scene && scene.k === 'animatic') return void (cut && !mounting && cut.follow(patch, performance.now() - stateAt));
    if (!scene || scene.k === 'board' || scene.k === 'idle' || mounting || !viewer.isOpen()) return;
    // A piece this page has not got (filed since it loaded, say) leaves the one showing as it is.
    const has = (id) => (viewer.host().media() || []).some((p) => p.id === id);
    if ('f' in patch && typeof patch.f === 'string' && patch.f !== viewer.current() && has(patch.f)) viewer.follow(patch.f);
    const open = viewer.current();
    // Which of its files is shown in its place (one of its version's attachments), before the zoom on it.
    if ('x' in patch && typeof patch.x === 'string') viewer.followFile(patch.x);
    if ('d' in patch) viewer.follow3d(patch.d);
    if ('m' in patch && Array.isArray(patch.m) && patch.m[0] === open) {
      const [, at, playing] = patch.m;
      viewer.followMedia(open, !!playing, at + (playing ? (performance.now() - stateAt) / 1000 : 0));
    }
    if ('t' in patch) viewer.follow(open, { thread: patch.t });
    if ('z' in patch) requestAnimationFrame(() => viewer.followZoom(patch.z));
  }

  // The comments on what is shown, when the link shows them: as a room would have them (see openEntity).
  function commentRoom(entityId, who, onComments) {
    commentListeners.add(onComments);
    onComments(comments);
    return { send() {}, close: () => commentListeners.delete(onComments) };
  }
  function setComments(list) {
    comments = Array.isArray(list) ? list : [];
    for (const fn of commentListeners) fn(comments);
  }

  // ---- the connection

  function connect() {
    if (dead) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?watch=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', name: me.name, color: me.color }));
      cacheSig = '';
      cacheSoon(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      onMessage(msg);
    };
    ws.onclose = (e) => {
      if (dead) return;
      if (e.code === 4005) return fatal('This link is not shared any more.');
      WB.offline(true);
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 8000);
    };
  }

  function onMessage(msg) {
    if (msg.t === 'init') {
      retry = 800;
      WB.offline(false);
      info = { ...info, project: msg.project, presenter: msg.presenter, access: msg.access };
      live = msg.live;
      away = msg.away;
      state = msg.p || {};
      stateAt = performance.now() - (msg.mAge || 0);
      setComments(msg.comments);
      document.title = `${msg.project.name} · Boards`;
      if (live && msg.scene) show(msg.scene);
      else paintWaiting();
    } else if (msg.t === 'scene') {
      state = msg.p || {};
      stateAt = performance.now();
      show(msg.scene);
    } else if (msg.t === 'p') {
      Object.assign(state, msg.p);
      if ('m' in msg.p) stateAt = performance.now();
      apply(msg.p);
    } else if (msg.t === 'laser') {
      if (viewer.isOpen()) viewer.laser('presenter', (info.presenter && info.presenter.color) || '#ffffff', msg.on, msg.pts);
    } else if (msg.t === 'comments') {
      setComments(msg.comments);
    } else if (msg.t === 'live') {
      live = true;
      away = false;
      info.presenter = msg.presenter;
      info.access = msg.access;
      paintWaiting();
    } else if (msg.t === 'away' || msg.t === 'back') {
      away = msg.t === 'away';
      paintWaiting();
    } else if (msg.t === 'ended') {
      live = false;
      scene = null;
      state = {};
      setComments([]);
      paintWaiting();
    } else if (msg.t === 'access') {
      info.access = msg.access;
      // Shown again, with the comments or without them.
      const was = scene;
      tearDown();
      if (was) show(was);
    }
  }

  // ---- start

  try {
    info = await WB.api('GET', `/api/watch/${token}`);
  } catch {
    return fatal('This link is not shared any more.');
  }
  document.title = `${info.project.name} · Boards`;
  // Who is watching, for the presenter to see: a name, typed once and kept. Joining is a click, so the
  // browser lets what is played here have its sound. It is kept apart from the name this browser goes by in
  // the app (wb:user): somebody on the team opening a link in their own browser stays who they are there.
  // The board's page in the frame here is told it for the tab (sessionStorage), and goes by it.
  const known = WB.store('wb:watcher') || WB.user();
  const name = el('input', { type: 'text', maxlength: 32, placeholder: 'Your name', value: known && known.name ? known.name : '', autocomplete: 'name', 'aria-label': 'Your name' });
  await new Promise((resolve) => {
    const join = (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      const color = known && WB.hexOk(known.color) ? known.color : WB.colors[Math.floor(Math.random() * WB.colors.length)];
      me = { name: name.value.trim().slice(0, 32), color };
      WB.store('wb:watcher', me);
      try {
        sessionStorage.setItem('wb:watcher', JSON.stringify(me));
      } catch {
        // the board in the frame goes by a name of its own
      }
      resolve();
    };
    showCard(info.project.name, info.live ? `${info.presenter.name} is presenting. Say who you are, and join.` : `${info.presenter.name} presents it here. Say who you are, and you are in when they start.`,
      el('form', { class: 'watch-join', onsubmit: join }, name, el('button', { class: 'btn primary', type: 'submit', text: 'Join' })));
    name.focus();
  });
  soundOn = true;
  card.hidden = true;
  paintStatus();
  connect();
})();
