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
  // Normal cards, or compact rows: a small still beside the name, many more to a screen. Remembered here.
  const ICON_ROWS = svg('<path d="M4 6h16M4 12h16M4 18h16"/>', 18);
  const ICON_CARDS = svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', 18);
  function paintDensity() {
    const compact = document.documentElement.dataset.density === 'compact';
    $('density').innerHTML = compact ? ICON_CARDS : ICON_ROWS;
    $('density').title = compact ? 'Show as cards' : 'Show as compact rows';
    $('density').setAttribute('aria-label', $('density').title);
    $('density').setAttribute('aria-pressed', String(compact));
  }
  $('density').addEventListener('click', () => {
    const compact = document.documentElement.dataset.density !== 'compact';
    if (compact) document.documentElement.dataset.density = 'compact';
    else delete document.documentElement.dataset.density;
    try { localStorage.setItem('wb:density', JSON.stringify(compact ? 'compact' : 'normal')); } catch { /* remembered for now only */ }
    paintDensity();
  });
  paintDensity();
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
  // A folder is found whatever workspace it is in; only the top level, `null`, is the workspace's own.
  const folderById = (id) => everything.folders.find((f) => f.id === id) || null;
  const childrenOf = (id, ws = space) => (id ? everything.folders : everything.folders.filter((f) => f.workspace === ws)).filter((f) => (f.parentId || null) === id).sort(byName);
  const boardsIn = (id, ws = space) => (id ? everything.boards : everything.boards.filter((b) => b.workspace === ws)).filter((b) => (b.folderId || null) === id);

  function currentFolder() {
    const m = /^#\/f\/([\w-]+)/.exec(location.hash);
    return m && folderById(m[1]) ? m[1] : null;
  }

  // In a project folder: which of its pages is open, boards or catalogue, and in the catalogue the tier
  // (#/f/<id>/catalogue/t/shot), the sequence (…/s/kilo) or the entity (…/<entity id>) being looked at.
  function currentView() {
    // The Import page that was is part of the catalogue now.
    if (/^#\/f\/[\w-]+\/timeline/.test(location.hash)) return { page: 'timeline', entity: null };
    if (/^#\/f\/[\w-]+\/versions/.test(location.hash)) return { page: 'versions', entity: null };
    const m = /^#\/f\/[\w-]+\/(catalogue|import)(?:\/(?:(t|s)\/([\w-]+)|([\w-]+)))?/.exec(location.hash);
    if (!m) return { page: 'boards', entity: null };
    if (m[1] === 'import') return { page: 'catalogue', entity: null };
    return { page: 'catalogue', tier: m[2] === 't' ? m[3] : null, seq: m[2] === 's' ? m[3] : null, entity: m[4] || null };
  }

  // Where the page is: Home (#/), a workspace's top level (#/w/<workspace>), or a folder (#/f/<id>…).
  function route() {
    const f = currentFolder();
    if (f) return { kind: 'folder', id: f };
    const w = /^#\/w\/(myreze|personal)/.exec(location.hash);
    if (w && (w[1] === 'myreze' || hasPersonal)) return { kind: 'space', space: w[1] };
    if (/^#\/(w|f)\//.test(location.hash)) return { kind: 'space', space };
    return { kind: 'home' };
  }
  const spaceHref = (ws) => `#/w/${ws}`;
  const spaceName = (ws) => (hasPersonal ? SPACES[ws] : 'All boards');

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
      const sig = JSON.stringify(next);
      if (quiet === true && sig === shown && Date.now() - shownAt < 60000) return;
      shown = sig;
      shownAt = Date.now();
      everything = next;
      render();
    } catch (err) {
      $('empty').hidden = false;
      $('empty').textContent = `Could not load boards: ${err.message}`;
    }
  }

  const otherSpace = (ws = space) => (ws === 'myreze' ? 'personal' : 'myreze');

  async function moveSpace(kind, thing) {
    await api('PATCH', kind === 'board' ? `/api/boards/${thing.id}` : `/api/folders/${thing.id}`, { workspace: otherSpace(thing.workspace) });
    await refresh();
  }

  async function moveTo(kind, id, folderId) {
    if (kind === 'board') await api('PATCH', `/api/boards/${id}`, { folderId });
    else await api('PATCH', `/api/folders/${id}`, { parentId: folderId });
    await refresh();
  }

  // ------------------------------------------------------------- drag and drop

  const dragged = () => dragging && (dragging.kind === 'folder' ? folderById(dragging.id) : everything.boards.find((x) => x.id === dragging.id));

  // `ws` is the workspace of the place dropped on. Into another workspace goes to its top level.
  function canDrop(folderId, ws = space) {
    const thing = dragged();
    if (!thing) return false;
    if (thing.workspace !== ws) return folderId === null;
    if (dragging.kind === 'folder') {
      if (folderId === thing.id || (folderId && isWithin(folderId, thing.id))) return false;
      return (thing.parentId || null) !== folderId;
    }
    return (thing.folderId || null) !== folderId;
  }

  function dropTarget(node, folderId, ws = space) {
    node.addEventListener('dragover', (e) => {
      if (!canDrop(folderId, ws)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('drop');
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('drop');
    });
    node.addEventListener('drop', (e) => {
      node.classList.remove('drop');
      if (!canDrop(folderId, ws)) return;
      e.preventDefault();
      const thing = dragged();
      const { kind, id } = dragging;
      dragging = null;
      (thing.workspace !== ws ? moveSpace(kind, thing) : moveTo(kind, id, folderId)).catch(fail);
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
  const holdsProject = (id) => everything.folders.some((f) => f.project && isWithin(f.id, id));

  async function setProject(folder, on) {
    if (on) {
      const sure = await WB.dialog({
        title: `Make “${folder.name}” a project?`,
        text: 'A project keeps a catalogue: its assets, sets and shots, and every version filed of them, from its boards or dropped straight into it. A project cannot be deleted, and stays one once something is filed in it.',
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
    const card = el('a', { class: `card folder${folder.project ? ' project' : ''}${bpick.has(`folder:${folder.id}`) ? ' picked' : ''}`, href: `#/f/${folder.id}`, 'data-pick': `folder:${folder.id}` },
      el('div', { class: 'folder-icon', html: folder.project ? ICON_PROJECT : ICON_FOLDER }),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: folder.name }),
        el('div', { class: 'card-meta', text: meta })),
      menuButton([
        ['Rename', () => rename('folder', folder)],
        ['Move to…', () => moveDialog('folder', folder)],
        [isPinned('folder', folder.id) ? 'Unpin from Home' : 'Pin to Home', () => togglePin({ kind: 'folder', id: folder.id })],
        hasPersonal && [`Move to ${SPACES[otherSpace(folder.workspace)]} workspace`, () => moveSpace('folder', folder)],
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
    const card = el('a', { class: `card${bpick.has(`board:${board.id}`) ? ' picked' : ''}`, href: `/b/${board.id}`, 'data-pick': `board:${board.id}` },
      thumbs,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: board.name }),
        el('div', { class: 'card-meta' },
          `${plural(board.count, 'item')} · edited ${ago(board.updatedAt)}`,
          board.online > 0 && el('span', { class: 'card-live', text: `${board.online} here now` }))),
      menuButton([
        ['Rename', () => rename('board', board)],
        ['Move to…', () => moveDialog('board', board)],
        [isPinned('board', board.id) ? 'Unpin from Home' : 'Pin to Home', () => togglePin({ kind: 'board', id: board.id })],
        hasPersonal && [`Move to ${SPACES[otherSpace(board.workspace)]} workspace`, () => moveSpace('board', board)],
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

  // ------------------------------------------------------------- pinned and recent
  //
  // Both are kept by this browser. What you opened (boards, from board.js, and assets, sets and shots)
  // is remembered as you go; what you pin stays on Home until you unpin it.

  const pins = () => (Array.isArray(store('wb:pins')) ? store('wb:pins') : []);
  const isPinned = (kind, id) => pins().some((p) => p.kind === kind && p.id === id);
  function togglePin(entry) {
    const list = pins();
    const at = list.findIndex((p) => p.kind === entry.kind && p.id === entry.id);
    if (at >= 0) list.splice(at, 1);
    else list.unshift({ ...entry, at: Date.now() });
    store('wb:pins', list.slice(0, 60));
    render();
  }

  // ------------------------------------------------------------- the sidebar
  //
  // Always there on a wide window, and a drawer on a narrow one: Home, then each workspace with its
  // folders as a tree. A project opens to its boards and its catalogue, and the catalogue to its assets,
  // sets and shots, the shots by sequence. What is open in the tree is remembered.

  const ICON_HOME = svg('<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>', 16);
  const ICON_BOARDS = svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', 16);
  const ICON_CAT = svg('<path d="M5 4h4v16H5zM10 4h4v16h-4z"/><path d="M15.5 4.6l3.8-1 3.7 15.5-3.8 1z"/>', 16);
  const ICON_LIST = svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/>', 16);
  const ICON_FILM = svg('<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M8 6v12M16 6v12M3 10h5M3 14h5M16 10h5M16 14h5"/>', 16);
  const ICON_DOT = svg('<circle cx="12" cy="12" r="2" fill="currentColor"/>', 16);
  const ICON_CHEVRON = svg('<path d="M9 6l6 6-6 6"/>', 14);
  const ICON_STAR = svg('<path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z"/>', 16);
  const FOLDER_SM = svg(FOLDER, 16);
  const PROJECT_SM = svg(STACK, 16);

  const opened = new Set(Array.isArray(store('wb:tree')) ? store('wb:tree') : []);
  const setOpen = (key, on) => {
    if (on) opened.add(key);
    else opened.delete(key);
    store('wb:tree', [...opened]);
  };

  // The key of the place the page is on, as the tree names its rows.
  function hereKey(rt) {
    if (rt.kind === 'home') return 'home';
    if (rt.kind === 'space') return `w:${rt.space}`;
    const f = folderById(rt.id);
    const v = f && f.project ? currentView() : { page: 'boards' };
    if (v.page === 'timeline') return `tl:${rt.id}`;
    if (v.page === 'versions') return `vl:${rt.id}`;
    if (v.page !== 'catalogue') return f && f.project ? `p:${rt.id}` : `f:${rt.id}`;
    if (v.seq) return `s:${rt.id}:${v.seq}`;
    if (v.tier) return `t:${rt.id}:${v.tier}`;
    if (v.entity) {
      const e = (catalogues.get(rt.id)?.entities || []).find((x) => x.id === v.entity);
      if (e && e.tier === 'shot' && N.seqOf(e.name)) return `s:${rt.id}:${N.seqOf(e.name)}`;
      return e ? `t:${rt.id}:${e.tier}` : `c:${rt.id}`;
    }
    return `c:${rt.id}`;
  }

  // The rows above the place the page is on are opened, so it can be seen in the tree.
  function openTo(rt) {
    if (rt.kind !== 'folder') return;
    for (const f of trailTo(rt.id).slice(0, -1)) opened.add(`f:${f.id}`);
    const f = folderById(rt.id);
    if (!f) return;
    if (f.project) {
      opened.add(`f:${f.id}`);
      const v = currentView();
      if (v.page === 'catalogue') opened.add(`c:${f.id}`);
      const key = hereKey(rt);
      if (key.startsWith('s:')) opened.add(`t:${f.id}:shot`);
    }
  }

  function sideRow({ key, depth, icon, label, href, count, kids, drop, hereK, cls = '' }) {
    const isOpen = kids && opened.has(key);
    const row = el('div', { class: `side-row${key === hereK ? ' here' : ''}${cls ? ` ${cls}` : ''}`, style: { paddingLeft: `${depth * 14}px` } },
      kids
        ? el('button', {
          type: 'button', class: `side-twist${isOpen ? ' open' : ''}`, html: ICON_CHEVRON, 'aria-label': isOpen ? `Close ${label}` : `Open ${label}`, 'aria-expanded': String(!!isOpen),
          onclick: () => { setOpen(key, !isOpen); renderSide(route()); },
        })
        : el('span', { class: 'side-twist none' }),
      el('a', { class: 'side-link', href, onclick: () => { if (kids && !isOpen) setOpen(key, true); closeDrawer(); } },
        el('span', { class: 'side-icon', html: icon }),
        el('span', { class: 'side-name', text: label }),
        count != null && el('span', { class: 'side-count', text: String(count) })));
    if (drop) drop(row);
    const out = [row];
    if (isOpen) out.push(...kids());
    return out;
  }

  function folderRows(f, depth, ws, hereK) {
    const subs = () => childrenOf(f.id).flatMap((c) => folderRows(c, depth + 1, ws, hereK));
    const drop = (row) => dropTarget(row, f.id, ws);
    if (!f.project) {
      return sideRow({ key: `f:${f.id}`, depth, icon: FOLDER_SM, label: f.name, href: `#/f/${f.id}`, kids: childrenOf(f.id).length ? subs : null, drop, hereK });
    }
    // A project: its boards (and folders), and its catalogue.
    const cat = catalogues.get(f.id);
    const tierRows = () => {
      if (!cat) {
        loadCatalogue(f.id);
        return [el('div', { class: 'side-row side-note', style: { paddingLeft: `${(depth + 2) * 14 + 32}px` }, text: 'Loading…' })];
      }
      return cat.preset.tiers.flatMap((t) => {
        const of = cat.entities.filter((e) => e.tier === t.id);
        const seqs = t.id === 'shot' ? [...new Set(of.map((e) => N.seqOf(e.name)).filter(Boolean))].sort() : [];
        return sideRow({
          key: `t:${f.id}:${t.id}`, depth: depth + 2, icon: ICON_DOT, label: t.label, href: `#/f/${f.id}/catalogue/t/${t.id}`, count: of.length, hereK,
          kids: seqs.length ? () => seqs.flatMap((q) => sideRow({ key: `s:${f.id}:${q}`, depth: depth + 3, icon: ICON_DOT, label: q, href: `#/f/${f.id}/catalogue/s/${q}`, count: of.filter((e) => N.seqOf(e.name) === q).length, hereK })) : null,
        });
      });
    };
    const kids = () => [
      ...sideRow({ key: `p:${f.id}`, depth: depth + 1, icon: ICON_BOARDS, label: 'Boards', href: `#/f/${f.id}`, count: boardsIn(f.id).length, drop, hereK }),
      ...sideRow({ key: `c:${f.id}`, depth: depth + 1, icon: ICON_CAT, label: 'Catalogue', href: `#/f/${f.id}/catalogue`, kids: tierRows, hereK }),
      ...sideRow({ key: `vl:${f.id}`, depth: depth + 1, icon: ICON_LIST, label: 'Versions', href: `#/f/${f.id}/versions`, hereK }),
      ...sideRow({ key: `tl:${f.id}`, depth: depth + 1, icon: ICON_FILM, label: 'Timeline', href: `#/f/${f.id}/timeline`, hereK }),
      ...subs(),
    ];
    return sideRow({ key: `f:${f.id}`, depth, icon: PROJECT_SM, label: f.name, href: `#/f/${f.id}`, kids, drop, hereK, cls: 'project' });
  }

  const loading = new Set();
  async function loadCatalogue(id) {
    if (loading.has(id)) return;
    loading.add(id);
    try {
      catalogues.set(id, await api('GET', `/api/projects/${id}`));
    } catch {
      // the tree shows the project without its catalogue's parts
    }
    loading.delete(id);
    renderSide(route());
    renderCrumbs(route());
    if (route().kind === 'home' && !$('q').value.trim()) render();
  }

  function renderSide(rt) {
    const hereK = hereKey(rt);
    const wsList = hasPersonal ? ['myreze', 'personal'] : ['myreze'];
    $('side').replaceChildren(
      ...sideRow({ key: 'home', depth: 0, icon: ICON_HOME, label: 'Home', href: '#/', hereK, cls: 'top' }),
      ...wsList.flatMap((ws) => {
        const head = el('a', { class: `side-head${hereK === `w:${ws}` ? ' here' : ''}`, href: spaceHref(ws), onclick: closeDrawer },
          el('span', { text: spaceName(ws) }),
          el('span', { class: 'side-count', text: String(everything.boards.filter((b) => b.workspace === ws).length) }));
        dropTarget(head, null, ws);
        return [head, ...childrenOf(null, ws).flatMap((f) => folderRows(f, 0, ws, hereK))];
      }));
  }

  // On a narrow window the sidebar is a drawer, opened from the bar.
  function closeDrawer() {
    document.body.classList.remove('side-open');
    $('sidetoggle').setAttribute('aria-expanded', 'false');
  }
  $('sidetoggle').addEventListener('click', () => {
    const on = !document.body.classList.contains('side-open');
    document.body.classList.toggle('side-open', on);
    $('sidetoggle').setAttribute('aria-expanded', String(on));
  });
  $('sidescrim').addEventListener('click', closeDrawer);

  // ------------------------------------------------------------- where you are
  //
  // One line: the workspace, the folders down to here, and in a catalogue the tier, the sequence and
  // the asset, set or shot. Every part goes there, folders take drops, and the star pins what is here.

  function renderCrumbs(rt) {
    const parts = []; // [label, href, folderId for drops (undefined: none), ws]
    let pin = null;
    if (rt.kind === 'home') parts.push(['Home', '#/']);
    else if (rt.kind === 'space') parts.push([spaceName(rt.space), spaceHref(rt.space), null, rt.space]);
    else {
      const trail = trailTo(rt.id);
      const ws = trail.length ? trail[0].workspace : space;
      parts.push([spaceName(ws), spaceHref(ws), null, ws]);
      for (const f of trail) parts.push([f.name, `#/f/${f.id}`, f.id, ws]);
      const f = trail[trail.length - 1];
      pin = f && { kind: 'folder', id: f.id };
      if (f && f.project) {
        const v = currentView();
        if (v.page === 'catalogue') {
          parts.push(['Catalogue', `#/f/${f.id}/catalogue`]);
          const cat = catalogues.get(f.id);
          const e = v.entity && cat && cat.entities.find((x) => x.id === v.entity);
          const tier = v.tier || (v.seq && 'shot') || (e && e.tier);
          const t = tier && cat && cat.preset.tiers.find((x) => x.id === tier);
          if (t) parts.push([t.label, `#/f/${f.id}/catalogue/t/${t.id}`]);
          const seq = v.seq || (e && e.tier === 'shot' && N.seqOf(e.name));
          if (seq) parts.push([seq, `#/f/${f.id}/catalogue/s/${seq}`]);
          if (v.entity) {
            const name = e ? e.name : shownEntity && shownEntity.id === v.entity ? shownEntity.name : '…';
            parts.push([name, `#/f/${f.id}/catalogue/${v.entity}`]);
            pin = e || (shownEntity && shownEntity.id === v.entity) ? { kind: 'entity', id: v.entity, name, projectId: f.id, tier: (e || shownEntity).tier, thumb: (e && e.thumb) || null } : null;
          }
        } else if (v.page === 'timeline') parts.push(['Timeline', `#/f/${f.id}/timeline`]);
        else if (v.page === 'versions') parts.push(['Versions', `#/f/${f.id}/versions`]);
        else parts.push(['Boards', `#/f/${f.id}`]);
        // The star pins what is here, not the project around it: a sequence, a tier, the catalogue,
        // the timeline or the versions are pinned as that place (an asset, set or shot as itself).
        if (v.page !== 'boards' && !v.entity) {
          const [name, href] = parts[parts.length - 1];
          const what = v.seq ? 'sequence' : v.tier ? 'tier' : v.page;
          pin = { kind: 'place', id: href, href, name, what, projectId: f.id };
        }
      }
    }
    const nodes = parts.map(([label, href, folderId, ws], i) => {
      const node = el('a', { class: `crumb${i === parts.length - 1 ? ' current' : ''}`, href, text: label });
      if (folderId !== undefined) dropTarget(node, folderId, ws);
      return node;
    });
    const pinned = pin && isPinned(pin.kind, pin.id);
    $('crumbs').replaceChildren(
      ...[...nodes.flatMap((node, i) => (i ? [el('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '/' }), node] : [node])),
      pin && el('button', {
        type: 'button', class: `iconbtn crumb-pin${pinned ? ' on' : ''}`, html: ICON_STAR,
        title: pinned ? 'Pinned to Home. Click to unpin' : 'Pin to Home', 'aria-pressed': String(!!pinned),
        onclick: () => togglePin(pin),
      })].filter(Boolean));
    document.title = `${parts[parts.length - 1][0]} · Boards`;
  }

  // ------------------------------------------------------------- Home
  //
  // What you pinned, along the top; then Updates, what happened to your work and to what you are cc'd on,
  // and beside it My work, what you make. Nothing else, so what matters is easy to see.

  // The feed (GET /api/feed): fetched when Home shows, at most every half minute.
  let feed = null;
  let feedAt = 0;
  async function loadFeed() {
    feedAt = Date.now();
    try {
      feed = await api('GET', `/api/feed${WB.info().user ? '' : `?name=${encodeURIComponent(me.name)}`}`);
    } catch {
      return;
    }
    if (route().kind === 'home' && !$('q').value.trim()) render();
  }
  // What came since you last marked Updates read, kept by this browser.
  const feedSeen = () => Number(store('wb:feed:seen')) || 0;
  let feedShow = store('wb:feed:show') || 'all'; // all | notes | versions
  let feedMore = false;

  function feedRow(item, seen) {
    const thing = el('strong', { text: item.version.label || item.entity.name });
    const what = item.kind === 'version'
      ? [el('strong', { text: item.by || 'Somebody' }), ' filed ', thing]
      : [el('strong', { text: item.mine ? 'You' : item.by || 'Somebody' }), item.note.reply ? ' replied on ' : ' commented on ', thing];
    const why = item.entity.role === 'cc' ? 'you are cc\'d' : 'your work';
    const where = [item.entity.project, why, ago(item.at)].filter(Boolean).join(' · ');
    const fresh = item.at > seen && !item.mine;
    return el('button', {
      type: 'button', class: `feed-row ${item.kind}${fresh ? ' unread' : ''}${item.mine ? ' mine' : ''}`, title: 'Open it, to look, comment and draw',
      onclick: () => lookAt(item.entity.id, item.version.id),
    },
    item.kind === 'version'
      ? el('span', { class: 'feed-thumb' }, item.version.thumb && el('img', { src: item.version.thumb, alt: '', loading: 'lazy' }))
      : el('span', { class: 'avatar sm', style: { background: /^#[0-9a-f]{6}$/i.test(item.color || '') ? item.color : '#8a8a8a' }, text: WB.initials(item.by || '?') }),
    el('span', { class: 'feed-body' },
      el('span', { class: 'feed-what' }, ...what),
      item.note && el('span', { class: 'feed-text', text: item.note.text }),
      el('span', { class: 'feed-where', text: where })),
    fresh && el('i', { class: 'feed-dot', 'aria-label': 'New' }));
  }

  // An asset, set or shot as its project's catalogue has it, so its card scrubs and plays like any other.
  function entityCard(p) {
    const project = folderById(p.projectId);
    if (!project) return null;
    const cat = catalogues.get(project.id);
    const full = cat && cat.entities.find((e) => e.id === p.id);
    if (!cat) loadCatalogue(project.id);
    return entityTile(project, full || { id: p.id, name: p.name, thumb: p.thumb, tier: p.tier, versions: null });
  }

  // A pinned place within a project: what it is, in which project, and a way back to it.
  function placeCard(p) {
    const project = folderById(p.projectId);
    if (!project) return null;
    const icon = { sequence: ICON_FILM, tier: ICON_CAT, catalogue: ICON_CAT, timeline: ICON_FILM, versions: ICON_LIST }[p.what] || ICON_CAT;
    const kind = { sequence: 'Sequence', tier: 'In the catalogue', catalogue: 'Catalogue', timeline: 'Timeline', versions: 'Versions' }[p.what] || '';
    const label = p.what === 'sequence' ? `${p.name}` : p.what === 'tier' ? p.name : `${project.name} ${p.name.toLowerCase()}`;
    return el('a', { class: 'card folder place', href: p.href },
      el('div', { class: 'folder-icon', html: icon }),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: label }),
        el('div', { class: 'card-meta', text: `${kind} · ${project.name}` })),
      menuButton([['Unpin from Home', () => togglePin({ kind: 'place', id: p.id })]]));
  }

  function homeView() {
    const label = (text, n, ...extra) => el('div', { class: 'section-label' }, text, n != null && el('span', { class: 'tally', text: String(n) }), ...extra);
    const q = $('q').value.trim().toLowerCase();
    if (q) {
      const subs = everything.folders.filter((f) => f.name.toLowerCase().includes(q)).sort(byName);
      const boards = everything.boards.filter((b) => b.name.toLowerCase().includes(q));
      return [
        subs.length > 0 && label('Folders', subs.length), subs.length > 0 && el('div', { class: 'folder-grid' }, subs.map(folderCard)),
        label('Boards', boards.length), el('div', { class: 'board-grid' }, boards.map(boardCard)),
        !subs.length && !boards.length && el('p', { class: 'home-empty', text: `Nothing matches "${$('q').value.trim()}".` }),
      ].filter(Boolean);
    }
    if (!feed || Date.now() - feedAt > 30000) loadFeed();

    // Pinned: the same cards as everywhere, and a place within a project (a sequence, say) as itself.
    const pinned = pins().map((p) => {
      if (p.kind === 'place') return placeCard(p);
      if (p.kind === 'board') { const b = everything.boards.find((x) => x.id === p.id); return b && boardCard(b); }
      if (p.kind === 'folder') { const f = folderById(p.id); return f && folderCard(f); }
      if (p.kind === 'entity') return entityCard(p);
      return null;
    }).filter(Boolean);

    // Updates: what happened to your work, and new versions of what you are cc'd on.
    const seen = feedSeen();
    const all = feed ? feed.items : [];
    const fresh = all.filter((x) => x.at > seen && !x.mine).length;
    const shown = all.filter((x) => feedShow === 'all' || (feedShow === 'notes' ? x.kind === 'note' : x.kind === 'version'));
    const seg = el('div', { class: 'seg feed-seg', role: 'tablist' }, [['all', 'All'], ['notes', 'Comments'], ['versions', 'New versions']].map(([k, text]) => el('button', {
      type: 'button', class: `seg-btn${feedShow === k ? ' on' : ''}`, role: 'tab', 'aria-selected': String(feedShow === k), text,
      onclick: () => { feedShow = k; store('wb:feed:show', k); feedMore = false; render(); },
    })));
    const markRead = fresh > 0 && el('button', { type: 'button', class: 'btn small ghost', text: 'Mark all read', onclick: () => { store('wb:feed:seen', Date.now()); render(); } });
    const updates = el('section', { class: 'home-main' },
      label('Updates', fresh || null, el('span', { class: 'label-gap' }), seg, markRead),
      !feed ? el('p', { class: 'home-quiet', text: 'Loading…' })
        : shown.length ? el('div', { class: 'feed' }, shown.slice(0, feedMore ? 80 : 15).map((x) => feedRow(x, seen)),
          shown.length > 15 && !feedMore && el('button', { type: 'button', class: 'feed-more', text: `Show ${shown.length - 15} more`, onclick: () => { feedMore = true; render(); } }))
          : el('p', { class: 'home-quiet', text: all.length ? 'Nothing of that kind in the last two weeks.' : 'Nothing in the last two weeks. Comments on your work, and new versions of what you are cc\'d on, come here.' }));

    // My work: what you are an artist on, or have filed.
    const work = (feed ? feed.work : []).map((e) => folderById(e.projectId) && entityTile(folderById(e.projectId), e)).filter(Boolean);
    const side = el('aside', { class: 'home-side' },
      label('My work', work.length || null),
      !feed ? el('p', { class: 'home-quiet', text: 'Loading…' })
        : work.length ? el('div', { class: 'board-grid ent-grid home-work' }, work)
          : el('p', { class: 'home-quiet', text: 'What you are named an artist on, on its page in the catalogue, and what you file, is listed here.' }));

    return [
      pinned.length > 0 && label('Pinned', pinned.length),
      pinned.length > 0 && el('div', { class: 'board-grid' }, pinned),
      el('div', { class: 'home-cols' }, updates, side),
    ].filter(Boolean);
  }

  // ------------------------------------------------------------- a project's versions, newest first
  //
  // Every version filed in the project, as it came in: by day, and within a day by who filed a run of
  // them. Pick some (a click, Shift and a click for a run, or a day's or a run's box), then put them on
  // one of the project's boards, or on a new board, as those versions.

  const versionLists = new Map(); // project id -> the list as last fetched
  const vpick = { project: null, ids: new Set(), last: null, order: [] };
  const DAY = 24 * 3600 * 1000;
  const dayOf = (t) => new Date(t).setHours(0, 0, 0, 0);
  function dayName(day) {
    const today = dayOf(Date.now());
    if (day === today) return 'Today';
    if (day === today - DAY) return 'Yesterday';
    const d = new Date(day);
    const opts = today - day < 6 * DAY ? { weekday: 'long' } : { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) };
    return d.toLocaleDateString(undefined, opts);
  }
  const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  function dropVersionPick() {
    vpick.project = null;
    vpick.ids.clear();
    $('vpickbar')?.remove();
    document.body.classList.remove('vpicking');
  }

  async function versionsPage(project, fresh) {
    const sig = `${project.id}|versions`;
    const show = (data) => {
      if (shownProject !== sig) return;
      $('content').replaceChildren(...versionsView(project, data));
      paintVersionPick(project);
    };
    shownProject = sig;
    if (versionLists.has(project.id)) show(versionLists.get(project.id));
    else if (fresh) $('content').replaceChildren(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      const data = await api('GET', `/api/projects/${project.id}/versions`);
      const was = versionLists.get(project.id);
      versionLists.set(project.id, data);
      if (!was || JSON.stringify(was) !== JSON.stringify(data)) show(data);
    } catch (err) {
      $('content').replaceChildren(el('p', { class: 'home-empty', text: err.message }));
    }
  }

  function versionsView(project, data) {
    const q = $('q').value.trim().toLowerCase();
    const list = data.versions.filter((v) => !q || v.label.includes(q) || (v.createdBy || '').toLowerCase().includes(q));
    vpick.order = list.map((v) => v.id);
    if (vpick.project !== project.id) {
      dropVersionPick();
      vpick.project = project.id;
    }
    // By day; within a day, a run is what one person filed one after another.
    const days = [];
    for (const v of list) {
      const day = dayOf(v.createdAt);
      let d = days[days.length - 1];
      if (!d || d.day !== day) days.push(d = { day, runs: [] });
      let r = d.runs[d.runs.length - 1];
      if (!r || r.by !== (v.createdBy || '') || r.last - v.createdAt > 2 * 3600 * 1000) d.runs.push(r = { by: v.createdBy || '', list: [], last: v.createdAt });
      r.list.push(v);
      r.last = v.createdAt;
    }
    const box = (ids, label) => {
      const all = ids.every((id) => vpick.ids.has(id));
      const some = !all && ids.some((id) => vpick.ids.has(id));
      return el('button', {
        type: 'button', class: `vl-box${all ? ' on' : some ? ' some' : ''}`, 'data-ids': ids.join(' '), title: label, 'aria-label': label,
        onclick: (e) => {
          e.stopPropagation();
          const on = !ids.every((id) => vpick.ids.has(id));
          for (const id of ids) on ? vpick.ids.add(id) : vpick.ids.delete(id);
          paintVersionPick(project);
        },
      });
    };
    const row = (v) => {
      const thumb = scrubber(el('button', {
        type: 'button', class: `card-thumbs vl-thumb n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw',
        onclick: (e) => { e.stopPropagation(); lookAt(v.entityId, v.id); },
      }, v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }), v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })), v.look);
      return el('div', {
        class: `vl-row${vpick.ids.has(v.id) ? ' picked' : ''}`, 'data-id': v.id,
        onclick: (e) => {
          if (e.target.closest('a')) return;
          if (e.shiftKey && vpick.last && vpick.order.includes(vpick.last)) {
            const [a, b] = [vpick.order.indexOf(vpick.last), vpick.order.indexOf(v.id)].sort((x, y) => x - y);
            for (const id of vpick.order.slice(a, b + 1)) vpick.ids.add(id);
          } else if (vpick.ids.has(v.id)) vpick.ids.delete(v.id);
          else vpick.ids.add(v.id);
          vpick.last = v.id;
          paintVersionPick(project);
        },
      },
      box([v.id], `Select ${v.label}`),
      thumb,
      el('div', { class: 'vl-main' },
        el('div', { class: 'vl-label' }, el('a', { href: `#/f/${project.id}/catalogue/${v.entityId}`, text: v.entity, title: `${v.entity}: its page` }), el('span', { text: v.label.slice(v.entity.length) })),
        el('div', { class: 'vl-meta', text: [v.tier, v.artist && v.artist !== (v.createdBy || '').toLowerCase() && `by ${v.artist}`].filter(Boolean).join(' · ') })),
      el('div', { class: 'vl-boards' }, v.boards.slice(0, 3).map((b) => el('a', { class: 'ver-board', href: `/b/${b.id}`, text: b.name, onclick: (e) => e.stopPropagation() })),
        v.boards.length > 3 && el('span', { class: 'vl-more', text: `+${v.boards.length - 3}` })),
      el('div', { class: 'vl-time', text: clock(v.createdAt), title: new Date(v.createdAt).toLocaleString() }));
    };
    const out = [];
    for (const d of days) {
      const ids = d.runs.flatMap((r) => r.list.map((v) => v.id));
      out.push(el('div', { class: 'vl-day' }, box(ids, `Select everything filed ${dayName(d.day).toLowerCase()}`), el('b', { text: dayName(d.day) }), el('span', { class: 'tally', text: String(ids.length) })));
      for (const r of d.runs) {
        const runIds = r.list.map((v) => v.id);
        const span = r.list.length > 1 ? `${clock(r.list[r.list.length - 1].createdAt)} – ${clock(r.list[0].createdAt)}` : clock(r.list[0].createdAt);
        out.push(el('div', { class: 'vl-run' },
          el('div', { class: 'vl-runhead' }, box(runIds, `Select what ${r.by || 'somebody'} filed then`),
            el('span', { class: 'avatar sm', text: WB.initials(r.by || '?') }),
            el('b', { text: r.by || 'Somebody' }), el('span', { text: `${plural(r.list.length, 'version')} · ${span}` })),
          el('div', { class: 'vl-list' }, r.list.map(row))));
      }
    }
    if (!list.length) out.push(el('p', { class: 'home-empty', text: q ? `No version matches "${$('q').value.trim()}".` : 'Nothing is filed in this project yet.' }));
    if (data.more && !q) out.push(el('p', { class: 'home-quiet', text: 'The 300 newest are shown.' }));
    return out;
  }

  function paintVersionPick(project) {
    for (const node of document.querySelectorAll('.vl-row[data-id], .card.ver[data-id]')) node.classList.toggle('picked', vpick.ids.has(node.dataset.id));
    for (const b of document.querySelectorAll('.vl-box[data-ids]')) {
      const ids = b.dataset.ids.split(' ');
      const n = ids.filter((id) => vpick.ids.has(id)).length;
      b.classList.toggle('on', n === ids.length);
      b.classList.toggle('some', n > 0 && n < ids.length);
    }
    const n = vpick.ids.size;
    document.body.classList.toggle('vpicking', n > 0);
    let bar = $('vpickbar');
    if (!n) return void bar?.remove();
    if (!bar) {
      const addBtn = el('button', { type: 'button', class: 'btn small', text: 'Add to board', onclick: (e) => { e.stopPropagation(); addToBoardMenu(project, e.currentTarget); } });
      bar = el('div', { id: 'vpickbar', class: 'pick-bar', role: 'toolbar', 'aria-label': 'Selected versions' },
        el('span', { class: 'pick-count' }),
        el('button', { type: 'button', class: 'btn small ghost', text: 'Clear', onclick: () => { vpick.ids.clear(); paintVersionPick(project); } }),
        el('span', { class: 'pick-gap' }),
        addBtn,
        el('button', { type: 'button', class: 'btn small primary', text: 'New board', title: 'A new board in this project, with these on it', onclick: () => newBoardWith(project) }));
      document.body.append(bar);
    }
    bar.querySelector('.pick-count').textContent = `${plural(n, 'version')} selected`;
  }

  // The project's boards (and those in its folders), newest edited first.
  const projectBoards = (project) => everything.boards.filter((b) => b.folderId && (b.folderId === project.id || isWithin(b.folderId, project.id))).sort((a, b) => b.updatedAt - a.updatedAt);

  function addToBoardMenu(project, anchor) {
    const boardsHere = projectBoards(project);
    if (!boardsHere.length) return void newBoardWith(project);
    openMenu(anchor, [
      ...boardsHere.slice(0, 12).map((b) => [b.name, () => placeOn(project, b)]),
      ['New board…', () => newBoardWith(project)],
    ]);
  }

  async function placeOn(project, board) {
    const ids = vpick.order.filter((id) => vpick.ids.has(id));
    const res = await api('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: ids, by: me.name });
    vpick.ids.clear();
    paintVersionPick(project);
    versionLists.delete(project.id);
    shownProject = '';
    render();
    undoable(`${plural(res.placed.length, 'version')} put on ${board.name}`, null);
    const toast = document.querySelector('.undo-toast');
    if (toast) toast.append(el('a', { class: 'btn small ghost', href: `/b/${board.id}`, text: 'Open board' }));
  }

  async function newBoardWith(project) {
    const ids = vpick.order.filter((id) => vpick.ids.has(id));
    if (!ids.length) return;
    const name = await WB.dialog({ title: 'New board', text: `With the ${plural(ids.length, 'version')} you picked on it.`, value: `Review ${new Date().toLocaleDateString()}`, placeholder: 'Board name', ok: 'Create board' });
    if (!name) return;
    try {
      const board = await api('POST', '/api/boards', { name, folderId: project.id, workspace: project.workspace, by: me.name });
      await api('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: ids, by: me.name });
      location.href = `/b/${board.id}`;
    } catch (err) {
      fail(err);
    }
  }

  // ------------------------------------------------------------- boards and folders, many at once
  //
  // Boxed in a folder or a workspace: moved together to another folder, or (boards) deleted together.
  const bpick = new Set(); // 'board:<id>' | 'folder:<id>'
  function dropBoardPick() {
    bpick.clear();
    $('bpickbar')?.remove();
    for (const n of document.querySelectorAll('.card[data-pick].picked')) n.classList.remove('picked');
  }
  function paintBoardPick() {
    for (const n of document.querySelectorAll('.card[data-pick]')) n.classList.toggle('picked', bpick.has(n.dataset.pick));
    const n = bpick.size;
    let bar = $('bpickbar');
    if (!n) return void bar?.remove();
    if (!bar) {
      bar = el('div', { id: 'bpickbar', class: 'pick-bar', role: 'toolbar', 'aria-label': 'Selected boards and folders' },
        el('span', { class: 'pick-count' }),
        el('button', { type: 'button', class: 'btn small ghost', text: 'Clear', onclick: dropBoardPick }),
        el('span', { class: 'pick-gap' }),
        el('button', { type: 'button', class: 'btn small pick-del', text: 'Delete…', onclick: () => deletePicked().catch(fail) }),
        el('button', { type: 'button', class: 'btn small primary', text: 'Move to…', onclick: () => movePicked().catch(fail) }));
      document.body.append(bar);
    }
    const boardsN = [...bpick].filter((k) => k.startsWith('board:')).length;
    const foldersN = n - boardsN;
    bar.querySelector('.pick-count').textContent = [boardsN && plural(boardsN, 'board'), foldersN && plural(foldersN, 'folder')].filter(Boolean).join(' and ') + ' selected';
    bar.querySelector('.pick-del').hidden = !boardsN;
  }
  async function movePicked() {
    const ids = [...bpick].map((k) => k.split(':'));
    const target = await pickFolder({ title: `Move ${plural(ids.length, 'item')} to`, exclude: ids.length === 1 && ids[0][0] === 'folder' ? ids[0][1] : null, current: currentFolder() });
    if (target === undefined) return;
    for (const [kind, id] of ids) {
      if (kind === 'folder' && (id === target || (target && isWithin(target, id)))) continue;
      if (kind === 'board') await api('PATCH', `/api/boards/${id}`, { folderId: target });
      else await api('PATCH', `/api/folders/${id}`, { parentId: target });
    }
    dropBoardPick();
    refresh();
  }
  async function deletePicked() {
    const ids = [...bpick].filter((k) => k.startsWith('board:')).map((k) => k.slice(6));
    const sure = await WB.dialog({ title: `Delete ${plural(ids.length, 'board')}?`, text: 'They disappear for everyone. The server keeps them hidden, so whoever runs the server can still restore them. Folders are left as they are.', ok: 'Delete', danger: true });
    if (!sure) return;
    for (const id of ids) await api('DELETE', `/api/boards/${id}`);
    dropBoardPick();
    refresh();
  }

  // ------------------------------------------------------------- box select
  //
  // In the catalogue and in a project's Versions, a drag that starts on empty space draws a box, and
  // what it touches is selected, as in a file manager: afresh, or added to what is selected already
  // with Shift, Ctrl or Cmd. In the catalogue it starts selecting, as the Select button does.
  function boxTargets() {
    const rt = route();
    if (rt.kind === 'space') return { sel: '.card[data-pick]', kind: 'items' };
    const f = rt.kind === 'folder' && folderById(rt.id);
    if (!f) return null;
    const v = f.project ? currentView() : { page: 'boards' };
    if (v.page === 'boards') return { project: f, sel: '.card[data-pick]', kind: 'items' };
    if (v.page === 'catalogue' && v.entity) return { project: f, sel: '.card.ver[data-id]', kind: 'vers' };
    if (v.page === 'catalogue') return { project: f, sel: '.card.ent[data-id]', kind: 'ents' };
    if (v.page === 'versions') return { project: f, sel: '.vl-row[data-id]', kind: 'vers' };
    return null;
  }
  let marquee = null;
  // Anywhere on the page counts, the margins and the space under the content too: all but the bars, the
  // sidebar, dialogs, menus and the player.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (!(e.target instanceof Element) || e.target.closest('.home-bar, .side, .side-scrim, .viewer, .menu, .combo-list, .undo-toast, .notices')) return;
    if (document.querySelector('dialog[open]') || (document.querySelector('.viewer') && !document.querySelector('.viewer').hidden)) return;
    if (e.target.closest('a, button, input, select, textarea, label, .card, .vl-row, .imp, .cat-tools, .ent-people, .pick-bar, #crumbs, dialog')) return;
    // What people wrote can still be selected, to copy it; dragging anywhere else never selects text.
    if (e.target.closest('.ent-msg-text, .feed-text, .msg-text')) return;
    e.preventDefault();
    const t = boxTargets();
    if (!t) return;
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = !add ? new Set() : new Set(t.kind === 'ents' ? (pickingIn(t.project) ? picking.ids : []) : t.kind === 'items' ? bpick : vpick.ids);
    marquee = { ...t, x: e.clientX, y: e.clientY + scrollY, base, box: null, pid: e.pointerId };
  });
  window.addEventListener('pointermove', (e) => {
    const m = marquee;
    if (!m || e.pointerId !== m.pid) return;
    const y = e.clientY + scrollY;
    if (!m.box) {
      if (Math.hypot(e.clientX - m.x, y - m.y) < 5) return;
      m.box = el('div', { class: 'marquee' });
      document.body.append(m.box);
      document.body.classList.add('marqueeing');
      if (m.kind === 'ents' && !pickingIn(m.project)) setPicking(m.project, true);
    }
    // Near the top or the foot of the window, the page scrolls on.
    if (e.clientY > innerHeight - 40) scrollBy(0, 14);
    else if (e.clientY < 40) scrollBy(0, -14);
    const r = { l: Math.min(m.x, e.clientX), r: Math.max(m.x, e.clientX), t: Math.min(m.y, y) - scrollY, b: Math.max(m.y, y) - scrollY };
    Object.assign(m.box.style, { left: `${r.l}px`, top: `${r.t}px`, width: `${r.r - r.l}px`, height: `${r.b - r.t}px` });
    const hit = new Set(m.base);
    for (const node of document.querySelectorAll(m.sel)) {
      const b = node.getBoundingClientRect();
      if (b.right > r.l && b.left < r.r && b.bottom > r.t && b.top < r.b) hit.add(node.dataset.pick || node.dataset.id);
    }
    if (m.kind === 'ents') {
      picking.ids = hit;
      paintPicked();
    } else if (m.kind === 'items') {
      bpick.clear();
      for (const k of hit) bpick.add(k);
      paintBoardPick();
    } else {
      vpick.ids = hit;
      paintVersionPick(m.project);
    }
  });
  const endMarquee = (e) => {
    if (!marquee || (e && e.pointerId !== marquee.pid)) return;
    marquee.box?.remove();
    document.body.classList.remove('marqueeing');
    marquee = null;
  };
  window.addEventListener('pointerup', endMarquee);
  window.addEventListener('pointercancel', endMarquee);

  // A project's timeline: its shots played through in the player, as an edit (viewer.js, openRun): the
  // newest version of each, of one task or any, all sequences or one, chosen in the player's bar.
  let runOf = null;
  // The card that stands in for a shot with nothing filed: its name, and that it has nothing yet.
  const slates = new Map();
  function slate(name, task) {
    const key = `${name}|${task}`;
    if (slates.has(key)) return slates.get(key);
    const c = document.createElement('canvas');
    c.width = 1280;
    c.height = 720;
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, 1280, 720);
    g.strokeStyle = '#191919';
    g.lineWidth = 14;
    for (let x = -720; x < 1280; x += 40) {
      g.beginPath();
      g.moveTo(x, 720);
      g.lineTo(x + 720, 0);
      g.stroke();
    }
    g.textAlign = 'center';
    g.fillStyle = '#e8e8e8';
    g.font = '600 64px Inter, system-ui, sans-serif';
    g.fillText(name, 640, 360);
    g.fillStyle = '#8a8a8a';
    g.font = '400 30px Inter, system-ui, sans-serif';
    g.fillText(task ? `No ${task} filed yet` : 'Nothing filed yet', 640, 416);
    const url = c.toDataURL('image/png');
    slates.set(key, url);
    return url;
  }
  async function openTimeline(project) {
    runOf = project.id;
    const key = project.id;
    let seq = store(`wb:tl:seq:${key}`) || '';
    let task = store('wb:tl:task') || '';
    let withEmpty = store('wb:tl:empty') !== false;
    let data = null;
    const load = async () => {
      data = await api('GET', `/api/projects/${project.id}/timeline${task ? `?task=${encodeURIComponent(task)}` : ''}`);
      if (seq && !data.shots.some((x) => x.seq === seq)) seq = '';
      if (!data.shots.length) return [];
      return data.shots.filter((x) => (x.version || withEmpty) && (!seq || x.seq === seq)).map((x) => (x.version ? {
        ...x.version.look, id: x.version.id, type: x.version.look.type, label: x.version.label, name: x.name, seq: x.seq, entityId: x.id,
      } : {
        // A shot with nothing filed (of that task): a slate in its place, held like a still.
        type: 'image', id: `empty-${x.id}`, src: slate(x.name, task), nw: 1280, nh: 720, empty: true,
        label: `${x.name} · nothing filed yet`, name: x.name, seq: x.seq, entityId: x.id,
      }));
    };
    const pick = (label, value, options, set) => {
      const sel = el('select', { class: 'v-pick', 'aria-label': label, title: label },
        options.map(([v, text]) => el('option', { value: v, text, ...(v === value && { selected: true }) })));
      sel.addEventListener('change', () => set(sel.value));
      return sel;
    };
    try {
      await WBViewer.openRun(thePlayer(), {
        load, me,
        title: () => `${project.name} · Timeline`,
        choices: (reload) => {
          const seqs = [...new Set(data.shots.map((x) => x.seq).filter(Boolean))];
          return [
            pick('Which sequence', seq, [['', 'All sequences'], ...seqs.map((x) => [x, x])], (v) => { seq = v; store(`wb:tl:seq:${key}`, v); reload(); }),
            pick('Latest of which task', task, [['', 'Latest of any task'], ...data.tasks.map((x) => [x, `Latest ${x}`])], (v) => { task = v; store('wb:tl:task', v); reload(); }),
            pick('Which shots', withEmpty ? 'all' : 'filed', [['all', 'All shots'], ['filed', 'Filed shots only']], (v) => { withEmpty = v === 'all'; store('wb:tl:empty', withEmpty); reload(); }),
          ];
        },
        onClose: () => {
          runOf = null;
          if (currentView().page === 'timeline' && currentFolder() === project.id) location.hash = `#/f/${project.id}/catalogue`;
        },
      });
    } catch (err) {
      runOf = null;
      $('content').replaceChildren(el('p', { class: 'home-empty', text: `${err.message}. File versions of the project's shots, and they play here in order.` }));
    }
  }

  function render() {
    const rt = route();
    if (vpick.project && (rt.kind !== 'folder' || rt.id !== vpick.project || !(currentView().page === 'versions' || currentView().entity))) dropVersionPick();
    if (bpick.size && (rt.kind === 'home' || (rt.kind === 'folder' && currentView().page !== 'boards'))) dropBoardPick();
    if (picking.on && (rt.kind !== 'folder' || rt.id !== picking.project || currentView().page !== 'catalogue' || currentView().entity)) {
      const f = folderById(picking.project);
      if (f) setPicking(f, false);
    }
    if (rt.kind === 'folder') space = folderById(rt.id).workspace || space;
    else if (rt.kind === 'space') space = rt.space;
    if (rt.kind !== 'home') store('wb:workspace', space);
    lib = {
      folders: everything.folders.filter((f) => f.workspace === space),
      boards: everything.boards.filter((b) => b.workspace === space),
    };
    openTo(rt);
    store('wb:tree', [...opened]);
    renderSide(rt);
    renderCrumbs(rt);

    const cur = rt.kind === 'folder' ? rt.id : null;
    const here = cur && folderById(cur);
    const view = here && here.project ? currentView() : { page: 'boards' };
    $('q').placeholder = view.page === 'catalogue' ? 'Search the catalogue' : 'Search boards and folders';
    $('empty').hidden = true;
    if (rt.kind === 'home') return $('content').replaceChildren(...homeView());
    // A project has its boards and its catalogue.
    if (view.page !== 'boards') return renderProject(here, view);
    // A search looks through every folder of the workspace; without one you see the folder you are in.
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
  }

  // ------------------------------------------------------------- a project: its catalogue
  //
  // A project's catalogue is every asset, set and shot in it, each with the versions filed of it. It
  // mirrors how the project is laid out on disk: assets, sets, and shots by sequence. Files dropped on
  // it, or added with Import, are taken many at once and filed: what a file's name says is filed at
  // once, and only what it does not say is asked. Nothing from it lands on a board.

  const N = window.WBNaming;
  const catalogues = new Map(); // project id -> its catalogue as last fetched

  let shownProject = '';
  let shownEntity = null; // the asset, set or shot whose page is showing, for the crumbs before its catalogue is in
  async function renderProject(project, view) {
    const sig = `${project.id}|${view.page}|${view.entity}`;
    const fresh = shownProject !== sig;
    shownProject = sig;
    if (view.page === 'versions') return versionsPage(project, fresh);
    if (view.page === 'timeline') {
      // The player plays it; the page behind says so. The background refresh of the library leaves it be.
      if (runOf === project.id && thePlayer().isOpen()) return;
      $('content').replaceChildren(el('p', { class: 'home-empty', text: 'Opening the timeline…' }));
      openTimeline(project);
      return;
    }
    // What is being brought in shows above the catalogue, on its page and on each entity's.
    const tray = importer(project).tray;
    if (fresh && (view.entity || !catalogues.has(project.id))) $('content').replaceChildren(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      if (view.entity) {
        const page = await api('GET', `/api/entities/${view.entity}`);
        if (shownProject !== sig) return;
        shownEntity = page.entity;
        WB.remember({ kind: 'entity', id: page.entity.id, name: page.entity.name, tier: page.entity.tier, projectId: project.id, thumb: (page.versions.find((v) => !v.hidden && v.thumb) || {}).thumb || null });
        if (!catalogues.has(project.id)) loadCatalogue(project.id);
        renderCrumbs(route());
        return $('content').replaceChildren(tray, entityPage(project, page));
      }
      // What was fetched last shows at once (a search narrows it as it is typed); then it is brought up to date.
      if (catalogues.has(project.id)) $('content').replaceChildren(tray, ...catalogueView(project, catalogues.get(project.id), view));
      const had = catalogues.get(project.id);
      const cat = await api('GET', `/api/projects/${project.id}`);
      catalogues.set(project.id, cat);
      if (shownProject !== sig) return;
      $('content').replaceChildren(tray, ...catalogueView(project, cat, view));
      // New assets, sets or shots show in the tree too.
      if (!had || JSON.stringify(had.entities.map((e) => e.id)) !== JSON.stringify(cat.entities.map((e) => e.id))) {
        renderSide(route());
        renderCrumbs(route());
      }
    } catch (err) {
      $('content').replaceChildren(el('p', { class: 'home-empty', text: err.message }));
    }
  }

  const ICON_CHECKS = svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><path d="M5.5 7l1.3 1.3L9 6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M5.5 17l1.3 1.3L9 16"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>', 16);
  const ICON_IMPORT = svg('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5"/>', 16);
  const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>', 18);

  // Above the catalogue: the way to bring files in. Whatever a file's name says files it; the rest are asked about.
  function catTools(project) {
    return el('div', { class: 'cat-tools' },
      el('span', { class: 'cat-hint', text: 'Drop images and videos anywhere here to add them' }),
      el('button', { type: 'button', class: `btn pick-toggle${pickingIn(project) ? ' on' : ''}`, html: `${ICON_CHECKS}<span>Select</span>`, title: 'Select assets, sets and shots to change them together', onclick: () => setPicking(project, !pickingIn(project)) }),
      el('a', { class: 'btn', href: `#/f/${project.id}/timeline`, html: `${ICON_PLAY}<span>Timeline</span>`, title: 'Every shot in order, played through' }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_PLUS}<span>Add assets, sets &amp; shots</span>`, title: 'Set up what the project has, before anything is filed of it', onclick: () => addEntities(project) }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_IMPORT}<span>Import</span>`, title: 'Bring images and videos into the catalogue', onclick: () => importer(project).pick() }));
  }

  // Changing many at once: who works on them and who is cc'd (added, taken off, or set outright), and
  // what they are. What is left alone stays as each has it.
  async function batchEdit(project) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`);
    const chosen = cat.entities.filter((e) => picking.ids.has(e.id));
    if (!chosen.length) return;
    if (!people.length) await loadPeople();
    const tally = (key) => {
      const count = new Map();
      for (const e of chosen) for (const n of e[key] || []) count.set(n, (count.get(n) || 0) + 1);
      return count.size ? [...count].sort((a, b) => b[1] - a[1]).map(([n, k]) => (k === chosen.length ? n : `${n} (${k})`)).join(', ') : 'nobody';
    };
    const peopleRow = (key, label) => {
      let names = [];
      const how = el('select', { class: 'be-how', 'aria-label': `${label}: what to do` },
        el('option', { value: '', text: 'Leave as they are' }), el('option', { value: 'add', text: 'Add' }), el('option', { value: 'remove', text: 'Take off' }), el('option', { value: 'set', text: 'Set to' }));
      const field = namesField([], (list) => { names = list; }, { placeholder: key === 'cc' ? 'Someone to keep in the loop' : 'An artist' });
      const sync = () => { field.hidden = !how.value; };
      how.addEventListener('change', sync);
      sync();
      return {
        node: el('div', { class: 'be-row' }, el('span', { class: 'be-label', text: label }),
          el('div', { class: 'be-field' }, el('div', { class: 'be-now', text: `Now: ${tally(key)}` }), el('div', { class: 'be-ctl' }, how, field))),
        value: () => (how.value ? { [how.value]: names } : undefined),
      };
    };
    const artists = peopleRow('artists', 'Artists');
    const cc = peopleRow('cc', 'CC');
    const tiers = cat.preset.tiers;
    const tierNow = [...new Set(chosen.map((e) => e.tier))];
    const tierSel = el('select', { class: 'be-how', 'aria-label': 'What they are' },
      el('option', { value: '', text: tierNow.length === 1 ? `Leave as ${tierNow[0]}${chosen.length > 1 ? 's' : ''}` : 'Leave as they are' }),
      tiers.map((t) => el('option', { value: t.id, text: `Make them ${t.label.toLowerCase()}` })));
    const error = el('p', { class: 've-error', hidden: true });
    const save = el('button', { type: 'submit', class: 'btn primary', text: `Change ${chosen.length}` });
    const names = chosen.map((e) => e.name);
    const dlg = el('dialog', { class: 'dlg be' },
      el('form', {
        method: 'dialog',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const body = { ids: chosen.map((e) => e.id), artists: artists.value(), cc: cc.value(), ...(tierSel.value && { tier: tierSel.value }) };
          if (!body.artists && !body.cc && !body.tier) return dlg.close();
          save.disabled = true;
          try {
            await api('PATCH', `/api/projects/${project.id}/entities`, body);
            catalogues.delete(project.id);
            dlg.close();
            shownProject = '';
            render();
            undoable(`Changed ${plural(chosen.length, 'asset, set or shot').replace('asset, set or shots', 'assets, sets and shots')}`, null);
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      el('h2', { text: `Edit ${chosen.length === 1 ? names[0] : `${chosen.length} ${tierNow.length === 1 ? (tiers.find((t) => t.id === tierNow[0]) || { label: 'assets, sets and shots' }).label.toLowerCase() : 'assets, sets and shots'}`}` }),
      el('p', { class: 'be-which', text: names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ') }),
      artists.node, cc.node,
      el('div', { class: 'be-row' }, el('span', { class: 'be-label', text: 'What they are' }), el('div', { class: 'be-field' }, el('div', { class: 'be-ctl' }, tierSel))),
      error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // Setting a project up with what it has from the start: names, one a line, each an asset, a set or a
  // shot by its shape (or as chosen). A run of shots can be filled in from a sequence and its numbers.
  function addEntities(project) {
    const presetId = project.settings && project.settings.naming;
    const cat = catalogues.get(project.id);
    const tiers = cat ? cat.preset.tiers : N.preset(presetId).tiers;
    const box = el('textarea', { rows: 8, spellcheck: 'false', placeholder: 'char-robot\nset-harbour\nkilo-0010\nkilo-0020', 'aria-label': 'Names, one a line' });
    const tierSel = el('select', { 'aria-label': 'What they are' },
      el('option', { value: '', text: 'What each name says' }), tiers.map((t) => el('option', { value: t.id, text: `All ${t.label.toLowerCase()}` })));
    const preview = el('div', { class: 'ae-preview' });
    const seq = el('input', { type: 'text', placeholder: 'kilo', spellcheck: 'false', 'aria-label': 'Sequence' });
    const from = el('input', { type: 'number', value: '10', min: '0', 'aria-label': 'First shot number' });
    const to = el('input', { type: 'number', value: '100', min: '0', 'aria-label': 'Last shot number' });
    const step = el('input', { type: 'number', value: '10', min: '1', 'aria-label': 'Step' });
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Add' });
    const error = el('p', { class: 've-error', hidden: true });
    const wanted = () => [...new Set(box.value.split(/[\n,;]+/).map((x) => N.tokenize(x)).filter(Boolean))];
    const paint = () => {
      const list = wanted();
      const have = new Set((catalogues.get(project.id)?.entities || []).map((e) => e.name));
      const fresh = list.filter((n) => !have.has(n));
      const tierOf = (n) => tierSel.value || N.tierOf(n, presetId) || 'asset';
      const counts = tiers.map((t) => [t, fresh.filter((n) => tierOf(n) === t.id).length]).filter(([, n]) => n);
      preview.textContent = !list.length ? 'Nothing yet.'
        : `${fresh.length ? `Adds ${counts.map(([t, n]) => `${n} ${n === 1 ? t.one : t.label.toLowerCase()}`).join(', ')}.` : 'Nothing new.'}${list.length > fresh.length ? ` ${list.length - fresh.length} already there.` : ''}`;
      save.disabled = !fresh.length;
      save.textContent = fresh.length ? `Add ${fresh.length}` : 'Add';
      error.hidden = true;
    };
    box.addEventListener('input', paint);
    tierSel.addEventListener('change', paint);
    const fillShots = () => {
      const q = N.tokenize(seq.value);
      const a = Number(from.value);
      const b = Number(to.value);
      const by = Math.max(1, Number(step.value) || 1);
      if (!q || !(b >= a) || (b - a) / by > 1000) return;
      const names = [];
      for (let n = a; n <= b; n += by) names.push(`${q}-${String(n).padStart(4, '0')}`);
      box.value = `${box.value.trim() ? `${box.value.trim()}\n` : ''}${names.join('\n')}`;
      paint();
    };
    const dlg = el('dialog', { class: 'dlg ae' },
      el('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          save.disabled = true;
          try {
            const res = await api('POST', `/api/projects/${project.id}/entities`, { names: wanted(), tier: tierSel.value || undefined, by: me.name });
            catalogues.delete(project.id);
            dlg.close();
            shownProject = '';
            render();
            undoable(`Added ${plural(res.made.length, 'asset, set or shot').replace('asset, set or shots', 'assets, sets and shots')}`, null);
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      el('h2', { text: 'Add assets, sets & shots' }),
      el('p', { text: 'What the project has, before anything is filed of it. Type or paste the names, one a line; each is an asset, a set or a shot by its name.' }),
      box,
      el('div', { class: 'ae-row' }, el('span', { text: 'They are' }), tierSel),
      el('div', { class: 'ae-row ae-shots' }, el('span', { text: 'Or a run of shots:' }), seq, el('span', { text: 'from' }), from, el('span', { text: 'to' }), to, el('span', { text: 'by' }), step,
        el('button', { type: 'button', class: 'btn small', text: 'Fill in', onclick: fillShots })),
      preview, error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    paint();
    dlg.showModal();
    box.focus();
  }

  // Moving the pointer across a video's picture scrubs through it, as if the pointer were dragging its
  // playhead: the left edge is the start, the right edge the end. Only while the pointer is over it is
  // the video fetched at all.
  function scrubber(box, look) {
    if (!look || look.type !== 'video' || !look.src) return box;
    let video = null;
    let head = null;
    let want = null;
    let busy = false;
    const seek = () => {
      const d = video && (video.duration > 0 && isFinite(video.duration) ? video.duration : look.dur);
      if (!video || want == null || busy || !(d > 0) || video.readyState < 1) return;
      busy = true;
      video.currentTime = Math.min(d - 0.04, want * d);
      want = null;
    };
    box.classList.add('scrubs');
    box.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch' || video) return;
      video = el('video', { class: 'scrub-video', playsinline: '', preload: 'auto', src: look.src });
      video.muted = true;
      head = el('i', { class: 'scrub-head' });
      video.addEventListener('seeked', () => {
        busy = false;
        video.classList.add('on');
        seek();
      });
      video.addEventListener('loadedmetadata', seek);
      box.append(video, head);
    });
    box.addEventListener('pointermove', (e) => {
      if (!video) return;
      const r = box.getBoundingClientRect();
      const k = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      head.style.left = `${k * 100}%`;
      want = k;
      seek();
    });
    box.addEventListener('pointerleave', () => {
      if (video) {
        video.removeAttribute('src');
        video.load();
        video.remove();
        head.remove();
      }
      video = head = null;
      want = null;
      busy = false;
    });
    return box;
  }

  const ICON_PLAY = svg('<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>', 14);

  // An asset, set or shot's card: its picture plays the newest version at once (scrubbing through it
  // under the pointer); its name goes to its page.
  // Picking many assets, sets and shots in the catalogue, to change them together (batchEdit). A click
  // picks one, Shift and a click every one between it and the last, and the bar at the foot says how
  // many and what can be done with them.
  const picking = { project: null, on: false, ids: new Set(), last: null, order: [] };
  const pickingIn = (project) => picking.on && picking.project === project.id;
  function pickTile(id, range) {
    if (range && picking.last && picking.order.includes(picking.last)) {
      const [a, b] = [picking.order.indexOf(picking.last), picking.order.indexOf(id)].sort((x, y) => x - y);
      for (const x of picking.order.slice(a, b + 1)) picking.ids.add(x);
    } else if (picking.ids.has(id)) picking.ids.delete(id);
    else picking.ids.add(id);
    picking.last = id;
    paintPicked();
  }
  function paintPicked() {
    for (const node of document.querySelectorAll('.card.ent[data-id]')) node.classList.toggle('picked', picking.ids.has(node.dataset.id));
    const bar = $('pickbar');
    if (!bar) return;
    const n = picking.ids.size;
    bar.querySelector('.pick-count').textContent = n ? `${n} selected` : 'Select assets, sets and shots';
    bar.querySelector('.pick-edit').disabled = !n;
    bar.querySelector('.pick-clear').hidden = !n;
  }
  function setPicking(project, on) {
    picking.on = on;
    picking.project = project.id;
    picking.ids.clear();
    picking.last = null;
    $('pickbar')?.remove();
    if (on) {
      const bar = el('div', { id: 'pickbar', class: 'pick-bar', role: 'toolbar', 'aria-label': 'Selected' },
        el('span', { class: 'pick-count' }),
        el('button', { type: 'button', class: 'btn small ghost', text: 'Select all', onclick: () => { for (const id of picking.order) picking.ids.add(id); paintPicked(); } }),
        el('button', { type: 'button', class: 'btn small ghost pick-clear', text: 'Clear', onclick: () => { picking.ids.clear(); paintPicked(); } }),
        el('span', { class: 'pick-gap' }),
        el('button', { type: 'button', class: 'btn small', text: 'Done', title: 'Stop selecting (Esc)', onclick: () => setPicking(project, false) }),
        el('button', { type: 'button', class: 'btn small primary pick-edit', text: 'Edit…', onclick: () => batchEdit(project) }));
      document.body.append(bar);
    }
    document.body.classList.toggle('picking', on);
    for (const b of document.querySelectorAll('.pick-toggle')) b.classList.toggle('on', on);
    paintPicked();
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picking.on && !document.querySelector('dialog[open], .menu') && !(document.querySelector('.viewer') && !document.querySelector('.viewer').hidden)) {
      const f = folderById(picking.project);
      if (f) setPicking(f, false);
    }
  });

  function entityTile(project, e) {
    const newest = e.newest || null;
    const thumbs = el('div', { class: `card-thumbs n${e.thumb ? 1 : 0}`, ...(newest && { title: 'Play the latest' }) },
      e.thumb && el('img', { src: e.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
      newest && el('span', { class: 'play-latest', html: `${ICON_PLAY}<span>Latest</span>` }));
    if (newest) {
      scrubber(thumbs, newest.look);
      thumbs.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (pickingIn(project)) pickTile(e.id, ev.shiftKey);
        else lookAt(e.id, newest.id);
      });
    }
    return el('a', {
      class: `card ent${picking.ids.has(e.id) && pickingIn(project) ? ' picked' : ''}`, href: `#/f/${project.id}/catalogue/${e.id}`, 'data-id': e.id,
      onclick: (ev) => {
        if (!pickingIn(project)) return;
        ev.preventDefault();
        pickTile(e.id, ev.shiftKey);
      },
    },
      el('span', { class: 'pick-box', 'aria-hidden': 'true' }),
      thumbs,
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: e.name }),
        el('div', { class: 'card-meta', text: e.versions == null ? (N.TIERS.includes(e.tier) ? e.tier : '') : e.versions ? `${plural(e.versions, 'version')} · last ${ago(e.latestAt)}` : 'Nothing filed yet' }),
        e.artists && e.artists.length > 0 && el('div', { class: 'card-meta ent-artists', title: `Artists: ${e.artists.join(', ')}` },
          e.artists.slice(0, 4).map((n) => el('span', { class: 'avatar xs', text: WB.initials(n) })), el('span', { text: e.artists.join(', ') }))));
  }

  function catalogueView(project, cat, view = {}) {
    const q = $('q').value.trim().toLowerCase();
    const list = cat.entities.filter((e) => (!q || e.name.includes(q))
      && (!view.tier || e.tier === view.tier) && (!view.seq || (e.tier === 'shot' && N.seqOf(e.name) === view.seq)));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    const out = [];
    picking.order = [];
    for (const tier of cat.preset.tiers) {
      const of = list.filter((e) => e.tier === tier.id);
      if (!of.length) continue;
      out.push(label(tier.label, of.length));
      picking.order.push(...of.map((e) => e.id));
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
        !q && el('p', { text: 'Drop images and videos here, or import them. On a board, select some and file them as versions (Shift+V).' })));
    }
    return [catTools(project, null), ...out];
  }

  // A version opens in the player (viewer.js), the same one a board opens its media in: with every other
  // version of the same thing beside it, and what has been said about them, live.
  let player = null;
  const thePlayer = () => player || (player = WBViewer.create({ me: () => me, title: () => '', media: () => [], notes: () => [], add() {}, set() {}, remove() {} }));
  async function lookAt(entityId, versionId) {
    thePlayer();
    try {
      await WBViewer.openEntity(player, entityId, { version: versionId, me, onClose: () => { shownProject = ''; render(); } });
    } catch (err) {
      fail(err);
    }
  }

  // What a version is filed as: its asset, set or shot, task and number make its name. Moved to another
  // asset or task with its number left as it was, it becomes the next one there.
  async function editVersion(project, entity, v) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    const presetId = project.settings && project.settings.naming;
    const field = (label, input) => el('label', { class: 've-field' }, el('span', { text: label }), input);
    const ent = el('input', { type: 'text', value: entity.name, required: true, spellcheck: 'false' });
    const task = el('input', { type: 'text', value: v.task || '', placeholder: 'None', spellcheck: 'false' });
    const num = el('input', { type: 'number', value: String(v.number), min: '1', step: '1' });
    const artist = el('input', { type: 'text', value: v.artist || '', placeholder: 'None', spellcheck: 'false' });
    const desc = el('input', { type: 'text', value: v.descriptor || '', autocomplete: 'off', placeholder: 'None', spellcheck: 'false' });
    const name = el('div', { class: 've-name' });
    const error = el('p', { class: 've-error', hidden: true });
    const moved = () => N.tokenize(ent.value) !== entity.name || (N.tokenize(task.value) || null) !== (v.task || null);
    // Moving it without saying a number: the number field is cleared, and the next one there is taken.
    let numTouched = false;
    num.addEventListener('input', () => { numTouched = true; paint(); });
    const paint = () => {
      if (!numTouched) num.value = moved() ? '' : String(v.number);
      num.placeholder = moved() ? 'Next' : '';
      const e = N.tokenize(ent.value);
      const t = N.tokenize(task.value) || null;
      name.textContent = !e ? '…' : num.value ? N.label(e, t, Number(num.value)) : `${[e, t].filter(Boolean).join(' ')}, its next version`;
      error.hidden = true;
    };
    for (const input of [ent, task, artist, desc]) input.addEventListener('input', paint);
    paint();
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save' });
    const dlg = el('dialog', { class: 'dlg ve' },
      el('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const e2 = N.tokenize(ent.value);
          if (!e2) return;
          const body = { task: task.value, artist: artist.value, descriptor: desc.value };
          if (e2 !== entity.name) body.entity = { name: e2, tier: N.tierOf(e2, presetId) || entity.tier };
          if (num.value) body.number = Number(num.value);
          save.disabled = true;
          try {
            const done = await api('PATCH', `/api/versions/${v.id}`, body);
            catalogues.delete(project.id);
            dlg.close();
            if (done.entityId !== entity.id) location.hash = `#/f/${project.id}/catalogue/${done.entityId}`;
            else render();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      el('h2', { text: `Edit ${v.label}` }),
      el('p', { text: 'Its notes, and every board it is on, go with it.' }),
      el('div', { class: 've-grid' },
        field('Asset, set or shot', ent), field('Task', task), field('Version', num), field('Artist', artist), field('Description', desc)),
      el('div', { class: 've-preview' }, el('span', { text: 'Called' }), name),
      error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    WB.combo(ent, entitySource(() => cat, presetId));
    WB.combo(task, taskSource(() => (cat ? cat.tasks : [])));
    WB.combo(artist, taskSource(() => (cat ? cat.artists : [])));
    dlg.showModal();
    ent.select();
  }

  async function deleteVersion(v) {
    if (v.boards.length) {
      await WB.dialog({ title: `${v.label} is on ${v.boards.length === 1 ? 'a board' : `${v.boards.length} boards`}`, text: `Take it off ${v.boards.map((b) => `“${b.name}”`).join(', ')} first, or archive it instead: archived, it is out of the way but still there.`, ok: 'OK', cancellable: false });
      return;
    }
    const sure = await WB.dialog({
      title: `Delete ${v.label}?`,
      text: 'It disappears from the catalogue, with what was said about it. Its number is not given to another version.',
      ok: 'Delete version',
      danger: true,
    });
    if (!sure) return;
    try {
      await api('DELETE', `/api/versions/${v.id}`);
    } catch (err) {
      return fail(err);
    }
    render();
    undoable(`${v.label} deleted`, async () => {
      await api('PATCH', `/api/versions/${v.id}`, { deleted: false });
      render();
    });
  }

  // A note at the bottom of the page for a few seconds, with a way to take back what was just done.
  let undoNode = null;
  function undoable(text, undo) {
    if (undoNode) undoNode.remove();
    const node = el('div', { class: 'undo-toast', role: 'status' },
      el('span', { text }),
      undo && el('button', { type: 'button', class: 'btn small ghost', text: 'Undo', onclick: async () => { node.remove(); try { await undo(); } catch (err) { fail(err); } } }));
    undoNode = node;
    document.body.append(node);
    setTimeout(() => node.remove(), 8000);
  }

  // Everyone the app knows by name, for picking artists and people to cc.
  let people = [];
  const loadPeople = async () => {
    try {
      people = (await api('GET', '/api/people')).people;
    } catch {
      // only what was typed, then
    }
  };

  // Names as chips, each with a way to take it off, and a box to add one: picked from the people the app
  // knows, or typed. `change(list)` is told the new list.
  function namesField(names, change, { placeholder }) {
    const chips = el('span', { class: 'pf-chips' });
    const input = el('input', { type: 'text', class: 'pf-in', placeholder, spellcheck: 'false', 'aria-label': placeholder });
    const wrap = el('span', { class: 'pf' }, chips, input);
    let list = [...names];
    const paint = () => chips.replaceChildren(...list.map((n) => el('span', { class: 'pf-chip' },
      el('span', { class: 'avatar sm', text: WB.initials(n) }), el('span', { text: n }),
      el('button', { type: 'button', class: 'pf-x', title: `Take ${n} off`, 'aria-label': `Take ${n} off`, html: svg('<path d="M7 7l10 10M17 7L7 17"/>', 12), onclick: () => set(list.filter((x) => x !== n)) }))));
    const set = (next) => {
      list = next;
      paint();
      change(list);
    };
    const addTyped = (name) => {
      const n = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      input.value = '';
      if (n && !list.some((x) => x.toLowerCase() === n.toLowerCase())) set([...list, n]);
    };
    WB.combo(input, (typed) => {
      const pool = [...new Set([me.name, ...people])].filter((n) => !list.some((x) => x.toLowerCase() === n.toLowerCase()));
      const out = WB.rank(pool, typed).map((n) => ({ value: n, label: n === me.name ? `${n} (you)` : n }));
      const t = typed.trim();
      if (t && !pool.concat(list).some((n) => n.toLowerCase() === t.toLowerCase())) out.push({ value: t, label: `Add ${t}`, make: true });
      return out;
    }, { onPick: (o) => addTyped(o.value) });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.defaultPrevented && input.value.trim()) { e.preventDefault(); addTyped(input.value); }
      else if (e.key === 'Backspace' && !input.value && list.length) set(list.slice(0, -1));
    });
    paint();
    return wrap;
  }

  // Who makes it, and who else follows it: both see what happens to it in their feed on Home.
  function entityPeople(entity) {
    const save = (key) => async (list) => {
      try {
        const done = await api('PATCH', `/api/entities/${entity.id}`, { [key]: list });
        entity[key] = done[key];
        catalogues.delete(entity.projectId);
        if (!people.length) loadPeople();
      } catch (err) {
        fail(err);
      }
    };
    if (!people.length) loadPeople();
    return el('div', { class: 'ent-people' },
      el('div', { class: 'ent-pp' }, el('span', { class: 'ent-pp-label', text: 'Artists' }), namesField(entity.artists || [], save('artists'), { placeholder: 'Add an artist' })),
      el('div', { class: 'ent-pp' }, el('span', { class: 'ent-pp-label', text: 'CC' }), namesField(entity.cc || [], save('cc'), { placeholder: 'Keep someone in the loop' })));
  }

  let showHidden = false;
  function entityPage(project, page) {
    const { entity } = page;
    const hidden = page.versions.filter((v) => v.hidden).length;
    const versions = page.versions.filter((v) => showHidden || !v.hidden);
    const byVersion = new Map(page.versions.map((v) => [v.id, v]));
    const archive = async (v, hide) => {
      await api('PATCH', `/api/versions/${v.id}`, { hidden: hide });
      render();
      if (hide) undoable(`${v.label} archived`, async () => { await api('PATCH', `/api/versions/${v.id}`, { hidden: false }); render(); });
    };
    const card = (v) => el('div', { class: `card ver${v.hidden ? ' hidden-ver' : ''}${vpick.ids.has(v.id) ? ' picked' : ''}`, 'data-id': v.id },
      scrubber(el('button', { type: 'button', class: `card-thumbs n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw', onclick: () => lookAt(entity.id, v.id) },
        v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
        v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })), v.look),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: v.label }),
        el('div', { class: 'card-meta', text: [v.artist, v.descriptor].filter(Boolean).join(' · ') || v.originalName || '' }),
        el('div', { class: 'card-meta', text: `Filed ${ago(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}${v.hidden ? ' · archived' : ''}` }),
        v.boards.length > 0 && el('div', { class: 'ver-boards' }, v.boards.map((b) => el('a', { class: 'ver-board', href: `/b/${b.id}`, text: b.name })))),
      menuButton([
        ['Edit…', () => editVersion(project, entity, v)],
        [v.hidden ? 'Bring back from the archive' : 'Archive', () => archive(v, !v.hidden)],
        ['Download', () => { location.href = v.look.orig || v.look.src; }],
        ['Delete…', () => deleteVersion(v), true],
      ]));
    // What was said, by thread, newest version first.
    const roots = page.notes.filter((n) => !n.re);
    const replies = (id) => page.notes.filter((n) => n.re === id).sort((a, b) => a.t - b.t);
    const order = new Map(page.versions.map((v, i) => [v.id, i]));
    roots.sort((a, b) => (order.get(a.versionId) ?? 0) - (order.get(b.versionId) ?? 0) || a.t - b.t);
    const msg = (n, first) => el('div', { class: `ent-msg${first ? '' : ' reply'}` },
      el('span', { class: 'avatar sm', style: { background: /^#[0-9a-f]{6}$/i.test(n.color || '') ? n.color : '#8a8a8a' }, text: WB.initials(n.name || '?') }),
      el('div', { class: 'ent-msg-main' },
        el('div', { class: 'ent-msg-top' }, el('strong', { text: n.name }), el('span', { text: ago(n.t) })),
        el('div', { class: 'ent-msg-text', text: n.text })));
    const threads = roots.map((n) => el('div', { class: `ent-thread${n.done ? ' done' : ''}` },
      // Where it was said is kept, not shown: what it is about is the version, which opens in the player.
      el('div', { class: 'ent-thread-ver' },
        el('button', { type: 'button', class: 'ent-thread-open', text: byVersion.get(n.versionId)?.label || '', title: 'Open it in the player', onclick: () => lookAt(entity.id, n.versionId) }),
        n.done && el('span', { class: 'ent-done', text: 'Resolved' })),
      msg(n, true), replies(n.id).map((r) => msg(r, false))));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    const latest = page.versions.find((v) => !v.hidden);
    if (vpick.project !== project.id) {
      dropVersionPick();
      vpick.project = project.id;
    }
    vpick.order = versions.map((v) => v.id);
    return el('div', { class: 'ent-page' },
      el('div', { class: 'ent-top' },
        latest && el('button', { type: 'button', class: 'btn primary', html: `${ICON_PLAY}<span>Play latest</span>`, title: `Open ${latest.label}, with every other version beside it`, onclick: () => lookAt(entity.id, latest.id) }),
        entityPeople(entity)),
      label('Versions', versions.length),
      hidden > 0 && el('label', { class: 'ent-hidden' }, el('input', { type: 'checkbox', checked: showHidden, onchange: (e) => { showHidden = e.target.checked; render(); } }), `Show archived (${hidden})`),
      el('div', { class: 'board-grid ent-grid' },
        el('button', { type: 'button', class: 'card new', title: `Add new versions of ${entity.name}: choose files, or drop them anywhere here`, onclick: () => importer(project).pick(entity) },
          el('span', { class: 'new-thumb' }, el('span', { class: 'plus', html: ICON_PLUS })),
          el('span', { class: 'card-body' }, el('span', { class: 'card-name', text: 'Add versions' }), el('span', { class: 'card-meta', text: 'Choose files, or drop them here' }))),
        ...versions.map(card)),
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

  // Suggestions for "which asset, set or shot": those the project has (with how many versions, and the
  // newest still), and, for a name it has not, the way to make it.
  function entitySource(getCat, presetId) {
    return (typed) => N.suggest(getCat() ? getCat().entities : [], typed, presetId);
  }
  const taskSource = (getTasks) => (typed) => WB.rank(getTasks(), typed).map((t) => ({ value: t, label: t }));

  // What is being brought into a project's catalogue: a strip above it, one row a file. Each file says on
  // its own row what it is to be filed as, filled in ahead from its name (or, added on an asset, set or
  // shot's page, that one), and is filed when you say so: one at a time, or all that are ready at once.
  // Kept per project, so leaving the catalogue and coming back finds it as it was.
  function importer(project) {
    let state = imports.get(project.id);
    if (state) return state;
    const presetId = project.settings && project.settings.naming;
    const rows = [];
    let cat = catalogues.get(project.id) || null;
    const catalogue = async () => cat || (cat = await api('GET', `/api/projects/${project.id}`));
    const tiers = () => (cat ? cat.preset.tiers : N.preset(presetId).tiers);
    const tasks = () => (cat ? cat.tasks : N.preset(presetId).tasks);
    const known = (name) => cat && cat.entities.find((e) => e.name === name);

    const list = el('div', { class: 'imp-list' });
    const title = el('b', { class: 'imp-title' });
    const fileAll = el('button', { type: 'button', class: 'btn small primary', onclick: () => { for (const r of rows) if (canFile(r)) fileRow(r); } });
    const clearBtn = el('button', { type: 'button', class: 'btn small ghost', text: 'Clear done', title: 'Put away what is filed', onclick: () => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].status === 'filed' || (rows[i].status === 'failed' && !rows[i].look)) {
          rows[i].node.remove();
          rows.splice(i, 1);
        }
      }
      paintHead();
    } });
    // The same answer for every file not yet filed, to start from.
    const allEnt = el('input', { type: 'text', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': 'Asset, set or shot for all' });
    const allTask = el('input', { type: 'text', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task for all' });
    WB.combo(allEnt, entitySource(() => cat, presetId));
    WB.combo(allTask, taskSource(tasks));
    const fillAll = el('form', {
      class: 'imp-fill',
      onsubmit: (e) => {
        e.preventDefault();
        for (const r of rows) {
          if (r.status === 'filed' || r.status === 'filing') continue;
          if (allEnt.value.trim()) r.fields.ent.value = allEnt.value.trim();
          if (allTask.value.trim()) r.fields.task.value = allTask.value.trim();
        }
        resyncAll();
      },
    }, el('span', { text: 'For all:' }), allEnt, allTask, el('button', { type: 'submit', class: 'btn small', text: 'Fill in' }));
    const head = el('div', { class: 'imp-head' }, title, fillAll, el('span', { class: 'imp-gap' }), clearBtn, fileAll);
    const tray = el('div', { class: 'imp', hidden: true }, head, list);
    const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime', hidden: true });
    document.body.append(picker);
    let pickFor = null;
    picker.addEventListener('change', () => {
      add([...picker.files], pickFor);
      picker.value = '';
    });

    const PHASE = { enc: 'Preparing', up: 'Uploading', strip: 'Building timeline', orig: 'Keeping the original' };
    const choiceOf = (r) => ({ name: N.tokenize(r.fields.ent.value), task: N.tokenize(r.fields.task.value) || null });
    // The next number for a row: one past the highest its asset, set or shot and task has, counting the
    // rows above it still to be filed to the same.
    function nextNumber(r) {
      const { name, task } = choiceOf(r);
      const have = known(name);
      let n = (have && have.tops ? have.tops[task || ''] || 0 : 0) + 1;
      for (const o of rows) {
        if (o === r) break;
        if (o.status === 'filed' || !o.fields) continue;
        const c = choiceOf(o);
        if (c.name === name && c.task === task) n = Math.max(n, (Number(o.fields.num.value) || n) + 1);
      }
      return n;
    }
    const resyncAll = () => { for (const o of rows) if (o.fields) o.fields.sync(); };
    const canFile = (r) => (r.status === 'ready' || r.status === 'uploading' || r.status === 'queued' || (r.status === 'failed' && r.look)) && !r.fileWhenReady && !!choiceOf(r).name;

    function makeRow(r) {
      const ent = el('input', { type: 'text', value: r.entity ? r.entity.name : r.parsed.entity || '', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': `What ${r.file.name} is` });
      const task = el('input', { type: 'text', value: r.parsed.task || '', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task' });
      // The version it is to be: the next of that asset, set or shot and task (after any rows above going
      // to the same), unless another is typed.
      const num = el('input', { type: 'number', min: '1', step: '1', class: 'imp-num', 'aria-label': 'Version', title: 'Version: the next one, unless you say another' });
      num.addEventListener('input', () => { r.numTouched = num.value !== ''; resyncAll(); });
      const tier = el('select', { 'aria-label': 'What it is', title: 'A new one: what is it?' }, tiers().map((t) => el('option', { value: t.id, text: t.one })));
      const go = el('button', { type: 'button', class: 'btn small', text: 'File', onclick: () => fileRow(r) });
      const status = el('span', { class: 'imp-status' });
      const bar = el('i', { class: 'imp-bar' }, el('i'));
      const thumb = el('span', { class: 'imp-thumb' });
      const said = el('button', { type: 'button', class: 'imp-filed', hidden: true, title: 'Open it, to look, comment and draw', onclick: () => r.version && lookAt(r.version.entityId, r.version.id) });
      const fields = el('span', { class: 'imp-fields' }, ent, tier, task, el('span', { class: 'imp-v' }, el('span', { text: 'v' }), num), go);
      WB.combo(ent, entitySource(() => cat, presetId));
      WB.combo(task, taskSource(tasks));
      const sync = () => {
        const { name } = choiceOf(r);
        const shape = name && N.tierOf(name, presetId);
        tier.hidden = !name || !!known(name) || !!shape;
        if (!r.numTouched && r.status !== 'filed') {
          const next = name ? nextNumber(r) : '';
          if (num.value !== String(next)) num.value = String(next);
        }
        go.disabled = !canFile(r);
        paintHead();
      };
      ent.addEventListener('input', resyncAll);
      task.addEventListener('input', resyncAll);
      for (const input of [ent, task, num]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented && canFile(r)) fileRow(r); });
      r.fields = { ent, task, num, tier, go, status, bar, thumb, said, box: fields, sync };
      r.node = el('div', { class: 'imp-row' }, thumb, el('span', { class: 'imp-file' }, el('span', { class: 'imp-name', text: r.file.name, title: r.file.name }), bar), fields, said, status);
      sync();
      return r.node;
    }

    function paintRow(r) {
      const f = r.fields;
      r.node.className = `imp-row ${r.status}${r.fileWhenReady ? ' soon' : ''}`;
      const pct = Math.min(99, Math.round((r.progress || 0) * 100));
      f.status.textContent = {
        queued: 'Waiting', uploading: `${PHASE[r.phase] || 'Preparing'} ${pct}%`, ready: '', filing: 'Filing…', filed: '', failed: r.error || 'Failed',
      }[r.status] + (r.fileWhenReady && r.status !== 'filing' ? ' · then filed' : '');
      f.bar.hidden = r.status !== 'uploading' && r.status !== 'queued';
      f.bar.firstChild.style.width = `${pct}%`;
      if (r.preview && !f.thumb.firstChild) f.thumb.append(el('img', { src: r.preview, alt: '' }));
      f.box.hidden = r.status === 'filed';
      f.said.hidden = r.status !== 'filed';
      f.said.textContent = r.label ? `Filed as ${r.label}` : '';
      f.go.textContent = r.status === 'filing' ? 'Filing…' : 'File';
      f.sync();
    }

    function paintHead() {
      tray.hidden = !rows.length;
      const busy = rows.filter((r) => r.status === 'queued' || r.status === 'uploading').length;
      const filed = rows.filter((r) => r.status === 'filed').length;
      title.textContent = busy ? `Bringing in ${rows.length - busy} of ${rows.length}` : `${plural(rows.length, 'file')} · ${filed} filed`;
      const ready = rows.filter(canFile).length;
      fileAll.textContent = ready > 1 ? `File all ${ready}` : 'File';
      fileAll.hidden = !ready;
      clearBtn.hidden = !filed && !rows.some((r) => r.status === 'failed' && !r.look);
      fillAll.hidden = rows.filter((r) => r.status !== 'filed').length < 2;
    }

    // What has been filed shows in the catalogue behind the strip at once.
    let redraw = 0;
    const showFiled = () => {
      clearTimeout(redraw);
      redraw = setTimeout(() => {
        if (currentFolder() !== project.id) return;
        shownProject = '';
        render();
      }, 300);
    };

    async function fileRow(r) {
      if (!canFile(r)) return;
      // Still on its way in: filed as soon as it is here.
      if (!r.look) {
        r.fileWhenReady = true;
        return paintRow(r);
      }
      const { name, task } = choiceOf(r);
      const have = known(name);
      const entity = have ? have.id : { name, tier: N.tierOf(name, presetId) || r.fields.tier.value };
      const number = Number(r.fields.num.value);
      r.status = 'filing';
      paintRow(r);
      try {
        const res = await api('POST', `/api/projects/${project.id}/versions`, { files: [{ look: r.look, entity, task, ...(Number.isSafeInteger(number) && number >= 1 && { number }) }], by: me.name });
        const v = res.versions[0];
        Object.assign(r, { status: 'filed', label: v.label, version: v });
        store(`wb:file:${project.id}`, { entity: name, task });
        // What is filed now has its number: the rows still to go count on from it.
        cat = null;
        await catalogue().catch(() => {});
        resyncAll();
        showFiled();
      } catch (err) {
        Object.assign(r, { status: 'failed', error: err.message });
      }
      paintRow(r);
    }

    // One file at a time: read, upload, and then it waits to be filed (or is, if that was asked for).
    let running = false;
    async function work() {
      if (running) return;
      running = true;
      await catalogue().catch(() => {});
      for (const r of rows) r.fields.sync();
      for (let r = rows.find((x) => x.status === 'queued'); r; r = rows.find((x) => x.status === 'queued')) {
        r.status = 'uploading';
        r.progress = 0;
        paintRow(r);
        try {
          r.look = await bringIn(r, () => paintRow(r));
          r.preview = r.look.th || (r.look.type === 'image' ? r.look.prev || r.look.src : r.look.poster) || null;
          r.status = 'ready';
          paintRow(r);
          if (r.fileWhenReady) {
            r.fileWhenReady = false;
            fileRow(r);
          }
        } catch (err) {
          r.status = 'failed';
          r.fileWhenReady = false;
          r.error = err.refused ? `This browser cannot process this video. Import it from ${WBIngest.OTHER_BROWSERS} instead` : err.message;
          paintRow(r);
        }
      }
      running = false;
    }

    // `entity`, when the files are added on an entity's page, is what they are filled in as.
    function add(files, entity = null) {
      let n = 0;
      for (const file of files) {
        if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|m4v|webm|mov)$/i.test(file.name)) continue;
        const r = { file, entity, status: 'queued', progress: 0, parsed: N.parse(file.name, presetId), look: null, preview: null };
        rows.push(r);
        list.append(makeRow(r));
        paintRow(r);
        n++;
      }
      if (!n) return void WB.dialog({ title: 'Nothing to bring in', text: 'Only images and MP4, WebM or MOV video can be added.', ok: 'OK', cancellable: false });
      paintHead();
      // The first file whose name said nothing takes the keyboard, ready to be told.
      const blank = rows.find((r) => r.status === 'queued' && !r.fields.ent.value);
      if (blank) setTimeout(() => blank.fields.ent.focus({ preventScroll: true }), 50);
      work();
    }

    function pick(entity = null) {
      pickFor = entity;
      picker.click();
    }

    // Leaving with files not yet filed would lose them.
    window.addEventListener('beforeunload', (e) => {
      if (!rows.some((r) => r.status !== 'filed' && !(r.status === 'failed' && !r.look))) return;
      e.preventDefault();
      e.returnValue = '';
    });

    state = { tray, add, pick };
    imports.set(project.id, state);
    return state;
  }

  // Files dropped anywhere on a project's catalogue go into it; on an asset, set or shot's page, into that.
  let dropTargetEntity = null;
  const catalogueOpen = () => {
    const cur = currentFolder();
    const f = cur && folderById(cur);
    return f && f.project && currentView().page === 'catalogue' ? f : null;
  };
  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e) || !catalogueOpen()) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      const view = currentView();
      dropTargetEntity = view.entity;
      $('catdrop').querySelector('span').textContent = view.entity ? 'Drop to add versions of it' : `Drop to add to ${catalogueOpen().name}`;
      $('catdrop').hidden = false;
    }
  });
  window.addEventListener('dragover', (e) => { if (carriesFiles(e) && catalogueOpen()) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('catdrop').hidden = true; } });
  window.addEventListener('drop', async (e) => {
    const project = carriesFiles(e) && catalogueOpen();
    dragDepth = 0;
    $('catdrop').hidden = true;
    if (!project) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    let entity = null;
    if (dropTargetEntity) {
      try {
        entity = (await api('GET', `/api/entities/${dropTargetEntity}`)).entity;
      } catch {
        entity = null;
      }
    }
    importer(project).add(files, entity);
  });

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
