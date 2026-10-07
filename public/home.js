'use strict';

(async () => {
  const { el, api, ago, store } = WB;
  const $ = (id) => document.getElementById(id);

  const svg = (d, size = 20) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
  const ICON_FOLDER = svg(FOLDER, 20);
  const ICON_FOLDER_SM = svg(FOLDER, 16);
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
  if (hasPersonal && store('wb:workspace') === 'personal') space = 'personal';
  const paintMe = () => $('me').replaceChildren(
    el('span', { class: 'avatar sm', style: { background: me.color }, text: WB.initials(me.name) }),
    el('span', { text: me.name }));
  paintMe();
  if (WB.info().signOut) {
    // Signed in with Google: the name comes from the account, so the chip is a sign-out instead.
    $('me').title = 'Sign out';
    $('me').addEventListener('click', () => { location.href = '/auth/logout'; });
  } else {
    $('me').addEventListener('click', async () => {
      me = await WB.askName(true);
      paintMe();
    });
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

  async function refresh() {
    try {
      everything = await api('GET', '/api/library');
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
        api('PATCH', kind === 'board' ? `/api/boards/${id}` : `/api/folders/${id}`, { workspace: name }).then(refresh).catch(fail);
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
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
  }

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

      const dlg = el('dialog', { class: 'dlg' },
        el('form', { method: 'dialog' },
          el('h2', { text: title }),
          list,
          el('div', { class: 'dlg-actions' },
            el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close('cancel') }),
            el('button', { type: 'submit', class: 'btn primary', text: 'Move here' }))));
      dlg.addEventListener('cancel', () => { dlg.returnValue = 'cancel'; });
      dlg.addEventListener('close', () => {
        dlg.remove();
        resolve(dlg.returnValue === 'cancel' ? undefined : chosen);
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
      text: 'It disappears for everyone. The board is moved to the trash folder on the server, so whoever runs the server can still restore it.',
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

  function folderCard(folder) {
    const subs = childrenOf(folder.id).length;
    const boards = boardsIn(folder.id).length;
    const meta = [boards && plural(boards, 'board'), subs && plural(subs, 'folder')].filter(Boolean).join(' · ') || 'Empty';
    const card = el('a', { class: 'card folder', href: `#/f/${folder.id}` },
      el('div', { class: 'folder-icon', html: ICON_FOLDER }),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: folder.name }),
        el('div', { class: 'card-meta', text: meta })),
      menuButton([
        ['Rename', () => rename('folder', folder)],
        ['Move to…', () => moveDialog('folder', folder)],
        hasPersonal && [`Move to ${SPACES[otherSpace()]} workspace`, () => moveSpace('folder', folder)],
        ['Delete folder', () => removeFolder(folder), true],
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
    const node = el('a', { class: 'crumb', href: folder ? `#/f/${folder.id}` : '#/', text: folder ? folder.name : (hasPersonal ? SPACES[space] : 'All boards') });
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
    document.title = `${trail.length ? trail[trail.length - 1].name : hasPersonal ? SPACES[space] : 'All boards'} · Wipboard`;

    // A search looks through every folder; without one you see the folder you are in.
    const q = $('q').value.trim().toLowerCase();
    const matches = (name) => name.toLowerCase().includes(q);
    const subs = q ? lib.folders.filter((f) => matches(f.name)).sort(byName) : childrenOf(cur);
    const boards = q ? lib.boards.filter((b) => matches(b.name)) : boardsIn(cur);
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    $('content').replaceChildren(...[
      subs.length > 0 && label('Folders', subs.length),
      subs.length > 0 && el('div', { class: 'folder-grid' }, subs.map(folderCard)),
      (subs.length > 0 || q) && label('Boards', boards.length),
      el('div', { class: 'board-grid' }, [...(q ? [] : [newBoardTile()]), ...boards.map(boardCard)]),
      q && !subs.length && !boards.length && el('p', { class: 'home-empty', text: `Nothing matches "${$('q').value.trim()}".` }),
    ].filter(Boolean));
    $('empty').hidden = true;
  }

  // ------------------------------------------------------------- actions

  async function newBoard() {
    const name = await WB.dialog({ title: 'New board', value: `Standup ${new Date().toLocaleDateString()}`, placeholder: 'Board name', ok: 'Create board' });
    if (!name) return;
    try {
      const board = await api('POST', '/api/boards', { name, folderId: currentFolder(), workspace: space });
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
  window.addEventListener('hashchange', () => { if (lib.folders) render(); });
  await refresh();
  setInterval(() => { if (!document.hidden && !dragging && !document.querySelector('dialog[open], .menu')) refresh(); }, 15000);
})();
