'use strict';

// Your account: who you are here (name and colour, unless sign-in says), how the app looks (theme, and
// lists as cards, compact rows or a table), what this computer caches of the videos, and the way to the
// admin page or out.
// Opened from your name in the bar. Loaded after media.js and icons.js.
const WBAccount = (() => {
  const { el } = WB;
  const icon = WB.icon;
  const ICON = {
    pen: icon('pen', 16), moon: icon('moon', 16), sun: icon('sun', 16), disk: icon('disk', 18), out: icon('out', 16),
    shield: icon('shield', 16), close: icon('close', 18),
  };
  const size = WB.bytes;

  // `me()` is who you are now; `setMe(me)` hears a new name or colour.
  function open({ me: getMe, setMe }) {
    let me = getMe();
    const changed = (m) => { me = m; setMe(m); };
    const managed = !!WB.info().user;
    const dlg = el('dialog', { class: 'dlg acct-dlg', 'aria-label': 'Your account' });
    dlg.addEventListener('close', () => dlg.remove());
    const section = (title, ...kids) => el('section', { class: 'acct-sec' }, el('h3', { text: title }), ...kids);

    // The dialog is drawn afresh after each change in it; what had the keyboard has it again after.
    const focusKey = () => {
      const a = document.activeElement;
      return a && dlg.contains(a) ? a.getAttribute('aria-label') || a.textContent.trim() : null;
    };
    const refocus = (key) => {
      if (!key) return;
      const again = [...dlg.querySelectorAll('button, input, a')].find((n) => (n.getAttribute('aria-label') || n.textContent.trim()) === key);
      if (again) again.focus({ preventScroll: true });
    };
    async function paint() {
      const had = focusKey();
      await draw();
      refocus(had);
    }
    async function draw() {
      const u = WB.info().user;
      const stats = await WB.media.stats();
      let quota = null;
      try {
        quota = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      } catch {
        // not said by this browser
      }
      const ahead = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Cache videos ahead' });
      ahead.checked = WB.media.ahead();
      ahead.addEventListener('change', () => { WB.media.setAhead(ahead.checked); paint(); });
      const on = WB.media.kinds();
      const kind = (k, text) => {
        const box = el('input', { type: 'checkbox', role: 'switch', 'aria-label': text, disabled: !ahead.checked });
        box.checked = on[k] !== false;
        box.addEventListener('change', () => WB.media.setKind(k, box.checked));
        return el('label', { class: `acct-row sub${ahead.checked ? '' : ' off'}` }, el('span', { text }), box);
      };
      const theme = WB.theme();
      dlg.replaceChildren(
        el('button', { type: 'button', class: 'iconbtn acct-close', html: ICON.close, title: 'Close (Esc)', onclick: () => dlg.close() }),
        el('div', { class: 'acct-head' },
          el('span', { class: 'avatar acct-av', style: { background: me.color }, text: WB.initials(me.name) }),
          el('div', { class: 'acct-who' },
            el('b', { text: me.name }),
            el('span', {}, (u && u.email) || 'This browser', WB.info().admin && el('span', { class: 'acct-badge', html: ICON.shield }, 'Admin'))),
          !managed && el('button', { type: 'button', class: 'iconbtn', html: ICON.pen, title: 'Change your name', onclick: async () => { changed(await WB.askName(true)); paint(); } })),
        // A group of radio buttons: one stop for Tab, the arrows move between the colours.
        !managed && el('div', {
          class: 'acct-colors', role: 'radiogroup', 'aria-label': 'Your colour',
          onkeydown: (e) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const i = WB.colors.indexOf(me.color);
            changed(WB.saveUser(me.name, WB.colors[(i + step + WB.colors.length) % WB.colors.length]));
            paint();
          },
        }, WB.colors.map((c, i) => el('button', {
          type: 'button', class: `acct-color${c === me.color ? ' on' : ''}`, style: { background: c }, role: 'radio', 'aria-checked': String(c === me.color),
          'aria-label': `Colour ${i + 1} of ${WB.colors.length}`, tabindex: c === me.color ? '0' : '-1', title: 'Your colour on the boards',
          onclick: () => { changed(WB.saveUser(me.name, c)); paint(); },
        }))),
        section('Appearance', el('div', { class: 'seg' }, [['dark', ICON.moon, 'Dark'], ['light', ICON.sun, 'Light']].map(([t, ic, label]) => el('button', {
          type: 'button', class: `seg-btn${theme === t ? ' on' : ''}`, 'aria-pressed': String(theme === t), onclick: () => { WB.setTheme(t); paint(); },
        }, el('span', { class: 'seg-ic', html: ic }), label))),
        // How lists are shown: cards, compact rows or a table. Also the switch in the bar.
        WB.layoutSwitch({ labels: true })),
        section('Video cache',
          el('div', { class: 'acct-cache' },
            el('span', { class: 'acct-cache-ic', html: ICON.disk }),
            el('div', { class: 'acct-cache-num' }, el('b', { text: size(stats.bytes) }), el('span', { text: `of ${size(WB.media.MAX)} · ${WB.plural(stats.count, 'video')}` })),
            el('button', {
              type: 'button', class: 'btn small', text: 'Clear', disabled: !stats.count,
              onclick: async () => {
                const sure = await WB.dialog({ title: 'Clear the video cache?', text: `${size(stats.bytes)} is freed on this computer. Videos load from the server again until they are cached anew.`, ok: 'Clear', danger: true });
                if (!sure) return;
                await WB.media.clear();
                paint();
              },
            })),
          el('i', { class: 'kp-bar' }, el('i', { style: { width: `${Math.min(1, stats.bytes / WB.media.MAX) * 100}%` } })),
          el('label', { class: 'acct-row' }, el('span', { text: 'Cache videos ahead' }), ahead),
          kind('boards', 'Boards I open'),
          kind('pinned', 'The newest of what I pinned'),
          el('p', { class: 'acct-note', text: 'Whatever you open is cached. With caching ahead on, so is what the page you are on and the timeline show. What was opened longest ago makes room.' }),
          quota && quota.quota && el('p', { class: 'acct-note', text: `Browser storage · ${size(quota.usage || 0)} used of ${size(quota.quota)}` })),
        (WB.info().admin || WB.info().signOut) && el('div', { class: 'acct-foot' },
          WB.info().admin && el('a', { class: 'btn', href: '/admin', html: `${ICON.shield}<span>Admin</span>` }),
          WB.info().signOut && el('button', {
            type: 'button', class: 'btn', html: `${ICON.out}<span>Sign out</span>`,
            onclick: async () => {
              const sure = await WB.dialog({ title: 'Sign out?', text: `You are signed in as ${me.name}.`, ok: 'Sign out' });
              if (sure) WB.signOut();
            },
          })));
    }

    document.body.append(dlg);
    paint();
    dlg.showModal();
  }

  return { open };
})();
