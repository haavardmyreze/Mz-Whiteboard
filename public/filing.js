'use strict';

// Filing pieces as versions, the same wherever it is done: a board's "File as a version" (Shift+V) and
// the catalogue's import strip ask the same questions, with the same fields. Each piece has a row:
// which asset, set or shot it is (suggested from the project's own as it is typed, or a new one, and
// then what it is), and the task. Several pieces can be given one answer to start from ("For all").
// Loaded after naming.js, before the pages that file.
const WBFiling = (() => {
  const { el } = WB;
  const N = WBNaming;

  // Suggestions for "which asset, set or shot", as a name is typed: the project's own, best first (those
  // that start with it, then those that hold it), each with what it is and how many versions it has;
  // and for a name the project does not have, the way to make it.
  function suggest(entities, typed, presetId, max = 8) {
    const list = entities || [];
    const name = N.tokenize(typed);
    const out = WB.rank(list, typed, (e) => e.name, max).map((e) => ({
      value: e.name, label: e.name, thumb: e.thumb || null,
      hint: `${e.tier}${e.versions ? ` · ${WB.plural(e.versions, 'version')}` : ''}`,
    }));
    if (name && !list.some((e) => e.name === name)) out.push({ value: name, label: `New: ${name}`, hint: N.tierOf(name, presetId) || 'say what it is', make: true });
    return out;
  }
  const entitySource = (getEntities, presetId) => (typed) => suggest(getEntities(), typed, presetId);
  const taskSource = (getTasks) => (typed) => WB.rank(getTasks(), typed).map((t) => ({ value: t, label: t }));

  // One piece's fields. `getEntities()` and `getTasks()` are the project's as last known; `onChange`
  // hears every edit. The tier is asked only for a new name whose shape does not say it.
  function fields({ entity = '', task = '', presetId, getEntities, getTasks, label = 'it', onChange = () => {} }) {
    const ent = el('input', { type: 'text', value: entity, placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': `What ${label} is` });
    const taskIn = el('input', { type: 'text', value: task, placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task' });
    const tier = el('select', { 'aria-label': 'What it is', title: 'A new one: what is it?' }, N.preset(presetId).tiers.map((t) => el('option', { value: t.id, text: t.one })));
    WB.combo(ent, entitySource(getEntities, presetId));
    WB.combo(taskIn, taskSource(getTasks));
    const name = () => N.tokenize(ent.value);
    const have = (n) => (getEntities() || []).find((e) => e.name === n) || null;
    const sync = () => {
      const n = name();
      tier.hidden = !n || !!have(n) || !!N.tierOf(n, presetId);
    };
    for (const input of [ent, taskIn]) input.addEventListener('input', () => { sync(); onChange(); });
    sync();
    return {
      ent, task: taskIn, tier, sync, name, have,
      taskName: () => N.tokenize(taskIn.value) || null,
      // What the server is told it is: one the project has, by id, or a new one, by name and tier.
      entity: () => {
        const n = name();
        const h = have(n);
        return h ? h.id : { name: n, tier: N.tierOf(n, presetId) || tier.value };
      },
      // The project does not have it yet: it is made when filed.
      isNew: () => !!name() && !have(name()),
    };
  }

  // "For all": one answer to start every row from. `apply(entity, task)` fills the rows (either may be '').
  function forAll({ presetId, getEntities, getTasks, apply, cls = 'file-fill' }) {
    const ent = el('input', { type: 'text', placeholder: 'Asset, set or shot', spellcheck: 'false', 'aria-label': 'Asset, set or shot for all' });
    const task = el('input', { type: 'text', placeholder: 'Task', spellcheck: 'false', 'aria-label': 'Task for all' });
    WB.combo(ent, entitySource(getEntities, presetId));
    WB.combo(task, taskSource(getTasks));
    const go = () => apply(ent.value.trim(), task.value.trim());
    return el('div', { class: cls }, el('span', { text: 'For all' }), ent, task,
      el('button', { type: 'button', class: 'btn small', text: 'Fill in', onclick: go }));
  }

  // Whether the file a video's review copy was made from may be kept on the server too.
  const originalFits = (file) => {
    const max = WB.info().maxUpload;
    return !max || file.size <= max;
  };

  return { suggest, entitySource, taskSource, fields, forAll, originalFits };
})();
