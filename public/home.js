'use strict';

(async () => {
  const { el, api, ago, store } = WB;
  const $ = (id) => document.getElementById(id);

  const svg = (d, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  const ICON_FOLDER = svg(FOLDER, 20);
  const ICON_FOLDER_SM = svg(FOLDER, 16);
  const STACK = '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5"/>';
  const ICON_PROJECT = svg(STACK, 20);
  const ICON_MORE = svg('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>', 18);

  let everything = { folders: [], boards: [] }; // all you may see, in every workspace
  let lib = { folders: [], boards: [] };       // the workspace being shown
  const SPACES = { myreze: 'Myreze', personal: 'Personal' };
  let space = 'myreze';
  let dragging = null; // { kind: 'board' | 'folder', id }

  $('themeslot').replaceWith(WB.themeButton());
  WB.watchServer();
  let me = await WB.askName();
  // Personal workspaces belong to a signed-in account, so without sign-in there is only the shared one.
  const hasPersonal = !!WB.info().user;
  $('adminlink').hidden = !WB.info().admin;
  if (hasPersonal && store('wb:workspace') === 'personal') space = 'personal';
  const paintMe = () => $('me').replaceChildren(
    el('span', { class: 'avatar sm', style: { background: me.color }, text: WB.initials(me.name) }),
    el('span', { text: me.name }));
  paintMe();
  $('me').title = 'Your account';
  $('me').addEventListener('click', () => openAccount());

  // ---- your account: who you are here, how the app looks, and what this computer keeps
  const ICON = {
    pen: svg('<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>', 16),
    moon: svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>', 16),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>', 16),
    disk: svg('<path d="M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z"/><path d="M4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>', 18),
    out: svg('<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h11"/>', 16),
    shield: svg('<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>', 16),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18),
  };
  const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1048576).toLocaleString()} MB`);

  function openAccount() {
    const managed = !!WB.info().user;
    const dlg = el('dialog', { class: 'dlg acct-dlg', 'aria-label': 'Your account' });
    dlg.addEventListener('close', () => dlg.remove());
    const section = (title, ...kids) => el('section', { class: 'acct-sec' }, el('h3', { text: title }), ...kids);

    async function paint() {
      const u = WB.info().user;
      const stats = WB.media.stats();
      let quota = null;
      try {
        quota = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      } catch {
        // not said by this browser
      }
      const ahead = el('input', { type: 'checkbox', role: 'switch', 'aria-label': 'Cache videos ahead' });
      ahead.checked = WB.media.ahead();
      ahead.addEventListener('change', () => WB.media.setAhead(ahead.checked));
      const theme = WB.theme();
      dlg.replaceChildren(
        el('button', { type: 'button', class: 'iconbtn acct-close', html: ICON.close, title: 'Close (Esc)', onclick: () => dlg.close() }),
        el('div', { class: 'acct-head' },
          el('span', { class: 'avatar acct-av', style: { background: me.color }, text: WB.initials(me.name) }),
          el('div', { class: 'acct-who' },
            el('b', { text: me.name }),
            el('span', {}, (u && u.email) || 'This browser', WB.info().admin && el('span', { class: 'acct-badge', html: ICON.shield }, 'Admin'))),
          !managed && el('button', { type: 'button', class: 'iconbtn', html: ICON.pen, title: 'Change your name', onclick: async () => { me = await WB.askName(true); paintMe(); paint(); } })),
        !managed && el('div', { class: 'acct-colors', role: 'radiogroup', 'aria-label': 'Your colour' }, WB.colors.map((c) => el('button', {
          type: 'button', class: `acct-color${c === me.color ? ' on' : ''}`, style: { background: c }, role: 'radio', 'aria-checked': String(c === me.color), title: 'Your colour on the boards',
          onclick: () => { me = { ...me, color: c }; store('wb:user', me); paintMe(); paint(); },
        }))),
        section('Appearance', el('div', { class: 'seg' }, [['dark', ICON.moon, 'Dark'], ['light', ICON.sun, 'Light']].map(([t, ic, label]) => el('button', {
          type: 'button', class: `seg-btn${theme === t ? ' on' : ''}`, onclick: () => { WB.setTheme(t); paint(); },
        }, el('span', { class: 'seg-ic', html: ic }), label)))),
        section('Video cache',
          el('div', { class: 'acct-cache' },
            el('span', { class: 'acct-cache-ic', html: ICON.disk }),
            el('div', { class: 'acct-cache-num' }, el('b', { text: size(stats.bytes) }), el('span', { text: `of ${size(WB.media.MAX)} · ${stats.count} ${stats.count === 1 ? 'video' : 'videos'}` })),
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
          el('label', { class: 'acct-row' }, el('span', { text: 'Cache videos of the boards I open' }), ahead),
          quota && quota.quota && el('p', { class: 'acct-note', text: `Browser storage · ${size(quota.usage || 0)} used of ${size(quota.quota)}` })),
        (WB.info().admin || WB.info().signOut) && el('div', { class: 'acct-foot' },
          WB.info().admin && el('a', { class: 'btn', href: '/admin', html: `${ICON.shield}<span>Admin</span>` }),
          WB.info().signOut && el('button', {
            type: 'button', class: 'btn', html: `${ICON.out}<span>Sign out</span>`,
            onclick: async () => {
              const sure = await WB.dialog({ title: 'Sign out?', text: `You are signed in as ${me.name}.`, ok: 'Sign out' });
              if (sure) location.href = '/auth/logout';
            },
          })));
    }

    document.body.append(dlg);
    paint();
    dlg.showModal();
  }

  // ------------------------------------------------------------- library helpers

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  const folderById = (id) => lib.folders.find((f) => f.id === id) || null;
  const childrenOf = (id) => lib.folders.filter((f) => (f.parentId || null) === id).sort(byName);
  const boardsIn = (id) => lib.boards.filter((b) => (b.folderId || null) === id);

  function currentFolder() {
    const m = /^#\/f\/([\w-]+)/.exec(location.hash);
    return m && folderById(m[1]) ? m[1] : null;
  }

  // In a project folder: which of its pages is open (boards, catalogue or import), and the entity open in the catalogue.
  function currentView() {
    const m = /^#\/f\/[\w-]+\/(catalogue|import)(?:\/([\w-]+))?/.exec(location.hash);
    return m ? { page: m[1], entity: m[2] || null } : { page: 'boards', entity: null };
  }

  function trailTo(id) {
    const out = [];
    for (let f = folderById(id); f && out.length < 50; f = folderById(f.parentId)) out.unshift(f);
    return out;
  }

  const isWithin = (id, ancestor) => trailTo(id).some((f) => f.id === ancestor);

  async function fail(err) {
    await WB.dialog({ title: 'That did not work', text: err.message, ok: 'OK', cancellable: false });
    refresh();
  }

  // `quiet` is the background check: when nothing has changed the page is left as it is, rather than
  // rebuilt under the pointer, except once a minute so "edited 5 min ago" stays true.
  let shown = '';
  let shownAt = 0;
  async function refresh(quiet = false) {
    try {
      const next = await api('GET', '/api/library');
      const sig = `${space}|${JSON.stringify(next)}`;
      if (quiet === true && sig === shown && Date.now() - shownAt < 60000) return;
      shown = sig;
      shownAt = Date.now();
      everything = next;
      lib = {
        folders: everything.folders.filter((f) => f.workspace === space),
        boards: everything.boards.filter((b) => b.workspace === space),
      };
      render();
    } catch (err) {
      $('empty').hidden = false;
      $('empty').textContent = `Could not load boards: ${err.message}`;
    }
  }

  const otherSpace = () => (space === 'myreze' ? 'personal' : 'myreze');

  async function moveSpace(kind, thing) {
    await api('PATCH', kind === 'board' ? `/api/boards/${thing.id}` : `/api/folders/${thing.id}`, { workspace: otherSpace() });
    await refresh();
  }

  function switchSpace(next) {
    if (next === space) return;
    space = next;
    store('wb:workspace', space);
    $('q').value = '';
    if (location.hash && location.hash !== '#/') location.hash = '#/';
    refresh();
  }

  // The two tabs. Dropping a board or folder on the other one moves it there.
  function renderSpaces() {
    $('spaces').hidden = !hasPersonal;
    if (!hasPersonal) return;
    $('spaces').replaceChildren(...Object.keys(SPACES).map((name) => {
      const count = everything.boards.filter((b) => b.workspace === name).length;
      const tab = el('button', { class: `space${name === space ? ' current' : ''}`, type: 'button', onclick: () => switchSpace(name) },
        SPACES[name], el('span', { class: 'tally', text: String(count) }));
      tab.addEventListener('dragover', (e) => {
        if (!dragging || name === space) return;
        e.preventDefault();
        tab.classList.add('drop');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drop'));
      tab.addEventListener('drop', (e) => {
        tab.classList.remove('drop');
        if (!dragging || name === space) return;
        e.preventDefault();
        const { kind, id } = dragging;
        dragging = null;
        api('PATCH', kind === 'board' ? `/api/boards/${id}` : `/api/folders/${id}`, { workspace: name }).then(() => refresh()).catch(fail);
      });
      return tab;
    }));
  }

  async function moveTo(kind, id, folderId) {
    if (kind === 'board') await api('PATCH', `/api/boards/${id}`, { folderId });
    else await api('PATCH', `/api/folders/${id}`, { parentId: folderId });
    await refresh();
  }

  // ------------------------------------------------------------- drag and drop

  function canDrop(folderId) {
    if (!dragging) return false;
    if (dragging.kind === 'folder') {
      const f = folderById(dragging.id);
      if (!f || folderId === f.id || (folderId && isWithin(folderId, f.id))) return false;
      return (f.parentId || null) !== folderId;
    }
    const b = lib.boards.find((x) => x.id === dragging.id);
    return !!b && (b.folderId || null) !== folderId;
  }

  function dropTarget(node, folderId) {
    node.addEventListener('dragover', (e) => {
      if (!canDrop(folderId)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('drop');
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('drop');
    });
    node.addEventListener('drop', (e) => {
      node.classList.remove('drop');
      if (!canDrop(folderId)) return;
      e.preventDefault();
      const { kind, id } = dragging;
      dragging = null;
      moveTo(kind, id, folderId).catch(fail);
    });
  }

  function draggable(node, kind, id) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      dragging = { kind, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id); // Firefox will not start a drag without data
      requestAnimationFrame(() => node.classList.add('lifted'));
    });
    node.addEventListener('dragend', () => {
      dragging = null;
      node.classList.remove('lifted');
      for (const n of document.querySelectorAll('.drop')) n.classList.remove('drop');
    });
  }

  // ------------------------------------------------------------- menus and dialogs

  function closeMenu() {
    for (const m of document.querySelectorAll('.menu')) m.remove();
  }

  function openMenu(anchor, entries) {
    closeMenu();
    const menu = el('div', { class: 'menu', role: 'menu' }, entries.map(([label, run, danger]) => el('button', {
      class: `menu-item${danger ? ' danger' : ''}`, role: 'menuitem', text: label,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        Promise.resolve(run()).catch(fail);
      },
    })));
    // The arrow keys walk the menu, and Escape hands the keyboard back to the button that opened it.
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.children];
      const at = list.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') list[(at + 1) % list.length].focus();
      else if (e.key === 'ArrowUp') list[(at - 1 + list.length) % list.length].focus();
      else if (e.key === 'Escape') {
        closeMenu();
        anchor.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
    menu.firstChild.focus({ preventScroll: true });
  }
  // A click anywhere else closes it. The buttons that open a menu, and its own entries, keep their clicks to themselves.
  document.addEventListener('click', closeMenu);

  function menuButton(entries) {
    return el('button', {
      class: 'iconbtn card-menu', title: 'More', html: ICON_MORE,
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.currentTarget, entries);
      },
    });
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

  // Resolves with a folder id, null for the top level, or undefined if dismissed.
  function pickFolder({ title, exclude, current }) {
    return new Promise((resolve) => {
      let chosen = current ?? null;
      const rows = [];
      const list = el('div', { class: 'picker' });
      const select = (id) => {
        chosen = id;
        for (const r of rows) r.node.classList.toggle('active', r.id === chosen);
      };
      const add = (id, name, depth) => {
        const node = el('button', {
          type: 'button', class: 'pick', html: ICON_FOLDER_SM, style: { paddingLeft: `${12 + depth * 18}px` },
          onclick: () => select(id),
        }, name);
        rows.push({ id, node });
        list.append(node);
      };
      const walk = (parent, depth) => {
        for (const f of childrenOf(parent)) {
          if (f.id === exclude) continue;
          add(f.id, f.name, depth);
          walk(f.id, depth + 1);
        }
      };
      add(null, 'All boards', 0);
      walk(null, 1);
      select(chosen);

      // Only "Move here" moves; any other way of closing it is a dismissal (see WB.dialog).
      let confirmed = false;
      const dlg = el('dialog', { class: 'dlg' },
        el('form', { method: 'dialog', onsubmit: () => { confirmed = true; } },
          el('h2', { text: title }),
          list,
          el('div', { class: 'dlg-actions' },
            el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
            el('button', { type: 'submit', class: 'btn primary', text: 'Move here' }))));
      dlg.addEventListener('close', () => {
        dlg.remove();
        resolve(confirmed ? chosen : undefined);
      });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  async function rename(kind, thing) {
    const name = await WB.dialog({ title: kind === 'folder' ? 'Rename folder' : 'Rename board', value: thing.name, placeholder: 'Name', ok: 'Rename' });
    if (!name || name === thing.name) return;
    await api('PATCH', kind === 'folder' ? `/api/folders/${thing.id}` : `/api/boards/${thing.id}`, { name });
    refresh();
  }

  async function moveDialog(kind, thing) {
    const target = await pickFolder({
      title: `Move "${thing.name}" to`,
      exclude: kind === 'folder' ? thing.id : null,
      current: kind === 'folder' ? thing.parentId : thing.folderId,
    });
    if (target === undefined) return;
    await moveTo(kind, thing.id, target);
  }

  async function removeBoard(board) {
    const sure = await WB.dialog({
      title: `Delete "${board.name}"?`,
      text: 'It disappears for everyone. The server keeps it hidden, so whoever runs the server can still restore it.',
      ok: 'Delete board',
      danger: true,
    });
    if (!sure) return;
    await api('DELETE', `/api/boards/${board.id}`);
    refresh();
  }

  async function removeFolder(folder) {
    const sure = await WB.dialog({
      title: `Delete folder "${folder.name}"?`,
      text: 'Only the folder is removed. Its boards and subfolders move up one level.',
      ok: 'Delete folder',
      danger: true,
    });
    if (!sure) return;
    await api('DELETE', `/api/folders/${folder.id}`);
    refresh();
  }

  // ------------------------------------------------------------- rendering

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  // A project is never inside another, nor around one.
  const inProject = (id) => trailTo(id).some((f) => f.project);
  const holdsProject = (id) => lib.folders.some((f) => f.project && isWithin(f.id, id));

  async function setProject(folder, on) {
    if (on) {
      const sure = await WB.dialog({
        title: `Make “${folder.name}” a project?`,
        text: 'A project keeps a catalogue: its assets, sets and shots, and every version filed of them from its boards or its Import page. A project cannot be deleted, and stays one once something is filed in it.',
        ok: 'Make it a project',
      });
      if (!sure) return;
    }
    await api('PATCH', `/api/folders/${folder.id}`, { project: on });
    await refresh();
    if (on) location.hash = `#/f/${folder.id}/catalogue`;
  }

  function folderCard(folder) {
    const subs = childrenOf(folder.id).length;
    const boards = boardsIn(folder.id).length;
    const meta = [folder.project && 'Project', boards && plural(boards, 'board'), subs && plural(subs, 'folder')].filter(Boolean).join(' · ') || 'Empty';
    const card = el('a', { class: `card folder${folder.project ? ' project' : ''}`, href: `#/f/${folder.id}` },
      el('div', { class: 'folder-icon', html: folder.project ? ICON_PROJECT : ICON_FOLDER }),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: folder.name }),
        el('div', { class: 'card-meta', text: meta })),
      menuButton([
        ['Rename', () => rename('folder', folder)],
        ['Move to…', () => moveDialog('folder', folder)],
        hasPersonal && [`Move to ${SPACES[otherSpace()]} workspace`, () => moveSpace('folder', folder)],
        !folder.project && !inProject(folder.id) && !holdsProject(folder.id) && ['Make it a project', () => setProject(folder, true)],
        folder.project && ['Open the catalogue', () => { location.hash = `#/f/${folder.id}/catalogue`; }],
        folder.project && ['Make it a plain folder', () => setProject(folder, false)],
        !folder.project && ['Delete folder', () => removeFolder(folder), true],
      ].filter(Boolean)));
    draggable(card, 'folder', folder.id);
    dropTarget(card, folder.id);
    return card;
  }

  function boardCard(board) {
    const thumbs = el('div', { class: `card-thumbs n${Math.min(board.thumbs.length, 4)}` },
      board.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' })));
    const card = el('a', { class: 'card', href: `/b/${board.id}` },
      thumbs,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: board.name }),
        el('div', { class: 'card-meta' },
          `${plural(board.count, 'item')} · edited ${ago(board.updatedAt)}`,
          board.online > 0 && el('span', { class: 'card-live', text: `${board.online} here now` }))),
      menuButton([
        ['Rename', () => rename('board', board)],
        ['Move to…', () => moveDialog('board', board)],
        hasPersonal && [`Move to ${SPACES[otherSpace()]} workspace`, () => moveSpace('board', board)],
        ['Delete board', () => removeBoard(board), true],
      ].filter(Boolean)));
    draggable(card, 'board', board.id);
    return card;
  }

  // The dashed first tile, as on Milanote: a board is always one click away. It is built like a board
  // card (picture area, then a name and a line) so it is exactly the same size in any folder.
  function newBoardTile() {
    return el('button', { class: 'card new', onclick: newBoard },
      el('span', { class: 'new-thumb' }, el('span', { class: 'plus', html: svg('<path d="M12 5v14M5 12h14"/>', 18) })),
      el('span', { class: 'card-body' },
        el('span', { class: 'card-name', text: 'New board' }),
        el('span', { class: 'card-meta', text: 'Start from a blank canvas' })));
  }

  function crumb(folder) {
    const node = el('a', { class: `crumb${folder && folder.project ? ' project' : ''}`, href: folder ? `#/f/${folder.id}` : '#/', text: folder ? folder.name : (hasPersonal ? SPACES[space] : 'All boards') });
    dropTarget(node, folder ? folder.id : null);
    return node;
  }

  function render() {
    renderSpaces();
    const cur = currentFolder();
    const trail = trailTo(cur);
    const crumbs = [crumb(null), ...trail.map(crumb)];
    $('crumbs').replaceChildren(...crumbs.flatMap((node, i) => (i ? [el('span', { class: 'crumb-sep', text: '/' }), node] : [node])));
    crumbs[crumbs.length - 1].classList.add('current');
    document.title = `${trail.length ? trail[trail.length - 1].name : hasPersonal ? SPACES[space] : 'All boards'} · Boards`;

    // A project has its boards, its catalogue and its Import page.
    const here = cur && folderById(cur);
    const view = here && here.project ? currentView() : { page: 'boards' };
    $('q').placeholder = view.page === 'catalogue' ? 'Search the catalogue' : 'Search boards and folders';
    if (view.page !== 'boards') {
      $('empty').hidden = true;
      return renderProject(here, view);
    }
    // A search looks through every folder; without one you see the folder you are in.
    const q = $('q').value.trim().toLowerCase();
    const matches = (name) => name.toLowerCase().includes(q);
    const subs = q ? lib.folders.filter((f) => matches(f.name)).sort(byName) : childrenOf(cur);
    const boards = q ? lib.boards.filter((b) => matches(b.name)) : boardsIn(cur);
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    $('content').replaceChildren(...[
      here && here.project && projectTabs(here, 'boards'),
      subs.length > 0 && label('Folders', subs.length),
      subs.length > 0 && el('div', { class: 'folder-grid' }, subs.map(folderCard)),
      (subs.length > 0 || q) && label('Boards', boards.length),
      el('div', { class: 'board-grid' }, [...(q ? [] : [newBoardTile()]), ...boards.map(boardCard)]),
      q && !subs.length && !boards.length && el('p', { class: 'home-empty', text: `Nothing matches "${$('q').value.trim()}".` }),
    ].filter(Boolean));
    $('empty').hidden = true;
  }

  // ------------------------------------------------------------- a project: its catalogue and Import page
  //
  // A project's catalogue is every asset, set and shot in it, each with the versions filed of it. It
  // mirrors how the project is laid out on disk: assets, sets, and shots by sequence. The Import page
  // takes many files at once and files them straight into the catalogue: what its name says is filed
  // at once, and only what it does not say is asked. Nothing from it lands on a board.

  const N = window.WBNaming;
  const catalogues = new Map(); // project id -> its catalogue as last fetched

  function projectTabs(project, page) {
    const tab = (id, label, href) => el('a', { class: `space${page === id ? ' current' : ''}`, href }, label);
    return el('nav', { class: 'spaces ptabs', 'aria-label': 'Project' },
      tab('boards', 'Boards', `#/f/${project.id}`),
      tab('catalogue', 'Catalogue', `#/f/${project.id}/catalogue`),
      tab('import', 'Import', `#/f/${project.id}/import`));
  }

  let shownProject = '';
  async function renderProject(project, view) {
    const sig = `${project.id}|${view.page}|${view.entity}`;
    const fresh = shownProject !== sig;
    shownProject = sig;
    if (view.page === 'import') return $('content').replaceChildren(projectTabs(project, 'import'), importView(project));
    if (fresh && (view.entity || !catalogues.has(project.id))) $('content').replaceChildren(projectTabs(project, 'catalogue'), el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      if (view.entity) {
        const page = await api('GET', `/api/entities/${view.entity}`);
        if (shownProject !== sig) return;
        return $('content').replaceChildren(projectTabs(project, 'catalogue'), entityPage(project, page));
      }
      // What was fetched last shows at once (a search narrows it as it is typed); then it is brought up to date.
      if (catalogues.has(project.id)) $('content').replaceChildren(projectTabs(project, 'catalogue'), ...catalogueView(project, catalogues.get(project.id)));
      const cat = await api('GET', `/api/projects/${project.id}`);
      catalogues.set(project.id, cat);
      if (shownProject !== sig) return;
      $('content').replaceChildren(projectTabs(project, 'catalogue'), ...catalogueView(project, cat));
    } catch (err) {
      $('content').replaceChildren(projectTabs(project, view.page), el('p', { class: 'home-empty', text: err.message }));
    }
  }

  function entityTile(project, e) {
    return el('a', { class: 'card ent', href: `#/f/${project.id}/catalogue/${e.id}` },
      el('div', { class: `card-thumbs n${e.thumb ? 1 : 0}` }, e.thumb && el('img', { src: e.thumb, alt: '', loading: 'lazy', draggable: 'false' })),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: e.name }),
        el('div', { class: 'card-meta', text: e.versions ? `${plural(e.versions, 'version')} · last ${ago(e.latestAt)}` : 'Nothing filed yet' })));
  }

  function catalogueView(project, cat) {
    const q = $('q').value.trim().toLowerCase();
    const list = cat.entities.filter((e) => !q || e.name.includes(q));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    const out = [];
    for (const tier of cat.preset.tiers) {
      const of = list.filter((e) => e.tier === tier.id);
      if (!of.length) continue;
      out.push(label(tier.label, of.length));
      if (tier.id !== 'shot') {
        out.push(el('div', { class: 'board-grid ent-grid' }, of.map((e) => entityTile(project, e))));
        continue;
      }
      // Shots by sequence, as they are on disk.
      const seqs = new Map();
      for (const e of of) {
        const seq = N.seqOf(e.name) || 'other';
        (seqs.get(seq) || seqs.set(seq, []).get(seq)).push(e);
      }
      for (const [seq, shots] of seqs) {
        out.push(el('div', { class: 'seq-label', text: seq }), el('div', { class: 'board-grid ent-grid' }, shots.map((e) => entityTile(project, e))));
      }
    }
    if (!out.length) {
      out.push(el('div', { class: 'home-empty cat-empty' },
        el('p', { text: q ? `Nothing in the catalogue matches "${$('q').value.trim()}".` : 'Nothing is filed in this project yet.' }),
        !q && el('p', { text: 'On one of its boards, select images or videos and file them as versions (Shift+V). Or bring many files in at once from Import.' }),
        !q && el('a', { class: 'btn', href: `#/f/${project.id}/import`, text: 'Import files' })));
    }
    return out;
  }

  // A version opens in the player (viewer.js), the same one a board opens its media in: with every other
  // version of the same thing beside it, and what has been said about them, live.
  let player = null;
  async function lookAt(entityId, versionId) {
    if (!player) player = WBViewer.create({ me: () => me, title: () => '', media: () => [], notes: () => [], add() {}, set() {}, remove() {} });
    try {
      await WBViewer.openEntity(player, entityId, { version: versionId, me, onClose: () => { shownProject = ''; render(); } });
    } catch (err) {
      fail(err);
    }
  }

  let showHidden = false;
  function entityPage(project, page) {
    const { entity } = page;
    const hidden = page.versions.filter((v) => v.hidden).length;
    const versions = page.versions.filter((v) => showHidden || !v.hidden);
    const byVersion = new Map(page.versions.map((v) => [v.id, v]));
    const hip = (v) => (v.hip != null ? `from HIP v${String(v.hip).padStart(3, '0')}` : null);
    const card = (v) => el('div', { class: `card ver${v.hidden ? ' hidden-ver' : ''}` },
      el('button', { type: 'button', class: `card-thumbs n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw', onclick: () => lookAt(entity.id, v.id) },
        v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
        v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: v.label }),
        el('div', { class: 'card-meta', text: [v.artist, v.descriptor, hip(v)].filter(Boolean).join(' · ') || v.originalName || '' }),
        el('div', { class: 'card-meta', text: `Filed ${ago(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}${v.hidden ? ' · hidden' : ''}` }),
        v.boards.length > 0 && el('div', { class: 'ver-boards' }, v.boards.map((b) => el('a', { class: 'ver-board', href: `/b/${b.id}`, text: b.name })))),
      menuButton([
        [v.hidden ? 'Show it again' : 'Hide it', async () => { await api('PATCH', `/api/versions/${v.id}`, { hidden: !v.hidden }); render(); }],
        ['Download', () => { location.href = v.look.orig || v.look.src; }],
      ]));
    // What was said, by thread, newest version first.
    const roots = page.notes.filter((n) => !n.re);
    const replies = (id) => page.notes.filter((n) => n.re === id).sort((a, b) => a.t - b.t);
    const order = new Map(page.versions.map((v, i) => [v.id, i]));
    roots.sort((a, b) => (order.get(a.versionId) ?? 0) - (order.get(b.versionId) ?? 0) || a.t - b.t);
    const msg = (n, first) => el('div', { class: `ent-msg${first ? '' : ' reply'}` },
      el('span', { class: 'avatar sm', style: { background: /^#[0-9a-f]{6}$/i.test(n.color || '') ? n.color : '#8a8a8a' }, text: WB.initials(n.name || '?') }),
      el('div', { class: 'ent-msg-main' },
        el('div', { class: 'ent-msg-top' }, el('strong', { text: n.name }), el('span', { text: ago(n.t) }),
          first && el('a', { href: `/b/${n.board.id}#c=${n.id}`, text: `on ${n.board.name || 'a board'}` })),
        el('div', { class: 'ent-msg-text', text: n.text })));
    const threads = roots.map((n) => el('div', { class: `ent-thread${n.done ? ' done' : ''}` },
      el('div', { class: 'ent-thread-ver' }, byVersion.get(n.versionId)?.label || '', n.done && el('span', { class: 'ent-done', text: 'Resolved' })),
      msg(n, true), replies(n.id).map((r) => msg(r, false))));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    return el('div', { class: 'ent-page' },
      el('a', { class: 'ent-back', href: `#/f/${project.id}/catalogue`, text: '← Catalogue' }),
      el('div', { class: 'ent-head' }, el('h1', { text: entity.name }), el('span', { class: 'ent-tier', text: entity.tier })),
      label('Versions', versions.length),
      hidden > 0 && el('label', { class: 'ent-hidden' }, el('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; render(); } }), `Show hidden (${hidden})`),
      versions.length ? el('div', { class: 'board-grid ent-grid' }, versions.map(card)) : el('p', { class: 'home-empty', text: 'No versions yet' }),
      label('Notes', roots.length),
      roots.length ? el('div', { class: 'ent-threads' }, threads) : el('p', { class: 'home-empty', text: 'Nothing said about it yet. Notes made on any board it is on show here.' }));
  }

  // ---- importing: many files at once, straight into the catalogue

  const imports = new Map(); // project id -> { rows, node }
  const megabytes = (bytes) => `${Math.round(bytes / 1048576).toLocaleString()} MB`;

  // A file brought in here goes through what a file dropped on a board does (ingest.js): a video is made
  // into its review copy, with its timeline strip, stills and frame rate, and the file it was made from is
  // kept too. Only then is it filed.
  async function bringIn(r, paint) {
    const { ingest, upload, fileExt, VID_EXT } = WBIngest;
    const isVideo = VID_EXT.test(fileExt(r.file));
    const at = { enc: 0, up: 0, strip: 0, orig: 0 };
    const tell = (part, k) => {
      at[part] = Math.max(at[part], Math.min(1, k));
      r.progress = isVideo ? at.enc * 0.4 + at.up * 0.25 + at.strip * 0.15 + at.orig * 0.2 : at.up;
      r.phase = part;
      paint();
    };
    const look = await ingest(r.file, (k) => tell('up', k), isVideo ? { onPhase: (k) => tell('enc', k), onStrip: (k) => tell('strip', k) } : {});
    if (isVideo && !look.orig) {
      const max = WB.info().maxUpload;
      if (!max || r.file.size <= max) look.orig = (await upload(r.file, fileExt(r.file), (k) => tell('orig', k))).url;
      else r.note = `The original is ${megabytes(r.file.size)}, more than is kept here, so only its review copy is`;
    }
    return look;
  }

  function importView(project) {
    let state = imports.get(project.id);
    if (state) return state.node;
    const presetId = project.settings && project.settings.naming;
    const rows = [];
    const list = el('div', { class: 'imp-list' });
    const pending = el('div', { class: 'imp-pending' });
    const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime', hidden: true });
    const drop = el('div', { class: 'imp-drop', tabindex: '0', role: 'button', onclick: () => picker.click() },
      el('span', { class: 'imp-drop-ic', html: svg('<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>', 22) }),
      el('b', { text: 'Drop files here, or click to choose' }),
      el('span', { text: 'Whatever a file’s name says (kilo-0010_anim_erik_v012.mov) files it at once. Only the ones whose names say nothing are asked about. Nothing goes on a board.' }));
    const node = el('div', { class: 'imp' }, drop, pending, list, picker);
    state = { rows, node };
    imports.set(project.id, state);

    let cat = catalogues.get(project.id) || null;
    const catalogue = async () => cat || (cat = await api('GET', `/api/projects/${project.id}`));
    const remembered = () => store(`wb:file:${project.id}`) || {};

    const PHASE = { enc: 'Preparing', up: 'Uploading', strip: 'Building timeline', orig: 'Keeping the original' };
    function rowNode(r) {
      const status = {
        queued: 'Waiting', uploading: `${PHASE[r.phase] || 'Preparing'} ${Math.min(99, Math.round((r.progress || 0) * 100))}%`, filing: 'Filing…',
        filed: r.label ? `Filed as ${r.label}` : 'Filed', failed: r.error || 'Failed', needs: 'Which asset, set or shot?',
      }[r.status];
      return el(r.version ? 'button' : 'div', {
        class: `imp-row ${r.status}`, ...(r.version && { type: 'button', title: 'Open it, to look, comment and draw', onclick: () => lookAt(r.version.entityId, r.version.id) }),
      },
        el('span', { class: 'imp-thumb' }, r.preview && el('img', { src: r.preview, alt: '' })),
        el('span', { class: 'imp-name', text: r.file.name }),
        el('span', { class: 'imp-said', text: [r.parsed.entity, r.parsed.task, r.parsed.hip != null && `HIP v${String(r.parsed.hip).padStart(3, '0')}`].filter(Boolean).join(' · ') }),
        el('span', { class: 'imp-status', text: status }));
    }

    function paint() {
      list.replaceChildren(...rows.filter((r) => r.status !== 'needs').map(rowNode).reverse());
      const needs = rows.filter((r) => r.status === 'needs');
      if (!needs.length) return pending.replaceChildren();
      const last = remembered();
      const entIn = el('input', { type: 'text', list: 'imp-entities', placeholder: 'kilo-0010, char-robot, set-kitchen…', value: pending.dataset.entity ?? last.entity ?? '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Asset, set or shot' });
      const taskIn = el('input', { type: 'text', list: 'imp-tasks', placeholder: 'No task', value: pending.dataset.task ?? last.task ?? '', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Task' });
      const tierSel = el('select', { 'aria-label': 'What it is' }, (cat ? cat.preset.tiers : N.preset(presetId).tiers).map((t) => el('option', { value: t.id, text: `A new ${t.one}` })));
      const go = el('button', { type: 'submit', class: 'btn primary', text: `File ${needs.length === 1 ? 'it' : `these ${needs.length}`}` });
      const check = () => {
        pending.dataset.entity = entIn.value;
        pending.dataset.task = taskIn.value;
        const name = N.tokenize(entIn.value);
        const have = cat && cat.entities.find((e) => e.name === name);
        const shape = name && N.tierOf(name, presetId);
        tierSel.hidden = !name || !!have || !!shape;
        if (shape) tierSel.value = shape;
        go.disabled = !name;
      };
      entIn.addEventListener('input', check);
      taskIn.addEventListener('input', check);
      const form = el('form', {
        class: 'imp-ask',
        onsubmit: async (e) => {
          e.preventDefault();
          const name = N.tokenize(entIn.value);
          if (!name) return;
          const have = cat && cat.entities.find((x) => x.name === name);
          const task = N.tokenize(taskIn.value);
          store(`wb:file:${project.id}`, { entity: name, task });
          await fileRows(needs, { entity: have ? have.id : { name, tier: tierSel.hidden ? N.tierOf(name, presetId) || 'asset' : tierSel.value }, task: task || null });
        },
      },
      el('div', { class: 'imp-ask-head' }, el('b', { text: needs.length === 1 ? 'One file’s name says nothing' : `${needs.length} files’ names say nothing` }),
        el('span', { text: 'Say what they are, and they are filed together.' })),
      el('div', { class: 'imp-ask-thumbs' }, needs.map((r) => el('span', { class: 'imp-thumb', title: r.file.name }, r.preview && el('img', { src: r.preview, alt: '' })))),
      el('div', { class: 'imp-ask-fields' }, entIn, tierSel, taskIn, go),
      el('datalist', { id: 'imp-entities' }, (cat ? cat.entities : []).map((x) => el('option', { value: x.name }))),
      el('datalist', { id: 'imp-tasks' }, (cat ? cat.tasks : N.preset(presetId).tasks).map((t) => el('option', { value: t }))));
      pending.replaceChildren(form);
      check();
    }

    async function fileRows(list, choice = {}) {
      for (const r of list) r.status = 'filing';
      paint();
      try {
        const res = await api('POST', `/api/projects/${project.id}/versions`, { files: list.map((r) => ({ look: r.look })), ...choice, by: me.name });
        res.versions.forEach((v, i) => { list[i].status = 'filed'; list[i].label = v.label; list[i].version = v; });
        cat = null;
        await catalogue().catch(() => {});
      } catch (err) {
        for (const r of list) {
          r.status = choice.entity ? 'needs' : 'failed';
          r.error = err.message;
        }
        if (choice.entity) WB.dialog({ title: 'Those were not filed', text: err.message, ok: 'OK', cancellable: false });
      }
      paint();
    }

    // One file at a time: read, upload, and file at once when its name says what it is.
    let running = false;
    async function work() {
      if (running) return;
      running = true;
      await catalogue().catch(() => {});
      for (let r = rows.find((x) => x.status === 'queued'); r; r = rows.find((x) => x.status === 'queued')) {
        r.status = 'uploading';
        r.progress = 0;
        paint();
        try {
          r.look = await bringIn(r, paint);
          r.preview = r.look.th || (r.look.type === 'image' ? r.look.prev || r.look.src : r.look.poster) || null;
          if (r.parsed.entity) await fileRows([r]);
          else r.status = 'needs';
        } catch (err) {
          r.status = 'failed';
          r.error = err.refused ? `This browser cannot process this video. Import it from ${WBIngest.OTHER_BROWSERS} instead` : err.message;
        }
        paint();
      }
      running = false;
    }

    function add(files) {
      for (const file of files) {
        if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|m4v|webm|mov)$/i.test(file.name)) continue;
        rows.push({ file, status: 'queued', progress: 0, parsed: N.parse(file.name, presetId), look: null, preview: null });
      }
      paint();
      work();
    }
    picker.addEventListener('change', () => { add([...picker.files]); picker.value = ''; });
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
    for (const type of ['dragover', 'dragenter']) drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('drop'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drop'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('drop');
      add([...e.dataTransfer.files]);
    });
    return node;
  }

  // ------------------------------------------------------------- actions

  async function newBoard() {
    const name = await WB.dialog({ title: 'New board', value: `Standup ${new Date().toLocaleDateString()}`, placeholder: 'Board name', ok: 'Create board' });
    if (!name) return;
    try {
      const board = await api('POST', '/api/boards', { name, folderId: currentFolder(), workspace: space, by: me.name });
      location.href = `/b/${board.id}`;
    } catch (err) {
      fail(err);
    }
  }
  $('new').addEventListener('click', newBoard);

  $('newfolder').addEventListener('click', async () => {
    const name = await WB.dialog({ title: 'New folder', value: '', placeholder: 'Folder name', ok: 'Create folder' });
    if (!name) return;
    try {
      await api('POST', '/api/folders', { name, parentId: currentFolder(), workspace: space });
      refresh();
    } catch (err) {
      fail(err);
    }
  });

  // ------------------------------------------------------------- notifications

  // Replies, comments on your work and boards, and mentions, newest first (see notifications.js).
  // Without sign-in the server only knows you by the name you gave, so it is sent along.
  const noticeUrl = (p = '') => `/api/notifications${p}${WB.info().user ? '' : `?name=${encodeURIComponent(me.name)}`}`;
  const NOTICE_TEXT = {
    mention: () => 'mentioned you',
    reply: () => 'replied to you',
    work: (n) => `commented on ${n.on}`,
    board: (n) => `commented on ${n.on}`,
  };
  let notices = { items: [], unread: 0 };

  async function loadNotices() {
    try {
      notices = await api('GET', noticeUrl());
    } catch {
      return;
    }
    $('bellcount').hidden = !notices.unread;
    $('bellcount').textContent = notices.unread > 99 ? '99+' : notices.unread;
    $('bell').title = notices.unread ? `Notifications: ${notices.unread} unread` : 'Notifications';
    if (!$('notices').hidden) paintNotices();
  }

  async function markNotices(body) {
    try {
      await api('POST', noticeUrl('/read'), body);
    } catch {
      // the next check shows them as they are
    }
  }

  function paintNotices() {
    const row = (n) => el('a', {
      class: `notice${n.read ? '' : ' unread'}`,
      href: `/b/${n.board.id}#c=${n.id}`,
      onclick: () => { if (!n.read) markNotices({ ids: [n.id] }); },
    },
    el('span', { class: 'avatar sm', style: { background: /^#[0-9a-f]{6}$/i.test(n.color || '') ? n.color : '#8a8a8a' }, text: WB.initials(n.author) }),
    el('span', { class: 'notice-body' },
      el('span', { class: 'notice-what' }, el('strong', { text: n.author }), n.guest && el('span', { class: 'notice-guest', text: 'guest' }), ` ${NOTICE_TEXT[n.kind](n)}`),
      el('span', { class: 'notice-text', text: n.text }),
      el('span', { class: 'notice-where', text: `${n.board.name} · ${ago(n.at)}` })),
    !n.read && el('i', { class: 'notice-dot', 'aria-label': 'Unread' }));
    $('notices').replaceChildren(
      el('header', { class: 'notices-head' },
        el('h2', { text: 'Notifications' }),
        notices.unread > 0 && el('button', {
          class: 'btn small ghost', text: 'Mark all as read',
          onclick: async () => { await markNotices({ all: true }); loadNotices(); },
        })),
      notices.items.length
        ? el('div', { class: 'notices-list' }, notices.items.map(row))
        : el('p', { class: 'notices-empty', text: 'Nothing yet. Replies to you, comments on your work and boards, and @mentions of your name show up here.' }));
  }

  function toggleNotices(open = $('notices').hidden) {
    $('notices').hidden = !open;
    $('bell').setAttribute('aria-expanded', String(open));
    if (open) {
      paintNotices();
      loadNotices();
    }
  }
  $('bell').addEventListener('click', () => toggleNotices());
  document.addEventListener('pointerdown', (e) => {
    if (!$('notices').hidden && !e.target.closest('.bellwrap')) toggleNotices(false);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('notices').hidden) toggleNotices(false); });
  loadNotices();
  setInterval(() => { if (!document.hidden) loadNotices(); }, 30000);
  // Coming back to this tab from a board: what was read there, or arrived since, shows at once.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotices(); });

  $('q').addEventListener('input', render);
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== $('q') && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('q').focus();
    } else if (e.key === 'Escape' && document.activeElement === $('q')) {
      $('q').value = '';
      $('q').blur();
      render();
    }
  });
  window.addEventListener('hashchange', render);
  await refresh();
  setInterval(() => { if (!document.hidden && !dragging && !document.querySelector('dialog[open], .menu')) refresh(true); }, 15000);
})();
