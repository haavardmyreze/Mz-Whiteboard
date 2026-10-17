'use strict';

// How a file's name is read for the catalogue. Nothing here is ever required: a name that says nothing
// (screenshoot_090126.png) is still filed, by hand. What a name does say only fills in the choices ahead
// of time. Used by the server and by the pages, so both read a name the same way.
//
// A project follows a preset. The one there is, Myreze's styleguide:
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

  const PRESETS = {
    // Each tier's `shape` says in words what its `test` checks (shown to people, and told to Claude).
    myreze: {
      name: 'Myreze styleguide',
      tiers: [
        { id: 'asset', label: 'Assets', one: 'asset', shape: 'char-, prop-, env-, veh- or fx- and then what it is (char-robot, prop-old-sword)', test: /^(char|prop|env|veh|fx)-[a-z0-9]+(?:-[a-z0-9]+)*$/, prefixes: ['char', 'prop', 'env', 'veh', 'fx'] },
        { id: 'set', label: 'Sets', one: 'set', shape: 'set- and then what it is (set-living-room)', test: /^set-[a-z0-9]+(?:-[a-z0-9]+)*$/, prefixes: ['set'] },
        { id: 'shot', label: 'Shots', one: 'shot', shape: '<sequence>-<shot>: the shot is always four digits, the sequence is free (kilo-0010, ch01-0020, ep2-intro-0100)', test: /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]{4}$/ },
      ],
      tasks: ['model', 'rig', 'lookdev', 'dressing', 'layout', 'anim', 'fx', 'lighting'],
      // Words people write for a prefix instead of it (character-robot), read as the prefix.
      aliases: { character: 'char', chr: 'char', props: 'prop', vehicle: 'veh', environment: 'env', effect: 'fx', effects: 'fx', vfx: 'fx' },
    },
  };
  const DEFAULT = 'myreze';
  const preset = (id) => PRESETS[id] || PRESETS[DEFAULT];
  const TIERS = ['asset', 'set', 'shot'];

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
  const seqOf = (name) => (/^([a-z0-9]+(?:-[a-z0-9]+)*)-\d+$/.exec(name || '') || [])[1] || null;

  // Whatever can be read from a file name: { entity, tier, task, descriptor, artist, hip, view }, each null
  // when the name does not say. `hip` is the number after v; nothing is made of it, since the catalogue
  // counts versions itself, but it is read so that the rest of the name is.
  function parse(filename, presetId) {
    const out = { entity: null, tier: null, task: null, descriptor: null, artist: null, hip: null, view: null };
    const stem = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().trim();
    if (!stem) return out;
    const tokens = stem.split('_').filter(Boolean);
    if (!tokens.length || !tokens.every((t) => TOKEN.test(t))) {
      // Not to the styleguide, but a version number may still be at its end ("robot final v3").
      const v = /(?:^|[^a-z0-9])v(\d{1,4})$/.exec(stem);
      if (v) out.hip = Number(v[1]);
      return out;
    }
    if (tokens.length > 2 && /^v\d{1,4}$/.test(tokens[tokens.length - 2]) && !/^v\d{1,4}$/.test(tokens[tokens.length - 1])) out.view = tokens.pop();
    const last = /^v(\d{1,4})$/.exec(tokens[tokens.length - 1]);
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
  const pad = (n) => String(Math.min(9999, Math.max(0, n))).padStart(4, '0');
  const shotNumber = (name) => {
    const m = /-(\d+)$/.exec(name || '');
    return m ? Number(m[1]) : null;
  };

  // The shots a sequence has, by number, and the step they go up in: the gap there is most often between
  // one and the next, the smaller of two as often (10 when they do not say).
  function sequence(names, seq) {
    const nums = [...new Set((names || []).filter((n) => seqOf(n) === seq && /-\d{4}$/.test(n)).map(shotNumber))].sort((a, b) => a - b);
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
  function nextShot(names, seq) {
    const { step, last } = sequence(names, seq);
    return `${seq}-${pad(Math.floor(last / step) * step + step)}`;
  }

  // What a line typed where a piece is filed says: which asset, set or shot, and any task, version number
  // and view after it ("kilo-0010 anim v12 bty"). A whole file name pasted in is read as a file name is.
  // A few short ways to say a shot, read against `ctx.seq` (the sequence being filed in): `20` is shot
  // 0020 of it, `+` its next shot (`kilo+` the next of kilo), and `.` whatever was filed last
  // (`ctx.last`). `task` is left undefined where the line does not say one, so that a task field keeps its
  // own; with `ctx.useTasks` false a line never says one. Words that are read as nothing are in `rest`.
  //   ctx: { presetId, names, tasks, views, seq, last: { entity, task }, useTasks, rules }
  function readLine(text, ctx = {}) {
    const out = { entity: null, task: undefined, number: null, view: null, short: null, rest: [] };
    const raw = String(text || '').trim();
    if (!raw) return out;
    const useTasks = ctx.useTasks !== false;
    const names = ctx.names || [];
    if (/_/.test(raw) && !/\s/.test(raw)) {
      const p = parse(raw, ctx.presetId);
      const ruled = !p.entity && byRules(raw, ctx.rules, ctx.tasks);
      if (p.entity || ruled) {
        out.entity = p.entity || ruled.entity;
        if (useTasks && (p.task || (ruled && ruled.task))) out.task = p.task || ruled.task;
        out.view = p.view;
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
        out.entity = nextShot([...names, ...(ctx.taken || [])], seq);
        out.short = `the next shot in ${seq}`;
      }
    } else if (/^\d{1,4}$/.test(first) && ctx.seq) {
      out.entity = `${ctx.seq}-${pad(Number(first))}`;
      out.short = `shot ${pad(Number(first))} of ${ctx.seq}`;
    } else out.entity = tokenize(first) || null;
    // A word after the name is a version number, a view or a task, by what it is. Any other word is more
    // of the name ("living room", "set living room") for as long as that makes it more of a name: not
    // once it is one the project has, and not when it would stop being to the styleguide.
    const views = [...new Set([...(ctx.views || []), ...VIEWS])];
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
    const short = /^(.+?)-(\d{1,3})$/.exec(n);
    if (short) add(`${short[1]}-${pad(Number(short[2]))}`);
    const glued = /^([a-z][a-z0-9-]*?[a-z])(\d{1,4})$/.exec(n);
    if (glued && names.some((o) => seqOf(o) === glued[1])) add(`${glued[1]}-${pad(Number(glued[2]))}`);
    const [head, ...tail] = n.split('-');
    if (p.aliases && p.aliases[head] && tail.length) add([p.aliases[head], ...tail].join('-'));
    if (!out.length) for (const tier of p.tiers) for (const prefix of tier.prefixes || []) add(`${prefix}-${n}`);
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
  // A file named some other way (another studio's KLO_010_anim_v3.mov) filed as kilo-0010 teaches that its
  // first word stands for a sequence: { word: 'klo', seq: 'kilo' }, and KLO_020 is then kilo-0020. One
  // filed as an asset or a set teaches that its first word is that one: { word: 'robot', name: 'char-robot' }.
  // Words that say nothing about what a file shows are never learned.
  const VAGUE = new Set(['screenshot', 'screen', 'shot', 'img', 'image', 'render', 'untitled', 'capture', 'export', 'final', 'comp', 'video',
    'movie', 'clip', 'frame', 'still', 'playblast', 'test', 'new', 'copy', 'scan', 'photo', 'dsc', 'pxl', 'vid', 'mov', 'output', 'out', 'preview', 'wip']);
  const stemWords = (filename) => String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // The rule a file teaches by being filed as `entity`, or null when it teaches none (its name says it
  // already, or says nothing that could be learned).
  function ruleFrom(filename, entity, presetId) {
    if (!entity || parse(filename, presetId).entity) return null;
    const [w0, w1] = stemWords(filename);
    if (!w0) return null;
    const seq = tierOf(entity, presetId) === 'shot' ? seqOf(entity) : null;
    if (seq) {
      const n = shotNumber(entity);
      if (/^\d+$/.test(w1 || '') && Number(w1) === n && /[a-z]/.test(w0) && !VAGUE.has(w0)) return { word: w0, seq };
      const glued = /^([a-z]+)(\d+)$/.exec(w0);
      if (glued && Number(glued[2]) === n && !VAGUE.has(glued[1])) return { word: glued[1], seq, glued: true };
      return null;
    }
    if (w0.length < 3 || /^\d+$/.test(w0) || VAGUE.has(w0)) return null;
    return { word: w0, name: entity };
  }
  // What a project's rules make of a file name: { entity, task, rule }, or null. A word of it that is one of
  // `tasks` is its task.
  function byRules(filename, rules = [], tasks = []) {
    const words = stemWords(filename);
    if (!words.length) return null;
    for (const rule of rules || []) {
      let entity = null;
      if (rule.seq && rule.glued) {
        const m = new RegExp(`^${rule.word}(\\d{1,4})$`).exec(words[0]);
        if (m) entity = `${rule.seq}-${pad(Number(m[1]))}`;
      } else if (rule.seq) {
        if (words[0] === rule.word && /^\d{1,4}$/.test(words[1] || '')) entity = `${rule.seq}-${pad(Number(words[1]))}`;
      } else if (rule.name && words[0] === rule.word) entity = rule.name;
      if (entity) return { entity, task: words.slice(1).find((w) => (tasks || []).includes(w)) || null, rule };
    }
    return null;
  }
  // A rule as it is shown: "klo 010 → kilo-0010".
  const ruleText = (rule) => (rule.seq ? `${rule.word}${rule.glued ? '' : ' '}010 → ${rule.seq}-0010` : `${rule.word} → ${rule.name}`);

  return {
    PRESETS, DEFAULT, TIERS, TOKEN, VIEWS, preset, tokenize, tierOf, seqOf, parse, label,
    pad, shotNumber, sequence, nextShot, readLine, corrections, distance, nearMisses, ruleFrom, byRules, ruleText,
  };
});
