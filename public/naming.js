'use strict';

// How a file's name is read for the catalogue. Nothing here is ever required: a name that says nothing
// (screenshoot_090126.png) is still filed, by hand. What a name does say only fills in the choices ahead
// of time. Used by the server and by the pages, so both read a name the same way.
//
// A project follows a preset. The one there is, Myreze's styleguide:
//   `_` separates tokens, `-` joins words inside a token, all lowercase.
//   An asset is char-, prop-, env-, veh- or fx- something (char-robot), a set is set- something
//   (set-living-room), a shot is <sequence>-<number> (kilo-0010).
//   A Houdini file is <context>_<task>[_<descriptor>]_<artist>_v###: the context first (its shape says
//   what tier it is), then the task, the version last, the artist before it, and anything between is
//   the descriptor. Review media is taken to be named the same way (kilo-0010_anim_erik_v012.mov).
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.WBNaming = make();
})(typeof self !== 'undefined' ? self : this, () => {
  const TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  const PRESETS = {
    myreze: {
      name: 'Myreze styleguide',
      tiers: [
        { id: 'asset', label: 'Assets', one: 'asset', test: /^(char|prop|env|veh|fx)-[a-z0-9]+(?:-[a-z0-9]+)*$/ },
        { id: 'set', label: 'Sets', one: 'set', test: /^set-[a-z0-9]+(?:-[a-z0-9]+)*$/ },
        { id: 'shot', label: 'Shots', one: 'shot', test: /^[a-z]{3,5}-[0-9]{4}$/ },
      ],
      tasks: ['model', 'rig', 'lookdev', 'dressing', 'layout', 'anim', 'fx', 'lighting'],
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

  // The sequence a shot is in: "kilo" for kilo-0010. Asked only of shots, so it is looser than the
  // preset's test for one: a shot named by hand (ab-12) still has a sequence, the part before its number.
  const seqOf = (name) => (/^([a-z][a-z0-9]*)-\d+$/.exec(name || '') || [])[1] || null;

  // Whatever can be read from a file name: { entity, tier, task, descriptor, artist, hip }, each null
  // when the name does not say. `hip` is the number after v; nothing is made of it, since the catalogue
  // counts versions itself, but it is read so that the rest of the name is.
  function parse(filename, presetId) {
    const out = { entity: null, tier: null, task: null, descriptor: null, artist: null, hip: null };
    const stem = String(filename || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').toLowerCase().trim();
    if (!stem) return out;
    const tokens = stem.split('_').filter(Boolean);
    if (!tokens.length || !tokens.every((t) => TOKEN.test(t))) {
      // Not to the styleguide, but a version number may still be at its end ("robot final v3").
      const v = /(?:^|[^a-z0-9])v(\d{1,4})$/.exec(stem);
      if (v) out.hip = Number(v[1]);
      return out;
    }
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

  // Suggestions for "which asset, set or shot", as a name is typed: the project's own that start with it,
  // then those that hold it, each with what it is and how many versions it has; and for a name the
  // project does not have, the way to make it. For a text box's list of suggestions (WB.combo).
  function suggest(entities, typed, presetId, max = 8) {
    const q = String(typed || '').trim().toLowerCase();
    const name = tokenize(typed);
    const starts = [];
    const holds = [];
    for (const e of entities || []) {
      if (!q || e.name.startsWith(q)) starts.push(e);
      else if (e.name.includes(q)) holds.push(e);
    }
    const out = [...starts, ...holds].slice(0, max).map((e) => ({
      value: e.name, label: e.name, thumb: e.thumb || null,
      hint: `${e.tier}${e.versions ? ` · ${e.versions} version${e.versions === 1 ? '' : 's'}` : ''}`,
    }));
    if (name && !(entities || []).some((e) => e.name === name)) out.push({ value: name, label: `New: ${name}`, hint: tierOf(name, presetId) || 'say what it is', make: true });
    return out;
  }

  // What a version is called wherever it is shown: "kilo-0010 anim v5".
  function label(entity, task, number) {
    return [entity, task, `v${number}`].filter(Boolean).join(' ');
  }

  return { PRESETS, DEFAULT, TIERS, TOKEN, preset, tokenize, tierOf, seqOf, parse, label, suggest };
});
