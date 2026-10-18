'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const naming = require('../public/naming');
const likely = require('../likely');

const NAMES = ['kilo-0010', 'kilo-0020', 'kilo-0030', 'char-robot', 'set-living-room', 'ch01-0010'];
const TASKS = ['model', 'rig', 'lookdev', 'dressing', 'layout', 'anim', 'fx', 'lighting'];
const read = (text, ctx = {}) => {
  const { short, rest, ...out } = naming.readLine(text, { names: NAMES, tasks: TASKS, ...ctx });
  return { ...out, ...(short && { short }), ...(rest.length && { rest }) };
};

test('filing: a typed line says the name, and the task, version and view after it', () => {
  assert.deepEqual(read('kilo-0010 anim v12 bty'), { entity: 'kilo-0010', task: 'anim', number: 12, view: 'bty' });
  assert.deepEqual(read('kilo-0010'), { entity: 'kilo-0010', task: undefined, number: null, view: null });
  // A number after a whole name is its version; anything else after one is a task, new or not.
  assert.equal(read('kilo-0010 12').number, 12);
  assert.equal(read('kilo-0010 turntable').task, 'turntable');
  assert.equal(read('char-robot turntable').entity, 'char-robot');
  // Until the name is one, more words are more of it.
  assert.deepEqual(read('Living Room anim'), { entity: 'living-room', task: 'anim', number: null, view: null });
  assert.deepEqual(read('set living room dressing'), { entity: 'set-living-room', task: 'dressing', number: null, view: null });
  assert.equal(read('char robot rig').entity, 'char-robot');
  // A file name pasted in is read as a file name is.
  assert.deepEqual(read('kilo-0010_anim_erik_v012_bty.mov'), { entity: 'kilo-0010', task: 'anim', number: null, view: 'bty' });
  // A project that does not count by task never reads one, and says what it did not read.
  assert.deepEqual(read('kilo-0010 anim', { useTasks: false }), { entity: 'kilo-0010', task: undefined, number: null, view: null, rest: ['anim'] });
});

test('filing: a shot can be said short, by the sequence it is filed in', () => {
  assert.deepEqual(read('20 anim', { seq: 'kilo' }), { entity: 'kilo-0020', task: 'anim', number: null, view: null, short: 'shot 0020 of kilo' });
  assert.equal(read('+', { seq: 'kilo' }).entity, 'kilo-0040');
  // The rows above count too: two pluses in a row are two new shots.
  assert.equal(read('+', { seq: 'kilo', taken: ['kilo-0040'] }).entity, 'kilo-0050');
  assert.equal(read('ch01+').entity, 'ch01-0020');
  assert.equal(read('newseq+').entity, 'newseq-0010');
  assert.deepEqual(read('.', { last: { entity: 'char-robot', task: 'rig' } }), { entity: 'char-robot', task: 'rig', number: null, view: null, short: 'the same as the last' });
  // Without a sequence to go by, a number is only a name.
  assert.equal(read('20').entity, '20');
  // A sequence goes up in its own step.
  assert.equal(naming.nextShot(['a-0010', 'a-0015', 'a-0020', 'a-0025'], 'a'), 'a-0030');
  assert.equal(naming.nextShot(['a-0100', 'a-0200', 'a-0250'], 'a'), 'a-0300');
  // As often one gap as another: the finer.
  assert.equal(naming.nextShot(['kilo-0010', 'kilo-0020', 'kilo-0040'], 'kilo'), 'kilo-0050');
  assert.equal(naming.nextShot(['b-0020', 'b-0040', 'b-0060', 'b-0070'], 'b'), 'b-0080');
});

test('filing: a name not to the styleguide is offered as one that is, and a near miss as the one meant', () => {
  assert.deepEqual(naming.corrections('kilo-10'), [{ name: 'kilo-0010', tier: 'shot' }]);
  assert.deepEqual(naming.corrections('kilo10', undefined, NAMES), [{ name: 'kilo-0010', tier: 'shot' }]);
  assert.deepEqual(naming.corrections('character-robot'), [{ name: 'char-robot', tier: 'asset' }]);
  assert.deepEqual(naming.corrections('robot').map((c) => c.name), ['char-robot', 'prop-robot', 'env-robot', 'veh-robot', 'fx-robot', 'set-robot']);
  assert.deepEqual(naming.corrections('kilo-0010'), []);
  assert.deepEqual(naming.nearMisses('kilo-010', NAMES), ['kilo-0010']);
  assert.deepEqual(naming.nearMisses('klio-0010', NAMES), ['kilo-0010']);
  assert.deepEqual(naming.nearMisses('char-robto', NAMES), ['char-robot']);
  // Names that differ only in their numbers are many on purpose.
  assert.deepEqual(naming.nearMisses('kilo-0040', NAMES), []);
  assert.deepEqual(naming.nearMisses('prop-sword-02', ['prop-sword-01']), []);
});

