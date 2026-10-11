'use strict';

// The admin area: people, groups and who may do what with which board or folder. Everything shown
// comes from GET /api/admin, and every change answers with all of it again, so the page just redraws.

(async () => {
  const { el, api, ago, dialog, initials } = WB;
  const $ = (id) => document.getElementById(id);
  const svg = (d, size = 16) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PEOPLE = '<circle cx="9" cy="8" r="3.2"/><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.3c2.1.6 3.5 2.3 3.5 4.7"/>';
  const ICON = {
    person: svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6"/>'),
    people: svg(PEOPLE),
    peopleLg: svg(PEOPLE, 20),
    key: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M15.5 7.5L18 10M18 5l2 2"/>'),
    keyLg: svg('<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M15.5 7.5L18 10M18 5l2 2"/>', 20),
    folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    board: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M7.5 9h4v3.5h-4zM14 12.5h2.5V15H14z"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    pen: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'),
    trash: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    search: svg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 14),
  };

  const TABS = { people: ['People', ICON.person], groups: ['Groups', ICON.people], permissions: ['Permissions', ICON.key] };
  // What each role is for, in the words the role picker uses.
  const ROLES = { viewer: 'Can look', commenter: 'Can look and comment', editor: 'Can add to and change boards', manager: 'Can also share, move and delete' };
  // Seen this recently, someone counts as here now. "Last seen" is written every ten minutes at most.
  const HERE = 15 * 60e3;

  let data = null;
  let tab = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'people';
  let query = '';   // what the list of people is narrowed to
  let giveTo = '';  // who the next permission is for, when a group's card asked for one

  $('themeslot').replaceWith(WB.themeButton());
  WB.watchServer();

  function say(message) {
    $('status').textContent = message || '';
    $('status').hidden = !message;
  }

  // Makes a change and shows what came back. Throws what the server said when it would not.
  async function send(method, path, body) {
    data = await api(method, `/api/admin${path}`, body);
    say('');
    render();
  }

  async function call(method, path, body) {
    try {
      await send(method, path, body);
      return true;
    } catch (err) {
      say(err.message);
      return false;
    }
  }

  function go(next) {
    tab = next;
    history.replaceState(null, '', `#${next}`);
    say('');
    render();
  }

  const enc = encodeURIComponent;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const userName = (email) => {
    const u = data.users.find((x) => x.email === email);
    return u && u.name ? u.name : email;
  };
  const group = (id) => data.groups.find((g) => g.id === id);

  // A folder or board named with the folders it sits in, so two of the same name can be told apart.
  function folderPath(id) {
    const names = [];
    for (let f = data.targets.folders.find((x) => x.id === id), hops = 0; f && hops < 100; f = data.targets.folders.find((x) => x.id === f.parentId), hops++) names.unshift(f.name);
    return names;
  }
  function targetPath(t) {
    if (t.type === 'folder') return folderPath(t.id);
    const b = data.targets.boards.find((x) => x.id === t.id);
    return b ? [...(b.folderId ? folderPath(b.folderId) : []), b.name] : [];
  }
  // The same path set out for reading: the folders it is in quieter, its own name in full ink.
  function pathLine(names) {
    return el('span', { class: 'admin-path' }, names.flatMap((n, i) => (i < names.length - 1 ? [el('span', { text: n }), el('i', { text: '/' })] : [el('b', { text: n })])));
  }

  function option(value, text, selected) {
    return el('option', { value, text, selected: selected || null });
  }

  // Everyone gets a colour of their own to be told apart by, the same one every time.
  function avatar(email, small) {
    const u = data.users.find((x) => x.email === email);
    const hue = [...email].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    return el('span', {
      class: `admin-av${small ? ' sm' : ''}`, 'aria-hidden': 'true',
      style: { background: WB.colors[hue % WB.colors.length] },
      text: u && u.name ? initials(u.name) : email.charAt(0).toUpperCase(),
    });
  }
  const groupMark = (small) => el('span', { class: `admin-av group${small ? ' sm' : ''}`, 'aria-hidden': 'true', html: small ? ICON.people : ICON.peopleLg });

  function empty(icon, title, text, action) {
    return el('div', { class: 'admin-empty' }, el('span', { class: 'admin-empty-ic', html: icon }), el('b', { text: title }), el('p', { text }), action);
  }

  // A dialog with a few fields to fill in. It stays open, saying what went wrong, until the change has gone through.
  function form({ title, text, fields, ok, submit }) {
    const inputs = fields.map((f) => el('input', { autocomplete: 'off', ...f.input }));
    const error = el('p', { class: 'admin-dlg-error', role: 'alert', hidden: true });
    const done = el('button', { type: 'submit', class: 'btn primary', text: ok });
    const dlg = el('dialog', { class: 'dlg admin-dlg' },
      el('form', { onsubmit: async (e) => {
        e.preventDefault();
        done.disabled = true;
        try {
          await submit(...inputs.map((i) => i.value.trim()));
          dlg.close();
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          done.disabled = false;
        }
      } },
      el('h2', { text: title }),
      text && el('p', { text }),
      fields.map((f, i) => el('label', {}, el('span', { text: f.label }), inputs[i])),
      error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        done)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  const addPerson = () => form({
    title: 'Add a person',
    text: 'Someone who has not signed in yet, so they can be put in groups and given access ahead of time.',
    fields: [
      { label: 'Email', input: { type: 'email', placeholder: 'name@example.com', required: true } },
      { label: 'Name (optional)', input: { type: 'text', placeholder: 'What they are called', maxlength: 120 } },
    ],
    ok: 'Add person',
    submit: (email, name) => send('POST', '/users', { email, name }),
  });

  const addGroup = () => form({
    title: 'New group',
    text: 'A group is given access in one go: a team, a client, the freelancers on a job.',
    fields: [{ label: 'Name', input: { type: 'text', placeholder: 'Group name', maxlength: 120, required: true } }],
    ok: 'Create group',
    submit: (name) => send('POST', '/groups', { name }),
  });

  // ---- people

  function people() {
    if (!data.users.length) {
      return [empty(ICON.peopleLg, 'Nobody here yet', 'People show up here as they sign in. They can also be added ahead of time.',
        el('button', { class: 'btn primary', html: ICON.plus, onclick: addPerson }, 'Add person'))];
    }
    const rows = data.users.map((u) => {
      const self = u.email === data.me;
      const mine = data.groups.filter((g) => g.members.includes(u.email));
      const why = u.fixed ? 'Set on the server (ADMIN_EMAILS), so it cannot be changed here' : self ? 'You cannot take away your own admin rights' : null;
      const toggle = el('input', {
        type: 'checkbox', role: 'switch', checked: u.admin || null, disabled: why ? true : null, 'aria-label': `${u.name || u.email} is an admin`,
        onchange: (e) => call('PATCH', `/users/${enc(u.email)}`, { admin: e.target.checked }),
      });
      const remove = el('button', { class: 'iconbtn', title: `Remove ${u.name || u.email}`, html: ICON.trash, onclick: async () => {
        const sure = await dialog({ title: `Remove ${u.name || u.email}?`, text: 'They are taken out of every group and permission. If they can still sign in, they show up here again when they do.', ok: 'Remove', danger: true });
        if (sure) call('DELETE', `/users/${enc(u.email)}`);
      } });
      return el('li', { class: 'admin-row', 'data-find': `${u.name || ''} ${u.email} ${mine.map((g) => g.name).join(' ')}`.toLowerCase() },
        el('div', { class: 'admin-who' }, avatar(u.email),
          el('div', { class: 'admin-who-text' },
            el('b', {}, el('span', { text: u.name || u.email }), self && el('span', { class: 'admin-tag you', text: 'You' })),
            u.name && el('span', { text: u.email }))),
        el('div', { class: 'admin-tags' }, mine.length ? mine.map((g) => el('span', { class: 'admin-tag', text: g.name })) : el('span', { class: 'admin-dim', text: 'No groups' })),
        el('span', { class: `admin-seen${!u.lastSeenAt ? ' never' : Date.now() - u.lastSeenAt < HERE ? ' on' : ''}`, text: u.lastSeenAt ? ago(u.lastSeenAt) : 'Not signed in yet' }),
        el('label', { class: 'admin-switch', title: why }, toggle, u.fixed && el('span', { class: 'admin-lock', html: ICON.lock })),
        self ? el('span') : remove);
    });

    const none = el('p', { class: 'admin-none', text: 'Nobody by that name or email.', hidden: true });
    const narrow = () => {
      const q = query.trim().toLowerCase();
      let shown = 0;
      for (const row of rows) {
        row.hidden = !!q && !row.dataset.find.includes(q);
        if (!row.hidden) shown++;
      }
      none.hidden = shown > 0;
    };
    narrow();
    const admins = data.users.filter((u) => u.admin).length;
    return [
      el('div', { class: 'admin-tools' },
        el('label', { class: 'admin-find' }, el('span', { html: ICON.search }),
          el('input', { type: 'search', placeholder: 'Find someone', value: query, 'aria-label': 'Find someone by name, email or group', oninput: (e) => {
            query = e.target.value;
            narrow();
          } })),
        el('span', { class: 'admin-dim', text: `${count(data.users.length, 'person', 'people')}, ${count(admins, 'admin', 'admins')}` })),
      el('div', { class: 'admin-panel admin-people' },
        el('div', { class: 'admin-cols', 'aria-hidden': 'true' }, ...['Person', 'Groups', 'Last seen', 'Admin', ''].map((h) => el('span', { text: h }))),
        el('ul', {}, rows),
        none),
    ];
  }

  // ---- groups

  function groups() {
    if (!data.groups.length) {
      return [empty(ICON.peopleLg, 'No groups yet', 'Put people in a group to give them all access in one go: a team, a client, the freelancers on a job.',
        el('button', { class: 'btn primary', html: ICON.plus, onclick: addGroup }, 'New group'))];
    }
    const cards = data.groups.map((g) => {
      const outside = data.users.filter((u) => !g.members.includes(u.email));
      const pick = el('select', { 'aria-label': `Add someone to ${g.name}` },
        option('', !data.users.length ? 'Nobody to add yet' : outside.length ? 'Add someone…' : 'Everyone is in this group'),
        outside.map((u) => option(u.email, u.name ? `${u.name} (${u.email})` : u.email)));
      pick.disabled = !outside.length;
      pick.addEventListener('change', () => pick.value && call('PUT', `/groups/${enc(g.id)}/members/${enc(pick.value)}`));
      const access = data.grants.filter((x) => x.principal.type === 'group' && x.principal.id === g.id);
      return el('section', { class: 'admin-panel admin-group' },
        el('header', { class: 'admin-group-head' },
          groupMark(),
          el('div', { class: 'admin-who-text' }, el('h3', { text: g.name }), el('span', { text: count(g.members.length, 'person', 'people') })),
          el('button', { class: 'iconbtn', title: 'Rename', html: ICON.pen, onclick: async () => {
            const next = await dialog({ title: 'Rename group', value: g.name, ok: 'Rename' });
            if (next && next !== g.name) call('PATCH', `/groups/${enc(g.id)}`, { name: next });
          } }),
          el('button', { class: 'iconbtn', title: 'Delete group', html: ICON.trash, onclick: async () => {
            const sure = await dialog({ title: `Delete ${g.name}?`, text: 'Its permissions go with it. The people in it are not removed.', ok: 'Delete', danger: true });
            if (sure) call('DELETE', `/groups/${enc(g.id)}`);
          } })),
        el('ul', { class: 'admin-members' },
          g.members.map((email) => el('li', { class: 'admin-member' },
            avatar(email, true),
            el('span', { text: userName(email) }),
            el('button', { class: 'iconbtn mini', title: `Take ${userName(email)} out of ${g.name}`, html: ICON.close, onclick: () => call('DELETE', `/groups/${enc(g.id)}/members/${enc(email)}`) }))),
          el('li', { class: 'admin-pick' }, el('span', { html: ICON.plus }), pick)),
        el('footer', { class: 'admin-access' },
          el('h4', { text: 'Access' }),
          access.map((x) => {
            const names = targetPath(x.target);
            return el('div', { class: 'admin-access-line' },
              el('span', { class: 'admin-ic', html: ICON[x.target.type] }),
              names.length ? pathLine(names) : el('span', { class: 'admin-dim', text: 'No longer in the shared workspace' }),
              el('span', { class: 'admin-tag', text: cap(x.role) }));
          }),
          el('button', { class: 'btn small ghost', html: ICON.plus, onclick: () => {
            giveTo = `group:${g.id}`;
            go('permissions');
          } }, access.length ? 'Give more access' : 'Give access')));
    });
    return [el('div', { class: 'admin-groups' }, cards,
      el('button', { class: 'admin-new', onclick: addGroup }, el('span', { class: 'plus', html: ICON.plus }), 'New group'))];
  }

  // ---- permissions

  function permissions() {
    const { folders, boards } = data.targets;
    const split = (v) => ({ type: v.slice(0, v.indexOf(':')), id: v.slice(v.indexOf(':') + 1) });
    const out = [];

    if (!data.users.length && !data.groups.length) {
      out.push(empty(ICON.keyLg, 'Nobody to give access to yet', 'Access is given to a person or to a group. Add one first.',
        el('button', { class: 'btn', text: 'Go to people', onclick: () => go('people') })));
    } else if (!folders.length && !boards.length) {
      out.push(empty(ICON.keyLg, 'Nothing to give access to yet', 'Access is given on the boards and folders of the shared workspace, and there are none so far.',
        el('a', { class: 'btn', href: '/', text: 'All boards' })));
    } else {
      const who = el('select', { class: 'admin-select', required: true },
        option('', 'Choose a group or a person…'),
        data.groups.length ? el('optgroup', { label: 'Groups' }, data.groups.map((g) => option(`group:${g.id}`, g.name, giveTo === `group:${g.id}`))) : null,
        data.users.length ? el('optgroup', { label: 'People' }, data.users.map((u) => option(`user:${u.email}`, u.name || u.email))) : null);
      const target = el('select', { class: 'admin-select', required: true },
        option('', 'Choose a folder or a board…'),
        folders.length ? el('optgroup', { label: 'Folders' }, folders.map((f) => option(`folder:${f.id}`, folderPath(f.id).join(' / ')))) : null,
        boards.length ? el('optgroup', { label: 'Boards' }, boards.map((b) => option(`board:${b.id}`, targetPath({ type: 'board', id: b.id }).join(' / ')))) : null);
      const roles = el('div', { class: 'admin-roles', role: 'radiogroup', 'aria-label': 'Role' }, data.roles.map((r) => el('label', { class: 'admin-role' },
        el('input', { type: 'radio', name: 'role', value: r, checked: r === 'editor' || null }),
        el('b', { text: cap(r) }),
        el('span', { text: ROLES[r] || '' }))));
      out.push(el('form', { class: 'admin-panel admin-give', onsubmit: (e) => {
        e.preventDefault();
        giveTo = '';
        call('POST', '/grants', { target: split(target.value), principal: split(who.value), role: new FormData(e.target).get('role') });
      } },
      el('h2', { text: 'Give access' }),
      el('div', { class: 'admin-give-fields' },
        el('label', { class: 'admin-field' }, el('span', { text: 'Who' }), who),
        el('label', { class: 'admin-field' }, el('span', { text: 'To what' }), target)),
      el('div', { class: 'admin-field' }, el('span', { text: 'As' }), roles),
      el('div', { class: 'admin-give-foot' }, el('button', { class: 'btn primary', type: 'submit', text: 'Give access' }))));
    }

    // What has been given, a panel to each folder or board: folders first, then boards, then what is gone.
    const on = new Map();
    for (const g of data.grants) {
      const key = `${g.target.type}:${g.target.id}`;
      if (!on.has(key)) on.set(key, { target: g.target, names: targetPath(g.target), grants: [] });
      on.get(key).grants.push(g);
    }
    const rank = (t) => `${t.names.length ? 0 : 1}${t.target.type === 'folder' ? 0 : 1}${t.names.join(' / ').toLowerCase()}`;
    const panels = [...on.values()].sort((a, b) => rank(a).localeCompare(rank(b))).map((t) => el('section', { class: 'admin-panel admin-target' },
      el('header', {},
        el('span', { class: 'admin-av group sm', 'aria-hidden': 'true', html: ICON[t.target.type] }),
        t.names.length ? pathLine(t.names) : el('span', { class: 'admin-dim', text: 'No longer in the shared workspace' }),
        el('span', { class: 'admin-dim', text: cap(t.target.type) })),
      el('ul', {}, t.grants.map((g) => {
        const many = g.principal.type === 'group';
        const name = many ? group(g.principal.id)?.name || 'Unknown group' : userName(g.principal.id);
        const sub = many ? `Group, ${count(group(g.principal.id)?.members.length || 0, 'person', 'people')}` : name === g.principal.id ? 'Person' : g.principal.id;
        const change = el('select', { class: 'admin-select', 'aria-label': `Role of ${name}`, onchange: (e) => call('POST', '/grants', { target: g.target, principal: g.principal, role: e.target.value }) },
          data.roles.map((r) => option(r, cap(r), r === g.role)));
        change.disabled = !t.names.length;
        return el('li', { class: 'admin-grant' },
          el('div', { class: 'admin-who' }, many ? groupMark(true) : avatar(g.principal.id, true),
            el('div', { class: 'admin-who-text' }, el('b', { text: name }), el('span', { text: sub }))),
          change,
          el('button', { class: 'iconbtn', title: `Take this access from ${name}`, html: ICON.close, onclick: () => call('DELETE', `/grants/${enc(g.id)}`) }));
      }))));
    if (panels.length) out.push(el('h2', { class: 'admin-sub', text: 'Who has access' }), ...panels);
    return out;
  }

  // ----

  function render() {
    const counts = { people: data.users.length, groups: data.groups.length, permissions: data.grants.length };
    $('localnote').hidden = !data.local;
    $('tabs').hidden = false;
    $('tabs').replaceChildren(...Object.entries(TABS).map(([key, [label, icon]]) => el('button', {
      class: `admin-tab${key === tab ? ' current' : ''}`, 'aria-current': key === tab ? 'page' : null, html: icon,
      onclick: () => go(key),
    }, label, el('span', { class: 'tally', text: String(counts[key]) }))));
    // The one thing set in ink at the end of the bar is what this tab is for adding.
    const action = { people: ['Add person', addPerson], groups: ['New group', addGroup] }[tab];
    $('primary').hidden = !action;
    if (action) {
      $('primary').replaceChildren(el('span', { class: 'admin-ic', html: ICON.plus }), action[0]);
      $('primary').onclick = action[1];
    }
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
    $('content').replaceChildren(empty(ICON.lock, 'The admin area is closed', err.message, el('a', { class: 'btn', href: '/', text: 'All boards' })));
  }
})();
