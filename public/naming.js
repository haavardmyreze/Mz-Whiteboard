'use strict';

// How names are written in the catalogue, and how a file's name is read for it. Used by the server and by
// the pages, so both read a name the same way. Nothing here is ever required: a name that says nothing
// (screenshot_090126.png) is still filed, by hand, and what a name does say only fills in the choices
// ahead of time.
//
// Every project is made of the same things, written one way:
//   Assets and sets, named in plain words: lower case, words joined by `-` (char-robot, harbour). What
//   each is, asset or set, is said when it is made; a new name is guessed to be what the project's names
//   that start with the same word are (char-dog is an asset where char-robot is one).
//   Sequences, each a run of shots: a shot is <sequence>-<four digits> (kilo-0010, ch01-0020), and its
//   sequence is everything before the number.
// A file's name is read by how the app writes names: <name>[_<task>][_<descriptor>][_<artist>]_v###[_<view>]
// (kilo-0010_anim_erik_v012_bty.mov), the name first, `_` between the parts. The name counts only when it
// is a shot, one the project has, or one its kind can be guessed for. A file named any other way is
// filed by hand once, and the project learns how names like it read (see "names from elsewhere" below).
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.WBNaming = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const TIERS = ['asset', 'set', 'shot'];
  const TIER_LIST = [
    { id: 'asset', label: 'Assets', one: 'asset' },
    { id: 'set', label: 'Sets', one: 'set' },
    { id: 'shot', label: 'Shots', one: 'shot' },
  ];
  // The tasks offered before a project has any of its own.
  const TASKS = ['model', 'rig', 'lookdev', 'dressing', 'layout', 'anim', 'fx', 'lighting', 'comp'];
  // How many digits a shot's number has.
  const DIGITS = 4;
  const SHOT = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{4})$/;

  // A name as a token: lower case, words joined by `-`. "Living Room" -> "living-room".
  function tokenize(text) {
    return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  }

  // 'shot' for a name with a shot's shape, else null: whether a name is an asset or a set is not in it.
  const tierOf = (name) => (SHOT.test(String(name || '')) ? 'shot' : null);
  // What a name is: a shot by its shape, else one of `entities` ([{ name, tier }], the project's) by
  // name, else what most of those whose name starts with the same word are (char-dog an asset, where
  // char-robot is one); null when nothing says.
  function kindOf(name, entities = []) {
    const n = String(name || '');
    if (tierOf(n)) return 'shot';
    const own = entities.find((e) => e.name === n);
    if (own) return own.tier;
    const head = n.split('-')[0];
    if (!head || head === n) return null;
    const count = new Map();
    for (const e of entities) if (e.tier !== 'shot' && e.name.startsWith(`${head}-`)) count.set(e.tier, (count.get(e.tier) || 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  // The sequence a shot is in: everything before its number ("kilo" for kilo-0010, "ch01" for
  // ch01-0010). Asked only of shots, so a shot named by hand with a shorter number (ab-12) still has one.
  const seqOf = (name) => (/^([a-z0-9]+(?:-[a-z0-9]+)*)-\d+$/.exec(name || '') || [])[1] || null;
  // Sequences in the order a project gives them (its settings' `seqs`: kine, haus, elec), and any it does
  // not list after them, as their names sort (chap2 before chap10). Without an order, by name.
  const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  function seqOrder(order) {
    const at = new Map((order || []).map((q, i) => [q, i]));
    const rank = (q) => (at.has(q) ? at.get(q) : Infinity);
    return (a, b) => rank(a) - rank(b) || natural(a, b);
  }
  // Names of shots in the order of their sequences, and within one by number; anything else after them.
  function shotOrder(order) {
    const bySeq = seqOrder(order);
    return (a, b) => {
      const [sa, sb] = [seqOf(a), seqOf(b)];
      if (sa && sb && sa !== sb) return bySeq(sa, sb);
      if (!sa !== !sb) return sa ? -1 : 1;
      return natural(a, b);
    };
  }
  // A shot's number written out (0010), the shot of a sequence by its number (kilo-0010), and a shot's number.
  const pad = (n) => String(Math.min(10 ** DIGITS - 1, Math.max(0, n))).padStart(DIGITS, '0');
  const shotName = (seq, n) => `${seq}-${pad(n)}`;
  const shotNumber = (name) => {
    const m = /-(\d+)$/.exec(name || '');
    return m ? Number(m[1]) : null;
  };

  // Whatever can be read from a file name: { entity, tier, task, descriptor, artist, hip, view }, each null
  // when the name does not say. `hip` is the number after v: the version it is filed as, unless another
  // is said (otherwise the catalogue counts on from the last). `entities` are the project's ([{ name, tier }]):
  // a first part that is none of them, and whose kind they do not say, is not taken for a name.
  function parse(filename, entities = []) {
    const out = { entity: null, tier: null, task: null, descriptor: null, artist: null, hip: null, view: null };
    const stem = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().trim();
    if (!stem) return out;
    const mark = /^v(\d{1,4})$/;
    const tokens = stem.split('_').filter(Boolean);
    if (!tokens.length || !tokens.every((t) => TOKEN.test(t))) {
      // Not written as the app writes names, but a version number may still be at its end ("robot final v3").
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
    const tier = kindOf(tokens[0], entities);
    if (!tier) return out;
    out.entity = tokens[0];
    out.tier = tier;
    const middle = tokens.slice(1);
    if (last && middle.length >= 2) {
      out.task = middle[0];
      out.artist = middle[middle.length - 1];
      if (middle.length > 2) out.descriptor = middle.slice(1, -1).join('_');
    } else if (middle.length === 1) {
      // One word between the name and the version: a task if it is one, otherwise whoever made it.
      if (!last || TASKS.includes(middle[0])) out.task = middle[0];
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
  function sequence(names, seq) {
    const nums = [...new Set((names || []).filter((n) => tierOf(n) && seqOf(n) === seq).map(shotNumber))].sort((a, b) => a - b);
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
    return shotName(seq, Math.floor(last / step) * step + step);
  }

  // What a line typed where a piece is filed says: which asset, set or shot, and any task, version number
  // and view after it ("kilo-0010 anim v12 bty"). A whole file name pasted in is read as a file name is.
  // A few short ways to say a shot, read against `ctx.seq` (the sequence being filed in): `20` is shot
  // 0020 of it, `+` its next shot (`kilo+` the next of kilo), and `.` whatever was filed last
  // (`ctx.last`). `task` is left undefined where the line does not say one, so that a task field keeps its
  // own; with `ctx.useTasks` false a line never says one. Words that are read as nothing are in `rest`.
  //   ctx: { names, entities, tasks, views, useViews, seq, last: { entity, task }, useTasks, rules }
  function readLine(text, ctx = {}) {
    const out = { entity: null, task: undefined, number: null, view: null, short: null, rest: [] };
    const raw = String(text || '').trim();
    if (!raw) return out;
    const useTasks = ctx.useTasks !== false;
    const names = ctx.names || [];
    if (raw.includes('_') && !/\s/.test(raw)) {
      const p = parse(raw, ctx.entities || names.map((name) => ({ name, tier: tierOf(name) || 'asset' })));
      const ruled = !p.entity && byRules(raw, ctx.rules, ctx.tasks);
      if (p.entity || ruled) {
        out.entity = p.entity || ruled.entity;
        if (useTasks && (p.task || (ruled && ruled.task))) out.task = p.task || ruled.task;
        out.view = ctx.useViews === false ? null : p.view || (ruled && ruled.view) || null;
        out.number = (ruled ? ruled.number : p.hip) || null;
        if (ruled) out.short = 'read as names like it are';
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
    } else if (/^\d+$/.test(first) && first.length <= DIGITS && ctx.seq) {
      out.entity = shotName(ctx.seq, Number(first));
      out.short = `shot ${pad(Number(first))} of ${ctx.seq}`;
    } else out.entity = tokenize(first) || null;
    // A word after the name is a version number, a view or a task, by what it is. Any other word is more
    // of the name ("living room", "set living room") for as long as that makes it more of a name: not
    // once it is one the project has, or a shot.
    // The project's views when it says them (`ctx.views`, the main one first), none when it shows each
    // version one way (`ctx.useViews` false), and the usual ones otherwise.
    const views = ctx.useViews === false ? [] : ctx.views && ctx.views.length ? ctx.views : VIEWS;
    const tasks = ctx.tasks || [];
    const whole = () => !!out.entity && (names.includes(out.entity) || !!tierOf(out.entity));
    const longer = (t) => {
      const joined = tokenize(`${out.entity}-${t}`);
      return names.includes(joined) || (!names.includes(out.entity) && !whole());
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

  // Shots a name not written as one may have been meant as, each { name, tier: 'shot' }: one with a short
  // number (kilo-10 is kilo-0010), or a number run on to a sequence the project has (kilo10).
  function corrections(typed, names = []) {
    const n = tokenize(typed);
    if (!n || tierOf(n)) return [];
    const out = [];
    const add = (name) => { if (tierOf(name) && !out.some((o) => o.name === name)) out.push({ name, tier: 'shot' }); };
    const short = /^(.+?)-(\d{1,3})$/.exec(n);
    if (short) add(shotName(short[1], Number(short[2])));
    const glued = /^([a-z][a-z0-9-]*?[a-z])(\d{1,4})$/.exec(n);
    if (glued && names.some((o) => seqOf(o) === glued[1])) add(shotName(glued[1], Number(glued[2])));
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
  function patternFrom(filename, filed) {
    const { entity, task = null, number = null, view = null, views = [] } = filed;
    if (tierOf(entity) !== 'shot') return null;
    const words = stemWords(filename);
    const seq = seqOf(entity);
    const n = shotNumber(entity);
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
  // views }, or just the entity's name), or null when it teaches none (its name says it already, as the
  // app writes it, or says nothing that could be learned).
  function ruleFrom(filename, filed) {
    const f = typeof filed === 'string' ? { entity: filed } : filed || {};
    const entity = f.entity;
    if (!entity || parse(filename, [{ name: entity, tier: tierOf(entity) || 'asset' }]).entity) return null;
    const whole = patternFrom(filename, f);
    if (whole) return whole;
    const [w0, w1] = stemWords(filename);
    if (!w0) return null;
    const seq = tierOf(entity) === 'shot' ? seqOf(entity) : null;
    if (seq) {
      const n = shotNumber(entity);
      if (/^\d+$/.test(w1 || '') && Number(w1) === n && /[a-z]/.test(w0) && !VAGUE.has(w0)) return { word: w0, seq };
      const glued = /^([a-z]+)(\d+)$/.exec(w0);
      if (glued && Number(glued[2]) === n && !VAGUE.has(glued[1])) return { word: glued[1], seq, glued: true };
      return null;
    }
    // A word the name only starts with (char, of char-dog) is no word for one asset: others share it.
    if (w0.length < 3 || /^\d+$/.test(w0) || VAGUE.has(w0) || entity.startsWith(`${w0}-`)) return null;
    return { word: w0, name: entity };
  }
  // A rule's key: two rules with the same are the same rule.
  const ruleKey = (rule) => (rule.pattern ? `p:${rule.pattern.join('_')}:${JSON.stringify(rule.seqs || {})}` : `w:${rule.word}`);

  // What a name reads as by a pattern: { entity, task, number, view }, or null when it is not one like it.
  function byPattern(words, rule) {
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
    out.entity = shotName(tokenize(seq), shot);
    return out;
  }
  // What a project's rules make of a file name: { entity, task, number, view, rule }, or null. Patterns
  // first, being the surer. Read by a word rule, a word of the name that is one of `tasks` is its task.
  function byRules(filename, rules = [], tasks = []) {
    const words = stemWords(filename);
    if (!words.length) return null;
    const list = [...(rules || [])].sort((a, b) => !!b.pattern - !!a.pattern);
    for (const rule of list) {
      if (rule.pattern) {
        const read = byPattern(words, rule);
        if (read) return { ...read, rule };
        continue;
      }
      let entity = null;
      if (rule.seq && rule.glued) {
        const m = new RegExp(`^${rule.word}(\\d{1,4})$`).exec(words[0]);
        if (m) entity = shotName(rule.seq, Number(m[1]));
      } else if (rule.seq) {
        if (words[0] === rule.word && /^\d{1,4}$/.test(words[1] || '')) entity = shotName(rule.seq, Number(words[1]));
      } else if (rule.name && words[0] === rule.word) entity = rule.name;
      if (entity) return { entity, task: words.slice(1).find((w) => (tasks || []).includes(w)) || null, number: null, view: null, rule };
    }
    return null;
  }
  // A rule as it is shown: the name it was learned from and what it was filed as ("NHMoc_CHAP01_010_cmp_v111
  // → chap01-0010 v111"), or "klo 010 → kilo-0010".
  const ruleText = (rule) => (rule.pattern ? `${rule.like} → ${rule.as}`
    : rule.seq ? `${rule.word}${rule.glued ? '' : ' '}010 → ${shotName(rule.seq, 10)}` : `${rule.word} → ${rule.name}`);

  return {
    TIERS, TIER_LIST, TASKS, TOKEN, VIEWS, DIGITS, tokenize, tierOf, kindOf, seqOf, seqOrder, shotOrder, parse, label,
    pad, shotName, shotNumber, sequence, nextShot, readLine, corrections, distance, nearMisses, ruleFrom, byRules, ruleText, ruleKey, PATTERN_TOKEN,
  };
});
