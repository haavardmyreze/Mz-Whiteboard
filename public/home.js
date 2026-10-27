'use strict';

(async () => {
  const { el, api, ago, store } = WB;
  const $ = (id) => document.getElementById(id);
  // What the page shows under its title. A part a view leaves out (false or null, as `x && el(...)` gives) is not
  // there, rather than written out as the word.
  const showContent = (...parts) => $('content').replaceChildren(...parts.filter((x) => x != null && x !== false));

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

  // How every list is shown (cards, compact rows or a table): the switch at the end of the page's title,
  // beside the lists it changes, and the page drawn again when it changes, here or in Your account. The
  // theme is chosen in Your account.
  const layoutSeg = WB.layoutSwitch();
  $('layoutslot').replaceWith(layoutSeg);
  window.addEventListener('wb:layout', () => render());
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
  $('me').addEventListener('click', () => WBAccount.open({ me: () => me, setMe: (m) => { me = m; paintMe(); } }));

  // ------------------------------------------------------------- library helpers

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  // Whether a page lists boards: a plain folder's, or a project's reviews (its boards and playlists).
  const listsBoards = (v) => v.page === 'boards' || (v.page === 'reviews' && !v.playlist);
  // A project's sequences, and its shots by them, in the order its settings give (see seqOrder in naming.js).
  const seqSort = (project) => WBNaming.seqOrder(project && project.settings && project.settings.seqs);
  const shotSort = (project) => WBNaming.shotOrder(project && project.settings && project.settings.seqs);
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
  // The playlists that are in no project (a project's come with its catalogue), kept in a folder or at the
  // top of a workspace as boards are.
  const loosePlaylists = () => everything.playlists || [];
  const loose = (id) => loosePlaylists().find((p) => p.id === id) || null;
  const playlistsIn = (id, ws = space) => (id ? loosePlaylists() : loosePlaylists().filter((p) => p.workspace === ws)).filter((p) => (p.folderId || null) === id);
  // The playlist outside a project that the page is on (#/pl/<id>), once the library has it.
  function currentLoose() {
    const m = /^#\/pl\/([\w-]+)/.exec(location.hash);
    return m ? loose(m[1]) : null;
  }

  function currentFolder() {
    const m = /^#\/f\/([\w-]+)/.exec(location.hash);
    return m && folderById(m[1]) ? m[1] : null;
  }

  // In a project folder: which of its pages is open, its home, its reviews (#/f/<id>/reviews: its boards,
  // playlists and animatics, and a playlist among them, …/reviews/<playlist id>), an animatic (…/animatic/<id>),
  // its versions (…/versions), its activity (…/activity) or catalogue, and in the catalogue the type
  // (#/f/<id>/catalogue/t/shot), the sequence (…/s/kilo) or the entity (…/<entity id>) being looked at.
  function currentView() {
    const an = /^#\/f\/[\w-]+\/animatic\/([\w-]+)/.exec(location.hash);
    if (an) return { page: 'animatic', animatic: an[1], entity: null };
    const rv = /^#\/f\/[\w-]+\/reviews(?:\/([\w-]+))?/.exec(location.hash);
    if (rv) return { page: 'reviews', playlist: rv[1] || null, entity: null };
    if (/^#\/f\/[\w-]+\/versions/.test(location.hash)) return { page: 'versions', entity: null };
    if (/^#\/f\/[\w-]+\/activity/.test(location.hash)) return { page: 'activity', entity: null };
    const m = /^#\/f\/[\w-]+\/(catalogue)(?:\/(?:(t|s)\/([\w-]+)|([\w-]+)))?/.exec(location.hash);
    // A project's own root is its home page.
    if (!m) return { page: 'home', entity: null };
    return { page: 'catalogue', type: m[2] === 't' ? m[3] : null, seq: m[2] === 's' ? m[3] : null, entity: m[4] || null };
  }

  // Where the page is: a workspace's top level (#/w/<workspace>), or a folder (#/f/<id>…). With neither
  // (#/), it is the workspace last shown, the shared one to begin with. A playlist outside a project
  // (#/pl/<id>) is in the folder, or at the top of the workspace, that keeps it.
  function route() {
    const pl = currentLoose();
    if (pl) return pl.folderId && folderById(pl.folderId) ? { kind: 'folder', id: pl.folderId } : { kind: 'space', space: pl.workspace };
    const f = currentFolder();
    if (f) return { kind: 'folder', id: f };
    const w = /^#\/w\/(myreze|personal)/.exec(location.hash);
    if (w && (w[1] === 'myreze' || hasPersonal)) return { kind: 'space', space: w[1] };
    return { kind: 'space', space };
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
    return !f || !f.project || ['reviews', 'home'].includes(currentView().page);
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
    await api('PATCH', `/api/${{ board: 'boards', playlist: 'playlists' }[kind] || 'folders'}/${thing.id}`, { workspace: otherSpace(thing.workspace) });
    await refresh();
  }

  // One thing put in a folder (null: the top of its workspace). A playlist or an animatic of a project goes to
  // a folder of its reviews, the project itself being their top.
  function moveCall(kind, id, folderId) {
    if (kind === 'board') return api('PATCH', `/api/boards/${id}`, { folderId });
    if (kind === 'playlist') return api('PATCH', `/api/playlists/${id}`, { folderId });
    if (kind === 'animatic') return api('PATCH', `/api/animatics/${id}`, { folderId });
    return api('PATCH', `/api/folders/${id}`, { parentId: folderId });
  }
  async function moveTo(kind, id, folderId) {
    await moveCall(kind, id, folderId);
    // A project's playlists and animatics come with its catalogue.
    const proj = folderId && trailTo(folderId).find((f) => f.project);
    if (proj && (kind === 'playlist' || kind === 'animatic')) {
      playlistData.delete(id);
      await loadCatalogue(proj.id, true);
      shownProject = '';
    }
    await refresh();
  }

  // ------------------------------------------------------------- drag and drop

  // What is being dragged: a board, a folder, a playlist outside a project, or one of a project's playlists
  // and animatics (which say which project, and where among its reviews they are kept).
  const dragged = () => dragging && (dragging.thing || (dragging.kind === 'folder' ? folderById(dragging.id) : dragging.kind === 'playlist' ? loose(dragging.id) : everything.boards.find((x) => x.id === dragging.id)));

  // `ws` is the workspace of the place dropped on. Into another workspace goes to its top level.
  function canDrop(folderId, ws = space) {
    const thing = dragged();
    if (!thing) return false;
    // A project's playlist or animatic stays among its reviews; one outside a project stays out of them.
    if (thing.projectId) return (folderId === thing.projectId || (!!folderId && isWithin(folderId, thing.projectId))) && thing.folderId !== folderId;
    if (dragging.kind === 'playlist' && folderId && inProject(folderId)) return false;
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
      (!thing.projectId && thing.workspace !== ws ? moveSpace(kind, thing) : moveTo(kind, id, folderId)).catch(fail);
    });
  }

  function draggable(node, kind, id, thing = null) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      dragging = { kind, id, thing };
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


  // ------------------------------------------------------------- objects
  //
  // Everything the app lists is an object, as a file manager lists files: a board, a folder, an asset,
  // set or shot, a version. Each kind only says what it is made of (a spec, made
  // by boardObj, folderObj, entityObj and versionObj), and one component shows any of them as
  // the layout in force has it (WB.layout, the switch in the bar): a card, a compact row (a card made
  // small, style.css), or a row of a table. objectList shows a list of them, objectTable puts the lists
  // of a page with groups under one row of headings, and groupHead heads a group as the catalogue does.
  //
  // A spec: {
  //   kind                   'board' | 'folder' | 'entity' | 'version'
  //   tag, attrs, state      its element (an a with its href, or a div), its attributes, and classes that
  //                          say what state it is in (archived, a project), on a card and a row alike
  //   picked, pick(range)    whether it is selected, and what selects it (a row's box; none where
  //                          nothing is selected)
  //   still | icon           its picture (a .card-thumbs, scrubbed and played as it is), or an icon
  //   box                    a card's own box over its picture
  //   name, title            its name: text, or nodes (a link to its shot)
  //   lines                  on a card, the lines under the name: text, or nodes as they are
  //   aside, cells           in a table, where a row is one line: a short word beside its name (archived,
  //                          who is on it now), and its columns by key: text, [text, its tooltip], or a node
  //   menu, setup(node)      what its … menu has, and what more is done to what is made (dragging)
  // }
  const OBJ_CARD = { board: '', folder: 'folder', entity: 'ent', version: 'ver', playlist: 'playlist' };
  // A table's columns: [key, heading, { w: its width in the grid (phone: on a phone), end: set against its end (numbers),
  // drop: how soon a narrower table leaves it out (1 first; 4 only on a phone), sort: what a click on its
  // heading sorts by, where the list can be sorted }]. The box, the picture, the name and the menu are
  // in every table, the box over the picture as on a compact card.
  const col = (key, title, opt = {}) => [key, title, opt];
  const cols = (mid, name = {}) => [col('still', '', { w: '84px', phone: '64px' }),
    col('name', 'Name', { w: 'minmax(220px, 3fr)', ...name }), ...mid, col('menu', '', { w: '32px' })];
  const OBJ_COLS = {
    board: cols([col('items', 'Items', { w: '64px', end: true, drop: 2 }), col('changed', 'Edited', { w: '120px', drop: 3 })]),
    folder: cols([col('kind', 'Kind', { w: '88px', drop: 2 }), col('boards', 'Boards', { w: '64px', end: true, drop: 3 }), col('folders', 'Folders', { w: '64px', end: true, drop: 1 })]),
    entity: cols([col('versions', 'Versions', { w: '72px', end: true, drop: 2 }), col('artists', 'Artists', { w: 'minmax(96px, 1.2fr)', drop: 1 }), col('changed', 'Last filed', { w: '120px', drop: 3 })]),
    version: cols([col('task', 'Task', { w: 'minmax(64px, 1fr)', drop: 3 }), col('ver', 'Version', { w: '64px', end: true, drop: 4, sort: 'number' }),
      col('artist', 'Artist', { w: 'minmax(72px, 1fr)', drop: 2 }),
      col('by', 'Filed by', { w: 'minmax(104px, 1.2fr)', drop: 3 }), col('changed', 'Filed', { w: '128px', drop: 4, sort: 'new' })], { sort: 'name' }),
    // The versions of a playlist outside a project: no task or artist, only who added each and when.
    clip: cols([col('by', 'Added by', { w: 'minmax(104px, 1.2fr)', drop: 2 }), col('changed', 'Added', { w: '128px', drop: 3 })]),
    // A project's reviews, boards and playlists together: what each is, how much is on it, when it changed.
    review: cols([col('kind', 'Kind', { w: '88px', drop: 2 }), col('items', 'Items', { w: '64px', end: true, drop: 1 }), col('changed', 'Changed', { w: '120px', drop: 3 })]),
  };
  // A table's grid at each of five steps, each leaving out more (the columns it keeps; at the last, at
  // their `phone` width). The table takes the first step whose columns fit how wide it is, measured as it
  // changes (data-level; style.css lays it out).
  const VT_GAP = 20;
  const vtMin = (w) => Number((/(\d+)px/.exec(w) || [0, 0])[1]);
  const vtFit = new ResizeObserver((seen) => {
    for (const { target, contentRect } of seen) {
      const mins = target.dataset.mins.split(',').map(Number);
      const level = mins.findIndex((m) => m <= contentRect.width);
      target.dataset.level = String(level < 0 ? 4 : level);
    }
  });
  function vtColumns(node, list) {
    const mins = [];
    for (let level = 0; level <= 4; level++) {
      const kept = list.filter(([, , o]) => !o.drop || o.drop > level).map(([, , o]) => (level === 4 && o.phone) || o.w);
      node.style.setProperty(`--vt${level}`, kept.join(' '));
      mins.push(kept.reduce((n, w) => n + vtMin(w), 0) + VT_GAP * (kept.length - 1));
    }
    node.dataset.mins = mins.join(',');
    node.dataset.level = '0';
    vtFit.observe(node);
    return node;
  }
  const vtText = (v) => (v instanceof Node ? v : Array.isArray(v) ? el('span', { class: 'vt-main', text: v[0], title: v[1] || v[0] })
    : v != null && v !== '' && v !== false && el('span', { class: 'vt-main', text: String(v), title: String(v) }));

  // An object as the layout in force shows it. `list` is the columns of the table it is in.
  function objectNode(o, list = OBJ_COLS[o.kind]) {
    if (o.kind === 'new') return newNode(o);
    const nameNode = el('div', { class: 'card-name', title: o.title || (typeof o.name === 'string' ? o.name : null) }, o.name);
    const cls = (base) => [base, 'obj', `obj-${o.kind}`, o.state, o.picked && 'picked'].filter(Boolean).join(' ');
    let node;
    if (WB.layout() !== 'table') {
      node = el(o.tag || 'div', { ...o.attrs, class: cls(`card ${OBJ_CARD[o.kind]}`.trim()) },
        o.box,
        o.still || el('div', { class: 'folder-icon', html: o.icon }),
        el('div', { class: 'card-body' }, nameNode, (o.lines || []).map((x) => (x instanceof Node ? x : x && el('div', { class: 'card-meta', text: x })))),
        o.menu && menuButton(o.menu));
    } else {
      node = el(o.tag || 'div', { ...o.attrs, class: cls('vt-row') }, list.map(([key, , opt]) => {
        const kids = key === 'still' ? [o.still || el('span', { class: 'vt-icon', html: o.icon }), o.pick && el('button', {
          type: 'button', class: 'vt-box', 'aria-label': `Select ${o.title || o.name}`, title: 'Select',
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); o.pick(e.shiftKey); },
        })]
            : key === 'name' ? [nameNode, o.aside && [].concat(o.aside).some(Boolean) && el('span', { class: 'vt-aside' },
              [].concat(o.aside).filter(Boolean).map((x) => (x instanceof Node ? x : el('span', { text: x }))))]
              : key === 'menu' ? o.menu && menuButton(o.menu)
                : vtText((o.cells || {})[key]);
        return el('div', { class: `vt-c vt-${key}${opt.end ? ' end' : ''}${opt.drop ? ` vt-d${opt.drop}` : ''}` }, kids);
      }));
    }
    if (o.setup) o.setup(node);
    return node;
  }
  // The first of a list, that adds to it (New board, Add versions): a dashed card, or a row of the table.
  function newNode({ name, meta, title, onclick }) {
    if (WB.layout() === 'table') {
      return el('button', { type: 'button', class: 'vt-add', title, onclick },
        el('span', { class: 'vt-add-plus', html: icon('plus', 16) }), el('span', { class: 'card-name', text: name }), el('span', { class: 'card-meta', text: meta }));
    }
    return el('button', { type: 'button', class: 'card new', title, onclick },
      el('span', { class: 'new-thumb' }, el('span', { class: 'plus', html: icon('plus', 18) })),
      el('span', { class: 'card-body' }, el('span', { class: 'card-name', text: name }), el('span', { class: 'card-meta', text: meta })));
  }

  // A table's headings, kept in sight as it scrolls. Where the list can be sorted (`sort`, `onSort`), a
  // heading that sorts says so and which way; Filed turns newest first into oldest first and back. `all`
  // is a box for everything shown.
  function objectHead(list, { sort, onSort, all } = {}) {
    return el('div', { class: 'vt-head' }, list.map(([key, title, opt]) => {
      const cls = `vt-c vt-${key}${opt.end ? ' end' : ''}${opt.drop ? ` vt-d${opt.drop}` : ''}`;
      if (key === 'still') return el('div', { class: cls }, all || null);
      if (!opt.sort || !onSort) return el('div', { class: cls }, el('span', { text: title }));
      const by = opt.sort;
      const on = by === 'new' ? sort === 'new' || sort === 'old' : sort === by;
      const next = by === 'new' && sort === 'new' ? 'old' : by;
      return el('div', { class: cls }, el('button', {
        type: 'button', class: `vt-sort${on ? ` on ${sort === 'old' || by !== 'new' ? 'up' : 'down'}` : ''}`,
        title: `Sort by ${title.toLowerCase()}${by === 'new' ? (next === 'old' ? ', oldest first' : ', newest first') : ''}`, onclick: () => onSort(next),
      }, el('span', { text: title }), el('i', { class: 'vt-arrow', 'aria-hidden': 'true' })));
    }));
  }
  // Some objects of one kind, as the layout in force shows them: a grid of cards (`grid`, its
  // classes), or a table with its headings. `lead` goes first ({ name, meta, title, onclick }: New board).
  // `bare` gives the rows alone, for a table that objectTable heads.
  function objectList(kind, specs, { grid = 'board-grid', lead, bare = false, ...head } = {}) {
    const list = OBJ_COLS[kind];
    const nodes = [lead && newNode(lead), ...specs.filter(Boolean).map((o) => objectNode(o, list))];
    if (WB.layout() !== 'table') return el('div', { class: grid }, nodes);
    const body = el('div', { class: 'vt-body' }, nodes);
    return bare ? body : vtColumns(el('div', { class: 'vt' }, objectHead(list, head), body), list);
  }
  // A page's lists of one kind with their groups' headings between them, under one row of headings so
  // that every group's columns line up (the catalogue, Versions). Its lists are objectList(…, { bare: true }).
  const objectTable = (kind, kids, head = {}) => vtColumns(el('div', { class: 'vt' }, objectHead(OBJ_COLS[kind], head), kids), OBJ_COLS[kind]);

  // The heading of a group of objects, as the catalogue heads them: a section ("Shots 25", and a line to
  // the edge; `extra` after it), or within one (`level` 2), a smaller one in capitals (a sequence, who
  // filed a run of versions) with `sub` beside it. `box` selects all of the group, `avatar` says whose.
  function groupHead(text, { n = null, level = 1, box = null, avatar = null, sub = null, extra = [] } = {}) {
    if (level === 2) return el('div', { class: 'seq-label' }, box, avatar, el('span', { text }), sub && el('span', { class: 'seq-sub', text: sub }), ...extra);
    return el('div', { class: 'section-label' }, box, avatar, text, n != null && el('span', { class: 'tally', text: String(n) }), ...extra);
  }
  const label = (text, n, ...extra) => groupHead(text, { n, extra });

  // Resolves with a folder id, null for the top level, or undefined if dismissed. With a `root` (a project),
  // only the folders of its reviews are offered, the project itself standing for their top.
  function pickFolder({ title, exclude, current, root = null }) {
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
      if (root) {
        add(root.id, 'Reviews', 0);
        walk(root.id, 1);
      } else {
        add(null, spaceName(space), 0);
        walk(null, 1);
      }
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
    const name = await WB.dialog({ title: `Rename ${kind}`, value: thing.name, placeholder: 'Name', ok: 'Rename' });
    if (!name || name === thing.name) return;
    await api('PATCH', `/api/${{ board: 'boards', playlist: 'playlists' }[kind] || 'folders'}/${thing.id}`, { name });
    if (kind === 'playlist') playlistData.delete(thing.id);
    refresh();
  }

  async function moveDialog(kind, thing, project = null) {
    const target = await pickFolder({
      title: `Move "${thing.name}" to`,
      exclude: kind === 'folder' ? thing.id : null,
      current: kind === 'folder' ? thing.parentId : project ? reviewHome(project, thing) : thing.folderId,
      root: project,
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
      text: 'Only the folder is removed. What is in it moves up one level.',
      ok: 'Delete folder',
      danger: true,
    });
    if (!sure) return;
    await api('DELETE', `/api/folders/${folder.id}`);
    refresh();
  }

  // A project goes whole, and for good: only an admin can, and only having typed its name.
  async function removeProject(project) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    const filed = cat && cat.entities ? cat.entities.length : 0;
    const typed = await WB.dialog({
      title: `Delete the project “${project.name}”?`,
      text: `Its catalogue${filed ? ` (${plural(filed, 'asset, set or shot', 'assets, sets and shots')})` : ''}, every version and every comment on them, its playlists and animatics go for good, for everyone. Its boards and folders are deleted with it. Type its name to delete it.`,
      value: '', placeholder: project.name, ok: 'Delete project', danger: true,
    });
    if (typed === null) return;
    if (typed !== project.name) return WB.toast('The name typed is not the project’s, so nothing was deleted', { ms: 5000 });
    await api('DELETE', `/api/folders/${project.id}`);
    catalogues.delete(project.id);
    if (currentFolder() && isWithin(currentFolder(), project.id)) location.hash = project.parentId ? WB.href.folder(project.parentId) : WB.href.space(project.workspace);
    await refresh();
    WB.toast(`“${project.name}” is deleted`);
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
        text: 'A project keeps a catalogue: its assets, sets and shots, and every version filed of them, from its boards or dropped straight into it. It stays one once something is filed in it, and only an admin can delete it.',
        ok: 'Make it a project',
      });
      if (!sure) return;
    }
    await api('PATCH', `/api/folders/${folder.id}`, { project: on });
    await refresh();
    if (on) location.hash = WB.href.catalogue(folder.id);
  }

  // A project's settings: whether its versions are counted by task, whether they are shown more than one
  // way and which ways (its passes, the main one first), the names from elsewhere it has learned to read,
  // and its 3D preview: the model of the venue its work is shown on, the material its projection
  // surface has, and which pass of a version goes on it. Set here once, they are never asked about
  // again: the player just has a 2D / 3D switch.
  async function projectSettings(project) {
    const was = (project.settings && project.settings.preview3d) || null;
    const byTask = el('input', { type: 'checkbox', class: 'switch', ...(!(project.settings && project.settings.tasks === false) && { checked: true }), 'aria-label': 'Count versions by task' });
    // What it has learned of file names from elsewhere, a row each between hairlines: the name it was learned
    // from, what that was filed as, and under them how every name like it is read (its words, where the
    // sequence, the shot and the version are, … for what changes). Forgotten with its ×. Only there once
    // there are some.
    let rules = [...((project.settings && project.settings.rules) || [])];
    const ruleList = el('ul', { class: 'ps-rules' });
    const PART = { '{seq}': 'sequence', '{version}': 'version', '{task}': 'task', '{pass}': 'pass' };
    const reads = (r) => (r.pattern
      ? r.pattern.map((t) => (PART[t] ? el('i', { text: PART[t] }) : t.startsWith('{shot') ? el('i', { text: `${t.slice(6, -1)}shot` }) : t === '*' ? '…' : t))
      : [r.word, el('i', { text: r.seq ? 'shot' : 'anything' })]);
    const paintRules = () => {
      ruleList.replaceChildren(...rules.map((r) => {
        const from = r.pattern ? r.like : `${r.word}${r.seq && !r.glued ? '_' : ''}${r.seq ? '010' : '…'}`;
        const as = r.pattern ? r.as : r.seq ? N.shotName(r.seq, 10) : r.name;
        const shape = reads(r).flatMap((x, i) => (i ? [el('span', { class: 'ps-rule-sep', text: '_' }), x] : [x]));
        return el('li', { class: 'ps-rule' },
          el('div', { class: 'ps-rule-main' },
            el('code', { class: 'ps-rule-from', text: from, title: from }),
            el('span', { class: 'ps-rule-arrow', html: icon('arrow', 12) }),
            el('b', { class: 'ps-rule-as', text: as })),
          el('div', { class: 'ps-rule-shape' }, el('span', { text: 'Reads ' }), ...shape),
          el('button', { type: 'button', class: 'iconbtn mini ps-rule-x', html: icon('close', 12), title: `Forget ${N.ruleText(r)}`, 'aria-label': `Forget ${N.ruleText(r)}`, onclick: () => { rules = rules.filter((x) => x !== r); paintRules(); } }));
      }));
      if (rulesRow) rulesRow.hidden = !rules.length;
    };
    let rulesRow = null;
    let model = was ? { url: was.model, name: was.name || 'Model' } : null;
    // Its banner: the picture over the title of its home page.
    let banner = (project.settings && project.settings.banner) || null;
    let bannerAt = (project.settings && project.settings.bannerAt) || [50, 50];
    // Shown cut as the home cuts it. Dragged (or moved with the arrow keys), the picture slides in its band to
    // choose what is kept in sight; a double-click puts it back in the middle.
    const bannerShow = el('div', { class: 'ps-banner', tabindex: '0', 'aria-label': 'Where the banner is cut. Drag it, or use the arrow keys' });
    const placeBanner = () => {
      const img = bannerShow.querySelector('img');
      if (img) img.style.objectPosition = bannerPlace(bannerAt);
    };
    // How far the picture reaches past the band each way, in pixels: what a drag can move across.
    const bannerSpare = () => {
      const img = bannerShow.querySelector('img');
      if (!img || !img.naturalWidth) return [0, 0];
      const k = Math.max(bannerShow.clientWidth / img.naturalWidth, bannerShow.clientHeight / img.naturalHeight);
      return [img.naturalWidth * k - bannerShow.clientWidth, img.naturalHeight * k - bannerShow.clientHeight];
    };
    const moveBanner = (dx, dy) => {
      const [sx, sy] = bannerSpare();
      bannerAt = [sx ? bannerAt[0] - (dx / sx) * 100 : bannerAt[0], sy ? bannerAt[1] - (dy / sy) * 100 : bannerAt[1]].map((v) => Math.min(100, Math.max(0, v)));
      placeBanner();
    };
    bannerShow.addEventListener('pointerdown', (e) => {
      if (!banner || e.button !== 0) return;
      e.preventDefault();
      bannerShow.setPointerCapture(e.pointerId);
      bannerShow.classList.add('held');
      let last = [e.clientX, e.clientY];
      const move = (m) => {
        moveBanner(m.clientX - last[0], m.clientY - last[1]);
        last = [m.clientX, m.clientY];
      };
      const up = () => {
        bannerShow.classList.remove('held');
        bannerShow.removeEventListener('pointermove', move);
        bannerShow.removeEventListener('pointerup', up);
        bannerShow.removeEventListener('pointercancel', up);
      };
      bannerShow.addEventListener('pointermove', move);
      bannerShow.addEventListener('pointerup', up);
      bannerShow.addEventListener('pointercancel', up);
    });
    bannerShow.addEventListener('keydown', (e) => {
      const by = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!by || !banner) return;
      e.preventDefault();
      // A step is a twentieth of what there is to move across; the picture moves the way the arrow points.
      const [sx, sy] = bannerSpare();
      moveBanner(by[0] * sx / 20, by[1] * sy / 20);
    });
    bannerShow.addEventListener('dblclick', () => {
      bannerAt = [50, 50];
      placeBanner();
    });
    const bannerPick = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/avif', hidden: true });
    const bannerChoose = el('button', { type: 'button', class: 'btn small', onclick: () => bannerPick.click() });
    const bannerRemove = el('button', { type: 'button', class: 'btn small ghost', text: 'Remove', onclick: () => { banner = null; paintBanner(); } });
    const paintBanner = (saying) => {
      bannerShow.replaceChildren(banner && !saying ? el('img', { src: banner, alt: '', draggable: 'false' }) : el('span', { text: saying || 'No banner' }));
      placeBanner();
      bannerShow.classList.toggle('none', !banner || !!saying);
      bannerChoose.textContent = banner ? 'Replace…' : 'Choose a picture…';
      bannerRemove.hidden = !banner;
    };
    bannerPick.addEventListener('change', async () => {
      const f = bannerPick.files[0];
      bannerPick.value = '';
      if (!f) return;
      save.disabled = bannerChoose.disabled = true;
      try {
        const up = await WBIngest.upload(await bannerFile(f), '.jpg', (k) => paintBanner(`Uploading ${f.name}… ${Math.round(k * 100)}%`));
        banner = up.url;
        bannerAt = [50, 50];
      } catch (err) {
        WB.toast(`${f.name} could not be used: ${err.message}`, { ms: 6000 });
      }
      save.disabled = bannerChoose.disabled = false;
      paintBanner();
    });
    paintBanner();
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    // The order of its sequences, first to last: as set, then any it has that the order does not name yet,
    // by name. Moved with the arrows beside each; By name puts them back in the order their names sort.
    const seqNames = [...new Set(((cat && cat.entities) || []).filter((e) => e.type === 'shot' && N.seqOf(e.name)).map((e) => N.seqOf(e.name)))];
    let seqs = seqNames.slice().sort(seqSort(project));
    const seqList = el('ol', { class: 'ps-seqs' });
    const paintSeqs = () => seqList.replaceChildren(...seqs.map((q, i) => {
      const move = (by) => {
        const next = seqs.slice();
        next.splice(i + by, 0, ...next.splice(i, 1));
        seqs = next;
        paintSeqs();
        seqList.querySelectorAll('.ps-seq')[i + by]?.querySelector(by < 0 ? '.up' : '.down')?.focus();
      };
      return el('li', { class: 'ps-seq' },
        el('span', { class: 'ps-seq-n', text: String(i + 1) }),
        el('span', { class: 'ps-seq-name', text: q }),
        el('button', { type: 'button', class: 'iconbtn mini up', html: icon('chevron', 14), title: `Move ${q} up`, 'aria-label': `Move ${q} up`, disabled: i === 0, onclick: () => move(-1) }),
        el('button', { type: 'button', class: 'iconbtn mini down', html: icon('chevron', 14), title: `Move ${q} down`, 'aria-label': `Move ${q} down`, disabled: i === seqs.length - 1, onclick: () => move(1) }));
    }));
    const seqReset = el('button', { type: 'button', class: 'btn small ghost', text: 'By name', title: 'Put them in the order their names sort', onclick: () => { seqs = seqNames.slice().sort(N.seqOrder()); paintSeqs(); } });
    paintSeqs();
    // Its passes, as set.
    const list = (cat && cat.passList) || null;
    const byPass = el('input', { type: 'checkbox', class: 'switch', ...(list && { checked: true }), 'aria-label': 'Several passes of each version' });
    const passNames = el('input', { type: 'text', value: (list || []).join(', '), placeholder: 'cmp, bty', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Its passes, the main one first' });
    const named = () => [...new Set(passNames.value.split(/[\s,]+/).map((v) => N.tokenize(v)).filter(Boolean))];
    const file = el('span', { class: 'ps-file' });
    const picker = el('input', { type: 'file', accept: '.glb,model/gltf-binary', hidden: true });
    const choose = el('button', { type: 'button', class: 'btn small', onclick: () => picker.click() });
    const remove = el('button', { type: 'button', class: 'btn small ghost', text: 'Remove', onclick: () => { model = null; paint(); } });
    const screen = el('input', { type: 'text', value: (was && was.screen) || 'screen', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Material of the projection surface' });
    const pass = el('select', { 'aria-label': 'Which pass goes on the model' });
    // Which of the model's cameras the 3D view opens through, from those its file names.
    const camera = el('select', { 'aria-label': 'The camera the 3D view opens through' });
    let cameras = []; // { name, across }: its lens in degrees across
    let camerasRead = false;
    let cameraRow = null;
    // The lens the 3D view flies through, in degrees across. Left empty, the main camera's own, which it shows;
    // a model with no camera is seen through a stand-in 79° across (view3d.js).
    const fov = el('input', { type: 'number', class: 'ps-num', min: '10', max: '120', step: '1', value: was && was.fov ? String(was.fov) : '', 'aria-label': 'Field of view flying, in degrees across' });
    const fovSays = el('span');
    const paintFov = () => {
      const main = cameras.find((c) => c.name === camera.value);
      const across = main ? main.across : cameras.length || !camerasRead ? null : 79;
      fov.placeholder = across ? String(across) : '';
      fovSays.textContent = `Degrees across the 3D view as you see it, as in Unreal, once it leaves a camera to fly.${across ? ` Unless set, ${across}°: the main camera's` : ' Unless set, the main camera\'s'}`;
    };
    const paintCameras = () => {
      const chosen = camera.value || (was && was.camera) || '';
      const names = cameras.map((c) => c.name);
      const pick = names.includes(chosen) ? chosen : names.find((c) => c.toLowerCase() === 'main') || names[0] || '';
      camera.replaceChildren(...names.map((c) => el('option', { value: c, text: c, ...(c === pick && { selected: true }) })));
      if (cameraRow) cameraRow.hidden = !model || cameras.length < 2;
      paintFov();
    };
    camera.addEventListener('change', paintFov);
    const readCameras = async (from) => {
      cameras = from ? await glbCameras(from).catch(() => []) : [];
      camerasRead = !!from;
      paintCameras();
    };
    // The ways it can show a version on the model: its passes as they are being set here, the main one first.
    const paintPasses = () => {
      const now = byPass.checked && named().length > 1 ? named() : null;
      const chosen = pass.value || (was ? was.pass || '' : '');
      pass.replaceChildren(...[['', now ? `${now[0]} (main)` : 'Main pass'], ...(now || []).slice(1).map((v) => [v, v])]
        .map(([v, t]) => el('option', { value: v, text: t, ...(chosen === v && { selected: true }) })));
      if (passesRow) passesRow.hidden = !byPass.checked;
      if (pictureRow) pictureRow.hidden = !model || !now;
    };
    let passesRow = null;
    let pictureRow = null;
    byPass.addEventListener('change', paintPasses);
    passNames.addEventListener('input', paintPasses);
    paintPasses();
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save' });
    const paint = () => {
      file.textContent = model ? model.name : 'No model';
      file.classList.toggle('none', !model);
      choose.textContent = model ? 'Replace…' : 'Choose a .glb…';
      remove.hidden = !model;
      // What goes with a model, only once there is one.
      surfaceRow.hidden = fovRow.hidden = !model;
      paintCameras();
      paintPasses();
    };
    picker.addEventListener('change', async () => {
      const f = picker.files[0];
      picker.value = '';
      if (!f) return;
      save.disabled = choose.disabled = true;
      try {
        const up = await WBIngest.upload(f, '.glb', (k) => { file.textContent = `Uploading ${f.name}… ${Math.round(k * 100)}%`; });
        model = { url: up.url, name: f.name };
        camera.value = '';
        await readCameras(f);
      } catch (err) {
        WB.toast(`${f.name} could not be uploaded: ${err.message}`, { ms: 6000 });
      }
      save.disabled = choose.disabled = false;
      paint();
    });
    // A setting: what it is, and a few words more when it needs them. A switch or a button sits beside
    // it (`row`); a field or a list goes under it, the width of its pane (`field`), with anything that
    // acts on the whole list (`act`) beside its name.
    const heading = (label, hint) => el('div', { class: 'ps-label' }, el('b', { text: label }), hint && el('span', { text: hint }));
    const row = (label, hint, ...control) => el('div', { class: 'ps-row' }, heading(label, hint), el('div', { class: 'ps-control' }, ...control));
    const field = (label, hint, control, act = null) => el('div', { class: 'ps-field' }, el('div', { class: 'ps-field-head' }, heading(label, hint), act), control);
    passesRow = field('Passes', 'The main one first: a file of it is a version, the others go with one', passNames);
    const surfaceRow = field('Screen material', 'What the screens are called in the model', screen);
    cameraRow = field('Main camera', 'Where the work is judged from: the 3D view opens through it', camera);
    const fovRow = el('div', { class: 'ps-row' }, el('div', { class: 'ps-label' }, el('b', { text: 'Field of view flying' }), fovSays),
      el('div', { class: 'ps-control' }, fov, el('span', { class: 'ps-unit', text: '°' })));
    pictureRow = field('On the screens', 'Which pass of a version is shown', pass);
    rulesRow = field('Learned file names', 'Names from elsewhere, read this way when filing. Forget one with its ×', ruleList);
    paintRules();
    // The settings go in tabs, one to each part of the project they set, listed down the side (across the
    // top on a phone) so more can come. The dialog opens on the tab last looked at.
    const tabs = WB.settingTabs('project', [
      {
        id: 'home', label: 'Home', icon: 'home', hint: 'How its home page looks',
        rows: [field('Banner', 'A picture across the top of its home, over its title. Drag it to choose what shows where it is cut', el('div', { class: 'ps-banner-box' }, bannerShow, el('div', { class: 'ps-banner-acts' }, bannerChoose, bannerRemove, bannerPick)))],
      },
      {
        id: 'versions', label: 'Versions', icon: 'stack', hint: 'How versions are counted, shown and read from file names',
        rows: [
          row('Count by task', 'anim v1, lighting v1… rather than one count', byTask),
          row('Several passes of each version', 'Each version as more than one file: cmp and bty, say', byPass),
          viewsRow,
          rulesRow,
        ],
      },
      {
        id: 'sequences', label: 'Sequences', icon: 'film', hint: 'How the shots are put together',
        rows: [seqNames.length > 1
          ? field('Order', 'First to last, as every list shows them and a new animatic puts them', seqList, seqReset)
          : el('p', { class: 'ps-empty', text: 'Once the project has two sequences or more, their order is set here.' })],
      },
      {
        id: '3d', label: '3D', icon: 'cube', hint: 'The venue the work is shown on',
        rows: [
          field('Venue model', 'A .glb with its screens and cameras: the player gets a 2D / 3D switch', el('div', { class: 'ps-model' }, el('span', { class: 'ps-model-icon', html: icon('cube', 16) }), file, choose, remove, picker)),
          surfaceRow,
          cameraRow,
          fovRow,
          pictureRow,
        ],
      },
      {
        id: 'sharing', label: 'Sharing', icon: 'people', hint: 'Who has what of the project, and the links to it',
        rows: [sharingPane(project)],
      },
    ]);
    const dlg = el('dialog', { class: 'dlg ps-dlg' },
      el('form', {
        method: 'dialog',
        onsubmit: async (e) => {
          e.preventDefault();
          if (byPass.checked && named().length < 2) {
            WB.toast('Name at least two passes, the main one first: cmp, bty', { ms: 6000 });
            tabs.show('versions');
            passNames.focus();
            return;
          }
          save.disabled = true;
          try {
            await api('PATCH', `/api/folders/${project.id}`, { settings: { banner, ...(banner && { bannerAt: bannerAt.map((v) => Math.round(v * 10) / 10) }), tasks: byTask.checked, passes: byPass.checked ? named() : false, rules, seqs, preview3d: model ? { model: model.url, name: model.name, screen: screen.value.trim() || 'screen', pass: pass.value, camera: camera.value, fov: Number(fov.value) || 0 } : null } });
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
      el('div', { class: 'ps-head' }, el('span', { class: 'ps-where', text: project.name }), el('h2', { text: 'Project settings' })),
      el('div', { class: 'ps-body' }, tabs.nav, tabs.panes),
      el('div', { class: 'dlg-actions' }, el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }), save)));
    dlg.addEventListener('close', () => dlg.remove());
    paint();
    if (model) readCameras(model.url);
    document.body.append(dlg);
    dlg.showModal();
  }

  // A project's Sharing tab: the permissions given on it and on what is in it (people and groups, each with
  // a role, as the admin area sets them; recorded, not yet enforced), the boards in it open to anyone with
  // their link, and the links to watch it presented. An admin gives and takes away permissions here, at
  // once; anyone else sees it all, greyed, with their controls out of reach.
  function sharingPane(project) {
    const box = el('div', { class: 'ps-share' }, el('p', { class: 'ps-empty', text: 'Loading…' }));
    const ROLE = { viewer: 'Can view', commenter: 'Can comment', editor: 'Can edit', manager: 'Manages' };
    const field = (label, hint, ...kids) => el('div', { class: 'ps-field' }, el('div', { class: 'ps-field-head' }, el('div', { class: 'ps-label' }, el('b', { text: label }), hint && el('span', { text: hint }))), ...kids);
    const until = (at) => (at ? `until ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : '');
    async function paint() {
      let s;
      try {
        s = await api('GET', `/api/folders/${project.id}/sharing`);
      } catch (err) {
        box.replaceChildren(el('p', { class: 'ps-empty', text: err.message }));
        return;
      }
      const locked = !s.canEdit;
      box.classList.toggle('locked', locked);
      const change = async (method, path, body) => {
        try {
          await api(method, path, body);
        } catch (err) {
          WB.toast(err.message, { ms: 6000 });
        }
        paint();
      };
      const grantRow = (g) => el('li', { class: 'ps-grant' },
        el('span', { class: 'ps-grant-ic', html: icon(g.principal.type === 'group' ? 'people' : 'person', 16) }),
        el('span', { class: 'ps-grant-who', title: g.principal.type === 'group' ? g.principal.members.join(', ') || 'Nobody in it yet' : g.principal.email },
          el('b', { text: g.principal.name }),
          el('span', { text: [g.principal.type === 'group' && plural(g.principal.members.length, 'person', 'people'), g.target.name && `on ${g.target.name}`].filter(Boolean).join(' · ') })),
        el('span', { class: 'ps-grant-role', text: ROLE[g.role] || g.role }),
        el('button', {
          type: 'button', class: 'iconbtn mini', html: icon('close', 12), disabled: locked,
          title: `Take ${g.principal.name}’s permission away`, 'aria-label': `Take ${g.principal.name}’s permission away`,
          onclick: () => change('DELETE', `/api/admin/grants/${g.id}`),
        }));
      // Giving one: who (a person or a group), and what they may do with the whole project.
      const who = el('select', { 'aria-label': 'Person or group', disabled: locked },
        el('option', { value: '', text: 'Person or group…' }),
        (s.users || []).length > 0 && el('optgroup', { label: 'People' }, ...s.users.map((u) => el('option', { value: `user:${u.email}`, text: u.name ? `${u.name} (${u.email})` : u.email }))),
        (s.groups || []).length > 0 && el('optgroup', { label: 'Groups' }, ...s.groups.map((g) => el('option', { value: `group:${g.id}`, text: `${g.name} (${plural(g.members, 'person', 'people')})` }))));
      const role = el('select', { 'aria-label': 'Role', disabled: locked }, ...s.roles.map((r) => el('option', { value: r, text: ROLE[r] || r })));
      const add = el('button', {
        type: 'button', class: 'btn small', text: 'Give', disabled: true,
        onclick: () => {
          const [type, ...id] = who.value.split(':');
          change('POST', '/api/admin/grants', { target: { type: 'folder', id: project.id }, principal: { type, id: id.join(':') }, role: role.value });
        },
      });
      who.addEventListener('change', () => { add.disabled = locked || !who.value; });
      box.replaceChildren(...[
        locked && el('p', { class: 'ps-lock' }, el('span', { html: icon('lock', 14) }), el('span', { text: 'Only an admin can change who has access.' })),
        s.shared
          ? field('People and groups', 'Their permissions on the project and on what is in it. Recorded, not yet enforced: everyone signed in sees the whole Myreze workspace',
            s.grants.length ? el('ul', { class: 'ps-grants' }, ...s.grants.map(grantRow)) : el('p', { class: 'ps-empty', text: 'Nobody has been given a permission on it yet.' }),
            el('div', { class: 'ps-give' }, who, role, add),
            s.canEdit && !(s.users || []).length && !(s.groups || []).length && el('p', { class: 'ps-empty' }, 'Nobody to choose yet: add people and groups in the ', el('a', { href: '/admin', text: 'admin area' }), '.'))
          : el('p', { class: 'ps-empty', text: 'The project is in a personal workspace: only its owner sees it.' }),
        s.links.length > 0 && field('Links', 'Boards in it that anyone holding their link can open',
          el('ul', { class: 'ps-grants' }, ...s.links.map((l) => el('li', { class: 'ps-grant' },
            el('span', { class: 'ps-grant-ic', html: icon('link', 16) }),
            el('a', { class: 'ps-grant-who', href: WB.href.board(l.id) }, el('b', { text: l.name }), el('span', { text: until(l.expiresAt) })),
            el('span', { class: 'ps-grant-role', text: { view: 'Can view', comments: 'Can read comments', comment: 'Can comment' }[l.access] || l.access }))))),
        s.presenting.length > 0 && field('Presenting', 'Links to watch somebody present it',
          el('ul', { class: 'ps-grants' }, ...s.presenting.map((p) => el('li', { class: 'ps-grant' },
            el('span', { class: 'ps-grant-ic', html: icon('playSolid', 16) }),
            el('span', { class: 'ps-grant-who' }, el('b', { text: p.name || 'Somebody' }), el('span', { text: until(p.expiresAt) })),
            el('span', { class: 'ps-grant-role', text: p.live ? 'Presenting now' : '' }))))),
      ].filter(Boolean));
    }
    paint();
    return box;
  }

  // Where a banner is cut: the point of it kept in sight, as a CSS object-position (the middle unless chosen).
  const bannerPlace = (at) => (Array.isArray(at) ? `${at[0]}% ${at[1]}%` : '50% 50%');

  // A picture chosen as a banner, made the size a banner is shown at: at most 2400 pixels across, as a JPEG.
  async function bannerFile(file) {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, 2400 / bitmap.width);
    const canvas = el('canvas', { width: String(Math.round(bitmap.width * k)), height: String(Math.round(bitmap.height * k)) });
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('It could not be read as a picture'))), 'image/jpeg', 0.88));
  }

  // The cameras in a .glb (a File, or the address of one), by name, read from the JSON at its start
  // without loading the rest: a camera is a node with a camera on it. An address is read in two small
  // pieces (its header, then its JSON), where the server gives pieces; otherwise whole.
  async function glbCameras(from) {
    const bytes = async (start, length) => {
      if (from instanceof Blob) return from.slice(start, start + length).arrayBuffer();
      const res = await fetch(from, { headers: { Range: `bytes=${start}-${start + length - 1}` } });
      if (!res.ok) throw new Error(`${res.status}`);
      const buf = await res.arrayBuffer();
      return res.status === 206 ? buf : buf.slice(start, start + length);
    };
    const head = new DataView(await bytes(0, 20));
    // "glTF", then the first chunk's length and its kind, "JSON".
    if (head.getUint32(0, true) !== 0x46546c67 || head.getUint32(16, true) !== 0x4e4f534a) return [];
    const json = JSON.parse(new TextDecoder().decode(await bytes(20, head.getUint32(12, true))));
    // Each with its lens in degrees across its frame (16:9 where the file gives no shape, as view3d.js reads it).
    const lensOf = (c) => {
      const p = c && c.perspective;
      if (!p || !Number.isFinite(p.yfov)) return null;
      return Math.round((2 * Math.atan(Math.tan(p.yfov / 2) * (p.aspectRatio || 16 / 9)) * 180) / Math.PI);
    };
    const seen = new Set();
    return (json.nodes || []).filter((n) => n.camera != null).map((n, i) => ({ name: n.name || `Camera ${i + 1}`, across: lensOf((json.cameras || [])[n.camera]) }))
      .filter((c) => !seen.has(c.name) && seen.add(c.name));
  }

  // A folder (or a project) as an object: what is in it, and its menu. Things are dropped on it to move
  // them in. Where boards and folders are selected (`pickable`), its row's box selects it.
  function folderObj(folder, { pickable = false } = {}) {
    const subs = childrenOf(folder.id).length;
    // A folder of a project's reviews holds its playlists and animatics too.
    const proj = !folder.project && trailTo(folder.id).find((f) => f.project);
    const boards = proj ? reviewsOf(proj, boardsIn(folder.id), folder.id).length : boardsIn(folder.id).length;
    const what = folder.project ? 'Project' : 'Folder';
    const k = `folder:${folder.id}`;
    return {
      kind: 'folder', tag: 'a', attrs: { href: WB.href.folder(folder.id), 'data-pick': k }, state: folder.project && 'project', picked: bpick.has(k),
      pick: pickable && (() => pickBoardThing(k)),
      icon: folder.project ? ICON_PROJECT : ICON_FOLDER,
      name: folder.name,
      lines: [[folder.project && 'Project', boards && plural(boards, proj ? 'review' : 'board'), subs && plural(subs, 'folder')].filter(Boolean).join(' · ') || 'Empty'],
      cells: { kind: what, boards: boards || '', folders: subs || '', where: folderPlace(folder.parentId, folder.workspace) },
      menu: [
        ['Rename', () => rename('folder', folder)],
        ['Move to…', () => moveDialog('folder', folder)],
        [isPinned('folder', folder.id) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'folder', id: folder.id })],
        hasPersonal && [`Move to ${SPACES[otherSpace(folder.workspace)]} workspace`, () => moveSpace('folder', folder)],
        !folder.project && !inProject(folder.id) && !holdsProject(folder.id) && ['Make it a project', () => setProject(folder, true)],
        folder.project && ['Open the catalogue', () => { location.hash = WB.href.catalogue(folder.id); }],
        folder.project && ['Project settings…', () => projectSettings(folder)],
        folder.project && ['Make it a plain folder', () => setProject(folder, false)],
        !folder.project && ['Delete folder', () => removeFolder(folder), true],
        folder.project && WB.info().admin && ['Delete project…', () => removeProject(folder), true],
      ].filter(Boolean),
      setup: (node) => {
        draggable(node, 'folder', folder.id);
        dropTarget(node, folder.id);
      },
    };
  }
  // Where something is kept: its folder's name, or the workspace's at the top.
  const folderPlace = (folderId, ws) => (folderId && folderById(folderId)?.name) || SPACES[ws] || '';

  // A board as an object: up to four of its pictures, how much is on it, when it was last changed, who is
  // on it now, and its menu. Listed with playlists (`kinds`), it says it is a board. A board in a project can
  // be made into a playlist of its versions, in the order it reads.
  function boardObj(board, { pickable = false, kinds = false } = {}) {
    const k = `board:${board.id}`;
    const proj = board.folderId && trailTo(board.folderId).reverse().find((f) => f.project);
    const live = board.online > 0 && el('span', { class: 'card-live', text: `${board.online} here now` });
    return {
      kind: 'board', tag: 'a', attrs: { href: WB.href.board(board.id), 'data-pick': k }, picked: bpick.has(k),
      pick: pickable && (() => pickBoardThing(k)),
      still: el('div', { class: `card-thumbs n${Math.min(board.thumbs.length, 4)}` },
        board.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }))),
      name: board.name,
      lines: [el('div', { class: 'card-meta' }, `${kinds ? 'Board · ' : ''}${plural(board.count, 'item')} · edited ${ago(board.updatedAt)}`, live)],
      aside: board.online > 0 && el('span', { class: 'card-live', text: `${board.online} here now` }),
      cells: { kind: 'Board', items: board.count, where: folderPlace(board.folderId, board.workspace), changed: [ago(board.updatedAt), new Date(board.updatedAt).toLocaleString()] },
      menu: [
        ['Rename', () => rename('board', board)],
        ['Move to…', () => moveDialog('board', board)],
        [isPinned('board', board.id) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'board', id: board.id })],
        proj && ['Make a playlist of it…', () => playlistOfBoard(proj, board)],
        hasPersonal && [`Move to ${SPACES[otherSpace(board.workspace)]} workspace`, () => moveSpace('board', board)],
        ['Delete board', () => removeBoard(board), true],
      ].filter(Boolean),
      setup: (node) => draggable(node, 'board', board.id),
    };
  }

  // The dashed first of a folder's boards, as on Milanote: a board is always one click away. It is built
  // like a board card (picture area, then a name and a line) so it is exactly the same size in any folder.
  // Among a project's reviews it makes any kind: a board, a playlist or an animatic.
  const NEW_BOARD = { name: 'New board', meta: 'Start from a blank canvas', onclick: () => newBoard() };
  const newReview = (project) => ({
    name: 'New', meta: 'A board, a playlist or an animatic', title: 'A board, to lay pieces out freely; a playlist, versions in order; or an animatic, an edit of the shots',
    onclick: (e) => openMenu(e.currentTarget, [['New board', newBoard], ['New playlist', () => newPlaylist(project)], ['New animatic', () => newAnimatic(project)]]),
  });
  // Where among a project's reviews a playlist or animatic is kept: a folder inside the project, or the project
  // itself for their top (and for a folder that has since gone, or left the project).
  const reviewHome = (project, x) => (x.folderId && folderById(x.folderId) && isWithin(x.folderId, project.id) ? x.folderId : project.id);
  // A project's reviews in one of its folders (its top, to begin with), boards, playlists and animatics
  // together, the one changed last first: [{ at, kind, item }].
  function reviewsOf(project, boards = boardsIn(project.id), folderId = project.id) {
    const cat = catalogues.get(project.id);
    const kept = (list) => (list || []).filter((x) => reviewHome(project, x) === folderId);
    return [...boards.map((x) => ({ at: x.updatedAt, kind: 'board', item: x })), ...kept(cat && cat.playlists).map((x) => ({ at: x.updatedAt, kind: 'playlist', item: x })),
      ...kept(cat && cat.animatics).map((x) => ({ at: x.updatedAt, kind: 'animatic', item: x }))]
      .sort((a, b) => b.at - a.at);
  }
  // Them as objects; each says what it is only where more than one kind is there.
  function reviewObjs(project, list, opts = {}) {
    const kinds = new Set(list.map((x) => x.kind)).size > 1;
    return list.map((x) => (x.kind === 'board' ? boardObj(x.item, { ...opts, kinds }) : x.kind === 'animatic' ? animaticObj(project, x.item, { ...opts, kinds }) : playlistObj(project, x.item, { ...opts, kinds })));
  }

  // ------------------------------------------------------------- pinned and recent
  //
  // Both are kept by this browser. What you opened (boards, from board.js, and assets, sets and shots)
  // is remembered as you go; what you pin stays in the sidebar until you unpin it.

  const pins = () => (Array.isArray(store(WB.KEYS.pins)) ? store(WB.KEYS.pins) : []);
  // Pins to what has since been deleted go, once the library (and for an asset, set or shot, its
  // project's catalogue) says so: they would only lead nowhere, and take the room of real pins.
  function prunePins() {
    if (!libraryLoaded) return;
    const keep = pins().filter((p) => {
      if (p.kind === 'board') return everything.boards.some((b) => b.id === p.id);
      if (p.kind === 'folder') return !!folderById(p.id);
      if (p.kind === 'playlist') return !!loose(p.id);
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
  // Always there on a wide window, and a drawer on a narrow one: what you pinned, then each workspace with
  // its folders as a tree. A project opens to its boards and its catalogue, and
  // the catalogue to its assets, sets and shots, the shots by sequence. Only what you are in is open.

  const ICON_BOARDS = icon('boards', 16);
  const ICON_CAT = icon('catalogue', 16);
  const ICON_LIST = icon('list', 16);
  const ICON_ACTIVITY = icon('activity', 16);
  const ICON_FILM = icon('film', 16);
  const ICON_PLAYLIST = icon('playlist', 16);
  const ICON_ANIMATIC = icon('animatic', 16);
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
    if (rt.kind === 'space') return `w:${rt.space}`;
    const f = folderById(rt.id);
    const v = f && f.project ? currentView() : { page: 'boards' };
    if (v.page === 'animatic') return `an:${rt.id}:${v.animatic}`;
    if (v.page === 'reviews') return v.playlist ? `pl:${rt.id}:${v.playlist}` : `rv:${rt.id}`;
    if (v.page === 'versions') return `vl:${rt.id}`;
    if (v.page === 'activity') return `ac:${rt.id}`;
    if (v.page === 'boards') return `f:${rt.id}`;
    if (v.page !== 'catalogue') return `f:${rt.id}`;
    if (v.seq) return `s:${rt.id}:${v.seq}`;
    if (v.type) return `t:${rt.id}:${v.type}`;
    if (v.entity) {
      const e = (catalogues.get(rt.id)?.entities || []).find((x) => x.id === v.entity);
      const seq = e && e.type === 'shot' && N.seqOf(e.name);
      if (seq) return `s:${rt.id}:${seq}`;
      return e ? `t:${rt.id}:${e.type}` : `c:${rt.id}`;
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
    // A folder of a project's reviews is under its Reviews.
    const around = !f.project && trailTo(f.id).find((x) => x.project);
    if (around) opened.add(`rv:${around.id}`);
    if (f.project) {
      opened.add(`f:${f.id}`);
      const v = currentView();
      if (v.page === 'catalogue') opened.add(`c:${f.id}`);
      if (v.page === 'reviews' || v.page === 'animatic') {
        opened.add(`rv:${f.id}`);
        // and so is the folder a playlist or an animatic is kept in.
        const cat = catalogues.get(f.id);
        const x = cat && (v.animatic ? cat.animatics : cat.playlists || []).find((y) => y.id === (v.animatic || v.playlist));
        if (x) for (const g of trailTo(reviewHome(f, x))) opened.add(`f:${g.id}`);
      }
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
        icon && el('span', { class: 'side-icon', html: icon }),
        el('span', { class: 'side-name', text: label }),
        // Nothing in it says nothing: only a count of something is shown.
        count > 0 && el('span', { class: 'side-count', text: String(count) })));
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
    // A project: its reviews (in their folders), and its catalogue.
    const cat = catalogues.get(f.id);
    const typeRows = () => {
      if (!cat) {
        const pad = { paddingLeft: `${(depth + 2) * 14 + 32}px` };
        if (catBroken(f.id)) {
          return [el('div', { class: 'side-row side-note', style: pad }, 'Could not load. ',
            el('button', { type: 'button', class: 'linkbtn', text: 'Try again', onclick: () => loadCatalogue(f.id, true) }))];
        }
        loadCatalogue(f.id);
        return [el('div', { class: 'side-row side-note', style: pad, text: 'Loading…' })];
      }
      return cat.types.flatMap((t) => {
        const of = cat.entities.filter((e) => e.type === t.id);
        const seqs = t.id === 'shot' ? [...new Set(of.map((e) => N.seqOf(e.name)).filter(Boolean))].sort(seqSort(f)) : [];
        return sideRow({
          key: `t:${f.id}:${t.id}`, depth: depth + 2, icon: null, label: t.label, href: WB.href.catalogue(f.id, { type: t.id }), count: of.length, hereK,
          kids: seqs.length ? () => seqs.flatMap((q) => sideRow({ key: `s:${f.id}:${q}`, depth: depth + 3, icon: null, label: q, href: WB.href.catalogue(f.id, { seq: q }), count: of.filter((e) => N.seqOf(e.name) === q).length, hereK })) : null,
        });
      });
    };
    // Its reviews in one of its folders (its top, to begin with): the folders first, each opening to what it
    // keeps, then its boards, playlists and animatics (a board opens on its own page).
    const reviewRows = (folderId, d) => [
      ...childrenOf(folderId).flatMap((g) => {
        const n = childrenOf(g.id).length + reviewsOf(f, boardsIn(g.id), g.id).length;
        return sideRow({ key: `f:${g.id}`, depth: d, icon: FOLDER_SM, label: g.name, href: WB.href.folder(g.id), count: n, kids: n ? () => reviewRows(g.id, d + 1) : null, drop: (row) => dropTarget(row, g.id, ws), hereK });
      }),
      ...reviewsOf(f, boardsIn(folderId), folderId).flatMap((x) => sideRow(x.kind === 'board'
        ? { key: `b:${x.item.id}`, depth: d, icon: ICON_BOARDS, label: x.item.name, href: WB.href.board(x.item.id), hereK }
        : x.kind === 'animatic'
          ? { key: `an:${f.id}:${x.item.id}`, depth: d, icon: ICON_ANIMATIC, label: x.item.name, href: WB.href.animatic(f.id, x.item.id), hereK }
          : { key: `pl:${f.id}:${x.item.id}`, depth: d, icon: ICON_PLAYLIST, label: x.item.name, href: WB.href.reviews(f.id, x.item.id), hereK })),
    ];
    // Its playlists come with its catalogue, so an open project has it fetched.
    const kids = () => {
      if (!cat) loadCatalogue(f.id);
      const top = childrenOf(f.id).length + reviewsOf(f).length;
      return [
        ...sideRow({ key: `rv:${f.id}`, depth: depth + 1, icon: ICON_BOARDS, label: 'Reviews', href: WB.href.reviews(f.id), count: top, drop, hereK, kids: top ? () => reviewRows(f.id, depth + 2) : null }),
        ...sideRow({ key: `c:${f.id}`, depth: depth + 1, icon: ICON_CAT, label: 'Catalogue', href: WB.href.catalogue(f.id), kids: typeRows, hereK }),
        ...sideRow({ key: `vl:${f.id}`, depth: depth + 1, icon: ICON_LIST, label: 'Versions', href: WB.href.versions(f.id), hereK }),
        ...sideRow({ key: `ac:${f.id}`, depth: depth + 1, icon: ICON_ACTIVITY, label: 'Activity', href: WB.href.activity(f.id), hereK }),
      ];
    };
    return sideRow({ key: `f:${f.id}`, depth, icon: PROJECT_SM, label: f.name, href: WB.href.folder(f.id), kids, drop, hereK, cls: 'project' });
  }

  // A catalogue that would not load is not asked for again on every render (the sidebar's pins and
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
    const rt = route();
    // A project's reviews list its playlists, which come with its catalogue; so do the folders among them.
    const reviewsHere = rt.kind === 'folder' && (rt.id === id ? currentView().page === 'reviews' && !currentView().playlist : isWithin(rt.id, id));
    if (reviewsHere && !typingInPage()) render();
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
      if (p.kind === 'playlist') {
        const l = loose(p.id);
        return l && { key: `pin:l:${l.id}`, icon: ICON_PLAYLIST, label: l.name, href: WB.href.playlist(l.id) };
      }
      const project = folderById(p.projectId);
      if (!project) return null;
      if (p.kind === 'entity') return { key: `pin:e:${p.id}`, icon: ICON_CAT, label: p.name, href: WB.href.catalogue(project.id, { entity: p.id }), title: project.name };
      if (p.kind === 'place') {
        const icon = { sequence: ICON_FILM, versions: ICON_LIST, activity: ICON_ACTIVITY, playlists: ICON_PLAYLIST, playlist: ICON_PLAYLIST, animatic: ICON_ANIMATIC }[p.what] || ICON_CAT;
        const label = ['sequence', 'type', 'playlist', 'animatic'].includes(p.what) ? p.name : `${project.name} ${p.name.toLowerCase()}`;
        return { key: `pin:p:${p.id}`, icon, label, href: p.href, title: project.name };
      }
      return null;
    }).filter(Boolean);
    if (!rows.length) return [];
    const here = location.hash || '#/';
    return [
      el('div', { class: 'side-head plain' }, el('span', { text: 'Pinned' })),
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
      ...pinnedRows(hereK),
      ...wsList.flatMap((ws) => {
        const head = el('a', { class: `side-head${hereK === `w:${ws}` ? ' here' : ''}`, href: spaceHref(ws), onclick: closeDrawer },
          el('span', { text: spaceName(ws) }),
          el('span', { class: 'side-count', text: String(everything.boards.filter((b) => b.workspace === ws).length || '') }));
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

  // Where you are: the workspace, the folders down to here, and in a catalogue the type, the sequence and
  // the asset, set or shot. The last is the page's title; the rest are one small line above it. Every
  // part goes there, folders take drops, and the star beside the title pins what is here.

  function renderCrumbs(rt) {
    const parts = []; // [label, href, folderId for drops (undefined: none), ws]
    let pin = null;
    let settingsOf = null; // a project's home has the way to its settings
    let playlistHere = null; // a playlist's page has its menu beside its title
    let animaticHere = null; // and so has an animatic's
    const onLoose = currentLoose();
    if (rt.kind === 'space') parts.push([spaceName(rt.space), spaceHref(rt.space), null, rt.space]);
    else {
      const trail = trailTo(rt.id);
      const ws = trail.length ? trail[0].workspace : space;
      parts.push([spaceName(ws), spaceHref(ws), null, ws]);
      for (const f of trail) {
        parts.push([f.name, WB.href.folder(f.id), f.id, ws]);
        // A folder in a project is one of its reviews' folders.
        if (f.project && f !== trail[trail.length - 1]) parts.push(['Reviews', WB.href.reviews(f.id), f.id, ws]);
      }
      // The folders of its reviews a playlist or an animatic is kept in, between Reviews and its name.
      const keptIn = (x) => x ? trailTo(reviewHome(f, x)).filter((g) => g.id !== f.id && isWithin(g.id, f.id)).map((g) => [g.name, WB.href.folder(g.id), g.id, ws]) : [];
      const f = trail[trail.length - 1];
      pin = f && { kind: 'folder', id: f.id };
      if (f && f.project) {
        const v = currentView();
        if (v.page === 'home') settingsOf = f;
        if (v.page === 'catalogue') {
          parts.push(['Catalogue', WB.href.catalogue(f.id)]);
          const cat = catalogues.get(f.id);
          const e = v.entity && cat && cat.entities.find((x) => x.id === v.entity);
          const type = v.type || (v.seq && 'shot') || (e && e.type);
          const t = type && cat && cat.types.find((x) => x.id === type);
          if (t) parts.push([t.label, WB.href.catalogue(f.id, { type: t.id })]);
          const seq = v.seq || (e && e.type === 'shot' && N.seqOf(e.name));
          if (seq) parts.push([seq, WB.href.catalogue(f.id, { seq: seq })]);
          if (v.entity) {
            const name = e ? e.name : shownEntity && shownEntity.id === v.entity ? shownEntity.name : '…';
            parts.push([name, WB.href.catalogue(f.id, { entity: v.entity })]);
            pin = e || (shownEntity && shownEntity.id === v.entity) ? { kind: 'entity', id: v.entity, name, projectId: f.id, type: (e || shownEntity).type, thumb: (e && e.thumb) || null } : null;
          }
        } else if (v.page === 'animatic') {
          parts.push(['Reviews', WB.href.reviews(f.id), f.id, ws]);
          const a = animaticNamed(f.id, v.animatic);
          parts.push(...keptIn(a));
          parts.push([a ? a.name : '…', WB.href.animatic(f.id, v.animatic)]);
          animaticHere = a ? { project: f, animatic: a } : null;
        } else if (v.page === 'reviews') {
          parts.push(['Reviews', WB.href.reviews(f.id), f.id, ws]);
          if (v.playlist) {
            const p = playlistData.get(v.playlist);
            parts.push(...keptIn(p && p.playlist));
            parts.push([p ? p.playlist.name : '…', WB.href.reviews(f.id, v.playlist)]);
            playlistHere = p ? { project: f, playlist: p.playlist } : null;
          }
        }
        else if (v.page === 'versions') parts.push(['Versions', WB.href.versions(f.id)]);
        else if (v.page === 'activity') parts.push(['Activity', WB.href.activity(f.id)]);
        // The star pins what is here, not the project around it: a sequence, a type, the catalogue
        // or the versions are pinned as that place (an asset, set or shot as itself).
        if (v.page !== 'home' && !listsBoards(v) && !v.entity) {
          const [name, href] = parts[parts.length - 1];
          const what = v.seq ? 'sequence' : v.type ? 'type' : v.playlist ? 'playlist' : v.page;
          pin = { kind: 'place', id: href, href, name, what, projectId: f.id };
        }
      }
    }
    // A playlist outside a project: the place that keeps it, then its own name as the title.
    if (onLoose) {
      parts.push([onLoose.name, WB.href.playlist(onLoose.id)]);
      pin = { kind: 'playlist', id: onLoose.id };
      playlistHere = { loose: onLoose };
    }
    const nodes = parts.slice(0, -1).map(([label, href, folderId, ws]) => {
      const node = el('a', { class: 'crumb', href, text: label });
      if (folderId !== undefined) dropTarget(node, folderId, ws);
      return node;
    });
    $('crumbs').replaceChildren(...nodes.flatMap((node, i) => (i ? [el('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '/' }), node] : [node])));
    $('crumbs').hidden = !nodes.length;
    const [title, , titleFolder, titleWs] = parts[parts.length - 1];
    const heading = el('span', { class: 'page-title-text', text: title, title });
    if (titleFolder !== undefined) dropTarget(heading, titleFolder, titleWs);
    $('pagetitle').replaceChildren(heading);
    // A project's home has its banner over its title, if it has one.
    const here = rt.kind === 'folder' ? folderById(rt.id) : null;
    const banner = here && here.project && currentView().page === 'home' ? here.settings && here.settings.banner : null;
    const shownBanner = $('pagebanner').firstChild;
    if (!banner) $('pagebanner').replaceChildren();
    else if (!shownBanner || shownBanner.getAttribute('src') !== banner) $('pagebanner').replaceChildren(el('img', { src: banner, alt: '', draggable: 'false' }));
    if (banner) $('pagebanner').firstChild.style.objectPosition = bannerPlace(here.settings.bannerAt);
    $('pagebanner').hidden = !banner;
    // Lists are shown one of three ways. A project's home, its activity and an animatic are not lists: nothing
    // there is shown more than one way.
    layoutSeg.hidden = !!(rt.kind === 'folder' && folderById(rt.id)?.project && ['home', 'animatic', 'activity'].includes(currentView().page));
    const pinned = pin && isPinned(pin.kind, pin.id);
    const onActivity = rt.kind === 'folder' && !!folderById(rt.id)?.project && currentView().page === 'activity';
    const tools = [pin && el('button', {
        type: 'button', class: `iconbtn crumb-pin${pinned ? ' on' : ''}`, html: ICON_STAR,
        title: pinned ? 'Pinned to the sidebar. Click to unpin' : 'Pin to sidebar', 'aria-pressed': String(!!pinned),
        onclick: () => togglePin(pin),
      }),
      settingsOf && el('button', { type: 'button', class: 'iconbtn crumb-pin', html: icon('settings', 16), title: 'Project settings', 'aria-label': 'Project settings', onclick: () => projectSettings(settingsOf) }),
      playlistHere && el('button', { type: 'button', class: 'iconbtn crumb-pin', html: icon('more', 16), title: 'Rename or delete the playlist', 'aria-label': 'Playlist menu', 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget, playlistHere.loose ? loosePlaylistMenu(playlistHere.loose) : playlistMenu(playlistHere.project, playlistHere.playlist)) }),
      animaticHere && el('button', { type: 'button', class: 'iconbtn crumb-pin', html: icon('more', 16), title: 'Rename, copy, set up, download or delete the animatic', 'aria-label': 'Animatic menu', 'aria-haspopup': 'menu', onclick: (e) => openMenu(e.currentTarget, animaticMenu(animaticHere.project, animaticHere.animatic, { here: true })) }),
      onActivity && el('button', {
        type: 'button', class: `btn small ghost pa-foryou${forYou ? ' active' : ''}`, 'aria-pressed': String(forYou), text: 'For you',
        title: forYou ? 'Only what is for you: comments on your work, replies to you, what is filed of what you make or are cc’d on. Click for everything' : 'Everything in the project. Click for only what is for you',
        onclick: () => { forYou = !forYou; render(); },
      }),
      ...presentingHere(rt),
    ].filter(Boolean);
    // An animatic wants all of the window, as a board does: where it is goes in the bar, after the mark (which
    // stands for the workspace), its name last with its pin and menu, and the page has no heading of its own.
    const inBar = !!animaticHere || (rt.kind === 'folder' && folderById(rt.id)?.project && currentView().page === 'animatic');
    $('barpath').hidden = !inBar;
    if (inBar) {
      const slash = () => el('span', { class: 'bar-slash', 'aria-hidden': 'true', text: '/' });
      $('barpath').replaceChildren(...parts.slice(1, -1).flatMap(([label, href, folderId, ws]) => {
        const node = el('a', { class: 'bar-crumb bar-way', href, text: label, title: label });
        if (folderId !== undefined) dropTarget(node, folderId, ws);
        return [slash(), node];
      }), slash(), el('span', { class: 'bar-here', text: title, title }), ...tools);
      $('pagetools').replaceChildren();
    } else {
      $('barpath').replaceChildren();
      $('pagetools').replaceChildren(...tools);
    }
    document.title = `${parts[parts.length - 1][0]} · Boards`;
  }

  // ------------------------------------------------------------- kept on this computer ahead
  //
  // The newest version of what you pinned is fetched ahead and kept on this computer (media.js), so it
  // opens and scrubs at once when you get to it. So is what the page you are on shows. Each can be turned
  // off in your settings.
  const videoOf = (n) => (n && n.look && n.look.type === 'video' ? WB.playable(n.look) : null);
  function keepAhead() {
    const pinned = [];
    for (const p of pins()) {
      if (p.kind !== 'entity' && !(p.kind === 'place' && (p.what === 'sequence' || p.what === 'type'))) continue;
      if (!folderById(p.projectId)) continue;
      const cat = catalogues.get(p.projectId);
      if (!cat) {
        loadCatalogue(p.projectId);
        continue;
      }
      const type = p.what === 'type' && (/\/t\/([\w-]+)$/.exec(p.href) || [])[1];
      const of = p.kind === 'entity' ? cat.entities.filter((e) => e.id === p.id)
        : p.what === 'sequence' ? cat.entities.filter((e) => e.type === 'shot' && N.seqOf(e.name) === p.name)
          : cat.entities.filter((e) => e.type === type);
      pinned.push(...of.slice().sort((a, b) => (b.latestAt || 0) - (a.latestAt || 0)).slice(0, 40).map((e) => videoOf(e.newest)));
    }
    WB.media.want('pinned', pinned, { rank: WB.media.RANK.pinned, kind: 'pinned' });
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

  // The ring in the bar: how much of what you are looking at (an animatic, or the page's cards) is cached.
  let pageScope = null;
  let cutScope = null; // what the animatic open plays
  const cacheRing = (() => {
    const button = el('button', { id: 'kept', class: 'kept-ring', hidden: true });
    document.querySelector('.home-head .bellwrap').before(button);
    return WB.media.ring(button, () => cutScope || pageScope);
  })();
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
  const VL_FILTERS = [['task', 'Task'], ['seq', 'Sequence'], ['type', 'Kind'], ['by', 'Filed by'], ['artist', 'Artist']];
  const vlDefault = () => ({ group: 'time', sort: 'new', when: '', newest: false, archived: false, task: [], seq: [], type: [], by: [], artist: [] });
  function vlState(project) {
    const key = `wb:vl:${project.id}`;
    return { ...vlDefault(), ...(store(key) || {}) };
  }
  const vlSave = (project, state) => store(`wb:vl:${project.id}`, state);
  const vlFiltered = (st) => VL_FILTERS.some(([k]) => st[k].length) || st.when || st.newest || st.archived;
  // The Versions page shows a page of them at a time, however many a project has, and a way to the others.
  // Which page is open is kept while the list is asked for the same way; any change to its filters, sort
  // or search starts again from the first.
  const VL_PAGE = 100;
  const vlPages = new Map(); // project id -> { base: the list as asked for, page }
  function vlPageOf(project, st) {
    const at = vlPages.get(project.id);
    return at && at.base === vlQuery(st) ? at.page : 0;
  }
  // What the server is asked: the page's state and the search, a page from `offset`.
  function vlQuery(st, offset = 0) {
    const since = { day: dayOf(Date.now()), week: Date.now() - 7 * 864e5, month: Date.now() - 30 * 864e5 }[st.when] || 0;
    const p = new URLSearchParams({ find: '1', sort: st.sort, offset: String(offset), limit: String(VL_PAGE) });
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
    const key = vlQuery(st, vlPageOf(project, st) * VL_PAGE);
    const show = (data) => {
      if (shownProject !== sig) return;
      showContent(...versionsView(project, data, st));
      paintVersionPick(project);
    };
    const had = versionLists.get(project.id);
    if (had && had.key === key) show(had.data);
    else if (fresh || !had) showContent(...versionsTools(project, st, null), el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      const now = await api('GET', `/api/projects/${project.id}/versions?${key}`);
      const st2 = vlState(project);
      if (vlQuery(st2, vlPageOf(project, st2) * VL_PAGE) !== key) return;
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
      if (k === 'type') return (f.types || []).map((t) => [t.id, t.label]);
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
    // On a page of many, which of them it shows: 101–200 of 1,234 versions.
    const from = vlPageOf(project, st) * VL_PAGE;
    const said = total == null ? null : total > VL_PAGE ? `${(from + 1).toLocaleString()}–${Math.min(total, from + VL_PAGE).toLocaleString()} of ${plural(total, 'version')}` : plural(total, 'version');
    return [el('div', { class: 'vl-tools' }, view, filter, ...chips,
      el('span', { class: 'imp-gap' }),
      said && el('span', { class: 'vl-total', text: said }))];
  }

  // The groups the list is shown in, each { key, title, list }. The groups come in their own order
  // (sequences as they are numbered, then assets and sets; shots, assets and sets as the catalogue has
  // them; tasks and people by name; days newest first, or oldest first when sorted so); the sort chosen
  // orders what is in each.
  const byNatural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  function versionGroups(list, st, typeName) {
    if (st.group === 'time') {
      // By day; within a day, by who filed them (whoever comes first in the sort first), however their
      // filing was interleaved with others'.
      const days = new Map();
      for (const v of list) {
        const day = dayOf(v.createdAt);
        if (!days.has(day)) days.set(day, { day, runs: [] });
        const d = days.get(day);
        const by = v.createdBy || '';
        let r = d.runs.find((x) => x.by === by);
        if (!r) d.runs.push(r = { by, list: [] });
        r.list.push(v);
      }
      return [...days.values()].sort((a, b) => (st.sort === 'old' ? a.day - b.day : b.day - a.day))
        .map((d) => ({ key: `d${d.day}`, title: dayName(d.day), runs: d.runs }));
    }
    const typeAt = (t) => (N.TYPES.includes(t) ? N.TYPES.indexOf(t) : N.TYPES.length);
    // For each version, its group's title and where that group comes: [rank, title].
    const groupOf = {
      seq: (v) => {
        const seq = v.type === 'shot' && N.seqOf(v.entity);
        return seq ? [0, seq] : [1 + typeAt(v.type), `${typeName(v.type)}s`];
      },
      entity: (v) => [typeAt(v.type), v.entity],
      task: (v) => (v.task ? [0, v.task] : [1, 'No task']),
      by: (v) => (v.createdBy ? [0, v.createdBy] : [1, 'Somebody']),
      none: () => [0, ''],
    }[st.group] || (() => [0, '']);
    const groups = new Map();
    for (const v of list) {
      const [rank, k] = groupOf(v);
      if (!groups.has(k)) groups.set(k, { key: `g${k}`, title: k, rank, list: [] });
      groups.get(k).list.push(v);
    }
    // Sequences go in the order the project gives them; the rest by name.
    const bySeq = seqSort(folderById(vpick.project));
    return [...groups.values()].sort((a, b) => a.rank - b.rank || (st.group === 'seq' && a.rank === 0 ? bySeq(a.title, b.title) : byNatural(a.title, b.title)));
  }

  function versionsView(project, data, st = vlState(project)) {
    const list = data.versions;
    if (vpick.project !== project.id) {
      dropVersionPick();
      vpick.project = project.id;
    }
    const cat = catalogues.get(project.id);
    const typeName = (id) => {
      const t = cat && cat.types.find((x) => x.id === id);
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
    // Grouped by day, a row's time is enough; otherwise it says the day too.
    // What every one of them is goes unsaid: a card says it is a video, or a shot, only where the page has others.
    const kinds = new Set(list.map((v) => v.kind)).size > 1;
    const types = new Set(list.map((v) => v.type)).size > 1;
    const grid = (vs) => objectList('version', versionsOf(project, null, vs, { list: true, typeName, day: st.group !== 'time', kinds, types }), { grid: 'board-grid ent-grid vl-grid', bare: true });
    const groups = versionGroups(list, st, typeName);
    // Shift and a click picks a run as it is shown.
    vpick.order = groups.flatMap((g) => (g.runs ? g.runs.flatMap((r) => r.list) : g.list).map((v) => v.id));
    // Headed as the catalogue heads its groups: a day (or a task, a shot…) as a section, and within a
    // day, who filed a run of them as a sequence is.
    const out = [];
    for (const g of groups) {
      if (g.runs) {
        const ids = g.runs.flatMap((r) => r.list.map((v) => v.id));
        out.push(groupHead(g.title, { n: ids.length, box: box(ids, `Select everything filed ${g.title.toLowerCase()}`) }));
        for (const r of g.runs) {
          // The time of each is on it; the heading gives the span only when there is one.
          const [from, to] = [clock(r.list[r.list.length - 1].createdAt), clock(r.list[0].createdAt)];
          const span = r.list.length > 1 ? ` · ${from === to ? from : `${from} – ${to}`}` : '';
          out.push(groupHead(r.by || 'Somebody', {
            level: 2, avatar: WB.avatar(r.by), sub: `${plural(r.list.length, 'version')}${span}`,
            box: box(r.list.map((v) => v.id), `Select what ${r.by || 'somebody'} filed then`),
          }), grid(r.list));
        }
        continue;
      }
      const ids = g.list.map((v) => v.id);
      if (st.group !== 'none') out.push(groupHead(g.title, { n: ids.length, box: box(ids, `Select all of ${g.title}`), avatar: st.group === 'by' ? WB.avatar(g.title) : null }));
      out.push(grid(g.list));
    }
    // As a table, the groups are all under one row of headings; a click on one sorts by it.
    if (WB.layout() === 'table' && list.length) {
      out.splice(0, out.length, objectTable('version', [...out], {
        sort: st.sort, onSort: (sort) => { st.sort = sort; vlSave(project, { ...st }); render(); }, all: box(list.map((v) => v.id), 'Select everything shown'),
      }));
    }
    out.unshift(...versionsTools(project, st, data));
    const q = $('q').value.trim();
    if (!list.length) {
      out.push(el('p', { class: 'home-empty', text: q ? `No version matches "${q}"${vlFiltered(st) ? ' with these filters' : ''}.` : vlFiltered(st) ? 'No version is like that.' : 'Nothing is filed in this project yet.' }));
    }
    out.push(vlPager(project, st, data.total));
    return out;
  }

  // The way to the other pages: the one before and after, the first and last, and those around this one.
  // Going to another page lets go of what is picked, as going to another list does.
  function vlPager(project, st, total) {
    const pages = Math.ceil(total / VL_PAGE);
    if (pages < 2) return null;
    const page = vlPageOf(project, st);
    const go = (n) => {
      vlPages.set(project.id, { base: vlQuery(st), page: n });
      dropVersionPick();
      shownProject = '';
      render();
      window.scrollTo({ top: 0 });
    };
    const shown = [...new Set([0, page - 1, page, page + 1, pages - 1])].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
    const nums = [];
    shown.forEach((n, k) => {
      if (k && n - shown[k - 1] > 1) nums.push(el('span', { class: 'vl-gap', text: '…' }));
      nums.push(el('button', { type: 'button', class: `vl-num${n === page ? ' on' : ''}`, text: String(n + 1), 'aria-current': n === page ? 'page' : null, onclick: () => go(n) }));
    });
    return el('nav', { class: 'vl-pager', 'aria-label': 'Pages of versions' },
      el('button', { type: 'button', class: 'btn small ghost', html: `${icon('prev', 14)}<span>Previous</span>`, disabled: page === 0, onclick: () => go(page - 1) }),
      ...nums,
      el('button', { type: 'button', class: 'btn small ghost', html: `<span>Next</span>${icon('next', 14)}`, disabled: page >= pages - 1, onclick: () => go(page + 1) }));
  }

  function paintVersionPick(project) {
    for (const node of document.querySelectorAll(VER_NODES)) node.classList.toggle('picked', vpick.ids.has(node.dataset.id));
    for (const b of document.querySelectorAll('.vl-box[data-ids]')) {
      const ids = b.dataset.ids.split(' ');
      const n = ids.filter((id) => vpick.ids.has(id)).length;
      b.classList.toggle('on', n === ids.length);
      b.classList.toggle('some', n > 0 && n < ids.length);
    }
    const n = vpick.ids.size;
    document.body.classList.toggle('vpicking', n > 0);
    if (!n) return void $('vpickbar')?.remove();
    const onPlaylist = currentView().playlist;
    const bar = pickBar('vpickbar', 'Selected versions', {
      clear: () => { vpick.ids.clear(); paintVersionPick(project); },
      actions: [
        onPlaylist && el('button', { type: 'button', class: 'btn small', text: 'Take off', title: 'Take them off this playlist (the versions stay as they are)', onclick: () => takeOffPlaylist(project, onPlaylist, vpick.order.filter((id) => vpick.ids.has(id))) }),
        !onPlaylist && el('button', { type: 'button', class: 'btn small', text: 'Edit…', title: 'Move them, give them a task or an artist, or archive them, all at once', onclick: () => editVersions(project) }),
        el('button', { type: 'button', class: 'btn small', text: 'Add to playlist', 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); addToPlaylistMenu(project, e.currentTarget, vpick.order.filter((id) => vpick.ids.has(id))); } }),
        el('button', { type: 'button', class: 'btn small', text: 'Add to animatic', 'aria-haspopup': 'menu', title: 'Their shots, at the end of an animatic', onclick: (e) => { e.stopPropagation(); addToAnimaticMenu(project, e.currentTarget, vpick.order.filter((id) => vpick.ids.has(id))); } }),
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
            ...(ent.how.value === 'set' && { entity: have ? have.id : { name: to, type: N.entityTypeOf(to, cat.entities) || 'asset' } }),
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
  const bpick = new Set(); // 'board:<id>' | 'folder:<id>', and among a project's reviews 'playlist:<id>' | 'animatic:<id>'
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
      el('button', { type: 'button', class: `btn ghost bpick-toggle${bselecting ? ' on' : ''}`, html: `${ICON_CHECKS}<span>Select</span>`, title: 'Select boards and folders, to move or delete them together', onclick: () => setBoardSelecting(!bselecting) }));
  }
  // A click on a board or folder while selecting selects it rather than opening it.
  document.addEventListener('click', (e) => {
    if (!bselecting || !(e.target instanceof Element)) return;
    const node = e.target.closest('.obj[data-pick]');
    if (!node || e.target.closest('.card-menu')) return;
    e.preventDefault();
    pickBoardThing(node.dataset.pick);
  }, true);
  // One selected or let go ('board:<id>' | 'folder:<id>'); a row's box starts selecting.
  function pickBoardThing(k) {
    if (!bselecting) setBoardSelecting(true);
    if (bpick.has(k)) bpick.delete(k);
    else bpick.add(k);
    paintBoardPick();
  }

  function dropBoardPick() {
    bpick.clear();
    if (!bselecting) $('bpickbar')?.remove();
    else paintBoardPick();
    for (const n of document.querySelectorAll('.obj[data-pick].picked')) n.classList.remove('picked');
  }
  function paintBoardPick() {
    for (const n of document.querySelectorAll('.obj[data-pick]')) n.classList.toggle('picked', bpick.has(n.dataset.pick));
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
    const count = (kind) => [...bpick].filter((k) => k.startsWith(`${kind}:`)).length;
    const boardsN = count('board');
    const said = ['board', 'folder', 'playlist', 'animatic'].map((kind) => count(kind) && plural(count(kind), kind)).filter(Boolean);
    bar.querySelector('.pick-count').textContent = n ? `${said.length > 1 ? `${said.slice(0, -1).join(', ')} and ${said[said.length - 1]}` : said[0]} selected` : 'Select boards and folders';
    bar.querySelector('.pick-del').hidden = !boardsN;
    bar.querySelector('.pick-move').disabled = !n;
    bar.querySelector('.pick-clear').hidden = !n;
  }
  async function movePicked() {
    const ids = [...bpick].map((k) => k.split(':'));
    // A project's playlists and animatics stay among its reviews, so with any of them only its folders are offered.
    const project = ids.some(([kind]) => kind === 'playlist' || kind === 'animatic') ? projectHere() : null;
    const target = await pickFolder({ title: `Move ${plural(ids.length, 'item')} to`, exclude: ids.length === 1 && ids[0][0] === 'folder' ? ids[0][1] : null, current: currentFolder(), root: project });
    if (target === undefined) return;
    const failed = [];
    for (const [kind, id] of ids) {
      if (kind === 'folder' && (id === target || (target && isWithin(target, id)))) continue;
      try {
        await moveCall(kind, id, target);
      } catch (err) {
        failed.push(err.message);
      }
    }
    dropBoardPick();
    if (project) {
      await loadCatalogue(project.id, true);
      shownProject = '';
    }
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
    if (rt.kind === 'space') return { sel: '.obj[data-pick]', kind: 'items' };
    const f = rt.kind === 'folder' && folderById(rt.id);
    if (!f) return null;
    const v = f.project ? currentView() : { page: 'boards' };
    if (listsBoards(v)) return { project: f, sel: '.obj[data-pick]', kind: 'items' };
    if (v.page === 'catalogue' && v.entity) return { project: f, sel: VER_NODES, kind: 'vers' };
    if (v.page === 'catalogue') return { project: f, sel: '.obj-entity[data-id]', kind: 'ents' };
    if (v.page === 'versions') return { project: f, sel: VER_NODES, kind: 'vers' };
    return null;
  }
  let marquee = null;
  // Anywhere on the page counts, the margins and the space under the content too: all but the bars, the
  // sidebar, dialogs, menus and the player.
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (!(e.target instanceof Element) || e.target.closest('.home-bar, .side, .side-scrim, .viewer, .menu, .combo-list, #toasts, .notices')) return;
    if (document.querySelector('dialog[open]') || (document.querySelector('.viewer') && !document.querySelector('.viewer').hidden)) return;
    if (e.target.closest('a, button, input, select, textarea, label, .card, .vt-row, .vt-head, .imp, .cat-tools, .ent-people, .pick-bar, #crumbs, dialog')) return;
    // What people wrote can still be selected, to copy it; dragging anywhere else never selects text.
    if (e.target.closest('.ent-msg-text, .msg-text')) return;
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

  let renderedFor = null;
  function render() {
    const rt = route();
    if (renderedFor !== location.hash) {
      // A link to a folder or project that is not there any more says so, rather than landing quietly
      // somewhere else.
      const asked = /^#\/f\/([\w-]+)/.exec(location.hash);
      if (asked && libraryLoaded && !folderById(asked[1])) WB.toast('That folder or project is not there any more, or is not shared with you.', { ms: 6000 });
      const askedPlaylist = /^#\/pl\/([\w-]+)/.exec(location.hash);
      if (askedPlaylist && libraryLoaded && !loose(askedPlaylist[1])) WB.toast('That playlist is not there any more, or is not shared with you.', { ms: 6000 });
      // Somewhere new: a search typed for the last page does not carry over to this one.
      if (renderedFor !== null && !searching) $('q').value = '';
      renderedFor = location.hash;
      // Going elsewhere (back, or a link) closes the player.
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
    // An animatic's page lets go of its player and its edit (saving what is not saved yet) once you go elsewhere.
    if (cutPage && !(rt.kind === 'folder' && rt.id === cutPage.project.id && cutKey(currentView()) === cutPage.key)) closeAnimatic();
    if (vpick.project && (rt.kind !== 'folder' || rt.id !== vpick.project || !(currentView().page === 'versions' || currentView().entity || currentView().playlist))) dropVersionPick();
    if (picking.on && (rt.kind !== 'folder' || rt.id !== picking.project || currentView().page !== 'catalogue' || currentView().entity)) {
      const f = folderById(picking.project);
      if (f) setPicking(f, false);
    }
    if (rt.kind === 'folder') space = folderById(rt.id).workspace || space;
    else if (rt.kind === 'space') space = rt.space;
    store('wb:workspace', space);
    lib = {
      folders: everything.folders.filter((f) => f.workspace === space),
      boards: everything.boards.filter((b) => b.workspace === space),
    };
    openTo(rt);
    renderSide(rt);
    renderCrumbs(rt);

    // A playlist outside a project has a page of its own; nothing is made or searched in the bar there.
    const onLoose = currentLoose();
    if (onLoose) {
      $('q').placeholder = 'Search is not used on a playlist';
      $('q').disabled = true;
      $('newsplit').hidden = true;
      if (presentBtn) presentBtn.hidden = !WBPresent.token();
      $('empty').hidden = true;
      return loosePlaylistPage(onLoose);
    }

    const cur = rt.kind === 'folder' ? rt.id : null;
    const here = cur && folderById(cur);
    const view = here && here.project ? currentView() : { page: 'boards' };
    // The search says what it searches here, and the bar offers only what can be made here: boards and
    // folders where boards and folders are listed, not over a catalogue or a list of versions.
    const inProjectHere = !!(here && here.project);
    // A folder inside a project is one of its reviews' folders, and lists them as its Reviews page does.
    const reviewsOfHere = inProjectHere ? here : here ? projectHere() : null;
    $('q').placeholder = {
      catalogue: view.entity ? 'Search the catalogue' : 'Search the catalogue',
      versions: 'Search versions, or who filed them',
      animatic: 'Search is not used in an animatic',
      home: 'Search the catalogue',
      reviews: "Search this project's reviews",
      boards: reviewsOfHere ? 'Search this folder’s reviews' : 'Search boards and folders',
    }[view.page] || 'Search boards and folders';
    $('q').disabled = view.page === 'animatic';
    const makesBoards = rt.kind !== 'folder' || !inProjectHere || view.page === 'reviews';
    // Present, in a project (and wherever you are while presenting, to get to the link and to stop).
    if (presentBtn) presentBtn.hidden = !(projectHere() || WBPresent.token());
    $('newsplit').hidden = !makesBoards;
    // Searching from a project's home looks through its catalogue.
    if (view.page === 'home' && $('q').value.trim()) Object.assign(view, { page: 'catalogue', type: null, seq: null });
    $('empty').hidden = true;
    // A project has its reviews and its catalogue.
    if (!listsBoards(view)) return renderProject(here, view);
    // A search looks through every folder of the workspace (of the project, inside one); without one you
    // see the folder you are in.
    const q = $('q').value.trim().toLowerCase();
    const matches = (name) => name.toLowerCase().includes(q);
    const within = (fid) => !reviewsOfHere || fid === cur || (fid && isWithin(fid, cur));
    const subs = q ? lib.folders.filter((f) => matches(f.name) && f.id !== cur && within(f.id)).sort(byName) : childrenOf(cur);
    const boards = q ? lib.boards.filter((b) => matches(b.name) && within(b.folderId)) : boardsIn(cur);
    // In a project, its playlists and animatics go with its boards, as its reviews. A search there looks
    // through those in this folder and every folder below it.
    if (reviewsOfHere && !catalogues.has(reviewsOfHere.id)) loadCatalogue(reviewsOfHere.id);
    const reviews = reviewsOfHere ? (q
      ? [cur, ...everything.folders.filter((f) => f.id !== cur && isWithin(f.id, cur)).map((f) => f.id)]
        .flatMap((fid) => reviewsOf(reviewsOfHere, [], fid)).concat(boards.map((b) => ({ at: b.updatedAt, kind: 'board', item: b })))
        .filter((x) => matches(x.item.name)).sort((a, b) => b.at - a.at)
      : reviewsOf(reviewsOfHere, boards, cur)) : null;
    // Elsewhere, playlists that are in no project are listed with the boards, the one changed last first.
    const lists = reviewsOfHere ? [] : q ? loosePlaylists().filter((p) => p.workspace === space && matches(p.name)) : playlistsIn(cur);
    const found = reviews ? reviews.length : boards.length + lists.length;
    // Each says what it is only where both kinds are listed.
    const kinds = boards.length > 0 && lists.length > 0;
    const together = lists.length
      ? [...boards.map((b) => ({ at: b.updatedAt, item: boardObj(b, { pickable: true, kinds }) })), ...lists.map((p) => ({ at: p.updatedAt, item: loosePlaylistObj(p, { kinds }) }))]
        .sort((a, b) => b.at - a.at).map((x) => x.item)
      : null;
    showContent(...[
      !q && (subs.length > 0 || found > 0) && boardTools(),
      subs.length > 0 && label('Folders', subs.length),
      subs.length > 0 && objectList('folder', subs.map((f) => folderObj(f, { pickable: true })), { grid: 'folder-grid' }),
      (subs.length > 0 || q) && label(reviews ? 'Reviews' : together ? 'Boards and playlists' : 'Boards', found),
      reviews ? objectList('review', reviewObjs(reviewsOfHere, reviews, { pickable: true }), { lead: !q && newReview(reviewsOfHere) })
        : together ? objectList('review', together, { lead: !q && NEW_BOARD })
          : objectList('board', boards.map((b) => boardObj(b, { pickable: true })), { lead: !q && NEW_BOARD }),
      q && !subs.length && !found && el('p', { class: 'home-empty', text: `Nothing matches "${$('q').value.trim()}".` }),
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
    showContent(el('div', { class: 'home-empty' },
      el('p', { text: err.message || 'That did not load.' }),
      el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => { shownProject = ''; render(); } })));
  }
  // A search being typed narrows what is already loaded; nothing is fetched for it.
  let searching = false;

  let shownProject = '';
  let shownEntity = null; // the asset, set or shot whose page is showing, for the crumbs before its catalogue is in
  async function renderProject(project, view) {
    // A project with a model of its venue: the player's 3D view is made ready as the project opens, so it is
    // there at once in the catalogue's player and in an animatic.
    const model = project.settings && project.settings.preview3d;
    if (model && model.model) thePlayer().prepare3d({ ...model, key: project.id });
    const sig = `${project.id}|${view.page}|${view.entity}|${view.playlist || ''}|${view.animatic || ''}`;
    const fresh = shownProject !== sig;
    shownProject = sig;
    if (view.page === 'versions') return versionsPage(project, fresh, sig);
    if (view.page === 'activity') return activityPage(project, fresh, sig);
    if (view.page === 'reviews') return playlistPage(project, view.playlist, fresh, sig);
    if (view.page === 'animatic') return animaticPage(project, view.animatic);
    if (view.page === 'home') return projectHome(project, fresh, sig);
    // What is being brought in shows above the catalogue, on its page and on each entity's.
    const tray = importer(project).tray;
    if (fresh && (view.entity || !catalogues.has(project.id))) showContent(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      if (view.entity) {
        if (searching && !fresh) return;
        const page = await api('GET', `/api/entities/${view.entity}`);
        if (shownProject !== sig) return;
        shownEntity = page.entity;
        WB.remember({ kind: 'entity', id: page.entity.id, name: page.entity.name, type: page.entity.type, projectId: project.id, thumb: (page.versions.find((v) => !v.hidden && v.thumb) || {}).thumb || null });
        if (!catalogues.has(project.id)) loadCatalogue(project.id);
        renderCrumbs(route());
        return showContent(tray, entityPage(project, page));
      }
      // What was fetched last shows at once (a search narrows it as it is typed); then it is brought up to date.
      if (catalogues.has(project.id)) showContent(tray, ...catalogueView(project, catalogues.get(project.id), view));
      if (searching && catalogues.has(project.id)) return;
      const had = catalogues.get(project.id);
      const cat = await api('GET', `/api/projects/${project.id}`);
      catalogues.set(project.id, cat);
      if (shownProject !== sig) return;
      showContent(tray, ...catalogueView(project, cat, view));
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
  // Where a project opens: the big picture of it, how far along it is and who is on it. Its versions,
  // boards and playlists are not here: each has its own page, in the sidebar.

  const activities = new Map(); // project id -> { items, at }
  async function projectHome(project, fresh, sig) {
    const show = () => {
      if (shownProject !== sig) return;
      showContent(...projectHomeView(project));
    };
    show();
    const act = activities.get(project.id);
    const stale = !act || Date.now() - act.at > 30000;
    if (!fresh && !stale && catalogues.has(project.id)) return;
    const [cat, activity] = await Promise.all([
      api('GET', `/api/projects/${project.id}`).catch(() => null),
      // Two weeks of it: this one beside the one before.
      stale ? api('GET', `/api/projects/${project.id}/activity?since=${Date.now() - 2 * WEEK}&limit=600`).catch(() => null) : null,
    ]);
    if (cat) catalogues.set(project.id, cat);
    if (activity) activities.set(project.id, { items: activity.items, at: Date.now() });
    show();
    if (cat) renderSide(route());
  }

  // A project's home: under its title, this week as one line of figures. Then how far along each part of
  // it is (its assets, its sets, and its shots by sequence), each one a mark toned by whether something
  // was filed of it this week, before, or not yet, with how many have reached each task. Beside that, who
  // is on it and what is waiting.
  const WEEK = 7 * 864e5;
  function projectHomeView(project) {
    const cat = catalogues.get(project.id);
    const act = activities.get(project.id);
    if (!cat) return [el('p', { class: 'home-quiet', text: 'Loading…' })];
    if (!cat.entities.length) {
      return [el('div', { class: 'home-empty' },
        el('p', { text: 'Nothing is set up in this project yet. Add its assets, sets and shots in the catalogue, or drop files there to file them.' }),
        el('a', { class: 'btn', href: WB.href.catalogue(project.id), text: 'Open the catalogue' }))];
    }
    const items = act ? act.items : null;
    const parts = cat.types.map((t) => homeType(project, cat, t)).filter(Boolean);
    return [
      homePulse(items),
      el('div', { class: 'home-cols' },
        el('section', { class: 'home-main' }, parts, homeKey()),
        el('aside', { class: 'home-side' }, homePeople(cat, items), homeWaiting(project, cat))),
    ];
  }

  // This week at a glance, as one line of figures under the title, each beside the week before: versions
  // filed, comments, and how many assets, sets and shots had something new.
  function homePulse(items) {
    if (!items || !items.length) return null;
    const now = Date.now();
    const thisWeek = items.filter((x) => now - x.at < WEEK);
    const lastWeek = items.filter((x) => now - x.at >= WEEK && now - x.at < 2 * WEEK);
    const n = (list, kind) => list.filter((x) => x.kind === kind).length;
    const versus = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(a - b)} on the week before` : a ? 'none the week before' : '');
    const moved = new Set(thisWeek.filter((x) => x.kind === 'version').map((x) => x.entity.id)).size;
    const fig = (value, name, sub) => el('div', { class: 'ph-fig' }, el('b', { text: value.toLocaleString() }), el('span', { text: name }), sub && el('small', { text: sub }));
    const filed = n(thisWeek, 'version');
    const said = n(thisWeek, 'note');
    return el('div', { class: 'ph-figs', role: 'group', 'aria-label': 'This week' },
      fig(filed, filed === 1 ? 'version this week' : 'versions this week', versus(filed, n(lastWeek, 'version'))),
      fig(said, said === 1 ? 'comment' : 'comments', versus(said, n(lastWeek, 'note'))),
      fig(moved, moved === 1 ? 'asset, set or shot moved on' : 'moved on'));
  }

  // Where something is: filed this week, filed before, or nothing yet.
  const stateOf = (e, now = Date.now()) => (!e.versions ? 'none' : now - e.latestAt < WEEK ? 'fresh' : 'filed');
  // A row of marks, one for each asset, set or shot given, in order; each opens it.
  const homeStrip = (project, list) => el('div', { class: 'ph-strip' }, list.map((e) => el('a', {
    class: `ph-mark ${stateOf(e)}`, href: WB.href.catalogue(project.id, { entity: e.id }),
    title: `${e.name}: ${e.versions ? `${plural(e.versions, 'version')}, last ${ago(e.latestAt)}` : 'nothing filed yet'}`, 'aria-label': e.name,
  })));

  // One part of the project (its assets, sets or shots): how many have something filed, each as a mark
  // (shots a row to each sequence, in order), then each task it has with how many have reached it.
  function homeType(project, cat, type) {
    const list = cat.entities.filter((e) => e.type === type.id);
    if (!list.length) return null;
    const filed = list.filter((e) => e.versions).length;
    const fresh = list.filter((e) => stateOf(e) === 'fresh').length;
    const count = (k, n) => el('span', { class: 'ph-count', text: `${k} of ${n}` });
    let rows;
    if (type.id === 'shot') {
      const bySeq = new Map();
      const inOrder = shotSort(project);
      for (const e of list.slice().sort((a, b) => inOrder(a.name, b.name))) {
        const q = N.seqOf(e.name) || '';
        if (!bySeq.has(q)) bySeq.set(q, []);
        bySeq.get(q).push(e);
      }
      rows = [...bySeq].map(([q, shots]) => el('div', { class: 'ph-row' },
        q ? el('a', { class: 'ph-name', href: WB.href.catalogue(project.id, { seq: q }), text: q }) : el('span', { class: 'ph-name', text: 'Other' }),
        homeStrip(project, shots), count(shots.filter((e) => e.versions).length, shots.length)));
    } else {
      rows = [el('div', { class: 'ph-row' }, homeStrip(project, list.slice().sort(byName)))];
    }
    // Its tasks, in the order work goes through them, each with how many have reached it. Not where
    // versions are not counted by task.
    const reached = new Map();
    for (const e of list) for (const task of Object.keys(e.heads || {})) if (task) reached.set(task, (reached.get(task) || 0) + 1);
    const step = (task) => (N.TASKS.includes(task) ? N.TASKS.indexOf(task) : N.TASKS.length);
    const tasks = [...reached].sort((a, b) => step(a[0]) - step(b[0]) || a[0].localeCompare(b[0]));
    return el('section', { class: 'ph-part' },
      label(type.label, null, el('span', { class: 'tally', text: `${filed} of ${list.length} filed${fresh ? ` · ${fresh} this week` : ''}` })),
      el('div', { class: 'ph-rows' }, rows),
      tasks.length > 0 && el('div', { class: 'ph-tasks', role: 'list', 'aria-label': `${type.label} by task` }, tasks.map(([task, k]) => el('div', { class: 'ph-task', role: 'listitem' },
        el('span', { class: 'ph-name', text: task }),
        el('span', { class: 'ph-bar', title: `${k} of ${list.length}` }, el('span', { style: { width: `${(k / list.length) * 100}%` } })),
        el('span', { class: 'ph-count', text: String(k) })))));
  }

  // What the marks' tones say, once, under them all.
  const homeKey = () => el('div', { class: 'ph-key' },
    el('span', { class: 'ph-mark fresh' }), 'filed this week', el('span', { class: 'ph-mark filed' }), 'before', el('span', { class: 'ph-mark none' }), 'nothing yet');

  // Who is on the project: everyone who works on any of its assets, sets and shots, with what they are
  // on, and how many versions each filed this week (everyone who filed one is here, on anything or not).
  function homePeople(cat, items) {
    const now = Date.now();
    const people = new Map();
    const of = (name) => people.get(name) || people.set(name, { name, on: new Map(), week: 0 }).get(name);
    for (const e of cat.entities) for (const a of e.artists || []) of(a).on.set(e.type, (of(a).on.get(e.type) || 0) + 1);
    for (const x of items || []) if (x.kind === 'version' && x.by && now - x.at < WEEK) of(x.by).week++;
    // Each in their colour, as the project's activity gives it.
    const colourOf = new Map((items || []).map((x) => [x.by, x.color]));
    if (!people.size) return null;
    const total = (p) => [...p.on.values()].reduce((a, b) => a + b, 0);
    const list = [...people.values()].sort((a, b) => total(b) - total(a) || b.week - a.week || a.name.localeCompare(b.name));
    const on = (p) => cat.types.filter((t) => p.on.has(t.id)).map((t) => plural(p.on.get(t.id), t.one)).join(', ');
    return el('div', {},
      label('People', people.size),
      el('div', { class: 'ph-people' }, list.map((p) => el('div', { class: 'ph-person' },
        WB.avatar(p.name, colourOf.get(p.name)),
        el('span', { class: 'ph-who' }, el('b', { text: p.name }), p.on.size > 0 && el('span', { text: `on ${on(p)}` })),
        p.week > 0 && el('span', { class: 'ph-week', text: `${p.week} this week`, title: `${plural(p.week, 'version')} filed in the last seven days` })))));
  }

  // ------------------------------------------------------------- a project's activity
  //
  // Everything that happened in the project, newest first and a day at a time, from its start: versions
  // filed, comments on them, playlists and animatics made. A page at a time; "Show earlier" goes further
  // back. For you, on unless turned off beside the title, keeps what is somebody's (see activityFor in
  // server.js), each line saying why.
  let forYou = true;
  const activityLists = new Map(); // `${project id}|${for you}` -> { items, more, next }, as far back as shown
  const activityQuery = (project, before = null) => `/api/projects/${project.id}/activity?limit=50${forYou ? `&for=me&name=${encodeURIComponent(me.name || '')}` : ''}${before ? `&before=${before}` : ''}`;
  async function activityPage(project, fresh, sig) {
    const key = `${project.id}|${forYou}`;
    const show = () => {
      if (shownProject === sig && `${project.id}|${forYou}` === key) showContent(...activityView(project, sig));
    };
    const had = activityLists.get(key);
    if (had) show();
    else showContent(el('p', { class: 'home-quiet', text: 'Loading…' }));
    if (had && !fresh) return;
    try {
      // Coming back to it, it starts again from what is newest.
      activityLists.set(key, await api('GET', activityQuery(project)));
      show();
    } catch (err) {
      pageFailed(sig, err);
    }
  }
  // What was done, at a glance, before who did it: filed, said, or a playlist or an animatic made.
  const KIND = { version: ['import', 'Filed'], note: ['comment', 'Comment'], playlist: ['playlist', 'Playlist'], animatic: ['animatic', 'Animatic'] };
  const kindMark = (kind) => el('span', { class: 'pa-kind', html: icon(KIND[kind][0], 16), title: KIND[kind][1] });
  const WHY = { mention: 'Mentions you', reply: 'Replies to you', work: 'On your work', artist: 'You make it', cc: 'You are cc’d on it' };
  function activityView(project, sig) {
    const list = activityLists.get(`${project.id}|${forYou}`);
    if (!list.items.length) {
      return [el('div', { class: 'home-empty' }, el('p', {
        text: forYou ? 'Nothing for you yet. Comments on your work, replies to you and what is filed of what you make or are cc’d on come here.' : 'Nothing has happened in this project yet.',
      }))];
    }
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    const thisYear = new Date().getFullYear();
    const dayOf = (at) => {
      const d = new Date(at);
      if (d.toDateString() === today) return 'Today';
      if (d.toDateString() === yesterday) return 'Yesterday';
      return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== thisYear && { year: 'numeric' }) });
    };
    const days = new Map();
    for (const x of list.items) (days.get(dayOf(x.at)) || days.set(dayOf(x.at), []).get(dayOf(x.at))).push(x);
    const more = list.more && el('button', {
      type: 'button', class: 'btn pa-more', text: 'Show earlier',
      onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const next = await api('GET', activityQuery(project, list.next));
          list.items.push(...next.items);
          Object.assign(list, { more: next.more, next: next.next });
        } catch (err) {
          WB.toast(err.message, { ms: 5000 });
        }
        if (shownProject === sig) showContent(...activityView(project, sig));
      },
    });
    return [...[...days].map(([day, lines]) => el('section', { class: 'pa-day' }, label(day), el('ol', { class: 'pa-list' },
      inRuns(lines).map((r) => (r.lines.length > 1 ? activityRun(project, r) : activityLine(project, r.lines[0])))))), more];
  }
  // A run: one person's versions filed, or comments written, close together (each within half an hour of the
  // one after it, whatever others did between) is one line, folded, where there are three or more. It stands
  // where its newest is. Fewer stay lines of their own, each where it falls.
  const RUN_GAP = 30 * 60e3;
  const RUN_MIN = 3;
  const openRuns = new Set(); // the runs unfolded, by their newest line's id
  function inRuns(lines) {
    const runs = [];
    const going = new Map(); // `${who}|${kind}` -> the run they are in now
    for (const x of lines) {
      const key = `${String(x.by || '').toLowerCase()}|${x.kind}`;
      const run = (x.kind === 'version' || x.kind === 'note') && going.get(key);
      if (run && run.lines[run.lines.length - 1].at - x.at <= RUN_GAP) run.lines.push(x);
      else {
        const fresh = { lines: [x] };
        runs.push(fresh);
        going.set(key, fresh);
      }
    }
    return runs.flatMap((r) => (r.lines.length >= RUN_MIN ? [r] : r.lines.map((x) => ({ lines: [x] }))))
      .sort((a, b) => b.lines[0].at - a.lines[0].at);
  }
  function activityRun(project, run) {
    const [newest] = run.lines;
    const oldest = run.lines[run.lines.length - 1];
    const n = run.lines.length;
    const open = openRuns.has(newest.id);
    const filed = newest.kind === 'version';
    // What they are of: the assets, sets and shots (or, for comments, the versions), the first few by name.
    const of = [...new Set(run.lines.map((x) => (filed ? x.entity.name : x.version.label || x.entity.name)))];
    const ofText = of.length <= 3 ? of.join(', ') : `${of.slice(0, 2).join(', ')} and ${of.length - 2} more`;
    const whys = new Set(run.lines.map((x) => x.why));
    const clock = (at) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const span = clock(oldest.at) === clock(newest.at) ? clock(newest.at) : `${clock(oldest.at)}–${clock(newest.at)}`;
    const stills = filed ? run.lines.filter((x) => x.version.thumb).slice(0, 4) : [];
    const head = el('button', {
      type: 'button', class: 'pa-row pa-run', 'aria-expanded': String(open),
      title: open ? 'Fold them away' : `Show all ${n}`,
      onclick: () => {
        if (open) openRuns.delete(newest.id);
        else openRuns.add(newest.id);
        const again = activityRun(project, run);
        item.replaceWith(again);
        again.querySelector('.pa-run').focus({ preventScroll: true });
      },
    },
    kindMark(newest.kind),
    WB.avatar(newest.by || '?', newest.color),
    el('div', { class: 'pa-body' },
      el('p', { class: 'pa-what' }, el('b', { text: newest.by || 'Somebody' }), filed ? ' filed ' : ' wrote ', el('span', { class: 'pa-thing', text: `${n} ${filed ? 'versions' : 'comments'}` }),
        el('span', { class: 'pa-of', text: ` on ${ofText}` })),
      whys.size === 1 && newest.why && el('span', { class: 'pa-why', text: WHY[newest.why] })),
    stills.length > 0 && el('span', { class: 'pa-pics' }, stills.map((x) => el('img', { class: 'pa-pic', src: x.version.thumb, alt: '', loading: 'lazy', draggable: 'false' }))),
    el('time', { class: 'pa-time', datetime: new Date(newest.at).toISOString(), text: span }),
    el('span', { class: 'pa-fold', html: icon('chevron', 14) }));
    const item = el('li', { class: `pa-runs${open ? ' open' : ''}` }, head, open && el('ol', { class: 'pa-list pa-inner' }, run.lines.map((x) => activityLine(project, x))));
    return item;
  }
  // A line: who did what, to which, when; a comment's words under it, and a version's still beside it. A version
  // or a comment opens in the player, a playlist or an animatic on its page.
  function activityLine(project, x) {
    const thing = (text) => el('span', { class: 'pa-thing', text });
    const what = {
      version: () => ['filed ', thing(x.version.label || x.entity.name)],
      note: () => [x.note.reply ? 'replied on ' : 'commented on ', thing(x.version.label || x.entity.name)],
      playlist: () => ['made the playlist ', thing(x.playlist.name)],
      animatic: () => ['made the animatic ', thing(x.animatic.name)],
    }[x.kind]();
    const at = new Date(x.at);
    const body = [
      kindMark(x.kind),
      WB.avatar(x.by || '?', x.color),
      el('div', { class: 'pa-body' },
        el('p', { class: 'pa-what' }, el('b', { text: x.by || 'Somebody' }), ' ', ...what),
        x.kind === 'note' && x.note.text && el('p', { class: 'pa-quote', text: x.note.text }),
        x.why && el('span', { class: 'pa-why', text: WHY[x.why] })),
      x.kind === 'version' && x.version.thumb && el('img', { class: 'pa-pic', src: x.version.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
      el('time', { class: 'pa-time', datetime: at.toISOString(), title: at.toLocaleString(), text: at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) }),
    ];
    const row = x.kind === 'playlist' ? el('a', { class: 'pa-row', href: WB.href.reviews(project.id, x.playlist.id) }, ...body)
      : x.kind === 'animatic' ? el('a', { class: 'pa-row', href: WB.href.animatic(project.id, x.animatic.id) }, ...body)
        : el('button', { type: 'button', class: 'pa-row', onclick: () => lookAt(x.entity.id, x.version.id) }, ...body);
    return el('li', {}, row);
  }

  // What is waiting: set up with nothing filed, and filed but quiet for two weeks or more.
  function homeWaiting(project, cat) {
    const now = Date.now();
    const none = cat.entities.filter((e) => !e.versions).sort(byName);
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

  // Above the catalogue: the way to bring files in, first and in ink (or drop them anywhere on the page).
  // Whatever a file's name says files it; the rest are asked about. Then setting up what the project has,
  // and, quieter, selecting.
  function catTools(project) {
    return el('div', { class: 'cat-tools' },
      el('button', { type: 'button', class: 'btn primary', html: `${ICON_IMPORT}<span>Import</span>`, title: 'Bring images and videos into the catalogue. Or drop them anywhere on the page', onclick: () => importer(project).pick() }),
      el('button', { type: 'button', class: 'btn', html: `${ICON_PLUS}<span>Add<span class="cat-long"> assets, sets &amp; shots</span></span>`, title: 'Set up what the project has, before anything is filed of it', onclick: () => addEntities(project) }),
      el('button', { type: 'button', class: `btn ghost pick-toggle${pickingIn(project) ? ' on' : ''}`, html: `${ICON_CHECKS}<span>Select</span>`, title: 'Select assets, sets and shots to change them together', onclick: () => setPicking(project, !pickingIn(project)) }));
  }

  // Changing many at once: who works on them and who is cc'd (added, taken off, or set outright), and
  // what they are. What is left alone stays as each has it.
  async function batchEdit(project) {
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`);
    // What is selected and can be seen: what a search hides is left out, as the bar says.
    const seen = shownIds('.obj-entity[data-id]');
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
    const types = cat.types;
    const typeNow = [...new Set(chosen.map((e) => e.type))];
    const typeSel = el('select', { class: 'be-how', 'aria-label': 'What they are' },
      el('option', { value: '', text: typeNow.length === 1 ? `Leave as ${typeNow[0]}${chosen.length > 1 ? 's' : ''}` : 'Leave as they are' }),
      types.map((t) => el('option', { value: t.id, text: `Make them ${t.label.toLowerCase()}` })));
    const error = el('p', { class: 've-error', hidden: true });
    const save = el('button', { type: 'submit', class: 'btn primary', text: `Change ${chosen.length}` });
    const names = chosen.map((e) => e.name);
    // Claude, told what they are, suggests new names and what each is (claude.js). Each suggestion is
    // ticked to be taken, and can be changed first; nothing is renamed until the dialog is saved.
    let renames = [];
    const aiList = el('div', { class: 'be-ai-list', hidden: true });
    const typeLabel = (id) => (types.find((t) => t.id === id) || { one: id }).one;
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
              el('span', { class: 'be-ai-old', text: e.name, title: e.type }), el('span', { class: 'be-ai-to', text: '→' }), name,
              el('span', { class: 'be-ai-type', text: a.type !== e.type ? `${typeLabel(e.type)} → ${typeLabel(a.type)}` : '' }),
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
          const body = { ids: chosen.map((e) => e.id), artists: artists.value(), cc: cc.value(), ...(typeSel.value && { type: typeSel.value }) };
          const taken = renames.filter((x) => x.take.checked && x.name.value.trim());
          if (taken.length) {
            body.names = Object.fromEntries(taken.filter((x) => x.name.value.trim() !== x.e.name).map((x) => [x.e.id, x.name.value]));
            body.types = Object.fromEntries(taken.filter((x) => x.a.type !== x.e.type).map((x) => [x.e.id, x.a.type]));
          }
          const renaming = taken.length && (Object.keys(body.names).length || Object.keys(body.types).length);
          if (!body.artists && !body.cc && !body.type && !renaming) return dlg.close();
          save.disabled = true;
          try {
            await api('PATCH', `/api/projects/${project.id}/entities`, body);
            catalogues.delete(project.id);
            dlg.close();
            shownProject = '';
            render();
            // Undo puts each back as it was: its own artists, cc and type, not one value for all.
            const before = chosen.map((e) => ({ id: e.id, name: e.name, artists: e.artists || [], cc: e.cc || [], type: e.type }));
            undoable(`Changed ${plural(chosen.length, 'asset, set or shot', 'assets, sets and shots')}`, async () => {
              // Names go back all at once, so names that went round among them can come back round.
              if (renaming) {
                await api('PATCH', `/api/projects/${project.id}/entities`, {
                  ids: before.map((e) => e.id), names: Object.fromEntries(before.map((e) => [e.id, e.name])), types: Object.fromEntries(before.map((e) => [e.id, e.type])),
                });
              }
              for (const e of before) await api('PATCH', `/api/entities/${e.id}`, { artists: e.artists, cc: e.cc, type: e.type });
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
      el('h2', { text: `Edit ${chosen.length === 1 ? names[0] : `${chosen.length} ${typeNow.length === 1 ? (types.find((t) => t.id === typeNow[0]) || { label: 'assets, sets and shots' }).label.toLowerCase() : 'assets, sets and shots'}`}` }),
      el('p', { class: 'be-which', text: names.length > 8 ? `${names.slice(0, 8).join(', ')} and ${names.length - 8} more` : names.join(', ') }),
      ai && el('div', { class: 'be-ai' }, ai.node, aiList),
      artists.node, cc.node,
      el('div', { class: 'be-row' }, el('span', { class: 'be-label', text: 'What they are' }), el('div', { class: 'be-field' }, el('div', { class: 'be-ctl' }, typeSel))),
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
    const types = N.TYPE_LIST;
    const box = el('textarea', { rows: 8, spellcheck: 'false', placeholder: 'char-robot\nset-harbour\nkilo-0010\nkilo-0020', 'aria-label': 'Names, one a line' });
    const typeSel = el('select', { 'aria-label': 'What they are' },
      el('option', { value: '', text: 'What each name says' }), types.map((t) => el('option', { value: t.id, text: `All ${t.label.toLowerCase()}` })));
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
      const typeByShape = (n) => typeSel.value || N.entityTypeOf(n, catalogues.get(project.id)?.entities || []) || 'asset';
      const counts = types.map((t) => [t, fresh.filter((n) => typeByShape(n) === t.id).length]).filter(([, n]) => n);
      preview.textContent = !list.length ? 'Nothing yet.'
        : `${fresh.length ? `Adds ${counts.map(([t, n]) => `${n} ${n === 1 ? t.one : t.label.toLowerCase()}`).join(', ')}.` : 'Nothing new.'}${list.length > fresh.length ? ` ${list.length - fresh.length} already there.` : ''}`;
      save.disabled = !fresh.length;
      save.textContent = fresh.length ? `Add ${fresh.length}` : 'Add';
      error.hidden = true;
    };
    box.addEventListener('input', paint);
    typeSel.addEventListener('change', paint);
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
            const res = await api('POST', `/api/projects/${project.id}/entities`, { names: wanted(), type: typeSel.value || undefined, by: me.name });
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
      el('div', { class: 'ae-row' }, el('span', { text: 'They are' }), typeSel),
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
    for (const node of document.querySelectorAll('.obj-entity[data-id]')) node.classList.toggle('picked', picking.ids.has(node.dataset.id));
    const bar = $('pickbar');
    if (!bar) return;
    const seen = shownIds('.obj-entity[data-id]');
    const n = [...picking.ids].filter((id) => seen.has(id)).length;
    countPicked(bar, n, picking.ids.size - n, 'assets, sets and shots');
    bar.querySelector('.pick-edit').disabled = !n;
    const cat = catalogues.get(picking.project);
    bar.querySelector('.pick-cut').disabled = !(cat && [...picking.ids].some((id) => seen.has(id) && cat.entities.some((e) => e.id === id && e.type === 'shot')));
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
        actions: [
          el('button', { type: 'button', class: 'btn small pick-cut', text: 'Add to animatic', 'aria-haspopup': 'menu', title: 'The shots picked, in order, at the end of an animatic', onclick: (e) => { e.stopPropagation(); addToAnimaticMenu(project, e.currentTarget, picking.order.filter((id) => picking.ids.has(id))); } }),
          el('button', { type: 'button', class: 'btn small primary pick-edit', text: 'Edit…', onclick: () => batchEdit(project) }),
        ],
      });
      bar.querySelector('.pick-count').after(el('button', { type: 'button', class: 'btn small ghost', text: 'Select all', onclick: () => { for (const id of picking.order) picking.ids.add(id); paintPicked(); } }));
    }
    document.body.classList.toggle('picking', on);
    for (const b of document.querySelectorAll('.pick-toggle')) b.classList.toggle('on', on);
    paintPicked();
  }

  // An asset, set or shot as an object: its newest picture (scrubbed, and the latest played with a click),
  // how many versions it has and when the last was filed, its tasks and its artists, and its menu. In the
  // catalogue (`pickable`) it is selected with a click while selecting, and its row's box starts that.
  // In the catalogue's rows (`inRow`) it is said short: its name (a shot's number alone, its sequence
  // naming the row) and what its newest version is.
  function entityObj(project, e, { pickable = false, inRow = false } = {}) {
    const newest = e.newest || null;
    const type = (project && catalogues.get(project.id)?.types.find((t) => t.id === e.type)) || null;
    const kind = type ? type.one.charAt(0).toUpperCase() + type.one.slice(1) : N.TYPES.includes(e.type) ? e.type.charAt(0).toUpperCase() + e.type.slice(1) : '';
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
    const artists = e.artists && e.artists.length > 0 && (() => el('div', { class: 'card-meta ent-artists', title: `Artists: ${e.artists.join(', ')}` },
      e.artists.slice(0, 4).map((n) => WB.avatar(n, null, { size: 'xs' })), el('span', { text: e.artists.join(', ') })));
    return {
      kind: 'entity', tag: 'a', picked: picking.ids.has(e.id) && pickingIn(project),
      attrs: {
        href: WB.href.catalogue(project.id, { entity: e.id }), 'data-id': e.id,
        onclick: (ev) => {
          if (!pickingIn(project)) return;
          ev.preventDefault();
          pickTile(e.id, ev.shiftKey);
        },
      },
      pick: pickable && ((range) => {
        if (!pickingIn(project)) setPicking(project, true);
        pickTile(e.id, range);
      }),
      box: el('span', { class: 'pick-box', 'aria-hidden': 'true' }),
      still: thumbs,
      name: inRow && e.type === 'shot' && N.seqOf(e.name) ? e.name.slice(N.seqOf(e.name).length + 1) : e.name,
      title: e.name,
      lines: inRow ? [newest && N.label(null, newest.task, newest.number)] : [e.versions == null ? kind.toLowerCase() : e.versions ? `${plural(e.versions, 'version')} · last ${ago(e.latestAt)}` : 'Nothing filed yet', artists && artists()],
      cells: {
        kind, where: project.name,
        versions: e.versions || '',
        artists: artists && artists(),
        changed: e.latestAt ? [ago(e.latestAt), new Date(e.latestAt).toLocaleString()] : e.versions === 0 ? 'Nothing filed' : '',
      },
      // The same menu as every other object: what can be done with it, Pin among it.
      menu: [
        newest && ['Play the latest', () => lookAt(e.id, newest.id)],
        ['Open its page', () => { location.hash = WB.href.catalogue(project.id, { entity: e.id }); }],
        e.type === 'shot' && ['Add to animatic…', () => addToAnimaticMenu(project, null, [e.id])],
        [isPinned('entity', e.id) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'entity', id: e.id, name: e.name, projectId: project.id, type: e.type, thumb: e.thumb || null })],
      ].filter(Boolean),
    };
  }

  function catalogueView(project, cat, view = {}) {
    const q = WBNaming.tokenize($('q').value);
    const list = cat.entities.filter((e) => (!q || e.name.includes(q))
      && (!view.type || e.type === view.type) && (!view.seq || (e.type === 'shot' && N.seqOf(e.name) === view.seq)));
    const out = [];
    const shown = (es) => objectList('entity', es.map((e) => entityObj(project, e, { pickable: true })), { grid: 'board-grid ent-grid', bare: true });
    // As cards, the whole catalogue (or all its shots) is one grid, as a clip launcher lays out its
    // layers: the same small print everywhere, after a column where each sequence is named. Assets and
    // sets have no order, so theirs wraps; a sequence runs along its row in order, scrolling sideways.
    // A sequence's page, or the assets' or the sets', is one group and wraps its cards as any list.
    const rows = WB.layout() === 'cards' && !view.seq && (!view.type || view.type === 'shot');
    const row = (head, es, wrap) => el('div', { class: `seq-row${wrap ? ' wrap' : ''}` }, head || el('div', { class: 'seq-row-head' }),
      objectList('entity', es.map((e) => entityObj(project, e, { pickable: true, inRow: true })), { grid: 'seq-track' }));
    picking.order = [];
    for (const type of cat.types) {
      const of = list.filter((e) => e.type === type.id);
      if (!of.length) continue;
      out.push(groupHead(type.label, { n: of.length }));
      picking.order.push(...of.map((e) => e.id));
      if (type.id !== 'shot') {
        out.push(rows ? el('div', { class: 'seq-rows' }, row(null, of, true)) : shown(of));
        continue;
      }
      // Shots by sequence, as they are on disk.
      const seqs = new Map();
      for (const e of of) {
        const seq = N.seqOf(e.name) || 'other';
        (seqs.get(seq) || seqs.set(seq, []).get(seq)).push(e);
      }
      const bySeq = seqSort(project);
      const sorted = [...seqs].sort(([a], [b]) => (a === 'other') - (b === 'other') || bySeq(a, b));
      if (!rows) {
        for (const [seq, shots] of sorted) out.push(groupHead(seq, { level: 2 }), shown(shots));
        continue;
      }
      out.push(el('div', { class: 'seq-rows' }, sorted.map(([seq, shots]) => row(
        el(seq === 'other' ? 'div' : 'a', { class: 'seq-row-head', ...(seq !== 'other' && { href: WB.href.catalogue(project.id, { seq }), title: `Open ${seq}` }) },
          el('span', { class: 'seq-row-name', text: seq }), el('span', { class: 'tally', text: String(shots.length) })),
        shots))));
    }
    if (!out.length) {
      out.push(el('div', { class: 'home-empty cat-empty' },
        el('p', { text: q ? `Nothing in the catalogue matches "${$('q').value.trim()}".` : 'Nothing is filed in this project yet.' }),
        !q && el('p', { text: 'Drop images and videos here, or import them. On a board, select some and file them as versions (Shift+V).' })));
    }
    // As a table, every group under one row of headings.
    return [catTools(project), ...(WB.layout() === 'table' && list.length ? [objectTable('entity', out)] : out)];
  }

  // A version opens in the player (viewer.js), the same one a board opens its media in: with every other
  // version of the same thing beside it, and what has been said about them, live.
  let player = null;
  let lookingAt = null; // the asset, set or shot open in the player
  const thePlayer = () => player || (player = WBViewer.create({ me: () => me, title: () => '', media: () => [], notes: () => [], add() {}, set() {}, remove() {} }));
  async function lookAt(entityId, versionId) {
    thePlayer();
    try {
      const project = folderById(currentFolder());
      // Over the whole window, as a board or an animatic is: Done or Esc comes back here.
      await WBViewer.openEntity(player, entityId, { version: versionId, me, title: project ? project.name : null, onClose: () => { lookingAt = null; shownProject = ''; render(); } });
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
          if (e2 !== entity.name) body.entity = { name: e2, type: N.entityTypeOf(e2, cat ? cat.entities : []) || entity.type };
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
      ['Add to playlist…', () => addToPlaylistMenu(project, null, [v.id])],
      entity.type === 'shot' && ['Add to animatic…', () => addToAnimaticMenu(project, null, [v.id])],
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

  // Who makes it, and who else follows it: both see what happens to it in the project's activity.
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

  // ---- versions: picked with a click wherever they are listed (a project's Versions, an asset, set or
  // shot's own page), Shift and a click for every one between, as files are in a file manager.
  const VER_NODES = '.obj-version[data-id]';
  // What picks it: a click, Space or Enter (with Shift, every one between), as on a card in a file manager.
  const verPicks = (project, entity, v, open = () => lookAt(entity.id, v.id)) => ({
    'data-id': v.id, tabindex: '0', 'aria-label': `${v.label}: press Space to select`,
    // A double-click opens it in the player, as a click on its picture does.
    ondblclick: (e) => { if (!e.target.closest('a, button')) open(); },
    onkeydown: (e) => {
      if (e.target !== e.currentTarget || (e.key !== ' ' && e.key !== 'Enter')) return;
      e.preventDefault();
      pickVersion(project, v.id, e.shiftKey);
    },
    onclick: (e) => {
      if (e.target.closest('a, button')) return;
      pickVersion(project, v.id, e.shiftKey);
    },
  });
  const verBox = (project, v) => el('button', {
    type: 'button', class: `vl-box${vpick.ids.has(v.id) ? ' on' : ''}`, 'data-ids': v.id, title: `Select ${v.label}`, 'aria-label': `Select ${v.label}`,
    onclick: (e) => { e.stopPropagation(); pickVersion(project, v.id, e.shiftKey); },
  });
  const verStill = (entity, v, badge = true, open = () => lookAt(entity.id, v.id)) => scrubber(el('button', {
    type: 'button', class: `card-thumbs n${v.thumb ? 1 : 0}`, title: 'Open it, to look, comment and draw',
    onclick: (e) => { e.stopPropagation(); open(); },
  },
  v.thumb && el('img', { src: v.thumb, alt: '', loading: 'lazy', draggable: 'false' }),
  badge && v.kind === 'video' && el('span', { class: 'ver-kind', text: 'Video' })), v.look, v.label);
  // Its shot strong (on the Versions page a link to its page), the rest of its label quieter.
  function verName(project, entity, v, list) {
    const rest = v.label.startsWith(entity.name) ? v.label.slice(entity.name.length).trim() : v.label;
    return [list ? el('a', { class: 'ver-ent', href: WB.href.catalogue(project.id, { entity: entity.id }), text: entity.name, title: `${entity.name}: its page` }) : el('span', { class: 'ver-ent', text: entity.name }),
      rest && el('span', { class: 'ver-rest', text: ` ${rest}` })];
  }
  const verBoards = (v, max) => v.boards.length > 0 && el('div', { class: 'ver-boards' },
    v.boards.slice(0, max).map((b) => el('a', { class: 'ver-board', href: WB.href.board(b.id), text: b.name, title: b.name })),
    v.boards.length > max && el('span', { class: 'ver-more', text: `+${v.boards.length - max}`, title: v.boards.slice(max).map((b) => b.name).join(', ') }));
  const verPasses = (v) => {
    const passes = v.passes || (v.look && (v.look.passes || []).length ? [v.look.pass || 'main', ...v.look.passes.map((x) => x.pass)] : []);
    return passes.length ? passes.map((x) => x || 'main') : null;
  };
  // A version's attachments, by label: said only of one that has some.
  const verAttachments = (v) => {
    const attachments = v.attachments || (v.look && v.look.attachments ? v.look.attachments.map((x) => x.label) : []);
    return attachments.length ? attachments : null;
  };

  // A version as an object: its picture (scrubbed under the pointer, opened in the player with a click),
  // its shot and the rest of its label, what is known of it, the boards it is on, and its menu. On the
  // Versions page (`list`) it says which asset, set or shot it is (a link to it) and when it was filed, as
  // the page groups by who filed it (and the day too, in a table not grouped by day: `day`); on the
  // asset, set or shot's own page, who filed it and when. Whether it is an image or a video (`kinds`), and
  // an asset, set or shot (`types`), is said only where the list has more than one.
  // Listed on a playlist, `open` is how it opens (the playlist playing from it) and `menu` comes first in its menu.
  function versionObj(project, entity, v, { list = false, typeName = (t) => t, day = false, kinds = false, types = false, open, menu = [] } = {}) {
    const passes = verPasses(v);
    const attachments = verAttachments(v);
    const about = [
      list && clock(v.createdAt),
      list && types && typeName(v.type),
      v.artist && !(list && v.artist === (v.createdBy || '').toLowerCase()) && `by ${v.artist}`,
      v.descriptor,
    ].filter(Boolean).join(' · ') || (!list && v.originalName) || '';
    return {
      kind: 'version', state: v.hidden && 'hidden-ver', picked: vpick.ids.has(v.id), attrs: verPicks(project, entity, v, open),
      pick: (range) => pickVersion(project, v.id, range),
      box: verBox(project, v),
      still: verStill(entity, v, kinds && WB.layout() !== 'table', open),
      name: verName(project, entity, v, list), title: v.label,
      lines: [
        about,
        // Shown more than one way: its passes, the main one first.
        passes && `Passes: ${passes.join(', ')}`,
        attachments && `Attachments: ${attachments.join(', ')}`,
        !list && `Filed ${ago(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}${v.hidden ? ' · archived' : ''}`,
        list && v.hidden && 'Archived',
        verBoards(v, 4),
      ],
      aside: [v.hidden && 'Archived', passes && el('span', { text: plural(passes.length, 'pass', 'passes'), title: `Passes: ${passes.join(', ')}` }),
        attachments && el('span', { text: plural(attachments.length, 'attachment'), title: `Attachments: ${attachments.join(', ')}` })].filter(Boolean),
      cells: {
        kind: 'Version', where: entity.name,
        task: v.task || '—',
        ver: el('span', { class: 'vt-main vt-strong', text: `v${v.number}` }),
        artist: v.artist || '',
        by: v.createdBy && el('span', { class: 'vt-who' }, WB.avatar(v.createdBy), el('span', { class: 'vt-main', text: v.createdBy })),
        changed: [!list ? ago(v.createdAt) : day ? `${dayName(dayOf(v.createdAt))} ${clock(v.createdAt)}` : clock(v.createdAt), new Date(v.createdAt).toLocaleString()],
      },
      menu: [...menu, ...versionActions(project, entity, v)],
    };
  }
  const versionsOf = (project, entity, vs, opts = { kinds: new Set(vs.map((v) => v.kind)).size > 1 }) => vs.map((v) => versionObj(project, entity || { id: v.entityId, name: v.entity, type: v.type }, v, opts));

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
      objectList('version', versionsOf(project, entity, versions), {
        grid: 'board-grid ent-grid',
        lead: { name: 'Add versions', meta: 'Choose files, or drop them here', title: `Add new versions of ${entity.name}: choose files, or drop them anywhere here`, onclick: () => importer(project).pick(entity) },
      }),
      label('Notes', roots.length),
      roots.length ? el('div', { class: 'ent-threads' }, threads) : el('p', { class: 'home-empty', text: 'Nothing said about it yet. Notes made on any board it is on show here.' }));
  }

  // ------------------------------------------------------------- a project's animatics
  //
  // An edit of the project's shots on tracks, always playing their newest versions (animatic.js, and
  // docs/animatic.md). Listed with its boards and playlists as its reviews; its own page is where it is cut.

  let cutPage = null; // the animatic whose page is open: { id, project, ctl }
  const cutNames = new Map(); // animatic id -> its name, as its page last said it

  // An animatic as its project's catalogue lists it (by the name its page says, which may be newer).
  function animaticNamed(projectId, aid) {
    const a = (catalogues.get(projectId)?.animatics || []).find((x) => x.id === aid);
    if (a) return cutNames.has(aid) ? { ...a, name: cutNames.get(aid) } : a;
    return cutNames.has(aid) ? { id: aid, name: cutNames.get(aid) } : null;
  }

  // An animatic as an object: its first stills side by side, as a playlist's are, how many shots it has, how
  // long it runs and when it changed. Listed with other kinds (`kinds`), it says it is an animatic.
  function animaticObj(project, a, { kinds = false, pickable = false } = {}) {
    const length = WBViewer.fmtTime(a.dur);
    const k = `animatic:${a.id}`;
    return {
      kind: 'playlist', tag: 'a', attrs: { href: WB.href.animatic(project.id, a.id), 'data-pick': k }, picked: bpick.has(k),
      pick: pickable && (() => pickBoardThing(k)),
      still: el('div', { class: `card-thumbs strip n${Math.min(a.thumbs.length, 4)}` }, a.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }))),
      name: a.name,
      lines: [`${kinds ? 'Animatic · ' : ''}${plural(a.shots, 'shot')}${a.dur ? ` · ${length}` : ''} · changed ${ago(a.updatedAt)}`],
      cells: { kind: 'Animatic', items: a.shots, changed: [ago(a.updatedAt), new Date(a.updatedAt).toLocaleString()] },
      menu: animaticMenu(project, a),
      setup: (node) => draggable(node, 'animatic', a.id, reviewThing(project, a)),
    };
  }

  // On its own page (`here`) it can also be set up and downloaded.
  function animaticMenu(project, a, { here = false } = {}) {
    const href = WB.href.animatic(project.id, a.id);
    const open = here && cutPage && cutPage.id === a.id ? cutPage.ctl : null;
    return [
      ['Rename…', () => renameAnimatic(project, a)],
      ['Make a copy…', () => copyAnimatic(project, a)],
      ['Move to…', () => moveDialog('animatic', a, project)],
      open && ['Frame rate and shape…', () => open.settings()],
      open && ['Download for a playback system…', () => open.download()],
      [isPinned('place', href) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'place', id: href, href, name: a.name, what: 'animatic', projectId: project.id })],
      ['Delete animatic…', () => deleteAnimatic(project, a), true],
    ].filter(Boolean);
  }

  // What changed in an animatic shows in the sidebar and the lists at once.
  function animaticsChanged(project) {
    loadCatalogue(project.id, true);
    shownProject = '';
    render();
  }

  // A new animatic, named, and started either empty or with the project's filed shots on V1 in their order;
  // with `shots` given (picked elsewhere), with those. It opens when made, unless it was made to add to.
  async function newAnimatic(project, shots = null) {
    const made = await new Promise((resolve) => {
      let ok = false;
      const input = el('input', { type: 'text', maxlength: 120, placeholder: 'Animatic name', value: `Cut ${new Date().toLocaleDateString()}`, autocomplete: 'off' });
      const fill = el('input', { type: 'checkbox', role: 'switch', checked: true });
      const dlg = el('dialog', { class: 'dlg' },
        el('form', { method: 'dialog', onsubmit: () => { ok = true; } },
          el('h2', { text: 'New animatic' }),
          el('p', { text: shots ? `With the ${plural(shots.length, 'shot')} you picked on it, one after another.` : 'An edit of the project’s shots on tracks. It always plays their newest versions.' }),
          input,
          !shots && el('label', { class: 'dlg-row' }, el('span', { text: 'Start with every filed shot, in order' }), fill),
          el('div', { class: 'dlg-actions' },
            el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
            el('button', { type: 'submit', class: 'btn primary', text: 'Create animatic' }))));
      dlg.addEventListener('close', () => {
        dlg.remove();
        resolve(ok && input.value.trim() ? { name: input.value.trim(), fill: !shots && fill.checked } : null);
      });
      document.body.append(dlg);
      dlg.showModal();
      input.select();
    });
    if (!made) return null;
    try {
      const a = await api('POST', `/api/projects/${project.id}/animatics`, { name: made.name, ...(made.fill && { from: 'shots' }), ...(shots && { shots }), folderId: reviewFolderHere(project), by: me.name });
      animaticsChanged(project);
      if (!shots) location.hash = WB.href.animatic(project.id, a.animatic.id);
      return a.animatic;
    } catch (err) {
      fail(err);
      return null;
    }
  }

  async function renameAnimatic(project, a) {
    const name = await WB.dialog({ title: 'Rename animatic', value: a.name, placeholder: 'Animatic name', ok: 'Rename' });
    if (!name || name === a.name) return;
    try {
      await api('PATCH', `/api/animatics/${a.id}`, { name });
      cutNames.set(a.id, name);
      animaticsChanged(project);
    } catch (err) {
      fail(err);
    }
  }

  // Another cut of the same shots to try: the copy opens.
  async function copyAnimatic(project, a) {
    const name = await WB.dialog({ title: 'Make a copy', text: 'The same edit, to cut another way. Each goes its own way from here.', value: `${a.name} copy`, placeholder: 'Animatic name', ok: 'Make copy' });
    if (!name) return;
    try {
      const made = await api('POST', `/api/projects/${project.id}/animatics`, { name, copy: a.id, folderId: reviewHome(project, a), by: me.name });
      animaticsChanged(project);
      location.hash = WB.href.animatic(project.id, made.animatic.id);
    } catch (err) {
      fail(err);
    }
  }

  async function deleteAnimatic(project, a) {
    const ok = await WB.dialog({ title: `Delete ${a.name}?`, text: 'The edit goes. The shots and their versions stay where they are.', ok: 'Delete animatic', danger: true });
    if (!ok) return;
    try {
      if (cutPage && cutPage.id === a.id) closeAnimatic(false);
      await api('DELETE', `/api/animatics/${a.id}`);
      if (currentView().animatic === a.id) location.hash = WB.href.reviews(project.id);
      animaticsChanged(project);
    } catch (err) {
      fail(err);
    }
  }

  // Shots (or the shots of versions) put at the end of an animatic's first track: one of the project's, or a
  // new one. From a menu under `anchor`, or a dialog listing them.
  async function addToAnimaticMenu(project, anchor, ids) {
    if (!ids.length) return;
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    const lists = (cat && cat.animatics) || [];
    const done = () => {
      vpick.ids.clear();
      paintVersionPick(project);
    };
    const add = async (a) => {
      try {
        if (cutPage && cutPage.id === a.id) closeAnimatic();
        await api('PATCH', `/api/animatics/${a.id}`, { add: ids, by: me.name });
        done();
        animaticsChanged(project);
        undoable(`Added to ${a.name}`, null, { label: 'Open animatic', href: WB.href.animatic(project.id, a.id) });
      } catch (err) {
        fail(err);
      }
    };
    const made = async () => {
      const a = await newAnimatic(project, ids);
      if (!a) return;
      done();
      undoable(`${a.name} made, with ${plural(a.shots, 'shot')}`, null, { label: 'Open animatic', href: WB.href.animatic(project.id, a.id) });
    };
    if (!lists.length) return void made();
    if (anchor) return void openMenu(anchor, [...lists.slice(0, 12).map((a) => [a.name, () => add(a)]), ['New animatic…', made]]);
    const chosen = await pickFromList('Add to animatic', lists.map((a) => [a.id, a.name, plural(a.shots, 'shot')]), 'New animatic…', ICON_ANIMATIC);
    if (chosen === 'new') made();
    else if (chosen) add(lists.find((a) => a.id === chosen));
  }

  // An animatic's page: the editor, opened once and left be as the rest of the page is brought up to date.
  // `cutKey` says which animatic a view is, as `cutPage.key` says which is open. Somebody presenting it is
  // followed through it as through the player (present.js hears what it tells).
  const cutKey = (v) => (v.page === 'animatic' ? `an:${v.animatic}` : null);
  function animaticPage(project, aid) {
    if (cutPage && cutPage.key === `an:${aid}` && $('content').contains(cutPage.node)) return;
    closeAnimatic();
    if (!catalogues.has(project.id)) loadCatalogue(project.id);
    const ctl = WBAnimatic.open($('content'), {
      project, id: aid, me,
      onName: (name) => {
        cutNames.set(aid, name);
        renderCrumbs(route());
        renderSide(route());
      },
      onScope: (scope) => {
        cutScope = scope;
        cacheRing.paint();
      },
      onGone: () => {
        closeAnimatic(false);
        WB.toast('That animatic is not there any more.', { ms: 6000 });
        location.hash = WB.href.reviews(project.id);
      },
    });
    cutPage = { key: `an:${aid}`, id: aid, project, ctl, node: $('content').firstElementChild, unhear: ctl.presenter.watch(WBPresent.heard) };
    WBPresent.report();
  }
  // `changed`: what it now says (its length, its stills) is fetched for the lists.
  function closeAnimatic(changed = true) {
    if (!cutPage) return;
    const { ctl, project, key, unhear } = cutPage;
    cutPage = null;
    if (unhear) unhear();
    ctl.close();
    if (changed) setTimeout(() => loadCatalogue(project.id, true), 600);
  }

  // ------------------------------------------------------------- a project's playlists
  //
  // Some of a project's versions in the order a review goes through them, as in ShotGrid: made from what is
  // picked anywhere versions are listed (Add to playlist), put in order by dragging, and gone through
  // one after another in the player, each with its own comments.

  const playlistData = new Map(); // playlist id -> { playlist, versions } as last fetched

  // A project's playlist or animatic as it is dragged: which project, and the folder of its reviews it is in.
  const reviewThing = (project, x) => ({ id: x.id, name: x.name, projectId: project.id, workspace: project.workspace, folderId: reviewHome(project, x) });
  // The folder of a project's reviews the page is in, for what is made there: none (their top) elsewhere.
  const reviewFolderHere = (project) => {
    const cur = currentFolder();
    return cur && cur !== project.id && isWithin(cur, project.id) ? cur : null;
  };

  // A playlist as an object: its first stills side by side as a strip of film (a board's are a grid), how
  // many versions, when it changed. Listed with boards (`kinds`), it says it is a playlist.
  function playlistObj(project, p, { kinds = false, pickable = false } = {}) {
    const k = `playlist:${p.id}`;
    return {
      kind: 'playlist', tag: 'a', attrs: { href: WB.href.reviews(project.id, p.id), 'data-pick': k }, picked: bpick.has(k),
      pick: pickable && (() => pickBoardThing(k)),
      still: el('div', { class: `card-thumbs strip n${Math.min(p.thumbs.length, 4)}` }, p.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }))),
      name: p.name,
      lines: [`${kinds ? 'Playlist · ' : ''}${plural(p.count, 'version')} · changed ${ago(p.updatedAt)}`],
      cells: { kind: 'Playlist', items: p.count, changed: [ago(p.updatedAt), new Date(p.updatedAt).toLocaleString()] },
      menu: playlistMenu(project, p),
      setup: (node) => draggable(node, 'playlist', p.id, reviewThing(project, p)),
    };
  }

  function playlistMenu(project, p) {
    return [
      ['Rename…', () => renamePlaylist(project, p)],
      ['Lay out on a board…', () => boardOfPlaylist(project, p)],
      ['Move to…', () => moveDialog('playlist', p, project)],
      [isPinned('place', WB.href.reviews(project.id, p.id)) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'place', id: WB.href.reviews(project.id, p.id), href: WB.href.reviews(project.id, p.id), name: p.name, what: 'playlist', projectId: project.id })],
      ['Delete playlist…', () => deletePlaylist(project, p), true],
    ];
  }

  // What changed in a playlist shows in the sidebar and the lists at once.
  function playlistsChanged(project, id) {
    if (id) playlistData.delete(id);
    loadCatalogue(project.id, true);
    shownProject = '';
    render();
  }

  async function newPlaylist(project, versions = []) {
    const name = await WB.dialog({
      title: 'New playlist', text: versions.length ? `With the ${plural(versions.length, 'version')} you picked on it, in that order.` : 'Add versions to it from anywhere they are listed.',
      value: `Dailies ${new Date().toLocaleDateString()}`, placeholder: 'Playlist name', ok: 'Create playlist',
    });
    if (!name) return null;
    try {
      const p = await api('POST', `/api/projects/${project.id}/playlists`, { name, versions, folderId: reviewFolderHere(project), by: me.name });
      playlistsChanged(project);
      // One made empty opens, to fill.
      if (!versions.length) location.hash = WB.href.reviews(project.id, p.id);
      return p;
    } catch (err) {
      fail(err);
      return null;
    }
  }

  // A board's versions as a playlist, in the order the board reads; it opens when made.
  async function playlistOfBoard(project, board) {
    const name = await WB.dialog({ title: 'Make a playlist of it', text: `The versions on ${board.name}, in the order it reads: rows first, then left to right.`, value: board.name, placeholder: 'Playlist name', ok: 'Make playlist' });
    if (!name) return;
    try {
      const p = await api('POST', `/api/projects/${project.id}/playlists`, { name, board: board.id, folderId: board.folderId, by: me.name });
      playlistsChanged(project);
      location.hash = WB.href.reviews(project.id, p.id);
    } catch (err) {
      fail(err);
    }
  }

  // A playlist laid out on a new board of the project, in rows in its order; the board opens when made.
  async function boardOfPlaylist(project, p) {
    const name = await WB.dialog({ title: 'Lay out on a board', text: `A new board with the ${plural(p.count, 'version')} of ${p.name} on it, in rows in its order.`, value: p.name, placeholder: 'Board name', ok: 'Make board' });
    if (!name) return;
    try {
      const { versions } = await api('GET', `/api/playlists/${p.id}`);
      const board = await api('POST', '/api/boards', { name, folderId: reviewHome(project, p), workspace: project.workspace, by: me.name });
      if (versions.length) await api('POST', `/api/projects/${project.id}/place`, { board: board.id, versions: versions.map((v) => v.id), by: me.name });
      location.href = WB.href.board(board.id);
    } catch (err) {
      fail(err);
    }
  }

  async function renamePlaylist(project, p) {
    const name = await WB.dialog({ title: 'Rename playlist', value: p.name, placeholder: 'Playlist name', ok: 'Rename' });
    if (!name || name === p.name) return;
    try {
      await api('PATCH', `/api/playlists/${p.id}`, { name });
      playlistsChanged(project, p.id);
    } catch (err) {
      fail(err);
    }
  }

  async function deletePlaylist(project, p) {
    const ok = await WB.dialog({ title: `Delete ${p.name}?`, text: 'The playlist goes. The versions on it stay where they are, in the catalogue and on any board.', ok: 'Delete playlist', danger: true });
    if (!ok) return;
    try {
      await api('DELETE', `/api/playlists/${p.id}`);
      if (currentView().playlist === p.id) location.hash = WB.href.reviews(project.id);
      playlistsChanged(project, p.id);
    } catch (err) {
      fail(err);
    }
  }

  // Versions put at the end of a playlist: one of the project's, or a new one. From a menu under `anchor`
  // (or, from a version's own menu, a dialog listing them).
  async function addToPlaylistMenu(project, anchor, ids) {
    if (!ids.length) return;
    const cat = catalogues.get(project.id) || await api('GET', `/api/projects/${project.id}`).catch(() => null);
    const lists = (cat && cat.playlists) || [];
    const add = async (p) => {
      try {
        await api('PATCH', `/api/playlists/${p.id}`, { add: ids });
        vpick.ids.clear();
        paintVersionPick(project);
        playlistsChanged(project, p.id);
        undoable(`${plural(ids.length, 'version')} added to ${p.name}`, null, { label: 'Open playlist', href: WB.href.reviews(project.id, p.id) });
      } catch (err) {
        fail(err);
      }
    };
    const made = async () => {
      const p = await newPlaylist(project, ids);
      if (!p) return;
      vpick.ids.clear();
      paintVersionPick(project);
      undoable(`${p.name} made, with ${plural(p.count, 'version')}`, null, { label: 'Open playlist', href: WB.href.reviews(project.id, p.id) });
    };
    if (!lists.length) return void made();
    if (anchor) return void openMenu(anchor, [...lists.slice(0, 12).map((p) => [p.name, () => add(p)]), ['New playlist…', made]]);
    const chosen = await pickFromList('Add to playlist', lists.map((p) => [p.id, p.name, plural(p.count, 'version')]), 'New playlist…');
    if (chosen === 'new') made();
    else if (chosen) add(lists.find((p) => p.id === chosen));
  }

  // A short list to choose one from, in a dialog: [id, name, what it is]; `more` is a last choice ('new').
  function pickFromList(title, rows, more, mark = ICON_PLAYLIST) {
    return new Promise((resolve) => {
      const dlg = el('dialog', { class: 'dlg' },
        el('h2', { text: title }),
        el('div', { class: 'picker' },
          rows.map(([id, name, meta]) => el('button', { type: 'button', class: 'pick', onclick: () => { resolve(id); dlg.close(); } }, el('span', { html: mark }), el('span', { text: name }), el('span', { class: 'pick-meta', text: meta }))),
          more && el('button', { type: 'button', class: 'pick', onclick: () => { resolve('new'); dlg.close(); } }, el('span', { html: icon('plus', 16) }), el('span', { text: more }))),
        el('div', { class: 'dlg-actions' }, el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() })));
      dlg.addEventListener('close', () => { dlg.remove(); resolve(null); });
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  async function takeOffPlaylist(project, id, ids) {
    const data = playlistData.get(id);
    if (!data || !ids.length) return;
    const before = data.versions.map((v) => v.id);
    try {
      await api('PATCH', `/api/playlists/${id}`, { versions: before.filter((x) => !ids.includes(x)) });
      vpick.ids.clear();
      paintVersionPick(project);
      playlistsChanged(project, id);
      undoable(`${plural(ids.length, 'version')} taken off ${data.playlist.name}`, async () => {
        await api('PATCH', `/api/playlists/${id}`, { versions: before });
        playlistsChanged(project, id);
      });
    } catch (err) {
      fail(err);
    }
  }

  // Its versions given anew in this order, as a drag left them.
  async function reorderPlaylist(project, id, order) {
    const data = playlistData.get(id);
    if (!data) return;
    const byId = new Map(data.versions.map((v) => [v.id, v]));
    playlistData.set(id, { ...data, versions: order.map((x) => byId.get(x)).filter(Boolean) });
    shownProject = '';
    render();
    try {
      await api('PATCH', `/api/playlists/${id}`, { versions: order });
      playlistsChanged(project, id);
    } catch (err) {
      fail(err);
    }
  }

  // A playlist's page: Play, and its versions in order, to drag into another order, open, or take off.
  async function playlistPage(project, id, fresh, sig) {
    const show = (data) => {
      if (shownProject !== sig) return;
      showContent(...playlistView(project, data));
      paintVersionPick(project);
    };
    const had = playlistData.get(id);
    if (had) show(had);
    else if (fresh) showContent(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      const data = await api('GET', `/api/playlists/${id}`);
      playlistData.set(id, data);
      renderCrumbs(route());
      if (!had || JSON.stringify(had) !== JSON.stringify(data)) show(data);
    } catch (err) {
      pageFailed(sig, err);
    }
  }

  function playlistView(project, data) {
    const { playlist, versions } = data;
    if (vpick.project !== project.id) {
      dropVersionPick();
      vpick.project = project.id;
    }
    vpick.order = versions.map((v) => v.id);
    const kinds = new Set(versions.map((v) => v.kind)).size > 1;
    const specs = versions.map((v, n) => versionObj(project, { id: v.entityId, name: v.entity, type: v.type }, v, {
      kinds,
      open: () => playPlaylist(project, data, v.id),
      menu: [['Open here', () => playPlaylist(project, data, v.id)], ['Take off the playlist', () => takeOffPlaylist(project, playlist.id, [v.id])]],
    }));
    const list = objectList('version', specs, { grid: 'board-grid ent-grid pl-grid' });
    dragToOrder(list, (order) => reorderPlaylist(project, playlist.id, order));
    return [
      el('div', { class: 'cat-tools' },
        el('button', { type: 'button', class: 'btn primary', html: `${ICON_PLAY}<span>Play</span>`, title: 'Open them in the player, from the first', disabled: !versions.length, onclick: () => playPlaylist(project, data, versions[0].id) }),
        el('a', { class: 'btn ghost', href: WB.href.versions(project.id), html: `${ICON_PLUS}<span>Add versions</span>`, title: 'Pick versions on the Versions page, then Add to playlist' })),
      label('Versions', versions.length, versions.length > 1 && el('span', { class: 'label-note', text: 'Drag to put them in order' })),
      versions.length ? list : el('p', { class: 'home-quiet', text: 'Nothing on it yet. Pick versions on the Versions page, the catalogue or a shot\'s page, and press Add to playlist.' }),
    ];
  }

  // Versions in a list put in another order by dragging one to where it should go: before the one it is
  // dropped on, or after it when dropped on its second half. `done` is given the new order of ids.
  function dragToOrder(list, done) {
    const nodes = () => [...list.querySelectorAll(VER_NODES)];
    let held = null;
    const clear = () => { for (const n of list.querySelectorAll('.drop-before, .drop-after')) n.classList.remove('drop-before', 'drop-after'); };
    const after = (node, e) => {
      const r = node.getBoundingClientRect();
      // Cards side by side go before or after by their halves across; rows of a table, down.
      return WB.layout() === 'table' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
    };
    for (const node of nodes()) {
      node.draggable = true;
      node.addEventListener('dragstart', (e) => {
        held = node.dataset.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', held); // Firefox will not start a drag without data
        requestAnimationFrame(() => node.classList.add('lifted'));
      });
      node.addEventListener('dragend', () => {
        held = null;
        node.classList.remove('lifted');
        clear();
      });
      node.addEventListener('dragover', (e) => {
        if (!held || held === node.dataset.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clear();
        node.classList.add(after(node, e) ? 'drop-after' : 'drop-before');
      });
      node.addEventListener('drop', (e) => {
        if (!held || held === node.dataset.id) return;
        e.preventDefault();
        const order = nodes().map((n) => n.dataset.id).filter((x) => x !== held);
        const at = order.indexOf(node.dataset.id) + (after(node, e) ? 1 : 0);
        order.splice(at, 0, held);
        clear();
        done(order);
      });
    }
  }

  // The playlist in the player, over the whole window, opened on `startId`: its versions one at a time,
  // each as filed with its own comments, to move between with the strip down the left or the arrows. It is
  // not an edit: nothing plays on into the next. Going elsewhere closes it.
  async function playPlaylist(project, data, startId) {
    // On the venue (a project with a model of it, as in an animatic) each is shown in the pass the project
    // puts on its model; otherwise as filed.
    const preview3d = project.settings && project.settings.preview3d;
    const load = async (in3d) => data.versions.map((v) => {
      const shown = WBViewer.inPass(v.look, in3d ? preview3d.pass : '');
      return { ...shown, src: WB.playable(shown), full: shown.src, id: v.id, type: shown.type, label: v.label, name: v.entity, entityId: v.entityId };
    });
    if (!data.versions.length) return;
    thePlayer();
    try {
      await WBViewer.openPlaylist(player, {
        load, me, at: startId,
        ...(preview3d && preview3d.model && { view3d: { ...preview3d, key: project.id } }),
        title: () => [project.name, data.playlist.name].filter(Boolean).join(' · '),
        onClose: () => { lookingAt = null; },
      });
      lookingAt = `playlist:${data.playlist.id}`;
    } catch (err) {
      fail(err);
    }
  }

  // ------------------------------------------------------------- a playlist outside a project
  //
  // A playlist that belongs to no project: made in any folder, next to the boards, and filled by adding
  // files to it. Each file is the next version of the playlist (v1, v2, …, in the order they came), looked
  // at and commented on in the player as a project's versions are. They can be put in another order and
  // taken off. For a small piece of work, such as one edit of a video that is added to as it is revised.

  const NO_PROJECT = { name: '', settings: null }; // what the player is told for a project it does not have
  const uploading = new Map(); // playlist id -> the files on their way in: [{ file, ctl, progress, phase, error }]

  function loosePlaylistObj(p, { kinds = false } = {}) {
    return {
      kind: 'playlist', tag: 'a', attrs: { href: WB.href.playlist(p.id) },
      still: el('div', { class: `card-thumbs strip n${Math.min(p.thumbs.length, 4)}` }, p.thumbs.map((src) => el('img', { src, alt: '', loading: 'lazy', draggable: 'false' }))),
      name: p.name,
      lines: [`${kinds ? 'Playlist · ' : ''}${plural(p.count, 'version')} · changed ${ago(p.updatedAt)}`],
      cells: { kind: 'Playlist', items: p.count, changed: [ago(p.updatedAt), new Date(p.updatedAt).toLocaleString()] },
      menu: loosePlaylistMenu(p),
      setup: (node) => draggable(node, 'playlist', p.id),
    };
  }

  function loosePlaylistMenu(p) {
    return [
      ['Rename…', () => rename('playlist', p)],
      ['Move to…', () => moveDialog('playlist', p)],
      [isPinned('playlist', p.id) ? 'Unpin from sidebar' : 'Pin to sidebar', () => togglePin({ kind: 'playlist', id: p.id })],
      hasPersonal && [`Move to ${SPACES[otherSpace(p.workspace)]} workspace`, () => moveSpace('playlist', p)],
      ['Delete playlist…', () => deleteLoosePlaylist(p), true],
    ].filter(Boolean);
  }

  async function newLoosePlaylist() {
    const name = await WB.dialog({
      title: 'New playlist', text: 'Add files to it as they are made: each is the next version, with its own comments.',
      value: '', placeholder: 'Playlist name', ok: 'Create playlist',
    });
    if (!name) return;
    try {
      const p = await api('POST', '/api/playlists', { name, folderId: currentFolder(), workspace: space, by: me.name });
      await refresh();
      location.hash = WB.href.playlist(p.id);
    } catch (err) {
      fail(err);
    }
  }

  async function deleteLoosePlaylist(p) {
    const ok = await WB.dialog({ title: `Delete ${p.name}?`, text: 'The playlist goes, with its versions and what was said about them.', ok: 'Delete playlist', danger: true });
    if (!ok) return;
    await api('DELETE', `/api/playlists/${p.id}`);
    playlistData.delete(p.id);
    if (currentLoose()?.id === p.id) location.hash = p.folderId && folderById(p.folderId) ? WB.href.folder(p.folderId) : spaceHref(p.workspace);
    refresh();
  }

  // What changed in it shows in the page and the lists at once.
  function looseChanged(id) {
    playlistData.delete(id);
    shownProject = '';
    return refresh();
  }

  // Its page: Play, and its versions in order, to drag into another order, open, or take off.
  async function loosePlaylistPage(p) {
    const sig = `pl|${p.id}`;
    const fresh = shownProject !== sig;
    shownProject = sig;
    const show = (data) => {
      if (shownProject === sig) showContent(...loosePlaylistView(p, data));
    };
    const had = playlistData.get(p.id);
    if (had) show(had);
    else if (fresh) showContent(el('p', { class: 'home-empty', text: 'Loading…' }));
    try {
      const data = await api('GET', `/api/playlists/${p.id}`);
      playlistData.set(p.id, data);
      if (!had || JSON.stringify(had) !== JSON.stringify(data)) show(data);
    } catch (err) {
      pageFailed(sig, err);
    }
  }

  function loosePlaylistView(p, data) {
    const { versions } = data;
    const kinds = new Set(versions.map((v) => v.kind)).size > 1;
    const specs = versions.map((v) => looseVersionObj(p, data, v, kinds));
    const list = objectList('clip', specs, {
      grid: 'board-grid ent-grid pl-grid',
      lead: { name: 'Add versions', meta: 'Choose files, or drop them here', title: 'Add the next version: choose images or videos, or drop them anywhere here', onclick: () => chooseFiles(p) },
    });
    dragToOrder(list, (order) => reorderLoose(p, data, order));
    const newest = versions[versions.length - 1];
    const page = [
      versions.length > 0 && el('div', { class: 'cat-tools' },
        el('button', { type: 'button', class: 'btn primary', html: `${ICON_PLAY}<span>Play</span>`, title: 'Open the newest version in the player, with the others beside it', onclick: () => playPlaylist(NO_PROJECT, data, newest.id) })),
      label('Versions', versions.length, versions.length > 1 && el('span', { class: 'label-note', text: 'Drag to put them in order' })),
      el('div', { class: 'pl-uploads', 'data-pl': p.id }),
      list,
    ].filter(Boolean);
    queueMicrotask(() => paintUploads(p.id));
    return page;
  }

  function looseVersionObj(p, data, v, kinds) {
    const open = () => playPlaylist(NO_PROJECT, data, v.id);
    return {
      kind: 'version', attrs: { 'data-id': v.id, tabindex: '0', 'aria-label': v.label, ondblclick: (e) => { if (!e.target.closest('a, button')) open(); } },
      still: verStill({ id: v.entityId, name: v.entity }, v, kinds && WB.layout() !== 'table', open),
      name: [el('span', { class: 'ver-ent', text: `v${v.number}` }), v.originalName && el('span', { class: 'ver-rest', text: ` ${v.originalName}` })],
      title: v.label,
      lines: [`Added ${ago(v.createdAt)}${v.createdBy ? ` by ${v.createdBy}` : ''}`],
      cells: {
        by: v.createdBy && el('span', { class: 'vt-who' }, WB.avatar(v.createdBy), el('span', { class: 'vt-main', text: v.createdBy })),
        changed: [ago(v.createdAt), new Date(v.createdAt).toLocaleString()],
      },
      menu: [['Open', open], ['Download', () => { location.href = v.look.orig || v.look.src; }], ['Take off the playlist', () => takeOffLoose(p, data, [v.id])]],
    };
  }

  async function takeOffLoose(p, data, ids) {
    const before = data.versions.map((v) => v.id);
    try {
      await api('PATCH', `/api/playlists/${p.id}`, { versions: before.filter((x) => !ids.includes(x)) });
      await looseChanged(p.id);
      undoable(`${plural(ids.length, 'version')} taken off ${p.name}`, async () => {
        await api('PATCH', `/api/playlists/${p.id}`, { versions: before });
        await looseChanged(p.id);
      });
    } catch (err) {
      fail(err);
    }
  }

  async function reorderLoose(p, data, order) {
    const byId = new Map(data.versions.map((v) => [v.id, v]));
    playlistData.set(p.id, { ...data, versions: order.map((x) => byId.get(x)).filter(Boolean) });
    shownProject = '';
    render();
    try {
      await api('PATCH', `/api/playlists/${p.id}`, { versions: order });
      await looseChanged(p.id);
    } catch (err) {
      fail(err);
    }
  }

  // ---- adding files: each is brought in as a file dropped on a board is (a video gets its review copy and
  // the rest, see bringIn), then becomes the playlist's next version. One at a time, in the order chosen,
  // so that they are numbered in that order.

  function chooseFiles(p) {
    const input = el('input', { type: 'file', multiple: true, accept: 'image/*,video/*,.mov' });
    input.addEventListener('change', () => addFiles(p, [...input.files]));
    input.click();
  }

  async function addFiles(p, files) {
    const media = files.filter((f) => WBIngest.fileExt(f));
    if (media.length < files.length) WB.toast(media.length ? 'Only images and videos can be added; the rest were left out.' : 'Only images and videos can be added.', { ms: 6000 });
    if (!media.length) return;
    const queue = uploading.get(p.id) || uploading.set(p.id, []).get(p.id);
    queue.push(...media.map((file) => ({ file, ctl: new AbortController(), progress: 0, phase: '', error: null })));
    paintUploads(p.id);
    if (queue.working) return;
    queue.working = true;
    try {
      for (let r; (r = queue.find((x) => !x.error)); ) {
        try {
          const look = await bringIn(r, () => paintUploads(p.id));
          const data = await api('POST', `/api/playlists/${p.id}/versions`, { files: [{ look }], by: me.name });
          playlistData.set(p.id, data);
          queue.splice(queue.indexOf(r), 1);
          shownProject = '';
          refresh();
        } catch (err) {
          r.error = err.message || 'It could not be added';
        }
        paintUploads(p.id);
      }
    } finally {
      queue.working = false;
    }
  }

  // The files on their way in, above the versions: a line each, with how far, or why it stopped.
  function paintUploads(id) {
    const box = document.querySelector(`.pl-uploads[data-pl="${id}"]`);
    if (!box) return;
    const queue = uploading.get(id) || [];
    const words = { enc: 'Preparing', up: 'Uploading', strip: 'Reading', orig: 'Uploading the original' };
    box.replaceChildren(...queue.map((r) => el('div', { class: 'pl-upload' },
      el('span', { class: 'pl-upload-name', text: r.file.name }),
      el('span', { class: 'pl-upload-state', text: r.error || `${words[r.phase] || 'Waiting'}${r.phase ? ` ${Math.round(r.progress * 100)}%` : ''}` }),
      r.error && el('button', {
        type: 'button', class: 'btn small ghost', text: 'Try again',
        onclick: () => { queue.splice(queue.indexOf(r), 1); addFiles(loose(id), [r.file]); },
      }),
      r.error && el('button', { type: 'button', class: 'btn small ghost', text: 'Remove', onclick: () => { queue.splice(queue.indexOf(r), 1); paintUploads(id); } }))));
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
    const passList = () => (cat ? cat.passList : Array.isArray(settings().passes) ? settings().passes : null) || null;
    const head = el('div', { class: 'imp-head' }, title, fillAll, el('span', { class: 'imp-gap' }), WBFiling.keysButton(), aiBtn, clearBtn, fileAll);
    // What each part of the rows' lines is, said once over them, as the project's settings have them.
    const labels = el('div', { class: 'imp-row imp-labels', hidden: true });
    let labelsFor = '';
    const paintLabels = () => {
      const key = JSON.stringify([useTasks(), passList()]);
      if (key !== labelsFor) {
        labelsFor = key;
        labels.replaceChildren(el('span'), el('span'), el('span', { class: 'imp-fields' }, WBFiling.lineHead({ useTasks: useTasks(), passes: passList() }), el('span', { class: 'imp-go' })), el('span', { class: 'imp-end' }));
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
    const passOf = (r) => r.fields.f.passName();
    const attachmentOf = (r) => r.fields.f.attachmentName();
    // The next number for a row: one past the highest its asset, set or shot and task has, counting the
    // rows above it still to be filed to the same. Another pass of the row just above (the same name and
    // task, from the same version of the file) is the same version, and has its number.
    // The row a pass goes with: another of the same asset, set or shot and task, from the same version of
    // the file (by the version its name says, when both say one), the main one first, above or below it.
    // Without a version in the names, the nearest row above going there.
    // An attachment goes with such a row too, one that is no attachment, or else with the newest version there is.
    function partnerOf(r) {
      const pass = passOf(r);
      const attachment = attachmentOf(r);
      if (!pass && !attachment) return null;
      const { name, task } = choiceOf(r);
      const others = rows.filter((o) => o !== r && o.fields && o.status !== 'failed' && (attachment ? !attachmentOf(o) : passOf(o) !== pass && !attachmentOf(o))
        && choiceOf(o).name === name && choiceOf(o).task === task);
      if (r.parsed.hip != null) {
        const same = others.filter((o) => o.parsed.hip === r.parsed.hip);
        return same.find((o) => !passOf(o)) || same[0] || null;
      }
      const above = others.filter((o) => rows.indexOf(o) < rows.indexOf(r));
      return above[above.length - 1] || null;
    }
    function nextNumber(r) {
      const { name, task } = choiceOf(r);
      const pass = passOf(r);
      if (attachmentOf(r)) {
        const partner = partnerOf(r);
        if (partner) return partner.status === 'filed' && partner.version ? partner.version.number : Number(partner.fields.num.value) || nextNumber(partner);
        const head = known(name) && known(name).heads && known(name).heads[task || ''];
        return head ? head.number : '';
      }
      if (pass) {
        const partner = partnerOf(r);
        if (partner) {
          const n = partner.status === 'filed' && partner.version ? partner.version.number
            : partner.numTouched || passOf(partner) ? Number(partner.fields.num.value) : nextNumber(partner);
          if (n) return n;
        }
        // On its own, it goes with the newest version there is of that, if that has no such pass yet.
        const newest = !partner && known(name) && known(name).newest;
        if (newest && (newest.task || null) === task && !WBViewer.inPass(newest.look, '').passNames.includes(pass)) return newest.number;
      }
      const have = known(name);
      let n = (have && have.tops ? have.tops[task || ''] || 0 : 0) + 1;
      for (const o of rows) {
        if (o === r) break;
        if (o.status === 'filed' || !o.fields) continue;
        // A pass that goes with another row makes no version of its own, nor does an attachment.
        if ((passOf(o) && partnerOf(o)) || attachmentOf(o)) continue;
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
        o.fields.f.take({ number: p.hip, pass: p.pass, named: true });
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
          now: { entity: r.fields.ent.value.trim() || null, task: r.fields.task.value.trim() || null, version: r.numTouched ? Number(r.fields.num.value) || null : null, pass: passOf(r) },
        })),
      });
      await catalogue().catch(() => {});
      const before = [];
      let n = 0;
      for (const r of asked) {
        const a = res.answers[r.key];
        if (!a || !unfiled(r)) continue;
        const f = r.fields;
        before.push({ r, ent: f.ent.value, task: f.task.value, type: f.type.value, num: f.num.value, numTouched: r.numTouched, pass: f.f.passName() });
        // Only the fields in its answer: asked to fill in the shot and the version and nothing more, the rest
        // are not there, and stay as they are. What is there may clear a field (no task, the main pass).
        if ('entity' in a) {
          f.ent.value = a.entity;
          f.type.value = a.type;
        }
        if ('task' in a) f.task.value = a.task || '';
        WBFiling.changed();
        if ('pass' in a && passList()) f.f.setPass(a.pass || passList()[0]);
        if ('version' in a) {
          r.numTouched = !!a.version;
          if (a.version) f.num.value = String(a.version);
        }
        setMark(r, WBClaude.mark(a.note, a.fits));
        n++;
      }
      // Passes given show their boxes, so what was filled in is seen and can be checked.
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
            b.r.fields.type.value = b.type;
            b.r.fields.num.value = b.num;
            if (passList()) b.r.fields.f.setPass(b.pass || passList()[0]);
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
        getEntities: () => (cat ? cat.entities : []), getTasks: tasks, passes: passList(), pass: r.parsed.pass || (ruled && ruled.pass), label: r.file.name,
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
      const { ent, task, type } = f;
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
        // Another pass of the version the row above is: shown as going with it.
        const above = rows[rows.indexOf(r) - 1];
        const { task } = choiceOf(r);
        r.node?.classList.toggle('with-above', !!(above && above.fields && (passOf(r) || attachmentOf(r)) && unfiled(r) && unfiled(above)
          && choiceOf(above).name === name && choiceOf(above).task === task && (attachmentOf(r) || passOf(above) !== passOf(r)) && Number(above.fields.num.value) === Number(num.value)));
        paintHead();
      };
      for (const input of [ent, task, num]) {
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented && canFile(r)) fileRow(r); });
        input.addEventListener('input', () => { r.touched = true; setMark(r, null); });
      }
      r.fields = { f, ent, task, num, pass: f.passSel, type, go, status, bar, thumb, said, undo, box: fields, sync };
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
      // Only while the server would take it back: a pass put with a version there already is not.
      f.undo.hidden = !(r.status === 'filed' && r.version && !r.version.filedPass && Date.now() - r.filedAt < WBFiling.UNFILE_WITHIN);
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
        await api('POST', `/api/versions/${r.version.id}/unfile`, { by: me.name, ...(r.version.filedAttachment && { attachment: r.version.filedAttachment }) });
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

    // Filed once however often it is asked (a pass's row asks for the row it goes with, which may be on its way already).
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
      // A pass or an attachment goes with its version, so the row that makes that version is filed first, then this counts from it.
      const partner = partnerOf(r);
      if (partner && !passOf(partner) && !attachmentOf(partner) && unfiled(partner) && (canFile(partner) || partner.inflight)) {
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
        const pass = passOf(r);
        const attachment = attachmentOf(r);
        const res = await api('POST', `/api/projects/${project.id}/versions`, { files: [{ look: r.look, entity, task, pass, ...(attachment && { attachment }), ...(Number.isSafeInteger(number) && number >= 1 && { number }) }], by: me.name });
        const v = res.versions[0];
        Object.assign(r, { status: 'filed', label: v.filedPass || v.filedAttachment ? `${v.label} · ${v.filedPass || v.filedAttachment}` : v.label, version: v, filedAt: Date.now() });
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
            filed: { entity: name, task, number: r.version.number, pass: passOf(r), passes: passList() || [] },
            others: rows.filter((o) => o !== r && o.fields && unfiled(o)).map((o) => ({ filename: o.file.name, fields: o.fields.f })),
            save: async (rule) => {
              await api('PATCH', `/api/folders/${project.id}`, { settings: { addRules: [rule] } });
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
    // (The catalogue is had first: what the project is set to, its passes among it, shapes each row.)
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
  // Files dropped anywhere on a playlist outside a project become its next versions.
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e) || !(catalogueOpen() || currentLoose())) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      const view = currentView();
      dropTargetEntity = view.entity;
      $('catdrop').querySelector('span').textContent = currentLoose() ? `Drop to add versions to ${currentLoose().name}` : view.entity ? 'Drop to add versions of it' : `Drop to add to ${catalogueOpen().name}`;
      $('catdrop').hidden = false;
    }
  });
  window.addEventListener('dragover', (e) => { if (carriesFiles(e) && (catalogueOpen() || currentLoose())) e.preventDefault(); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('catdrop').hidden = true; } });
  window.addEventListener('drop', async (e) => {
    const project = carriesFiles(e) && catalogueOpen();
    const playlist = carriesFiles(e) && currentLoose();
    dragDepth = 0;
    $('catdrop').hidden = true;
    if (playlist) {
      e.preventDefault();
      return void addFiles(playlist, [...e.dataTransfer.files]);
    }
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

  async function newFolder() {
    const name = await WB.dialog({ title: 'New folder', value: '', placeholder: 'Folder name', ok: 'Create folder' });
    if (!name) return;
    try {
      await api('POST', '/api/folders', { name, parentId: currentFolder(), workspace: space });
      refresh();
    } catch (err) {
      fail(err);
    }
  }
  $('newmore').addEventListener('click', (e) => {
    const project = projectHere();
    openMenu(e.currentTarget, [['New board', newBoard], ['New playlist', () => (project ? newPlaylist(project) : newLoosePlaylist())], ['New folder', newFolder]]);
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
  // player, the catalogue's versions or an animatic, as you show it; the lists in between they are not shown.
  if (WB.info().canShare) {
    // The player tells what it shows, and so does an animatic's page while it is open (and the player is not
    // open over it).
    WBPresent.init({ me: () => me, viewer: () => (cutPage && cutPage.ctl.presenter.isOpen() && !thePlayer().isOpen() ? cutPage.ctl.presenter : thePlayer()), player: thePlayer, project: projectHere, page: () => ({ k: 'idle' }) });
    presentBtn = WBPresent.button();
    presentBtn.hidden = true;
    $('presentslot').replaceWith(presentBtn);
    WBPresent.onChange(() => render());
  }
  await refresh();
  keepAhead();
  setInterval(() => { if (!document.hidden && !dragging && !document.querySelector('dialog[open], .menu:not([hidden])')) refresh(true); }, 15000);
})();
