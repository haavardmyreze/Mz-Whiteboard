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
  const klo = naming.ruleFrom('KLO_010_anim_v3.mov', 'kilo-0010');
  assert.deepEqual(klo, { word: 'klo', seq: 'kilo' });
  assert.deepEqual(naming.byRules('KLO_020_anim_v1.mov', [klo], TASKS), { entity: 'kilo-0020', task: 'anim', rule: klo });
  assert.equal(naming.byRules('XYZ_020.mov', [klo], TASKS), null);
  const glued = naming.ruleFrom('klo010.mov', 'kilo-0010');
  assert.deepEqual(glued, { word: 'klo', seq: 'kilo', glued: true });
  assert.equal(naming.byRules('klo030_v2.mov', [glued]).entity, 'kilo-0030');
  assert.deepEqual(naming.ruleFrom('Robot_turntable.mov', 'char-robot'), { word: 'robot', name: 'char-robot' });
  assert.equal(naming.ruleFrom('screenshot_090126.png', 'char-robot'), null);
  // A name to the styleguide needs no rule.
  assert.equal(naming.ruleFrom('kilo-0010_anim_v3.mov', 'kilo-0010'), null);
  assert.equal(naming.ruleText(klo), 'klo 010 → kilo-0010');
  // A pasted name is read by the rules too.
  assert.equal(naming.readLine('KLO_070_anim_v1.mov', { rules: [klo], tasks: TASKS }).entity, 'kilo-0070');
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
