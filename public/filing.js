'use strict';

// Filing pieces as versions, the same wherever it is done: a board's "File as a version" (Shift+V) and
// the catalogue's import strip ask the same questions, with the same fields. Each piece has a row:
// which asset, set or shot it is, and the task (when the project counts its versions by task). Several
// pieces can be given one answer to start from ("For all").
//
// Each row is one line of parts, labelled once above the rows (lineHead): what it is (an icon, with a
// dot when it is new, or a question when nothing says), its name, the task, the version it follows (its
// still, which shows the two side by side), the version it is to be, the view, the extra it is of that
// version (a label, empty for a version of its own), and what there is to say about it. What the page filled in itself, and nobody said (the next number, the main view), is faint,
// so that it reads as the guess it is. The name takes a whole line, read by WBNaming.readLine:
// "kilo-0010 anim v12 bty", a file name pasted in, or a short way to say a shot (20, +, .); a space after
// a name the project has, or a shot, moves on to the task, and a line that reads one way only goes into
// its parts as it is typed. What the line does not say (a change of length, and anything that looks
// wrong: a near miss of a name the project has, a shot written short, a new one nothing says the kind of, a new sequence like
// one there is, a second count for one shot) is behind a mark at its end, a warning when something is
// to be sorted out: clicked, it says it, worst first, each with the fix a click away. Suggestions come before anything
// is typed: what the piece looks like a new version of (by its picture, asked of the server), the row
// above, the next shot. Ctrl+D copies the row above; Shift+Enter numbers the rows below on from this one.
// Loaded after naming.js, before the pages that file.
const WBFiling = (() => {
  const { el } = WB;
  const N = WBNaming;
  const SHORT_HELP = 'Type a name, or a whole line: kilo-0010 anim v12. A space after a name moves on to the task. 20 is shot 0020 of the sequence above, + its next shot, . the same as the last. Ctrl+D copies the row above; Shift+Enter numbers the rows below on from this one';
  // A likeness that is more than the same length: two shots of a sequence are often as long as each
  // other, so that alone only ever hints.
  const looksAlike = (l) => l.why.includes('looks alike');

  // The newest version of each task of an entity, newest first: [{ task, number, thumb, at }].
  const streamsOf = (e) => Object.entries((e && e.heads) || {}).map(([task, h]) => ({ task: task || null, ...h })).sort((a, b) => b.at - a.at);
  // The number the next version of an entity and task gets, `before` more being filed ahead of it.
  const nextOf = (e, task, before = 0) => ((e && e.tops ? e.tops[task || ''] || 0 : 0) + 1 + before);
  // Counts what is typed or put into any row: a row's line is read again only after a change (see line
  // in fields). A page that writes into a row's boxes itself says so with changed().
  let edits = 0;
  const changed = () => { edits++; };
  // Two keys of what something was worked out from, the same.
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  // How long a filing can be taken back as if it had not been (as the server says: UNFILE_WITHIN in server.js).
  const UNFILE_WITHIN = 30 * 60 * 1000;

  // A suggestion of an entity and one of its tasks (or of the entity alone): what it is called, its
  // newest still, and the number the next gets.
  function streamOption(e, s, hint, useTasks) {
    const task = useTasks ? (s ? s.task : undefined) : null;
    return {
      value: e.name, task, label: task ? `${e.name} › ${task}` : e.name,
      thumb: (s && s.thumb) || e.thumb || null,
      hint: hint || (s ? `v${s.number} → v${nextOf(e, s.task)}` : `${e.tier}${e.versions ? ` · ${WB.plural(e.versions, 'version')}` : ''}`),
    };
  }
  const newOption = (name, kinds, hint) => ({ value: name, task: undefined, label: `New: ${name}`, hint: hint || N.kindOf(name, kinds || []) || 'say what it is', make: true });

  // Suggestions for "which asset, set or shot", as a line is typed, best first. `ctx` is what the row
  // knows besides: { entities, tasks, useTasks, line context (see readLine), likely, above }.
  function suggest(ctx, typed, max = 9) {
    const list = ctx.entities || [];
    const names = list.map((e) => e.name);
    const byName = new Map(list.map((e) => [e.name, e]));
    const useTasks = ctx.useTasks !== false;
    const out = [];
    const seen = new Set();
    const push = (o) => {
      const key = `${o.value}|${o.task || ''}`;
      if (o.value && !seen.has(key) && out.length < max) {
        seen.add(key);
        out.push(o);
      }
    };
    const streamsFor = (e, hint) => {
      const ss = streamsOf(e).filter((s) => useTasks || !s.task);
      if (!ss.length) return push(streamOption(e, null, hint, useTasks));
      for (const s of ss) push(streamOption(e, s, hint, useTasks));
    };
    const likely = ctx.likely || [];
    const text = String(typed || '').trim();
    const likeOption = (l) => streamOption(byName.get(l.entity), streamsOf(byName.get(l.entity)).find((s) => s.task === l.task), `like its v${l.number}: ${l.why.join(', ')}`, useTasks);
    if (!text) {
      // Before anything is typed: what the piece looks like a version of, then the row above (or what
      // was filed last), the next shot after it, what is only as long as the piece, and what had
      // versions lately. Enter takes the first, when it is one of the first two kinds.
      for (const l of likely) if (looksAlike(l) && byName.has(l.entity)) push(likeOption(l));
      const last = ctx.line && ctx.line.last;
      if (last && last.entity) {
        const e = byName.get(last.entity);
        const s = e && streamsOf(e).find((x) => x.task === (last.task || null));
        push(e ? { ...streamOption(e, s, ctx.above ? 'same as above' : 'same as last', useTasks), task: useTasks ? last.task || null : null }
          : { ...newOption(last.entity, ctx.entities, ctx.above ? 'same as above' : 'same as last'), task: useTasks ? last.task || null : null });
      }
      if (out.length) out[0].first = true;
      const seq = ctx.line && ctx.line.seq;
      if (seq) {
        const next = N.nextShot([...names, ...((ctx.line && ctx.line.taken) || [])], seq);
        push({ ...newOption(next, ctx.entities, `next shot in ${seq}`), task: useTasks && last ? last.task || null : undefined });
      }
      for (const l of likely) if (!looksAlike(l) && byName.has(l.entity)) push(likeOption(l));
      for (const e of [...list].filter((x) => x.latestAt).sort((a, b) => b.latestAt - a.latestAt)) push(streamOption(e, streamsOf(e).find((s) => useTasks || !s.task), 'lately', useTasks));
      return out;
    }
    const line = N.readLine(text, ctx.line);
    const name = line.entity;
    // A short way to say a shot, or a file name pasted in: what it was read as, first.
    if (line.short && name) {
      if (byName.has(name)) push({ ...streamOption(byName.get(name), null, line.short, useTasks), task: line.task });
      else push({ ...newOption(name, ctx.entities, line.short), task: line.task });
    }
    // A name the project has, and more after it: its tasks that start with what was typed.
    const words = text.split(/\s+/);
    if (name && byName.has(name) && words.length > 1 && useTasks) {
      const e = byName.get(name);
      const typedTask = N.tokenize(words.slice(1).join('-'));
      for (const s of streamsOf(e)) if (s.task && s.task.startsWith(typedTask)) push(streamOption(e, s, null, true));
      if (line.task && !streamsOf(e).some((s) => s.task === line.task)) push({ value: e.name, task: line.task, label: `${e.name} › ${line.task}`, thumb: e.thumb || null, hint: 'new task: v1', make: true });
    }
    // The names that start with or hold what was typed, those it looks like first. Few of them: each with its tasks.
    const like = new Set(likely.filter(looksAlike).map((l) => l.entity));
    const ranked = WB.rank(list, words.length > 1 && name ? name : text, (e) => e.name, 40).sort((a, b) => like.has(b.name) - like.has(a.name));
    for (const e of ranked.slice(0, 6)) {
      if (ranked.length <= 3) streamsFor(e);
      else push(streamOption(e, streamsOf(e).find((s) => useTasks || !s.task), null, useTasks));
    }
    // "kilo-": the sequence's next shot.
    const seqTyped = /^([a-z0-9]+(?:-[a-z0-9]+)*)-$/.exec(text.toLowerCase());
    if (seqTyped && names.some((n) => N.seqOf(n) === seqTyped[1])) push(newOption(N.nextShot(names, seqTyped[1]), ctx.entities, `next shot in ${seqTyped[1]}`));
    if (name && !byName.has(name)) {
      for (const miss of N.nearMisses(name, names)) push(streamOption(byName.get(miss), null, 'did you mean?', useTasks));
      for (const c of N.corrections(name, names)) push(byName.has(c.name) ? streamOption(byName.get(c.name), null, 'as a shot', useTasks) : newOption(c.name, ctx.entities, `new ${c.tier}`));
      push(newOption(name, ctx.entities));
    }
    // A pick keeps what else the line said: a suggestion names only the entity (and perhaps its task).
    for (const o of out) {
      if (o.task === undefined && line.task !== undefined) o.task = line.task;
      o.number = line.number;
      o.view = line.view;
      o.extra = line.extra;
    }
    return out;
  }

  // ---- the version a piece follows, beside it

  // Under the pointer (after a moment) or the keyboard, `node` shows what `what()` gives side by side:
  // { before, after } looks (the version followed, and the piece), their labels, and how their lengths
  // differ. Two videos play together from the start, and both start again when either ends.
  let compare = null;
  function compareOn(node, what) {
    let wait = 0;
    const open = () => {
      const w = what();
      if (!w.before || !w.after) return;
      shut();
      const pane = (look, caption) => {
        const src = look.type === 'video' ? WB.playable(look) : look.prev || look.src;
        const media = look.type === 'video'
          ? el('video', { src, poster: look.poster || null, muted: '', playsinline: '', preload: 'auto' })
          : el('img', { src, alt: '' });
        if (look.type === 'video') media.muted = true;
        return { media, node: el('figure', {}, media, el('figcaption', { text: caption })) };
      };
      const seconds = (look) => (look.type === 'video' && look.dur > 0 ? ` · ${look.dur.toFixed(1)} s` : '');
      const a = pane(w.before, `${w.beforeLabel}${seconds(w.before)}`);
      const b = pane(w.after, `This${seconds(w.after)}${w.change ? ` · ${w.change.text}` : ''}${w.alike ? ' · looks alike' : ''}`);
      const box = el('div', { class: 'file-compare', role: 'tooltip' }, a.node, b.node);
      (node.closest('dialog') || document.body).append(box);
      const r = node.getBoundingClientRect();
      const bw = box.offsetWidth;
      const bh = box.offsetHeight;
      box.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - bw - 8)))}px`;
      box.style.top = `${Math.round(r.top - bh - 8 > 8 ? r.top - bh - 8 : Math.min(r.bottom + 8, innerHeight - bh - 8))}px`;
      const videos = [a.media, b.media].filter((m) => m.tagName === 'VIDEO');
      const again = () => { for (const v of videos) { v.currentTime = 0; v.play().catch(() => {}); } };
      let loaded = 0;
      for (const v of videos) {
        v.addEventListener('canplay', () => { if (++loaded === videos.length) again(); }, { once: true });
        v.addEventListener('ended', again);
      }
      // The still it opened from may be painted afresh under it: then it goes too.
      const gone = setInterval(() => { if (!node.isConnected) shut(); }, 400);
      compare = { box, node, gone };
    };
    const later = () => { clearTimeout(wait); wait = setTimeout(open, 250); };
    const close = () => { clearTimeout(wait); if (compare && compare.node === node) shut(); };
    node.addEventListener('pointerenter', later);
    node.addEventListener('pointerleave', close);
    node.addEventListener('focus', open);
    node.addEventListener('blur', close);
    node.addEventListener('keydown', (e) => { if (e.key === 'Escape' && compare) { e.preventDefault(); e.stopPropagation(); shut(); } });
  }
  function shut() {
    if (!compare) return;
    clearInterval(compare.gone);
    for (const v of compare.box.querySelectorAll('video')) v.removeAttribute('src');
    compare.box.remove();
    compare = null;
  }

  // ---- a small box of words over the page, opened from a button, one at a time

  // `content()` is what it shows, made afresh each time it is painted; `paint()` on what comes back does
  // that while it is open. It goes on a click elsewhere, Escape, or once its button is gone.
  let popped = null;
  function popOver(button, content) {
    shutPop();
    const box = el('div', { class: 'file-pop', role: 'dialog' });
    (button.closest('dialog') || document.body).append(box);
    const place = () => {
      const r = button.getBoundingClientRect();
      box.style.left = `${Math.round(Math.max(8, Math.min(r.right - box.offsetWidth, innerWidth - box.offsetWidth - 8)))}px`;
      box.style.top = `${Math.round(r.bottom + 6 + box.offsetHeight < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - box.offsetHeight - 6))}px`;
    };
    const paint = () => {
      box.replaceChildren(...[].concat(content()));
      place();
    };
    const away = (e) => { if (!box.contains(e.target) && !button.contains(e.target)) shutPop(); };
    const esc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); shutPop(); button.focus(); } };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc, true);
    const gone = setInterval(() => { if (!button.isConnected) shutPop(); }, 400);
    button.setAttribute('aria-expanded', 'true');
    popped = { box, button, paint, off: () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc, true); clearInterval(gone); } };
    paint();
    return popped;
  }
  function shutPop() {
    if (!popped) return;
    popped.off();
    popped.box.remove();
    popped.button.setAttribute('aria-expanded', 'false');
    popped = null;
  }

  // The keys that work where pieces are filed, behind a button.
  const KEYS = [
    ['kilo-0010 anim v12', 'a whole line; a space moves on from the name'],
    ['20  +  kilo+', 'shot 0020 of the sequence above, its next shot, kilo\'s next'],
    ['.', 'the same as the row above'],
    ['Enter', 'takes what is suggested'],
    ['Ctrl+D', 'copies the row above'],
    ['Shift+Enter', 'fills in the rows below on from this one'],
  ];
  function keysButton() {
    const b = el('button', { type: 'button', class: 'iconbtn file-keys-btn', html: WB.icon('help', 16), title: 'Typing a row', 'aria-label': 'Typing a row', 'aria-expanded': 'false' });
    b.addEventListener('click', () => {
      if (popped && popped.button === b) return shutPop();
      popOver(b, () => [el('b', { text: 'Typing a row' }), el('dl', { class: 'file-keys-list' }, KEYS.flatMap(([k, what]) => [el('dt', { text: k }), el('dd', { text: what })])),
        el('p', { text: 'Faint is filled in, not said.' })]);
    });
    return b;
  }

  // The parts of a row's line, as columns, the same on every row and in the labels over them.
  const lineColumns = ({ useTasks, views }) => ['34px', 'minmax(120px, 1fr)', useTasks && 'minmax(64px, 110px)', '72px', '62px', views && 'minmax(56px, 84px)', 'minmax(64px, 96px)', '30px'].filter(Boolean).join(' ');
  // The labels over the rows' lines, once: what each part of them is.
  function lineHead({ useTasks = true, views = null } = {}) {
    const node = el('span', { class: 'file-line file-labels', 'aria-hidden': 'true' },
      el('span'), el('span', { text: 'Asset, set or shot' }), useTasks && el('span', { text: 'Task' }),
      el('span', { text: 'Follows' }), el('span', { text: 'Version' }), views && el('span', { text: 'View', title: `${views[0]} is the main one: a version of its own` }),
      el('span', { text: 'Extra', title: 'A label here adds the file to that version as an extra, rather than making a version of its own' }), el('span'));
    node.style.gridTemplateColumns = lineColumns({ useTasks, views });
    return node;
  }
  const TIER_ICON = { asset: 'cube', set: 'set', shot: 'film' };

  // One piece's fields. `getEntities()` and `getTasks()` are the project's as last known;
  // `onChange` hears every edit. The tier is asked only for a new name whose shape does not say it, and
  // the task only when the project counts by task (`useTasks`). `peers()` are the fields of the rows
  // still to be filed, in order, this one among them: what is above says what a short line means, and
  // the keys that fill rows in work on those below. `remembered` is what was filed last ({ entity, task }).
  // `numberOf()`, when the page has a number field of its own (`numInput`, put in the line, faint while
  // `numAuto()` says the page filled it in), is its number, and `onLine(line)` hears a line's number to
  // put in it; otherwise the line has one here, and what is typed in it or said by a line is kept in
  // `typedNumber()`, starting from `number`. `views` are the project's views, the main one first (null when it shows each
  // version one way): the row then has a View picker (`viewSel`, starting at `view`, the one its name
  // says), and `viewName()` is the one picked, null for the main one. A word after the version that is no
  // view (in a project shown one way, any word) makes the piece an extra of that version instead:
  // `extraName()` is its label, null for a version or view of its own. `named` says the entity given
  // was read from the piece's own file name. `rules` let the project's learned rules read pasted names;
  // `say(text, undo)` tells the person something the keys did (a toast unless the page says otherwise).
  // `piece()` is the look of what is being filed (to compare it with the version it follows).
  function fields({
    entity = '', task = '', getEntities, getTasks, label = 'it', onChange = () => {},
    useTasks = true, peers = () => [], remembered = null, numberOf = null, onLine = null, rules = () => [],
    number: typedNumber = null, view: namedView = null, views = null, named = false, say = null, piece = () => null,
    numInput = null, numAuto = null,
  }) {
    const readout = el('div', { class: 'file-says', id: `fs-${WB.uid()}` });
    const ent = el('input', { type: 'text', value: entity, placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': `What ${label} is`, 'aria-describedby': readout.id, title: SHORT_HELP });
    const taskIn = el('input', { type: 'text', value: task, placeholder: 'task', spellcheck: 'false', 'aria-label': 'Task', hidden: !useTasks });
    // What it is, as an icon: the project's when it has it; for a new one, what it is said to be (`tier`),
    // else a shot by its shape, else what the project's names starting the same way are, else a question.
    // A new one's icon is a button, to say otherwise: it opens a menu of what it can be, with a tick on what
    // it is taken to be now. What is said is its `value` ('' while nothing is).
    const kind = el('span', { class: 'file-kind' });
    const tier = el('button', { type: 'button', class: 'file-ask', value: '', 'aria-label': 'What it is', 'aria-haspopup': 'menu', title: 'What is it?' });
    const sayTier = (id) => {
      tier.value = id;
      sync();
      onChange();
    };
    tier.addEventListener('click', () => {
      if (document.querySelector('.tier-menu')) return WB.closeMenus();
      const n = name();
      const now = tier.value || (n && N.kindOf(n, entities())) || '';
      WB.menu(tier, N.TIER_LIST.map((t) => el('button', {
        type: 'button', class: `menu-item menu-check${t.id === now ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(t.id === now),
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          WB.closeMenus();
          tier.focus();
          sayTier(t.id);
        },
      }, el('span', { class: 'menu-tick', html: t.id === now ? WB.icon('check', 14) : '' }), el('span', { class: 'menu-icon', html: WB.icon(TIER_ICON[t.id], 15) }), el('span', { text: t.one[0].toUpperCase() + t.one.slice(1) }))), { align: 'left', cls: 'tier-menu' });
    });
    // The version it follows, and the one it is to be: typed, or the next (faint).
    const prevSlot = el('span', { class: 'file-follows' });
    const verIn = numInput || el('input', { type: 'text', inputmode: 'numeric', value: typedNumber ? String(typedNumber) : '', spellcheck: 'false', 'aria-label': 'Version', title: 'Version: the next one, unless you say another' });
    verIn.classList.add('file-ver');
    const verSeg = el('span', { class: 'file-vseg' }, el('span', { class: 'file-vmark', text: 'v' }), verIn);
    // Which view of its version the piece is: the main one (a version of its own) or one of the others,
    // to go with a version. A name that says a view the project does not have is asked about, not guessed.
    const viewSel = views && el('select', { class: 'file-view', 'aria-label': 'View', title: `Which way of its version it shows. ${views[0]}, the main one, is a version of its own; the others go with one` },
      el('option', { value: '', text: views[0] }), views.slice(1).map((v) => el('option', { value: v, text: v })));
    // Which extra of its version it is: a label, or nothing for a version (or view) of its own. Filled
    // in from its name, or typed.
    const extraIn = el('input', { type: 'text', class: 'file-extra', placeholder: '', spellcheck: 'false', 'aria-label': 'Extra', title: 'A label (light-a, still-1043) adds it to the version as an extra. Empty: a version of its own' });
    // What there is to say about it, behind a mark at the end of the line (see paintReadout).
    const info = el('button', { type: 'button', class: 'file-info', 'aria-expanded': 'false', tabindex: '-1' });
    info.addEventListener('pointerdown', (e) => e.preventDefault());
    info.addEventListener('click', () => {
      if (popped && popped.button === info) return shutPop();
      if (readout.childNodes.length) popOver(info, () => readout);
    });
    const line_ = el('span', { class: 'file-line' }, el('span', { class: 'file-is' }, kind, tier), ent, useTasks ? taskIn : null, prevSlot, verSeg, viewSel || null, extraIn, el('span', { class: 'file-info-cell' }, info));
    line_.style.gridTemplateColumns = lineColumns({ useTasks, views });
    // Which extra of its version it is, if it is one (see readout: it says so, with the way back).
    let extra = null;
    const setExtra = (x) => {
      extra = N.tokenize(x || '') || null;
      extraIn.value = extra || '';
    };
    function setView(v) {
      if (!v) return;
      if (!views || !views.includes(v)) return setExtra(v);
      setExtra(null);
      viewSel.value = v === views[0] ? '' : v;
    }
    setView(namedView);
    const viewName = () => (!extra && viewSel && viewSel.value) || null;
    const extraName = () => extra;
    let likely = [];
    let fromName = named && !!entity;
    // What a line said of the number, on a page with no field for it. Said by a line, it goes when the
    // name is changed (it was said of that one); given by the page, it stays. A view said goes to the picker.
    const own = { number: typedNumber, said: false };
    const toLine = (l) => {
      if (l.view) setView(l.view);
      if (l.extra) setExtra(l.extra);
      if (l.number == null) return;
      if (onLine) return onLine(l);
      own.number = l.number;
      own.said = true;
    };
    const tell = say || ((text, undo) => WB.toast(text, { key: 'filing', ms: 8000, action: undo && { label: 'Undo', run: undo } }));
    const self = {};
    const entities = () => getEntities() || [];
    const have = (n) => entities().find((e) => e.name === n) || null;
    // The rows, and where this one is among them, as they are while one repaint runs (asked for again
    // and again in it, and the same throughout).
    let near = null;
    const around = () => {
      if (!near) {
        const list = peers();
        near = { list, at: list.indexOf(self) };
        queueMicrotask(() => { near = null; });
      }
      return near;
    };

    // What a short line means here: the sequence of the nearest row above with a shot (else of what was
    // filed last), what that row (or the last) was, and the names the rows above are taking.
    // (What is above is only worked out when a line asks: most lines are plain names.)
    function lineContext() {
      const { list, at } = around();
      const above = at > 0 ? list.slice(0, at) : [];
      const prev = above.length ? above[above.length - 1] : null;
      const last = () => (prev && prev.name() ? { entity: prev.name(), task: prev.taskName() } : remembered);
      return {
        entities: entities(), names: entities().map((e) => e.name), tasks: getTasks() || [], views: views || [], useViews: !!views, useTasks, rules: rules(), above: !!prev,
        get last() { return last(); },
        get taken() { return above.map((p) => p.name()).filter(Boolean); },
        get seq() {
          for (let i = above.length - 1; i >= 0; i--) if (N.tierOf(above[i].name()) === 'shot') return N.seqOf(above[i].name());
          const l = last();
          return l && N.tierOf(l.entity) === 'shot' ? N.seqOf(l.entity) : null;
        },
      };
    }
    // A line is read again only once something has changed, in it, in the rows around it or in the
    // project: a short line is read by the rows above it, so reading every row afresh on each repaint
    // would go up as the cube of how many there are.
    let read = null;
    const line = () => {
      const { list, at } = around();
      const key = [edits, list.length, at, entities().length, ent.value];
      if (!read || !same(read.key, key)) read = { key, line: N.readLine(ent.value, lineContext()) };
      return read.line;
    };
    const name = () => line().entity || '';
    let taskRead = { value: null, name: null };
    const taskName = () => {
      if (!useTasks) return null;
      const l = line();
      if (l.task !== undefined) return l.task || null;
      if (taskRead.value !== taskIn.value) taskRead = { value: taskIn.value, name: N.tokenize(taskIn.value) || null };
      return taskRead.name;
    };

    // The line, said in the fields: the name in the first, the task in its own, and a number and view
    // to the page (or kept here). A line with words it could not read stays as it is, said under the
    // row, rather than lose them.
    function settle() {
      const l = line();
      if (!l.entity || l.rest.length || (ent.value === l.entity && l.task === undefined && l.number == null && !l.view && !l.extra)) return;
      changed();
      ent.value = l.entity;
      if (useTasks && l.task !== undefined) taskIn.value = l.task || '';
      if (l.number != null || l.view || l.extra) toLine(l);
      sync();
      onChange();
    }
    // Put in by a key, a suggestion or the page: a name and (when given) a task.
    function setLine(n, t) {
      changed();
      fromName = false;
      ent.value = n || '';
      if (useTasks && t !== undefined) taskIn.value = t || '';
      sync();
    }

    // What Enter puts in a box with nothing in it: what the piece looks like a new version of, or else
    // the row above (or what was filed last). Said under the row and in the box, before anything is typed.
    function topPick() {
      const like = likely.find((l) => looksAlike(l) && have(l.entity));
      if (like) return { entity: like.entity, task: useTasks ? like.task || null : null, why: `like its v${like.number}` };
      const last = lineContext().last;
      if (last && last.entity) return { entity: last.entity, task: useTasks ? last.task || null : null, why: lineContext().above ? 'as above' : 'as last filed' };
      return null;
    }

    const combo = WB.combo(ent, (typed) => suggest({
      entities: entities(), useTasks, likely, line: lineContext(), above: lineContext().above,
    }, typed), {
      quiet: true,
      onPick: (o) => {
        changed();
        fromName = false;
        if (useTasks && o.task !== undefined) taskIn.value = o.task || '';
        if (o.number != null || o.view || o.extra) toLine({ number: o.number, view: o.view, extra: o.extra });
        settle();
        sync();
        onChange();
      },
    });
    WB.combo(taskIn, (typed) => {
      // The tasks of the one named first, with how far each has counted, then the project's.
      const e = have(name());
      const ownTasks = streamsOf(e).filter((st) => st.task).map((st) => ({ value: st.task, label: st.task, hint: `v${st.number} → v${st.number + 1}` }));
      const rest = WB.rank(getTasks() || [], typed).filter((t) => !ownTasks.some((o) => o.value === t)).map((t) => ({ value: t, label: t }));
      return [...WB.rank(ownTasks, typed, (o) => o.value), ...rest].slice(0, 9);
    }, { quiet: true });

    // The keys that fill rows in (registered before the suggestions', so Shift+Enter is never taken as a
    // pick, and Enter in an empty box with no list open takes what it would be).
    ent.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        const { list, at } = around();
        const prev = list[at - 1];
        if (!prev) return;
        e.preventDefault();
        setLine(prev.name(), prev.taskName());
        combo.hide();
        onChange();
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        settle();
        combo.hide();
        const done = series(self, peers(), entities());
        if (done) tell(done.text, done.undo);
        onChange();
      } else if (e.key === 'Enter' && !ent.value.trim() && combo.list.hidden) {
        const top = topPick();
        if (!top) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setLine(top.entity, top.task === null ? '' : top.task);
        onChange();
      }
    }, true);
    taskIn.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D'))) return;
      const { list, at } = around();
      const prev = list[at - 1];
      if (!prev) return;
      e.preventDefault();
      changed();
      taskIn.value = prev.taskName() || '';
      sync();
      onChange();
    });
    ent.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) settle(); });
    ent.addEventListener('blur', () => settle());
    ent.addEventListener('paste', () => setTimeout(settle, 0));

    // ---- what the row will be, said under it

    // What there is to say about the row, each { text, fixes: [{ label, run }] } and how much it
    // matters: `warn` (with its `rank`, the worst lowest), `ok`, or neither (only telling). Asked for
    // several times in a repaint (the mark at the end of the line, filing), and worked out once until
    // something changes: it reads the rows above, so working it out each time would be slow with many.
    let judged = null;
    let likelyAt = 0;
    function checks() {
      const { list, at } = around();
      const key = [edits, list.length, at, entities().length, likelyAt, ent.value, taskIn.value, tier.value, own.number, numberOf && numberOf(), viewName(), extra, (piece() || {}).dur];
      if (!judged || !same(judged.key, key)) judged = { key, out: judge() };
      return judged.out;
    }
    function judge() {
      const n = name();
      if (!n) return [];
      const out = [];
      const list = entities();
      const names = list.map((x) => x.name);
      const l = line();
      const e = have(n);
      const typed = ent.value.trim();
      if (l.short) out.push({ text: `${typed} is ${l.short}: ${n}` });
      else if (typed !== n && l.task === undefined && l.number == null && !l.view && !l.extra && !l.rest.length) out.push({ text: `Called ${n}` });
      if (l.rest.length) out.push({ text: `Not read: ${l.rest.join(' ')}. Take it out${useTasks ? ' or put it in the task' : ''} to file`, warn: true, rank: 0 });
      // An extra: which version it goes with, or that there is none; a view it may have been meant as; and
      // the way back to a version of its own.
      if (extra) {
        const at = number();
        const head = headOf();
        const ahead = around().list.slice(0, Math.max(0, around().at)).some((p) => p.name() === n && p.taskName() === taskName() && !p.extraName());
        const fixes = [...(views || []).filter((x) => x !== views[0]).map((x) => ({ label: `the ${x} view`, run: () => { changed(); setView(x); sync(); } })),
          { label: 'A version of its own', run: () => { changed(); setExtra(null); sync(); } }];
        if (!at || (!ahead && !(e && at <= ((e.tops || {})[taskName() || ''] || 0)))) out.push({ text: `An extra, “${extra}”, but there is no ${at ? N.label(n, taskName(), at) : `version of ${N.label(n, taskName(), '').replace(/ v$/, '')}`} to add it to`, fixes, warn: true, rank: 0 });
        else if (head && head.number === at && (head.look.extraNames || []).includes(extra)) out.push({ text: `${N.label(n, taskName(), at)} has an extra called “${extra}” already`, fixes, warn: true, rank: 0 });
        else out.push({ text: `Adds it to ${N.label(n, taskName(), at)} as an extra, “${extra}”`, fixes, extra: true });
      }
      const v = viewName();
      if (v) {
        const at = number();
        const head = headOf();
        // Another row (above or below) that makes the version it goes with.
        const ahead = around().list.some((p) => p !== self && p.name() === n && p.taskName() === taskName() && p.viewName() !== v && p.number() === at);
        if (head && head.number === at && (head.look.viewNames || []).includes(v)) out.push({ text: `${N.label(n, taskName(), at)} has its ${v} already`, warn: true, rank: 0 });
        else out.push({ text: ahead || (e && at <= ((e.tops || {})[taskName() || ''] || 0)) ? `Adds its ${v} to ${N.label(n, taskName(), at)}` : `A new ${N.label(n, taskName(), at)}, shown as ${v} only` });
      }
      if (!e) {
        const misses = N.nearMisses(n, names);
        if (misses.length) out.push({ text: 'Not in the project. Did you mean', fixes: misses.map((m) => ({ label: m, run: () => setLine(m) })), warn: true, rank: 1 });
        const tierNow = N.tierOf(n);
        // A shot written short (kilo-10) or run on (kilo10) is offered as the shot it is.
        const fixes = N.corrections(n, names).filter((c) => !misses.includes(c.name)).slice(0, 2);
        if (fixes.length) out.push({ text: 'A shot? Perhaps', fixes: fixes.map((c) => ({ label: c.name, run: () => setLine(c.name) })), warn: true, rank: 2 });
        // Nothing says what a new one is: it is asked, nothing is assumed.
        if (!tier.value && !N.kindOf(n, list)) {
          out.push({ text: 'New: what is it?', fixes: N.TIER_LIST.map((t) => ({ label: t.one, run: () => { changed(); tier.value = t.id; sync(); } })), warn: true, rank: 2 });
        }
        if (tierNow === 'shot') {
          const seq = N.seqOf(n);
          const seqs = [...new Set(names.filter((x) => N.tierOf(x) === 'shot').map((x) => N.seqOf(x)))];
          const taken = lineContext().taken;
          const above = taken.some((x) => N.seqOf(x) === seq && N.tierOf(x) === 'shot');
          if (!seqs.includes(seq) && !above) {
            // A warning when it is a letter or two from one there is; otherwise said in the tag that says
            // it is new (see paintReadout), and asked about when filed.
            const like = N.nearMisses(seq, seqs);
            out.push({ text: like.length ? `A new sequence, ${seq}. Did you mean` : '', fixes: like.map((q) => ({ label: q, run: () => setLine(N.shotName(q, N.shotNumber(n))) })), warn: like.length > 0, rank: 1, newSeq: seq });
          } else {
            // Past the last shot there is, or that a row above is making: a run of new shots warns once, at its jump.
            const sq = N.sequence([...names, ...taken], seq);
            const num = N.shotNumber(n);
            if (sq.last && num > sq.last + 10 * sq.step) out.push({ text: `Far past the last shot of ${seq} (${N.pad(sq.last)})`, warn: true, rank: 5 });
          }
        }
      }
      // A number typed that the count has passed already: most likely someone's, or was (numbers are never
      // given twice), unless it was skipped. The server says for sure when it is filed.
      const top = e ? (e.tops || {})[taskName() || ''] || 0 : 0;
      if (e && !numberOf && !extra && own.number && own.number <= top) {
        out.push({ text: `${N.label(n, taskName(), own.number)} is probably taken: the count is at v${top}`, fixes: [{ label: 'The next instead', run: () => { changed(); own.number = null; sync(); } }], warn: true, rank: 0 });
      }
      if (e && useTasks) {
        // A second count for one asset, set or shot: with a task beside one without, or the other way.
        const t = taskName();
        const tops = e.tops || {};
        const counted = Object.keys(tops).filter((k) => k);
        if (t && !tops[t] && tops['']) {
          out.push({ text: `${n} has ${tops[''] > 1 ? `v1–v${tops['']}` : 'a v1'} with no task: this starts ${t} at v1`, fixes: [{ label: `File as v${tops[''] + 1} with no task`, run: () => { changed(); taskIn.value = ''; sync(); } }], warn: true, rank: 4 });
        } else if (!t && !tops[''] && counted.length) {
          out.push({ text: `${n} is counted by task (${counted.map((k) => `${k} v${tops[k]}`).join(', ')}): this starts a count with no task`, fixes: counted.slice(0, 3).map((k) => ({ label: k, run: () => { changed(); taskIn.value = k; sync(); } })), warn: true, rank: 4 });
        }
      }
      // How much longer or shorter it is than the version it follows: what a playblast is checked for.
      const change = lengthChange();
      if (change) out.push({ text: change.text });
      // What the piece itself looks like it is, by its picture: said when it agrees (a tick on the still
      // of the version it follows), and when it seems to be something else. Being as long as a shot is
      // not enough to say either.
      const best = likely.find(looksAlike);
      if (best) {
        const same = best.entity === n && (!useTasks || (best.task || null) === taskName());
        if (same) out.push({ text: `Like its v${best.number}: ${best.why.join(', ')}`, ok: true });
        else if (best.score >= 0.75) out.push({ text: 'It looks like', fixes: [{ label: N.label(best.entity, useTasks ? best.task : null, best.number), run: () => setLine(best.entity, useTasks ? best.task || '' : undefined) }], warn: true, rank: 3 });
      }
      return out;
    }
    // The newest version of the entity and task it goes to, which it follows.
    const headOf = () => {
      const e = have(name());
      return e && e.heads ? e.heads[taskName() || ''] || null : null;
    };
    // How many frames longer or shorter it is than that, as { frames, text }, or null when they are as
    // long (or either is not a video).
    function lengthChange() {
      const h = headOf();
      const mine = piece();
      const a = h && h.look;
      if (!a || !mine || a.type !== 'video' || mine.type !== 'video' || !(a.dur > 0) || !(mine.dur > 0)) return null;
      const fps = mine.fps || a.fps || 24;
      const frames = Math.round(mine.dur * fps) - Math.round(a.dur * (a.fps || fps));
      if (!frames) return null;
      return { frames, text: `${WB.plural(Math.abs(frames), 'frame')} ${frames < 0 ? 'shorter' : 'longer'} than v${h.number}` };
    }
    // Ready to file: it says what it is, every word of it is read, and a new one says what it is.
    const ready = () => {
      const n = name();
      return !!n && !line().rest.length && !(extra && checks().some((c) => c.warn && c.rank === 0)) && (!!have(n) || !!tier.value || !!N.kindOf(n, entities()));
    };

    // The number it gets: the page's, or the one typed, or one past the highest of its entity and task,
    // counting what the rows above going there will get (as the server numbers them, in order).
    // (Kept until something changes, as a line is: each row asks those above.)
    let counted = null;
    // Another view (not the main one) goes with a version rather than making one: that of the nearest
    // row above going to the same that is not this view, else the newest there is if it lacks this view.
    // An extra goes with that of the nearest row above going to the same that is no extra, else the newest.
    function number() {
      if (numberOf) return numberOf();
      if (own.number) return own.number;
      const { list, at } = around();
      const key = [edits, list.length, at, entities().length, ent.value, taskIn.value, viewName(), extra];
      if (counted && same(counted.key, key)) return counted.n;
      const n = name();
      const t = taskName();
      const above = list.slice(0, Math.max(0, at)).filter((p) => p.name() === n && p.taskName() === t);
      const v = viewName();
      let joins = null;
      if (extra) {
        const row = [...above].reverse().find((p) => !p.extraName());
        const head = headOf();
        counted = { key, n: row ? row.number() : head ? head.number : null };
        return counted.n;
      }
      if (v) {
        const row = [...above].reverse().find((p) => p.viewName() !== v);
        const head = headOf();
        joins = row ? row.number() : head && !(head.look.viewNames || []).includes(v) ? head.number : null;
      }
      let top = nextOf(have(n), t) - 1;
      for (const p of above) if (!p.extraName()) top = Math.max(top, p.number());
      counted = { key, n: joins || top + 1 };
      return counted.n;
    }

    const note = (c) => el('span', { class: `file-note${c.warn ? ' warn' : ''}${c.ok ? ' ok' : ''}`, ...(c.title && { title: c.title }) },
      el('span', { text: c.text }),
      (c.fixes || []).map((f) => el('button', { type: 'button', class: 'file-fix', text: f.label, onpointerdown: (ev) => ev.preventDefault(), onclick: () => { f.run(); onChange(); } })));

    // What there is to say, all of it, the worst first, into `readout` (shown when the mark at the end of
    // the line is clicked), and the mark: none, a note, or a warning when something is to be sorted out.
    function paintReadout() {
      const n = name();
      const typed = ent.value.trim();
      let all = [];
      if (!n) {
        // What Enter would put in is in the box; why a short line says nothing is behind the mark.
        const top = topPick();
        ent.placeholder = top ? `${[top.entity, top.task].filter(Boolean).join(' ')} ↵` : 'Asset, set or shot';
        ent.title = top ? `Enter: ${[top.entity, top.task].filter(Boolean).join(' ')} (${top.why}). ${SHORT_HELP}` : SHORT_HELP;
        if (typed === '.') all = [{ text: 'Nothing above, or filed before, to repeat', warn: true }];
        else if (typed && (/^[+]$|^\d{1,4}$/.test(typed.split(/\s+/)[0]))) all = [{ text: 'No sequence above to go by: say it, as kilo+ or kilo-0020', warn: true }];
      } else {
        ent.placeholder = 'Asset, set or shot';
        ent.title = SHORT_HELP;
        all = checks().filter((c) => !c.ok && c.text);
      }
      const warns = all.filter((c) => c.warn).sort((a, b) => a.rank - b.rank);
      const shown = [...warns, ...all.filter((c) => !c.warn)];
      readout.replaceChildren(...shown.map(note));
      const said = shown.map((c) => c.text).join('. ');
      info.className = `file-info${warns.length ? ' warn' : shown.length ? ' note' : ''}`;
      info.innerHTML = shown.length ? WB.icon(warns.length ? 'warn' : shown.some((c) => c.extra) ? 'stack' : 'info', 15) : '';
      info.hidden = !shown.length;
      info.title = said;
      info.setAttribute('aria-label', said ? `${warns.length ? 'To sort out' : 'Notes'}: ${said}` : '');
      if (popped && popped.button === info) {
        if (shown.length) popped.paint();
        else shutPop();
      }
    }

    // The line's parts that are not typed in: what it is, and the version it follows.
    function paintLine() {
      const n = name();
      const e = n ? have(n) : null;
      const guess = n && !e && !tier.value ? N.kindOf(n, entities()) : null;
      const tid = e ? e.tier : tier.value || guess || null;
      const t = tid && N.TIER_LIST.find((x) => x.id === tid);
      const seq = tid === 'shot' ? N.seqOf(n) : null;
      const newSeq = !e && seq && checks().some((c) => c.newSeq);
      tier.hidden = !n || !!e;
      kind.innerHTML = !n ? '' : tid ? WB.icon(TIER_ICON[tid] || 'dot', 15) : '?';
      kind.className = `file-kind${!n || e ? '' : ' new'}${newSeq ? ' new-seq' : ''}${n && !tid ? ' ask' : ''}`;
      const why = guess === 'shot' ? ', by the shape of its name' : guess ? ', as the project\'s names like it are' : '';
      const a = t && /^[aeiou]/.test(t.one) ? 'an' : 'a';
      const said = !n ? '' : !tid ? `${n} is new: say what it is` : e ? `${n}: ${a} ${t.one} the project has`
        : `${n} is new: ${a} ${t.one}${seq ? `, in ${newSeq ? 'a new sequence, ' : ''}${seq}` : ''}${why}`;
      kind.title = said;
      tier.title = said ? `${said}. Click to say otherwise` : '';
      // The version it follows: its still (with a tick when the piece looks like it), which shows the two
      // side by side under the pointer or the keyboard.
      const head = n ? headOf() : null;
      if (!head) prevSlot.replaceChildren();
      else {
        const tn = taskName();
        const ok = checks().find((c) => c.ok);
        const still = el('button', {
          type: 'button', class: `file-prev${ok ? ' ok' : ''}`,
          'aria-label': `Compare with ${N.label(n, tn, head.number)}${ok ? `. ${ok.text}` : ''}`, onpointerdown: (ev) => ev.preventDefault(),
        }, head.thumb ? el('img', { src: head.thumb, alt: '' }) : null, el('span', { text: `v${head.number}` }));
        compareOn(still, () => ({ before: head.look, after: piece(), beforeLabel: N.label(n, tn, head.number), change: lengthChange(), alike: ok && ok.text }));
        prevSlot.replaceChildren(still);
      }
      // The version: typed, or the next, faint.
      if (!numberOf) {
        if (document.activeElement !== verIn) verIn.value = own.number ? String(own.number) : '';
        verIn.placeholder = n ? String(number()) : '';
      }
      verSeg.classList.toggle('auto', numberOf ? !!(numAuto && numAuto()) : !own.number);
      if (viewSel) viewSel.classList.toggle('auto', !viewSel.value);
    }

    const sync = () => {
      const n = name();
      paintLine();
      paintReadout();
    };
    for (const input of [ent, taskIn]) {
      input.addEventListener('input', () => {
        changed();
        if (input === ent) fromName = false;
        if (input === ent && own.said) Object.assign(own, { number: null, said: false });
        sync();
        onChange();
      });
    }
    // ---- typing through the line, as a date's parts are typed through

    // The parts typed in, in order, and the one after or before one.
    const parts = () => [ent, useTasks && taskIn, verIn, viewSel, extraIn].filter(Boolean);
    const step = (from, by) => parts()[parts().indexOf(from) + by] || null;
    const toEnd = (input) => {
      input.focus();
      if (input.tagName === 'INPUT' && input.type === 'text') input.setSelectionRange(input.value.length, input.value.length);
      else if (input.select) input.select();
    };
    // A space typed at the end of the name: a line that reads one way only goes into its parts (then on to
    // the first part it did not fill), and a name the project has, a shot, or a short way to say one moves
    // on to the task. Any other name may have more words to it ("set living room"), so it is left be.
    ent.addEventListener('input', (e) => {
      if (e.inputType !== 'insertText' || e.data !== ' ' || ent.selectionStart !== ent.value.length) return;
      const l = N.readLine(ent.value, lineContext());
      if (!l.entity || l.rest.length) return;
      const whole = !!have(l.entity) || !!l.short || N.tierOf(l.entity) === 'shot';
      const more = l.task !== undefined || l.number != null || !!l.view || !!l.extra;
      if (!more && !whole) return;
      combo.hide();
      if (more) settle();
      else {
        changed();
        fromName = false;
        ent.value = l.entity;
        sync();
        onChange();
      }
      const next = [useTasks && !(more && l.task !== undefined) && taskIn, l.number == null && verIn, viewSel].find(Boolean);
      if (next) toEnd(next);
    });
    // A task part with a version or a view in it puts it where it goes: on a space, or when left.
    function settleTask() {
      const w = taskIn.value.trim();
      const v = /^(?:v|#)?(\d{1,5})$/i.exec(w);
      const asView = views && views.includes(N.tokenize(w)) ? N.tokenize(w) : null;
      if (!v && !asView) return false;
      changed();
      taskIn.value = '';
      if (v) toLine({ number: Number(v[1]) || null });
      else setView(asView);
      sync();
      onChange();
      return true;
    }
    taskIn.addEventListener('input', (e) => {
      if (e.inputType !== 'insertText' || e.data !== ' ' || taskIn.selectionStart !== taskIn.value.length) return;
      const moved = settleTask();
      if (!moved) {
        taskIn.value = N.tokenize(taskIn.value);
        changed();
        sync();
        onChange();
      }
      const next = step(taskIn, 1);
      if (next) toEnd(next);
    });
    taskIn.addEventListener('blur', settleTask);
    taskIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') settleTask(); }, true);
    // The version: a number, typed over what the page put in; a space goes on to the view (or the extra).
    verIn.addEventListener('focus', () => { if (verSeg.classList.contains('auto') && verIn.select) verIn.select(); });
    verIn.addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        e.preventDefault();
        (viewSel || extraIn).focus();
      }
    });
    if (!numberOf) {
      verIn.addEventListener('input', () => {
        const typed = /^\s*v?(\d{1,5})\s*$/i.exec(verIn.value);
        changed();
        Object.assign(own, { number: typed ? Number(typed[1]) || null : null, said: false });
        sync();
        onChange();
      });
    }
    // Backspace in an empty part goes back to the one before, to its end.
    for (const input of parts().slice(1)) {
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Backspace' || (input.value && input.tagName === 'INPUT') || e.defaultPrevented) return;
        if (input.tagName === 'SELECT') return;
        const back = step(input, -1);
        if (!back) return;
        e.preventDefault();
        toEnd(back);
      });
    }

    if (viewSel) viewSel.addEventListener('change', () => { changed(); setExtra(null); sync(); onChange(); });
    // Typed as it is, read as a label: the box keeps what was typed until it is left.
    extraIn.addEventListener('input', () => {
      changed();
      extra = N.tokenize(extraIn.value) || null;
      if (extra && viewSel) viewSel.value = '';
      sync();
      onChange();
    });
    extraIn.addEventListener('blur', () => { extraIn.value = extra || ''; });
    sync();
    return Object.assign(self, {
      ent, task: taskIn, tier, readout, sync, line: line_, version: verIn, name, have, taskName, settle, setLine, checks, ready, number,
      typedNumber: () => (numberOf ? null : own.number), viewSel, viewName, setView, extraName, setExtra,
      // A number and view read for it from elsewhere (a learned rule), as if typed on its line; `named`
      // when what it is was read from its own file's name so.
      take: (l) => {
        changed();
        if (l.named) fromName = true;
        toLine({ number: l.number ?? null, view: l.view || null, extra: l.extra || null });
        sync();
      },
      // Its name was read from its own file's name, and has not been changed since.
      fromName: () => fromName,
      // What the server is told it is: one the project has, by id, or a new one, by name and tier.
      entity: () => {
        const n = name();
        const h = have(n);
        return h ? h.id : { name: n, tier: tier.value || N.kindOf(n, entities()) };
      },
      // The project does not have it yet: it is made when filed.
      isNew: () => !!name() && !have(name()),
      // The sequence it starts, when it is the first shot of one.
      newSeq: () => (checks().find((c) => c.newSeq) || {}).newSeq || null,
      // What the server found it looks like (see likely.js): put first among the suggestions.
      setLikely: (list) => {
        likely = list || [];
        likelyAt++;
        sync();
        // Suggestions open already, before this came: shown again with it first.
        if (likely.length && document.activeElement === ent && !ent.value.trim() && !combo.list.hidden) combo.show();
      },
    });
  }

  // Shift+Enter: the rows below `from` are filled in on from it. Shots go on in their sequence's step
  // (kilo-0010, kilo-0020...), skipping any the project has; anything else is the same for them all. A
  // row whose own file's name said what it is keeps it. Gives what to say about it, and how to undo it.
  function series(from, list, entities) {
    const at = list.indexOf(from);
    const n = from.name();
    if (at < 0 || !n) return null;
    const task = from.taskName();
    const names = entities.map((e) => e.name);
    const shot = N.tierOf(n) === 'shot' ? N.seqOf(n) : null;
    const step = shot ? N.sequence(names, shot).step : 0;
    let num = shot ? N.shotNumber(n) : 0;
    const before = [];
    let kept = 0;
    for (const p of list.slice(at + 1)) {
      if (p.fromName()) {
        kept++;
        continue;
      }
      before.push({ p, ent: p.ent.value, task: p.task.value });
      if (shot) {
        const most = 10 ** N.DIGITS - 1;
        do num += step; while (names.includes(N.shotName(shot, num)) && num < most);
        p.setLine(N.shotName(shot, num), task || '');
      } else p.setLine(n, task || '');
    }
    if (!before.length && !kept) return null;
    const first = before.length ? before[0].p.name() : '';
    const last = before.length ? before[before.length - 1].p.name() : '';
    const text = [
      before.length ? `Filled in ${WB.plural(before.length, 'row')}${shot ? `: ${first}${before.length > 1 ? ` to ${last}` : ''}` : ` as ${n}`}` : '',
      kept ? `${before.length ? 'kept' : 'Kept'} ${kept === 1 ? 'the row' : `${kept} rows`} named by ${kept === 1 ? 'its file' : 'their files'}` : '',
    ].filter(Boolean).join('; ');
    return {
      text,
      undo: before.length ? () => {
        changed();
        for (const b of before) {
          b.p.ent.value = b.ent;
          b.p.task.value = b.task;
          b.p.sync();
        }
      } : null,
    };
  }

  // "For all": one answer to start every row from. `apply(entity, task)` fills the rows (either may be '').
  // A line that says a shot short (+, 20) is read by each row in turn, so + numbers them one after another.
  function forAll({ getEntities, getTasks, apply, cls = 'file-fill', useTasks = true }) {
    const ent = el('input', { type: 'text', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': 'Asset, set or shot for all', title: 'A name for every row. + gives each row the next shot in turn' });
    const task = el('input', { type: 'text', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task for all', hidden: !useTasks });
    WB.combo(ent, (typed) => suggest({ entities: getEntities(), useTasks, line: { entities: getEntities() || [], names: (getEntities() || []).map((e) => e.name), tasks: getTasks() || [], useTasks } }, typed));
    WB.combo(task, (typed) => WB.rank(getTasks() || [], typed).map((t) => ({ value: t, label: t })));
    const go = () => apply(ent.value.trim(), useTasks ? task.value.trim() : '');
    return el('div', { class: cls }, el('span', { text: 'For all' }), ent, task,
      el('button', { type: 'button', class: 'btn small', text: 'Fill in', onclick: go }));
  }

  // The new sequences some rows start, asked about once before they are filed: a typo there makes a whole
  // sequence in the catalogue. Resolves true to go on.
  async function confirmSequences(list, asked = new Set()) {
    const seqs = [...new Set(list.map((f) => f.newSeq()).filter((s) => s && !asked.has(s)))];
    if (!seqs.length) return true;
    const ok = await WB.dialog({
      title: seqs.length === 1 ? `Start a new sequence, ${seqs[0]}?` : `Start ${seqs.length} new sequences?`,
      text: seqs.length === 1 ? `There are no shots in ${seqs[0]} yet. It shows in the catalogue beside the others.` : `There are no shots yet in ${seqs.join(', ')}.`,
      ok: seqs.length === 1 ? 'Start it' : 'Start them',
    });
    if (ok) for (const s of seqs) asked.add(s);
    return ok;
  }

  // What the server finds pieces look like a new version of, by their length and picture, for each by
  // its key: { key: [{ entity, task, number, score, why }] }. Only videos with a colour strip are asked about.
  async function findLikely(projectId, pieces) {
    const looks = pieces.filter((p) => p.look && p.look.type === 'video').map((p) => ({
      key: p.key, type: 'video', dur: p.look.dur, fps: p.look.fps, nw: p.look.nw, nh: p.look.nh, wf: p.look.wf && p.look.wf.c,
    }));
    if (!looks.length) return {};
    try {
      return (await WB.api('POST', `/api/projects/${projectId}/likely`, { looks })).answers || {};
    } catch {
      return {};
    }
  }

  // ---- what a project learns about file names from elsewhere (see ruleFrom in naming.js)

  // After a piece named some other way is filed: the rule it teaches, if it teaches one the project does
  // not have, offered to be kept, and to fill in the rows still to go that it reads. `filed` is what it
  // was filed as ({ entity, task, number, view, views }: see ruleFrom in naming.js). `others` are those
  // rows, each { filename, fields }; `save(rule)` keeps the rule beside those the project has by then.
  // A pattern is offered once while the page is open, however many files like it are filed (several at
  // once, say), and whatever was answered: Not now is not asked again until the page is opened anew.
  const offered = new Set();
  function offerRule({ filename, filed, rules, others = [], tasks = [], save }) {
    const rule = N.ruleFrom(filename, filed);
    if (!rule || (rules || []).some((r) => N.ruleKey(r) === N.ruleKey(rule)) || offered.has(N.ruleKey(rule))) return;
    offered.add(N.ruleKey(rule));
    const reads = others.filter((o) => !o.fields.name() && N.byRules(o.filename, [rule], tasks));
    const said = (r) => N.label(r.entity, r.task, r.number || '').replace(/ v$/, '') + (r.view ? ` ${r.view}` : '');
    const stem = (f) => String(f).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    // Asked in the middle of the page, not in a corner: what is learned here reads every name like it.
    const fill = async () => {
      await save(rule);
      for (const o of reads) {
        const r = N.byRules(o.filename, [rule], tasks);
        o.fields.setLine(r.entity, r.task || undefined);
        o.fields.take({ number: r.number, view: r.view, named: true });
      }
    };
    const shown = reads.slice(0, 6);
    const dlg = el('dialog', { class: 'dlg rule-dlg' },
      el('form', { method: 'dialog' },
        el('h2', { text: 'Remember this pattern?' }),
        el('div', { class: 'rule-pair' }, el('code', { text: stem(filename) }), el('span', { class: 'rule-arrow', html: WB.icon('arrow', 14) }), el('b', { text: said(filed) })),
        shown.length ? el('div', { class: 'rule-more' },
          el('span', { text: `${reads.length === 1 ? 'One more' : `${reads.length} more`} waiting would be filed as` }),
          el('ul', {}, shown.map((o) => el('li', {}, el('code', { text: stem(o.filename) }), el('b', { text: said(N.byRules(o.filename, [rule], tasks)) }))),
            reads.length > shown.length ? el('li', { class: 'rule-rest', text: `and ${reads.length - shown.length} more` }) : null)) : null,
        el('div', { class: 'dlg-actions' },
          el('button', { type: 'button', class: 'btn', text: 'Not now', onclick: () => dlg.close() }),
          reads.length ? el('button', { type: 'button', class: 'btn', text: 'Remember', onclick: async () => { dlg.close(); await save(rule); } }) : null,
          el('button', {
            type: 'submit', class: 'btn primary', text: reads.length ? `Remember and fill in ${reads.length}` : 'Remember',
            onclick: async (e) => { e.preventDefault(); dlg.close(); await fill(); },
          }))));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    dlg.showModal();
  }

  // Suggestions for a name or a task typed anywhere else (a version's Edit), the same as a row's.
  const entitySource = (getEntities) => (typed) => {
    const list = getEntities() || [];
    return suggest({ entities: list, line: { entities: list, names: list.map((e) => e.name) } }, typed);
  };
  const taskSource = (getTasks) => (typed) => WB.rank(getTasks() || [], typed).map((t) => ({ value: t, label: t }));

  // Whether the file a video's review copy was made from may be kept on the server too.
  const originalFits = (file) => {
    const max = WB.info().maxUpload;
    return !max || file.size <= max;
  };

  return { UNFILE_WITHIN, lineHead, suggest, entitySource, taskSource, fields, changed, series, keysButton, forAll, confirmSequences, findLikely, offerRule, originalFits, streamsOf, nextOf };
})();
