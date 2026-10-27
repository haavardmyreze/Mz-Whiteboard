'use strict';

// Your account: who you are here (name and colour, unless sign-in says), how the app looks (theme, and
// lists as cards, compact rows or a table), what this computer caches of the videos, and the way to the
// admin page or out. One dialog in tabs, as a project's settings are (WB.settingTabs).
// Opened from your name in the bar. Loaded after media.js and icons.js.
const WBAccount = (() => {
  const { el } = WB;
  const icon = WB.icon;
  const ICON = {
    pen: icon('pen', 16), moon: icon('moon', 16), sun: icon('sun', 16), kept: icon('kept', 18), out: icon('out', 16),
    shield: icon('shield', 16),
  };
  const size = WB.bytes;

  // `me()` is who you are now; `setMe(me)` hears a new name or colour.
  function open({ me: getMe, setMe }) {
    let me = getMe();
    const changed = (m) => { me = m; setMe(m); };
    const managed = !!WB.info().user;
    const dlg = el('dialog', { class: 'dlg ps-dlg acct-dlg', 'aria-label': 'Your account' });
    dlg.addEventListener('close', () => dlg.remove());

    // The dialog is drawn afresh after each change in it, on the same tab; what had the keyboard has it again after.
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
    // A setting and what it is, with its switch or buttons beside it (`row`) or under it (`field`), as in a
    // project's settings.
    const heading = (label, hint) => el('div', { class: 'ps-label' }, el('b', { text: label }), hint && el('span', { text: hint }));
    const row = (label, hint, ...control) => el('label', { class: 'ps-row' }, heading(label, hint), el('div', { class: 'ps-control' }, ...control));
    const field = (label, hint, control) => el('div', { class: 'ps-field' }, el('div', { class: 'ps-field-head' }, heading(label, hint)), control);

    async function draw() {
      const u = WB.info().user;
      const stats = await WB.media.stats();
      let quota = null;
      try {
        quota = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      } catch {
        // not said by this browser
      }
      const ahead = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Cache videos ahead' });
      ahead.checked = WB.media.ahead();
      ahead.addEventListener('change', () => { WB.media.setAhead(ahead.checked); paint(); });
      const on = WB.media.kinds();
      const kind = (k, text) => {
        const box = el('input', { type: 'checkbox', class: 'switch', 'aria-label': text, disabled: !ahead.checked });
        box.checked = on[k] !== false;
        box.addEventListener('change', () => WB.media.setKind(k, box.checked));
        const r = row(text, null, box);
        r.classList.add('acct-sub');
        r.classList.toggle('off', !ahead.checked);
        return r;
      };
      const theme = WB.theme();

      const you = el('div', { class: 'acct-head' },
        el('span', { class: 'avatar acct-av', style: { background: me.color }, text: WB.initials(me.name) }),
        el('div', { class: 'acct-who' },
          el('b', { text: me.name }),
          el('span', {}, (u && u.email) || 'This browser', WB.info().admin && el('span', { class: 'acct-badge', html: ICON.shield }, 'Admin'))),
        !managed && el('button', { type: 'button', class: 'iconbtn', html: ICON.pen, title: 'Change your name', 'aria-label': 'Change your name', onclick: async () => { changed(await WB.askName(true)); paint(); } }));
      // A group of radio buttons: one stop for Tab, the arrows move between the colours.
      const colours = !managed && el('div', {
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
      })));

      const tabs = WB.settingTabs('account', [
        {
          id: 'you', label: 'Profile', icon: 'person', hint: managed ? 'Who you are here, as your sign-in says' : 'Who you are here, on this browser',
          rows: [you, colours && field('Colour', 'Yours on the boards: your pointer, your pen and your comments', colours)],
        },
        {
          id: 'look', label: 'Appearance', icon: 'sun', hint: 'How the app looks on this computer',
          rows: [
            field('Theme', null, el('div', { class: 'seg' }, [['dark', ICON.moon, 'Dark'], ['light', ICON.sun, 'Light']].map(([t, ic, label]) => el('button', {
              type: 'button', class: `seg-btn${theme === t ? ' on' : ''}`, 'aria-pressed': String(theme === t), onclick: () => { WB.setTheme(t); paint(); },
            }, el('span', { class: 'seg-ic', html: ic }), label)))),
            // How lists are shown: cards, compact rows or a table. Also the switch in the bar.
            field('Lists', 'Also in the bar, beside a page’s title', WB.layoutSwitch({ labels: true })),
          ],
        },
        {
          id: 'cache', label: 'Video cache', icon: 'kept', hint: 'The videos kept on this computer, so they open and scrub at once',
          rows: [
            el('div', { class: 'acct-cache-box' },
              el('div', { class: 'acct-cache' },
                el('span', { class: 'acct-cache-ic', html: ICON.kept }),
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
              quota && quota.quota && el('p', { class: 'acct-note', text: `Browser storage · ${size(quota.usage || 0)} used of ${size(quota.quota)}` })),
            el('div', { class: 'acct-group' },
              row('Cache videos ahead', 'Whatever you open is cached. With this on, so is what the page you are on and the timeline show. What was opened longest ago makes room', ahead),
              kind('boards', 'Boards I open'),
              kind('pinned', 'The newest of what I pinned')),
          ],
        },
      ]);

      dlg.replaceChildren(
        el('div', { class: 'ps-head' }, el('span', { class: 'ps-where', text: me.name }), el('h2', { text: 'Your account' })),
        el('div', { class: 'ps-body' }, tabs.nav, tabs.panes),
        el('div', { class: 'dlg-actions' },
          // The words the app uses (vocabulary.js), from wherever you are.
          el('a', { class: 'btn', href: '/#/vocabulary', text: 'Vocabulary', onclick: () => dlg.close() }),
          WB.info().admin && el('a', { class: 'btn', href: '/admin', html: `${ICON.shield}<span>Admin</span>` }),
          WB.info().signOut && el('button', {
            type: 'button', class: 'btn', html: `${ICON.out}<span>Sign out</span>`,
            onclick: async () => {
              const sure = await WB.dialog({ title: 'Sign out?', text: `You are signed in as ${me.name}.`, ok: 'Sign out' });
              if (sure) WB.signOut();
            },
          }),
          el('button', { type: 'button', class: 'btn primary acct-done', text: 'Done', title: 'Close (Esc)', onclick: () => dlg.close() })));
    }

    document.body.append(dlg);
    paint();
    dlg.showModal();
  }

  return { open };
})();
