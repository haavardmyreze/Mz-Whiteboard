'use strict';

// Presenting a project: everybody who opens its link (/p/<token>, see watch.js) sees what you show, as you
// show it, and can do nothing else. A board, an asset's versions in the player, an animatic: they follow
// you through all of it, onto the frame you are on, the thread you read, how far you are zoomed in, 2D or
// 3D. Anything else (a list of the catalogue, a page outside the project) they are not shown: they wait
// on what they saw last until you open something again.
//
// Each person has one link per project, kept (so it can go in the invitation to every review), and it is
// live only while they present. Presenting lasts in this tab across pages (sessionStorage), until stopped.
//
//   WBPresent.init({ me, viewer, player, page, project })   on a page that may present: who you are, what tells
//                                                    what is shown (`viewer`: its player, or what stands in for it,
//                                                    as an animatic's page does), the player itself, heard from
//                                                    the start (`player`, else `viewer`), what the page shows
//                                                    besides ({ k: 'board', board } or null), the project it is in
//   WBPresent.heard(type, ...)                       what a stand-in for the player tells, as the player does
//   WBPresent.button()                               the bar's button: Present, or Presenting while you are
//   WBPresent.token()                                the link presented through in this tab, if any
//   WBPresent.onChange(fn)                           hears presenting start and stop
const WBPresent = (() => {
  const { el } = WB;
  const KEY = 'wb:presenting';
  let host = null;      // { me, viewer, page, project }
  let ws = null;
  let retry = 800;
  let closing = false;
  let watching = [];
  let lastScene = '';
  let pending = {};
  let pendingTimer = 0;
  let beat = 0;
  let poll = 0;
  const listeners = new Set();
  const buttons = new Set();

  const now = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY));
    } catch {
      return null;
    }
  };
  const keep = (v) => {
    try {
      if (v) sessionStorage.setItem(KEY, JSON.stringify(v));
      else sessionStorage.removeItem(KEY);
    } catch {
      // Without session storage it lasts as long as the page does.
    }
  };
  const token = () => (now() || {}).token || null;
  const me = () => (host && host.me()) || {};
  const by = () => (WB.info().user ? '' : `?by=${encodeURIComponent(me().name || '')}`);
  const api = (method, projectId, rest = '', body) => WB.api(method, `/api/projects/${projectId}/present${rest}${method === 'GET' || method === 'DELETE' ? by() : ''}`,
    method === 'GET' || method === 'DELETE' ? undefined : { ...body, by: me().name });

  // ---- the connection that says what is shown

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function connect() {
    const p = now();
    if (!p || !host || closing) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?present=${encodeURIComponent(p.token)}`);
    const mine = ws;
    ws.onopen = () => {
      retry = 800;
      send({ t: 'hello', name: me().name, color: me().color });
      lastScene = '';
      report(true);
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'watchers') {
        watching = msg.list || [];
        paint();
      }
    };
    let opened = false;
    ws.addEventListener('open', () => { opened = true; });
    ws.onclose = async (e) => {
      if (ws !== mine) return;
      ws = null;
      if (closing) return;
      // Turned away (4005, 4003), or never let in at all: the link may have been replaced (presenting goes
      // on through the new one), taken away, or not be this person's to present.
      if (e.code === 4005 || e.code === 4003 || !opened) {
        const was = now();
        let info = null;
        try {
          info = was && e.code !== 4003 ? await api('GET', was.projectId) : null;
        } catch (err) {
          // The server unreachable is not the link gone: tried again as ever.
          if (!err.status && !opened) {
            setTimeout(connect, retry);
            retry = Math.min(retry * 1.6, 8000);
            return;
          }
        }
        if (info && info.token === was.token && e.code !== 4005) {
          setTimeout(connect, retry);
          retry = Math.min(retry * 1.6, 8000);
          return;
        }
        if (info && info.token && info.token !== was.token) {
          keep({ ...was, token: info.token });
          WB.toast('Presenting goes on through the new link');
          connect();
          tell();
          return;
        }
        stop(false);
        WB.toast(e.code === 4003 ? 'This project is not yours to present any more' : 'The link was turned off, so presenting stopped');
        return;
      }
      setTimeout(connect, retry);
      retry = Math.min(retry * 1.6, 8000);
    };
  }

  // What is shown now: the player's own word for it (an asset's versions, an animatic), else the page's (a board).
  function sceneNow() {
    const v = host && host.viewer && host.viewer();
    const fromPlayer = v && v.isOpen() && v.scene();
    return fromPlayer || (host.page && host.page()) || { k: 'idle' };
  }
  // What the player is doing, all of it.
  function playerNow() {
    const v = host && host.viewer && host.viewer();
    if (!v || !v.isOpen()) return {};
    return { f: v.current(), t: v.thread(), m: v.moment(), z: v.zoom(), d: v.view3d() };
  }

  function report(force = false) {
    if (!host || !ws || ws.readyState !== 1) return;
    const scene = sceneNow();
    const sig = JSON.stringify(scene);
    if (!force && sig === lastScene) return;
    lastScene = sig;
    pending = {};
    send({ t: 'scene', scene, p: playerNow() });
  }
  // What the player does is sent a beat behind, gathered, so a drag of the zoom is not a message a frame.
  function tellPlayer(patch, atOnce = false) {
    Object.assign(pending, patch);
    if (atOnce) clearTimeout(pendingTimer);
    else if (pendingTimer) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = 0;
      if (Object.keys(pending).length) send({ t: 'p', p: pending });
      pending = {};
    }, atOnce ? 0 : 60);
  }

  function onPlayer(type, ...args) {
    if (!now()) return;
    const v = host.viewer();
    if (type === 'open' || type === 'close') {
      report();
      // The new piece, and how it plays once it has started.
      if (type === 'open') {
        tellPlayer({ f: args[0], x: v.file(), t: v.thread(), z: v.zoom(), d: v.view3d(), m: v.moment() }, true);
        setTimeout(() => { if (v.isOpen() && v.current() === args[0]) tellPlayer({ m: v.moment() }); }, 250);
      }
      return;
    }
    if (type === 'media') tellMoment([args[0], Math.round(args[2] * 1000) / 1000, args[1] ? 1 : 0]);
    else if (type === 'thread') tellPlayer({ t: args[0] });
    else if (type === 'file') tellPlayer({ x: args[1], z: v.zoom() });
    else if (type === 'zoom') tellPlayer({ z: v.zoom() });
    else if (type === '3d') tellPlayer({ d: v.view3d() });
    else if (type === 'laser') send({ t: 'laser', on: args[0], pts: args[1] });
  }

  // Where the video is, as it is moved: at once, but no more than thirty times a second however quickly a
  // scrub sends it, and always the last of a run of them.
  let momentNext = null;
  let momentAt = 0;
  let momentTimer = 0;
  function tellMoment(m) {
    momentNext = m;
    if (momentTimer) return;
    const flush = () => {
      momentTimer = 0;
      momentAt = performance.now();
      if (momentNext) send({ t: 'p', p: { m: momentNext } });
      momentNext = null;
    };
    const wait = 33 - (performance.now() - momentAt);
    if (wait <= 0) flush();
    else momentTimer = setTimeout(flush, wait);
  }

  // While presenting: now and then the moment of a video playing (so the people watching never drift), and
  // where the view is, flying in 3D; and what is shown, should the page have changed it without a word.
  function startBeat() {
    clearInterval(beat);
    clearInterval(poll);
    beat = setInterval(() => {
      const v = host && host.viewer && host.viewer();
      if (!v || !v.isOpen()) return;
      const m = v.moment();
      if (m && m[2]) tellMoment(m);
    }, 1000);
    let flown = '';
    poll = setInterval(() => {
      report();
      const v = host && host.viewer && host.viewer();
      const d = v && v.isOpen() ? v.view3d() : null;
      // Flying: the view as it moves, twenty times a second, each place with when it was taken (view3d.js
      // plays them back at that pace); nothing while it is still.
      if (d && d.f) {
        const sig = JSON.stringify([d.f.p, d.f.q, d.f.fov]);
        if (sig !== flown) send({ t: 'p', p: { d } });
        flown = sig;
      }
    }, 50);
  }

  // ---- starting and stopping

  async function start(projectId, tokenNow) {
    keep({ token: tokenNow, projectId });
    closing = false;
    connect();
    startBeat();
    tell();
  }
  function stop(say = true) {
    closing = true;
    if (ws && ws.readyState === 1) send({ t: 'end' });
    if (ws) ws.close();
    ws = null;
    keep(null);
    watching = [];
    clearInterval(beat);
    clearInterval(poll);
    tell();
    if (say) WB.toast('Presenting stopped. The link stays: send it again next time');
  }
  function tell() {
    paint();
    for (const fn of listeners) fn(token());
  }

  // ---- what it looks like: the bar's button, and a pill while presenting

  const pill = el('div', { class: 'present-pill', hidden: true, role: 'status' });

  // Each person watching is a face with a ring around it: how much of what is shown they have cached on
  // their own computer (its videos, and the model of the venue where it can be seen on it). A full green
  // ring is ready to play; one still filling says wait; a dashed one is a browser that cannot cache and plays
  // from the server; an empty one is a person whose page has not said yet, or is putting up what you opened.
  const FACES = 6;
  const CIRCLE = 2 * Math.PI * 15;
  const WHY = { unavailable: 'this browser cannot keep videos here', off: 'it is turned off in their settings', data: 'their browser is saving data', full: 'their device has no more room' };
  const ready = (c) => !!c && !c.wait && c.k >= 1;
  function cacheSays(w) {
    const c = w.cache;
    if (!c) return { state: 'wait', text: 'has not said yet' };
    if (c.wait) return { state: 'wait', text: 'is loading what you opened' };
    const parts = [];
    if (c.v[1]) parts.push(`${c.v[0]} of ${WB.plural(c.v[1], 'video')}`);
    if (c.m !== null) parts.push(`3D model ${Math.floor(c.m * 100)}%`);
    if (c.k >= 1) return { state: 'full', text: c.v[1] || c.m !== null ? `has it all cached (${parts.join(', ')}): ready to play` : 'has nothing to cache here: ready to play' };
    if (c.off) return { state: 'off', text: `cannot cache (${WHY[c.off]}), so it plays from the server: ${parts.join(', ')} cached` };
    return { state: 'filling', text: `is caching: ${parts.join(', ')} (${Math.floor(c.k * 100)}% in all)` };
  }
  function face(w) {
    const says = cacheSays(w);
    const k = says.state === 'wait' ? 0 : says.state === 'off' ? 0 : w.cache.k;
    return el('span', {
      class: `present-face ${says.state}`, title: `${w.name} ${says.text}`,
      html: `<svg viewBox="0 0 34 34" aria-hidden="true"><circle class="track" cx="17" cy="17" r="15"/><circle class="arc" cx="17" cy="17" r="15" stroke-dasharray="${CIRCLE}" stroke-dashoffset="${CIRCLE * (1 - k)}"/></svg>`,
    }, WB.avatar(w.name, w.color));
  }
  function paint() {
    const live = !!token();
    for (const b of buttons) {
      b.classList.toggle('on-air', live);
      b.querySelector('.lbl').textContent = live ? 'Presenting' : 'Present';
      b.title = live ? 'You are presenting this project. Click for the link, and to stop' : 'Present the project: a link that shows whoever opens it what you show, as you show it';
    }
    pill.hidden = !live;
    if (!live) return;
    const names = watching.map((w) => w.name).join(', ');
    const ok = watching.filter((w) => ready(w.cache)).length;
    pill.replaceChildren(...[
      el('i', { class: 'live' }),
      el('span', { class: 'present-what', text: 'Presenting' }),
      watching.length > 0 && el('span', { class: 'present-faces' }, watching.slice(0, FACES).map(face),
        watching.length > FACES && el('span', { class: 'avatar sm more', title: watching.slice(FACES).map((w) => w.name).join(', '), text: `+${watching.length - FACES}` })),
      el('span', {
        class: 'present-who', title: names || 'Nobody has the link open yet',
        text: !watching.length ? 'Nobody watching yet' : ok === watching.length ? 'All cached' : `${ok} of ${watching.length} cached`,
      }),
      el('button', { class: 'btn small', text: 'Link', onclick: () => openDialog() }),
      el('button', { class: 'btn small', text: 'Stop', onclick: () => stop() }),
    ].filter(Boolean));
  }

  function button() {
    const b = el('button', { class: 'btn present-btn', onclick: () => openDialog() },
      el('span', { class: 'present-dot', 'aria-hidden': 'true' }), el('span', { class: 'lbl', text: 'Present' }));
    buttons.add(b);
    paint();
    return b;
  }

  const ACCESS = [['view', 'Only see what you show'], ['comments', 'Also read the comments on it']];
  const EXPIRY = [['never', 'Never', 0], ['1d', 'In 1 day', 864e5], ['7d', 'In 7 days', 7 * 864e5], ['30d', 'In 30 days', 30 * 864e5]];

  async function openDialog() {
    const project = host && host.project && host.project();
    const p = now();
    const projectId = p ? p.projectId : project && project.id;
    if (!projectId) return;
    const name = p && project && p.projectId !== project.id ? 'the project you are presenting' : project ? project.name : 'this project';
    let info;
    try {
      info = await api('GET', projectId);
    } catch (err) {
      return void WB.toast(err.message);
    }
    const bases = WB.shareBases();
    let base = bases.includes(WB.store('wb:sharebase')) ? WB.store('wb:sharebase') : bases[0];
    let busy = false;
    const dlg = el('dialog', { class: 'dlg share-dlg present-dlg' });
    const call = async (method, rest, body) => {
      if (busy) return;
      busy = true;
      try {
        info = await api(method, projectId, rest, body);
      } catch (err) {
        WB.toast(err.message);
      }
      busy = false;
      paintDialog();
    };
    const select = (options, value, onchange) => el('select', { onchange: (e) => onchange(e.target.value) },
      options.map(([v, label]) => el('option', { value: v, text: label, selected: v === value })));
    function paintDialog() {
      const live = token() && info.token === token();
      const link = info.token && `${base}/p/${info.token}`;
      const input = link && el('input', { type: 'text', readonly: true, value: link, 'aria-label': 'Link', onfocus: (e) => e.target.select() });
      const copy = async () => {
        try {
          await navigator.clipboard.writeText(link);
        } catch {
          input.select();
          document.execCommand('copy');
        }
        WB.toast('Link copied');
      };
      const expiry = info.expiresAt
        ? [['set', `On ${new Date(info.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`], ...EXPIRY]
        : EXPIRY;
      dlg.replaceChildren(el('form', { method: 'dialog', onsubmit: (e) => e.preventDefault() },
        el('h2', { text: `Present ${name}` }),
        el('p', { class: 'share-note', text: 'Whoever opens the link sees what you show, as you show it: boards, versions in the player, animatics. They follow you and cannot look about for themselves, and they never see the catalogue\'s lists or anything outside the project. No sign-in is needed.' }),
        !link && el('div', { class: 'dlg-actions' },
          el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
          el('button', { type: 'button', class: 'btn primary', text: 'Make a link', onclick: () => call('POST', '') })),
        link && el('div', { class: 'share-link' }, input, el('button', { type: 'button', class: 'btn primary', text: 'Copy', onclick: copy })),
        link && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'They can' }),
          select(ACCESS, info.access, (v) => call('PATCH', '', { access: v }))),
        link && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'Link ends' }),
          select(expiry, info.expiresAt ? 'set' : 'never', (v) => {
            const pick = EXPIRY.find((x) => x[0] === v);
            if (pick) call('PATCH', '', { expiresAt: pick[2] ? Date.now() + pick[2] : null });
          })),
        link && bases.length > 1 && el('label', { class: 'share-row' }, el('span', { class: 'share-label', text: 'Address' }),
          select(bases.map((b) => [b, b]), base, (v) => { base = v; WB.store('wb:sharebase', base); paintDialog(); })),
        link && !/^https:/.test(base) && el('p', { class: 'share-note', text: 'This address only works for people on the same network as this computer. For people elsewhere, set up a public address (see DEPLOY.md).' }),
        link && live && el('p', { class: 'share-note present-watching', text: watching.length ? `Watching now: ${watching.map((w) => w.name).join(', ')}` : 'Nobody has the link open yet.' }),
        link && el('div', { class: 'dlg-actions' },
          el('button', { type: 'button', class: 'btn ghost share-reset', text: 'Turn off', title: 'Take the link away. Whoever has it can no longer open it.', onclick: async () => {
            const sure = await WB.dialog({ title: 'Turn the link off?', text: 'Everybody who has it loses it at once, and presenting stops. Making a link again makes a new one.', ok: 'Turn off', danger: true });
            if (!sure) return;
            if (live) stop(false);
            call('DELETE', '');
          } }),
          el('button', { type: 'button', class: 'btn ghost share-reset', text: 'New link', title: 'Make a new link. The current one stops working at once.', onclick: async () => {
            const sure = await WB.dialog({ title: 'Make a new link?', text: 'The current link stops working at once, for everyone who has it.', ok: 'Make a new link', danger: true });
            if (sure) call('POST', '/reset');
          } }),
          live
            ? el('button', { type: 'button', class: 'btn danger', text: 'Stop presenting', onclick: () => { stop(); dlg.close(); } })
            : el('button', { type: 'button', class: 'btn brand', text: 'Start presenting', onclick: () => { start(projectId, info.token); dlg.close(); } }),
          el('button', { type: 'button', class: 'btn', text: 'Done', onclick: () => dlg.close() }))));
    }
    dlg.addEventListener('close', () => dlg.remove());
    paintDialog();
    document.body.append(dlg);
    dlg.showModal();
  }

  let unwatch = null;
  function init(next) {
    host = next;
    document.body.append(pill);
    const v = host.player ? host.player() : host.viewer && host.viewer();
    if (unwatch) unwatch();
    unwatch = v ? v.watch(onPlayer) : null;
    window.addEventListener('hashchange', () => setTimeout(() => report(), 0));
    window.addEventListener('pagehide', () => {
      closing = true;
      if (ws) ws.close();
    });
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted || !now()) return;
      closing = false;
      connect();
    });
    if (now()) {
      connect();
      startBeat();
    }
    paint();
  }

  return {
    init, button, token, report, heard: onPlayer,
    onChange: (fn) => listeners.add(fn),
  };
})();
