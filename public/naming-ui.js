'use strict';

// Naming conventions on the page: which one a project follows (a row of its settings), and the editor a
// studio makes its own in, best from a few of its own file names (see guess and validate in naming.js).
// The studio's conventions are kept by the server (/api/conventions); every page has them from
// /conventions.js, before any name is read.
window.WBNamingUI = (() => {
  const { el, api, toast, plural } = WB;
  const N = WBNaming;
  const DRAFT = '__draft__';

  // A name a template makes, to show what it means: chr-robot, kilo-0010.
  function sample(tier) {
    if (!tier.name) return '';
    return tier.name.replace('{prefix}', (tier.prefixes || [])[0] || 'x').replace('{what}', 'robot').replace('{seq}', 'kilo')
      .replace(/\{shot:(\d)\}/, (_, d) => '10'.padStart(Number(d), '0'));
  }
  // What a convention says, a line each: "Shots: kilo-0010".
  const said = (p) => p.tiers.map((t) => `${t.label}: ${t.name ? t.examples && t.examples.length ? t.examples.slice(0, 2).join(', ') : sample(t) : 'any name'}`);

  // The setting: which convention a project follows. `control` is the choice, `detail` what it says and,
  // for an admin, how to make or change one. `value()` is the one chosen.
  async function projectRow(project, cat) {
    let data = await api('GET', '/api/conventions').catch(() => null);
    const current = (cat && cat.preset && cat.preset.id) || (project.settings && project.settings.naming) || N.defaultId();
    let chosen = current;
    const sel = el('select', { 'aria-label': 'Naming convention' });
    const detail = el('div', { class: 'nc-detail' });
    sel.addEventListener('change', () => {
      chosen = sel.value;
      paint();
    });
    const names = (cat && cat.entities ? cat.entities : []).map((e) => e.name);
    function paint() {
      const list = data ? data.conventions : N.conventions();
      const studio = data ? data.default : N.defaultId();
      sel.replaceChildren(...list.map((c) => el('option', { value: c.id, text: `${c.name}${c.id === studio ? ' (studio)' : ''}`, ...(c.id === chosen && { selected: true }) })));
      const p = N.preset(chosen);
      const off = chosen !== current && N.preset(chosen).strict ? names.filter((n) => !N.tierOf(n, chosen)).length : 0;
      const canEdit = data && data.canEdit;
      const custom = list.find((c) => c.id === chosen && c.custom);
      detail.replaceChildren(...[
        el('div', { class: 'nc-said' }, said(p).map((line) => el('span', { text: line }))),
        off && el('div', { class: 'nc-warn', text: `${plural(off, 'name')} here ${off === 1 ? 'is' : 'are'} not to it. Names stay as they are; new ones are checked by it.` }),
        canEdit && el('div', { class: 'nc-actions' },
          el('button', { type: 'button', class: 'btn small', text: 'New from file names…', onclick: () => open({ from: chosen }) }),
          el('button', { type: 'button', class: 'btn small ghost', text: custom ? 'Edit…' : 'Copy and change…', onclick: () => open(custom ? { id: chosen } : { from: chosen, copy: true }) }),
          chosen !== studio && el('button', {
            type: 'button', class: 'btn small ghost', text: 'Make it the studio’s', title: 'New projects start with it, and projects that say none follow it',
            onclick: async () => {
              try {
                data = await api('PATCH', '/api/conventions', { default: chosen });
                N.setDefault(chosen);
                paint();
                toast(`New projects start with ${p.name}`);
              } catch (err) {
                toast(err.message, { ms: 6000 });
              }
            },
          })),
      ].filter(Boolean));
    }
    function open(opts) {
      editor({
        ...opts, data,
        onSaved: (id, next) => {
          data = next;
          if (id) chosen = id;
          else if (!N.PRESETS[chosen]) chosen = current;
          paint();
        },
      });
    }
    paint();
    return { control: sel, detail, value: () => chosen, changed: () => chosen !== current };
  }

  // The editor: a convention's name, how each of assets, sets and shots is named, and how its files are
  // read, filled in from file names pasted in, with how each of them reads by it as it stands.
  // `id` is a studio convention to change; otherwise a new one, from `from` (a copy of it when `copy`).
  // `onSaved(id, data)` with what the server then says (id null when one was deleted).
  function editor({ id = null, from = N.defaultId(), copy = false, data = null, onSaved = () => {} }) {
    const own = id && data && data.conventions.find((c) => c.id === id);
    const start = JSON.parse(JSON.stringify(own ? own.convention : N.CONVENTIONS[from] || N.CONVENTIONS[N.DEFAULT]));
    if (!own) start.name = copy ? `${start.name} (ours)` : '';
    const examples = el('textarea', {
      rows: 5, spellcheck: 'false', class: 'nc-files', 'aria-label': 'File names, one a line',
      placeholder: 'A few of your file names, one a line:\nsq010-sh0040_comp_anna_v003.mov\nchr-robot_model_erik_v002.mov',
    });
    const readBtn = el('button', { type: 'button', class: 'btn small', text: 'Read these' });
    const found = el('ul', { class: 'nc-found' });
    const name = el('input', { type: 'text', value: start.name || '', maxlength: 60, placeholder: 'Our naming', 'aria-label': 'Its name' });
    const tierRows = N.TIERS.map((tid) => {
      const t = start.tiers.find((x) => x.id === tid) || { id: tid };
      const r = {
        id: tid,
        label: el('input', { type: 'text', value: t.label || '', maxlength: 24, 'aria-label': `What ${tid}s are called` }),
        name: el('input', { type: 'text', value: t.name || '', spellcheck: 'false', placeholder: tid === 'shot' ? '{seq}-{shot:4}' : 'any name', 'aria-label': `How a ${tid} is named` }),
        prefixes: el('input', { type: 'text', value: (t.prefixes || []).join(', '), spellcheck: 'false', placeholder: 'prefixes', 'aria-label': `The prefixes of ${tid}s` }),
        used: el('input', { type: 'checkbox', class: 'switch', ...(!t.hidden && { checked: true }), 'aria-label': `It has ${tid}s` }),
        example: el('span', { class: 'nc-eg' }),
        examples: t.examples || [],
      };
      return r;
    });
    const sep = el('select', { 'aria-label': 'Between the parts of a file name' },
      [['_', '_ underscore'], ['.', '. dot']].map(([v, text]) => el('option', { value: v, text, ...((start.file || {}).sep === v && { selected: true }) })));
    const mark = el('input', { type: 'text', value: (start.file || {}).version ?? 'v', maxlength: 4, spellcheck: 'false', 'aria-label': 'Before a version number' });
    const tasks = el('input', { type: 'text', value: (start.tasks || []).join(', '), spellcheck: 'false', 'aria-label': 'Its usual tasks' });
    const reads = el('ul', { class: 'nc-reads' });
    const error = el('div', { class: 'nc-error', hidden: true });
    const save = el('button', { type: 'submit', class: 'btn primary', text: own ? 'Save' : 'Keep it' });
    const words = (v) => v.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    let aliases = start.aliases || {};

    const draft = () => ({
      name: name.value.trim(),
      tiers: tierRows.map((r) => {
        const label = r.label.value.trim();
        const one = (label || r.id).toLowerCase().replace(/s$/, '') || r.id;
        return {
          id: r.id, label: label || `${r.id.charAt(0).toUpperCase()}${r.id.slice(1)}s`, one, ...(r.name.value.trim() && { name: r.name.value.trim().toLowerCase() }),
          ...(r.name.value.includes('{prefix}') && { prefixes: words(r.prefixes.value) }), ...(!r.used.checked && { hidden: true }),
          ...(r.examples.length && { examples: r.examples }),
        };
      }),
      file: { sep: sep.value, version: mark.value.trim() },
      tasks: words(tasks.value),
      aliases,
    });
    const files = () => examples.value.split('\n').map((x) => x.trim()).filter(Boolean);

    // What it is now, and how the names pasted in read by it.
    function paint() {
      const checked = N.validate({ ...draft(), name: draft().name || 'Draft' });
      error.hidden = !checked.error;
      error.textContent = checked.error || '';
      save.disabled = !!checked.error || !draft().name;
      save.title = !draft().name ? 'Give it a name' : '';
      for (const r of tierRows) {
        r.prefixes.hidden = !r.name.value.includes('{prefix}');
        for (const x of [r.label, r.name, r.prefixes]) x.disabled = !r.used.checked;
        r.example.textContent = '';
      }
      if (checked.error) return reads.replaceChildren();
      N.register(DRAFT, checked.convention);
      try {
        const p = N.preset(DRAFT);
        for (const r of tierRows) {
          const t = p.tiers.find((x) => x.id === r.id);
          r.example.textContent = !t ? 'not used' : t.name ? `e.g. ${sample(t)}` : 'any name, said when filed';
        }
        reads.replaceChildren(...files().slice(0, 30).map((f) => {
          const x = N.parse(f, DRAFT);
          const t = x.tier && p.tiers.find((y) => y.id === x.tier);
          return el('li', { class: x.entity ? '' : 'none' },
            el('span', { class: 'nc-file', text: f }),
            el('span', { text: x.entity ? [x.entity, t ? t.one : x.tier, x.task, x.hip != null && `v${x.hip}`, x.view].filter(Boolean).join(' · ') : 'not read: file one by hand and names like it are learned' }));
        }));
      } finally {
        N.register(DRAFT, null);
      }
    }
    function fill(c) {
      name.value = name.value || c.name || '';
      for (const r of tierRows) {
        const t = c.tiers.find((x) => x.id === r.id) || {};
        r.label.value = t.label || r.label.value;
        r.name.value = t.name || '';
        r.prefixes.value = (t.prefixes || []).join(', ');
        r.used.checked = !t.hidden;
        r.examples = t.examples || [];
      }
      sep.value = c.file.sep;
      mark.value = c.file.version;
      tasks.value = (c.tasks || []).join(', ');
      aliases = c.aliases || {};
    }
    readBtn.addEventListener('click', () => {
      if (!files().length) return examples.focus();
      const g = N.guess(files(), from);
      fill({ ...g.convention, name: '' });
      found.replaceChildren(...g.notes.map((n) => el('li', { text: n })));
      paint();
    });
    const dlg = el('dialog', { class: 'dlg nc-dlg' });
    dlg.addEventListener('input', paint);
    dlg.addEventListener('change', paint);
    const field = (label, hint, ...control) => el('label', { class: 'nc-field' }, el('span', { class: 'nc-flabel' }, el('b', { text: label }), hint && el('span', { text: hint })), ...control);
    dlg.append(el('form', {
      method: 'dialog',
      onsubmit: async (e) => {
        e.preventDefault();
        const body = { convention: draft() };
        save.disabled = true;
        try {
          const next = own ? await api('PUT', `/api/conventions/${id}`, body) : await api('POST', '/api/conventions', body);
          const kept = own ? id : next.id;
          const c = next.conventions.find((x) => x.id === kept);
          if (c) N.register(kept, c.convention);
          dlg.close();
          toast(own ? `${body.convention.name} is saved` : `${body.convention.name} is kept for the studio. Save the settings to follow it here`, { ms: 6000 });
          onSaved(kept, next);
        } catch (err) {
          error.hidden = false;
          error.textContent = err.message;
          save.disabled = false;
        }
      },
    },
    el('h2', { text: own ? `Naming: ${own.name}` : 'A naming convention' }),
    el('p', { class: 'nc-intro', text: 'How your studio names what it makes. Paste a few of your file names to start from them, then change what is wrong.' }),
    el('div', { class: 'nc-paste' }, examples, el('div', { class: 'nc-paste-go' }, readBtn)),
    found,
    field('Name', null, name),
    el('h3', { class: 'ps-sec', text: 'Names' }),
    el('p', { class: 'nc-help', text: 'Lower case, words joined by -. {prefix} is one of its prefixes, {what} what it is, {seq} the sequence, {shot:4} the shot in 4 digits. Empty: any name.' }),
    el('div', { class: 'nc-tiers' }, tierRows.map((r) => el('div', { class: 'nc-tier' }, r.used, r.label, r.name, r.prefixes, r.example))),
    el('h3', { class: 'ps-sec', text: 'Files' }),
    el('div', { class: 'nc-row' }, field('Between parts', null, sep), field('Before a version', 'v for v012', mark)),
    field('Tasks', 'The usual ones, offered first', tasks),
    reads,
    error,
    el('div', { class: 'dlg-actions' },
      own && el('button', {
        type: 'button', class: 'btn danger ghost nc-delete', text: 'Delete',
        onclick: async () => {
          const sure = await WB.dialog({ title: `Delete ${own.name}?`, text: 'Projects that follow it have to be moved to another first.', ok: 'Delete', danger: true });
          if (!sure) return;
          try {
            const next = await api('DELETE', `/api/conventions/${id}`);
            N.register(id, null);
            dlg.close();
            onSaved(null, next);
          } catch (err) {
            error.hidden = false;
            error.textContent = err.message;
          }
        },
      }),
      el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => dlg.close() }),
      save)));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.append(dlg);
    paint();
    dlg.showModal();
    (own ? name : examples).focus();
    return dlg;
  }

  return { projectRow, editor, sample };
})();
