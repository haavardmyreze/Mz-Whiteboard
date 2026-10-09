'use strict';

// Shared helpers for the board list and the board itself.
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

  function saveUser(name) {
    const prev = user();
    const u = { name: name.trim().slice(0, 32), color: prev ? prev.color : anyColor() };
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

  // A sign-in that ran out while the page was open: off to sign in again, and then back to this page.
  function toSignIn() {
    location.href = `/auth/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
  }

  // Errors carry the HTTP status, so a caller can tell "gone" from "not allowed" from "try again".
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
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
  const SUN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    store('wb:theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#f7f7f7' : '#0f0f0f';
    window.dispatchEvent(new Event('wb:theme'));
  }

  function themeButton() {
    const btn = el('button', { class: 'iconbtn themebtn' });
    const paint = () => {
      const dark = theme() === 'dark';
      btn.innerHTML = dark ? SUN : MOON;
      btn.dataset.tip = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
    };
    btn.addEventListener('click', () => setTheme(theme() === 'dark' ? 'light' : 'dark'));
    window.addEventListener('wb:theme', paint);
    paint();
    return btn;
  }

  // ---- videos kept on this computer (see board.js): where, how much at most, and what is there
  const media = {
    CACHE: 'wb-media-1',
    MAX: 4 * 1024 * 1024 * 1024,
    // Whether boards fetch their videos ahead to keep; this browser's choice.
    ahead: () => store('wb:noahead') !== true,
    setAhead: (on) => store('wb:noahead', !on),
    stats() {
      const kept = store('wb:kept') || {};
      const list = Object.values(kept).filter((k) => Array.isArray(k));
      return { count: list.length, bytes: list.reduce((sum, k) => sum + (k[0] || 0), 0), last: Math.max(0, ...list.map((k) => k[1] || 0)) };
    },
    async clear() {
      try {
        if ('caches' in window) await caches.delete(media.CACHE);
      } catch {
        // nothing kept, or no leave to say so
      }
      try {
        localStorage.removeItem('wb:kept');
      } catch {
        // storage blocked: there was nothing in it either
      }
    },
  };

  // What /api/me said (after identity() or askName() has run): whether read-only links, a public address and sign-out exist here.
  const info = () => session;

  // ---- Myreze logo: a welcome when the app opens, and an idle state while the server cannot be reached
  const LOGO = '<svg viewBox="0 0 1024 1024" aria-hidden="true"><path pathLength="1" d="M989.01,478.72L769.07,223.08c-9.26-10.58-22.48-16.31-36.14-16.31h-116.8c-10.14,0-18.95,6.17-22.48,15.87l-72.73,189.97c-1.32,4.41-5.29,6.61-8.82,6.61c-3.53,0-7.49-2.2-9.26-6.61l-72.28-189.97c-3.53-9.7-12.34-15.87-22.48-15.87H290.84c-14.1,0-26.89,5.73-36.14,16.31L35.2,478.28c-15.43,17.63-18.07,48.48,7.49,67L323.9,750.23c3.97,3.09,10.58,2.2,13.22-2.2c14.1-21.6,8.82-42.31-1.32-55.1c0-0.44-121.21-163.96-121.21-163.96c-8.82-10.58-8.82-26.45,0.44-37.02l66.11-74.49c9.7-11.46,26.45-7.49,30.85,5.29l149.86,379.49c3.09,9.26,11.9,14.99,21.6,14.99h29.09l29.97-0.44c9.7,0,18.07-6.17,21.6-14.99l149.86-379.05c4.85-13.22,21.6-16.31,30.85-5.29l65.67,74.05c9.26,10.58,9.26,26.45,0.44,37.02L689.73,692.49c-10.14,12.78-15.87,33.5-1.76,55.54c3.09,4.41,9.26,5.29,13.22,2.2L982.4,545.28C997.82,533.38,1010.61,505.17,989.01,478.72z"/></svg>';

  // The logo that sits in the top left corner of every page. It is filled in here so the welcome can fly into it.
  const slot = document.querySelector('[data-logo-slot]');
  if (slot) slot.innerHTML = LOGO;

  function splash(kind, message) {
    const node = el('div', { id: 'splash', class: kind, role: kind === 'idle' ? 'status' : 'presentation' },
      el('div', { class: 'splash-bg' }),
      el('div', { class: 'splash-logo', html: LOGO }),
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
    // Opening the app or refreshing it, not moving around inside it (home to a board and back).
    const nav = performance.getEntriesByType('navigation')[0];
    const type = nav ? nav.type : 'navigate';
    let inside = false;
    try {
      inside = !!document.referrer && new URL(document.referrer).origin === location.origin;
    } catch {
      // an odd referrer counts as coming from outside
    }
    if (type === 'back_forward' || (type === 'navigate' && inside)) return;
    const node = splash('welcome');
    const target = slot && slot.querySelector('svg');
    if (!target) return setTimeout(() => dismiss(node), 1500);
    // The logo draws itself in the middle and flies to its place in the corner while the cover fades away a moment later.
    document.body.classList.add('welcoming');
    const logo = node.querySelector('.splash-logo');
    setTimeout(() => {
      const from = logo.getBoundingClientRect();
      const to = target.getBoundingClientRect();
      logo.style.transformOrigin = '0 0';
      logo.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})`;
      node.classList.add('fly');
    }, 950);
    // The flying logo stays above the cover until it has landed, then the real one takes over from exactly where it rests.
    setTimeout(() => {
      document.body.classList.remove('welcoming');
      node.remove();
    }, 2050);
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

  return { el, store, user, dialog, askName, info, offline, watchServer, initials, ago, api, theme, setTheme, themeButton, media, colors: USER_COLORS, saveUser };
})();
