'use strict';

// Filing pieces as versions, the same wherever it is done: a board's "File as a version" (Shift+V) and
// the catalogue's import strip ask the same questions, with the same fields. Each piece has a row:
// which asset, set or shot it is, and the task (when the project counts its versions by task). Several
// pieces can be given one answer to start from ("For all").
//
// The first field takes a whole line, read by WBNaming.readLine: "kilo-0010 anim v12 bty", a file name
// pasted in, or a short way to say a shot (20, +, .). Under each row a line says what it will be: where
// it goes, the version it follows (with its still, beside the piece's own) and the number it gets, and
// anything that looks wrong (a near miss of a name the project has, a name not to the styleguide, a new
// sequence, a second count for one shot), the worst of it first, each with the fix a click away; and
// before anything is typed, what Enter would put in. Suggestions come before anything is typed: what
// the piece looks like a new version of (by its picture, asked of the server), the row above, the next
// shot. Ctrl+D copies the row above; Shift+Enter numbers the rows below on from this one.
// Loaded after naming.js, before the pages that file.
const WBFiling = (() => {
  const { el } = WB;
  const N = WBNaming;
  const SHORT_HELP = 'Type a name, or a whole line: kilo-0010 anim v12. 20 is shot 0020 of the sequence above, + its next shot, . the same as the last. Ctrl+D copies the row above; Shift+Enter numbers the rows below on from this one';
  // A likeness that is more than the same length: two shots of a sequence are often as long as each
  // other, so that alone only ever hints.
  const looksAlike = (l) => l.why.includes('looks alike');

  // The newest version of each task of an entity, newest first: [{ task, number, thumb, at }].
  const streamsOf = (e) => Object.entries((e && e.heads) || {}).map(([task, h]) => ({ task: task || null, ...h })).sort((a, b) => b.at - a.at);
  // The number the next version of an entity and task gets, `before` more being filed ahead of it.
  const nextOf = (e, task, before = 0) => ((e && e.tops ? e.tops[task || ''] || 0 : 0) + 1 + before);
  const tierLabel = (presetId, tier) => (N.preset(presetId).tiers.find((t) => t.id === tier) || { label: '' }).label;
  // Counts what is typed or put into any row: a row's line is read again only after a change (see line
  // in fields). A page that writes into a row's boxes itself says so with changed().
  let edits = 0;
  const changed = () => { edits++; };
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
  const newOption = (name, presetId, hint) => ({ value: name, task: undefined, label: `New: ${name}`, hint: hint || N.tierOf(name, presetId) || 'say what it is', make: true });

  // Suggestions for "which asset, set or shot", as a line is typed, best first. `ctx` is what the row
  // knows besides: { entities, tasks, presetId, useTasks, line context (see readLine), likely, above }.
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
          : { ...newOption(last.entity, ctx.presetId, ctx.above ? 'same as above' : 'same as last'), task: useTasks ? last.task || null : null });
      }
      if (out.length) out[0].first = true;
      const seq = ctx.line && ctx.line.seq;
      if (seq) {
        const next = N.nextShot([...names, ...((ctx.line && ctx.line.taken) || [])], seq);
        push({ ...newOption(next, ctx.presetId, `next shot in ${seq}`), task: useTasks && last ? last.task || null : undefined });
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
      else push({ ...newOption(name, ctx.presetId, line.short), task: line.task });
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
    if (seqTyped && names.some((n) => N.seqOf(n) === seqTyped[1])) push(newOption(N.nextShot(names, seqTyped[1]), ctx.presetId, `next shot in ${seqTyped[1]}`));
    if (name && !byName.has(name)) {
      for (const miss of N.nearMisses(name, names)) push(streamOption(byName.get(miss), null, 'did you mean?', useTasks));
      for (const c of N.corrections(name, ctx.presetId, names)) push(byName.has(c.name) ? streamOption(byName.get(c.name), null, 'to the styleguide', useTasks) : newOption(c.name, ctx.presetId, `new ${c.tier}`));
      push(newOption(name, ctx.presetId));
    }
    // A pick keeps what else the line said: a suggestion names only the entity (and perhaps its task).
    for (const o of out) {
      if (o.task === undefined && line.task !== undefined) o.task = line.task;
      o.number = line.number;
      o.view = line.view;
    }
    return out;
  }

  // One piece's fields. `getEntities()`, `getTasks()` and `getViews()` are the project's as last known;
  // `onChange` hears every edit. The tier is asked only for a new name whose shape does not say it, and
  // the task only when the project counts by task (`useTasks`). `peers()` are the fields of the rows
  // still to be filed, in order, this one among them: what is above says what a short line means, and
  // the keys that fill rows in work on those below. `remembered` is what was filed last ({ entity, task }).
  // `numberOf()`, when the page has a number field, is its number, and `onLine(line)` hears a line's
  // number and view to put in its fields; a page without them (a board) keeps what a line says here, in
  // `typedNumber()` and `typedView()`, starting from `number` and `view`. `named` says the entity given
  // was read from the piece's own file name. `rules` let the project's learned rules read pasted names;
  // `say(text, undo)` tells the person something the keys did (a toast unless the page says otherwise).
  function fields({
    entity = '', task = '', presetId, getEntities, getTasks, getViews = () => [], label = 'it', onChange = () => {},
    useTasks = true, peers = () => [], remembered = null, numberOf = null, onLine = null, rules = () => [],
    number: typedNumber = null, view: typedView = null, named = false, say = null,
  }) {
    const readout = el('div', { class: 'file-says', id: `fs-${WB.uid()}` });
    const ent = el('input', { type: 'text', value: entity, placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': `What ${label} is`, 'aria-describedby': readout.id, title: SHORT_HELP });
    const taskIn = el('input', { type: 'text', value: task, placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task', hidden: !useTasks });
    // A new name whose shape does not say what it is has to be told: nothing is assumed.
    const tier = el('select', { 'aria-label': 'What it is', title: 'A new one: what is it?' },
      el('option', { value: '', text: 'what is it?' }), N.preset(presetId).tiers.map((t) => el('option', { value: t.id, text: t.one })));
    let likely = [];
    let fromName = named && !!entity;
    let expanded = false;
    // What a line said of the number and view, on a page with no fields for them. Said by a line, they
    // go when the name is changed (they were said of that one); given by the page, they stay.
    const own = { number: typedNumber, view: typedView, said: false };
    const toLine = onLine || ((l) => {
      if (l.number != null) own.number = l.number;
      if (l.view) own.view = l.view;
      own.said = true;
    });
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
        presetId, names: entities().map((e) => e.name), tasks: getTasks() || [], views: getViews() || [], useTasks, rules: rules(), above: !!prev,
        get last() { return last(); },
        get taken() { return above.map((p) => p.name()).filter(Boolean); },
        get seq() {
          for (let i = above.length - 1; i >= 0; i--) if (N.tierOf(above[i].name(), presetId) === 'shot') return N.seqOf(above[i].name());
          const l = last();
          return l && N.tierOf(l.entity, presetId) === 'shot' ? N.seqOf(l.entity) : null;
        },
      };
    }
    // A line is read again only once something has changed, in it, in the rows around it or in the
    // project: a short line is read by the rows above it, so reading every row afresh on each repaint
    // would go up as the cube of how many there are.
    let read = null;
    const line = () => {
      const { list, at } = around();
      const key = `${edits}|${list.length}|${at}|${entities().length}|${ent.value}`;
      if (!read || read.key !== key) read = { key, line: N.readLine(ent.value, lineContext()) };
      return read.line;
    };
    const name = () => line().entity || '';
    const taskName = () => {
      if (!useTasks) return null;
      const l = line();
      return l.task !== undefined ? l.task || null : N.tokenize(taskIn.value) || null;
    };

    // The line, said in the fields: the name in the first, the task in its own, and a number and view
    // to the page (or kept here). A line with words it could not read stays as it is, said under the
    // row, rather than lose them.
    function settle() {
      const l = line();
      if (!l.entity || l.rest.length || (ent.value === l.entity && l.task === undefined && l.number == null && !l.view)) return;
      changed();
      ent.value = l.entity;
      if (useTasks && l.task !== undefined) taskIn.value = l.task || '';
      if (l.number != null || l.view) toLine(l);
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
      entities: entities(), presetId, useTasks, likely, line: lineContext(), above: lineContext().above,
    }, typed), {
      quiet: true,
      onPick: (o) => {
        changed();
        fromName = false;
        if (useTasks && o.task !== undefined) taskIn.value = o.task || '';
        if (o.number != null || o.view) toLine({ number: o.number, view: o.view });
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
        const done = series(self, peers(), entities(), presetId);
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
    // matters: `warn` (with its `rank`, the worst lowest), `ok`, or neither (only telling).
    function checks() {
      const n = name();
      if (!n) return [];
      const out = [];
      const list = entities();
      const names = list.map((x) => x.name);
      const l = line();
      const e = have(n);
      const typed = ent.value.trim();
      if (l.short) out.push({ text: `${typed} is ${l.short}: ${n}` });
      else if (typed !== n && l.task === undefined && l.number == null && !l.view && !l.rest.length) out.push({ text: `Called ${n}` });
      if (l.rest.length) out.push({ text: `Not read: ${l.rest.join(' ')}. Take it out${useTasks ? ' or put it in the task' : ''} to file`, warn: true, rank: 0 });
      const e0 = have(n);
      if (!numberOf && own.number && !(e0 && own.number <= ((e0.tops || {})[taskName() || ''] || 0))) out.push({ text: `v${own.number} as typed`, fixes: [{ label: 'The next instead', run: () => { changed(); own.number = null; sync(); } }] });
      if (!numberOf && own.view) out.push({ text: `View: ${own.view}`, fixes: [{ label: 'No view', run: () => { changed(); own.view = null; sync(); } }] });
      if (!e) {
        const misses = N.nearMisses(n, names);
        if (misses.length) out.push({ text: 'Not in the project. Did you mean', fixes: misses.map((m) => ({ label: m, run: () => setLine(m) })), warn: true, rank: 1 });
        const tierNow = N.tierOf(n, presetId);
        if (!tierNow) {
          const fixes = N.corrections(n, presetId, names).filter((c) => !misses.includes(c.name)).slice(0, 4);
          if (fixes.length || !misses.length) out.push({ text: fixes.length ? 'Not to the styleguide. Perhaps' : 'Not to the styleguide: say what it is', fixes: fixes.map((c) => ({ label: c.name, run: () => setLine(c.name) })), warn: true, rank: 2 });
        }
        if (tierNow === 'shot') {
          const seq = N.seqOf(n);
          const seqs = [...new Set(names.filter((x) => N.tierOf(x, presetId) === 'shot').map(N.seqOf))];
          const above = lineContext().taken.some((x) => N.seqOf(x) === seq && N.tierOf(x, presetId) === 'shot');
          if (!seqs.includes(seq) && !above) {
            // Only worth a warning when it is a letter or two from one there is; otherwise it is said, and asked about when filed.
            const like = N.nearMisses(seq, seqs);
            out.push({ text: like.length ? `A new sequence, ${seq}. Did you mean` : `Starts a new sequence: ${seq}`, fixes: like.map((q) => ({ label: q, run: () => setLine(`${q}-${N.pad(N.shotNumber(n))}`) })), warn: like.length > 0, rank: 1, newSeq: seq });
          } else {
            const sq = N.sequence(names, seq);
            const num = N.shotNumber(n);
            if (sq.last && num > sq.last + 10 * sq.step) out.push({ text: `Far past the last shot of ${seq} (${N.pad(sq.last)})`, warn: true, rank: 5 });
          }
        }
      }
      // A number typed that the count has passed already: most likely someone's, or was (numbers are never
      // given twice), unless it was skipped. The server says for sure when it is filed.
      const top = e ? (e.tops || {})[taskName() || ''] || 0 : 0;
      if (e && !numberOf && own.number && own.number <= top) {
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
      // What the piece itself looks like it is, by its picture: said when it agrees, and when it seems
      // to be something else. Being as long as a shot is not enough to say either.
      const best = likely.find(looksAlike);
      if (best) {
        const same = best.entity === n && (!useTasks || (best.task || null) === taskName());
        if (same) out.push({ text: `Like its v${best.number}: ${best.why.join(', ')}`, ok: true });
        else if (best.score >= 0.75) out.push({ text: 'It looks like', fixes: [{ label: N.label(best.entity, useTasks ? best.task : null, best.number), run: () => setLine(best.entity, useTasks ? best.task || '' : undefined) }], warn: true, rank: 3 });
      }
      return out;
    }
    // Ready to file: it says what it is, every word of it is read, and a new one says what it is.
    const ready = () => {
      const n = name();
      return !!n && !line().rest.length && (!!have(n) || !!N.tierOf(n, presetId) || !!tier.value);
    };

    // The number it gets: the page's, or the one typed, or one past the highest of its entity and task,
    // counting what the rows above going there will get (as the server numbers them, in order).
    // (Kept until something changes, as a line is: each row asks those above.)
    let counted = null;
    function number() {
      if (numberOf) return numberOf();
      if (own.number) return own.number;
      const { list, at } = around();
      const key = `${edits}|${list.length}|${at}|${entities().length}|${ent.value}|${taskIn.value}`;
      if (counted && counted.key === key) return counted.n;
      const n = name();
      const t = taskName();
      let top = nextOf(have(n), t) - 1;
      for (const p of list.slice(0, Math.max(0, at))) if (p.name() === n && p.taskName() === t) top = Math.max(top, p.number());
      counted = { key, n: top + 1 };
      return counted.n;
    }

    const note = (c) => el('span', { class: `file-note${c.warn ? ' warn' : ''}${c.ok ? ' ok' : ''}` },
      el('span', { text: c.text }),
      (c.fixes || []).map((f) => el('button', { type: 'button', class: 'file-fix', text: f.label, onpointerdown: (ev) => ev.preventDefault(), onclick: () => { f.run(); onChange(); } })));

    function paintReadout() {
      const n = name();
      const typed = ent.value.trim();
      readout.classList.toggle('empty', !n);
      if (!n) {
        // Nothing to say yet: what Enter would put in; or why a short line says nothing.
        if (typed === '.') return readout.replaceChildren(note({ text: 'Nothing above, or filed before, to repeat', warn: true }));
        if (typed && (/^[+]$|^\d{1,4}$/.test(typed.split(/\s+/)[0]))) return readout.replaceChildren(note({ text: 'No sequence above to go by: say it, as kilo+ or kilo-0020', warn: true }));
        const top = topPick();
        ent.placeholder = 'Asset, set or shot';
        if (top) ent.placeholder = `${[top.entity, top.task].filter(Boolean).join(' ')} ↵`;
        // (How to type a line is said once, under the rows: on every row it would only be noise.)
        return readout.replaceChildren(top ? el('span', { class: 'file-help', text: `Enter: ${[top.entity, top.task].filter(Boolean).join(' ')} (${top.why})` }) : '');
      }
      ent.placeholder = 'Asset, set or shot';
      const e = have(n);
      const t = taskName();
      const tierId = e ? e.tier : N.tierOf(n, presetId) || tier.value || null;
      const seq = tierId === 'shot' ? N.seqOf(n) : null;
      const head = e && e.heads ? e.heads[t || ''] : null;
      const num = number();
      const path = [tierId && tierLabel(presetId, tierId), seq, n, t].filter(Boolean);
      const parts = [];
      parts.push(el('span', { class: 'file-path' }, path.flatMap((p, i) => [i ? el('i', { text: '›' }) : null, el('span', { class: i === path.length - 1 || p === n ? 'b' : '', text: p })])));
      // Where the page shows the number in a field of its own, this only says what it follows.
      if (head) {
        parts.push(el('span', { class: 'file-prev', title: `Follows ${N.label(n, t, head.number)}` },
          head.thumb ? el('img', { src: head.thumb, alt: '' }) : null, el('span', { text: numberOf ? `after v${head.number}` : `v${head.number}` }), numberOf ? null : el('i', { text: '→' })));
      }
      if (!numberOf) parts.push(el('b', { class: `file-num${e ? '' : ' new'}`, text: `v${num}${own.view ? ` ${own.view}` : ''}` }));
      if (!e) parts.push(el('span', { class: `file-new${tierId ? '' : ' ask'}`, text: tierId ? `new ${tierId}` : 'new: say what it is' }));
      // The worst warning and what only tells; the other warnings a click away.
      const all = checks();
      const warns = all.filter((c) => c.warn).sort((a, b) => a.rank - b.rank);
      const shown = [...all.filter((c) => !c.warn), ...(expanded ? warns : warns.slice(0, 1))];
      const more = !expanded && warns.length > 1 && el('button', {
        type: 'button', class: 'file-more', text: `+${warns.length - 1} more`, onpointerdown: (ev) => ev.preventDefault(),
        onclick: () => { expanded = true; paintReadout(); },
      });
      readout.replaceChildren(el('div', { class: 'file-what' }, parts), ...shown.map(note), more || '');
    }

    const sync = () => {
      const n = name();
      tier.hidden = !n || !!have(n) || !!N.tierOf(n, presetId);
      paintReadout();
    };
    for (const input of [ent, taskIn]) {
      input.addEventListener('input', () => {
        changed();
        if (input === ent) fromName = false;
        if (input === ent && own.said) Object.assign(own, { number: null, view: null, said: false });
        expanded = false;
        sync();
        onChange();
      });
    }
    tier.addEventListener('change', () => { sync(); onChange(); });
    sync();
    return Object.assign(self, {
      ent, task: taskIn, tier, readout, sync, name, have, taskName, settle, setLine, checks, ready, number,
      typedNumber: () => (numberOf ? null : own.number), typedView: () => (numberOf ? null : own.view),
      // Its name was read from its own file's name, and has not been changed since.
      fromName: () => fromName,
      // What the server is told it is: one the project has, by id, or a new one, by name and tier.
      entity: () => {
        const n = name();
        const h = have(n);
        return h ? h.id : { name: n, tier: N.tierOf(n, presetId) || tier.value };
      },
      // The project does not have it yet: it is made when filed.
      isNew: () => !!name() && !have(name()),
      // The sequence it starts, when it is the first shot of one.
      newSeq: () => (checks().find((c) => c.newSeq) || {}).newSeq || null,
      // What the server found it looks like (see likely.js): put first among the suggestions.
      setLikely: (list) => {
        likely = list || [];
        sync();
        // Suggestions open already, before this came: shown again with it first.
        if (likely.length && document.activeElement === ent && !ent.value.trim() && !combo.list.hidden) combo.show();
      },
    });
  }

  // Shift+Enter: the rows below `from` are filled in on from it. Shots go on in their sequence's step
  // (kilo-0010, kilo-0020...), skipping any the project has; anything else is the same for them all. A
  // row whose own file's name said what it is keeps it. Gives what to say about it, and how to undo it.
  function series(from, list, entities, presetId) {
    const at = list.indexOf(from);
    const n = from.name();
    if (at < 0 || !n) return null;
    const task = from.taskName();
    const names = entities.map((e) => e.name);
    const shot = N.tierOf(n, presetId) === 'shot' ? N.seqOf(n) : null;
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
        do num += step; while (names.includes(`${shot}-${N.pad(num)}`) && num < 9999);
        p.setLine(`${shot}-${N.pad(num)}`, task || '');
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
  function forAll({ presetId, getEntities, getTasks, apply, cls = 'file-fill', useTasks = true }) {
    const ent = el('input', { type: 'text', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': 'Asset, set or shot for all', title: 'A name for every row. + gives each row the next shot in turn' });
    const task = el('input', { type: 'text', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task for all', hidden: !useTasks });
    WB.combo(ent, (typed) => suggest({ entities: getEntities(), presetId, useTasks, line: { presetId, names: (getEntities() || []).map((e) => e.name), tasks: getTasks() || [], useTasks } }, typed));
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
  // not have, offered to be kept, and to fill in the rows still to go that it reads. `others` are those
  // rows, each { filename, fields }; `save(rules)` keeps the project's rules.
  function offerRule({ filename, entity, presetId, rules, others = [], tasks = [], save }) {
    const rule = N.ruleFrom(filename, entity, presetId);
    if (!rule || (rules || []).some((r) => r.word === rule.word)) return;
    const reads = others.filter((o) => !o.fields.name() && N.byRules(o.filename, [rule], tasks));
    WB.toast(`${filename} was filed as ${entity}. Read “${rule.word}” names that way from now on?`, {
      key: 'rule', ms: 12000,
      action: {
        label: reads.length ? `Yes, and fill in ${WB.plural(reads.length, 'other')}` : 'Remember',
        run: async () => {
          await save([...(rules || []), rule]);
          for (const o of reads) {
            const r = N.byRules(o.filename, [rule], tasks);
            o.fields.setLine(r.entity, r.task || undefined);
          }
        },
      },
    });
  }

  // The keys that work where pieces are filed, said once under the rows.
  const keysHint = () => el('p', { class: 'file-keys', text: 'Type a whole line: kilo-0010 anim v12 · 20, + and . say a shot short · Enter takes what is suggested · Ctrl+D copies the row above · Shift+Enter fills in the rows below' });

  // Suggestions for a name or a task typed anywhere else (a version's Edit), the same as a row's.
  const entitySource = (getEntities, presetId) => (typed) => {
    const list = getEntities() || [];
    return suggest({ entities: list, presetId, line: { presetId, names: list.map((e) => e.name) } }, typed);
  };
  const taskSource = (getTasks) => (typed) => WB.rank(getTasks() || [], typed).map((t) => ({ value: t, label: t }));

  // Whether the file a video's review copy was made from may be kept on the server too.
  const originalFits = (file) => {
    const max = WB.info().maxUpload;
    return !max || file.size <= max;
  };

  return { UNFILE_WITHIN, suggest, entitySource, taskSource, fields, changed, series, keysHint, forAll, confirmSequences, findLikely, offerRule, originalFits, streamsOf, nextOf };
})();
