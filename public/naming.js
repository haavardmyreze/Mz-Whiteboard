'use strict';

// How a file's name is read for the catalogue. Nothing here is ever required: a name that says nothing
// (screenshoot_090126.png) is still filed, by hand. What a name does say only fills in the choices ahead
// of time. Used by the server and by the pages, so both read a name the same way.
//
// A project follows a convention: how a studio names what it makes. The structure is the same for every
// studio (assets, sets and shots in sequences; tasks; numbered versions; views); only the names differ,
// so a convention is data, not code: words and templates, compiled below into what the code reads.
// The one there is, Myreze's styleguide:
//   `_` separates tokens, `-` joins words inside a token, all lowercase.
//   An asset is char-, prop-, env-, veh- or fx- something (char-robot), a set is set- something
//   (set-living-room), a shot is <sequence>-<four digits> (kilo-0010, ch01-0010).
//   A Houdini file is <context>_<task>[_<descriptor>]_<artist>_v###: the context first (its shape says
//   what tier it is), then the task, the version last, the artist before it, and anything between is
//   the descriptor. Review media is taken to be named the same way (kilo-0010_anim_erik_v012.mov).
//   A word after the version is the view the file shows of it (kilo-0010_comp_erik_v012_bty.mov): the
//   projected look beside the unwrapped one, say. Most files have none.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.WBNaming = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const WORDS = '[a-z0-9]+(?:-[a-z0-9]+)*';

  // A convention:
  //   tiers: each the same three, asset, set and shot, as this studio calls and names them. `name` is the
  //     template a name of it has: literal text and
  //       {prefix}  one of the tier's `prefixes`        {what}   what it is, in words (robot, old-sword)
  //       {seq}     the sequence, in words (kilo, ep2-intro)   {shot:N}  the shot, N digits
  //     A shot's template has a {seq} and a {shot:N}. `examples` are shown beside its shape. A tier with
  //     no template takes any name, said by hand to be one; a `hidden` one is not offered at all (a studio
  //     that makes no sets).
  //   file: how a file's name is read: `sep` between its tokens and `version` before its number (v012).
  //   tasks: the tasks it usually has. aliases: words written for a prefix instead of it (character-robot).
  // These are the ones every studio has; a studio's own are kept by the server (see register below).
  const CONVENTIONS = {
    myreze: {
      name: 'Myreze styleguide',
      tiers: [
        { id: 'asset', label: 'Assets', one: 'asset', name: '{prefix}-{what}', prefixes: ['char', 'prop', 'env', 'veh', 'fx'], examples: ['char-robot', 'prop-old-sword'] },
        { id: 'set', label: 'Sets', one: 'set', name: '{prefix}-{what}', prefixes: ['set'], examples: ['set-living-room'] },
        { id: 'shot', label: 'Shots', one: 'shot', name: '{seq}-{shot:4}', examples: ['kilo-0010', 'ch01-0020', 'ep2-intro-0100'] },
      ],
      file: { sep: '_', version: 'v' },
      tasks: ['model', 'rig', 'lookdev', 'dressing', 'layout', 'anim', 'fx', 'lighting'],
      aliases: { character: 'char', chr: 'char', props: 'prop', vehicle: 'veh', environment: 'env', effect: 'fx', effects: 'fx', vfx: 'fx' },
    },
    episodic: {
      name: 'Episodic (ep / sq / sh)',
      tiers: [
        { id: 'asset', label: 'Assets', one: 'asset', name: '{prefix}-{what}', prefixes: ['chr', 'prp', 'env', 'veh', 'fx'], examples: ['chr-robot', 'prp-old-sword'] },
        { id: 'set', label: 'Sets', one: 'set', name: '{prefix}-{what}', prefixes: ['set'], examples: ['set-harbour'] },
        { id: 'shot', label: 'Shots', one: 'shot', name: '{seq}-sh{shot:4}', examples: ['ep01-sq010-sh0010', 'sq020-sh0040'] },
      ],
      file: { sep: '_', version: 'v' },
      tasks: ['model', 'rig', 'lookdev', 'layout', 'anim', 'fx', 'lighting', 'comp'],
      aliases: { char: 'chr', character: 'chr', prop: 'prp', props: 'prp', vehicle: 'veh', environment: 'env', vfx: 'fx' },
    },
    free: {
      name: 'Free naming',
      tiers: [
        { id: 'asset', label: 'Assets', one: 'asset' },
        { id: 'set', label: 'Sets', one: 'set' },
        { id: 'shot', label: 'Shots', one: 'shot' },
      ],
      file: { sep: '_', version: 'v' },
      tasks: ['model', 'rig', 'lookdev', 'layout', 'anim', 'fx', 'lighting', 'comp'],
    },
  };

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const DIGITS = ['one', 'two', 'three', 'four', 'five', 'six'];
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}` : xs[0] || '');
  // A template's literal text and parts in order: ['', '{seq}', '-', '{shot:4}', ''].
  const pieces = (template) => template.split(/(\{(?:prefix|what|seq|shot:\d)\})/);

  // A tier as the code reads it: the convention's words, and `test` (whether a name is of it), `shape`
  // (what its template says, in words, shown to people and told to Claude) and, for shots, `shot`: the
  // text before the sequence, between it and the number, and after, and how many digits the number has.
  function compileTier(tier) {
    if (!tier.name) return { ...tier, prefixes: [], test: /(?!)/, shape: 'anything: what it is is said when it is filed' };
    const parts = pieces(tier.name);
    const prefixes = tier.prefixes || [];
    const test = new RegExp(`^${parts.map((p, i) => (i % 2 === 0 ? esc(p)
      : p === '{prefix}' ? `(?:${prefixes.map(esc).join('|')})` : p.startsWith('{shot') ? `[0-9]{${p[6]}}` : WORDS)).join('')}$`);
    const ex = tier.examples && tier.examples.length ? ` (${tier.examples.join(', ')})` : '';
    let shape;
    if (parts.length === 5 && parts[0] === '' && parts[1] === '{prefix}' && parts[3] === '{what}' && parts[4] === '') {
      shape = `${list(prefixes.map((x) => `${x}${parts[2]}`))} and then what it is${ex}`;
    } else {
      const notes = [];
      const said = parts.map((p, i) => {
        if (i % 2 === 0) return p;
        if (p === '{prefix}') return `<${prefixes.join('|')}>`;
        if (p === '{what}') return '<what it is>';
        if (p === '{seq}') {
          notes.push('the sequence is free');
          return '<sequence>';
        }
        notes.unshift(`the shot is always ${DIGITS[p[6] - 1] || p[6]} digits`);
        return '<shot>';
      }).join('');
      shape = `${said}${notes.length ? `: ${notes.join(', ')}` : ''}${ex}`;
    }
    const out = { ...tier, prefixes, test, shape };
    const seq = parts.indexOf('{seq}');
    const num = parts.findIndex((p) => p.startsWith('{shot'));
    if (tier.id === 'shot' && seq === 1 && num === 3) out.shot = { before: parts[0], join: parts[2], after: parts[4], digits: Number(parts[3][6]) };
    return out;
  }
  // How a convention's shots are written, with the patterns that read them: `seq` (the sequence of a shot
  // whose number has any digits, so one named by hand with a shorter number, ab-12, still has one), `num`
  // (its number) and `whole` (whether its number has all its digits).
  function shotForm({ before, join, after, digits }) {
    const [b, j, a] = [before, join, after].map(esc);
    return {
      before, join, after, digits,
      seq: new RegExp(`^${b}(${WORDS})${j}\\d+${a}$`),
      num: new RegExp(`${j}(\\d+)${a}$`),
      whole: new RegExp(`${j}\\d{${digits}}${a}$`),
    };
  }
  // A convention as the code reads it: `tiers` those it has, `every` with those it hides as well (a project
  // may have some of them from before). `free` when no name is checked, there being no templates to check by;
  // `strict` when every name is, so that a name of none of its shapes is not to it.
  // A shot's numbering is Myreze's where the convention does not say one (kilo-0010), so that shots named
  // that way still fall in sequences.
  function compile(convention) {
    const all = convention.tiers.map(compileTier);
    const tiers = all.filter((t) => !t.hidden);
    const shot = shotForm((all.find((t) => t.id === 'shot') || {}).shot || { before: '', join: '-', after: '', digits: 4 });
    return {
      ...convention, tiers, every: all, shot, free: !tiers.some((t) => t.name), strict: tiers.every((t) => t.name),
      file: { sep: '_', version: 'v', ...convention.file }, tasks: convention.tasks || [], aliases: convention.aliases || {},
    };
  }

  const TIERS = ['asset', 'set', 'shot'];
  const PRESETS = Object.fromEntries(Object.entries(CONVENTIONS).map(([id, c]) => [id, compile(c)]));
  const BUILT_IN = Object.keys(CONVENTIONS);
  // The convention a project follows when it says none: the studio's (see setDefault), else Myreze's.
  const DEFAULT = 'myreze';
  let studio = DEFAULT;
  const preset = (id) => PRESETS[id] || PRESETS[studio] || PRESETS[DEFAULT];
  const defaultId = () => (PRESETS[studio] ? studio : DEFAULT);
  function setDefault(id) {
    studio = PRESETS[id] ? id : DEFAULT;
  }

  // A convention as given (by a studio, from a form), checked: { convention } cleaned of anything else,
  // or { error } saying what is wrong with it, in words.
  function validate(input) {
    const c = input && typeof input === 'object' ? input : {};
    const name = String(c.name || '').trim().slice(0, 60);
    if (!name) return { error: 'A convention needs a name' };
    const word = (w) => typeof w === 'string' && /^[a-z0-9]{1,16}$/.test(w);
    const tiers = [];
    for (const id of TIERS) {
      const t = (Array.isArray(c.tiers) ? c.tiers : []).find((x) => x && x.id === id) || {};
      const one = String(t.one || id).trim().toLowerCase().slice(0, 24) || id;
      const out = { id, label: String(t.label || '').trim().slice(0, 24) || `${one.charAt(0).toUpperCase()}${one.slice(1)}s`, one };
      if (t.hidden) out.hidden = true;
      const template = String(t.name || '').trim().toLowerCase();
      if (template) {
        const parts = pieces(template);
        if (!parts.every((p, i) => (i % 2 === 0 ? /^[a-z0-9-]*$/.test(p) : true))) {
          return { error: `The ${one} name ${template} has more than letters, digits, dashes and {prefix}, {what}, {seq}, {shot:N} in it` };
        }
        if (/[{}]/.test(parts.filter((_, i) => i % 2 === 0).join(''))) return { error: `The ${one} name ${template} has a {…} that is not one of {prefix}, {what}, {seq}, {shot:N}` };
        const has = (x) => parts.filter((p) => p === x || (x === '{shot' && p.startsWith('{shot'))).length;
        if (id === 'shot') {
          if (has('{seq}') !== 1 || has('{shot') !== 1 || parts.length !== 5 || parts[1] !== '{seq}' || !parts[3].startsWith('{shot')) {
            return { error: `A shot is named by its sequence, then its number: ${template} needs {seq} and then {shot:N}, once each` };
          }
          if (!/^[a-z-]+$/.test(parts[2])) return { error: `Something must stand between a shot's sequence and its number, and not digits (${template})` };
          if (!(Number(parts[3][6]) >= 1 && Number(parts[3][6]) <= 6)) return { error: 'A shot number has 1 to 6 digits' };
        } else {
          if (has('{seq}') || has('{shot') || has('{what}') !== 1) return { error: `A ${one} is named by what it is: ${template} needs {what} once, and no {seq} or {shot}` };
        }
        out.name = template;
        if (has('{prefix}')) {
          const prefixes = [...new Set((Array.isArray(t.prefixes) ? t.prefixes : []).map((x) => String(x).trim().toLowerCase()))].filter(Boolean);
          if (!prefixes.length || !prefixes.every(word) || prefixes.length > 16) return { error: `The ${one} name ${template} has a {prefix}: say which (letters and digits, up to 16)` };
          out.prefixes = prefixes;
        }
      }
      // Examples only of what it says: one from before its template was changed is not one.
      const fits = out.name ? compileTier(out).test : TOKEN;
      const examples = (Array.isArray(t.examples) ? t.examples : []).map((x) => String(x).trim().toLowerCase()).filter((x) => TOKEN.test(x) && fits.test(x)).slice(0, 4);
      if (examples.length) out.examples = examples;
      tiers.push(out);
    }
    if (tiers.every((t) => t.hidden)) return { error: 'A convention has to keep one of assets, sets and shots' };
    const prefixOwner = new Map();
    for (const t of tiers) {
      for (const x of t.prefixes || []) {
        if (prefixOwner.has(x)) return { error: `${x} is a prefix of both ${prefixOwner.get(x)}s and ${t.one}s` };
        prefixOwner.set(x, t.one);
      }
    }
    const f = c.file && typeof c.file === 'object' ? c.file : {};
    const sep = f.sep === undefined ? '_' : f.sep;
    if (!['_', '.'].includes(sep)) return { error: 'File names are read with _ or . between their parts' };
    const version = f.version === undefined ? 'v' : String(f.version).toLowerCase();
    if (!/^[a-z]{0,4}$/.test(version)) return { error: 'What comes before a version number is up to four letters (v, ver), or nothing' };
    const tasks = [...new Set((Array.isArray(c.tasks) ? c.tasks : []).map((x) => String(x).trim().toLowerCase()))].filter((x) => TOKEN.test(x)).slice(0, 40);
    const aliases = {};
    for (const [k, v] of Object.entries(c.aliases && typeof c.aliases === 'object' ? c.aliases : {})) {
      if (word(k) && prefixOwner.has(v) && !prefixOwner.has(k)) aliases[k] = v;
    }
    return { convention: { name, tiers, file: { sep, version }, tasks, ...(Object.keys(aliases).length && { aliases }) } };
  }

  // A studio's own convention, by its id, beside those built in (which it cannot replace); null to forget it.
  function register(id, convention) {
    if (BUILT_IN.includes(id)) return false;
    if (convention == null) {
      delete PRESETS[id];
      return true;
    }
    PRESETS[id] = { ...compile(convention), custom: true };
    return true;
  }
  // The studio's own conventions ({ id: convention }) and its default, as the server says them: the ones
  // there were before are forgotten.
  function setConventions(own, studioDefault) {
    for (const id of Object.keys(PRESETS)) if (PRESETS[id].custom) delete PRESETS[id];
    for (const [id, c] of Object.entries(own || {})) register(id, c);
    setDefault(studioDefault);
  }
  // Every convention there is, built in first: [{ id, name, custom }].
  const conventions = () => Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name, custom: !!p.custom }));

  // A name as a token: lower case, words joined by `-`. "Living Room" -> "living-room".
  function tokenize(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  // What tier a name has the shape of, or null.
  function tierOf(name, presetId) {
    const n = String(name || '');
    const t = preset(presetId).tiers.find((tier) => tier.test.test(n));
    return t ? t.id : null;
  }

  // The sequence a shot is in: everything before its number ("kilo" for kilo-0010, "ch01" for
  // ch01-0010). Asked only of shots, so a shot named by hand with a shorter number (ab-12) still has one.
  const seqOf = (name, presetId) => (preset(presetId).shot.seq.exec(name || '') || [])[1] || null;
  // A shot's number as its convention writes it (0010), and the shot of a sequence by its number (kilo-0010).
  const pad = (n, presetId) => {
    const { digits } = preset(presetId).shot;
    return String(Math.min(10 ** digits - 1, Math.max(0, n))).padStart(digits, '0');
  };
  const shotName = (seq, n, presetId) => {
    const s = preset(presetId).shot;
    return `${s.before}${seq}${s.join}${pad(n, presetId)}${s.after}`;
  };
  const shotNumber = (name, presetId) => {
    const m = preset(presetId).shot.num.exec(name || '');
    return m ? Number(m[1]) : null;
  };

  // Whatever can be read from a file name: { entity, tier, task, descriptor, artist, hip, view }, each null
  // when the name does not say. `hip` is the number after v: the version it is filed as, unless another
  // is said (otherwise the catalogue counts on from the last).
  function parse(filename, presetId) {
    const out = { entity: null, tier: null, task: null, descriptor: null, artist: null, hip: null, view: null };
    const stem = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().trim();
    if (!stem) return out;
    const { sep, version } = preset(presetId).file;
    const mark = new RegExp(`^${esc(version)}(\\d{1,4})$`);
    const tokens = stem.split(sep).filter(Boolean);
    if (!tokens.length || !tokens.every((t) => TOKEN.test(t))) {
      // Not to the styleguide, but a version number may still be at its end ("robot final v3").
      const v = /(?:^|[^a-z0-9])v(\d{1,4})$/.exec(stem);
      if (v) out.hip = Number(v[1]);
      return out;
    }
    if (tokens.length > 2 && mark.test(tokens[tokens.length - 2]) && !mark.test(tokens[tokens.length - 1])) out.view = tokens.pop();
    const last = mark.exec(tokens[tokens.length - 1]);
    if (last) {
      out.hip = Number(last[1]);
      tokens.pop();
    }
    const tier = tierOf(tokens[0], presetId);
    if (!tier) return out;
    out.entity = tokens[0];
    out.tier = tier;
    const middle = tokens.slice(1);
    const tasks = preset(presetId).tasks;
    if (last && middle.length >= 2) {
      out.task = middle[0];
      out.artist = middle[middle.length - 1];
      if (middle.length > 2) out.descriptor = middle.slice(1, -1).join('_');
    } else if (middle.length === 1) {
      // One word between the context and the version: a task if it is one, otherwise whoever made it.
      if (!last || tasks.includes(middle[0])) out.task = middle[0];
      else out.artist = middle[0];
    } else if (middle.length > 1) {
      out.task = middle[0];
      out.descriptor = middle.slice(1).join('_');
    }
    return out;
  }

  // What a version is called wherever it is shown: "kilo-0010 anim v5".
  function label(entity, task, number) {
    return [entity, task, `v${number}`].filter(Boolean).join(' ');
  }

  // ---- what is typed where a piece is filed

  // The views a version is most often shown in, beside those a project has.
  const VIEWS = ['cmp', 'bty'];

  // The shots a sequence has, by number, and the step they go up in: the gap there is most often between
  // one and the next, the smaller of two as often (10 when they do not say).
  function sequence(names, seq, presetId) {
    const { whole } = preset(presetId).shot;
    const nums = [...new Set((names || []).filter((n) => seqOf(n, presetId) === seq && whole.test(n)).map((n) => shotNumber(n, presetId)))].sort((a, b) => a - b);
    const gaps = new Map();
    for (let i = 1; i < nums.length; i++) gaps.set(nums[i] - nums[i - 1], (gaps.get(nums[i] - nums[i - 1]) || 0) + 1);
    let step = 10;
    let most = 0;
    for (const [gap, count] of gaps) {
      if (count > most || (count === most && gap < step)) {
        step = gap;
        most = count;
      }
    }
    return { nums, step, last: nums.length ? nums[nums.length - 1] : 0 };
  }
  // The shot after a sequence's last, on its step: kilo-0130 after kilo-0120.
  function nextShot(names, seq, presetId) {
    const { step, last } = sequence(names, seq, presetId);
    return shotName(seq, Math.floor(last / step) * step + step, presetId);
  }

  // What a line typed where a piece is filed says: which asset, set or shot, and any task, version number
  // and view after it ("kilo-0010 anim v12 bty"). A whole file name pasted in is read as a file name is.
  // A few short ways to say a shot, read against `ctx.seq` (the sequence being filed in): `20` is shot
  // 0020 of it, `+` its next shot (`kilo+` the next of kilo), and `.` whatever was filed last
  // (`ctx.last`). `task` is left undefined where the line does not say one, so that a task field keeps its
  // own; with `ctx.useTasks` false a line never says one. Words that are read as nothing are in `rest`.
  //   ctx: { presetId, names, tasks, views, useViews, seq, last: { entity, task }, useTasks, rules }
  function readLine(text, ctx = {}) {
    const out = { entity: null, task: undefined, number: null, view: null, short: null, rest: [] };
    const raw = String(text || '').trim();
    if (!raw) return out;
    const useTasks = ctx.useTasks !== false;
    const names = ctx.names || [];
    const P = ctx.presetId;
    if (raw.includes(preset(P).file.sep) && !/\s/.test(raw)) {
      const p = parse(raw, P);
      const ruled = !p.entity && byRules(raw, ctx.rules, ctx.tasks, P);
      if (p.entity || ruled) {
        out.entity = p.entity || ruled.entity;
        if (useTasks && (p.task || (ruled && ruled.task))) out.task = p.task || ruled.task;
        out.view = ctx.useViews === false ? null : p.view || (ruled && ruled.view) || null;
        out.number = (ruled ? ruled.number : p.hip) || null;
        if (ruled) out.short = `read by the rule for “${ruled.rule.word}”`;
        return out;
      }
    }
    const words = raw.toLowerCase().split(/[\s_,]+/).filter(Boolean);
    const first = words.shift();
    const seqPlus = /^([a-z0-9]+(?:-[a-z0-9]+)*?)-?\+$/.exec(first);
    if (first === '.') {
      if (ctx.last && ctx.last.entity) {
        out.entity = ctx.last.entity;
        if (useTasks) out.task = ctx.last.task || null;
        out.short = 'the same as the last';
      }
    } else if (first === '+' || seqPlus) {
      const seq = first === '+' ? ctx.seq : seqPlus[1];
      if (seq) {
        out.entity = nextShot([...names, ...(ctx.taken || [])], seq, P);
        out.short = `the next shot in ${seq}`;
      }
    } else if (/^\d+$/.test(first) && first.length <= preset(P).shot.digits && ctx.seq) {
      out.entity = shotName(ctx.seq, Number(first), P);
      out.short = `shot ${pad(Number(first), P)} of ${ctx.seq}`;
    } else out.entity = tokenize(first) || null;
    // A word after the name is a version number, a view or a task, by what it is. Any other word is more
    // of the name ("living room", "set living room") for as long as that makes it more of a name: not
    // once it is one the project has, and not when it would stop being to the styleguide.
    // The project's views when it says them (`ctx.views`, the main one first), none when it shows each
    // version one way (`ctx.useViews` false), and the usual ones otherwise.
    const views = ctx.useViews === false ? [] : ctx.views && ctx.views.length ? ctx.views : VIEWS;
    const tasks = ctx.tasks || [];
    const whole = () => !!out.entity && (names.includes(out.entity) || !!tierOf(out.entity, ctx.presetId));
    const longer = (t) => {
      const joined = tokenize(`${out.entity}-${t}`);
      return names.includes(joined) || (!names.includes(out.entity) && (!whole() || !!tierOf(joined, ctx.presetId)));
    };
    let more = !out.short && !!out.entity;
    for (const w of words) {
      const t = tokenize(w);
      if (!t) continue;
      const v = /^(?:v|#)(\d{1,5})$/.exec(w) || (whole() && /^(\d{1,5})$/.exec(w));
      if (v && out.number == null) out.number = Number(v[1]) || null;
      else if (views.includes(t) && !out.view) out.view = t;
      else if (useTasks && out.task === undefined && tasks.includes(t)) out.task = t;
      else if (more && longer(t)) {
        out.entity = tokenize(`${out.entity}-${t}`);
        continue;
      } else if (useTasks && out.task === undefined && whole()) out.task = t;
      else out.rest.push(w);
      more = false;
    }
    return out;
  }

  // Names to the styleguide that a name which is not to it may have been meant as, best first, each
  // { name, tier }: a shot with a short number (kilo-10 is kilo-0010), a prefix written out (character-robot
  // is char-robot), or else the name with each prefix in front of it. `names` are the project's own: a
  // number run on to a sequence of theirs (kilo10) is read as a shot of it.
  function corrections(typed, presetId, names = []) {
    const n = tokenize(typed);
    if (!n || tierOf(n, presetId)) return [];
    const p = preset(presetId);
    const out = [];
    const add = (name) => {
      const tier = tierOf(name, presetId);
      if (tier && !out.some((o) => o.name === name)) out.push({ name, tier });
    };
    const s = p.shot;
    const short = new RegExp(`^${esc(s.before)}(.+?)${esc(s.join)}(\\d{1,${s.digits - 1}})${esc(s.after)}$`).exec(n);
    if (short && s.digits > 1) add(shotName(short[1], Number(short[2]), presetId));
    const glued = new RegExp(`^([a-z][a-z0-9-]*?[a-z])(\\d{1,${s.digits}})$`).exec(n);
    if (glued && names.some((o) => seqOf(o, presetId) === glued[1])) add(shotName(glued[1], Number(glued[2]), presetId));
    const [head, ...tail] = n.split('-');
    if (p.aliases[head] && tail.length) add([p.aliases[head], ...tail].join('-'));
    // A name that is what something is and no more, as each tier with a prefix would have it.
    if (!out.length) {
      for (const tier of p.tiers) {
        if (!tier.name || !tier.name.includes('{what}')) continue;
        for (const prefix of tier.name.includes('{prefix}') ? tier.prefixes : ['']) add(tier.name.replace('{prefix}', prefix).replace('{what}', n));
      }
    }
    return out;
  }

  // How many single letters must change to make one word the other (stopping once past `most`).
  function distance(a, b, most = 3) {
    if (Math.abs(a.length - b.length) > most) return most + 1;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (Math.min(...next) > most) return most + 1;
      row = next;
    }
    return row[b.length];
  }
  // Which of `names` a new name was probably meant to be, best first: one a letter or two away (klio-0010
  // for kilo-0010), or the same but for how its number is written (kilo-010). Names that differ only in
  // their numbers (kilo-0020 beside kilo-0010, prop-sword-02 beside prop-sword-01) are not misses: a
  // project has many of those on purpose.
  function nearMisses(typed, names = [], max = 3) {
    const n = tokenize(typed);
    if (!n || names.includes(n)) return [];
    const shape = (s) => s.replace(/\d+/g, '#');
    const digits = (s) => (s.match(/\d+/g) || []).map(Number).join(',');
    const most = n.length > 6 ? 2 : 1;
    const found = [];
    for (const o of names) {
      let d;
      if (shape(o) === shape(n)) {
        if (digits(o) !== digits(n)) continue;
        d = 0;
      } else if ((d = distance(n, o, most)) > most) continue;
      found.push([d, o]);
    }
    return found.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)).slice(0, max).map((x) => x[1]);
  }

  // ---- names from elsewhere: rules learned from how they were filed
  //
  // A file named some other way, filed by hand, teaches how names like it read. Best, the whole of its
  // name as a pattern: NHMoc_CHAP01_010_cmp_v111 filed as chap01-0010 v111 teaches
  //   { pattern: ['nhmoc', '{seq}', '{shot}', '*', '{version}'], like, as }
  // each word being one to find in every name like it (nhmoc), where the sequence, the shot, the version,
  // the task or the view is ({seq}...), or anything (*: what changes from file to file, an artist, say).
  // NHMoc_CHAP03_040_cmp_v009 is then chap03-0040 v9. A sequence named otherwise there than here (KLO for
  // kilo) is kept as `seqs: { klo: 'kilo' }`; a shot's number run on after letters (sh010) as `{shot:sh}`.
  // A pattern needs a word of its own to know its names by (nhmoc, or a sequence it renames). Without one,
  // the first word is learned, as before: as a sequence ({ word: 'klo', seq: 'kilo' }, KLO_020 being
  // kilo-0020), or as one asset or set ({ word: 'robot', name: 'char-robot' }). Words that say nothing about
  // what a file shows are never learned.
  const VAGUE = new Set(['screenshot', 'screen', 'shot', 'img', 'image', 'render', 'untitled', 'capture', 'export', 'final', 'comp', 'video',
    'movie', 'clip', 'frame', 'still', 'playblast', 'test', 'new', 'copy', 'scan', 'photo', 'dsc', 'pxl', 'vid', 'mov', 'output', 'out', 'preview', 'wip']);
  const stem = (filename) => String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  const stemWords = (filename) => stem(filename).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const PATTERN_TOKEN = /^(?:[a-z0-9]{1,40}|\*|\{(?:seq|version|task|view)\}|\{shot(?::[a-z]{1,10})?\})$/;

  // The pattern a file's name teaches by being filed as `filed` ({ entity, task, number, view, views }:
  // what it was filed as, `views` the project's, the main one first), or null.
  function patternFrom(filename, filed, presetId) {
    const { entity, task = null, number = null, view = null, views = [] } = filed;
    if (tierOf(entity, presetId) !== 'shot') return null;
    const words = stemWords(filename);
    const seq = seqOf(entity, presetId);
    const n = shotNumber(entity, presetId);
    // The shot: a number of its own, or run on after letters; the sequence is the word before it.
    let at = -1;
    let prefix = '';
    for (let i = 1; i < words.length && at < 0; i++) {
      const m = /^([a-z]{0,10})(\d{1,4})$/.exec(words[i]);
      if (m && Number(m[2]) === n && /[a-z]/.test(words[i - 1])) {
        at = i;
        prefix = m[1];
      }
    }
    if (at < 0) return null;
    const pattern = words.map((w, i) => {
      if (i === at - 1) return '{seq}';
      if (i === at) return prefix ? `{shot:${prefix}}` : '{shot}';
      if (i > at && number != null && /^v?\d{1,5}$/.test(w) && Number(w.replace(/^v/, '')) === number) return '{version}';
      if (i > at && task && w === task) return '{task}';
      if (i > at && (views || []).includes(w) && (w === (view || views[0]))) return '{view}';
      return i < at ? w : '*';
    });
    const seqs = words[at - 1] === seq ? null : { [words[at - 1]]: seq };
    if (!seqs && !pattern.some((t, i) => i < at - 1 && !VAGUE.has(t) && /[a-z]/.test(t))) return null;
    return { pattern, ...(seqs && { seqs }), like: stem(filename).slice(0, 120), as: label(entity, task, number || '') .replace(/ v$/, '') };
  }

  // The rule a file teaches by being filed as `filed` (what it was filed as: { entity, task, number, view,
  // views }, or just the entity's name), or null when it teaches none (its name says it already, or says
  // nothing that could be learned).
  function ruleFrom(filename, filed, presetId) {
    const f = typeof filed === 'string' ? { entity: filed } : filed || {};
    const entity = f.entity;
    if (!entity || parse(filename, presetId).entity) return null;
    const whole = patternFrom(filename, f, presetId);
    if (whole) return whole;
    const [w0, w1] = stemWords(filename);
    if (!w0) return null;
    const seq = tierOf(entity, presetId) === 'shot' ? seqOf(entity, presetId) : null;
    if (seq) {
      const n = shotNumber(entity, presetId);
      if (/^\d+$/.test(w1 || '') && Number(w1) === n && /[a-z]/.test(w0) && !VAGUE.has(w0)) return { word: w0, seq };
      const glued = /^([a-z]+)(\d+)$/.exec(w0);
      if (glued && Number(glued[2]) === n && !VAGUE.has(glued[1])) return { word: glued[1], seq, glued: true };
      return null;
    }
    if (w0.length < 3 || /^\d+$/.test(w0) || VAGUE.has(w0)) return null;
    return { word: w0, name: entity };
  }
  // A rule's key: two rules with the same are the same rule.
  const ruleKey = (rule) => (rule.pattern ? `p:${rule.pattern.join('_')}:${JSON.stringify(rule.seqs || {})}` : `w:${rule.word}`);

  // What a name reads as by a pattern: { entity, task, number, view }, or null when it is not one like it.
  function byPattern(words, rule, presetId) {
    if (words.length !== rule.pattern.length) return null;
    // A pattern with no word of its own is known only by the sequences it renames (KLO for kilo).
    const anchored = rule.pattern.some((t) => !t.startsWith('{') && t !== '*');
    const out = { entity: null, task: null, number: null, view: null };
    let seq = null;
    let shot = null;
    for (let i = 0; i < words.length; i++) {
      const t = rule.pattern[i];
      const w = words[i];
      if (t === '*') continue;
      if (t === '{seq}') {
        if (!/[a-z]/.test(w) || (!anchored && !(rule.seqs && rule.seqs[w]))) return null;
        seq = (rule.seqs && rule.seqs[w]) || w;
      } else if (t.startsWith('{shot')) {
        const m = new RegExp(`^${(t.split(':')[1] || '}').slice(0, -1)}(\\d{1,4})$`).exec(w);
        if (!m) return null;
        shot = Number(m[1]);
      } else if (t === '{version}') {
        if (!/^v?\d{1,5}$/.test(w)) return null;
        out.number = Number(w.replace(/^v/, '')) || null;
      } else if (t === '{task}') out.task = w;
      else if (t === '{view}') out.view = w;
      else if (t !== w) return null;
    }
    if (!seq || shot == null) return null;
    out.entity = shotName(tokenize(seq), shot, presetId);
    return out;
  }
  // What a project's rules make of a file name: { entity, task, number, view, rule }, or null. Patterns
  // first, being the surer. Read by a word rule, a word of the name that is one of `tasks` is its task.
  function byRules(filename, rules = [], tasks = [], presetId) {
    const words = stemWords(filename);
    if (!words.length) return null;
    const list = [...(rules || [])].sort((a, b) => !!b.pattern - !!a.pattern);
    for (const rule of list) {
      if (rule.pattern) {
        const read = byPattern(words, rule, presetId);
        if (read) return { ...read, rule };
        continue;
      }
      let entity = null;
      if (rule.seq && rule.glued) {
        const m = new RegExp(`^${rule.word}(\\d{1,4})$`).exec(words[0]);
        if (m) entity = shotName(rule.seq, Number(m[1]), presetId);
      } else if (rule.seq) {
        if (words[0] === rule.word && /^\d{1,4}$/.test(words[1] || '')) entity = shotName(rule.seq, Number(words[1]), presetId);
      } else if (rule.name && words[0] === rule.word) entity = rule.name;
      if (entity) return { entity, task: words.slice(1).find((w) => (tasks || []).includes(w)) || null, number: null, view: null, rule };
    }
    return null;
  }
  // A rule as it is shown: the name it was learned from and what it was filed as ("NHMoc_CHAP01_010_cmp_v111
  // → chap01-0010 v111"), or "klo 010 → kilo-0010".
  const ruleText = (rule, presetId) => (rule.pattern ? `${rule.like} → ${rule.as}`
    : rule.seq ? `${rule.word}${rule.glued ? '' : ' '}010 → ${shotName(rule.seq, 10, presetId)}` : `${rule.word} → ${rule.name}`);

  // ---- a convention from a studio's own file names
  //
  // What a few file names say about how a studio names what it makes: the parts of each name (by `_` or
  // `.`), the version (v012, ver3) and what comes after it (a view), and the name first: a shot where it
  // ends in a number (kilo-0010, sq010-sh0040), its sequence before, with the same text between them in
  // most; otherwise an asset or a set, its prefix the word before its first dash when names share it.
  // A word every name starts with (a studio's or a show's code, NHMoc_) is no part of any name: such
  // names are read whole by the rules a project learns (see ruleFrom). Nothing is certain: what is found
  // is `convention` (a draft, as validate would take it, from `base` where names say nothing) and `notes`,
  // in words, of what was found and what was not.
  const SET_WORDS = new Set(['set', 'sets', 'loc', 'location', 'locations', 'lay']);
  const mostOf = (xs) => {
    const n = new Map();
    for (const x of xs) n.set(x, (n.get(x) || 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0] || [undefined, 0];
  };
  function guess(filenames, baseId) {
    const base = CONVENTIONS[baseId] || CONVENTIONS[DEFAULT];
    const notes = [];
    const stems = [...new Set((filenames || []).map((f) => String(f || '').trim().replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase()).filter(Boolean))].slice(0, 200);
    const draft = JSON.parse(JSON.stringify({ ...base, name: 'Our naming' }));
    if (!stems.length) return { convention: draft, notes: ['Paste a few file names, one a line'] };
    const count = (ch) => stems.reduce((n, x) => n + x.split(ch).length - 1, 0);
    const sep = count('.') > count('_') ? '.' : '_';
    const split = stems.map((x) => x.split(sep).filter(Boolean).map((t) => t.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean));
    // The version: a number, after a few letters or none, last or next to last.
    const marks = [];
    const after = [];
    const versionAt = split.map((tokens) => {
      for (const at of [tokens.length - 1, tokens.length - 2]) {
        const m = at > 0 && /^([a-z]{0,4})(\d{1,5})$/.exec(tokens[at]);
        if (m && (m[1] || at === tokens.length - 1)) {
          marks.push(m[1]);
          if (at === tokens.length - 2) after.push(tokens[at + 1]);
          return at;
        }
      }
      return -1;
    });
    const [version, marked] = mostOf(marks);
    if (version !== undefined) notes.push(`Versions are written ${version ? `${version}012` : 'as a bare number, 012'} (in ${marked} of ${stems.length})`);
    else notes.push('No version number found at the end of the names');
    const views = [...new Set(after.filter((w) => /^[a-z]{2,8}$/.test(w)))];
    if (views.length) notes.push(`After the version: ${views.join(', ')}. If those are views, turn views on in the project`);
    // A word they all start with names none of them.
    let skip = 0;
    while (stems.length > 1 && split.every((t) => t.length > skip + 1 && t[skip] === split[0][skip] && !/\d$/.test(t[skip]))) skip++;
    if (skip) notes.push(`Every name starts with ${split[0].slice(0, skip).join(sep)}: that names none of them. File one by hand and names like it are learned`);
    // A sequence and its shot may be parts of their own (chap01_010, ep2_sh010): one name here, written
    // with a dash. A shot with letters before its number goes with a sequence with a number of its own.
    const isApart = (t) => /[a-z]/.test(t[skip]) && t.length > skip + 1
      && (/^\d{2,6}$/.test(t[skip + 1]) || (/\d/.test(t[skip]) && /^[a-z]{1,4}\d{2,6}$/.test(t[skip + 1])));
    let apart = 0;
    const contexts = split.map((t, i) => {
      if (!(t.length > skip && (versionAt[i] < 0 || versionAt[i] > skip))) return null;
      if (isApart(t) && versionAt[i] !== skip + 1) {
        apart++;
        return `${t[skip]}-${t[skip + 1]}`;
      }
      return t[skip];
    }).filter(Boolean);
    if (apart) notes.push(`The sequence and the shot are parts of their own in ${apart === stems.length ? 'every name' : apart === 1 ? 'one name' : `${apart} names`} (${split.find(isApart).slice(skip, skip + 2).join(sep)}): file one by hand and names like it are learned`);
    // A word before a dash that several names share, or that a convention knows, is a prefix.
    const known = new Set(Object.values(CONVENTIONS).flatMap((c) => c.tiers.flatMap((t) => t.prefixes || [])));
    const firsts = contexts.filter((c) => c.includes('-')).map((c) => c.split('-')[0]);
    const prefixes = [...new Set(firsts)].filter((w) => !/\d/.test(w) && (known.has(w) || SET_WORDS.has(w) || firsts.filter((x) => x === w).length > 1));
    const shots = [];
    const things = [];
    for (const c of contexts) {
      const m = /^(.*?)(\d{2,6})$/.exec(c);
      if (m && !prefixes.includes(c.split('-')[0])) shots.push({ c, head: m[1], digits: m[2].length });
      else things.push(c);
    }
    const tiers = draft.tiers.map((t) => ({ ...t }));
    const tier = (id) => tiers.find((t) => t.id === id);
    if (shots.length) {
      const [digits] = mostOf(shots.map((x) => x.digits));
      const joins = shots.map((x) => (/^(.*[a-z0-9])(-[a-z]*)$/.exec(x.head) || [])[2]).filter(Boolean);
      const glued = shots.length - joins.length;
      const [join = '-'] = mostOf(joins);
      tier('shot').name = `{seq}${join}{shot:${digits}}`;
      tier('shot').examples = [...new Set(shots.filter((x) => x.head.endsWith(join) && x.digits === digits).map((x) => x.c))].slice(0, 3);
      notes.push(`Shots: ${tier('shot').examples.join(', ')}, the shot ${digits} digits${join !== '-' ? ` after ${join.slice(1)}` : ''}`);
      if (glued) notes.push(`${glued === 1 ? 'A shot runs' : `${glued} shots run`} on into ${glued === 1 ? 'its sequence' : 'their sequences'} (${shots.find((x) => !/-[a-z]*$/.test(x.head)).c}): the catalogue writes ${glued === 1 ? 'it' : 'them'} with a dash, and a rule learned when filing one reads the rest`);
    }
    const ofSets = prefixes.filter((w) => SET_WORDS.has(w));
    const ofAssets = prefixes.filter((w) => !SET_WORDS.has(w));
    for (const [id, list] of [['asset', ofAssets], ['set', ofSets]]) {
      if (!list.length) continue;
      Object.assign(tier(id), { name: '{prefix}-{what}', prefixes: list, examples: things.filter((c) => list.includes(c.split('-')[0])).slice(0, 2) });
      notes.push(`${tier(id).label}: ${list.map((w) => `${w}-`).join(', ')}`);
    }
    const bare = things.filter((c) => !prefixes.includes(c.split('-')[0]));
    if (bare.length) {
      notes.push(`No prefix found in ${bare.slice(0, 3).join(', ')}${bare.length > 3 ? '…' : ''}: names like ${bare.length === 1 ? 'it' : 'them'} are said by hand to be an asset or a set`);
      for (const id of ['asset', 'set']) if (!(id === 'asset' ? ofAssets : ofSets).length) delete tier(id).name;
    }
    for (const t of tiers) {
      if (!t.name) {
        delete t.prefixes;
        delete t.examples;
      } else if (!contexts.some((c) => new RegExp(`^${pieces(t.name).map((x, i) => (i % 2 === 0 ? esc(x) : x === '{prefix}' ? `(?:${t.prefixes.join('|')})` : '.+')).join('')}$`).test(c))) {
        notes.push(`No ${t.one}s among these: named as in the ${base.name}, ${compileTier(t).shape}`);
      }
    }
    // Tasks: the word after the name, where there is one before the version.
    const tasks = split.map((t, i) => {
      const at = skip + (isApart(t) ? 2 : 1);
      return versionAt[i] < 0 || versionAt[i] > at ? t[at] : null;
    }).filter((w) => w && /^[a-z][a-z-]{1,20}$/.test(w) && !views.includes(w));
    const found = [...new Set(tasks)];
    if (found.length) notes.push(`Tasks: ${found.join(', ')}`);
    const ok = validate({ ...draft, tiers, file: { sep, version: version === undefined ? 'v' : version }, tasks: [...new Set([...found, ...(base.tasks || [])])] });
    return { convention: ok.convention || draft, notes: ok.error ? [...notes, ok.error] : notes };
  }

  return {
    CONVENTIONS, PRESETS, DEFAULT, BUILT_IN, TIERS, TOKEN, VIEWS, compile, validate, guess, register, setConventions, conventions, setDefault, defaultId, preset, tokenize, tierOf, seqOf, parse, label,
    pad, shotName, shotNumber, sequence, nextShot, readLine, corrections, distance, nearMisses, ruleFrom, byRules, ruleText, ruleKey, PATTERN_TOKEN,
  };
});
