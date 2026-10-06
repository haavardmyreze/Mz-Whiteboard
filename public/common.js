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

  function user() {
    const u = store('wb:user');
    return u && typeof u.name === 'string' && u.name ? u : null;
  }

  function saveUser(name) {
    const prev = user();
    const u = {
      name: name.trim().slice(0, 32),
      color: (prev && prev.color) || USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)],
    };
    store('wb:user', u);
    return u;
  }

  // In-page replacement for prompt() and confirm(). Resolves with the entered text
  // (or true for a confirmation), or null when dismissed.
  function dialog({ title, text, value, placeholder, ok = 'OK', danger = false, cancellable = true, maxlength = 120 }) {
    return new Promise((resolve) => {
      const input = value !== undefined && el('input', { type: 'text', maxlength, placeholder, value, autocomplete: 'off' });
      const dlg = el('dialog', { class: 'dlg' },
        el('form', { method: 'dialog' },
          el('h2', { text: title }),
          text && el('p', { text }),
          input,
          el('div', { class: 'dlg-actions' },
            cancellable && el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close('cancel') }),
            el('button', { type: 'submit', class: `btn ${danger ? 'danger solid' : 'primary'}`, text: ok }))));
      dlg.addEventListener('cancel', (e) => {
        if (!cancellable) e.preventDefault();
        else dlg.returnValue = 'cancel';
      });
      dlg.addEventListener('close', () => {
        dlg.remove();
        if (dlg.returnValue === 'cancel') return resolve(null);
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
  async function identity() {
    if (signedIn !== undefined) return signedIn;
    try {
      const res = await fetch('/api/me');
      const data = await res.json();
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

  function ago(ts) {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ts).toLocaleDateString();
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  const SUN = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>';
  const MOON = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';

  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function setTheme(t) {
    document.documentElement.dataset.theme = t;
    store('wb:theme', t);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#ffffff' : '#0e0e10';
    window.dispatchEvent(new Event('wb:theme'));
  }

  function themeButton() {
    const btn = el('button', { class: 'iconbtn' });
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

  return { el, store, user, dialog, askName, initials, ago, api, theme, setTheme, themeButton };
})();
