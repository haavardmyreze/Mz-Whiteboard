'use strict';

// The admin area: people, groups and who may do what with which board or folder. Everything shown
// comes from GET /api/admin, and every change answers with all of it again, so the page just redraws.

(async () => {
  const { el, api, ago, dialog } = WB;
  const $ = (id) => document.getElementById(id);

  const TABS = { people: 'People', groups: 'Groups', permissions: 'Permissions' };
  let data = null;
  let tab = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'people';

  $('themeslot').replaceWith(WB.themeButton());
  WB.watchServer();

  function say(message) {
    $('status').textContent = message || '';
    $('status').hidden = !message;
  }

  async function call(method, path, body) {
    try {
      data = await api(method, `/api/admin${path}`, body);
      say('');
      render();
      return true;
    } catch (err) {
      say(err.message);
      return false;
    }
  }

  const enc = encodeURIComponent;
  const userName = (email) => {
    const u = data.users.find((x) => x.email === email);
    return u && u.name ? u.name : email;
  };
  const groupName = (id) => data.groups.find((g) => g.id === id)?.name || 'Unknown group';
  const whoName = (p) => (p.type === 'group' ? groupName(p.id) : userName(p.id));

  // A folder or board named with the folders it sits in, so two of the same name can be told apart.
  function folderPath(id) {
    const names = [];
    for (let f = data.targets.folders.find((x) => x.id === id), hops = 0; f && hops < 100; f = data.targets.folders.find((x) => x.id === f.parentId), hops++) names.unshift(f.name);
    return names.join(' / ');
  }
  function targetName(t) {
    if (t.type === 'folder') return folderPath(t.id) || null;
    const b = data.targets.boards.find((x) => x.id === t.id);
    if (!b) return null;
    return b.folderId ? `${folderPath(b.folderId)} / ${b.name}` : b.name;
  }

  function option(value, text, selected) {
    return el('option', { value, text, selected: selected || null });
  }

  // ---- people

  function people() {
    const email = el('input', { type: 'email', placeholder: 'name@example.com', required: true, 'aria-label': 'Email' });
    const name = el('input', { type: 'text', placeholder: 'Name (optional)', maxlength: 120, 'aria-label': 'Name' });
    const add = el('form', { class: 'admin-add', onsubmit: async (e) => {
      e.preventDefault();
      if (await call('POST', '/users', { email: email.value, name: name.value })) email.focus();
    } }, email, name, el('button', { class: 'btn primary', type: 'submit', text: 'Add person' }));

    const groupsOf = (email) => data.groups.filter((g) => g.members.includes(email)).map((g) => g.name).join(', ');
    const rows = data.users.map((u) => {
      const self = u.email === data.me;
      const toggle = el('input', {
        type: 'checkbox', checked: u.admin || null, disabled: u.fixed || self || null, 'aria-label': `${u.email} is an admin`,
        title: u.fixed ? 'Named in ADMIN_EMAILS' : self ? 'You cannot take away your own admin rights' : null,
        onchange: (e) => call('PATCH', `/users/${enc(u.email)}`, { admin: e.target.checked }),
      });
      const remove = !self && el('button', { class: 'btn small ghost', text: 'Remove', onclick: async () => {
        const sure = await dialog({ title: `Remove ${u.name || u.email}?`, text: 'They are taken out of every group and permission. If they can still sign in, they show up here again when they do.', ok: 'Remove', danger: true });
        if (sure) call('DELETE', `/users/${enc(u.email)}`);
      } });
      return el('tr', {},
        el('td', { text: u.name || '—' }),
        el('td', { class: 'admin-mono', text: u.email }),
        el('td', { class: 'admin-dim', 'data-label': 'Groups', text: groupsOf(u.email) || '—' }),
        el('td', { class: 'admin-dim', 'data-label': 'Last seen', text: u.lastSeenAt ? ago(u.lastSeenAt) : 'Not yet' }),
        el('td', { 'data-label': 'Admin' }, el('label', { class: 'admin-check' }, toggle, u.fixed ? el('span', { class: 'admin-dim', text: 'env' }) : null)),
        el('td', { class: 'admin-actions' }, remove));
    });
    return [
      add,
      el('table', { class: 'admin-table' },
        el('thead', {}, el('tr', {}, ...['Name', 'Email', 'Groups', 'Last seen', 'Admin', ''].map((h) => el('th', { text: h })))),
        el('tbody', {}, rows)),
    ];
  }

  // ---- groups

  function groups() {
    const name = el('input', { type: 'text', placeholder: 'Group name', maxlength: 120, required: true, 'aria-label': 'Group name' });
    const add = el('form', { class: 'admin-add', onsubmit: async (e) => {
      e.preventDefault();
      if (await call('POST', '/groups', { name: name.value })) name.focus();
    } }, name, el('button', { class: 'btn primary', type: 'submit', text: 'Create group' }));

    const cards = data.groups.map((g) => {
      const outside = data.users.filter((u) => !g.members.includes(u.email));
      const pick = el('select', { 'aria-label': `Add someone to ${g.name}` },
        option('', outside.length ? 'Add someone…' : 'Everyone is in this group'),
        outside.map((u) => option(u.email, u.name ? `${u.name} (${u.email})` : u.email)));
      pick.disabled = !outside.length;
      pick.addEventListener('change', () => pick.value && call('PUT', `/groups/${enc(g.id)}/members/${enc(pick.value)}`));
      return el('section', { class: 'admin-card' },
        el('div', { class: 'admin-card-head' },
          el('h3', { text: g.name }),
          el('span', { class: 'admin-dim', text: `${g.members.length} ${g.members.length === 1 ? 'person' : 'people'}` }),
          el('div', { class: 'spacer' }),
          el('button', { class: 'btn small ghost', text: 'Rename', onclick: async () => {
            const next = await dialog({ title: 'Rename group', value: g.name, ok: 'Rename' });
            if (next && next !== g.name) call('PATCH', `/groups/${enc(g.id)}`, { name: next });
          } }),
          el('button', { class: 'btn small ghost', text: 'Delete', onclick: async () => {
            const sure = await dialog({ title: `Delete ${g.name}?`, text: 'Its permissions go with it. The people in it are not removed.', ok: 'Delete', danger: true });
            if (sure) call('DELETE', `/groups/${enc(g.id)}`);
          } })),
        el('div', { class: 'admin-members' },
          g.members.map((email) => el('span', { class: 'admin-member' },
            el('span', { text: userName(email) }),
            el('button', { class: 'admin-x', 'aria-label': `Take ${userName(email)} out of ${g.name}`, text: '×', onclick: () => call('DELETE', `/groups/${enc(g.id)}/members/${enc(email)}`) }))),
          pick));
    });
    return [add, cards.length ? cards : el('p', { class: 'admin-dim', text: 'No groups yet.' })];
  }

  // ---- permissions

  function permissions() {
    const { folders, boards } = data.targets;
    const target = el('select', { required: true, 'aria-label': 'On' },
      option('', 'On which folder or board…'),
      folders.length ? el('optgroup', { label: 'Folders' }, folders.map((f) => option(`folder:${f.id}`, folderPath(f.id)))) : null,
      boards.length ? el('optgroup', { label: 'Boards' }, boards.map((b) => option(`board:${b.id}`, targetName({ type: 'board', id: b.id })))) : null);
    const who = el('select', { required: true, 'aria-label': 'Who' },
      option('', 'For whom…'),
      data.groups.length ? el('optgroup', { label: 'Groups' }, data.groups.map((g) => option(`group:${g.id}`, g.name))) : null,
      data.users.length ? el('optgroup', { label: 'People' }, data.users.map((u) => option(`user:${u.email}`, u.name || u.email))) : null);
    const role = el('select', { 'aria-label': 'Role' }, data.roles.map((r) => option(r, r, r === 'editor')));
    const split = (v) => ({ type: v.slice(0, v.indexOf(':')), id: v.slice(v.indexOf(':') + 1) });
    const add = el('form', { class: 'admin-add', onsubmit: (e) => {
      e.preventDefault();
      call('POST', '/grants', { target: split(target.value), principal: split(who.value), role: role.value });
    } }, target, who, role, el('button', { class: 'btn primary', type: 'submit', text: 'Give access' }));

    const rows = data.grants.map((g) => {
      const on = targetName(g.target);
      const change = el('select', { 'aria-label': 'Role', onchange: (e) => call('POST', '/grants', { target: g.target, principal: g.principal, role: e.target.value }) },
        data.roles.map((r) => option(r, r, r === g.role)));
      change.disabled = !on;
      return el('tr', {},
        el('td', {}, el('span', { class: 'admin-dim', text: `${g.target.type} ` }), on || el('em', { class: 'admin-dim', text: 'not in the shared workspace' })),
        el('td', {}, el('span', { class: 'admin-dim', text: `${g.principal.type === 'group' ? 'group' : 'person'} ` }), whoName(g.principal)),
        el('td', { 'data-label': 'Role' }, change),
        el('td', { class: 'admin-actions' }, el('button', { class: 'btn small ghost', text: 'Remove', onclick: () => call('DELETE', `/grants/${enc(g.id)}`) })));
    });
    return [
      add,
      rows.length
        ? el('table', { class: 'admin-table' },
          el('thead', {}, el('tr', {}, ...['On', 'Who', 'Role', ''].map((h) => el('th', { text: h })))),
          el('tbody', {}, rows))
        : el('p', { class: 'admin-dim', text: 'No permissions given yet.' }),
    ];
  }

  // ----

  function render() {
    const counts = { people: data.users.length, groups: data.groups.length, permissions: data.grants.length };
    $('localnote').hidden = !data.local;
    $('tabs').hidden = false;
    $('tabs').replaceChildren(...Object.entries(TABS).map(([key, label]) => el('button', {
      class: `space${key === tab ? ' current' : ''}`,
      onclick: () => {
        tab = key;
        history.replaceState(null, '', `#${key}`);
        say('');
        render();
      },
    }, label, el('span', { class: 'tally', text: String(counts[key]) }))));
    $('content').replaceChildren(...(tab === 'people' ? people() : tab === 'groups' ? groups() : permissions()).flat());
  }

  window.addEventListener('hashchange', () => {
    const next = location.hash.slice(1);
    if (!TABS[next] || next === tab || !data) return;
    tab = next;
    say('');
    render();
  });

  try {
    data = await api('GET', '/api/admin');
    render();
  } catch (err) {
    $('content').replaceChildren(el('p', { class: 'home-empty', text: err.message }));
  }
})();
