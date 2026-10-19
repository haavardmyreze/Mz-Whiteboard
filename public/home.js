'use strict';

(async () => {
  const { el, api, ago, store } = WB;
  const $ = (id) => document.getElementById(id);

  const icon = WB.icon; // icons.js
  const ICON_FOLDER = icon('folder', 20);
  const ICON_FOLDER_SM = icon('folder', 16);
  const ICON_PROJECT = icon('project', 20);
  const ICON_MORE = icon('more', 18);

  let everything = { folders: [], boards: [] }; // all you may see, in every workspace
  let lib = { folders: [], boards: [] };       // the workspace being shown
  const SPACES = { myreze: 'Myreze', personal: 'Personal' };
  let space = 'myreze';
  let dragging = null; // { kind: 'board' | 'folder', id }

  $('themeslot').replaceWith(WB.themeButton());
  // Normal cards, or compact rows: a small still beside the name, many more to a screen. Remembered here.
  const ICON_ROWS = icon('rows', 18);
  const ICON_CARDS = icon('boards', 18);
  function paintDensity() {
    const compact = document.documentElement.dataset.density === 'compact';
    $('density').innerHTML = compact ? ICON_CARDS : ICON_ROWS;
    $('density').title = compact ? 'Show as cards' : 'Show as compact rows';
    $('density').setAttribute('aria-label', $('density').title);
    $('density').setAttribute('aria-pressed', String(compact));
  }
  function setDensity(compact) {
    if (compact) document.documentElement.dataset.density = 'compact';
    else delete document.documentElement.dataset.density;
    store(WB.KEYS.density, compact ? 'compact' : 'normal');
    paintDensity();
  }
  $('density').addEventListener('click', () => setDensity(document.documentElement.dataset.density !== 'compact'));
  // On a phone the search is a button in the bar, opening the box over it.
  $('searchtoggle').addEventListener('click', () => {
    const on = !document.body.classList.contains('search-open');
    document.body.classList.toggle('search-open', on);
    $('searchtoggle').setAttribute('aria-expanded', String(on));
    if (on) $('q').focus();
  });
  $('q').addEventListener('blur', () => {
    if ($('q').value) return;
    document.body.classList.remove('search-open');
    $('searchtoggle').setAttribute('aria-expanded', 'false');
  });
  paintDensity();
  WB.watchServer();
  let me = await WB.askName();
  // Personal workspaces belong to a signed-in account, so without sign-in there is only the shared one.
  const hasPersonal = !!WB.info().user;
  if (hasPersonal && store('wb:workspace') === 'personal') space = 'personal';
  const paintMe = () => $('me').replaceChildren(
    WB.avatar(me.name, me.color),
    el('span', { text: me.name }));
  paintMe();
  $('me').title = 'Your account';
  // Your account (account.js): a change of name or colour there shows here at once.
  $('me').addEventListener('click', () => WBAccount.open({ me: () => me, setMe: (m) => { me = m; paintMe(); }, setDensity }));

  // ------------------------------------------------------------- library helpers

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  // A folder is found whatever workspace it is in; only the top level, `null`, is the workspace's own.
  const folderById = (id) => everything.folders.find((f) => f.id === id) || null;
  // The project the page is in, if it is in one.
  const projectHere = () => {
    const id = currentFolder();
    return (id && trailTo(id).reverse().find((f) => f.project)) || null;
  };
  let presentBtn = null; // the bar's Present button (see presenting, at the end)
  // The videos the pages here show that have no phone copy yet: made here, one at a time, when this desk
  // browser can and has nothing better to do (ingest.js); never while the player is open, or presenting.
  const needsPhoneCopy = new Set();
  const phoneCopies = WBIngest.phoneCopies(() => (WBPresent.token() || (player && player.isOpen()) ? [] : [...needsPhoneCopy]));
  const childrenOf = (id, ws = space) => (id ? everything.folders : everything.folders.filter((f) => f.workspace === ws)).filter((f) => (f.parentId || null) === id).sort(byName);
  const boardsIn = (id, ws = space) => (id ? everything.boards : everything.boards.filter((b) => b.workspace === ws)).filter((b) => (b.folderId || null) === id);

  function currentFolder() {
    const m = /^#\/f\/([\w-]+)/.exec(location.hash);
    return m && folderById(m[1]) ? m[1] : null;
  }

  // In a project folder: which of its pages is open, its home, its boards (#/f/<id>/boards) or catalogue, and in the catalogue the tier
  // (#/f/<id>/catalogue/t/shot), the sequence (…/s/kilo) or the entity (…/<entity id>) being looked at.
  function currentView() {
    if (/^#\/f\/[\w-]+\/timeline/.test(location.hash)) return { page: 'timeline', entity: null };
    if (/^#\/f\/[\w-]+\/versions/.test(location.hash)) return { page: 'versions', entity: null };
    if (/^#\/f\/[\w-]+\/boards/.test(location.hash)) return { page: 'boards', entity: null };
    const m = /^#\/f\/[\w-]+\/(catalogue)(?:\/(?:(t|s)\/([\w-]+)|([\w-]+)))?/.exec(location.hash);
    // A project's own root is its home page.
    if (!m) return { page: 'home', entity: null };
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
  let libraryLoaded = false;
  // Somebody typing on the page (a name for an asset, a comment, the importer) is never rebuilt under:
  // what the background check found waits until they are done.
  const typingInPage = () => WB.isTyping(document.activeElement) && !!document.activeElement.closest('#content, dialog');
  let renderWaiting = false;
  document.addEventListener('focusout', () => setTimeout(() => {
    if (renderWaiting && !typingInPage()) {
      renderWaiting = false;
      render();
    }
  }, 0));
  // Pages that show boards say how long ago each was edited; only they are rebuilt once a minute.
  const showsBoardTimes = () => {
    const rt = route();
    if (rt.kind === 'space') return true;
    if (rt.kind !== 'folder') return false;
    const f = folderById(rt.id);
    return !f || !f.project || ['boards', 'home'].includes(currentView().page);
  };
  async function refresh(quiet = false) {
    try {
      const next = await api('GET', '/api/library');
      const sig = JSON.stringify(next);
      if (quiet === true && sig === shown && (Date.now() - shownAt < 60000 || !showsBoardTimes())) return;
      shown = sig;
      shownAt = Date.now();
      everything = next;
      libraryLoaded = true;
      prunePins();
      if (quiet === true && typingInPage()) {
        renderWaiting = true;
        return;
      }
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

  const openMenu = (anchor, entries) => WB.menu(anchor, entries, { onError: fail });

  function menuButton(entries) {
    return el('button', {
      class: 'iconbtn card-menu', title: 'More', html: ICON_MORE, 'aria-haspopup': 'menu',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.currentTarget, entries);
      },
    });
  }


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
      add(null, spaceName(space), 0);
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

  const { plural } = WB;

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
    if (on) location.hash = WB.href.catalogue(folder.id);
  }

  // A project's settings: whether its versions are counted by task, whether they are shown more than one
  // way and which ways (its views, the main one first), the names from elsewhere it has learned to read,
  // and its 3D preview: the model of the venue its work is shown on, the material its projection
  // surface has, and which view of a version goes on it. Set here once, they are never asked about
  // again: the player just has a 2D / 3D switch.
  async function projectSettings(project) {
    const was = (project.settings && project.settings.preview3d) || null;
    const byTask = el('input', { type: 'checkbox', class: 'switch', ...(!(project.settings && project.settings.tasks === false) && { checked: true }), 'aria-label': 'Count versions by task' });
    // What it has learned of file names from elsewhere: each a chip, forgotten with its ×. Only there once there are some.
    let rules = [...((project.settings && project.settings.rules) || [])];
    const ruleList = el('div', { class: 'ps-chips' });
    const paintRules = () => {
      ruleList.replaceChildren(...rules.map((r) => el('span', { class: 'ps-chip' }, el('span', { text: N.ruleText(r) }),
        el('button', { type: 'button', class: 'ps-chip-x', html: icon('close', 12), title: `Forget ${N.ruleText(r)}`, 'aria-label': `Forget ${N.ruleText(r)}`, onclick: () => { rules = rules.filter((x) => x !== r); paintRules(); } }))));
      if (rulesRow) rulesRow.hidden = !rules.length;
    };
    let rulesRow = null;
    let model = was ? { url: was.model, name: was.name || 'Model' } : null;
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    // Its views, as set.
    const list = (cat && cat.viewList) || null;
    const byView = el('input', { type: 'checkbox', class: 'switch', ...(list && { checked: true }), 'aria-label': 'Several views of each version' });
    const viewNames = el('input', { type: 'text', value: (list || []).join(', '), placeholder: 'cmp, bty', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Its views, the main one first' });
    const named = () => [...new Set(viewNames.value.split(/[\s,]+/).map((v) => N.tokenize(v)).filter(Boolean))];
    const file = el('span', { class: 'ps-file' });
    const picker = el('input', { type: 'file', accept: '.glb,model/gltf-binary', hidden: true });
    const choose = el('button', { type: 'button', class: 'btn small', onclick: () => picker.click() });
    const remove = el('button', { type: 'button', class: 'btn small ghost', text: 'Remove', onclick: () => { model = null; paint(); } });
    const screen = el('input', { type: 'text', value: (was && was.screen) || 'screen', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Material of the projection surface' });
    const view = el('select', { 'aria-label': 'Which view goes on the model' });
    // The ways it can show a version on the model: its views as they are being set here, the main one first.
    const paintViews = () => {
      const now = byView.checked && named().length > 1 ? named() : null;
      const chosen = view.value || (was ? was.view || '' : '');
      view.replaceChildren(...[['', now ? `${now[0]} (main)` : 'Main view'], ...(now || []).slice(1).map((v) => [v, v])]
        .map(([v, t]) => el('option', { value: v, text: t, ...(chosen === v && { selected: true }) })));
      if (viewsRow) viewsRow.hidden = !byView.checked;
      if (pictureRow) pictureRow.hidden = !model || !now;
    };
    let viewsRow = null;
    let pictureRow = null;
    byView.addEventListener('change', paintViews);
    viewNames.addEventListener('input', paintViews);
    paintViews();
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save' });
    const paint = () => {
      file.textContent = model ? model.name : 'No model';
      file.classList.toggle('none', !model);
      choose.textContent = model ? 'Replace…' : 'Choose a .glb…';
      remove.hidden = !model;
      // What goes with a model, only once there is one.
      surfaceRow.hidden = !model;
      paintViews();
    };
    picker.addEventListener('change', async () => {
      const f = picker.files[0];
      picker.value = '';
      if (!f) return;
      save.disabled = choose.disabled = true;
      try {
        const up = await WBIngest.upload(f, '.glb', (k) => { file.textContent = `Uploading ${f.name}… ${Math.round(k * 100)}%`; });
        model = { url: up.url, name: f.name };
      } catch (err) {
        WB.toast(`${f.name} could not be uploaded: ${err.message}`, { ms: 6000 });
      }
      save.disabled = choose.disabled = false;
      paint();
    });
    // A setting: what it is, a few words more when it needs them, and its control. `sub` is one that
    // belongs to the setting above, shown only while that is on.
    const row = (label, hint, ...control) => el('div', { class: 'ps-row' },
      el('div', { class: 'ps-label' }, el('b', { text: label }), hint && el('span', { text: hint })), el('div', { class: 'ps-control' }, ...control));
    const sub = (label, hint, ...control) => {
      const node = row(label, hint, ...control);
      node.classList.add('sub');
      return node;
    };
    viewsRow = sub('Views', 'The main one first: a file of it is a version, the others go with one', viewNames);
    const surfaceRow = sub('Screen material', 'What the screens are called in the model', screen);
    pictureRow = sub('On the screens', 'Which view of a version is shown', view);
    rulesRow = row('Learned file names', 'Names from elsewhere, read this way when filing', ruleList);
    paintRules();
    const dlg = el('dialog', { class: 'dlg ps-dlg' },
      el('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          if (byView.checked && named().length < 2) {
            WB.toast('Name at least two views, the main one first: cmp, bty', { ms: 6000 });
            viewNames.focus();
            return;
          }
          save.disabled = true;
          try {
            await api('PATCH', `/api/folders/${project.id}`, { settings: { tasks: byTask.checked, views: byView.checked ? named() : false, rules, preview3d: model ? { model: model.url, name: model.name, screen: screen.value.trim() || 'screen', view: view.value } : null } });
            catalogues.delete(project.id);
            await refresh();
            dlg.close();
            WB.toast(model ? 'Saved. The player has a 2D / 3D switch in this project' : 'Saved');
          } catch (err) {
            WB.toast(err.message, { ms: 6000 });
            save.disabled = false;
          }
        },
      },
      el('h2', { text: `${project.name}: settings` }),
      el('h3', { class: 'ps-sec', text: 'Versions' }),
      row('Count by task', 'anim v1, lighting v1… rather than one count', byTask),
      row('Several views of each version', 'Each version as more than one file: cmp and bty, say', byView),
      viewsRow,
      rulesRow,
      el('h3', { class: 'ps-sec', text: '3D' }),
      row('Venue model', 'A .glb with a camera named “main”: the player gets a 2D / 3D switch', el('div', { class: 'ps-model' }, file, choose, remove), picker),
      surfaceRow,
      pictureRow,
      el('div', { class: 'dlg-actions' }, el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), save)));
    dlg.addEventListener('close', () => dlg.remove());
    paint();
    document.body.append(dlg);
    dlg.showModal();
  }

  function folderCard(folder) {
    const subs = childrenOf(folder.id).length;
    const boards = boardsIn(folder.id).length;
    const meta = [folder.project && 'Project', boards && plural(boards, 'board'), subs && plural(subs, 'folder')].filter(Boolean).join(' · ') || 'Empty';
    const card = el('a', { class: `card folder${folder.project ? ' project' : ''}${bpick.has(`folder:${folder.id}`) ? ' picked' : ''}`, href: WB.href.folder(folder.id), 'data-pick': `folder:${folder.id}` },
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
        folder.project && ['Open the catalogue', () => { location.hash = WB.href.catalogue(folder.id); }],
        folder.project && ['Project settings…', () => projectSettings(folder)],
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
    const card = el('a', { class: `card${bpick.has(`board:${board.id}`) ? ' picked' : ''}`, href: WB.href.board(board.id), 'data-pick': `board:${board.id}` },
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
      el('span', { class: 'new-thumb' }, el('span', { class: 'plus', html: icon('plus', 18) })),
      el('span', { class: 'card-body' },
        el('span', { class: 'card-name', text: 'New board' }),
        el('span', { class: 'card-meta', text: 'Start from a blank canvas' })));
  }

  // ------------------------------------------------------------- pinned and recent
  //
  // Both are kept by this browser. What you opened (boards, from board.js, and assets, sets and shots)
  // is remembered as you go; what you pin stays on Home until you unpin it.

  const pins = () => (Array.isArray(store(WB.KEYS.pins)) ? store(WB.KEYS.pins) : []);
  // Pins to what has since been deleted go, once the library (and for an asset, set or shot, its
  // project's catalogue) says so: they would only lead nowhere, and take the room of real pins.
  function prunePins() {
    if (!libraryLoaded) return;
    const keep = pins().filter((p) => {
      if (p.kind === 'board') return everything.boards.some((b) => b.id === p.id);
      if (p.kind === 'folder') return !!folderById(p.id);
      if (!folderById(p.projectId)) return false;
      if (p.kind === 'entity') {
        const cat = catalogues.get(p.projectId);
        return !cat || cat.entities.some((e) => e.id === p.id);
      }
      return true;
    });
    if (keep.length !== pins().length) store(WB.KEYS.pins, keep);
  }
  const isPinned = (kind, id) => pins().some((p) => p.kind === kind && p.id === id);
  function togglePin(entry) {
    const list = pins();
    const at = list.findIndex((p) => p.kind === entry.kind && p.id === entry.id);
    if (at >= 0) list.splice(at, 1);
    else list.unshift({ ...entry, at: Date.now() });
    store('wb:pins', list.slice(0, 60));
    render();
    keepAhead();
  }

  // ------------------------------------------------------------- the sidebar
  //
  // Always there on a wide window, and a drawer on a narrow one: Home, then each workspace with its
  // folders as a tree, with what you pinned between. A project opens to its boards and its catalogue, and
  // the catalogue to its assets, sets and shots, the shots by sequence. Only what you are in is open.

  const ICON_HOME = icon('home', 16);
  const ICON_BOARDS = icon('boards', 16);
  const ICON_CAT = icon('catalogue', 16);
  const ICON_LIST = icon('list', 16);
  const ICON_FILM = icon('film', 16);
  const ICON_DOT = icon('dot', 16);
  const ICON_CHEVRON = icon('chevron', 14);
  const ICON_STAR = icon('star', 16);
  const FOLDER_SM = icon('folder', 16);
  const PROJECT_SM = icon('project', 16);

  // Only what you are in is open: going somewhere closes the rest. A twist opens a row for a look,
  // until you go somewhere.
  const opened = new Set();
  let openedFor = null;
  const setOpen = (key, on) => {
    if (on) opened.add(key);
    else opened.delete(key);
  };

  // The key of the place the page is on, as the tree names its rows.
  function hereKey(rt) {
    if (rt.kind === 'home') return 'home';
    if (rt.kind === 'space') return `w:${rt.space}`;
    const f = folderById(rt.id);
    const v = f && f.project ? currentView() : { page: 'boards' };
    if (v.page === 'timeline') return `tl:${rt.id}`;
    if (v.page === 'versions') return `vl:${rt.id}`;
    if (v.page === 'boards') return f && f.project ? `p:${rt.id}` : `f:${rt.id}`;
    if (v.page !== 'catalogue') return `f:${rt.id}`;
    if (v.seq) return `s:${rt.id}:${v.seq}`;
    if (v.tier) return `t:${rt.id}:${v.tier}`;
    if (v.entity) {
      const e = (catalogues.get(rt.id)?.entities || []).find((x) => x.id === v.entity);
      const seq = e && e.tier === 'shot' && N.seqOf(e.name);
      if (seq) return `s:${rt.id}:${seq}`;
      return e ? `t:${rt.id}:${e.tier}` : `c:${rt.id}`;
    }
    return `c:${rt.id}`;
  }

  // The rows above the place the page is on are opened, so it can be seen in the tree.
  function openTo(rt) {
    if (openedFor === location.hash) return;
    openedFor = location.hash;
    opened.clear();
    if (rt.kind !== 'folder') return;
    for (const f of trailTo(rt.id)) opened.add(`f:${f.id}`);
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
      el('a', { class: 'side-link', href, 'aria-current': key === hereK ? 'page' : null, onclick: () => { if (kids && !isOpen) setOpen(key, true); closeDrawer(); } },
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
      return sideRow({ key: `f:${f.id}`, depth, icon: FOLDER_SM, label: f.name, href: WB.href.folder(f.id), kids: childrenOf(f.id).length ? subs : null, drop, hereK });
    }
    // A project: its boards (and folders), and its catalogue.
    const cat = catalogues.get(f.id);
    const tierRows = () => {
      if (!cat) {
        const pad = { paddingLeft: `${(depth + 2) * 14 + 32}px` };
        if (catBroken(f.id)) {
          return [el('div', { class: 'side-row side-note', style: pad }, 'Could not load. ',
            el('button', { type: 'button', class: 'linkbtn', text: 'Try again', onclick: () => loadCatalogue(f.id, true) }))];
        }
        loadCatalogue(f.id);
        return [el('div', { class: 'side-row side-note', style: pad, text: 'Loading…' })];
      }
      return cat.tiers.flatMap((t) => {
        const of = cat.entities.filter((e) => e.tier === t.id);
        const seqs = t.id === 'shot' ? [...new Set(of.map((e) => N.seqOf(e.name)).filter(Boolean))].sort() : [];
        return sideRow({
          key: `t:${f.id}:${t.id}`, depth: depth + 2, icon: ICON_DOT, label: t.label, href: WB.href.catalogue(f.id, { tier: t.id }), count: of.length, hereK,
          kids: seqs.length ? () => seqs.flatMap((q) => sideRow({ key: `s:${f.id}:${q}`, depth: depth + 3, icon: ICON_DOT, label: q, href: WB.href.catalogue(f.id, { seq: q }), count: of.filter((e) => N.seqOf(e.name) === q).length, hereK })) : null,
        });
      });
    };
    const kids = () => [
      ...sideRow({ key: `p:${f.id}`, depth: depth + 1, icon: ICON_BOARDS, label: 'Boards', href: WB.href.boards(f.id), count: boardsIn(f.id).length, drop, hereK }),
      ...sideRow({ key: `c:${f.id}`, depth: depth + 1, icon: ICON_CAT, label: 'Catalogue', href: WB.href.catalogue(f.id), kids: tierRows, hereK }),
      ...sideRow({ key: `vl:${f.id}`, depth: depth + 1, icon: ICON_LIST, label: 'Versions', href: WB.href.versions(f.id), hereK }),
      ...sideRow({ key: `tl:${f.id}`, depth: depth + 1, icon: ICON_FILM, label: 'Timeline', href: WB.href.timeline(f.id), hereK }),
      ...subs(),
    ];
    return sideRow({ key: `f:${f.id}`, depth, icon: PROJECT_SM, label: f.name, href: WB.href.folder(f.id), kids, drop, hereK, cls: 'project' });
  }

  // A catalogue that would not load is not asked for again on every render (the sidebar, Home's pins and
  // the cache would ask in a loop): it says so where it would show, with a way to try again.
  const loading = new Set();
  const catFailed = new Map(); // project id -> when it failed
  const catBroken = (id) => catFailed.has(id) && Date.now() - catFailed.get(id) < 60000;
  async function loadCatalogue(id, force = false) {
    if (loading.has(id) || (!force && catBroken(id))) return;
    loading.add(id);
    try {
      catalogues.set(id, await api('GET', `/api/projects/${id}`));
      catFailed.delete(id);
      prunePins();
    } catch {
      catFailed.set(id, Date.now());
    }
    loading.delete(id);
    keepAhead();
    renderSide(route());
    renderCrumbs(route());
    if (route().kind === 'home' && !$('q').value.trim()) render();
  }

  // What you pinned, each as a row that goes there.
  function pinnedRows(hereK) {
    const rows = pins().map((p) => {
      if (p.kind === 'board') {
        const b = everything.boards.find((x) => x.id === p.id);
        return b && { key: `pin:b:${b.id}`, icon: ICON_BOARDS, label: b.name, href: WB.href.board(b.id) };
      }
      if (p.kind === 'folder') {
        const f = folderById(p.id);
        return f && { key: `f:${f.id}`, icon: f.project ? PROJECT_SM : FOLDER_SM, label: f.name, href: WB.href.folder(f.id) };
      }
      const project = folderById(p.projectId);
      if (!project) return null;
      if (p.kind === 'entity') return { key: `pin:e:${p.id}`, icon: ICON_DOT, label: p.name, href: WB.href.catalogue(project.id, { entity: p.id }), title: project.name };
      if (p.kind === 'place') {
        const icon = { sequence: ICON_FILM, timeline: ICON_FILM, versions: ICON_LIST }[p.what] || ICON_CAT;
        const label = p.what === 'sequence' || p.what === 'tier' ? p.name : `${project.name} ${p.name.toLowerCase()}`;
        return { key: `pin:p:${p.id}`, icon, label, href: p.href, title: project.name };
      }
      return null;
    }).filter(Boolean);
    if (!rows.length) return [];
    const here = location.hash || '#/';
    return [
      el('div', { class: 'side-head plain' }, el('span', { text: 'Pinned' }), el('span', { class: 'side-count', text: String(rows.length) })),
      ...rows.map((x) => el('div', { class: `side-row${x.href === here ? ' here' : ''}` },
        el('span', { class: 'side-twist none' }),
        el('a', { class: 'side-link', href: x.href, title: x.title ? `${x.label} · ${x.title}` : x.label, onclick: closeDrawer },
          el('span', { class: 'side-icon', html: x.icon }),
          el('span', { class: 'side-name', text: x.label })))),
    ];
  }

  function renderSide(rt) {
    const hereK = hereKey(rt);
    const wsList = hasPersonal ? ['myreze', 'personal'] : ['myreze'];
    $('side').replaceChildren(
      ...sideRow({ key: 'home', depth: 0, icon: ICON_HOME, label: 'Home', href: '#/', hereK, cls: 'top' }),
      ...pinnedRows(hereK),
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
  // Somebody else on the team presenting the project you are in: a way to watch them, as their link does.
  function presentingHere(rt) {
    const proj = rt.kind === 'folder' ? trailTo(rt.id).reverse().find((f) => f.project) : null;
    const mine = WBPresent.token();
    return (proj ? everything.presenting || [] : []).filter((p) => p.projectId === proj.id && p.token !== mine).map((p) => el('a', {
      class: 'crumb-live', href: `/p/${p.token}`, target: '_blank', rel: 'noopener',
      title: `${p.name} is presenting ${proj.name}. Watch what they show, in a new tab`,
    }, el('i', { class: 'live', style: { background: p.color } }), el('span', { text: `${p.name} is presenting` }), el('b', { text: 'Watch' })));
  }

  // One line: the workspace, the folders down to here, and in a catalogue the tier, the sequence and
  // the asset, set or shot. Every part goes there, folders take drops, and the star pins what is here.

  function renderCrumbs(rt) {
    const parts = []; // [label, href, folderId for drops (undefined: none), ws]
    let pin = null;
    let settingsOf = null; // a project's home has the way to its settings
    if (rt.kind === 'home') parts.push(['Home', '#/']);
    else if (rt.kind === 'space') parts.push([spaceName(rt.space), spaceHref(rt.space), null, rt.space]);
    else {
      const trail = trailTo(rt.id);
      const ws = trail.length ? trail[0].workspace : space;
      parts.push([spaceName(ws), spaceHref(ws), null, ws]);
      for (const f of trail) parts.push([f.name, WB.href.folder(f.id), f.id, ws]);
      const f = trail[trail.length - 1];
      pin = f && { kind: 'folder', id: f.id };
      if (f && f.project) {
        const v = currentView();
        if (v.page === 'home') settingsOf = f;
        if (v.page === 'catalogue') {
          parts.push(['Catalogue', WB.href.catalogue(f.id)]);
          const cat = catalogues.get(f.id);
          const e = v.entity && cat && cat.entities.find((x) => x.id === v.entity);
          const tier = v.tier || (v.seq && 'shot') || (e && e.tier);
          const t = tier && cat && cat.tiers.find((x) => x.id === tier);
          if (t) parts.push([t.label, WB.href.catalogue(f.id, { tier: t.id })]);
          const seq = v.seq || (e && e.tier === 'shot' && N.seqOf(e.name));
          if (seq) parts.push([seq, WB.href.catalogue(f.id, { seq: seq })]);
          if (v.entity) {
            const name = e ? e.name : shownEntity && shownEntity.id === v.entity ? shownEntity.name : '…';
            parts.push([name, WB.href.catalogue(f.id, { entity: v.entity })]);
            pin = e || (shownEntity && shownEntity.id === v.entity) ? { kind: 'entity', id: v.entity, name, projectId: f.id, tier: (e || shownEntity).tier, thumb: (e && e.thumb) || null } : null;
          }
        } else if (v.page === 'timeline') parts.push(['Timeline', WB.href.timeline(f.id)]);
        else if (v.page === 'versions') parts.push(['Versions', WB.href.versions(f.id)]);
        else if (v.page === 'boards') parts.push(['Boards', WB.href.boards(f.id)]);
        // The star pins what is here, not the project around it: a sequence, a tier, the catalogue,
        // the timeline or the versions are pinned as that place (an asset, set or shot as itself).
        if (v.page !== 'boards' && v.page !== 'home' && !v.entity) {
          const [name, href] = parts[parts.length - 1];
          const what = v.seq ? 'sequence' : v.tier ? 'tier' : v.page;
          pin = { kind: 'place', id: href, href, name, what, projectId: f.id };
        }
      }
    }
    const nodes = parts.map(([label, href, folderId, ws], i) => {
      const node = el('a', { class: `crumb${i === parts.length - 1 ? ' current' : ''}`, href, text: label, 'aria-current': i === parts.length - 1 ? 'page' : null });
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
      }),
      settingsOf && el('button', { type: 'button', class: 'iconbtn crumb-pin', html: icon('settings', 16), title: 'Project settings', 'aria-label': 'Project settings', onclick: () => projectSettings(settingsOf) }),
      ...presentingHere(rt),
      ].filter(Boolean));
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
    keepAhead();
    if (route().kind === 'home' && !$('q').value.trim()) render();
  }

  // ------------------------------------------------------------- kept on this computer ahead
  //
  // The newest version of your work, of what you are cc'd on, and of what you pinned, is fetched ahead
  // and kept on this computer (media.js), so it opens and scrubs at once when you get to it. So is what
  // the page you are on shows. Each can be turned off in your settings.
  const videoOf = (n) => (n && n.look && n.look.type === 'video' ? WB.playable(n.look) : null);
  function keepAhead() {
    const R = WB.media.RANK;
    if (feed) {
      WB.media.want('work', feed.work.map((e) => videoOf(e.newest)), { rank: R.work, kind: 'work' });
      WB.media.want('cc', (feed.cc || []).map((e) => videoOf(e.newest)), { rank: R.cc, kind: 'cc' });
    }
    const pinned = [];
    for (const p of pins()) {
      if (p.kind !== 'entity' && !(p.kind === 'place' && (p.what === 'sequence' || p.what === 'tier'))) continue;
      if (!folderById(p.projectId)) continue;
      const cat = catalogues.get(p.projectId);
      if (!cat) {
        loadCatalogue(p.projectId);
        continue;
      }
      const tier = p.what === 'tier' && (/\/t\/([\w-]+)$/.exec(p.href) || [])[1];
      const of = p.kind === 'entity' ? cat.entities.filter((e) => e.id === p.id)
        : p.what === 'sequence' ? cat.entities.filter((e) => e.tier === 'shot' && N.seqOf(e.name) === p.name)
          : cat.entities.filter((e) => e.tier === tier);
      pinned.push(...of.slice().sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0)).slice(0, 40).map((e) => videoOf(e.newest)));
    }
    WB.media.want('pinned', pinned, { rank: R.pinned, kind: 'pinned' });
  }
  // What the page shows: every video card that can be scrubbed, in the order they are made. The cards of
  // one go (one render) make the list; the next go makes it afresh.
  let pageSrcs = null;
  function keepForPage(src, name) {
    if (!pageSrcs) {
      pageSrcs = [];
      queueMicrotask(() => {
        WB.media.want('page', pageSrcs.slice(0, 60).map((x) => x.src), { rank: WB.media.RANK.page, hold: true });
        pageScope = { label: 'this page', items: pageSrcs };
        pageSrcs = null;
        cacheRing.paint();
      });
    }
    pageSrcs.push({ src, name });
  }

  // The ring in the bar: how much of what you are looking at (the timeline, or the page's cards) is cached.
  let pageScope = null;
  let tlScope = null;
  let runOf = null; // the project whose timeline is open
  const cacheRing = (() => {
    const button = el('button', { id: 'kept', class: 'kept-ring', hidden: true });
    document.querySelector('.home-head .bellwrap').before(button);
    return WB.media.ring(button, () => (runOf && tlScope) || pageScope);
  })();
  // The feed is fetched now and then wherever you are, so what is new is kept before you look.
  setInterval(() => { if (!document.hidden) loadFeed(); }, 5 * 60 * 1000);
  // What came since you last marked Updates read, kept by this browser.
  const feedSeen = () => Number(store('wb:feed:seen')) || 0;
  let feedShow = store('wb:feed:show') || 'all'; // all | notes | versions
  let feedMore = false;

  function feedRow(item, seen) {
    const thing = el('strong', { text: item.version.label || item.entity.name });
    const what = item.kind === 'version'
      ? [el('strong', { text: item.by || 'Somebody' }), ' filed ', thing]
      : [el('strong', { text: item.mine ? 'You' : item.by || 'Somebody' }), item.note.reply ? ' replied on ' : ' commented on ', thing];
    const why = item.entity.role === 'cc' ? 'you are cc\'d' : item.entity.role ? 'your work' : null;
    const where = [item.entity.role !== undefined && item.entity.project, why, ago(item.at)].filter(Boolean).join(' · ');
    const fresh = item.at > seen && !item.mine;
    return el('button', {
      type: 'button', class: `feed-row ${item.kind}${fresh ? ' unread' : ''}${item.mine ? ' mine' : ''}`, title: 'Open it, to look, comment and draw',
      onclick: () => lookAt(item.entity.id, item.version.id),
    },
    item.kind === 'version'
      ? el('span', { class: 'feed-thumb' }, item.version.thumb && el('img', { src: item.version.thumb, alt: '', loading: 'lazy' }))
      : WB.avatar(item.by, item.color),
    el('span', { class: 'feed-body' },
      el('span', { class: 'feed-what' }, ...what),
      item.note && el('span', { class: 'feed-text', text: item.note.text }),
      el('span', { class: 'feed-where', text: where })),
    fresh && el('span', { class: 'feed-dot', role: 'img', 'aria-label': 'New' }));
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

  const versionLists = new Map(); // project id -> { key: how it was asked for, data: the list as last fetched }
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

  // ---- a project's Versions: every version filed, as it is asked for
  //
  // Newest filed first, by day and by who filed them, unless asked otherwise: grouped by sequence, by
  // asset, set or shot, by task, by who filed them, or not at all; sorted by when they were filed, by name
  // or by number; narrowed to some tasks, sequences, kinds (assets, sets, shots), people, artists, a time,
  // the newest of each, or with what is archived. The search box searches them all, on the server: the
  // name, the task, the artist, who filed it, the file's own name, "v12". How it is asked for is kept per
  // project in this browser.
  const VL_GROUPS = [['time', 'Upload time'], ['seq', 'Sequence'], ['entity', 'Asset, set or shot'], ['task', 'Task'], ['by', 'Who filed'], ['none', 'Nothing']];
  const VL_SORTS = [['new', 'Newest filed'], ['old', 'Oldest filed'], ['name', 'Name'], ['number', 'Version number']];
  const VL_WHEN = [['', 'Any time'], ['day', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days']];
  const VL_FILTERS = [['task', 'Task'], ['seq', 'Sequence'], ['tier', 'Kind'], ['by', 'Filed by'], ['artist', 'Artist']];
  const vlDefault = () => ({ group: 'time', sort: 'new', when: '', newest: false, archived: false, task: [], seq: [], tier: [], by: [], artist: [] });
  function vlState(project) {
    const key = `wb:vl:${project.id}`;
    return { ...vlDefault(), ...(store(key) || {}) };
  }
  const vlSave = (project, state) => store(`wb:vl:${project.id}`, state);
  const vlFiltered = (st) => VL_FILTERS.some(([k]) => st[k].length) || st.when || st.newest || st.archived;
  // What the server is asked: the page's state and the search, from `offset`.
  function vlQuery(st, offset = 0) {
    const since = { day: dayOf(Date.now()), week: Date.now() - 7 * 864e5, month: Date.now() - 30 * 864e5 }[st.when] || 0;
    const p = new URLSearchParams({ find: '1', sort: st.sort, offset: String(offset) });
    for (const [k] of VL_FILTERS) if (st[k].length) p.set(k, st[k].join(','));
    if (since) p.set('since', String(since));
    if (st.newest) p.set('newest', '1');
    if (st.archived) p.set('archived', '1');
    const q = $('q').value.trim();
    if (q) p.set('q', q);
    return p.toString();
  }

  async function versionsPage(project, fresh, sig) {
    const st = vlState(project);
    const key = vlQuery(st);
    const show = (data) => {
      if (shownProject !== sig) return;
      $('content').replaceChildren(...versionsView(project, data, st));
      paintVersionPick(project);
    };
    const had = versionLists.get(project.id);
    if (had && had.key === key) show(had.data);
    else if (fresh || !had) $('content').replaceChildren(...versionsTools(project, st, null), el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      const data = await api('GET', `/api/projects/${project.id}/versions?${key}`);
      // Pages further down already shown stay shown when the first is fetched again.
      const keep = had && had.key === key && had.data.versions.length > data.versions.length ? had.data : null;
      const fresh1 = new Set(data.versions.map((v) => v.id));
      const now = keep ? { ...data, versions: [...data.versions, ...keep.versions.slice(data.versions.length).filter((v) => !fresh1.has(v.id))], more: keep.more } : data;
      if (vlQuery(vlState(project)) !== key) return;
      versionLists.set(project.id, { key, data: now });
      if (!had || had.key !== key || JSON.stringify(had.data) !== JSON.stringify(now)) show(now);
    } catch (err) {
      pageFailed(sig, err);
    }
  }

  // A menu of things to tick (each filter's): it stays open while ticking, and closes with a click away.
  // A panel under a button of the Versions bar, painted afresh by `build()` on each change, until a click
  // elsewhere or Escape. The page under it is drawn again as it changes, so the panel keeps its own place.
  function vlPanel(anchor, build, cls = '') {
    document.querySelector('.vl-pop')?.remove();
    const pop = el('div', { class: `vl-pop${cls ? ` ${cls}` : ''}`, role: 'dialog' });
    const paint = () => pop.replaceChildren(...build(paint));
    paint();
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)))}px`;
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    const close = () => {
      pop.remove();
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', esc, true);
    };
    const away = (e) => { if (!pop.contains(e.target) && !e.target.closest('.vl-open')) close(); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(() => {
      document.addEventListener('pointerdown', away, true);
      document.addEventListener('keydown', esc, true);
    });
  }

  // The bar over the list: two buttons, View (how it is grouped and sorted) and Filter (what narrows it),
  // the filters in force as chips, each taken off with its ×, and how many there are.
  function versionsTools(project, st, data) {
    const set = (patch) => {
      Object.assign(st, patch);
      vlSave(project, { ...st });
      render();
    };
    const facets = (data && data.facets) || ((versionLists.get(project.id) || {}).data || {}).facets || null;
    const options = (k) => {
      const f = facets || {};
      if (k === 'task') return [...(f.untasked ? [['', 'No task']] : []), ...(f.tasks || []).map((t) => [t, t])];
      if (k === 'seq') return (f.seqs || []).map((q) => [q, q]);
      if (k === 'tier') return (f.tiers || []).map((t) => [t.id, t.label]);
      if (k === 'by') return (f.filers || []).map((n) => [n, n]);
      return (f.artists || []).map((n) => [n, n]);
    };
    const labelOf = (k, v) => (options(k).find(([x]) => x === v) || [, v || 'No task'])[1];
    const choice = (name, list, value, on) => list.map(([v, t]) => el('label', { class: 'vl-tick' },
      el('input', { type: 'radio', name, ...(v === value && { checked: true }), onchange: () => on(v) }), el('span', { text: t })));
    const tick = (on, label, change) => el('label', { class: 'vl-tick' },
      el('input', { type: 'checkbox', ...(on && { checked: true }), onchange: (e) => change(e.target.checked) }), el('span', { text: label }));
    const section = (title, ...rows) => el('div', { class: 'vl-sec' }, el('b', { text: title }), ...rows);

    const groupName = st.group === 'none' ? 'Not grouped' : `By ${(VL_GROUPS.find(([g]) => g === st.group) || VL_GROUPS[0])[1].toLowerCase()}`;
    const view = el('button', {
      type: 'button', class: 'btn small ghost vl-open', html: `${icon('rows', 14)}<span>${groupName}</span>`, title: 'Group and sort', 'aria-haspopup': 'dialog',
      onclick: (e) => vlPanel(e.currentTarget, () => [
        section('Group by', ...choice('vl-group', VL_GROUPS, st.group, (v) => set({ group: v }))),
        section('Sort', ...choice('vl-sort', VL_SORTS, st.sort, (v) => set({ sort: v }))),
      ]),
    });
    const count = VL_FILTERS.filter(([k]) => st[k].length).length + (st.when ? 1 : 0) + (st.newest ? 1 : 0) + (st.archived ? 1 : 0);
    const filter = el('button', {
      type: 'button', class: `btn small ghost vl-open${count ? ' on' : ''}`, html: `${icon('filter', 14)}<span>Filter${count ? ` · ${count}` : ''}</span>`, 'aria-haspopup': 'dialog',
      onclick: (e) => vlPanel(e.currentTarget, (repaint) => [
        section('Show', tick(st.newest, 'Newest of each only', (on) => { set({ newest: on }); repaint(); }),
          tick(st.archived, 'Archived too', (on) => { set({ archived: on }); repaint(); })),
        section('Filed', ...choice('vl-when', VL_WHEN, st.when, (v) => { set({ when: v }); repaint(); })),
        ...VL_FILTERS.filter(([k]) => options(k).length || st[k].length).map(([k, title]) => section(title,
          ...options(k).map(([v, t]) => tick(st[k].includes(v), t, (on) => {
            set({ [k]: on ? [...st[k], v] : st[k].filter((x) => x !== v) });
            repaint();
          })))),
      ], 'vl-pop-filter'),
    });
    // What narrows it now, each a chip.
    const chip = (text, off) => el('span', { class: 'vl-chip' }, el('span', { text }),
      el('button', { type: 'button', class: 'vl-chip-x', html: icon('close', 12), title: `Take off ${text}`, 'aria-label': `Take off ${text}`, onclick: off }));
    const chips = [
      ...VL_FILTERS.filter(([k]) => st[k].length).map(([k, title]) => chip(`${title}: ${st[k].map((v) => labelOf(k, v)).join(', ')}`, () => set({ [k]: [] }))),
      st.when && chip((VL_WHEN.find(([w]) => w === st.when) || [])[1], () => set({ when: '' })),
      st.newest && chip('Newest only', () => set({ newest: false })),
      st.archived && chip('Archived too', () => set({ archived: false })),
    ].filter(Boolean);
    const total = data ? data.total : null;
    return [el('div', { class: 'vl-tools' }, view, filter, ...chips,
      el('span', { class: 'imp-gap' }),
      total != null && el('span', { class: 'vl-total', text: plural(total, 'version') }))];
  }

  // The groups the list is shown in, each { key, title, sub, list }, in the order they come.
  function versionGroups(list, st, tierName) {
    if (st.group === 'time') {
      // By day; within a day, by who filed them (whoever filed last first), however their filing was
      // interleaved with others'.
      const days = [];
      for (const v of list) {
        const day = dayOf(v.createdAt);
        let d = days[days.length - 1];
        if (!d || d.day !== day) days.push(d = { day, runs: [] });
        const by = v.createdBy || '';
        let r = d.runs.find((x) => x.by === by);
        if (!r) d.runs.push(r = { by, list: [] });
        r.list.push(v);
      }
      return days.map((d) => ({ key: `d${d.day}`, title: dayName(d.day), runs: d.runs }));
    }
    const keyOf = {
      seq: (v) => (v.tier === 'shot' && N.seqOf(v.entity)) || `${tierName(v.tier)}s`,
      entity: (v) => v.entity,
      task: (v) => v.task || 'No task',
      by: (v) => v.createdBy || 'Somebody',
      none: () => '',
    }[st.group] || (() => '');
    const groups = new Map();
    for (const v of list) {
      const k = keyOf(v);
      if (!groups.has(k)) groups.set(k, { key: `g${k}`, title: k, list: [] });
      groups.get(k).list.push(v);
    }
    return [...groups.values()];
  }

  function versionsView(project, data, st = vlState(project)) {
    const list = data.versions;
    if (vpick.project !== project.id) {
      dropVersionPick();
      vpick.project = project.id;
    }
    const cat = catalogues.get(project.id);
    const tierName = (id) => {
      const t = cat && cat.tiers.find((x) => x.id === id);
      const word = t ? t.one : id || '';
      return word.charAt(0).toUpperCase() + word.slice(1);
    };
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
    const grid = (vs) => el('div', { class: 'board-grid ent-grid vl-grid' }, vs.map((v) => versionCard(project, { id: v.entityId, name: v.entity, tier: v.tier }, v, { list: true, tierName })));
    const groups = versionGroups(list, st, tierName);
    // Shift and a click picks a run as it is shown.
    vpick.order = groups.flatMap((g) => (g.runs ? g.runs.flatMap((r) => r.list) : g.list).map((v) => v.id));
    const out = [...versionsTools(project, st, data)];
    for (const g of groups) {
      if (g.runs) {
        const ids = g.runs.flatMap((r) => r.list.map((v) => v.id));
        out.push(el('div', { class: 'vl-day' }, box(ids, `Select everything filed ${g.title.toLowerCase()}`), el('b', { text: g.title }), el('span', { class: 'tally', text: String(ids.length) })));
        for (const r of g.runs) {
          const runIds = r.list.map((v) => v.id);
          // The time of each is on its row; the heading gives the span only when there is one.
          const [from, to] = [clock(r.list[r.list.length - 1].createdAt), clock(r.list[0].createdAt)];
          const span = r.list.length > 1 ? ` · ${from === to ? from : `${from} – ${to}`}` : '';
          out.push(el('div', { class: 'vl-run' },
            el('div', { class: 'vl-runhead' }, box(runIds, `Select what ${r.by || 'somebody'} filed then`),
              WB.avatar(r.by),
              el('b', { text: r.by || 'Somebody' }), el('span', { text: `${plural(r.list.length, 'version')}${span}` })),
            grid(r.list)));
        }
        continue;
      }
      const ids = g.list.map((v) => v.id);
      if (st.group !== 'none') out.push(el('div', { class: 'vl-day' }, box(ids, `Select all of ${g.title}`), st.group === 'by' ? WB.avatar(g.title) : null, el('b', { text: g.title }), el('span', { class: 'tally', text: String(ids.length) })));
      out.push(el('div', { class: 'vl-run' }, grid(g.list)));
    }
    const q = $('q').value.trim();
    if (!list.length) {
      out.push(el('p', { class: 'home-empty', text: q ? `No version matches "${q}"${vlFiltered(st) ? ' with these filters' : ''}.` : vlFiltered(st) ? 'No version is like that.' : 'Nothing is filed in this project yet.' }));
    }
    // A page at a time: more are fetched when asked for, after the ones shown.
    if (data.more) {
      out.push(el('button', {
        type: 'button', class: 'feed-more', text: `Show more (${(data.total - list.length).toLocaleString()} to go)`,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const key = vlQuery(st);
            const next = await api('GET', `/api/projects/${project.id}/versions?${vlQuery(st, list.length)}`);
            const merged = { ...data, versions: [...list, ...next.versions], more: next.more };
            versionLists.set(project.id, { key, data: merged });
            $('content').replaceChildren(...versionsView(project, merged, st));
            paintVersionPick(project);
          } catch (err) {
            fail(err);
          }
        },
      }));
    }
    return out;
  }

  function paintVersionPick(project) {
    for (const node of document.querySelectorAll('.card.ver[data-id]')) node.classList.toggle('picked', vpick.ids.has(node.dataset.id));
    for (const b of document.querySelectorAll('.vl-box[data-ids]')) {
      const ids = b.dataset.ids.split(' ');
      const n = ids.filter((id) => vpick.ids.has(id)).length;
      b.classList.toggle('on', n === ids.length);
      b.classList.toggle('some', n > 0 && n < ids.length);
    }
    const n = vpick.ids.size;
    document.body.classList.toggle('vpicking', n > 0);
    if (!n) return void $('vpickbar')?.remove();
    const bar = pickBar('vpickbar', 'Selected versions', {
      clear: () => { vpick.ids.clear(); paintVersionPick(project); },
      actions: [
        el('button', { type: 'button', class: 'btn small', text: 'Edit…', title: 'Move them, give them a task or an artist, or archive them, all at once', onclick: () => editVersions(project) }),
        el('button', { type: 'button', class: 'btn small', text: 'Add to board', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); addToBoardMenu(project, e.currentTarget); } }),
        el('button', { type: 'button', class: 'btn small primary', text: 'New board', title: 'A new board in this project, with these on it', onclick: () => newBoardWith(project) }),
      ],
    });
    const seen = new Set(vpick.order);
    const shown = [...vpick.ids].filter((id) => seen.has(id)).length;
    countPicked(bar, shown, n - shown, 'versions');
  }

  // Many versions changed at once (the Versions page's selection): moved to another asset, set or shot,
  // given a task or none, an artist or none, archived or brought back. Each field leaves them as they are
  // unless it says otherwise. Those moved to one place go in the order they were filed, each the next
  // number there. All of it or none (PATCH /api/projects/:id/versions); Undo puts each back as it was,
  // number and all.
  async function editVersions(project) {
    const shown = ((versionLists.get(project.id) || {}).data || { versions: [] }).versions;
    const chosen = shown.filter((v) => vpick.ids.has(v.id)).sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
    if (!chosen.length) return;
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`);
    catalogues.set(project.id, cat);
    const useTasks = !(cat.project && cat.project.settings && cat.project.settings.tasks === false);
    const tally = (pick) => {
      const count = new Map();
      for (const v of chosen) count.set(pick(v), (count.get(pick(v)) || 0) + 1);
      return [...count].sort((a, b) => b[1] - a[1]).map(([n, k]) => (count.size === 1 ? n : `${n} (${k})`)).slice(0, 6).join(', ');
    };
    // A field: what to do (leave, or each way of changing it), and a box for the value when one is needed.
    const field = (label, now, ways, input) => {
      const how = el('select', { class: 'be-how', 'aria-label': `${label}: what to do` }, ways.map(([v, t]) => el('option', { value: v, text: t })));
      const sync = () => { if (input) input.hidden = how.value !== 'set'; };
      how.addEventListener('change', () => { sync(); if (how.value === 'set' && input) input.focus(); });
      sync();
      return {
        node: el('div', { class: 'be-row' }, el('span', { class: 'be-label', text: label }),
          el('div', { class: 'be-field' }, el('div', { class: 'be-now', text: `Now: ${now}` }), el('div', { class: 'be-ctl' }, how, input))),
        how,
      };
    };
    const entIn = el('input', { type: 'text', class: 'be-in', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': 'Move them to' });
    WB.combo(entIn, WBFiling.entitySource(() => cat.entities));
    const taskIn = el('input', { type: 'text', class: 'be-in', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Their task' });
    WB.combo(taskIn, WBFiling.taskSource(() => cat.tasks));
    const artistIn = el('input', { type: 'text', class: 'be-in', placeholder: 'Artist', spellcheck: 'false', 'aria-label': 'Their artist' });
    WB.combo(artistIn, WBFiling.taskSource(() => cat.artists || []));
    const ent = field('Where', tally((v) => v.entity), [['', 'Leave where they are'], ['set', 'Move them to']], entIn);
    const task = useTasks && field('Task', tally((v) => v.task || 'none'), [['', 'Leave as they are'], ['set', 'Set to'], ['none', 'Take it off']], taskIn);
    const artist = field('Artist', tally((v) => v.artist || 'none'), [['', 'Leave as they are'], ['set', 'Set to'], ['none', 'Take it off']], artistIn);
    const archived = chosen.filter((v) => v.hidden).length;
    const hide = field('Archived', archived ? `${archived} of ${chosen.length}` : 'none of them', [['', 'Leave as they are'], ['archive', 'Archive them'], ['back', 'Bring them back']], null);
    const error = el('p', { class: 've-error', hidden: true });
    const save = el('button', { type: 'submit', class: 'btn primary', text: `Change ${plural(chosen.length, 'version')}` });
    const names = chosen.map((v) => v.label);
    const dlg = el('dialog', { class: 'dlg be' },
      el('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          const to = N.tokenize(entIn.value);
          if (ent.how.value === 'set' && !to) return entIn.focus();
          const have = cat.entities.find((x) => x.name === to);
          const edits = chosen.map((v) => ({
            id: v.id,
            ...(ent.how.value === 'set' && { entity: have ? have.id : { name: to, tier: N.kindOf(to, cat.entities) || 'asset' } }),
            ...(task && task.how.value === 'set' && { task: taskIn.value }), ...(task && task.how.value === 'none' && { task: null }),
            ...(artist.how.value === 'set' && { artist: artistIn.value }), ...(artist.how.value === 'none' && { artist: null }),
            ...(hide.how.value && { hidden: hide.how.value === 'archive' }),
          }));
          if (!edits.some((x) => Object.keys(x).length > 1)) return dlg.close();
          save.disabled = true;
          try {
            await api('PATCH', `/api/projects/${project.id}/versions`, { edits, by: me.name });
            dlg.close();
            catalogues.delete(project.id);
            versionLists.delete(project.id);
            render();
            // Each back as it was: where, its task and number, its artist, archived or not.
            const before = chosen.map((v) => ({ id: v.id, entity: v.entityId, task: v.task, number: v.number, artist: v.artist, hidden: !!v.hidden }));
            undoable(`Changed ${plural(chosen.length, 'version')}`, async () => {
              await api('PATCH', `/api/projects/${project.id}/versions`, { edits: before, by: me.name });
              catalogues.delete(project.id);
              versionLists.delete(project.id);
              render();
            });
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      el('h2', { text: chosen.length === 1 ? `Edit ${names[0]}` : `Edit ${chosen.length} versions` }),
      el('p', { class: 'be-which', text: names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ') }),
      ent.node, task && task.node, artist.node, hide.node,
      el('p', { class: 'be-note', text: 'Moved, each gets the next number where it goes, in the order they were filed. Their notes, and every board they are on, go with them.' }),
      error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
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
    undoable(`${plural(res.placed.length, 'version')} put on ${board.name}`, null, { label: 'Open board', href: WB.href.board(board.id) });
  }

  async function newBoardWith(project) {
    const ids = vpick.order.filter((id) => vpick.ids.has(id));
    if (!ids.length) return;
    const name = await WB.dialog({ title: 'New board', text: `With the ${plural(ids.length, 'version')} you picked on it.`, value: `Review ${new Date().toLocaleDateString()}`, placeholder: 'Board name', ok: 'Create board' });
    if (!name) return;
    try {
      const board = await api('POST', '/api/boards', { name, folderId: project.id, workspace: project.workspace, by: me.name });
      // A new board starts laid out as the edit is: a column for each sequence, its shots going down.
      await api('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: ids, layout: 'sequences', by: me.name });
      location.href = WB.href.board(board.id);
    } catch (err) {
      fail(err);
    }
  }

  // ------------------------------------------------------------- boards and folders, many at once
  //
  // Boxed in a folder or a workspace: moved together to another folder, or (boards) deleted together.
  const bpick = new Set(); // 'board:<id>' | 'folder:<id>'
  // ---- what is selected, wherever things can be: one bar at the foot of the page, the same everywhere.
  // Its count says how many are selected and, when a search hides some of them, that those are left out:
  // what the buttons do is done to what can be seen.
  function pickBar(id, label, { clear, done, actions = [] }) {
    let bar = $(id);
    if (!bar) {
      bar = el('div', { id, class: 'pick-bar', role: 'toolbar', 'aria-label': label },
        el('span', { class: 'pick-count', 'aria-live': 'polite' }),
        clear && el('button', { type: 'button', class: 'btn small ghost pick-clear', text: 'Clear', onclick: clear }),
        el('span', { class: 'pick-gap' }),
        done && el('button', { type: 'button', class: 'btn small', text: 'Done', title: 'Stop selecting (Esc)', onclick: done }),
        ...actions);
      document.body.append(bar);
    }
    return bar;
  }
  function countPicked(bar, n, hidden, what) {
    bar.querySelector('.pick-count').textContent = !n ? `Select ${what}`
      : `${n} selected${hidden ? ` · ${hidden} hidden by the search, left out` : ''}`;
  }
  // Which of the selected can be seen on the page now.
  const shownIds = (sel) => new Set([...document.querySelectorAll(sel)].map((n) => n.dataset.id || n.dataset.pick));

  // Boards and folders can be selected with the Select button (then a click selects), or by dragging a box.
  let bselecting = false;
  function setBoardSelecting(on) {
    bselecting = on;
    document.body.classList.toggle('bpicking', on);
    for (const b of document.querySelectorAll('.bpick-toggle')) b.classList.toggle('on', on);
    if (!on) dropBoardPick();
    else paintBoardPick();
  }
  function boardTools() {
    return el('div', { class: 'cat-tools board-tools' },
      el('button', { type: 'button', class: `btn bpick-toggle${bselecting ? ' on' : ''}`, html: `${ICON_CHECKS}<span>Select</span>`, title: 'Select boards and folders, to move or delete them together', onclick: () => setBoardSelecting(!bselecting) }));
  }
  // A click on a card while selecting selects it rather than opening it.
  document.addEventListener('click', (e) => {
    if (!bselecting || !(e.target instanceof Element)) return;
    const card = e.target.closest('.card[data-pick]');
    if (!card || e.target.closest('.card-menu')) return;
    e.preventDefault();
    const k = card.dataset.pick;
    if (bpick.has(k)) bpick.delete(k);
    else bpick.add(k);
    paintBoardPick();
  }, true);

  function dropBoardPick() {
    bpick.clear();
    if (!bselecting) $('bpickbar')?.remove();
    else paintBoardPick();
    for (const n of document.querySelectorAll('.card[data-pick].picked')) n.classList.remove('picked');
  }
  function paintBoardPick() {
    for (const n of document.querySelectorAll('.card[data-pick]')) n.classList.toggle('picked', bpick.has(n.dataset.pick));
    const n = bpick.size;
    if (!n && !bselecting) return void $('bpickbar')?.remove();
    const bar = pickBar('bpickbar', 'Selected boards and folders', {
      clear: () => { bpick.clear(); paintBoardPick(); },
      done: () => setBoardSelecting(false),
      actions: [
        el('button', { type: 'button', class: 'btn small pick-del', text: 'Delete…', onclick: () => deletePicked().catch(fail) }),
        el('button', { type: 'button', class: 'btn small primary pick-move', text: 'Move to…', onclick: () => movePicked().catch(fail) }),
      ],
    });
    const boardsN = [...bpick].filter((k) => k.startsWith('board:')).length;
    const foldersN = n - boardsN;
    bar.querySelector('.pick-count').textContent = n ? `${[boardsN && plural(boardsN, 'board'), foldersN && plural(foldersN, 'folder')].filter(Boolean).join(' and ')} selected` : 'Select boards and folders';
    bar.querySelector('.pick-del').hidden = !boardsN;
    bar.querySelector('.pick-move').disabled = !n;
    bar.querySelector('.pick-clear').hidden = !n;
  }
  async function movePicked() {
    const ids = [...bpick].map((k) => k.split(':'));
    const target = await pickFolder({ title: `Move ${plural(ids.length, 'item')} to`, exclude: ids.length === 1 && ids[0][0] === 'folder' ? ids[0][1] : null, current: currentFolder() });
    if (target === undefined) return;
    const failed = [];
    for (const [kind, id] of ids) {
      if (kind === 'folder' && (id === target || (target && isWithin(target, id)))) continue;
      try {
        if (kind === 'board') await api('PATCH', `/api/boards/${id}`, { folderId: target });
        else await api('PATCH', `/api/folders/${id}`, { parentId: target });
      } catch (err) {
        failed.push(err.message);
      }
    }
    dropBoardPick();
    await refresh();
    tellFailed('moved', ids.length, failed);
  }
  // Many things done at once go on past one that could not be, and say at the end which could not.
  function tellFailed(done, total, failed) {
    if (!failed.length) return;
    WB.dialog({
      title: `${failed.length} of ${total} could not be ${done}`,
      text: [...new Set(failed)].slice(0, 3).join(' '),
      ok: 'OK', cancellable: false,
    });
  }
  async function deletePicked() {
    const ids = [...bpick].filter((k) => k.startsWith('board:')).map((k) => k.slice(6));
    const sure = await WB.dialog({ title: `Delete ${plural(ids.length, 'board')}?`, text: 'They disappear for everyone. The server keeps them hidden, so whoever runs the server can still restore them. Folders are left as they are.', ok: 'Delete', danger: true });
    if (!sure) return;
    const failed = [];
    for (const id of ids) {
      try {
        await api('DELETE', `/api/boards/${id}`);
      } catch (err) {
        failed.push(err.message);
      }
    }
    dropBoardPick();
    await refresh();
    tellFailed('deleted', ids.length, failed);
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
    if (v.page === 'versions') return { project: f, sel: '.card.ver[data-id]', kind: 'vers' };
    return null;
  }
  let marquee = null;
  // Anywhere on the page counts, the margins and the space under the content too: all but the bars, the
  // sidebar, dialogs, menus and the player.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (!(e.target instanceof Element) || e.target.closest('.home-bar, .side, .side-scrim, .viewer, .menu, .combo-list, #toasts, .notices')) return;
    if (document.querySelector('dialog[open]') || (document.querySelector('.viewer') && !document.querySelector('.viewer').hidden)) return;
    if (e.target.closest('a, button, input, select, textarea, label, .card, .imp, .cat-tools, .ent-people, .pick-bar, #crumbs, dialog')) return;
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
  // runOf: the project whose timeline is open (declared with the cache ring, which asks for it).
  async function openTimeline(project) {
    runOf = project.id;
    const key = project.id;
    let seq = store(`wb:tl:seq:${key}`) || '';
    let task = store('wb:tl:task') || '';
    let withEmpty = store('wb:tl:empty') !== false;
    // Which view of each shot (cmp, bty...), kept per project and shared with its catalogue's player. In 3D,
    // the one the project puts on its model.
    let view = store(`wb:view:${key}`) || '';
    const preview3d = project.settings && project.settings.preview3d;
    let in3d = false;
    let data = null;
    let reloadRun = () => {};
    const load = async () => {
      data = await api('GET', `/api/projects/${project.id}/timeline${task ? `?task=${encodeURIComponent(task)}` : ''}`);
      if (seq && !data.shots.some((x) => x.seq === seq)) seq = '';
      if (!data.shots.length) return [];
      if (!view) view = WBViewer.usualView(data);
      const pieces = await WBViewer.runPieces(data, { seq, task, withEmpty, view: in3d ? preview3d.view : view });
      // All of it is cached, after the next few shots the player asks for first; the ring says how far.
      const videos = pieces.filter((x) => x.type === 'video' && !x.empty);
      for (const x of videos) if (!x.lo) needsPhoneCopy.add(x.full);
      phoneCopies.poke();
      tlScope = { label: 'this timeline', items: videos.map((x) => ({ src: x.src, name: x.label })) };
      WB.media.want('timeline', tlScope.items.map((x) => x.src), { rank: WB.media.RANK.timeline, hold: true });
      cacheRing.paint();
      return pieces;
    };
    try {
      await WBViewer.openRun(thePlayer(), {
        load, me, dock: true,
        // What it is, for somebody presenting it (present.js).
        scene: () => ({ k: 'run', seq, task, empty: withEmpty, view: in3d ? '' : view }),
        ...(preview3d && preview3d.model && {
          view3d: { ...preview3d, key: project.id },
          onMode3d: (on) => { in3d = on; reloadRun({ keep: true }); },
        }),
        title: () => `${project.name} · Timeline`,
        // What the run is, all in one button (viewer.js optionsButton): which sequence, the newest of which
        // task, whether shots with nothing filed are there as slates, and which view. Only what is a choice
        // in this project is offered: a task, say, only where there are two to choose between.
        choices: (reload) => {
          reloadRun = reload;
          const opts = WBViewer.optionsButton(() => {
            const seqs = [...new Set(data.shots.map((x) => x.seq).filter(Boolean))];
            const untasked = data.shots.some((x) => x.version && !x.version.task);
            const tasks = task || data.tasks.length > 1 || (data.tasks.length === 1 && untasked) ? data.tasks : [];
            const emptyShots = !withEmpty || data.shots.some((x) => !x.version);
            const views = data.shots.some((x) => x.version && (x.version.look.views || []).length)
              ? [...(data.shots.some((x) => x.version && !x.version.look.view) ? [''] : []), ...data.views] : [];
            return [
              { name: 'Sequence', value: seq, def: '', options: seqs.length > 1 || seq ? [['', 'All sequences'], ...seqs.map((x) => [x, x])] : [], pick: (v) => { seq = v; store(`wb:tl:seq:${key}`, v); reload(); } },
              { name: 'Task', value: task, def: '', options: tasks.length ? [['', 'Newest of any task'], ...tasks.map((x) => [x, `Newest ${x}`])] : [], pick: (v) => { task = v; store('wb:tl:task', v); reload(); } },
              { name: 'Shots', value: withEmpty ? 'all' : 'filed', def: 'all', options: emptyShots ? [['all', 'All shots, a slate where nothing is filed'], ['filed', 'Only shots with something filed']] : [], pick: (v) => { withEmpty = v === 'all'; store('wb:tl:empty', withEmpty); reload(); } },
              // In 3D the view is the one the project puts on its model, so there is none to choose.
              ...(views.length > 1 && !in3d ? [WBViewer.viewGroup(views, view, (v) => { view = v; store(`wb:view:${key}`, v); reload({ keep: true }); }, project.settings && Array.isArray(project.settings.views) ? project.settings.views : null)] : []),
            ];
          }, { title: 'What the timeline plays' });
          return [opts];
        },
        onClose: () => {
          runOf = null;
          tlScope = null;
          WB.media.want('timeline', []);
          cacheRing.paint();
          if (currentView().page === 'timeline' && currentFolder() === project.id) location.hash = WB.href.folder(project.id);
        },
      });
    } catch (err) {
      runOf = null;
      tlFailed = project.id;
      $('content').replaceChildren(el('p', { class: 'home-empty', text: `${err.message}. File versions of the project's shots, and they play here in order.` }));
    }
  }

  let renderedFor = null;
  function render() {
    const rt = route();
    if (renderedFor !== location.hash) {
      // A link to a folder or project that is not there any more says so, rather than landing quietly
      // somewhere else.
      const asked = /^#\/f\/([\w-]+)/.exec(location.hash);
      if (asked && libraryLoaded && !folderById(asked[1])) WB.toast('That folder or project is not there any more, or is not shared with you.', { ms: 6000 });
      // Somewhere new: a search typed for the last page does not carry over to this one.
      if (renderedFor !== null && !searching) $('q').value = '';
      renderedFor = location.hash;
      tlFailed = null;
      // Going elsewhere from the sidebar or the bar closes a player docked beside them.
      if (lookingAt && player && player.isOpen()) {
        lookingAt = null;
        player.close();
      }
      // What was selected belongs to the page it was selected on: never carried, unseen, to another.
      if (bselecting) setBoardSelecting(false);
      else if (bpick.size) dropBoardPick();
      WB.media.want('page', []);
      pageScope = null;
      cacheRing.paint();
    }
    // The timeline is docked beside the sidebar: going elsewhere from it (the sidebar, the bar) closes it.
    if (runOf && !(rt.kind === 'folder' && rt.id === runOf && currentView().page === 'timeline') && thePlayer().isOpen()) {
      runOf = null;
      thePlayer().close();
    }
    if (vpick.project && (rt.kind !== 'folder' || rt.id !== vpick.project || !(currentView().page === 'versions' || currentView().entity))) dropVersionPick();
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
    renderSide(rt);
    renderCrumbs(rt);

    const cur = rt.kind === 'folder' ? rt.id : null;
    const here = cur && folderById(cur);
    const view = here && here.project ? currentView() : { page: 'boards' };
    // The search says what it searches here, and the bar offers only what can be made here: boards and
    // folders where boards and folders are listed, not over a catalogue or a list of versions.
    const inProjectHere = !!(here && here.project);
    $('q').placeholder = {
      catalogue: view.entity ? 'Search the catalogue' : 'Search the catalogue',
      versions: 'Search versions, or who filed them',
      timeline: 'Search is not used on the timeline',
      home: inProjectHere ? "Search this project's boards" : 'Search boards and folders',
      boards: inProjectHere ? "Search this project's boards" : 'Search boards and folders',
    }[view.page] || 'Search boards and folders';
    $('q').disabled = view.page === 'timeline';
    const makesBoards = rt.kind !== 'folder' || !inProjectHere || view.page === 'boards' || view.page === 'home';
    $('new').hidden = !makesBoards;
    // Present, in a project (and wherever you are while presenting, to get to the link and to stop).
    if (presentBtn) presentBtn.hidden = !(projectHere() || WBPresent.token());
    $('newfolder').hidden = !makesBoards;
    // Searching from a project's home looks through its boards.
    if (view.page === 'home' && $('q').value.trim()) view.page = 'boards';
    $('empty').hidden = true;
    if (rt.kind === 'home') return $('content').replaceChildren(...homeView());
    // A project has its boards and its catalogue.
    if (view.page !== 'boards') return renderProject(here, view);
    // A search looks through every folder of the workspace (of the project, inside one); without one you
    // see the folder you are in.
    const q = $('q').value.trim().toLowerCase();
    const matches = (name) => name.toLowerCase().includes(q);
    const within = (fid) => !inProjectHere || fid === cur || (fid && isWithin(fid, cur));
    const subs = q ? lib.folders.filter((f) => matches(f.name) && f.id !== cur && within(f.id)).sort(byName) : childrenOf(cur);
    const boards = q ? lib.boards.filter((b) => matches(b.name) && within(b.folderId)) : boardsIn(cur);
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    $('content').replaceChildren(...[
      !q && (subs.length > 0 || boards.length > 0) && boardTools(),
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

  // What went wrong loading a page, with a way to try again, shown only if that page is still the one up.
  function pageFailed(sig, err) {
    if (shownProject !== sig) return;
    $('content').replaceChildren(el('div', { class: 'home-empty' },
      el('p', { text: err.message || 'That did not load.' }),
      el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => { shownProject = ''; render(); } })));
  }
  // A search being typed narrows what is already loaded; nothing is fetched for it.
  let searching = false;
  let tlFailed = null; // the project whose timeline would not open, until you go elsewhere

  let shownProject = '';
  let shownEntity = null; // the asset, set or shot whose page is showing, for the crumbs before its catalogue is in
  async function renderProject(project, view) {
    // A project with a model of its venue: the player's 3D view is made ready as the project opens, so it is
    // there at once in the catalogue's player and on the timeline.
    const model = project.settings && project.settings.preview3d;
    if (model && model.model) thePlayer().prepare3d({ ...model, key: project.id });
    const sig = `${project.id}|${view.page}|${view.entity}`;
    const fresh = shownProject !== sig;
    shownProject = sig;
    if (view.page === 'versions') return versionsPage(project, fresh, sig);
    if (view.page === 'home') return projectHome(project, fresh, sig);
    if (view.page === 'timeline') {
      // The player plays it; the page behind says so. The background refresh of the library leaves it be,
      // and one that would not open is not tried again until you come back to it.
      if ((runOf === project.id && thePlayer().isOpen()) || tlFailed === project.id) return;
      $('content').replaceChildren(el('p', { class: 'home-empty', text: 'Opening the timeline…' }));
      openTimeline(project);
      return;
    }
    // What is being brought in shows above the catalogue, on its page and on each entity's.
    const tray = importer(project).tray;
    if (fresh && (view.entity || !catalogues.has(project.id))) $('content').replaceChildren(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      if (view.entity) {
        if (searching && !fresh) return;
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
      if (searching && catalogues.has(project.id)) return;
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
      pageFailed(sig, err);
    }
  }

  // ------------------------------------------------------------- a project's home
  //
  // Where a project opens: its parts (catalogue, boards, versions, timeline), what happened in it lately,
  // what was filed last, and the boards last worked on.

  const activities = new Map(); // project id -> { items, at }
  async function projectHome(project, fresh, sig) {
    const show = () => {
      if (shownProject !== sig) return;
      $('content').replaceChildren(...projectHomeView(project));
    };
    show();
    const act = activities.get(project.id);
    const stale = !act || Date.now() - act.at > 30000;
    if (!fresh && !stale && catalogues.has(project.id)) return;
    const [cat, activity] = await Promise.all([
      api('GET', `/api/projects/${project.id}`).catch(() => null),
      stale ? api('GET', `/api/projects/${project.id}/activity`).catch(() => null) : null,
    ]);
    if (cat) catalogues.set(project.id, cat);
    if (activity) activities.set(project.id, { items: activity.items, at: Date.now() });
    show();
    if (cat) renderSide(route());
  }

  // A project's home: how it is doing and what needs a look, not only the way to its parts. Its parts
  // along the top; this week at a glance (what was filed, said and moved, and by whom); what happened,
  // by day, each person's filing in one row ("Anna filed 23 versions", opened for the rest) and what was
  // said about a version in one; each sequence as a strip of its shots (filed this week, before, or not
  // yet); and what is waiting (set up with nothing filed, or quiet for two weeks).
  const homeOpen = new Set(); // groups of the activity opened, by key
  const WEEK = 7 * 864e5;
  function projectHomeView(project) {
    const label = (text, n, ...extra) => el('div', { class: 'section-label' }, text, n != null && el('span', { class: 'tally', text: String(n) }), ...extra);
    const cat = catalogues.get(project.id);
    const act = activities.get(project.id);
    const boards = boardsIn(project.id).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const counts = cat ? cat.tiers.map((t) => plural(cat.entities.filter((e) => e.tier === t.id).length, t.one)).join(' · ') : '…';
    const filed = cat ? cat.entities.filter((e) => e.latestAt) : [];
    const part = (icon, name, meta, href) => el('a', { class: 'card folder place', href },
      el('div', { class: 'folder-icon', html: icon }),
      el('div', { class: 'card-body' }, el('div', { class: 'card-name', text: name }), el('div', { class: 'card-meta', text: meta })));
    const parts = el('div', { class: 'folder-grid ph-parts' },
      part(ICON_CAT, 'Catalogue', counts, WB.href.catalogue(project.id)),
      part(ICON_BOARDS, 'Boards', plural(boards.length, 'board'), WB.href.boards(project.id)),
      part(ICON_LIST, 'Versions', cat ? plural(cat.entities.reduce((n, e) => n + (e.versions || 0), 0), 'version') : '…', WB.href.versions(project.id)),
      part(ICON_FILM, 'Timeline', 'Every shot, played through', WB.href.timeline(project.id)));
    const items = act ? act.items : null;
    const main = el('section', { class: 'home-main' },
      items && items.length ? homePulse(items) : null,
      label('Activity', null),
      !items ? el('p', { class: 'home-quiet', text: 'Loading…' })
        : items.length ? homeActivity(project, items)
          : el('p', { class: 'home-quiet', text: 'Nothing in the last two weeks. Versions filed and comments written in the project come here.' }));
    const latest = filed.sort((a, b) => b.latestAt - a.latestAt).slice(0, 4).map((e) => entityTile(project, e));
    const side = el('aside', { class: 'home-side' },
      cat && homeSequences(project, cat, label),
      cat && homeWaiting(project, cat, label),
      label('Latest filed', null, el('span', { class: 'label-gap' }), el('a', { class: 'btn small ghost', href: WB.href.versions(project.id), text: 'All versions' })),
      !cat ? el('p', { class: 'home-quiet', text: 'Loading…' })
        : latest.length ? el('div', { class: 'board-grid ent-grid home-work' }, latest)
          : el('p', { class: 'home-quiet', text: 'Nothing is filed yet. Drop images and videos on the catalogue to file them.' }),
      label('Recent boards', null, el('span', { class: 'label-gap' }), el('a', { class: 'btn small ghost', href: WB.href.boards(project.id), text: 'All boards' })),
      boards.length ? el('div', { class: 'board-grid home-work' }, boards.slice(0, 4).map(boardCard))
        : el('p', { class: 'home-quiet', text: 'No boards yet.' }));
    return [parts, el('div', { class: 'home-cols' }, main, side)];
  }

  // This week at a glance, beside the week before: versions filed, comments, how many assets, sets and
  // shots had something new, and who filed.
  function homePulse(items) {
    const now = Date.now();
    const thisWeek = items.filter((x) => now - x.at < WEEK);
    const lastWeek = items.filter((x) => now - x.at >= WEEK && now - x.at < 2 * WEEK);
    const n = (list, kind) => list.filter((x) => x.kind === kind).length;
    const versus = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(a - b)} on the week before` : a ? 'none the week before' : '');
    const moved = new Set(thisWeek.filter((x) => x.kind === 'version').map((x) => x.entity.id)).size;
    const who = new Map();
    for (const x of thisWeek) if (x.kind === 'version') who.set(x.by || 'Somebody', (who.get(x.by || 'Somebody') || 0) + 1);
    const tile = (value, name, sub) => el('div', { class: 'ph-stat' }, el('b', { text: value.toLocaleString() }), el('span', { text: name }), sub && el('small', { text: sub }));
    return el('div', { class: 'ph-pulse', role: 'group', 'aria-label': 'This week' },
      tile(n(thisWeek, 'version'), 'versions this week', versus(n(thisWeek, 'version'), n(lastWeek, 'version'))),
      tile(n(thisWeek, 'note'), 'comments', versus(n(thisWeek, 'note'), n(lastWeek, 'note'))),
      tile(moved, moved === 1 ? 'asset, set or shot moved on' : 'assets, sets and shots moved on'),
      el('div', { class: 'ph-stat ph-who' }, el('span', { text: 'Filed this week by' }),
        el('div', { class: 'ph-faces' }, who.size ? [...who].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, k]) => el('span', { class: 'ph-face', title: `${name}: ${plural(k, 'version')}` }, WB.avatar(name), el('small', { text: String(k) })))
          : el('small', { text: 'nobody yet' }))));
  }

  // What happened, by day. A person's filing that day is one row (their stills, what it was, opened for
  // each); what one person said about one version that day is one row; anything alone is as it was.
  function homeActivity(project, items) {
    const days = [];
    for (const x of items) {
      const day = dayOf(x.at);
      let d = days[days.length - 1];
      if (!d || d.day !== day) days.push(d = { day, groups: new Map() });
      const key = x.kind === 'version' ? `f:${x.by || ''}` : `n:${x.by || ''}:${x.version.id}`;
      if (!d.groups.has(key)) d.groups.set(key, { key: `${day}:${key}`, kind: x.kind, by: x.by, list: [] });
      d.groups.get(key).list.push(x);
    }
    const out = [];
    for (const d of days.slice(0, 14)) {
      out.push(el('div', { class: 'ph-day', text: dayName(d.day) }));
      const rows = [];
      for (const g of d.groups.values()) {
        if (g.list.length === 1) {
          rows.push(feedRow(g.list[0], Infinity));
          continue;
        }
        const open = homeOpen.has(g.key);
        const first = g.list[0];
        const span = (() => {
          const [a, b] = [clock(g.list[g.list.length - 1].at), clock(first.at)];
          return a === b ? a : `${a} – ${b}`;
        })();
        const names = [...new Set(g.list.map((x) => x.version.label))];
        const head = el('button', {
          type: 'button', class: `feed-row ph-group${open ? ' open' : ''}`, 'aria-expanded': String(open),
          onclick: () => {
            if (open) homeOpen.delete(g.key); else homeOpen.add(g.key);
            $('content').replaceChildren(...projectHomeView(project));
          },
        },
        g.kind === 'version'
          ? el('span', { class: 'ph-stills' }, g.list.slice(0, 4).map((x) => el('span', { class: 'feed-thumb' }, x.version.thumb && el('img', { src: x.version.thumb, alt: '', loading: 'lazy' }))))
          : WB.avatar(g.by, first.color),
        el('span', { class: 'feed-body' },
          el('span', { class: 'feed-what' }, ...(g.kind === 'version'
            ? [el('strong', { text: g.by || 'Somebody' }), ' filed ', el('strong', { text: plural(g.list.length, 'version') })]
            : [el('strong', { text: first.mine ? 'You' : g.by || 'Somebody' }), ` commented ${g.list.length} times on `, el('strong', { text: first.version.label })])),
          el('span', { class: 'feed-text', text: g.kind === 'version' ? `${names.slice(0, 4).join(', ')}${names.length > 4 ? ` and ${names.length - 4} more` : ''}` : first.note.text }),
          el('span', { class: 'feed-where', text: span })),
        el('span', { class: 'ph-chev', html: icon('chevron', 14) }));
        rows.push(head);
        if (open) rows.push(el('div', { class: 'ph-more' }, g.list.map((x) => feedRow(x, Infinity))));
      }
      out.push(el('div', { class: 'feed' }, rows));
    }
    return el('div', { class: 'ph-activity' }, out);
  }

  // Each sequence as a strip of its shots, in order: filed this week, filed before, or nothing yet; and
  // how many of each. A shot in the strip opens it.
  function homeSequences(project, cat, label) {
    const shots = cat.entities.filter((e) => e.tier === 'shot' && N.seqOf(e.name));
    if (!shots.length) return null;
    const bySeq = new Map();
    for (const e of shots.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      const q = N.seqOf(e.name);
      if (!bySeq.has(q)) bySeq.set(q, []);
      bySeq.get(q).push(e);
    }
    const now = Date.now();
    const state = (e) => (!e.versions ? 'none' : now - e.latestAt < WEEK ? 'fresh' : 'filed');
    return el('div', {},
      label('Sequences', bySeq.size),
      el('div', { class: 'ph-seqs' }, [...bySeq].slice(0, 12).map(([q, list]) => {
        const filedN = list.filter((e) => e.versions).length;
        const fresh = list.filter((e) => state(e) === 'fresh').length;
        return el('div', { class: 'ph-seq' },
          el('div', { class: 'ph-seq-head' },
            el('a', { href: WB.href.catalogue(project.id, { seq: q }), text: q }),
            el('span', { text: `${filedN} of ${list.length} filed${fresh ? ` · ${fresh} this week` : ''}` })),
          el('div', { class: 'ph-strip' }, list.map((e) => el('a', {
            class: `ph-shot ${state(e)}`, href: WB.href.catalogue(project.id, { entity: e.id }),
            title: `${e.name}: ${e.versions ? `${plural(e.versions, 'version')}, last ${ago(e.latestAt)}` : 'nothing filed yet'}`, 'aria-label': e.name,
          }))));
      })),
      el('div', { class: 'ph-key' }, el('span', { class: 'ph-shot fresh' }), 'this week', el('span', { class: 'ph-shot filed' }), 'before', el('span', { class: 'ph-shot none' }), 'nothing yet'));
  }

  // What is waiting: set up with nothing filed, and filed but quiet for two weeks or more.
  function homeWaiting(project, cat, label) {
    const now = Date.now();
    const none = cat.entities.filter((e) => !e.versions);
    const quiet = cat.entities.filter((e) => e.versions && now - e.latestAt >= 2 * WEEK).sort((a, b) => a.latestAt - b.latestAt);
    if (!none.length && !quiet.length) return null;
    const line = (title, list, say) => !list.length ? null : el('div', { class: 'ph-wait' },
      el('b', { text: `${list.length} ${title}` }),
      el('div', { class: 'ph-names' }, list.slice(0, 10).map((e) => el('a', { href: WB.href.catalogue(project.id, { entity: e.id }), text: e.name, title: say(e) })),
        list.length > 10 && el('span', { text: `and ${list.length - 10} more` })));
    return el('div', {},
      label('Waiting', null),
      line('with nothing filed yet', none, () => 'Set up, nothing filed yet'),
      line('quiet for two weeks or more', quiet, (e) => `Last filed ${ago(e.latestAt)}`));
  }

  const ICON_CHECKS = icon('checks', 16);
  const ICON_IMPORT = icon('import', 16);
  const ICON_PLUS = icon('plus', 18);

  // Above the catalogue: the way to bring files in. Whatever a file's name says files it; the rest are asked about.
  function catTools(project) {
    return el('div', { class: 'cat-tools' },
      el('span', { class: 'cat-hint', text: 'Drop images and videos anywhere here to add them' }),
      el('button', { type: 'button', class: `btn pick-toggle${pickingIn(project) ? ' on' : ''}`, html: `${ICON_CHECKS}<span>Select</span>`, title: 'Select assets, sets and shots to change them together', onclick: () => setPicking(project, !pickingIn(project)) }),
      el('a', { class: 'btn', href: WB.href.timeline(project.id), html: `${ICON_PLAY}<span>Timeline</span>`, title: 'Every shot in order, played through' }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_PLUS}<span>Add assets, sets &amp; shots</span>`, title: 'Set up what the project has, before anything is filed of it', onclick: () => addEntities(project) }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_IMPORT}<span>Import</span>`, title: 'Bring images and videos into the catalogue', onclick: () => importer(project).pick() }));
  }

  // Changing many at once: who works on them and who is cc'd (added, taken off, or set outright), and
  // what they are. What is left alone stays as each has it.
  async function batchEdit(project) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`);
    // What is selected and can be seen: what a search hides is left out, as the bar says.
    const seen = shownIds('.card.ent[data-id]');
    const chosen = cat.entities.filter((e) => picking.ids.has(e.id) && seen.has(e.id));
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
    const tiers = cat.tiers;
    const tierNow = [...new Set(chosen.map((e) => e.tier))];
    const tierSel = el('select', { class: 'be-how', 'aria-label': 'What they are' },
      el('option', { value: '', text: tierNow.length === 1 ? `Leave as ${tierNow[0]}${chosen.length > 1 ? 's' : ''}` : 'Leave as they are' }),
      tiers.map((t) => el('option', { value: t.id, text: `Make them ${t.label.toLowerCase()}` })));
    const error = el('p', { class: 've-error', hidden: true });
    const save = el('button', { type: 'submit', class: 'btn primary', text: `Change ${chosen.length}` });
    const names = chosen.map((e) => e.name);
    // Claude, told what they are, suggests new names and what each is (claude.js). Each suggestion is
    // ticked to be taken, and can be changed first; nothing is renamed until the dialog is saved.
    let renames = [];
    const aiList = el('div', { class: 'be-ai-list', hidden: true });
    const tierLabel = (id) => (tiers.find((t) => t.id === id) || { one: id }).one;
    const ai = WBClaude.on() && WBClaude.box({
      placeholder: 'Tell Claude how to rename them, e.g. "these are all shots of ch01, in the order of their names"',
      ask: async (instruction) => {
        const res = await api('POST', `/api/projects/${project.id}/ai/entities`, { instruction, ids: chosen.map((e) => e.id) });
        renames = chosen.filter((e) => res.answers[e.id]).map((e) => {
          const a = res.answers[e.id];
          const take = el('input', { type: 'checkbox', checked: true, 'aria-label': `Rename ${e.name}` });
          const name = el('input', { type: 'text', value: a.name, spellcheck: 'false', 'aria-label': `New name for ${e.name}` });
          return {
            e, a, take, name,
            node: el('label', { class: 'be-ai-row' }, take,
              el('span', { class: 'be-ai-old', text: e.name, title: e.tier }), el('span', { class: 'be-ai-to', text: '→' }), name,
              el('span', { class: 'be-ai-tier', text: a.tier !== e.tier ? `${tierLabel(e.tier)} → ${tierLabel(a.tier)}` : '' }),
              WBClaude.mark(a.note, a.fits)),
          };
        });
        aiList.replaceChildren(...renames.map((x) => x.node));
        aiList.hidden = !renames.length;
        return { text: renames.length ? `${plural(renames.length, 'change')} suggested. Untick what you do not want, then save.` : 'Claude would leave them as they are' };
      },
    });
    const dlg = el('dialog', { class: 'dlg be' },
      el('form', {
        method: 'dialog',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const body = { ids: chosen.map((e) => e.id), artists: artists.value(), cc: cc.value(), ...(tierSel.value && { tier: tierSel.value }) };
          const taken = renames.filter((x) => x.take.checked && x.name.value.trim());
          if (taken.length) {
            body.names = Object.fromEntries(taken.filter((x) => x.name.value.trim() !== x.e.name).map((x) => [x.e.id, x.name.value]));
            body.tiers = Object.fromEntries(taken.filter((x) => x.a.tier !== x.e.tier).map((x) => [x.e.id, x.a.tier]));
          }
          const renaming = taken.length && (Object.keys(body.names).length || Object.keys(body.tiers).length);
          if (!body.artists && !body.cc && !body.tier && !renaming) return dlg.close();
          save.disabled = true;
          try {
            await api('PATCH', `/api/projects/${project.id}/entities`, body);
            catalogues.delete(project.id);
            dlg.close();
            shownProject = '';
            render();
            // Undo puts each back as it was: its own artists, cc and tier, not one value for all.
            const before = chosen.map((e) => ({ id: e.id, name: e.name, artists: e.artists || [], cc: e.cc || [], tier: e.tier }));
            undoable(`Changed ${plural(chosen.length, 'asset, set or shot', 'assets, sets and shots')}`, async () => {
              // Names go back all at once, so names that went round among them can come back round.
              if (renaming) {
                await api('PATCH', `/api/projects/${project.id}/entities`, {
                  ids: before.map((e) => e.id), names: Object.fromEntries(before.map((e) => [e.id, e.name])), tiers: Object.fromEntries(before.map((e) => [e.id, e.tier])),
                });
              }
              for (const e of before) await api('PATCH', `/api/entities/${e.id}`, { artists: e.artists, cc: e.cc, tier: e.tier });
              catalogues.delete(project.id);
              shownProject = '';
              render();
            });
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      el('h2', { text: `Edit ${chosen.length === 1 ? names[0] : `${chosen.length} ${tierNow.length === 1 ? (tiers.find((t) => t.id === tierNow[0]) || { label: 'assets, sets and shots' }).label.toLowerCase() : 'assets, sets and shots'}`}` }),
      el('p', { class: 'be-which', text: names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ') }),
      ai && el('div', { class: 'be-ai' }, ai.node, aiList),
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
    const cat = catalogues.get(project.id);
    const tiers = N.TIER_LIST;
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
      const tierOf = (n) => tierSel.value || N.kindOf(n, catalogues.get(project.id)?.entities || []) || 'asset';
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
      for (let n = a; n <= b; n += by) names.push(N.shotName(q, n));
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
            undoable(`Added ${plural(res.made.length, 'asset, set or shot', 'assets, sets and shots')}`, null);
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
  function scrubber(box, look, name) {
    if (!look || look.type !== 'video' || !look.src) return box;
    // Its phone copy on a phone (WB.playable); one is made here if it has none and this browser can.
    const src = WB.playable(look);
    if (!look.lo && !needsPhoneCopy.has(look.src)) {
      needsPhoneCopy.add(look.src);
      phoneCopies.poke();
    }
    keepForPage(src, name || look.name);
    // In its corner: whether it is cached on this computer (media.js).
    box.append(WB.media.badge(src));
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
      video = el('video', { class: 'scrub-video', playsinline: '', preload: 'auto', src });
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

  const ICON_PLAY = icon('playSolid', 14);

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
    const seen = shownIds('.card.ent[data-id]');
    const n = [...picking.ids].filter((id) => seen.has(id)).length;
    countPicked(bar, n, picking.ids.size - n, 'assets, sets and shots');
    bar.querySelector('.pick-edit').disabled = !n;
    bar.querySelector('.pick-clear').hidden = !picking.ids.size;
  }
  function setPicking(project, on) {
    picking.on = on;
    picking.project = project.id;
    picking.ids.clear();
    picking.last = null;
    $('pickbar')?.remove();
    if (on) {
      const bar = pickBar('pickbar', 'Selected assets, sets and shots', {
        clear: () => { picking.ids.clear(); paintPicked(); },
        done: () => setPicking(project, false),
        actions: [el('button', { type: 'button', class: 'btn small primary pick-edit', text: 'Edit…', onclick: () => batchEdit(project) })],
      });
      bar.querySelector('.pick-count').after(el('button', { type: 'button', class: 'btn small ghost', text: 'Select all', onclick: () => { for (const id of picking.order) picking.ids.add(id); paintPicked(); } }));
    }
    document.body.classList.toggle('picking', on);
    for (const b of document.querySelectorAll('.pick-toggle')) b.classList.toggle('on', on);
    paintPicked();
  }

  function entityTile(project, e) {
    const newest = e.newest || null;
    const thumbs = el('div', { class: `card-thumbs n${e.thumb ? 1 : 0}`, ...(newest && { title: 'Play the latest' }) },
      e.thumb && el('img', { src: e.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
      newest && el('span', { class: 'play-latest', html: `${ICON_PLAY}<span>Latest</span>` }));
    if (newest) {
      scrubber(thumbs, newest.look, newest.label || e.name);
      // Reached with Tab too: Enter or Space plays the latest.
      thumbs.setAttribute('tabindex', '0');
      thumbs.setAttribute('role', 'button');
      thumbs.setAttribute('aria-label', `Play the latest of ${e.name}`);
      thumbs.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        ev.stopPropagation();
        thumbs.click();
      });
      thumbs.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (pickingIn(project)) pickTile(e.id, ev.shiftKey);
        else lookAt(e.id, newest.id);
      });
    }
    return el('a', {
      class: `card ent${picking.ids.has(e.id) && pickingIn(project) ? ' picked' : ''}`, href: WB.href.catalogue(project.id, { entity: e.id }), 'data-id': e.id,
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
          e.artists.slice(0, 4).map((n) => WB.avatar(n, null, { size: 'xs' })), el('span', { text: e.artists.join(', ') }))),
      // The same menu as every other card: what can be done with it, Pin among it (so a pin on Home can
      // be taken off from Home).
      menuButton([
        newest && ['Play the latest', () => lookAt(e.id, newest.id)],
        ['Open its page', () => { location.hash = WB.href.catalogue(project.id, { entity: e.id }); }],
        [isPinned('entity', e.id) ? 'Unpin from Home' : 'Pin to Home', () => togglePin({ kind: 'entity', id: e.id, name: e.name, projectId: project.id, tier: e.tier, thumb: e.thumb || null })],
      ].filter(Boolean)));
  }

  function catalogueView(project, cat, view = {}) {
    const q = WBNaming.tokenize($('q').value);
    const list = cat.entities.filter((e) => (!q || e.name.includes(q))
      && (!view.tier || e.tier === view.tier) && (!view.seq || (e.tier === 'shot' && N.seqOf(e.name) === view.seq)));
    const label = (text, n) => el('div', { class: 'section-label' }, text, el('span', { class: 'tally', text: String(n) }));
    const out = [];
    picking.order = [];
    for (const tier of cat.tiers) {
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
  let lookingAt = null; // the asset, set or shot open in the (docked) player
  const thePlayer = () => player || (player = WBViewer.create({ me: () => me, title: () => '', media: () => [], notes: () => [], add() {}, set() {}, remove() {} }));
  async function lookAt(entityId, versionId) {
    thePlayer();
    try {
      const project = folderById(currentFolder());
      // Docked, as the timeline is: the sidebar and the bar stay, and going elsewhere from them closes it.
      await WBViewer.openEntity(player, entityId, { version: versionId, me, dock: true, title: project ? project.name : null, onClose: () => { lookingAt = null; shownProject = ''; render(); } });
      lookingAt = entityId;
    } catch (err) {
      fail(err);
    }
  }

  // What a version is filed as: its asset, set or shot, task and number make its name. Moved to another
  // asset or task with its number left as it was, it becomes the next one there.
  async function editVersion(project, entity, v) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
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
          if (e2 !== entity.name) body.entity = { name: e2, tier: N.kindOf(e2, cat ? cat.entities : []) || entity.tier };
          if (num.value) body.number = Number(num.value);
          save.disabled = true;
          try {
            const done = await api('PATCH', `/api/versions/${v.id}`, body);
            catalogues.delete(project.id);
            dlg.close();
            if (done.entityId !== entity.id) location.hash = WB.href.catalogue(project.id, { entity: done.entityId });
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
        // A project that does not count by task asks for none (one filed with a task before still shows it, so it can be taken off).
        field('Asset, set or shot', ent), (v.task || !(project.settings && project.settings.tasks === false)) && field('Task', task), field('Version', num), field('Artist', artist), field('Description', desc)),
      el('div', { class: 've-preview' }, el('span', { text: 'Called' }), name),
      error,
      el('div', { class: 'dlg-actions' },
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
        save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    WB.combo(ent, WBFiling.entitySource(() => (cat ? cat.entities : [])));
    WB.combo(task, WBFiling.taskSource(() => (cat ? cat.tasks : [])));
    WB.combo(artist, WBFiling.taskSource(() => (cat ? cat.artists : [])));
    dlg.showModal();
    ent.select();
  }

  // What can be done to a version, the same from its card on its asset's page and from its row in the
  // project's Versions: open it, change what it is filed as, archive it, download it, delete it.
  async function archiveVersion(v, hide) {
    await api('PATCH', `/api/versions/${v.id}`, { hidden: hide });
    versionLists.clear();
    render();
    if (hide) undoable(`${v.label} archived`, async () => { await api('PATCH', `/api/versions/${v.id}`, { hidden: false }); versionLists.clear(); render(); });
  }
  function versionActions(project, entity, v) {
    return [
      ['Open', () => lookAt(entity.id, v.id)],
      ['Edit…', () => editVersion(project, entity, v)],
      [v.hidden ? 'Bring back from the archive' : 'Archive', () => archiveVersion(v, !v.hidden)],
      v.look && ['Download', () => { location.href = v.look.orig || v.look.src; }],
      ['Delete…', () => deleteVersion(v), true],
    ].filter(Boolean);
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
    versionLists.clear();
    render();
    undoable(`${v.label} deleted`, async () => {
      await api('PATCH', `/api/versions/${v.id}`, { deleted: false });
      render();
    });
  }

  // A note at the bottom of the page for a few seconds, with a way to take back what was just done.
  // A change just made, said at the foot of the page, with a way to take it back when there is one.
  function undoable(text, undo, more) {
    WB.toast(text, { key: 'undo', ms: 8000, action: undo ? { label: 'Undo', run: async () => { try { await undo(); } catch (err) { fail(err); } } } : more });
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
      WB.avatar(n), el('span', { text: n }),
      el('button', { type: 'button', class: 'pf-x', title: `Take ${n} off`, 'aria-label': `Take ${n} off`, html: icon('close', 12), onclick: () => set(list.filter((x) => x !== n)) }))));
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

  // Picking versions, on the Versions page and an asset, set or shot's own: a click on a card picks it
  // (Shift and a click, every one between it and the last), and the bar at the foot says what can be done.
  function pickVersion(project, id, range) {
    if (range && vpick.last && vpick.order.includes(vpick.last)) {
      const [a, b] = [vpick.order.indexOf(vpick.last), vpick.order.indexOf(id)].sort((x, y) => x - y);
      for (const x of vpick.order.slice(a, b + 1)) vpick.ids.add(x);
    } else if (vpick.ids.has(id)) vpick.ids.delete(id);
    else vpick.ids.add(id);
    vpick.last = id;
    paintVersionPick(project);
  }

  // A version's card, the same wherever versions are listed: its picture (scrubbed under the pointer,
  // opened in the player with a click), its shot and the rest of its label, what is known of it, the
  // boards it is on, and its menu. A click anywhere else on it picks it. On the Versions page (`list`) it
  // says which asset, set or shot it is (a link to it) and when it was filed, as the page groups by who
  // filed it; on the asset, set or shot's own page, who filed it and when.
  function versionCard(project, entity, v, { list = false, tierName = (t) => t } = {}) {
    const rest = v.label.startsWith(entity.name) ? v.label.slice(entity.name.length).trim() : v.label;
    const views = v.look && (v.look.views || []).length ? [v.look.view || 'main', ...v.look.views.map((x) => x.view)] : null;
    const about = [
      list && clock(v.createdAt),
      list && tierName(v.tier),
      v.artist && !(list && v.artist === (v.createdBy || '').toLowerCase()) && `by ${v.artist}`,
      v.descriptor,
    ].filter(Boolean).join(' · ') || (!list && v.originalName) || '';
    const label = v.label;
    return el('div', {
      class: `card ver${v.hidden ? ' hidden-ver' : ''}${vpick.ids.has(v.id) ? ' picked' : ''}`, 'data-id': v.id, tabindex: '0',
      'aria-label': `${label}: press Space to select`,
      // From the keyboard too: Space or Enter picks it, as a click does.
      onkeydown: (e) => {
        if (e.target !== e.currentTarget || (e.key !== ' ' && e.key !== 'Enter')) return;
        e.preventDefault();
        pickVersion(project, v.id, e.shiftKey);
      },
      onclick: (e) => {
        if (e.target.closest('a, button')) return;
        pickVersion(project, v.id, e.shiftKey);
      },
    },
    el('button', {
      type: 'button', class: `vl-box${vpick.ids.has(v.id) ? ' on' : ''}`, 'data-ids': v.id, title: `Select ${label}`, 'aria-label': `Select ${label}`,
      onclick: (e) => { e.stopPropagation(); pickVersion(project, v.id, e.shiftKey); },
    }),
    scrubber(el('button', {
      type: 'button', class: `card-thumbs n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw',
      onclick: (e) => { e.stopPropagation(); lookAt(entity.id, v.id); },
    },
    v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
    v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })), v.look, v.label),
    el('div', { class: 'card-body' },
      el('div', { class: 'card-name', title: v.label },
        list ? el('a', { class: 'ver-ent', href: WB.href.catalogue(project.id, { entity: entity.id }), text: entity.name, title: `${entity.name}: its page` }) : el('span', { class: 'ver-ent', text: entity.name }),
        rest && el('span', { class: 'ver-rest', text: ` ${rest}` })),
      el('div', { class: 'card-meta', text: about }),
      // Shown more than one way: its views, the main one first.
      views && el('div', { class: 'card-meta', text: `Views: ${views.join(', ')}` }),
      !list && el('div', { class: 'card-meta', text: `Filed ${ago(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}${v.hidden ? ' · archived' : ''}` }),
      list && v.hidden && el('div', { class: 'card-meta', text: 'Archived' }),
      v.boards.length > 0 && el('div', { class: 'ver-boards' }, v.boards.slice(0, 4).map((b) => el('a', { class: 'ver-board', href: WB.href.board(b.id), text: b.name })),
        v.boards.length > 4 && el('span', { class: 'ver-more', text: `+${v.boards.length - 4}` }))),
    menuButton(versionActions(project, entity, v)));
  }

  let showHidden = false;
  function entityPage(project, page) {
    const { entity } = page;
    const hidden = page.versions.filter((v) => v.hidden).length;
    const versions = page.versions.filter((v) => showHidden || !v.hidden);
    const byVersion = new Map(page.versions.map((v) => [v.id, v]));
    // What was said, by thread, newest version first.
    const roots = page.notes.filter((n) => !n.re);
    const replies = (id) => page.notes.filter((n) => n.re === id).sort((a, b) => a.t - b.t);
    const order = new Map(page.versions.map((v, i) => [v.id, i]));
    roots.sort((a, b) => (order.get(a.versionId) ?? 0) - (order.get(b.versionId) ?? 0) || a.t - b.t);
    const msg = (n, first) => el('div', { class: `ent-msg${first ? '' : ' reply'}` },
      WB.avatar(n.name, n.color),
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
        ...versions.map((v) => versionCard(project, entity, v))),
      label('Notes', roots.length),
      roots.length ? el('div', { class: 'ent-threads' }, threads) : el('p', { class: 'home-empty', text: 'Nothing said about it yet. Notes made on any board it is on show here.' }));
  }

  // ---- importing: many files at once, straight into the catalogue

  const imports = new Map(); // project id -> { rows, node }
  const megabytes = WB.bytes;

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
    const signal = r.ctl.signal;
    const look = await ingest(r.file, (k) => tell('up', k), isVideo ? { onPhase: (k) => tell('enc', k), onStrip: (k) => tell('strip', k), signal } : { signal });
    if (isVideo && !look.orig) {
      if (WBFiling.originalFits(r.file)) look.orig = (await upload(r.file, fileExt(r.file), (k) => tell('orig', k), false, signal)).url;
      else r.note = `The original is ${megabytes(r.file.size)}, more than is kept here, so only its review copy is`;
    }
    return look;
  }


  // What is being brought into a project's catalogue: a strip above it, one row a file. Each file says on
  // its own row what it is to be filed as, filled in ahead from its name (or, added on an asset, set or
  // shot's page, that one), and is filed when you say so: one at a time, or all that are ready at once.
  // Kept per project, so leaving the catalogue and coming back finds it as it was.
  function importer(project) {
    let state = imports.get(project.id);
    if (state) return state;
    const rows = [];
    let cat = catalogues.get(project.id) || null;
    const catalogue = async () => cat || (cat = await api('GET', `/api/projects/${project.id}`));
    const tasks = () => (cat ? cat.tasks : N.TASKS);
    const known = (name) => cat && cat.entities.find((e) => e.name === name);
    // What the project is set to: whether it counts by task, and the names it has learned to read.
    const settings = () => (cat && cat.project && cat.project.settings) || project.settings || {};
    const useTasks = () => settings().tasks !== false;
    const rules = () => settings().rules || [];
    // The fields of the rows still to be filed, in order: what is above a row says what a short line in it means.
    const peers = () => rows.filter((o) => o.fields && unfiled(o)).map((o) => o.fields.f);
    // New sequences already said yes to, so each is asked about once.
    const seqsAsked = new Set();

    const list = el('div', { class: 'imp-list' });
    const title = el('b', { class: 'imp-title' });
    const fileAll = el('button', {
      type: 'button', class: 'btn small primary',
      onclick: async () => {
        const ready = rows.filter(canFile);
        for (const r of ready) r.fields.f.settle();
        if (!(await WBFiling.confirmSequences(ready.map((r) => r.fields.f), seqsAsked))) return;
        for (const r of ready) fileRow(r);
      },
    });
    const clearBtn = el('button', { type: 'button', class: 'btn small ghost', text: 'Clear done', title: 'Put away what is filed', onclick: () => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].status === 'filed' || (rows[i].status === 'failed' && !rows[i].look)) {
          rows[i].node.remove();
          rows.splice(i, 1);
        }
      }
      paintHead();
    } });
    // The same answer for every file not yet filed, to start from (filing.js, as on a board).
    const fillAll = WBFiling.forAll({
      getEntities: () => (cat ? cat.entities : []), getTasks: tasks, cls: 'imp-fill', useTasks: useTasks(),
      apply: (ent, task) => {
        // In order, so that a short line (+) is read by each row after the one above it.
        for (const r of rows) {
          if (r.status === 'filed' || r.status === 'filing') continue;
          if (ent) r.fields.ent.value = ent;
          if (task) r.fields.task.value = task;
          WBFiling.changed();
          r.fields.f.settle();
        }
        resyncAll();
      },
    });
    // Claude, told what these are, fills the rows in (claude.js); they are checked and filed as ever.
    const ai = WBClaude.on() && WBClaude.box({
      placeholder: 'Tell Claude what these are, e.g. "all shots of ch02, numbered in the order of their names, anim"',
      ask: askClaude, cls: 'imp-ai',
    });
    const aiBtn = ai && el('button', {
      type: 'button', class: 'btn small ghost imp-aibtn', html: `${icon('sparkle', 14)}<span>Ask Claude</span>`, 'aria-expanded': 'false',
      title: 'Let Claude fill in what these are from their names and what you tell it',
      onclick: () => {
        ai.node.hidden = !ai.node.hidden;
        aiBtn.setAttribute('aria-expanded', String(!ai.node.hidden));
        if (!ai.node.hidden) ai.focus();
      },
    });
    if (ai) ai.node.hidden = true;
    // The ways the project shows its versions, the main one first, or null for one way (its settings):
    // each row then says which it is (filing.js).
    const viewList = () => (cat ? cat.viewList : Array.isArray(settings().views) ? settings().views : null) || null;
    const head = el('div', { class: 'imp-head' }, title, fillAll, el('span', { class: 'imp-gap' }), WBFiling.keysButton(), aiBtn, clearBtn, fileAll);
    // What each part of the rows' lines is, said once over them, as the project's settings have them.
    const labels = el('div', { class: 'imp-row imp-labels', hidden: true });
    let labelsFor = '';
    const paintLabels = () => {
      const key = JSON.stringify([useTasks(), viewList()]);
      if (key !== labelsFor) {
        labelsFor = key;
        labels.replaceChildren(el('span'), el('span'), el('span', { class: 'imp-fields' }, WBFiling.lineHead({ useTasks: useTasks(), views: viewList() }), el('span', { class: 'imp-go' })), el('span', { class: 'imp-end' }));
      }
      labels.hidden = !rows.some(unfiled);
    };
    const tray = el('div', { class: 'imp', hidden: true }, head, ai && ai.node, labels, list);
    const picker = el('input', { type: 'file', multiple: true, accept: 'image/*,video/mp4,video/webm,video/quicktime', hidden: true });
    document.body.append(picker);
    let pickFor = null;
    picker.addEventListener('change', () => {
      add([...picker.files], pickFor);
      picker.value = '';
    });

    const PHASE = { enc: 'Preparing', up: 'Uploading', strip: 'Building timeline', orig: 'Keeping the original' };
    const choiceOf = (r) => ({ name: r.fields.f.name(), task: r.fields.f.taskName() });
    const viewOf = (r) => r.fields.f.viewName();
    // The next number for a row: one past the highest its asset, set or shot and task has, counting the
    // rows above it still to be filed to the same. Another view of the row just above (the same name and
    // task, from the same version of the file) is the same version, and has its number.
    // The row a view goes with: another of the same asset, set or shot and task, from the same version of
    // the file (by the version its name says, when both say one), the main one first, above or below it.
    // Without a version in the names, the nearest row above going there.
    function partnerOf(r) {
      const view = viewOf(r);
      if (!view) return null;
      const { name, task } = choiceOf(r);
      const others = rows.filter((o) => o !== r && o.fields && o.status !== 'failed' && viewOf(o) !== view
        && choiceOf(o).name === name && choiceOf(o).task === task);
      if (r.parsed.hip != null) {
        const same = others.filter((o) => o.parsed.hip === r.parsed.hip);
        return same.find((o) => !viewOf(o)) || same[0] || null;
      }
      const above = others.filter((o) => rows.indexOf(o) < rows.indexOf(r));
      return above[above.length - 1] || null;
    }
    function nextNumber(r) {
      const { name, task } = choiceOf(r);
      const view = viewOf(r);
      if (view) {
        const partner = partnerOf(r);
        if (partner) {
          const n = partner.status === 'filed' && partner.version ? partner.version.number
            : partner.numTouched || viewOf(partner) ? Number(partner.fields.num.value) : nextNumber(partner);
          if (n) return n;
        }
        // On its own, it goes with the newest version there is of that, if that has no such view yet.
        const newest = !partner && known(name) && known(name).newest;
        if (newest && (newest.task || null) === task && !WBViewer.inView(newest.look, '').viewNames.includes(view)) return newest.number;
      }
      const have = known(name);
      let n = (have && have.tops ? have.tops[task || ''] || 0 : 0) + 1;
      for (const o of rows) {
        if (o === r) break;
        if (o.status === 'filed' || !o.fields) continue;
        // A view that goes with another row makes no version of its own.
        if (viewOf(o) && partnerOf(o)) continue;
        const c = choiceOf(o);
        if (c.name === name && c.task === task) n = Math.max(n, (Number(o.fields.num.value) || n) + 1);
      }
      return n;
    }
    const resyncAll = () => { for (const o of rows) if (o.fields) o.fields.sync(); };
    // Rows nobody has named yet, read again by what the project now has: a file filed as char-robot
    // makes char-robot_model_v1 one of its versions, and char-dog_rig_v2 an asset like it.
    const reread = () => {
      for (const o of rows) {
        if (!o.fields || o.touched || !unfiled(o) || o.fields.f.name()) continue;
        const p = N.parse(o.file.name, cat ? cat.entities : []);
        if (!p.entity) continue;
        o.parsed = p;
        o.fields.f.setLine(p.entity, p.task || undefined);
        o.fields.f.take({ number: p.hip, view: p.view, named: true });
      }
    };

    // What Claude would file each row not yet filed as, put into the rows. Undo puts back what they said.
    const unfiled = (r) => r.status !== 'filed' && r.status !== 'filing';
    async function askClaude(instruction) {
      const asked = rows.filter(unfiled);
      if (!asked.length) throw new Error('Nothing here is left to file');
      const res = await api('POST', `/api/projects/${project.id}/ai/files`, {
        instruction,
        files: asked.map((r) => ({
          key: r.key, filename: r.file.name,
          now: { entity: r.fields.ent.value.trim() || null, task: r.fields.task.value.trim() || null, version: r.numTouched ? Number(r.fields.num.value) || null : null, view: viewOf(r) },
        })),
      });
      await catalogue().catch(() => {});
      const before = [];
      let n = 0;
      for (const r of asked) {
        const a = res.answers[r.key];
        if (!a || !unfiled(r)) continue;
        const f = r.fields;
        before.push({ r, ent: f.ent.value, task: f.task.value, tier: f.tier.value, num: f.num.value, numTouched: r.numTouched, view: f.f.viewName() });
        // Only the fields in its answer: asked to fill in the shot and the version and nothing more, the rest
        // are not there, and stay as they are. What is there may clear a field (no task, the main view).
        if ('entity' in a) {
          f.ent.value = a.entity;
          f.tier.value = a.tier;
        }
        if ('task' in a) f.task.value = a.task || '';
        WBFiling.changed();
        if ('view' in a && viewList()) f.f.setView(a.view || viewList()[0]);
        if ('version' in a) {
          r.numTouched = !!a.version;
          if (a.version) f.num.value = String(a.version);
        }
        setMark(r, WBClaude.mark(a.note, a.fits));
        n++;
      }
      // Views given show their boxes, so what was filled in is seen and can be checked.
      resyncAll();
      if (!n) return { text: 'Claude had nothing to suggest for these' };
      const missed = asked.length - n;
      return {
        text: `Filled in ${plural(n, 'row')}${missed ? ` (not ${missed})` : ''}. Check them, then file.`,
        undo: () => {
          for (const b of before) {
            b.r.fields.ent.value = b.ent;
            b.r.fields.task.value = b.task;
            WBFiling.changed();
            b.r.fields.tier.value = b.tier;
            b.r.fields.num.value = b.num;
            if (viewList()) b.r.fields.f.setView(b.view || viewList()[0]);
            b.r.numTouched = b.numTouched;
            setMark(b.r, null);
          }
          resyncAll();
        },
      };
    }
    // A row Claude filled in says so, until it is changed by hand.
    function setMark(r, mark) {
      if (r.fields.mark) r.fields.mark.remove();
      r.fields.mark = mark;
      if (mark) r.fields.box.prepend(mark);
    }
    const canFile = (r) => (r.status === 'ready' || r.status === 'uploading' || r.status === 'queued' || (r.status === 'failed' && r.look)) && !r.fileWhenReady && !!r.fields && r.fields.f.ready();

    function makeRow(r) {
      // Which asset, set or shot, what it is if new, and the task: the fields a board files with too.
      // The version it is to be: the next of that asset, set or shot and task (after any rows above going
      // to the same), unless another is typed (in its field, or at the end of the line: kilo-0010 v12).
      const num = el('input', { type: 'number', min: '1', step: '1', class: 'imp-num', 'aria-label': 'Version', title: 'Version: the next one, unless you say another' });
      const ruled = !r.parsed.entity && N.byRules(r.file.name, rules(), tasks());
      // Named some other way, and not by a pattern the project has: filing it may teach one.
      r.taught = !r.entity && !r.parsed.entity && !(ruled && ruled.rule.pattern);
      const f = WBFiling.fields({
        getEntities: () => (cat ? cat.entities : []), getTasks: tasks, views: viewList(), view: r.parsed.view || (ruled && ruled.view), label: r.file.name,
        entity: r.entity ? r.entity.name : r.parsed.entity || (ruled && ruled.entity) || '', task: r.parsed.task || (ruled && ruled.task) || '', onChange: resyncAll,
        named: !!(r.entity || r.parsed.entity || ruled), piece: () => r.look,
        useTasks: useTasks(), rules, peers, remembered: store(`wb:file:${project.id}`) || null,
        numberOf: () => Number(num.value) || null, numInput: num, numAuto: () => !r.numTouched,
        onLine: (l) => {
          if (l.number) {
            num.value = String(l.number);
            r.numTouched = true;
          }
          resyncAll();
        },
      });
      const { ent, task, tier } = f;
      // The version its name says (v111), read as the app writes names or by a learned pattern, is its number.
      const named = (ruled && ruled.number) || (r.parsed.entity && r.parsed.hip) || null;
      if (named) {
        num.value = String(named);
        r.numTouched = true;
      }
      num.addEventListener('input', () => { r.numTouched = num.value !== ''; resyncAll(); });
      const go = el('button', { type: 'button', class: 'btn small', text: 'File', onclick: () => fileRow(r) });
      const status = el('span', { class: 'imp-status' });
      const bar = el('i', { class: 'imp-bar' }, el('i'));
      const thumb = el('span', { class: 'imp-thumb' });
      const said = el('button', { type: 'button', class: 'imp-filed', hidden: true, title: 'Open it, to look, comment and draw', onclick: () => r.version && lookAt(r.version.entityId, r.version.id) });
      // Taken back straight after, as if it had not been filed: the row is as it was, to file again.
      const undo = el('button', { type: 'button', class: 'btn small ghost imp-undo', text: 'Undo', hidden: true, title: 'Take it back, as if it had not been filed', onclick: () => unfileRow(r) });
      const fields = el('span', { class: 'imp-fields' }, f.line, go);
      const sync = () => {
        const { name } = choiceOf(r);
        if (!r.numTouched && r.status !== 'filed') {
          const next = name ? nextNumber(r) : '';
          if (num.value !== String(next)) num.value = String(next);
        }
        f.sync();
        go.disabled = !canFile(r);
        // Another view of the version the row above is: shown as going with it.
        const above = rows[rows.indexOf(r) - 1];
        const { task } = choiceOf(r);
        r.node?.classList.toggle('with-above', !!(above && above.fields && viewOf(r) && unfiled(r) && unfiled(above)
          && choiceOf(above).name === name && choiceOf(above).task === task && viewOf(above) !== viewOf(r) && Number(above.fields.num.value) === Number(num.value)));
        paintHead();
      };
      for (const input of [ent, task, num]) {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented && canFile(r)) fileRow(r); });
        input.addEventListener('input', () => { r.touched = true; setMark(r, null); });
      }
      r.fields = { f, ent, task, num, view: f.viewSel, tier, go, status, bar, thumb, said, undo, box: fields, sync };
      // Taken back: whatever is under way for it stops, and the row goes.
      const drop = el('button', {
        type: 'button', class: 'iconbtn imp-x', html: icon('close', 14), title: `Take ${r.file.name} back`,
        onclick: () => {
          r.ctl.abort();
          const i = rows.indexOf(r);
          if (i >= 0) rows.splice(i, 1);
          r.node.remove();
          paintHead();
        },
      });
      r.fields.drop = drop;
      // Did not come in: it can be tried again as it is, without taking it back and adding it anew.
      const retry = el('button', {
        type: 'button', class: 'btn small imp-retry', html: `${icon('retry', 14)}<span>Try again</span>`, hidden: true, title: `Bring ${r.file.name} in again`,
        onclick: () => {
          Object.assign(r, { status: 'queued', error: null, progress: 0, phase: null, ctl: new AbortController() });
          paintRow(r);
          paintHead();
          work();
        },
      });
      r.fields.retry = retry;
      // What it is doing is said under its bar, so nothing on the row moves while it comes in.
      r.node = el('div', { class: 'imp-row' }, thumb, el('span', { class: 'imp-file' }, el('span', { class: 'imp-name', text: r.file.name, title: r.file.name }), bar, status), fields, said, el('span', { class: 'imp-end' }, undo, retry, drop));
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
      // Only while the server would take it back: a view put with a version there already is not.
      f.undo.hidden = !(r.status === 'filed' && r.version && !r.version.filedView && Date.now() - r.filedAt < WBFiling.UNFILE_WITHIN);
      f.go.textContent = r.status === 'filing' ? 'Filing…' : 'File';
      f.drop.hidden = r.status === 'filed' || r.status === 'filing';
      f.retry.hidden = !(r.status === 'failed' && !r.look);
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
      if (aiBtn) aiBtn.hidden = !rows.some(unfiled);
      paintLabels();
      if (ai && aiBtn.hidden) ai.node.hidden = true;
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

    async function unfileRow(r) {
      if (r.status !== 'filed' || !r.version) return;
      try {
        await api('POST', `/api/versions/${r.version.id}/unfile`, { by: me.name });
      } catch (err) {
        r.fields.undo.hidden = true;
        return fail(err);
      }
      Object.assign(r, { status: 'ready', label: null, version: null, filedAt: 0 });
      cat = null;
      await catalogue().catch(() => {});
      resyncAll();
      paintRow(r);
      showFiled();
    }

    // Filed once however often it is asked (a view's row asks for the row it goes with, which may be on its way already).
    function fileRow(r) {
      if (!r.inflight) r.inflight = fileRowNow(r).finally(() => { r.inflight = null; });
      return r.inflight;
    }
    async function fileRowNow(r) {
      if (!canFile(r)) return;
      r.fields.f.settle();
      // A new sequence is said out loud once before it is made.
      if (!(await WBFiling.confirmSequences([r.fields.f], seqsAsked))) return;
      if (!canFile(r)) return;
      // A view goes with its version, so the row that makes that version is filed first, then this counts from it.
      const partner = partnerOf(r);
      if (partner && !viewOf(partner) && unfiled(partner) && (canFile(partner) || partner.inflight)) {
        await fileRow(partner);
        r.fields.sync();
      }
      // Still on its way in: filed as soon as it is here.
      if (!r.look) {
        r.fileWhenReady = true;
        return paintRow(r);
      }
      const { name, task } = choiceOf(r);
      const entity = r.fields.f.entity();
      const number = Number(r.fields.num.value);
      r.status = 'filing';
      paintRow(r);
      try {
        const view = viewOf(r);
        const res = await api('POST', `/api/projects/${project.id}/versions`, { files: [{ look: r.look, entity, task, view, ...(Number.isSafeInteger(number) && number >= 1 && { number }) }], by: me.name });
        const v = res.versions[0];
        Object.assign(r, { status: 'filed', label: v.filedView ? `${v.label} · ${v.filedView}` : v.label, version: v, filedAt: Date.now() });
        store(`wb:file:${project.id}`, { entity: name, task });
        // What is filed now has its number: the rows still to go count on from it.
        cat = null;
        await catalogue().catch(() => {});
        reread();
        resyncAll();
        showFiled();
        // A file named some other way teaches how such names are read, if it is wanted, and fills in the rest.
        if (r.taught) {
          WBFiling.offerRule({
            filename: r.file.name, rules: rules(), tasks: tasks(),
            filed: { entity: name, task, number: r.version.number, view: viewOf(r), views: viewList() || [] },
            others: rows.filter((o) => o !== r && o.fields && unfiled(o)).map((o) => ({ filename: o.file.name, fields: o.fields.f })),
            save: async (next) => {
              await api('PATCH', `/api/folders/${project.id}`, { settings: { rules: next } });
              cat = null;
              await catalogue().catch(() => {});
              await refresh();
              resyncAll();
            },
          });
        }
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
          // What it looks like a new version of, asked as soon as it is in: first among its suggestions.
          WBFiling.findLikely(project.id, [{ key: r.key, look: r.look }]).then((a) => { if (a[r.key] && r.fields) r.fields.f.setLikely(a[r.key]); });
          if (r.fileWhenReady) {
            r.fileWhenReady = false;
            fileRow(r);
          }
        } catch (err) {
          // Taken back while it was coming in: the row has gone already.
          if (err.name === 'AbortError') continue;
          r.status = 'failed';
          r.fileWhenReady = false;
          r.error = err.transient ? `The review copy could not be made (tried ${WBIngest.TRIES} times). Try again`
            : err.refused ? `This browser cannot process this video. Import it from ${WBIngest.OTHER_BROWSERS} instead` : err.message;
          paintRow(r);
        }
      }
      running = false;
    }

    // `entity`, when the files are added on an entity's page, is what they are filled in as.
    // (The catalogue is had first: what the project is set to, its views among it, shapes each row.)
    async function add(files, entity = null) {
      // A new lot is read against the project as it is now (its settings may have changed since the last).
      if (!rows.some(unfiled)) cat = null;
      await catalogue().catch(() => {});
      let n = 0;
      for (const file of files) {
        if (!/^(image|video)\//.test(file.type) && !/\.(png|jpe?g|gif|webp|avif|bmp|svg|mp4|m4v|webm|mov)$/i.test(file.name)) continue;
        const r = { key: WB.uid(), file, entity, status: 'queued', progress: 0, parsed: N.parse(file.name, cat ? cat.entities : []), look: null, preview: null, ctl: new AbortController() };
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
      location.href = WB.href.board(board.id);
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

  // ------------------------------------------------------------- notifications (notices.js)

  const notices = WBNotices.mount({ name: () => me.name });

  // What is typed narrows the page from what it already has, a beat after the last key.
  let searchTimer = 0;
  $('q').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searching = true;
      try {
        render();
      } finally {
        searching = false;
      }
    }, 120);
  });
  // The page's keys, in one place. `/` goes to the search box unless something else is being typed in;
  // Escape puts away the nearest thing, one at a time: the search, the notifications, the drawer, then
  // what is selected. A dialog, a menu or the player has Escape to itself.
  const playerOpen = () => !!player && player.isOpen();
  window.addEventListener('keydown', (e) => {
    const typing = WB.isTyping(e.target);
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !document.querySelector('dialog[open]') && !playerOpen()) {
      e.preventDefault();
      $('q').focus();
      return;
    }
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (e.target === $('q')) {
      $('q').value = '';
      $('q').blur();
      render();
      return;
    }
    if (typing || document.querySelector('dialog[open], .wb-menu') || playerOpen()) return;
    if (notices.isOpen()) return void notices.close();
    if (document.body.classList.contains('side-open')) return void closeDrawer();
    if (vpick.ids.size) {
      vpick.ids.clear();
      const f = folderById(vpick.project);
      if (f) paintVersionPick(f);
    } else if (bpick.size || bselecting) setBoardSelecting(false);
    else if (picking.on) {
      const f = folderById(picking.project);
      if (f) setPicking(f, false);
    }
  });
  window.addEventListener('hashchange', render);
  // ---- presenting the project you are in (present.js): whoever has its link sees what you open in the
  // player, the catalogue's versions or the timeline, as you show it; the lists in between they are not shown.
  if (WB.info().canShare) {
    WBPresent.init({ me: () => me, viewer: thePlayer, project: projectHere, page: () => ({ k: 'idle' }) });
    presentBtn = WBPresent.button();
    presentBtn.hidden = true;
    $('presentslot').replaceWith(presentBtn);
    WBPresent.onChange(() => render());
  }
  await refresh();
  if (!feed) loadFeed();
  setInterval(() => { if (!document.hidden && !dragging && !document.querySelector('dialog[open], .menu:not([hidden])')) refresh(true); }, 15000);
})();