test('filing: a file named some other way teaches how such names are read, and words that say nothing teach nothing', () => {
  // A sequence named otherwise there: learned as a pattern known by that name.
  const klo = naming.ruleFrom('KLO_010_anim_v3.mov', 'kilo-0010');
  assert.deepEqual(klo.seqs, { klo: 'kilo' });
  assert.equal(naming.byRules('KLO_020_anim_v1.mov', [klo], TASKS).entity, 'kilo-0020');
  // Rules learned before patterns still read: the first word as a sequence, run on or not, or as one asset.
  const word = { word: 'klo', seq: 'kilo' };
  assert.deepEqual(naming.byRules('KLO_020_anim_v1.mov', [word], TASKS), { entity: 'kilo-0020', task: 'anim', number: null, view: null, rule: word });
  assert.equal(naming.byRules('XYZ_020.mov', [word], TASKS), null);
  const glued = naming.ruleFrom('klo010.mov', 'kilo-0010');
  assert.deepEqual(glued, { word: 'klo', seq: 'kilo', glued: true });
  assert.equal(naming.byRules('klo030_v2.mov', [glued]).entity, 'kilo-0030');
  assert.deepEqual(naming.ruleFrom('Robot_turntable.mov', 'char-robot'), { word: 'robot', name: 'char-robot' });
  assert.equal(naming.ruleFrom('screenshot_090126.png', 'char-robot'), null);
  // A name to the styleguide needs no rule.
  assert.equal(naming.ruleFrom('kilo-0010_anim_v3.mov', 'kilo-0010'), null);
  assert.equal(naming.ruleText(word), 'klo 010 → kilo-0010');
  // A pasted name is read by the rules too.
  assert.equal(naming.readLine('KLO_070_anim_v1.mov', { rules: [word], tasks: TASKS }).entity, 'kilo-0070');
});

test('filing: a whole name filed by hand teaches its pattern: the sequence, shot, version and view each in its place', () => {
  const rule = naming.ruleFrom('NHMoc_CHAP01_010_cmp_v111.mp4', { entity: 'chap01-0010', task: null, number: 111, view: null, views: ['cmp', 'bty'] });
  assert.deepEqual(rule.pattern, ['nhmoc', '{seq}', '{shot}', '{view}', '{version}']);
  assert.equal(naming.ruleText(rule), 'NHMoc_CHAP01_010_cmp_v111 → chap01-0010 v111');
  const read = (name) => {
    const r = naming.byRules(name, [rule]);
    return r && { entity: r.entity, number: r.number, view: r.view };
  };
  assert.deepEqual(read('NHMoc_CHAP03_040_cmp_v009.mp4'), { entity: 'chap03-0040', number: 9, view: 'cmp' });
  assert.deepEqual(read('NHMoc_CHAP03_040_bty_v009.mp4'), { entity: 'chap03-0040', number: 9, view: 'bty' });
  // Not one like it: another studio's word, or another shape.
  assert.equal(read('Other_CHAP03_040_cmp_v009.mp4'), null);
  assert.equal(read('NHMoc_CHAP03_040_v009.mp4'), null);
  // Without views, the word where the view was is anything; a shot's number may run on after letters.
  const plain = naming.ruleFrom('ABC_ep2_sh010_comp_erik_v004.mov', { entity: 'ep2-0010', task: 'comp', number: 4 });
  assert.deepEqual(plain.pattern, ['abc', '{seq}', '{shot:sh}', '{task}', '*', '{version}']);
  assert.deepEqual(naming.byRules('ABC_ep3_sh120_lighting_anna_v011.mov', [plain]), { entity: 'ep3-0120', task: 'lighting', number: 11, view: null, rule: plain });
  // A sequence named otherwise there is kept as such; with no word of its own, the pattern is known by it alone.
  const klo = naming.ruleFrom('KLO_010_anim_v3.mov', { entity: 'kilo-0010', task: 'anim', number: 3 });
  assert.deepEqual(klo.seqs, { klo: 'kilo' });
  assert.equal(naming.byRules('KLO_020_anim_v7.mov', [klo]).entity, 'kilo-0020');
  assert.equal(naming.byRules('ABC_020_anim_v1.mov', [klo]), null);
  // A pasted name is read by it, number and all.
  const line = naming.readLine('NHMoc_CHAP02_030_cmp_v004', { rules: [rule], views: ['cmp', 'bty'] });
  assert.deepEqual([line.entity, line.number, line.view], ['chap02-0030', 4, 'cmp']);
  // Patterns go before the first-word rules, being surer.
  assert.equal(naming.byRules('NHMoc_CHAP03_040_cmp_v009.mp4', [{ word: 'nhmoc', name: 'char-robot' }, rule]).entity, 'chap03-0040');
});

// A colour strip as likely.js reads it: COLS columns of top and bottom RGB, from a brightness at each moment.
const stripOf = (bright) => Buffer.from(Array.from({ length: 512 }, (_, i) => {
  const v = Math.round(bright(i / 512));
  return [v, v, v, v, v, v];
}).flat()).toString('base64');

