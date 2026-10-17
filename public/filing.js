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
// sequence, a second count for one shot), each with the fix a click away. Suggestions come before
// anything is typed: what the piece looks like a new version of (by its length and picture, asked of
// the server), the row above, the next shot. Ctrl+D copies the row above; Shift+Enter numbers the rows
// below on from this one.
// Loaded after naming.js, before the pages that file.
const WBFiling = (() => {
  const { el } = WB;
  const N = WBNaming;
  const SHORT_HELP = 'Type a name, or a whole line: kilo-0010 anim v12. 20 is shot 0020 of the sequence above, + its next shot, . the same as the last. Ctrl+D copies the row above; Shift+Enter numbers the rows below on from this one';

  // The newest version of each task of an entity, newest first: [{ task, number, thumb, at }].
  const streamsOf = (e) => Object.entries((e && e.heads) || {}).map(([task, h]) => ({ task: task || null, ...h })).sort((a, b) => b.at - a.at);
  // The number the next version of an entity and task gets, `before` more being filed ahead of it.
  const nextOf = (e, task, before = 0) => ((e && e.tops ? e.tops[task || ''] || 0 : 0) + 1 + before);
  const tierLabel = (presetId, tier) => (N.preset(presetId).tiers.find((t) => t.id === tier) || { label: '' }).label;
  // Counts what is typed or put into any row: a row's line is read again only after a change (see line
  // in fields). A page that writes into a row's boxes itself says so with changed().
  let edits = 0;
  const changed = () => { edits++; };

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
    if (!text) {
      // Before anything is typed: what the piece looks like a version of, then the row above (or what
      // was filed last), the next shot after it, and what had versions lately.
      for (const l of likely) if (byName.has(l.entity)) push(streamOption(byName.get(l.entity), streamsOf(byName.get(l.entity)).find((s) => s.task === l.task), `like its v${l.number}: ${l.why.join(', ')}`, useTasks));
      const last = ctx.line && ctx.line.last;
      if (last && last.entity) {
        const e = byName.get(last.entity);
        const s = e && streamsOf(e).find((x) => x.task === (last.task || null));
        push(e ? { ...streamOption(e, s, ctx.above ? 'same as above' : 'same as last', useTasks), task: useTasks ? last.task || null : null }
          : { ...newOption(last.entity, ctx.presetId, ctx.above ? 'same as above' : 'same as last'), task: useTasks ? last.task || null : null });
      }
      const seq = ctx.line && ctx.line.seq;
      if (seq) {
        const next = N.nextShot([...names, ...((ctx.line && ctx.line.taken) || [])], seq);
        push({ ...newOption(next, ctx.presetId, `next shot in ${seq}`), task: useTasks && last ? last.task || null : undefined });
      }
      // What it looks like, or the row above, is taken by Enter straight away.
      if (out.length) out[0].first = true;
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
    const like = new Set(likely.map((l) => l.entity));
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
  // `numberOf()`, when the page has a number field, is its number; `onLine(line)` hears a line's number
  // and view when one is typed. `filename` and `rules` let the project's learned rules read the piece's name.
  function fields({
    entity = '', task = '', presetId, getEntities, getTasks, getViews = () => [], label = 'it', onChange = () => {},
    useTasks = true, peers = () => [], remembered = null, numberOf = null, onLine = () => {}, rules = () => [],
  }) {
    const ent = el('input', { type: 'text', value: entity, placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': `What ${label} is`, title: SHORT_HELP });
    const taskIn = el('input', { type: 'text', value: task, placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task', hidden: !useTasks });
    const tier = el('select', { 'aria-label': 'What it is', title: 'A new one: what is it?' }, N.preset(presetId).tiers.map((t) => el('option', { value: t.id, text: t.one })));
    const readout = el('div', { class: 'file-says', hidden: true });
    let likely = [];
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
    // to the page (when it has such fields). A line with words it could not read stays as it is, said
    // under the row, rather than lose them.
    function settle() {
      const l = line();
      if (!l.entity || l.rest.length || (ent.value === l.entity && l.task === undefined && l.number == null && !l.view)) return;
      changed();
      ent.value = l.entity;
      if (useTasks && l.task !== undefined) taskIn.value = l.task || '';
      if (l.number != null || l.view) onLine(l);
      sync();
      onChange();
    }
    // Put in by a key, a suggestion or the page: a name and (when given) a task.
    function setLine(n, t) {
      changed();
      ent.value = n || '';
      if (useTasks && t !== undefined) taskIn.value = t || '';
      sync();
    }

    const combo = WB.combo(ent, (typed) => suggest({
      entities: entities(), presetId, useTasks, likely, line: lineContext(), above: lineContext().above,
    }, typed), {
      onPick: (o) => {
        changed();
        if (useTasks && o.task !== undefined) taskIn.value = o.task || '';
        if (o.number != null || o.view) onLine({ number: o.number, view: o.view });
        settle();
        sync();
        onChange();
      },
    });
    WB.combo(taskIn, (typed) => {
      // The tasks of the one named first, with how far each has counted, then the project's.
      const e = have(name());
      const own = streamsOf(e).filter((s) => s.task).map((s) => ({ value: s.task, label: s.task, hint: `v${s.number} → v${s.number + 1}` }));
      const rest = WB.rank(getTasks() || [], typed).filter((t) => !own.some((o) => o.value === t)).map((t) => ({ value: t, label: t }));
      return [...WB.rank(own, typed, (o) => o.value), ...rest].slice(0, 9);
    });

    // The keys that fill rows in (registered before the suggestions', so Shift+Enter is never taken as a pick).
    ent.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        const list = peers();
        const prev = list[list.indexOf(self) - 1];
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
        series(self, peers(), entities(), presetId);
        onChange();
      }
    }, true);
    taskIn.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D'))) return;
      const list = peers();
      const prev = list[list.indexOf(self) - 1];
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

    // The things that look wrong about the row, each { text, fixes: [{ label, run }], warn }.
    function checks() {
      const n = name();
      if (!n) return [];
      const out = [];
      const list = entities();
      const names = list.map((e) => e.name);
      const l = line();
      const e = have(n);
      const typed = ent.value.trim();
      if (l.short) out.push({ text: `${typed} is ${l.short}: ${n}` });
      else if (typed !== n && l.task === undefined && l.number == null && !l.view && !l.rest.length) out.push({ text: `Called ${n}` });
      if (l.rest.length) out.push({ text: `Not read: ${l.rest.join(' ')}`, warn: true });
      if (!e) {
        const misses = N.nearMisses(n, names);
        if (misses.length) out.push({ text: 'Not in the project. Did you mean', fixes: misses.map((m) => ({ label: m, run: () => setLine(m) })), warn: true });
        const tierNow = N.tierOf(n, presetId);
        if (!tierNow) {
          const fixes = N.corrections(n, presetId, names).filter((c) => !misses.includes(c.name)).slice(0, 4);
          if (fixes.length || !misses.length) out.push({ text: fixes.length ? 'Not to the styleguide. Perhaps' : 'Not to the styleguide: say what it is', fixes: fixes.map((c) => ({ label: c.name, run: () => setLine(c.name) })), warn: true });
        }
        if (tierNow === 'shot') {
          const seq = N.seqOf(n);
          const seqs = [...new Set(names.filter((x) => N.tierOf(x, presetId) === 'shot').map(N.seqOf))];
          const above = lineContext().taken.some((x) => N.seqOf(x) === seq && N.tierOf(x, presetId) === 'shot');
          if (!seqs.includes(seq) && !above) {
            const like = N.nearMisses(seq, seqs);
            out.push({ text: like.length ? `A new sequence, ${seq}. Did you mean` : `A new sequence: ${seq}`, fixes: like.map((s) => ({ label: s, run: () => setLine(`${s}-${N.pad(N.shotNumber(n))}`) })), warn: true, newSeq: seq });
          } else {
            const s = N.sequence(names, seq);
            const num = N.shotNumber(n);
            if (s.last && num > s.last + 10 * s.step) out.push({ text: `Far past the last shot of ${seq} (${N.pad(s.last)})`, warn: true });
          }
        }
      } else if (useTasks) {
        // A second count for one asset, set or shot: with a task beside one without, or the other way.
        const t = taskName();
        const tops = e.tops || {};
        const counted = Object.keys(tops).filter((k) => k);
        if (t && !tops[t] && tops['']) {
          out.push({ text: `${n} has ${tops[''] > 1 ? `v1–v${tops['']}` : 'a v1'} with no task: this starts ${t} at v1`, fixes: [{ label: `File as v${tops[''] + 1} with no task`, run: () => { changed(); taskIn.value = ''; sync(); } }], warn: true });
        } else if (!t && !tops[''] && counted.length) {
          out.push({ text: `${n} is counted by task (${counted.map((k) => `${k} v${tops[k]}`).join(', ')}): this starts a count with no task`, fixes: counted.slice(0, 3).map((k) => ({ label: k, run: () => { changed(); taskIn.value = k; sync(); } })), warn: true });
        }
      }
      // What the piece itself looks like it is: said when it agrees, and when it seems to be something else.
      const best = likely[0];
      if (best) {
        const same = best.entity === n && (!useTasks || (best.task || null) === taskName());
        if (same) out.push({ text: `Like its v${best.number}: ${best.why.join(', ')}`, ok: true });
        else if (best.score >= 0.75) out.push({ text: 'It looks like', fixes: [{ label: N.label(best.entity, useTasks ? best.task : null, best.number), run: () => setLine(best.entity, useTasks ? best.task || '' : undefined) }], warn: true });
      }
      return out;
    }

    // The number it gets: the page's, or the next of its entity and task after the rows above going there.
    function number() {
      if (numberOf) return numberOf();
      const n = name();
      const t = taskName();
      const { list, at } = around();
      const before = list.slice(0, Math.max(0, at)).filter((p) => p.name() === n && p.taskName() === t).length;
      return nextOf(have(n), t, before);
    }

    function paintReadout() {
      const n = name();
      readout.hidden = !n;
      if (!n) return readout.replaceChildren();
      const e = have(n);
      const t = taskName();
      const tierId = e ? e.tier : N.tierOf(n, presetId) || tier.value;
      const seq = tierId === 'shot' ? N.seqOf(n) : null;
      const head = e && e.heads ? e.heads[t || ''] : null;
      const num = number();
      const path = [tierLabel(presetId, tierId), seq, n, t].filter(Boolean);
      const parts = [];
      parts.push(el('span', { class: 'file-path' }, path.flatMap((p, i) => [i ? el('i', { text: '›' }) : null, el('span', { class: i === path.length - 1 || p === n ? 'b' : '', text: p })])));
      if (head) {
        parts.push(el('span', { class: 'file-prev', title: `Follows ${N.label(n, t, head.number)}` },
          head.thumb ? el('img', { src: head.thumb, alt: '' }) : null, el('span', { text: `v${head.number}` }), el('i', { text: '→' })));
      }
      parts.push(el('b', { class: `file-num${e ? '' : ' new'}`, text: num ? `v${num}` : 'next' }));
      if (!e) parts.push(el('span', { class: 'file-new', text: `new ${tierId}` }));
      const notes = checks().map((c) => el('span', { class: `file-note${c.warn ? ' warn' : ''}${c.ok ? ' ok' : ''}` },
        el('span', { text: c.text }),
        (c.fixes || []).map((f) => el('button', { type: 'button', class: 'file-fix', text: f.label, onpointerdown: (ev) => ev.preventDefault(), onclick: () => { f.run(); onChange(); } }))));
      readout.replaceChildren(el('div', { class: 'file-what' }, parts), ...notes);
    }

    const sync = () => {
      const n = name();
      tier.hidden = !n || !!have(n) || !!N.tierOf(n, presetId);
      paintReadout();
    };
    for (const input of [ent, taskIn]) {
      input.addEventListener('input', () => {
        changed();
        sync();
        onChange();
      });
    }
    tier.addEventListener('change', () => { sync(); onChange(); });
    sync();
    return Object.assign(self, {
      ent, task: taskIn, tier, readout, sync, name, have, taskName, settle, setLine, checks,
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
        if (likely.length && document.activeElement === ent && !ent.value.trim()) combo.show();
      },
    });
  }

  // Shift+Enter: the rows below `from` are filled in on from it. Shots go on in their sequence's step
  // (kilo-0010, kilo-0020...), skipping any the project has; anything else is the same for them all.
  function series(from, list, entities, presetId) {
    const at = list.indexOf(from);
    const n = from.name();
    if (at < 0 || !n) return;
    const task = from.taskName();
    const names = entities.map((e) => e.name);
    const shot = N.tierOf(n, presetId) === 'shot' ? N.seqOf(n) : null;
    const step = shot ? N.sequence(names, shot).step : 0;
    let num = shot ? N.shotNumber(n) : 0;
    for (const p of list.slice(at + 1)) {
      if (shot) {
        do num += step; while (names.includes(`${shot}-${N.pad(num)}`) && num < 9999);
        p.setLine(`${shot}-${N.pad(num)}`, task || '');
      } else p.setLine(n, task || '');
    }
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

  return { suggest, entitySource, taskSource, fields, changed, series, forAll, confirmSequences, findLikely, offerRule, originalFits, streamsOf, nextOf };
})();
