'use strict';

// The bell and what it opens: replies, comments on your work and boards, and mentions, newest first (the
// server's notifications.js). Checked every half minute while the tab is shown, and at once when it is
// shown again. Wants a page with #bell, #bellcount and #notices inside a .bellwrap.
const WBNotices = (() => {
  const { el, api, ago } = WB;
  const $ = (id) => document.getElementById(id);

  const TEXT = {
    mention: () => 'mentioned you',
    reply: () => 'replied to you',
    work: (n) => `commented on ${n.on}`,
    board: (n) => `commented on ${n.on}`,
  };

  // `name()` is who you are: without sign-in the server only knows you by the name you gave, so it is
  // sent along.
  function mount({ name }) {
    const url = (p = '') => `/api/notifications${p}${WB.info().user ? '' : `?name=${encodeURIComponent(name())}`}`;
    let notices = { items: [], unread: 0 };
    const isOpen = () => !$('notices').hidden;

    async function load() {
      try {
        notices = await api('GET', url());
      } catch {
        return;
      }
      $('bellcount').hidden = !notices.unread;
      $('bellcount').textContent = notices.unread > 99 ? '99+' : notices.unread;
      $('bell').title = notices.unread ? `Notifications: ${notices.unread} unread` : 'Notifications';
      if (isOpen()) paint();
    }

    async function mark(body) {
      try {
        await api('POST', url('/read'), body);
      } catch {
        // the next check shows them as they are
      }
    }

    function paint() {
      // A comment made on a board opens there, at the comment; one made in the catalogue opens the asset,
      // set or shot it is about.
      const row = (n) => el('a', {
        class: `notice${n.read ? '' : ' unread'}`,
        href: n.board ? `${WB.href.board(n.board.id)}#c=${n.id}` : n.projectId && n.entityId ? WB.href.abs(WB.href.catalogue(n.projectId, { entity: n.entityId })) : '/',
        onclick: () => { if (!n.read) mark({ ids: [n.id] }); },
      },
      WB.avatar(n.author, n.color),
      el('span', { class: 'notice-body' },
        el('span', { class: 'notice-what' }, el('strong', { text: n.author }), n.guest && el('span', { class: 'notice-guest', text: 'guest' }), ` ${TEXT[n.kind](n)}`),
        el('span', { class: 'notice-text', text: n.text }),
        el('span', { class: 'notice-where', text: `${n.board ? n.board.name || 'A board' : 'In the catalogue'} · ${ago(n.at)}` })),
      !n.read && el('span', { class: 'notice-dot', role: 'img', 'aria-label': 'Unread' }));
      $('notices').replaceChildren(
        el('header', { class: 'notices-head' },
          el('h2', { text: 'Notifications' }),
          notices.unread > 0 && el('button', {
            class: 'btn small ghost', text: 'Mark all read',
            onclick: async () => { await mark({ all: true }); load(); },
          })),
        notices.items.length
          ? el('div', { class: 'notices-list' }, notices.items.map(row))
          : el('p', { class: 'notices-empty', text: 'Nothing yet. Replies to you, comments on your work and boards, and @mentions of your name show up here.' }));
    }

    function toggle(open = !isOpen()) {
      // Asked before it is hidden: hiding it takes the keyboard away from whatever in it had it.
      const had = isOpen() && $('notices').contains(document.activeElement);
      $('notices').hidden = !open;
      $('bell').setAttribute('aria-expanded', String(open));
      if (open) {
        paint();
        load();
        // The keyboard goes into the list, and back to the bell when it closes.
        $('notices').setAttribute('tabindex', '-1');
        $('notices').focus({ preventScroll: true });
      } else if (had) $('bell').focus();
    }

    $('bell').addEventListener('click', () => toggle());
    document.addEventListener('pointerdown', (e) => {
      if (isOpen() && !e.target.closest('.bellwrap')) toggle(false);
    });
    load();
    setInterval(() => { if (!document.hidden) load(); }, 30000);
    // Coming back to this tab from a board: what was read there, or arrived since, shows at once.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    return { isOpen, close: () => toggle(false), load };
  }

  return { mount };
})();
