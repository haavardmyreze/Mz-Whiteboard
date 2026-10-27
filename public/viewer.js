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
//                                           fps?, dur?, wf?, name?, label?, orig?, extras?, files?, ex? }
//                                         A piece filed as a version may have its version's extras: `extras`
//                                         (its look's, each with its `label`), or `files` (the version's own
//                                         file and its extras, each with `ex`, '' for its own) with `ex`
//                                         saying which of them the piece itself is. Any of them can be shown
//                                         in its place (see "a version's extras" below).
//     notes: () => [comment],             { id, on, re?, text, name, color, t, done, at?, fr?, drawing?, edited?,
//                                           guest?, obn?, ex? }, on any of the pieces (`ex`: on that extra of it)
//     drawings: (id) => [stroke],         drawings on the piece that are not a comment's, if the host has them
//     can: { read, write, draw, member }  functions: read comments, write them, draw, act as one of the team
//     add(comment), set(id, patch), remove(ids)      what is said, done (the host keeps and shares it)
//     undo(), redo(), erase(ids), clear(id), download(piece)               all optional
//     names: () => [{ name, color }]      who may be named with an @, besides those who have commented
//     onOpen(id), onClose(), onMedia(id, playing, time), onThread(id), onLaser(id, pts), onInteract(), onWhole(id, url)
//     view3d: { key, model, screen }      a project with a model of its venue: the piece can be seen on it in 3D
//     onMode3d(on)                        it has turned to 3D or back (the host may show the pieces another way)
//     can3d(piece)                        whether a piece can be seen on the model at all (all of them, if not said)
//     scene: () => ({ k, ... })           what is shown, for somebody presenting it (see present.js)
//     locked: true                        it only follows somebody else (who presents): nothing here moves it
//   })
//
// Whoever wants to know what the player does, whatever host it has, listens with `watch(fn)`: fn('open', id),
// ('close'), ('media', id, playing, time), ('thread', id), ('laser', id, pts), ('zoom'), ('3d'), ('muted'),
// ('3dload', k): the venue is loading, k of it come (null while that is not known), false once it is there,
// ('file', id, ex): another of the open piece's files is shown in its place.
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

  // How the venue is drawn, under the button beside the 3D switch: how much the room is lit, the shade in
  // its corners and creases (ambient occlusion, and cavity), and the light the screens throw on it, all
  // under one switch: off, the venue is drawn plainly (PLAIN), and the settings wait as they were. Lower
  // quality is for a slower computer and so is not part of the look: it works with Effects on or off, and
  // Reset leaves it. Kept by this browser, and the same for every 3D view on the page (a player's, an
  // animatic's): each listens for a change (`listenLook`) and opens the menu under its own button.
  const LOOK = { on: true, light: 0.05, ao: 0.59, aoRadius: 0.55, cavity: 0.4, glow: true, glowAmount: 0.95 };
  const PLAIN = { light: 1, ao: 0, cavity: 0, glow: false };
  let look3d = { ...LOOK, low: false, ...(store('wb:3dlook') || {}) };
  const lookShown = () => (look3d.on ? look3d : { ...look3d, ...PLAIN });
  const lookListeners = new Set();
  function setLook3d(change) {
    look3d = { ...look3d, ...change };
    store('wb:3dlook', look3d);
    for (const fn of lookListeners) fn(lookShown());
  }
  // `fn(look)` hears every change; it gives back how to stop.
  function listenLook(fn) {
    lookListeners.add(fn);
    return () => lookListeners.delete(fn);
  }
  const pct = (v) => `${Math.round(v * 100)}%`;
  function lookMenu(lookBtn) {
    if (document.querySelector('.v-look')) return void WB.closeMenus();
    const slider = (label, key, min, max, step, says) => {
      const value = el('span', { class: 'v-look-val' });
      const input = el('input', { type: 'range', min, max, step, value: look3d[key], 'aria-label': label });
      const paint = () => {
        value.textContent = says(look3d[key]);
        input.style.setProperty('--p', `${((look3d[key] - min) / (max - min)) * 100}%`);
      };
      input.addEventListener('input', () => {
        setLook3d({ [key]: Number(input.value) });
        paint();
        reach.hidden = !look3d.ao;
      });
      // The arrows move the slider, not the player along its pieces.
      input.addEventListener('keydown', (e) => { if (/^(Arrow|Page|Home|End)/.test(e.key)) e.stopPropagation(); });
      paint();
      return el('label', { class: 'v-look-row' }, el('span', { text: label }), value, input);
    };
    // How far the occlusion reaches is only asked while there is some; the screens' strength, while they light.
    const reach = slider('Reach', 'aoRadius', 0.1, 4, 0.05, (v) => `${v.toFixed(2)} m`);
    reach.hidden = !look3d.ao;
    const glowAmount = slider('Strength', 'glowAmount', 0.1, 3, 0.05, pct);
    glowAmount.hidden = !look3d.glow;
    const glow = el('input', { type: 'checkbox', class: 'switch', checked: look3d.glow, 'aria-label': 'Screen light' });
    glow.addEventListener('change', () => {
      setLook3d({ glow: glow.checked });
      glowAmount.hidden = !glow.checked;
    });
    const body = el('div', { class: 'v-look-body' },
      slider('Room light', 'light', 0, 2, 0.01, pct),
      el('div', { class: 'menu-sep' }),
      slider('Ambient occlusion', 'ao', 0, 1, 0.01, (v) => (v ? pct(v) : 'Off')),
      reach,
      slider('Cavity', 'cavity', 0, 1, 0.01, (v) => (v ? pct(v) : 'Off')),
      el('div', { class: 'menu-sep' }),
      el('label', { class: 'v-look-row v-look-switch', title: 'The picture on the screens lights the room' }, el('span', { text: 'Screen light' }), glow),
      glowAmount);
    // The one switch over all of them: off, they are greyed out and out of reach.
    const on = el('input', { type: 'checkbox', class: 'switch', checked: look3d.on, 'aria-label': 'Effects' });
    const paintOn = () => {
      body.classList.toggle('off', !look3d.on);
      for (const input of body.querySelectorAll('input')) input.disabled = !look3d.on;
    };
    on.addEventListener('change', () => {
      setLook3d({ on: on.checked });
      paintOn();
    });
    paintOn();
    const low = el('input', { type: 'checkbox', class: 'switch', checked: look3d.low, 'aria-label': 'Lower quality' });
    low.addEventListener('change', () => setLook3d({ low: low.checked }));
    const node = WB.menu(lookBtn, [
      el('label', { class: 'v-look-row v-look-switch', title: 'Off, the venue is drawn plainly: lit as it was, with no shade and no light from the screens' }, el('span', { text: 'Effects' }), on),
      el('div', { class: 'menu-sep' }),
      body,
      el('div', { class: 'menu-sep' }),
      el('label', { class: 'v-look-row v-look-switch', title: 'For a slower computer: its shade and the light from the screens are worked out more roughly; the picture keeps its size' }, el('span', { text: 'Lower quality' }), low),
      el('div', { class: 'menu-sep' }),
      el('button', {
        type: 'button', class: 'menu-item', text: 'Reset',
        onclick: () => {
          setLook3d(LOOK);
          WB.closeMenus();
          lookMenu(lookBtn);
        },
      }),
    ], { cls: 'v-look' });
    node.querySelector('input').focus({ preventScroll: true });
    lookBtn.setAttribute('aria-expanded', 'true');
    new MutationObserver((_, watch) => {
      if (node.isConnected) return;
      lookBtn.setAttribute('aria-expanded', 'false');
      watch.disconnect();
    }).observe(document.body, { childList: true });
  }


  // ---------------------------------------------------------------- the venue in 3D, one way for every player
  //
  // Whatever shows a piece of a project with a model of its venue (the player here, an animatic's page) shows
  // it on the venue the same way, with this: the 2D / 3D switch (with how far the venue has come while it
  // loads), how the venue is drawn, the model's cameras (its main one, the others under the arrow, V for the
  // next), flying with W A S D Q E, 2 and 3, where it was left (for the tab, by model), the venue fetched and
  // made ready ahead, and the page's one 3D view (view3d.js), lent to whichever of them is showing it, as a
  // browser keeps only so many drawing contexts going. What a host does itself is say what it has and lay out
  // its own picture: `host` gives
  //   setting()      the project's 3D setting ({ model, screen, camera, pass }), or null
  //   can()          whether what it has open can be seen on the venue now
  //   isOn()         whether it shows the venue
  //   toggle(on)     shows the venue (having asked `ready()` for the view) or its own picture: the switch,
  //                  and 2 and 3, call it
  //   frameOf()      where the frame the view holds is on the page (a box laid out at `three.aspect()`)
  //   seen()         where across the page the view is seen ({ left, right }), if not the whole of it
  //   holds(e)       whether a press on the venue is its own (a pen), not a move of the view
  //   quiet()        whether the keys are its own just now (a pen in hand), not the view's
  //   onFree(on)     the view left its frame to fly, or came to one
  //   onLook()       the view went to another frame or moved: its box takes the frame's shape again
  //   onLoad(k)      how much of the venue has come while it loads (null: not known; false: there)
  //   toast(text)    how it says something (the venue could not be opened); WB.toast unless it says otherwise
  let shared3d = null;
  let lender = null; // the venue component the 3D view is lent to
  const warmed3d = new Set();
  async function makeView3d(setting, warm = false) {
    const mod = await import('/view3d.js');
    if (!shared3d) {
      shared3d = mod.create({
        onFree: (on) => { if (lender) lender.freed(on); },
        frameOf: () => (lender ? lender.host.frameOf() : null),
        seen: () => (lender && lender.host.seen ? lender.host.seen() : null),
        holds: (e) => !!lender && lender.host.holds(e),
      });
      shared3d.setLook(lookShown());
      listenLook((look) => shared3d.setLook(look));
    }
    await shared3d.load(setting);
    if (warm) await shared3d.warm();
    return shared3d;
  }
  function venue(host, { title = 'See it on the venue, in 3D. Key 3', back = 'Back to the picture as it is, in 2D. Key 2' } = {}) {
    const ICON = WB.iconSet(20);
    const d3Pct = el('span', { class: 'v-3dpct' });
    const d3Btn = el('button', { type: 'button', class: 'iconbtn v-3d-btn', html: ICON.cube, title, 'aria-label': '3D', 'aria-pressed': 'false', onclick: () => host.toggle(!host.isOn()) }, d3Pct);
    const lookBtn = el('button', { type: 'button', class: 'iconbtn v-look-btn', html: ICON.shade, title: 'How the venue is drawn', 'aria-label': '3D view settings', 'aria-haspopup': 'menu', 'aria-expanded': 'false', onclick: () => lookMenu(lookBtn) });
    const dims = el('span', { class: 'bar-group v-dims', hidden: true }, d3Btn);
    const camBtn = el('button', { type: 'button', class: 'iconbtn v-cam', html: ICON.focus, title: 'Look through the main camera. V goes on to the next camera', 'aria-label': 'Main camera', 'aria-pressed': 'false', onclick: () => look('main') });
    const camMore = el('button', { type: 'button', class: 'iconbtn v-cam-more', html: ICON.chevron, title: "The model's other cameras", 'aria-haspopup': 'menu', onclick: () => cameraMenu() });
    // What only the venue has (how it is drawn, its cameras) comes and goes with it. A host puts it at the far
    // end of its controls from the switch, so nothing that is there in 2D moves when it comes.
    const cams = el('span', { class: 'bar-group v-cams', hidden: true }, lookBtn, camBtn, camMore);
    const me = { host, freed: (on) => { host.onFree(on); paint(); } };
    const owns = () => lender === me && !!shared3d;
    const showing = () => host.isOn() && owns();

    // The view, with the venue in it, lent to this host: fetched (how far it has come on the switch) and made
    // the first time. Null if it could not be.
    async function ready() {
      const setting = host.setting();
      if (!setting || !setting.model) return null;
      d3Btn.disabled = true;
      d3Btn.classList.add('loading');
      d3Btn.title = 'Loading the venue…';
      let mod = null;
      import('/view3d.js').then((m) => { mod = m; }, () => {});
      const counting = setInterval(() => {
        const k = mod ? mod.progress(setting.model) : 0;
        d3Pct.textContent = k == null ? '…' : `${Math.round(k * 100)}%`;
        host.onLoad(k);
      }, 150);
      host.onLoad(0);
      try {
        await makeView3d(setting);
        lender = me;
        return shared3d;
      } catch (err) {
        console.warn('The 3D view could not be opened:', err);
        (host.toast || WB.toast)("The project's 3D model could not be opened", { ms: 5000 });
        return null;
      } finally {
        clearInterval(counting);
        host.onLoad(false);
        d3Btn.disabled = false;
        d3Btn.classList.remove('loading');
        d3Pct.textContent = '';
        paint();
      }
    }
    // Fetched and made ready a moment after, when the page has nothing better to do, so the switch is quick.
    // Once a model.
    function prepare(setting = host.setting(), delay = 0) {
      if (!setting || !setting.model || warmed3d.has(setting.model)) return;
      warmed3d.add(setting.model);
      const run = async () => {
        try {
          const mod = await import('/view3d.js');
          await mod.preload(setting.model);
          if (!host.isOn()) await makeView3d(setting, true);
        } catch {
          warmed3d.delete(setting.model);
        }
      };
      setTimeout(() => (window.requestIdleCallback ? requestIdleCallback(run, { timeout: 600 }) : run()), delay);
    }

    // The view goes to another frame: a camera of the model's ('main', or its number), a comment's place, or,
    // with none given, holds still where it is, framed as a comment's view is.
    function look(pov, animate = true) {
      if (!showing()) return;
      if (pov === undefined) shared3d.hold();
      else shared3d.goTo(pov, animate);
      host.onLook();
      paint();
    }
    // V: on a camera of the model's, the next one (the last comes round to the first); anywhere else (flying,
    // or on a comment's frame), the main camera.
    function next() {
      if (!showing()) return;
      const on = shared3d.camera();
      look(on < 0 || shared3d.isFree() ? 'main' : (on + 1) % shared3d.cameras().length);
    }
    function cameraMenu() {
      if (!showing()) return;
      const names = shared3d.cameras();
      const main = shared3d.mainCamera();
      const on = shared3d.camera();
      // Every camera of the model, the main one too (marked so), with a tick on the one looked through.
      WB.menu(camMore, names.map((name, i) => el('button', {
        type: 'button', class: `menu-item menu-check${i === on ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(i === on),
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          WB.closeMenus();
          look(i);
        },
      }, el('span', { class: 'menu-tick', html: i === on ? ICON.check : '' }), el('span', { text: name || 'Camera' }), i === main && !/^main$/i.test(name) && el('span', { class: 'menu-note', text: 'main' }))));
    }
    // The venue's keys: true when the key was taken. On the venue, W A S D Q E fly (unless the host's keys are
    // its own) and V goes on to the next camera; 2 and 3 switch, where what is open can be seen on it.
    function key(e) {
      const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (showing() && !host.quiet() && shared3d.key(e, true)) {
        host.onLook();
        paint();
        return true;
      }
      if (showing() && plain && e.key.toLowerCase() === 'v') {
        next();
        return true;
      }
      if (plain && (e.code === 'Digit2' || e.code === 'Digit3') && host.can()) {
        host.toggle(e.code === 'Digit3');
        return true;
      }
      return false;
    }

    // Where the venue was last seen from in this tab (sessionStorage, by model): whether it was shown, and where
    // the view was. Shared by every host, so what opens next opens that way.
    const placeKey = () => {
      const setting = host.setting();
      return setting && setting.model ? `wb:3dat:${setting.model}` : '';
    };
    function remember() {
      if (!placeKey() || !host.can()) return;
      try {
        sessionStorage.setItem(placeKey(), JSON.stringify(showing() ? { on: 1, at: shared3d.where() } : { on: 0 }));
      } catch {
        // Storage can be blocked: it opens in 2D.
      }
    }
    // `still()` says whether what was open is still what is open once the venue is up.
    async function recall(still = () => true) {
      if (host.isOn() || !host.can() || !placeKey()) return;
      let was = null;
      try {
        was = JSON.parse(sessionStorage.getItem(placeKey()));
      } catch {
        return;
      }
      if (!was || !was.on) return;
      await host.toggle(true);
      if (!showing() || !still() || !was.at || !shared3d.place(was.at)) return;
      host.onLook();
      paint();
    }

    function paint() {
      const on = showing();
      dims.hidden = !host.can();
      d3Btn.setAttribute('aria-pressed', String(host.isOn()));
      if (!d3Btn.disabled) d3Btn.title = host.isOn() ? back : title;
      cams.hidden = !on;
      if (!on) return;
      camBtn.setAttribute('aria-pressed', String(shared3d.camera() === shared3d.mainCamera() && !shared3d.isFree()));
      camMore.hidden = shared3d.cameras().length < 2;
    }

    return {
      dims, cams, ready, prepare, look, next, key, remember, recall, paint, owns,
      // The page's 3D view, while it is lent to this host.
      three: () => (owns() ? shared3d : null),
      // Stops showing the venue here: the view stops, and its canvas comes down.
      putAway() {
        if (!owns()) return;
        shared3d.stop();
        shared3d.canvas.remove();
      },
    };
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
      if (next.locked) Object.assign(can, { write: () => false, draw: () => false, member: () => false });
    }
    const locked = () => !!opts.locked;
    // Who listens to what the player does, whatever its host (see `watch` below).
    const watchers = new Set();
    const emit = (type, ...args) => {
      for (const fn of watchers) {
        try {
          fn(type, ...args);
        } catch (err) {
          console.error(err);
        }
      }
    };
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
    const stage = el('div', { class: 'v-stage' }, pieceBox, laserCanvas);
    const nameEl = el('span', { class: 'v-name' });
    const posEl = el('span', { class: 'v-pos' });
    const prevBtn = el('button', { class: 'iconbtn', html: ICON.prev, title: 'Previous (←)', onclick: () => step(-1) });
    const nextBtn = el('button', { class: 'iconbtn', html: ICON.next, title: 'Next (→)', onclick: () => step(1) });
    const crumb = el('button', { class: 'bar-crumb', title: 'Back (Esc)', onclick: () => close() });
    const clearBtn = el('button', { class: 'iconbtn v-clear', html: ICON.eraser, title: 'Clear what is drawn on it (not what was drawn for a comment)', 'aria-label': 'Clear drawing', onclick: () => clearDrawing() });
    const extras = el('span', { class: 'v-extras' });
    // On a window too narrow for the strip, the open piece's other files are a menu here (see showFile).
    const filesBtn = el('button', { class: 'iconbtn v-files', html: ICON.stack, title: 'Its other files ([ and ])', 'aria-label': 'Its other files', 'aria-haspopup': 'menu', hidden: true, onclick: () => filesMenu() });
    const dlBtn = el('button', { class: 'iconbtn', html: ICON.download, title: 'Download the original media', onclick: () => opts.download && open && opts.download(open) });
    const zoomBtn = el('button', { class: 'btn ghost v-zoom', html: ICON.fit, title: 'Fitted to the screen. Click for actual size', onclick: () => toggleZoom() });
    const doneBtn = el('button', { class: 'btn primary', text: 'Done', title: 'Close (Esc)', onclick: () => close() });
    // In a project with a model of its venue, the piece can be seen on it (view3d.js), the way every player
    // shows it (venue, above): its switch, how it is drawn and its cameras are in the bar.
    const venue3d = venue({
      setting: () => opts.view3d || null,
      can: () => has3d(),
      isOn: () => in3d,
      toggle: (on) => set3d(on),
      frameOf: () => pieceBox.getBoundingClientRect(),
      // The venue is drawn under the strip and the comments: it is seen between them.
      seen: () => {
        const r = stage.getBoundingClientRect();
        return { left: shown(film) ? film.getBoundingClientRect().right : r.left, right: shown(panel) ? panel.getBoundingClientRect().left : r.right };
      },
      // Drawing, erasing and pointing are done on the frame held; any other press moves the view.
      holds: (e) => e.button === 0 && !spaceDown && (tool === 'pen' || tool === 'eraser' || tool === 'laser'),
      quiet: () => tool === 'pen' || tool === 'eraser',
      onFree: (on) => {
        if (on && (tool === 'pen' || tool === 'eraser')) setTool('pan');
        paintInk();
        emit('3d');
      },
      onLook: () => {
        emit('3d');
        if (in3d && three && Math.round(1600 / three.aspect()) !== H) {
          sizeBox();
          fit();
        }
        paintInk();
      },
      // (Whoever watches is told too: following somebody into 3D, the button is not there to see.)
      onLoad: (k) => emit('3dload', k),
      toast: (text, o) => toast(text, o),
    });
    const brand = el('a', { class: 'brand', href: '/', title: 'All boards' }, el('span', { class: 'logomark', html: (document.querySelector('[data-logo-slot] svg') || {}).outerHTML || '' }), el('span', { class: 'wordmark', text: 'Boards' }));
    const bar = el('header', { class: 'appbar chrome v-bar' },
      brand,
      el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' }), crumb,
      el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' }),
      el('span', { class: 'stepper' }, prevBtn, posEl, nextBtn),
      nameEl, el('div', { class: 'spacer' }), venue3d.cams, clearBtn, filesBtn, extras, venue3d.dims,
      el('span', { class: 'bar-group' }, dlBtn, zoomBtn),
      WB.themeButton(), doneBtn);
    // On a phone there is no room for the panel's brush: the viewer's own few tools sit along the bottom.
    const tools = el('nav', { class: 'chrome v-tools' });
    const root = el('div', { class: `viewer${opts.locked ? ' locked' : ''}`, hidden: true }, stage, bar, film, filmTab, filmGrip, timeline, panel, cpTab, tools);
    if (opts.locked) brand.removeAttribute('href');
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
    let soundWanted = true;
    // Following somebody's video (followMedia): a phone, and the catch-up waiting for a video to be able to play.
    const coarse = matchMedia('(pointer: coarse)').matches;
    const followWait = new WeakMap();
    const clearFollowWait = (video) => {
      const go = followWait.get(video);
      if (!go) return;
      followWait.delete(video);
      video.removeEventListener('playing', go);
      video.removeEventListener('canplay', go);
    };
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
      pieces = (opts.media() || []).filter((p) => p && (p.type === 'image' || p.type === 'video')).map(withFile);
      notes = can.read() ? (opts.notes() || []) : [];
    }

    // ---- a version's extras
    //
    // A piece filed as a version may have more files than its own: the version's own file and its extras
    // (full-size stills, another lighting), each `ex`, its label ('' for the version's own). One of them is
    // shown in the piece's place, chosen in the strip (where they are listed under the piece while it is
    // open) or with [ and ]; the piece's own until then. What is said on one is said on it (`ex` on a
    // comment), so each has its own comments and drawings.
    const shownFile = new Map(); // piece id -> the `ex` of the file shown in its place
    const FILE_KEYS = [...MEDIA_KEYS, 'lo', 'full', 'shownPass'];
    const filesOf = (p) => (p.files && p.files.length > 1 ? p.files
      : p.extras && p.extras.length ? [{ ex: '' }, ...p.extras.map((x) => ({ ...x, ex: x.label }))] : null);
    function withFile(p) {
      const files = filesOf(p);
      if (!files) return p;
      const own = p.ex || '';
      const want = shownFile.has(p.id) ? shownFile.get(p.id) : own;
      const f = files.find((x) => x.ex === want);
      // Its own (as the host gives it), the others in the version's order after it: the order they are
      // listed and stepped through.
      const mine = { ex: own };
      for (const k of FILE_KEYS) if (p[k] !== undefined) mine[k] = p[k];
      const fileList = [mine, ...files.filter((x) => x.ex !== own)];
      if (!f || want === own) return { ...p, fileList, shownEx: own };
      const out = { ...p, fileList, shownEx: want };
      for (const k of FILE_KEYS) delete out[k];
      for (const k of MEDIA_KEYS) if (f[k] !== undefined) out[k] = f[k];
      out.src = WB.playable(f);
      out.full = f.src;
      return out;
    }
    // Whether a comment is on what is shown: the piece open, and the one of its files in its place.
    const onShown = (c) => !!open && c.on === open.id && (c.ex || '') === (open.shownEx || '');
    // What a file of a piece is called in the strip: an extra by its label, the version's own by what it is.
    const fileName = (f) => f.ex || (f.type === 'video' ? 'Video' : f.type === 'image' ? 'Image' : 'Its own');
    // Shows another of the open piece's files in its place. Two of one shape (one frame at another size,
    // another lighting of it) are looked at the same way: flipping between them keeps the view where it
    // was, zoomed in as far and on the same spot. One of another shape is fitted, as a piece opened is.
    function showFile(ex, { followed = false } = {}) {
      if (!open || !open.fileList || (open.shownEx || '') === ex || !open.fileList.some((f) => f.ex === ex)) return false;
      if (!followed) interact();
      const before = { s: cam.s, x: cam.x, y: cam.y, w: W, h: H, fitted: !zoomed() };
      shownFile.set(open.id, ex);
      readHost();
      const now = pieces.find((p) => p.id === open.id);
      if (!now) return false;
      leavePiece(open);
      activeThread = null;
      open = now;
      mount(now);
      if (in3d && !has3d()) set3d(false);
      paintDims();
      document.body.classList.toggle('focus-video', now.type === 'video');
      paintAll();
      layout();
      if (!in3d && !before.fitted && Math.abs(W / H - before.w / before.h) < 0.005) {
        cam.s = (before.s * before.w) / W;
        cam.x = before.x;
        cam.y = before.y;
        applyCam();
      } else fit();
      emit('file', open.id, ex);
      return true;
    }
    function filesMenu() {
      if (!open || !open.fileList) return;
      WB.menu(filesBtn, open.fileList.map((f) => {
        const on = f.ex === (open.shownEx || '');
        return el('button', {
          type: 'button', class: `menu-item menu-check${on ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(on),
          onclick: (e) => {
            e.preventDefault();
            WB.closeMenus();
            showFile(f.ex);
          },
        }, el('span', { class: 'menu-tick', html: on ? ICON.check : '' }), el('span', { text: fileName(f) }));
      }));
    }
    function stepFile(dir) {
      if (!open || !open.fileList) return;
      const list = open.fileList.map((f) => f.ex);
      const i = list.indexOf(open.shownEx || '');
      showFile(list[(((i + dir) % list.length) + list.length) % list.length]);
    }

    // `followed` is true when it opens because the person being followed opened it.
    function show(id, { followed = false, thread = null } = {}) {
      // A thread picked is shown on the file of the piece it was written on.
      const about = thread && (opts.notes() || []).find((c) => c.id === thread);
      if (about && about.on === id) shownFile.set(id, about.ex || '');
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
      // The player always opens on the picture itself (2D); 3D is a switch away. A piece that cannot be seen
      // on the model is shown as it is.
      if (in3d && !has3d()) set3d(false);
      // Opened again in this tab, it opens as it was left: in 3D, where the view was (a comment picked
      // goes where it was made instead, and somebody followed is seen as they see it).
      if (!was && !followed && !thread) recall3d();
      paintDims();
      warm3d();
      document.body.classList.toggle('focus-video', piece.type === 'video');
      paintAll();
      layout();
      fit();
      if (thread) pickThread(thread);
      if (opts.onOpen) opts.onOpen(id);
      emit('open', id);
      return true;
    }

    function close() {
      if (!open) return;
      remember3d();
      const was = open;
      leavePiece(was);
      switchTyped(was.id, null);
      // Opened again, a piece shows its own file.
      shownFile.clear();
      open = null;
      activeThread = null;
      if (media) media.remove();
      unload(media);
      media = null;
      pieceBox.replaceChildren();
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
      emit('close');
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
        media = makeVideo(piece);
        // Open, it is scrubbed and stepped through: worth having all of it. Held back a moment so stepping
        // quickly past videos does not start fetching every one of them.
        wholeTimer = setTimeout(() => holdWhole(piece), 300);
      } else {
        media = el('img', { alt: piece.name || '', draggable: 'false', decoding: 'async', src: piece.prev || piece.src });
      }
      arrange();
      if (old !== media) unload(old);
    }

    // What the piece box holds: the picture at its own size, or, in 3D, the venue drawn at the shape of the
    // frame the view holds over the picture (which plays on unseen, and is what the venue shows).
    function sizeBox() {
      if (in3d && three) {
        W = 1600;
        H = Math.round(W / three.aspect());
      } else {
        W = open.nw || 1000;
        H = open.nh || W * 0.5625;
      }
      pieceBox.style.width = `${W}px`;
      pieceBox.style.height = `${H}px`;
      ink.setAttribute('viewBox', `0 0 ${UNITS} ${(UNITS * H) / W}`);
    }
    function arrange() {
      if (!open) return;
      const as3d = in3d && !!three;
      sizeBox();
      // In 3D the venue fills the stage, under the piece box, which keeps the frame held (and what is drawn
      // in it) but shows nothing of its own.
      pieceBox.replaceChildren(media, ink);
      root.classList.toggle('in3d', as3d);
      if (as3d) {
        if (three.canvas.parentNode !== stage) stage.prepend(three.canvas);
        three.setSource(media);
        three.start();
      } else venue3d.putAway();
    }

    // ---- 3D: the piece on the project's model of its venue (view3d.js, through venue above)

    let in3d = false;
    let three = null; // the page's 3D view, while it is lent to this player (see venue)
    let busy3d = false; // following somebody into 3D (see follow3d)
    let next3d = null;
    // An extra shown in a piece's place is looked at as it is, never on the venue.
    const has3d = () => !!(opts.view3d && opts.view3d.model) && (!opts.can3d || (!!open && opts.can3d(open))) && !(open && (open.shownEx || '') !== (open.ex || ''));
    // A piece that can be seen on the model open, the venue is fetched and made ready a moment after, so the
    // switch is there at once (the piece's own picture comes first).
    function warm3d() {
      if (has3d()) venue3d.prepare(opts.view3d, 1500);
    }
    async function set3d(on) {
      on = !!on && has3d() && !!open;
      if (on === in3d) return;
      if (on) {
        // Not fetched ahead yet (see warm3d): how far it has come is on the switch till it is there.
        three = await venue3d.ready();
        if (!three || !open) return;
      }
      // A drawing half made belongs to the view it was made in.
      if (draft && draft.strokes.length) {
        discardDrawing();
        toast('The drawing was taken away: it was made in the other view', { ms: 3500 });
      }
      in3d = on;
      if (three) three.goTo('main', false);
      if (opts.onMode3d) opts.onMode3d(on);
      emit('3d');
      arrange();
      layout();
      fit();
      paintDims();
      paintAll();
    }
    // The view goes to another frame (a camera of the model's, a comment's place: see view3d.js), and the
    // piece box takes its shape.
    const look = (pov, animate = true) => venue3d.look(pov, animate);
    // In 3D a comment is made from where the view is: the moment one is begun (the pen taken up, the box
    // clicked into, a comment sent), the view holds still there, framed 16:9, and that frame goes with the
    // comment. A drawing begun already keeps the frame it was begun in, and the view goes back to it.
    function holdForComment() {
      if (!in3d || !three || !open) return;
      if (draft && draft.on === open.id && draft.pov && typeof draft.pov === 'object') look(draft.pov);
      else look();
    }
    const povHere = () => (in3d && three ? three.pose() : null);

    // Where the venue was last seen from in this tab is kept as the player closes, and as the page goes (venue).
    const remember3d = () => venue3d.remember();
    window.addEventListener('pagehide', () => { if (open) remember3d(); });
    function recall3d() {
      const id = open.id;
      return venue3d.recall(() => !!open && open.id === id);
    }
    const paintDims = () => venue3d.paint();
    // Made in 3D, a drawing is seen from where it was drawn only; drawn on the picture, on the picture only.
    const drawnHere = (c) => (c.pov ? in3d && !!three && three.at(c.pov) : !in3d);

    function makeVideo(piece) {
      const video = el('video', { playsinline: '', preload: 'auto' });
      video.muted = !soundWanted;
      video.loop = looping;
      if (piece.poster || piece.th) video.poster = piece.poster || piece.th;
      video.src = piece.src;
      const mine = () => media === video;
      for (const type of ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange']) video.addEventListener(type, () => { if (!mine()) return; syncTimeline(); if (type !== 'timeupdate') { paintMarks(); paintInk(); } });
      for (const type of ['progress', 'suspend']) video.addEventListener(type, () => { if (mine()) syncLoaded(); });
      for (const type of ['play', 'pause', 'volumechange']) video.addEventListener(type, () => { if (!mine()) return; syncTimeline(); paintInk(); });
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
        // Another pass of the same version is the same moment seen another way: it stays on that moment.
        if (now.src !== open.src || now.type !== open.type) {
          const was = videoOpen();
          // The same video in another copy (its phone copy arriving) stays on its moment, as another view does.
          const sameVideo = now.type === open.type && !!now.full && now.full === open.full;
          const keepAt = was && (now.shownPass !== open.shownPass || sameVideo) ? whereOf(was) : null;
          leavePiece(open);
          open = now;
          mount(now);
          layout();
          fit();
          const video = videoOpen();
          if (video && keepAt != null) video.addEventListener('loadedmetadata', () => goTo(video, keepAt), { once: true });
        } else {
          open = now;
        }
        if (activeThread && !noteById(activeThread)) activeThread = null;
        if (editingId && !noteById(editingId)) editingId = null;
        paintAll();
      });
    }

    function paintAll() {
      if (!open) return;
      // Shown one of several ways: which, since a shot without the pass chosen shows its main one. An
      // extra shown is said by its label.
      const way = open.shownEx || (open.passNames && open.passNames.length > 1 ? open.shownPass || 'main' : '');
      nameEl.textContent = [open.label || open.name || (open.type === 'video' ? 'Video' : 'Image'), way].filter(Boolean).join(' · ');
      // A version's file name is still there, on a hover over its label.
      nameEl.title = open.label && open.name && open.name !== open.label ? open.name : '';
      crumb.textContent = opts.title ? opts.title() : '';
      // Shown whenever the host downloads, and only greyed out for what is not an upload of the team's, so
      // the bar does not shift as the pieces change.
      dlBtn.hidden = !opts.download;
      dlBtn.disabled = !WB.media.keepable(open.src);
      dlBtn.title = dlBtn.disabled ? 'Nothing to download' : 'Download the original media';
      filesBtn.hidden = !open.fileList;
      clearBtn.hidden = !opts.clear || !can.member();
      clearBtn.disabled = !plainDrawings().length;
      timeline.hidden = open.type !== 'video';
      paintFilm();
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
    function layout() {
      const below = timeline.hidden ? 0 : timeline.offsetHeight + 12;
      const top = bar.offsetHeight || 48;
      pad = narrow()
        ? { t: top + 16, r: 12, b: bottomChrome() + 12, l: 12 }
        : { t: top + 24, r: (panel.hidden ? 0 : panel.offsetWidth) + 40, b: 32 + below, l: (filmOff || !shown(film) ? 0 : film.offsetWidth) + 40 };
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
      emit('zoom');
      // Fitted, an icon; zoomed in, how far, which is worth reading.
      const z = zoomed() ? `${Math.round((cam.s / actualS()) * 100)}%` : '';
      if (zoomBtn.dataset.z !== z) {
        zoomBtn.dataset.z = z;
        if (z) zoomBtn.textContent = z;
        else zoomBtn.innerHTML = ICON.fit;
        zoomBtn.title = z ? `At ${z}. Click to fit to the screen` : 'Fitted to the screen. Click for actual size';
      }
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
    dragEdge(filmGrip, (x) => setFilmWidth(x - film.getBoundingClientRect().left, false), () => setFilmWidth(film.offsetWidth));
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
      const fileCount = new Map(); // the open piece's, by file
      for (const c of roots()) {
        if (c.done) continue;
        openCount.set(c.on, (openCount.get(c.on) || 0) + 1);
        if (c.on === open.id) fileCount.set(c.ex || '', (fileCount.get(c.ex || '') || 0) + 1);
      }
      // The piece itself is the first of its files: its own, in the strip as a piece always is. The rest
      // are under it while it is open, set in under its number.
      const files = open.fileList ? open.fileList.slice(1) : [];
      const ownOf = (p) => (p.fileList ? { ...p, ...p.fileList[0] } : p);
      const sig = [...pieces.map((p) => `${p.id} ${stillOf(ownOf(p))} ${openCount.get(p.id) || 0} ${p.label || p.name || ''}`),
        open.id, fileCount.get(open.fileList ? open.fileList[0].ex : '') || 0, ...files.map((f) => `${f.ex} ${stillOf(f)} ${fileCount.get(f.ex) || 0}`)].join('|');
      const thumb = (p, still, n) => el('span', { class: 'fs-thumb', style: { aspectRatio: String(clamp((p.nw || 16) / (p.nh || 9), 0.6, 2.4)) } },
        still && el('img', { src: still, alt: '', decoding: 'async', draggable: 'false' }),
        p.type === 'video' && el('span', { class: 'fs-badge', html: ICON.play }),
        n && el('span', { class: 'fs-count', text: String(n), title: n > 1 ? `${n} open comments` : '1 open comment' }));
      const kindOf = (p) => {
        const kind = p.type === 'video' ? 'Video' : 'Image';
        return p.type === 'video' && p.dur ? `${kind} · ${fmtTime(p.dur)}` : kind;
      };
      if (sig !== filmSig) {
        filmSig = sig;
        film.replaceChildren(...pieces.flatMap((p, i) => {
          // An open piece showing another of its files keeps its own still here.
          const own = ownOf(p);
          const n = p.id === open.id && p.fileList ? fileCount.get(p.fileList[0].ex) : openCount.get(p.id);
          const kind = p.type === 'video' ? 'Video' : 'Image';
          const item = el('button', { class: 'fs-item', 'data-id': p.id, title: p.label || p.name || kind, onclick: () => (p.id === open.id && p.fileList ? showFile(p.fileList[0].ex) : show(p.id)) },
            el('span', { class: 'fs-num', text: String(i + 1) }),
            thumb(own, stillOf(own), n),
            el('span', { class: 'fs-label' },
              el('span', { class: 'fs-name', text: p.label || p.name || kind }),
              el('span', { class: 'fs-kind', text: p.fileList ? fileName(p.fileList[0]) : kindOf(p) })));
          if (p.id !== open.id || !files.length) return [item];
          return [item, ...files.map((f) => el('button', { class: 'fs-item fs-sub', 'data-id': p.id, 'data-ex': f.ex, title: fileName(f), onclick: () => showFile(f.ex) },
            el('span', { class: 'fs-num' }),
            thumb(f, stillOf(f), fileCount.get(f.ex)),
            el('span', { class: 'fs-label' },
              el('span', { class: 'fs-name', text: fileName(f) }),
              el('span', { class: 'fs-kind', text: f.ex ? kindOf(f) : 'Its own file' }))))];
        }));
        recentre = true;
      }
      const i = pieces.findIndex((p) => p.id === open.id);
      posEl.textContent = `${i + 1} / ${pieces.length}`;
      posEl.style.minWidth = `${String(pieces.length).length * 2 + 3}ch`;
      prevBtn.disabled = nextBtn.disabled = pieces.length < 2;
      for (const node of film.children) {
        // Of a piece with more files than its own, the one shown; of any other, the piece.
        const current = node.dataset.id === open.id && (open.fileList ? (node.dataset.ex ?? open.fileList[0].ex) === (open.shownEx || '') : true);
        node.classList.toggle('holds', node.dataset.id === open.id && !current && node.dataset.ex === undefined);
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
      if (video) video.loop = on;
      tlLoop.classList.toggle('active', on);
      tlLoop.setAttribute('aria-pressed', String(on));
      tlLoop.title = on ? 'Looping: starts again at the end. Click to stop at the end' : 'Stops at the end. Click to loop';
    }
    setLooping(looping);
    const tlTime = el('button', { class: 'tl-time', text: '0:00', title: 'Show minutes and seconds, frame number or timecode', onclick: cycleTimeMode });
    const tlMarks = el('div', { class: 'tl-marks' });
    const tlTip = el('span', { class: 'tl-tip', hidden: true });
    const tlLoaded = el('i', { class: 'tl-loaded' });
    const tlWave = el('canvas', { class: 'tl-wave', width: 480, height: 80 });
    const tlTrack = el('div', { class: 'tl-track' }, tlWave, el('i', { class: 'tl-rail' }, tlLoaded, el('i', { class: 'tl-played' })), tlMarks, el('i', { class: 'tl-head' }), tlTip);
    timeline.append(tlPlay,
      el('button', { class: 'iconbtn tl-step', html: ICON.frameBack, title: 'Back one frame ( , )   With Shift, one second', onclick: (e) => stepFrame(-1, e.shiftKey) }),
      el('button', { class: 'iconbtn tl-step', html: ICON.frameFwd, title: 'Forward one frame ( . )   With Shift, one second', onclick: (e) => stepFrame(1, e.shiftKey) }),
      tlTime, tlTrack, tlLoop, tlSound);
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
      if (!open || !video) return;
      if (at == null) at = whereOf(video);
      const dur = video.duration;
      if (changing.has(video) && !(dur > 0)) return;
      const fps = fpsOf(open.id);
      tlTrack.style.setProperty('--p', `${(dur > 0 && isFinite(dur) ? clamp(at / dur, 0, 1) : 0) * 100}%`);
      const label = timeLabel(at, dur, fps);
      if (tlTime.textContent !== label) tlTime.textContent = label;
      const playing = !video.paused;
      const state = `${!playing}${video.muted}`;
      if (timeline.dataset.state !== state) {
        timeline.dataset.state = state;
        tlPlay.innerHTML = playing ? ICON.pause : ICON.play;
        tlSound.innerHTML = video.muted ? ICON.muted : ICON.sound;
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
      if (!open || !video) return;
      emit('media', open.id, !video.paused, whereOf(video));
      if (opts.onMedia) opts.onMedia(open.id, !video.paused, whereOf(video));
    }
    function togglePlay() {
      const video = videoOpen();
      if (!video) return;
      interact();
      if (video.paused) video.play().catch(() => {});
      else video.pause();
      told();
    }
    function toggleSound() {
      const video = videoOpen();
      if (video) video.muted = !video.muted;
    }
    function stepFrame(dir, second = false) {
      const video = videoOpen();
      if (!video) return;
      interact();
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
      video.pause();
      goTo(video, at);
      told();
    }
    // Stops the video on the frame it is showing, so what is made on it next belongs to that frame.
    function holdFrame() {
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
      const video = videoOpen();
      return video && video.duration > 0 && isFinite(video.duration) ? video : null;
    };
    function trackMoment(e) {
      const video = videoOpen();
      const r = tlTrack.getBoundingClientRect();
      const k = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      return { k, at: wholeFrame(k * video.duration) };
    }
    function scrubTo(e) {
      const { at } = trackMoment(e);
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
      scrub = { pid: e.pointerId, resume: !video.paused };
      video.pause();
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
      tlTip.textContent = fmtMoment(at, fpsOf(open.id));
      tlTip.style.left = `${k * 100}%`;
      if (scrub && e.pointerId === scrub.pid) scrubTo(e);
    });
    tlTrack.addEventListener('click', (e) => {
      if (!dragFromMark) return;
      dragFromMark = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    const endScrub = (e) => {
      if (markPress && e.pointerId === markPress.pid) markPress = null;
      if (!scrub || e.pointerId !== scrub.pid) return;
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
      const video = videoOpen();
      const dur = video ? video.duration : 0;
      if (!video || !(dur > 0) || !isFinite(dur)) return void tlMarks.replaceChildren();
      const leftOf = (at) => `${clamp(at / dur, 0, 1) * 100}%`;
      const stacks = new Map();
      for (const c of roots()) {
        if (!onShown(c)) continue;
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
      if (!c || !Array.isArray(c.drawing) || !onShown(c) || !drawnHere(c)) return false;
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
        if (in3d) holdForComment();
        draft = { id: uid(), on: open.id, strokes: [], ...(povHere() && { pov: povHere() }) };
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
        if (!draft || draft.on !== open.id) {
          if (in3d) holdForComment();
          draft = { id: uid(), on: open.id, strokes: [], ...(povHere() && { pov: povHere() }) };
        }
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
        if (laserOut.length && open) {
          const pts = laserOut.splice(0);
          if (opts.onLaser) opts.onLaser(open.id, pts);
          emit('laser', open.id, pts);
        }
        laserOut.length = 0;
      }, 25);
    }

    // ---- tools: the brush, the eraser, the laser, and the hand

    function setTool(name) {
      if ((name === 'pen' || name === 'eraser') && in3d && three && can.draw()) holdForComment();
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
      if (!open || locked()) return;
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
    const composer = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Comment on this', 'aria-label': 'Comment' });
    const replyBox = el('textarea', { rows: 1, maxlength: 2000, placeholder: 'Reply…', 'aria-label': 'Reply' });
    const editBox = el('textarea', { rows: 1, maxlength: 2000, 'aria-label': 'Edit comment' });
    // In 3D, beginning to write a comment holds the view where it is (see holdForComment).
    composer.addEventListener('focus', () => holdForComment());
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
      el('div', { class: 'cp-actions' }, cpPen, momentChip, drawnChip, el('button', { class: 'btn small primary', text: 'Send', title: 'Send (Enter)', onclick: submitComment })));

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
      // Said as the animatic's page says it: what the comment is on, by name.
      composer.placeholder = strokes ? 'Say what the drawing is about…' : `Comment on ${(open && open.label) || 'this'}`;
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
          first && Array.isArray(c.drawing) && el('span', { class: 'msg-drawn', title: c.pov ? 'Has a drawing, made in 3D. Pick the thread to see it from where it was drawn' : 'Has a drawing on the picture. Pick the thread to see it' }, el('span', { html: ICON.scribble }), c.pov ? 'Drawing in 3D' : 'Drawing'),
          first && c.pov && !Array.isArray(c.drawing) && el('span', { class: 'msg-drawn', title: 'Made in 3D. Pick the thread to see it from where it was made' }, el('span', { html: ICON.focus }), 'In 3D')));
    }

    function threadCard(c, mentions) {
      const active = activeThread === c.id;
      return el('div', {
        class: `cp-card${active ? ' active' : ''}${c.done ? ' done' : ''}`, 'data-id': c.id,
        onclick: (e) => { if (!e.target.closest('button, a, textarea')) pickThread(c.id); },
      },
      messageNode(c, c, mentions),
      repliesOf(c.id).map((r) => messageNode(r, c, mentions)),
      active && can.write() && el('div', { class: 'cp-reply' }, replyBox, el('button', { class: 'btn small ghost', text: 'Reply', title: 'Send (Enter)', onclick: submitReply })));
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
      let list = roots().filter(onShown);
      const openN = list.filter((c) => !c.done).length;
      cpTabCount.hidden = !openN;
      cpTabCount.textContent = String(openN);
      if (!shown) return;
      const any = list.length > 0;
      if (hideDone) list = list.filter((c) => !c.done);
      if (open.type === 'video') list.sort((a, b) => (momentOf(a) ?? -1) - (momentOf(b) ?? -1) || byTime(a, b));
      cpCount.hidden = !openN;
      cpCount.textContent = String(openN);
      const empty = any ? [ICON.check, 'All resolved'] : [ICON.comment, 'Nothing said about this yet'];
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
      emit('thread', activeThread);
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
      if ((rootNote.ex || '') !== (open.shownEx || '')) showFile(rootNote.ex || '');
      // It is seen from where it was made: in 3D from the place it was made at, or, drawn on the picture, on
      // the picture.
      if (rootNote.pov && has3d()) {
        if (!in3d) set3d(true).then(() => look(rootNote.pov, false));
        else look(rootNote.pov);
      } else if (!rootNote.pov && Array.isArray(rootNote.drawing) && in3d) set3d(false);
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
      const c = { id: drawn ? drawn.id : uid(), type: 'comment', text: text.slice(0, 2000), name: me().name, color: me().color, t: Date.now(), done: false, on: open.id, ...(open.shownEx && { ex: open.shownEx }) };
      if (drawn) {
        if (drawn.at != null) c.at = drawn.at;
        if (drawn.fr != null) c.fr = drawn.fr;
        c.drawing = drawn.strokes;
        if (drawn.pov) c.pov = drawn.pov;
      } else {
        stampMoment(c);
        // Written in 3D, it is about what the view shows: that frame goes with it.
        if (in3d && three) {
          holdForComment();
          if (povHere()) c.pov = povHere();
        }
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
    // Space plays even when a control clicked a moment ago (a dropdown in the bar, a button) still has the
    // keyboard (WB.heldControl).
    const { isTyping, heldControl } = WB;
    window.addEventListener('keydown', (e) => {
      let released = false;
      if (open && e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey && heldControl(e.target) && !document.querySelector('dialog[open]')
        && root.contains(e.target)) {
        e.target.blur();
        released = true;
      }
      if (!open || (!released && isTyping(e.target)) || document.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase();
      // Following somebody who presents, only what is this screen's own is in reach: the sound, and the
      // strip and the comments put away or back. Everything else is theirs to do.
      if (locked()) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (k === 'm' && !e.shiftKey) toggleSound();
        else if (k === 'f' && e.shiftKey) toggleFilm();
        else if (k === 'c' && e.shiftKey && can.read()) togglePanel();
        else if (e.code !== 'Space' && !k.startsWith('arrow')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // The venue's keys: W A S D Q E fly (unless a pen is in hand), V goes on to the next camera, and 2 and 3
      // switch between the picture and the venue (venue, above).
      if (venue3d.key(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Enter works a button that has the keyboard; Space always plays and pauses, even when a button
      // clicked a moment ago still has it.
      if (k === 'enter' && e.target.closest && e.target.closest('button, a[href], input')) return;
      // A key the player takes is the player's, so whatever was clicked a moment ago lets go of it rather
      // than being rung in blue (even the card behind the player that opened it).
      const done = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
        WB.letGo();
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
      // A piece's other files (its version's extras) have keys of their own, so the arrows still go
      // from piece to piece.
      if ((e.key === '[' || e.key === ']') && open.fileList) {
        stepFile(e.key === ']' ? 1 : -1);
        return done();
      }
      if ((e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) || k === 'home') fit();
      else if (k === 'escape') {
        if (tool !== 'pan') setTool('pan');
        else close();
      } else if (k === 'f' && e.shiftKey) toggleFilm();
      else if (k === 'c' && e.shiftKey) { if (can.read()) togglePanel(); }
      else if (k === 'c' && !e.shiftKey) startComment();
      else if (videoOpen() && (k === 'k' || k === 'enter')) togglePlay();
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
      if (e.code !== 'Space' || !spaceDown || locked()) return;
      e.preventDefault();
      const tapped = spaceTap && performance.now() - spaceAt < 400;
      spaceDown = false;
      spaceTap = false;
      root.classList.remove('space-held');
      if (open && tapped && videoOpen()) togglePlay();
    }, true);
    window.addEventListener('blur', () => {
      spaceDown = false;
      root.classList.remove('space-held');
    });
    // Text pasted while a piece is open is on its way into a comment.
    window.addEventListener('paste', (e) => {
      if (!open || isTyping(e.target) || locked()) return;
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
        root.classList.toggle('locked', !!next.locked);
        // Following somebody who presents, the corner is no way out.
        if (next.locked) brand.removeAttribute('href');
        else brand.setAttribute('href', '/');
      },
      // The sound, as this screen wants it (somebody watching a presentation chooses theirs).
      sound(on) {
        soundWanted = !!on;
        const video = videoOpen();
        if (video) video.muted = !soundWanted;
      },
      prepare3d: (setting) => venue3d.prepare(setting),
      // Hears what the player does, whatever host it has; returns how to stop.
      watch(fn) {
        watchers.add(fn);
        return () => watchers.delete(fn);
      },
      host: () => opts,
      refresh,
      isOpen: () => !!open,
      current: () => (open ? open.id : null),
      // Which of the open piece's files is shown in its place ('' its version's own; see showFile), and
      // the one somebody followed shows.
      file: () => (open ? open.shownEx || '' : null),
      followFile: (ex) => !!open && showFile(ex, { followed: true }),
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
          if (c && !c.re && c.on === open.id && (c.ex || '') !== (open.shownEx || '')) showFile(c.ex || '', { followed: true });
          const next = c && !c.re && onShown(c) ? c.id : null;
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
        if (!open || open.id !== id) return;
        const video = videoOpen();
        if (!video) return;
        // Stopped, it is on their frame exactly. Playing, a little behind or ahead is made up by playing a
        // touch quicker or slower (a tenth at most, which nobody hears) rather than by jumping, which shows;
        // only a second or more off, or starting to play, is gone to at once.
        //
        // A video still finding its moment, or waiting for more of itself to arrive (a phone on a mobile
        // network, scrubbing through what it has not got yet), is not asked for another moment on top: each
        // one would throw away what it was getting, and it would never catch up. It goes, once, to where
        // they are by then, as soon as it can play. A phone (a coarse pointer) is not sped up or slowed down
        // either: some of their browsers stop showing new frames when that changes while playing.
        clearFollowWait(video);
        if (!playing) {
          video.playbackRate = 1;
          if (Math.abs(whereOf(video) - time) > 0.001) goTo(video, time);
        } else if (!video.paused && (video.seeking || bound.has(video) || video.readyState < 3)) {
          const asked = performance.now();
          const go = () => {
            clearFollowWait(video);
            if (videoOpen() !== video || video.paused) return;
            const now = time + (performance.now() - asked) / 1000;
            if (Math.abs(whereOf(video) - now) > (coarse ? 0.5 : 0.25)) goTo(video, now);
          };
          followWait.set(video, go);
          video.addEventListener('playing', go, { once: true });
          video.addEventListener('canplay', go, { once: true });
        } else {
          let drift = time - whereOf(video);
          const dur = video.duration;
          if (video.loop && dur > 0 && isFinite(dur) && Math.abs(drift) > dur / 2) drift -= Math.sign(drift) * dur;
          if (video.paused || Math.abs(drift) > (coarse ? 0.5 : 1)) {
            video.playbackRate = 1;
            goTo(video, time);
          } else video.playbackRate = coarse || Math.abs(drift) < 0.04 ? 1 : clamp(1 + drift * 0.25, 0.9, 1.1);
        }
        // A browser that will not play sound unasked plays it without, and says so.
        if (playing) {
          video.play().catch(() => {
            if (video.muted || videoOpen() !== video) return;
            video.muted = true;
            soundWanted = false;
            emit('muted');
            video.play().catch(() => {});
          });
        } else video.pause();
        syncTimeline();
      },
      // How far into the piece the view is: its middle, in drawing units, and how many times the fit it is
      // shown at. Null when it is fitted.
      zoom() {
        if (!open || !zoomed()) return null;
        const mid = toUnits(pad.l + (innerWidth - pad.l - pad.r) / 2, pad.t + (innerHeight - pad.t - pad.b) / 2);
        const r = (v) => Math.round(v * 10) / 10;
        return [r(mid.x), r(mid.y), Math.round((cam.s / fitS()) * 1000) / 1000];
      },
      // Shows the piece as somebody else has it, as far in and on the same middle, whatever this window's shape.
      followZoom(z) {
        if (!open) return;
        if (!Array.isArray(z)) return void fit();
        const s = clamp(fitS() * z[2], fitS(), maxS());
        cam.s = s;
        cam.x = pad.l + (innerWidth - pad.l - pad.r) / 2 - (z[0] / units()) * s;
        cam.y = pad.t + (innerHeight - pad.t - pad.b) / 2 - (z[1] / units()) * s;
        applyCam();
      },
      // In 3D, how it is seen: { on, c: the model's camera held, q: a comment's frame held, f: flown, at }.
      // Null in 2D, or where there is no 3D.
      view3d() {
        if (!in3d || !three) return null;
        const f = three.flight();
        if (f) return { on: 1, f };
        const c = three.camera();
        if (c >= 0) return { on: 1, c };
        const q = three.pose();
        return q ? { on: 1, q } : { on: 1 };
      },
      // Sees it as somebody else does: in 2D or 3D, through the same camera, frame or flight. What comes in
      // while the model is still loading waits, and the latest of it is what is shown.
      follow3d(d) {
        next3d = { d };
        if (busy3d) return;
        busy3d = true;
        (async () => {
          while (next3d) {
            const { d: x } = next3d;
            next3d = null;
            const on = !!(x && x.on) && has3d();
            if (on !== in3d) await set3d(on);
            if (!on || !in3d || !three) continue;
            if (x.f) three.steer(x.f);
            else if (Number.isInteger(x.c)) look(x.c);
            else if (x.q) look(x.q);
            paintDims();
            paintInk();
          }
        })().finally(() => { busy3d = false; });
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
      // What is shown, for somebody presenting it: the host's own word for it, if it has one.
      scene: () => (open && opts.scene ? opts.scene() : null),
    };
  }

  // ---------------------------------------------------------------- a version's passes
  //
  // A version may be shown more than one way: the unwrapped picture (cmp, vr) and how it looks projected
  // (bty, or bty-left, top, side...), each its own file. Its look is the main one, with the others in
  // `passes`. Most have none, and then nothing here is ever seen.
  const MEDIA_KEYS = ['type', 'src', 'orig', 'prev', 'pw', 'th', 'poster', 'nw', 'nh', 'fps', 'dur', 'wf', 'name'];
  // Its passes' names, the main one first ('' when the main one has none).
  const passesOf = (look) => [look.pass || '', ...(look.passes || []).map((v) => v.pass)];
  // The look of a version as seen in `pass`: that pass's file, or the main one's when it has none of that
  // name. `shownPass` says which it is.
  function inPass(look, pass) {
    const { passes, ...main } = look;
    const pick = pass && pass !== main.pass && (passes || []).find((v) => v.pass === pass);
    if (!pick) return { ...main, shownPass: main.pass || '', passNames: passesOf(look) };
    const out = { ...main };
    for (const k of MEDIA_KEYS) delete out[k];
    return { ...out, ...pick, name: pick.name || main.name, shownPass: pick.pass, passNames: passesOf(look) };
  }
  // A pass's name as shown: the main one (a version's own file, with no pass named) by the name the
  // project gives its main pass, if it has named its passes.
  const passLabel = (name, list) => name || (list && list[0]) || 'Main';
  // The choices of what the player shows (which pass), as one button in the bar that opens them as a menu,
  // rather than a row of dropdowns. `groups()` says them as they are now: [{ name, value, def, options:
  // [[value, label]], pick(value) }]; a group with one option is no choice and is left out. The button
  // counts the groups not at their default, and its tip says what each is at.
  function optionsButton(groups, { title = 'What to show' } = {}) {
    const count = el('span', { class: 'v-opts-n', hidden: true });
    const btn = el('button', { class: 'iconbtn v-opts', html: ICON.pick, 'aria-haspopup': 'menu', 'aria-label': title }, count);
    const shown = () => groups().filter((g) => g.options.length > 1);
    const labelOf = (g) => (g.options.find(([v]) => v === g.value) || [null, ''])[1];
    function paint() {
      const list = shown();
      const n = list.filter((g) => g.value !== g.def).length;
      count.hidden = !n;
      count.textContent = String(n);
      btn.hidden = !list.length;
      btn.title = [title, ...list.map((g) => `${g.name}: ${labelOf(g)}`)].join('\n');
    }
    btn.addEventListener('click', () => {
      WB.menu(btn, shown().flatMap((g) => [
        el('div', { class: 'menu-head', text: g.name }),
        ...g.options.map(([v, label]) => el('button', {
          type: 'button', class: `menu-item menu-check${v === g.value ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(v === g.value),
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            WB.closeMenus();
            if (v !== g.value) g.pick(v);
            paint();
          },
        }, el('span', { class: 'menu-tick', html: v === g.value ? ICON.check : '' }), el('span', { text: label }))),
      ]), { cls: 'v-opts-menu' });
    });
    btn.paint = paint;
    paint();
    return btn;
  }
  // Which pass of each version: a group for optionsButton (a way of seeing, not a filter, so not counted).
  // `list` is the project's passes as its settings name them, the main one first: they are shown in its order.
  const passGroup = (names, value, pick, list = null) => {
    const at = (n) => (list ? (n === '' || n === list[0] ? -1 : list.indexOf(n) === -1 ? 99 : list.indexOf(n)) : 0);
    const shown = [...names].sort((a, b) => at(a) - at(b));
    return { name: 'Pass', value, def: value, options: shown.map((n) => [n, passLabel(n, list)]), pick };
  };

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
  // `title` is where the entity is (its project), for the bar.
  // Somebody watching a presentation (watch.js) has it `follow`ed instead: { page, pass, room } (the entity
  // as the link gives it, the pass the presenter shows, and where the notes come from); nothing is theirs to do.
  async function openEntity(viewer, entityId, { version = null, me, title = null, onClose = () => {}, follow = null } = {}) {
    const page = follow ? follow.page : await WB.api('GET', `/api/entities/${entityId}`);
    const versions = page.versions.filter((v) => !v.hidden || v.id === version);
    if (!versions.length) throw new Error('There is nothing filed under it yet');
    // Oldest first, so the arrows go forward in time; the newest of each task last.
    versions.sort((a, b) => (a.task || '').localeCompare(b.task || '') || a.number - b.number);
    // Each in the pass last chosen in this project, where it has that pass.
    const passKey = `wb:pass:${page.entity.projectId}`;
    let pass = follow ? follow.pass || '' : WB.store(passKey) || '';
    // Each played from its phone copy on a phone (WB.playable); `full` is its review copy.
    const piecesIn = (name) => versions.map((v) => {
      const look = inPass(v.look, name);
      return { ...look, src: WB.playable(look), full: look.src, id: v.id, type: look.type || v.kind, label: v.label, name: look.name || v.originalName };
    });
    // In 3D, each is shown in the pass the project puts on its model (its main one unless the project says).
    const preview3d = page.project && page.project.settings && page.project.settings.preview3d;
    let in3d = false;
    let pieces = piecesIn(pass);
    // A version shown more than one way has the way to choose in the bar; one shown one way, nothing.
    const showPicker = (id) => {
      const p = pieces.find((x) => x.id === id);
      const names = p ? p.passNames : [];
      const list = page.project && page.project.settings && Array.isArray(page.project.settings.passes) ? page.project.settings.passes : null;
      viewer.extras.replaceChildren(...(names.length > 1 && !follow ? [optionsButton(() => [passGroup(names, p.shownPass, (name) => {
        pass = name;
        WB.store(passKey, name);
        pieces = piecesIn(in3d ? preview3d.pass : pass);
        viewer.refresh();
        showPicker(p.id);
      }, list)], { title: 'Which pass' })].map((b) => (b.classList.add('v-passpick'), b)) : []));
    };
    const shape = (list) => list.map((n) => (n.type === 'comment' ? n : { ...n, type: 'comment', on: n.versionId, obn: n.board && n.board.id ? n.board.name : 'the catalogue' }));
    let notes = shape(page.notes);
    const room = (follow ? follow.room : entityRoom)(entityId, me, (list) => {
      notes = list;
      viewer.refresh();
    });
    viewer.use({
      me: () => me,
      locked: !!follow,
      title: () => (title ? `${title} · ${page.entity.name}` : page.entity.name),
      media: () => pieces,
      notes: () => notes,
      can: follow ? { read: () => follow.read } : { member: () => true },
      ...roomNotes(viewer, () => room, () => notes, (next) => { notes = next; }),
      ...(follow && { download: null }),
      scene: () => ({ k: 'entity', entity: entityId, pass: in3d ? '' : pass }),
      // Seen another way (by the person presenting, say): each in that pass.
      setPass: (name) => {
        if ((name || '') === pass) return;
        pass = name || '';
        if (!in3d) pieces = piecesIn(pass);
        viewer.refresh();
      },
      ...(preview3d && preview3d.model && {
        view3d: { ...preview3d, key: page.entity.projectId },
        onMode3d: (on) => {
          in3d = on;
          pieces = piecesIn(on ? preview3d.pass : pass);
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

  // ---------------------------------------------------------------- a playlist
  //
  // Opens the versions of a playlist in a player, at `at` (or the first), taken one at a time as an
  // entity's versions are, with the strip down the left to move between them. Each is commented on in the
  // room of the entity it is a version of, so what is said here is said wherever that entity is open.
  // `load(in3d)` gives the pieces, each with its `entityId`: seen on the venue in 3D (`view3d`, the project's
  // model), they may be other files of the same versions.
  async function openPlaylist(viewer, { load, me, title, at = null, view3d = null, onClose = () => {} }) {
    let pieces = await load(false);
    if (!pieces.length) throw new Error('There is nothing in it to play yet');
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
    // The room follows the piece on screen; a beat later, so stepping quickly through does not hop every room.
    // Coming back to the piece whose room is open before that beat is up stays in it.
    const joinShot = (id) => {
      const p = pieces.find((x) => x.id === id);
      clearTimeout(joinTimer);
      if (!p || p.entityId === roomOf) return;
      joinTimer = setTimeout(() => join(p.entityId), roomOf ? 400 : 0);
    };
    // A comment goes to the room of the piece it is on, joined there and then if the beat is not up yet.
    const roomFor = (pieceId) => {
      const p = pieces.find((x) => x.id === pieceId);
      if (p && p.entityId !== roomOf) join(p.entityId);
      return room;
    };
    viewer.use({
      me: () => me,
      title,
      media: () => pieces,
      notes: () => notes,
      can: { member: () => true },
      ...roomNotes(viewer, (pieceId) => (pieceId ? roomFor(pieceId) : room), () => notes, (next) => { notes = next; }),
      onOpen: joinShot,
      ...(view3d && {
        view3d,
        onMode3d: async (on) => {
          pieces = await load(on);
          viewer.refresh();
        },
      }),
      onClose: () => {
        clearTimeout(joinTimer);
        if (room) room.close();
        onClose();
      },
    });
    viewer.open(pieces.some((p) => p.id === at) ? at : pieces[0].id);
  }

  return {
    create, openEntity, openPlaylist, entityRoom, inPass, optionsButton, passGroup, ICON, INK, inkColor, pathData, outlinePath, strokeNode, fmtTime, fmtMoment, timeLabel, cycleTimeMode,
    frameTime, frameIndex, lastFrame, goTo, whereOf, changing, switchSource, fetchWhole, releaseWhole, showWave, venue,
    timeMode: () => timeMode,
  };
})();
