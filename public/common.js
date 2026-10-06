'use strict';

// Shared helpers for the board list and the board itself.
const WB = (() => {
  const USER_COLORS = ['#f2545b', '#f59e3b', '#e8c53a', '#4fbf73', '#2bb5a8', '#3d9df2', '#8b7cf6', '#e064b7'];

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
  async function askName(force) {
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

  return { el, store, user, dialog, askName, initials, ago, api };
})();
