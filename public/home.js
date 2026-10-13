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
    const card = el('a', { class: `card folder${folder.project ? ' project' : ''}`, href: `#/f/${folder.id}` },
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
  const recents = () => (Array.isArray(store('wb:recent')) ? store('wb:recent') : []);

  // ------------------------------------------------------------- the sidebar
  //
  // Always there on a wide window, and a drawer on a narrow one: Home, then each workspace with its
  // folders as a tree. A project opens to its boards and its catalogue, and the catalogue to its assets,
  // sets and shots, the shots by sequence. What is open in the tree is remembered.

  const ICON_HOME = svg('<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>', 16);
  const ICON_BOARDS = svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>', 16);
  const ICON_CAT = svg('<path d="M5 4h4v16H5zM10 4h4v16h-4z"/><path d="M15.5 4.6l3.8-1 3.7 15.5-3.8 1z"/>', 16);
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
        } else parts.push(['Boards', `#/f/${f.id}`]);
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
  // What you pinned, what you opened lately, and every project.

  function homeView() {
    const label = (text, n) => el('div', { class: 'section-label' }, text, n != null && el('span', { class: 'tally', text: String(n) }));
    const q = $('q').value.trim().toLowerCase();
    if (q) {
      const subs = everything.folders.filter((f) => f.name.toLowerCase().includes(q)).sort(byName);
      const boards = everything.boards.filter((b) => b.name.toLowerCase().includes(q));
      return [
        subs.length > 0 && label('Folders', subs.length), subs.length > 0 && el('div', { class: 'folder-grid' }, subs.map(folderCard)),
        label('Boards', boards.length), el('div', { class: 'board-grid' }, boards.map(boardCard)),
        !subs.length && !boards.length && el('p', { class: 'home-empty', text: `Nothing matches "${$('q').value.trim()}".` }),
      ];
    }
    const card = (p) => {
      if (p.kind === 'board') { const b = everything.boards.find((x) => x.id === p.id); return b && boardCard(b); }
      if (p.kind === 'folder') { const f = folderById(p.id); return f && folderCard(f); }
      if (p.kind === 'entity' && folderById(p.projectId)) return entityTile(folderById(p.projectId), { id: p.id, name: p.name, thumb: p.thumb, tier: p.tier, versions: null });
      return null;
    };
    const pinnedCards = pins().map(card).filter(Boolean);
    const recentBoards = recents().filter((x) => x.kind === 'board').map(card).filter(Boolean).slice(0, 8);
    const recentEnts = recents().filter((x) => x.kind === 'entity').map(card).filter(Boolean).slice(0, 8);
    const edited = recentBoards.length ? [] : [...everything.boards].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map(boardCard);
    const projects = everything.folders.filter((f) => f.project).sort(byName);
    const out = [];
    if (pinnedCards.length) out.push(label('Pinned', pinnedCards.length), el('div', { class: 'board-grid' }, pinnedCards));
    if (recentBoards.length) out.push(label('Boards you opened lately'), el('div', { class: 'board-grid' }, recentBoards));
    else if (edited.length) out.push(label('Edited lately'), el('div', { class: 'board-grid' }, edited));
    if (recentEnts.length) out.push(label('Looked at in the catalogue'), el('div', { class: 'board-grid ent-grid' }, recentEnts));
    if (projects.length) out.push(label('Projects', projects.length), el('div', { class: 'folder-grid' }, projects.map(folderCard)));
    if (!out.length) out.push(el('p', { class: 'home-empty', text: 'Nothing here yet. Make a board, or open a workspace on the left.' }));
    if (!pinnedCards.length && out.length) out.push(el('p', { class: 'home-hint', text: 'Pin boards, folders, projects and shots to keep them here: the star beside where you are, or a card\'s menu.' }));
    return out.filter(Boolean);
  }

  function render() {
    const rt = route();
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

  const ICON_IMPORT = svg('<path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 14v5h14v-5"/>', 16);
  const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>', 18);

  // Above the catalogue: the way to bring files in. Whatever a file's name says files it; the rest are asked about.
  function catTools(project) {
    return el('div', { class: 'cat-tools' },
      el('span', { class: 'cat-hint', text: 'Drop images and videos anywhere here to add them' }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_IMPORT}<span>Import</span>`, title: 'Bring images and videos into the catalogue', onclick: () => importer(project).pick() }));
  }

  function entityTile(project, e) {
    return el('a', { class: 'card ent', href: `#/f/${project.id}/catalogue/${e.id}` },
      el('div', { class: `card-thumbs n${e.thumb ? 1 : 0}` }, e.thumb && el('img', { src: e.thumb, alt: '', loading: 'lazy', draggable: 'false' })),
      el('div', { class: 'card-body' },
        el('div', { class: 'card-name', text: e.name }),
        el('div', { class: 'card-meta', text: e.versions == null ? (N.TIERS.includes(e.tier) ? e.tier : '') : e.versions ? `${plural(e.versions, 'version')} · last ${ago(e.latestAt)}` : 'Nothing filed yet' })));
  }

  function catalogueView(project, cat, view = {}) {
    const q = $('q').value.trim().toLowerCase();
    const list = cat.entities.filter((e) => (!q || e.name.includes(q))
      && (!view.tier || e.tier === view.tier) && (!view.seq || (e.tier === 'shot' && N.seqOf(e.name) === view.seq)));
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
        !q && el('p', { text: 'Drop images and videos here, or import them. On a board, select some and file them as versions (Shift+V).' })));
    }
    return [catTools(project, null), ...out];
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

  // What a version is filed as: its asset, set or shot, task and number make its name. Moved to another
  // asset or task with its number left as it was, it becomes the next one there.
  async function editVersion(project, entity, v) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    const presetId = project.settings && project.settings.naming;
    const list = (id, values) => el('datalist', { id }, (values || []).map((value) => el('option', { value })));
    const field = (label, input) => el('label', { class: 've-field' }, el('span', { text: label }), input);
    const ent = el('input', { type: 'text', value: entity.name, list: 've-entities', autocomplete: 'off', required: true, spellcheck: 'false' });
    const task = el('input', { type: 'text', value: v.task || '', list: 've-tasks', autocomplete: 'off', placeholder: 'None', spellcheck: 'false' });
    const num = el('input', { type: 'number', value: String(v.number), min: '1', step: '1' });
    const artist = el('input', { type: 'text', value: v.artist || '', list: 've-artists', autocomplete: 'off', placeholder: 'None', spellcheck: 'false' });
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
      list('ve-entities', cat && cat.entities.map((x) => x.name)), list('ve-tasks', cat && cat.tasks), list('ve-artists', cat && cat.artists),
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
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
      el('button', { type: 'button', class: 'btn small ghost', text: 'Undo', onclick: async () => { node.remove(); try { await undo(); } catch (err) { fail(err); } } }));
    undoNode = node;
    document.body.append(node);
    setTimeout(() => node.remove(), 8000);
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
    const card = (v) => el('div', { class: `card ver${v.hidden ? ' hidden-ver' : ''}` },
      el('button', { type: 'button', class: `card-thumbs n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw', onclick: () => lookAt(entity.id, v.id) },
        v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
        v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })),
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
        el('div', { class: 'ent-msg-top' }, el('strong', { text: n.name }), el('span', { text: ago(n.t) }),
          first && (n.board.id
            ? el('a', { href: `/b/${n.board.id}#c=${n.id}`, text: `on ${n.board.name || 'a board'}` })
            : el('span', { class: 'ent-msg-where', text: 'in the catalogue' }))),
        el('div', { class: 'ent-msg-text', text: n.text })));
    const threads = roots.map((n) => el('div', { class: `ent-thread${n.done ? ' done' : ''}` },
      el('div', { class: 'ent-thread-ver' }, byVersion.get(n.versionId)?.label || '', n.done && el('span', { class: 'ent-done', text: 'Resolved' })),
      msg(n, true), replies(n.id).map((r) => msg(r, false))));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    return el('div', { class: 'ent-page' },
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

  // What is being brought into a project's catalogue: a strip above it, one row a file. Kept per project,
  // so leaving the catalogue and coming back finds it as it was.
  function importer(project) {
    let state = imports.get(project.id);
    if (state) return state;
    const presetId = project.settings && project.settings.naming;
    const rows = [];
    const list = el('div', { class: 'imp-list' });
    const pending = el('div', { class: 'imp-pending' });
    const clearBtn = el('button', { type: 'button', class: 'btn small ghost', text: 'Clear', title: 'Put away what is done', onclick: () => {
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i].status === 'filed' || rows[i].status === 'failed') rows.splice(i, 1);
      paint();
    } });
    const head = el('div', { class: 'imp-head' }, el('b', { class: 'imp-title' }), clearBtn);
    const tray = el('div', { class: 'imp', hidden: true }, head, pending, list);
    const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime', hidden: true });
    document.body.append(picker);
    let pickFor = null;
    picker.addEventListener('change', () => {
      add([...picker.files], pickFor);
      picker.value = '';
    });

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
        el('span', { class: 'imp-said', text: r.entity ? `Into ${r.entity.name}` : [r.parsed.entity, r.parsed.task].filter(Boolean).join(' · ') }),
        el('span', { class: 'imp-status', text: status }));
    }

    function paint() {
      tray.hidden = !rows.length;
      const busy = rows.filter((r) => r.status === 'queued' || r.status === 'uploading' || r.status === 'filing').length;
      head.firstChild.textContent = busy ? `Bringing in ${busy} of ${rows.length}` : `Brought in ${rows.filter((r) => r.status === 'filed').length} of ${rows.length}`;
      clearBtn.hidden = !!busy && rows.every((r) => r.status !== 'filed' && r.status !== 'failed');
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

    async function fileRows(list, choice = {}) {
      for (const r of list) r.status = 'filing';
      paint();
      try {
        const res = await api('POST', `/api/projects/${project.id}/versions`, { files: list.map((r) => ({ look: r.look })), ...choice, by: me.name });
        res.versions.forEach((v, i) => { list[i].status = 'filed'; list[i].label = v.label; list[i].version = v; });
        cat = null;
        await catalogue().catch(() => {});
        showFiled();
      } catch (err) {
        for (const r of list) {
          r.status = choice.entity && !list[0].entity ? 'needs' : 'failed';
          r.error = err.message;
        }
        if (choice.entity && !list[0].entity) WB.dialog({ title: 'Those were not filed', text: err.message, ok: 'OK', cancellable: false });
      }
      paint();
    }

    // One file at a time: read, upload, and file at once when it is known where it goes.
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
          // Added on an asset, set or shot's page, it goes there, whatever its name says; its task still comes from the name.
          if (r.entity) await fileRows([r], { entity: r.entity.id });
          else if (r.parsed.entity) await fileRows([r]);
          else r.status = 'needs';
        } catch (err) {
          r.status = 'failed';
          r.error = err.refused ? `This browser cannot process this video. Import it from ${WBIngest.OTHER_BROWSERS} instead` : err.message;
        }
        paint();
      }
      running = false;
    }

    // `entity`, when the files are added on an entity's page, is where they all go.
    function add(files, entity = null) {
      let n = 0;
      for (const file of files) {
        if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|m4v|webm|mov)$/i.test(file.name)) continue;
        rows.push({ file, entity, status: 'queued', progress: 0, parsed: N.parse(file.name, presetId), look: null, preview: null });
        n++;
      }
      if (!n) return void WB.dialog({ title: 'Nothing to bring in', text: 'Only images and MP4, WebM or MOV video can be added.', ok: 'OK', cancellable: false });
      paint();
      work();
    }

    function pick(entity = null) {
      pickFor = entity;
      picker.click();
    }

    // Leaving while a file is still on its way in would lose it.
    window.addEventListener('beforeunload', (e) => {
      if (!rows.some((r) => r.status === 'queued' || r.status === 'uploading' || r.status === 'filing')) return;
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
