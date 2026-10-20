'use strict';

// Shared helpers for every page: the home page (home.js), a board (board.js), the admin page.
// Scripts load in this order, each using those before it: common.js (WB), icons.js (WB.icon), media.js
// (WB.media), naming.js (WBNaming), ingest.js (WBIngest), ink.js (WBInk), viewer.js (WBViewer), then the
// page's own script.
const WB = (() => {
  const USER_COLORS = ['#e88a86', '#e8a875', '#e4c978', '#82c79b', '#74c2b9', '#8bb6e8', '#aa9ce6', '#e090b8'];

  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'html') node.innerHTML = value; // only ever passed static markup (icons)
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'style') Object.assign(node.style, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid);
    }
    return node;
  }

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage can be blocked or full; everything it holds is a convenience.
    }
    return value ?? null;
  }

  const anyColor = () => USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];

  // The name and colour this browser goes by where nobody signs in. Always both, or nothing.
  function user() {
    const u = store('wb:user');
    if (!u || typeof u.name !== 'string' || !u.name) return null;
    if (!/^#[0-9a-f]{6}$/i.test(u.color || '')) store('wb:user', Object.assign(u, { color: anyColor() }));
    return u;
  }

  function saveUser(name, color) {
    const prev = user();
    const u = { name: String(name).trim().slice(0, 32), color: hexOk(color) ? color : prev ? prev.color : anyColor() };
    store('wb:user', u);
    return u;
  }

  // In-page replacement for prompt() and confirm(). Resolves with the entered text
  // (or true for a confirmation), or null when dismissed.
  //
  // Only the OK button (or Enter) confirms. However else the dialog closes it was dismissed: Esc,
  // Cancel, or the browser closing it on its own. (Chrome resets returnValue when Esc closes a dialog,
  // so it cannot be trusted to say which button it was.)
  function dialog({ title, text, value, placeholder, ok = 'OK', danger = false, cancellable = true, maxlength = 120 }) {
    return new Promise((resolve) => {
      let confirmed = false;
      const input = value !== undefined && el('input', { type: 'text', maxlength, placeholder, value, autocomplete: 'off' });
      const dlg = el('dialog', { class: 'dlg' },
        el('form', { method: 'dialog', onsubmit: () => { confirmed = true; } },
          el('h2', { text: title }),
          text && el('p', { text }),
          input,
          el('div', { class: 'dlg-actions' },
            cancellable && el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
            el('button', { type: 'submit', class: `btn ${danger ? 'danger solid' : 'primary'}`, text: ok }))));
      dlg.addEventListener('cancel', (e) => {
        if (!cancellable) e.preventDefault();
      });
      dlg.addEventListener('close', () => {
        dlg.remove();
        if (!confirmed) return resolve(null);
        resolve(input ? input.value.trim() : true);
      });
      document.body.append(dlg);
      dlg.showModal();
      if (input) input.select();
    });
  }

  // Resolves with the user, asking for a name first when there is none yet.
  // Behind a login (see DEPLOY.md) the server knows who you are; nobody has to type a name.
  let signedIn;
  let session = {};
  async function identity() {
    if (signedIn !== undefined) return signedIn;
    try {
      const res = await fetch('/api/me');
      // Signed out, or no longer on the list: nothing this browser kept may still be played.
      if (res.status === 401 || res.status === 403) forgetKept();
      const data = await res.json();
      session = data;
      signedIn = data.user || null;
    } catch {
      signedIn = null;
    }
    return signedIn;
  }

  async function askName(force) {
    const managed = await identity();
    if (managed) return managed;
    const existing = user();
    if (existing && !force) return existing;
    for (;;) {
      const name = await dialog({
        title: existing ? 'Change your name' : 'What should we call you?',
        text: 'Your name is shown next to your cursor so the team can see who is who.',
        value: existing ? existing.name : '',
        placeholder: 'Your name',
        ok: 'Continue',
        cancellable: !!existing,
        maxlength: 32,
      });
      if (name) return saveUser(name);
      if (existing) return existing;
    }
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // How long ago, said the same way wherever a time is shown.
  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    const then = new Date(ts);
    const sameYear = then.getFullYear() === new Date().getFullYear();
    return then.toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // The videos this browser kept (media.js) go when whoever kept them is no longer let in.
  function forgetKept() {
    try {
      return WB.media ? WB.media.clear() : Promise.resolve();
    } catch {
      return Promise.resolve();
    }
  }

  // Signs out, leaving nothing of the account's media behind in this browser.
  async function signOut() {
    await forgetKept();
    location.href = '/auth/logout';
  }

  // A sign-in that ran out while the page was open: off to sign in again, and then back to this page.
  async function toSignIn() {
    await forgetKept();
    location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }

  // Errors carry the HTTP status, so a caller can tell "gone" from "not allowed" from "try again".
  async function api(method, url, body) {
    // X-WB says the request comes from the app's own pages: a page elsewhere cannot send it without the
    // server agreeing first, which it never does, so nobody else's page can change anything here.
    const res = await fetch(url, {
      method,
      headers: { 'X-WB': '1', ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && session.signOut) toSignIn();
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
    }
    return data;
  }

  // A quieter, quicker tooltip than the browser's. A trailing "(S)" in a title becomes a keycap.
  function installTips() {
    const tip = el('div', { id: 'tip', role: 'tooltip' });
    document.body.append(tip);
    let target = null;
    let timer = 0;

    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove('show');
      target = null;
    };

    function show(t) {
      if (!document.contains(t)) return;
      const text = t.dataset.tip;
      const m = /^(.*?)\s*\(([^()]{1,24})\)\.?$/.exec(text);
      tip.replaceChildren(el('span', { text: m ? m[1] : text }), ...(m ? m[2].split(/\s+or\s+/).map((k) => el('kbd', { text: k.trim() })) : []));
      const r = t.getBoundingClientRect();
      const w = tip.offsetWidth;
      const h = tip.offsetHeight;
      // Beside vertical toolbars, below everything else (above it near the bottom edge).
      const side = r.left < 90 && r.top > 90;
      let x = side ? r.right + 10 : r.left + r.width / 2 - w / 2;
      let y = side ? r.top + r.height / 2 - h / 2 : r.bottom + 9;
      if (!side && y + h > innerHeight - 8) y = r.top - h - 9;
      tip.style.transform = `translate(${Math.round(Math.max(8, Math.min(x, innerWidth - w - 8)))}px, ${Math.round(Math.max(8, y))}px)`;
      tip.classList.add('show');
    }

    document.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const t = e.target.closest && e.target.closest('[title], [data-tip]');
      if (!t) return hide();
      if (t.hasAttribute('title')) {
        t.dataset.tip = t.getAttribute('title');
        t.removeAttribute('title');
        // For a control that is only an icon the title was also its name; it keeps one.
        if (t.dataset.tipNamed || (!t.hasAttribute('aria-label') && !t.textContent.trim())) {
          t.dataset.tipNamed = '1';
          t.setAttribute('aria-label', t.dataset.tip);
        }
      }
      if (t === target || !t.dataset.tip) return;
      target = t;
      clearTimeout(timer);
      timer = setTimeout(() => show(t), tip.classList.contains('show') ? 0 : 380);
    });
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('blur', hide);
  }
  installTips();

  // ---- theme: dark by default, remembered per browser
  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    store('wb:theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#f0f0f0' : '#090909'; // style.css --bg
    window.dispatchEvent(new Event('wb:theme'));
  }

  function themeButton() {
    const btn = el('button', { class: 'iconbtn themebtn' });
    const paint = () => {
      const dark = theme() === 'dark';
      btn.innerHTML = WB.icon(dark ? 'sun' : 'moon', 18);
      btn.dataset.tip = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
    };
    btn.addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));
    window.addEventListener('wb:theme', paint);
    paint();
    return btn;
  }

  // ---- layout: how every list of things is shown (boards, folders, the catalogue, versions), the same
  // everywhere and remembered per browser: as cards, as compact rows (a small still beside each name, many
  // to a screen), or as a table (a row each, with what is known of it in columns). boot.js reads it first.
  const LAYOUTS = [['cards', 'boards', 'Cards'], ['rows', 'rows', 'Rows'], ['table', 'table', 'Table']];
  const layout = () => {
    const k = document.documentElement.dataset.layout;
    return k === 'rows' || k === 'table' ? k : 'cards';
  };
  function setLayout(k) {
    document.documentElement.dataset.layout = k;
    store('wb:layout', k);
    window.dispatchEvent(new Event('wb:layout'));
  }
  // The three, side by side, the one in force pressed: in the bar (icons) and in Your account (`labels`).
  function layoutSwitch({ labels = false } = {}) {
    const seg = el('div', { class: `seg layout-seg${labels ? '' : ' seg-icons'}`, role: 'group', 'aria-label': 'Show lists as' });
    const paint = () => seg.replaceChildren(...LAYOUTS.map(([k, ic, label]) => el('button', {
      type: 'button', class: `seg-btn${layout() === k ? ' on' : ''}`, 'aria-pressed': String(layout() === k),
      ...(labels ? {} : { 'aria-label': `Show as ${label.toLowerCase()}`, 'data-tip': `Show as ${label.toLowerCase()}` }),
      onclick: () => { if (layout() !== k) setLayout(k); },
    }, el('span', { class: 'seg-ic', html: WB.icon(ic, 15) }), labels && label)));
    // Redrawn when it changes anywhere; one taken off the page stops listening.
    const heard = () => (seg.isConnected ? paint() : window.removeEventListener('wb:layout', heard));
    window.addEventListener('wb:layout', heard);
    paint();
    return seg;
  }

  // Videos kept on this computer: media.js, which sets WB.media.

  // What /api/me said (after identity() or askName() has run): whether read-only links, a public address and sign-out exist here.
  const info = () => session;
  // Whether this screen plays videos' phone copies (see "phone copies" in server.js): a phone (a touch
  // screen and a small one), or a browser asked to save data or on a slow mobile line. Decided once a page,
  // so it does not change copy part way through.
  let phoneSized = null;
  function usesPhoneCopies() {
    if (phoneSized === null) {
      try {
        const c = navigator.connection;
        phoneSized = !!(c && (c.saveData || /(^|-)(2g|3g)$/.test(c.effectiveType || '')))
          || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820);
      } catch {
        phoneSized = false;
      }
    }
    return phoneSized;
  }
  // The file a video is played from here: its phone copy on a phone, when it has one; its review copy otherwise.
  const playable = (look) => (look ? (look.lo && usesPhoneCopies() ? look.lo : look.src) : null);

  // The addresses a link can be opened at, best first: a configured public address, then the address this
  // page was opened from (a tunnel, say), then this computer's network addresses. Never a localhost
  // address: it would only open on this computer.
  function shareBases() {
    const served = session.shareBases || [];
    const here = /^(localhost$|127\.|\[::1\])/.test(location.hostname) ? [] : [location.origin];
    const bases = [...new Set([...served.filter((b) => b.startsWith('https:')), ...here, ...served])];
    return bases.length ? bases : [location.origin];
  }

  // ---- Myreze logo: a welcome when the app opens, and an idle state while the server cannot be reached
  const LOGO = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path pathLength="1" d="M989.01,478.72L769.07,223.08c-9.26-10.58-22.48-16.31-36.14-16.31h-116.8c-10.14,0-18.95,6.17-22.48,15.87l-72.73,189.97c-1.32,4.41-5.29,6.61-8.82,6.61c-3.53,0-7.49-2.2-9.26-6.61l-72.28-189.97c-3.53-9.7-12.34-15.87-22.48-15.87H290.84c-14.1,0-26.89,5.73-36.14,16.31L35.2,478.28c-15.43,17.63-18.07,48.48,7.49,67L323.9,750.23c3.97,3.09,10.58,2.2,13.22-2.2c14.1-21.6,8.82-42.31-1.32-55.1c0-0.44-121.21-163.96-121.21-163.96c-8.82-10.58-8.82-26.45,0.44-37.02l66.11-74.49c9.7-11.46,26.45-7.49,30.85,5.29l149.86,379.49c3.09,9.26,11.9,14.99,21.6,14.99h29.09l29.97-0.44c9.7,0,18.07-6.17,21.6-14.99l149.86-379.05c4.85-13.22,21.6-16.31,30.85-5.29l65.67,74.05c9.26,10.58,9.26,26.45,0.44,37.02L689.73,692.49c-10.14,12.78-15.87,33.5-1.76,55.54c3.09,4.41,9.26,5.29,13.22,2.2L982.4,545.28C997.82,533.38,1010.61,505.17,989.01,478.72z"/></svg>';

  // The logo that sits in the top left corner of every page. It is filled in here so the welcome can fly into it.
  const slot = document.querySelector('[data-logo-slot]');
  if (slot) slot.innerHTML = LOGO;

  function splash(kind, message) {
    const node = el('div', { id: 'splash', class: kind, role: kind === 'idle' ? 'status' : 'presentation' },
      el('div', { class: 'splash-bg' }),
      el('div', { class: 'splash-logo', html: LOGO }),
      // The welcome says the name under the mark: Boards, and beneath it who it is by.
      kind === 'welcome' && el('div', { class: 'splash-word', 'aria-label': 'Boards by Myreze' },
        el('div', { class: 'sw-name', 'aria-hidden': 'true', text: 'Boards' }),
        el('div', { class: 'sw-by', 'aria-hidden': 'true', text: 'by Myreze' })),
      message && el('div', { class: 'splash-msg', text: message }));
    document.body.append(node);
    return node;
  }

  function dismiss(node, ms = 450) {
    node.classList.add('out');
    setTimeout(() => node.remove(), ms);
  }

  function welcome() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A page shown inside another (a board being presented, in the page that watches it) is no arrival.
    if (window.top !== window) return;
    // Only when the app is first opened in this tab: not on a refresh, and not moving around inside it
    // (home to a board and back). Where session storage is not allowed it cannot be remembered, so it plays on every page.
    try {
      if (sessionStorage.getItem('wb:welcomed')) return;
      sessionStorage.setItem('wb:welcomed', '1');
    } catch {
      // nothing to remember it by
    }
    const node = splash('welcome');
    const target = slot && slot.querySelector('svg');
    if (!target) return setTimeout(() => dismiss(node), 1500);
    // The logo draws itself in the middle and flies to its place in the corner while the cover fades away a moment later.
    document.body.classList.add('welcoming');
    const logo = node.querySelector('.splash-logo');
    // The name holds while the mark sets off, and fades as it travels: it is the last thing to go but the cover.
    setTimeout(() => node.classList.add('leave'), 2500);
    setTimeout(() => {
      const from = logo.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      logo.style.transformOrigin = '0 0';
      logo.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})`;
      node.classList.add('fly');
    }, 2300);
    // The flying logo stays above the cover until it has landed, then the real one takes over from exactly where it rests.
    setTimeout(() => {
      document.body.classList.remove('welcoming');
      node.remove();
    }, 3500);
  }

  // Called with true when the server stops answering and false when it is back. A short blip never shows it.
  let idle = null;
  let idleTimer = 0;
  function offline(on) {
    clearTimeout(idleTimer);
    if (on) {
      if (!idle) idleTimer = setTimeout(() => { idle = splash('idle', 'Connection lost. Reconnecting…'); }, 1200);
    } else if (idle) {
      dismiss(idle);
      idle = null;
    }
  }

  // The same cover for anything else that is waited on (the presenter finding what to show next, see
  // watch.js): `waiting(text)` puts it up, or changes what it says, and `waiting(null)` takes it away.
  let waitingNode = null;
  function waiting(text) {
    if (text == null) {
      if (waitingNode) dismiss(waitingNode);
      waitingNode = null;
      return;
    }
    if (waitingNode) {
      waitingNode.querySelector('.splash-msg').textContent = text;
      return;
    }
    waitingNode = splash('idle', text);
  }

  // For pages without a live connection: ask the server now and then, and reload once it is back.
  function watchServer() {
    let misses = 0;
    setInterval(async () => {
      try {
        if (!(await fetch('/healthz', { cache: 'no-store' })).ok) throw new Error('down');
        if (idle) return location.reload();
        misses = 0;
      } catch {
        if (++misses >= 2) offline(true);
      }
    }, 4000);
  }

  welcome();

  // A list of suggestions under a text box, as it is typed in: the arrows walk it, Enter or a click takes
  // one, Esc puts it away. `source(text)` gives the suggestions: { value, label, hint, thumb, make }; one
  // with `make` is the way to make something new of what was typed. Taking one puts its value in the box
  // and tells the box (an "input" event), then `onPick`. With `quiet`, the box being given the keyboard
  // by the page (rather than clicked into) does not open the list: it would cover what is below.
  function combo(input, source, { onPick, quiet = false } = {}) {
    const list = el('div', { class: 'combo-list', role: 'listbox', hidden: true });
    let options = [];
    let at = -1;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    const place = () => {
      const r = input.getBoundingClientRect();
      list.style.left = `${Math.round(r.left)}px`;
      list.style.top = `${Math.round(r.bottom + 4)}px`;
      list.style.minWidth = `${Math.round(r.width)}px`;
    };
    const paint = () => {
      list.replaceChildren(...options.map((o, i) => el('button', {
        type: 'button', class: `combo-opt${i === at ? ' at' : ''}${o.make ? ' make' : ''}`, role: 'option', tabindex: '-1',
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => take(o),
      },
      o.thumb !== undefined && el('span', { class: 'combo-thumb' }, o.thumb && el('img', { src: o.thumb, alt: '' })),
      el('span', { class: 'combo-label', text: o.label ?? o.value }),
      o.hint && el('span', { class: 'combo-hint', text: o.hint }))));
    };
    const show = () => {
      options = source(input.value) || [];
      // Nothing typed, nothing is picked by Enter, unless the source says its first is what is meant.
      at = options.length && (input.value.trim() || options[0].first) ? 0 : -1;
      if (!options.length) return hide();
      if (!list.isConnected) (input.closest('dialog') || document.body).append(list);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      place();
      paint();
    };
    const hide = () => {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    };
    const take = (o) => {
      input.value = o.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      // After the input event, whose listener (show) would open it again.
      hide();
      if (onPick) onPick(o);
    };
    let pressed = false;
    input.addEventListener('pointerdown', () => {
      pressed = true;
      if (document.activeElement === input && list.hidden) show();
    });
    input.addEventListener('focus', () => {
      if (!quiet || pressed) show();
      pressed = false;
    });
    input.addEventListener('input', () => { if (document.activeElement === input) show(); });
    input.addEventListener('blur', () => setTimeout(hide, 100));
    input.addEventListener('keydown', (e) => {
      if (list.hidden) {
        if (e.key === 'ArrowDown') { show(); e.preventDefault(); }
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        at = (at + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        paint();
        list.children[at]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && at >= 0) take(options[at]);
      else if (e.key === 'Escape') hide();
      else if (e.key === 'Tab' && at >= 0 && input.value.trim() && options[at].value !== input.value) { take(options[at]); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener('scroll', () => { if (!list.hidden) place(); }, true);
    window.addEventListener('resize', () => { if (!list.hidden) place(); });
    return { show, hide, list };
  }

  // Suggestions of what a source names, best first: those that start with what was typed, then those
  // that hold it anywhere.
  function rank(items, typed, key = (x) => x, max = 8) {
    const q = String(typed || '').trim().toLowerCase();
    if (!q) return items.slice(0, max);
    const starts = [];
    const holds = [];
    for (const x of items) {
      const k = String(key(x)).toLowerCase();
      if (k.startsWith(q)) starts.push(x);
      else if (k.includes(q)) holds.push(x);
    }
    return [...starts, ...holds].slice(0, max);
  }

  // ---- small things every page needs, said once

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // crypto.randomUUID needs HTTPS; boards are often served over plain HTTP on the LAN.
  const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const hexOk = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
  // Somewhere text goes. A slider or a tick box is not: clicking one must not take the keyboard away.
  const isTyping = (t) => !!t && (t.isContentEditable || /^(TEXTAREA|SELECT)$/.test(t.tagName)
    || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit)$/.test(t.type)));

  // A size on disk: megabytes below a gigabyte (with a decimal under ten), gigabytes above.
  function bytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    const mb = n / 1048576;
    return `${mb >= 10 || !n ? Math.round(mb).toLocaleString() : mb.toFixed(1)} MB`;
  }
  // "1 version", "3 versions"; `many` for a word that does not just take an s.
  const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

  // A person's round badge: their initials on their colour, or on the page's quiet grey when the app
  // does not know their colour.
  function avatar(name, color, { size = 'sm', title } = {}) {
    return el('span', { class: `avatar${size ? ` ${size}` : ''}`, style: hexOk(color) ? { background: color } : null, text: initials(name || '?'), title });
  }

  // ---- menus: a list of things to do, under the button that opened it
  //
  // entries: [label, run, danger] (run may return a promise; its error is shown), an { href, label }
  // link, or a node (a heading). The arrows walk it, Escape closes it and hands the keyboard back, and
  // a click anywhere else closes it. One menu at a time.
  function closeMenus() {
    for (const m of document.querySelectorAll('.menu.wb-menu')) m.remove();
  }
  function menu(anchor, entries, { cls = '', align = 'right', onError } = {}) {
    closeMenus();
    const failed = onError || ((err) => toast(err.message || String(err)));
    const node = el('div', { class: `menu wb-menu${cls ? ` ${cls}` : ''}`, role: 'menu' }, entries.filter(Boolean).map((x) => {
      if (x instanceof Node) return x;
      if (!Array.isArray(x)) return el('a', { class: 'menu-item', role: 'menuitem', href: x.href, text: x.label, onclick: () => closeMenus() });
      const [label, run, danger] = x;
      return el('button', {
        type: 'button', class: `menu-item${danger ? ' danger' : ''}`, role: 'menuitem', text: label,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMenus();
          Promise.resolve().then(run).catch(failed);
        },
      });
    }));
    node.addEventListener('keydown', (e) => {
      const list = [...node.querySelectorAll('.menu-item')];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') list[(at + 1) % list.length]?.focus();
      else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length]?.focus();
      else if (e.key === 'Escape') {
        closeMenus();
        anchor.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    node.addEventListener('click', (e) => e.stopPropagation());
    document.body.append(node);
    const r = anchor.getBoundingClientRect();
    const left = align === 'left' ? r.left : r.right - node.offsetWidth;
    node.style.left = `${clamp(left, 8, innerWidth - node.offsetWidth - 8)}px`;
    node.style.top = `${clamp(r.bottom + 4, 8, innerHeight - node.offsetHeight - 8)}px`;
    node.querySelector('.menu-item')?.focus({ preventScroll: true });
    return node;
  }
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.wb-menu, [aria-haspopup="menu"]')) closeMenus();
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

  // A dropdown, once something is picked from it, gives the keyboard back to the page: otherwise it keeps
  // it, and Space (play, pan) only rings the dropdown until somewhere empty is clicked. One opened from the
  // keyboard lets go too, once its choice is made. A dialog's fields keep it, to be tabbed through.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement && !t.closest('dialog, form')) setTimeout(() => { if (document.activeElement === t) t.blur(); });
  }, true);

  // ---- toasts: a line at the foot of the page, for a moment, with something to do about it if there is
  // anything (Undo, Open). `key` replaces the last toast of that key rather than piling up. `action` may
  // be a list of them (Undo, Change).
  function toast(text, { action, ms = 4000, sticky = false, key } = {}) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = el('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' });
      document.body.append(box);
    }
    if (key) box.querySelector(`.toast[data-key="${key}"]`)?.remove();
    const label = el('span', { text });
    const node = el('div', { class: 'toast', 'data-key': key || null }, label);
    const close = () => node.remove();
    for (const a of [action].flat().filter(Boolean)) {
      node.classList.add('has-action');
      node.append(a.href
        ? el('a', { class: 'toast-act', href: a.href, text: a.label, onclick: close })
        : el('button', { type: 'button', class: 'toast-act', text: a.label, onclick: async () => { close(); try { await a.run(); } catch (err) { toast(err.message || String(err)); } } }));
    }
    box.append(node);
    if (!sticky) setTimeout(close, action ? Math.max(ms, 8000) : ms);
    return { set: (t) => { label.textContent = t; }, close, node };
  }

  // ---- where things are: every address in the app is made here, so they read the same everywhere.
  // On the home page they are hash routes; from a board, `abs` puts them under / as well.
  const href = {
    home: () => '#/',
    space: (ws) => `#/w/${ws}`,
    folder: (id) => `#/f/${id}`,
    boards: (id) => `#/f/${id}/boards`,
    catalogue: (id, { tier, seq, entity } = {}) => `#/f/${id}/catalogue${entity ? `/${entity}` : seq ? `/s/${encodeURIComponent(seq)}` : tier ? `/t/${tier}` : ''}`,
    versions: (id) => `#/f/${id}/versions`,
    timeline: (id) => `#/f/${id}/timeline`,
    board: (id) => `/b/${id}`,
    abs: (h) => (h.startsWith('#') ? `/${h}` : h),
  };

  // ---- what this browser remembers (localStorage, through store()), so every key is written down once
  const KEYS = {
    user: 'wb:user',           // { name, color } where nobody signs in
    theme: 'wb:theme',         // 'dark' | 'light'
    layout: 'wb:layout',       // 'cards' | 'rows' | 'table': how lists are shown
    workspace: 'wb:workspace', // the workspace last shown
    pins: 'wb:pins',           // what is pinned to Home
    recent: 'wb:recent',       // what was opened lately
    feedSeen: 'wb:feed:seen',  // when Updates were last marked read
    feedShow: 'wb:feed:show',  // which of Updates shows
    loop: 'wb:loop',           // the player loops videos
    noAhead: 'wb:noahead',     // videos are not cached ahead
    mediaKinds: 'wb:media:kinds', // which kinds are cached ahead
  };

  // What was opened lately, newest first, for Home: { kind: 'board' | 'entity', id, … }.
  function remember(entry) {
    const list = (Array.isArray(store('wb:recent')) ? store('wb:recent') : []).filter((x) => !(x.kind === entry.kind && x.id === entry.id));
    list.unshift({ ...entry, at: Date.now() });
    store('wb:recent', list.slice(0, 40));
  }

  return {
    el, store, remember, combo, rank, user, dialog, askName, info, shareBases, offline, waiting, playable, usesPhoneCopies, watchServer, initials, ago, api, theme, setTheme, themeButton, layout, setLayout, layoutSwitch,
    media: null, colors: USER_COLORS, saveUser, signOut, clamp, uid, hexOk, isTyping, bytes, plural, avatar, menu, closeMenus, toast, href, KEYS,
  };
})();