test('filing: a video is most like the version it is as long as, at the same rate, with the same picture', () => {
  const wave = stripOf((t) => 128 + 100 * Math.sin(t * 20));
  const other = stripOf((t) => 128 + 100 * Math.cos(t * 7));
  const heads = [
    { id: 'a', entityId: 'shot-a', task: 'anim', number: 3, look: { type: 'video', dur: 4, fps: 24, nw: 320, nh: 180, wf: { c: wave } } },
    { id: 'b', entityId: 'shot-b', task: 'anim', number: 1, look: { type: 'video', dur: 4, fps: 24, nw: 320, nh: 180, wf: { c: other } } },
    { id: 'c', entityId: 'shot-c', task: null, number: 2, look: { type: 'video', dur: 9, fps: 25, nw: 1920, nh: 1080, wf: { c: wave } } },
    { id: 'd', entityId: 'robot', task: 'model', number: 1, look: { type: 'image', nw: 320, nh: 180 } },
  ];
  const stripFor = (v) => likely.strip(v.look.wf && v.look.wf.c);
  const found = likely.likelyFor({ type: 'video', dur: 4.02, fps: 24, nw: 320, nh: 180, wf: wave }, heads, stripFor);
  assert.equal(found[0].head.id, 'a');
  assert.deepEqual(found[0].why, ['same length', 'looks alike']);
  assert.ok(found[0].score > 0.9);
  // The same length with another picture is less like it; another length and rate is not suggested at all.
  assert.ok(!found[1] || found[1].score < found[0].score - 0.2);
  assert.ok(!found.some((f) => f.head.id === 'c' || f.head.id === 'd'));
  // Images are not matched, nor a strip that is not one.
  assert.deepEqual(likely.likelyFor({ type: 'image', nw: 320, nh: 180 }, heads, stripFor), []);
  assert.equal(likely.strip('bm90IGEgc3RyaXA='), null);
});

test('naming: a convention is data, and names are read by its templates, not by Myreze’s', () => {
  // Myreze's, compiled, says what it always did.
  const m = naming.preset('myreze');
  assert.equal(m.tiers[0].shape, 'char-, prop-, env-, veh- or fx- and then what it is (char-robot, prop-old-sword)');
  assert.equal(m.tiers[2].shape, '<sequence>-<shot>: the shot is always four digits, the sequence is free (kilo-0010, ch01-0020, ep2-intro-0100)');
  // Another studio's: chr-/prp- assets, loc- sets, sq010-sh040 shots of three digits, files read.by.dots.ver003.
  naming.PRESETS.other = naming.compile({
    name: 'Other',
    tiers: [
      { id: 'asset', label: 'Assets', one: 'asset', name: '{prefix}-{what}', prefixes: ['chr', 'prp'] },
      { id: 'set', label: 'Sets', one: 'set', name: 'loc-{what}', examples: ['loc-harbour'] },
      { id: 'shot', label: 'Shots', one: 'shot', name: 'sq{seq}-sh{shot:3}', examples: ['sq010-sh040'] },
    ],
    file: { sep: '.', version: 'ver' },
    tasks: ['comp'],
  });
  try {
    const o = 'other';
    assert.deepEqual(['chr-robot', 'loc-harbour', 'sq010-sh040', 'kilo-0010', 'char-robot'].map((n) => naming.tierOf(n, o)), ['asset', 'set', 'shot', null, null]);
    assert.equal(naming.preset(o).tiers[1].shape, 'loc-<what it is> (loc-harbour)');
    assert.equal(naming.preset(o).tiers[2].shape, 'sq<sequence>-sh<shot>: the shot is always three digits, the sequence is free (sq010-sh040)');
    assert.equal(naming.seqOf('sq010-sh040', o), '010');
    assert.equal(naming.shotNumber('sq010-sh040', o), 40);
    assert.equal(naming.nextShot(['sq010-sh010', 'sq010-sh020'], '010', o), 'sq010-sh030');
    assert.equal(naming.readLine('20', { presetId: o, seq: '010' }).entity, 'sq010-sh020');
    assert.deepEqual(naming.corrections('sq010-sh40', o), [{ name: 'sq010-sh040', tier: 'shot' }]);
    assert.deepEqual(naming.corrections('robot', o).map((c) => c.name), ['chr-robot', 'prp-robot', 'loc-robot']);
    const p = naming.parse('sq010-sh040.comp.erik.ver003.mov', o);
    assert.deepEqual([p.entity, p.tier, p.task, p.artist, p.hip], ['sq010-sh040', 'shot', 'comp', 'erik', 3]);
    assert.equal(naming.byRules('KLO_020.mov', [{ word: 'klo', seq: '010' }], [], o).entity, 'sq010-sh020');
  } finally {
    delete naming.PRESETS.other;
  }
});
