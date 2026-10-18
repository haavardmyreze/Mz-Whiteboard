'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAi, DEFAULT_MODEL } = require('../ai');

// Claude stood in for: each test says what it answers, and sees what was asked.
function fakeClaude(answer, { status = 200, stop = 'tool_use' } = {}) {
  const asked = [];
  const fetchImpl = async (url, options) => {
    asked.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const tool = JSON.parse(options.body).tool_choice.name;
    const body = status === 200
      ? { stop_reason: stop, content: answer === null ? [{ type: 'text', text: 'hm' }] : [{ type: 'tool_use', name: tool, input: answer }] }
      : { type: 'error', error: { message: 'nope' } };
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { asked, fetchImpl };
}

const ENTITIES = [{ id: 'e1', name: 'kilo-0010', tier: 'shot' }, { id: 'e2', name: 'char-robot', tier: 'asset' }];

test('ai: off without a key, and says so', async () => {
  const ai = createAi({ key: '' });
  assert.equal(ai.enabled, false);
  await assert.rejects(ai.fileNames({ files: [{ key: '0', filename: 'a.mov' }] }), (err) => err.status === 503);
});

test('ai: asks Claude with the key, the model, the rules and the files, and must be answered by the tool', async () => {
  const claude = fakeClaude({ files: [] });
  const ai = createAi({ key: 'sk-test', base: 'http://claude.local/', fetchImpl: claude.fetchImpl });
  assert.equal(ai.model, DEFAULT_MODEL);
  await ai.fileNames({ instruction: 'These are all shots of ch02', files: [{ key: '0', filename: 'Robot walk FINAL v3.mov', now: { entity: 'robot-walk', view: 'cmp' } }], entities: ENTITIES, tasks: ['anim'], views: ['cmp', 'bty'] });
  const [q] = claude.asked;
  assert.equal(q.url, 'http://claude.local/v1/messages');
  assert.equal(q.headers['x-api-key'], 'sk-test');
  assert.ok(q.headers['anthropic-version']);
  assert.equal(q.body.model, DEFAULT_MODEL);
  assert.deepEqual(q.body.tool_choice, { type: 'tool', name: 'file_versions' });
  assert.match(q.body.system, /four digits/);
  assert.match(q.body.system, /kilo-0010 \(shot\)/);
  assert.match(q.body.system, /This project has: anim/);
  assert.match(q.body.messages[0].content, /These are all shots of ch02/);
  assert.match(q.body.messages[0].content, /0\tRobot walk FINAL v3\.mov\tnow: robot-walk view cmp/);
  // It is asked which view each is, and told the views the project has, the main one first.
  assert.ok(q.body.tools[0].input_schema.properties.files.items.properties.view);
  assert.match(q.body.system, /shows each version these ways: cmp, bty; the first, cmp, is the main one/);
  assert.equal(createAi({ key: 'k', model: 'claude-sonnet-5-5', fetchImpl: claude.fetchImpl }).model, 'claude-sonnet-5-5');
});

test('ai: what Claude says is made to fit before it is shown', async () => {
  const claude = fakeClaude({
    files: [
      { key: '0', entity: 'CH02 0010', tier: 'shot', task: 'Anim', version: 3, view: null, note: 'from the name' },
      { key: '1', entity: 'ch02-10', tier: 'shot', task: null, version: 0 }, // not the shape of a shot; no version 0
      { key: '0', entity: 'twice', tier: 'shot', task: null, version: null }, // the first answer stands
      { key: 'x', entity: 'ch02-0030', tier: 'shot', task: null, version: null }, // not asked about
      { key: '2', entity: '', tier: 'shot', task: null, version: null }, // no name: no answer
      { key: '3', entity: 'set-kitchen', tier: 'nonsense', task: null, version: 12345, view: 'BTY Left' }, // tier from its shape; the view as a token
    ],
  });
  const ai = createAi({ key: 'k', fetchImpl: claude.fetchImpl });
  const files = ['0', '1', '2', '3'].map((key) => ({ key, filename: `${key}.mov` }));
  const out = await ai.fileNames({ files, entities: [], views: ['cmp', 'bty-left'] });
  assert.deepEqual(Object.keys(out).sort(), ['0', '1', '3']);
  assert.deepEqual(out['0'], { entity: 'ch02-0010', tier: 'shot', task: 'anim', version: 3, view: null, note: 'from the name', fits: true });
  assert.equal(out['3'].view, 'bty-left');
  // A view the project does not have, or its main one, is no view; a project shown one way has none.
  const odd = createAi({ key: 'k', fetchImpl: fakeClaude({ files: [{ key: '0', entity: 'kilo-0010', tier: 'shot', task: null, version: null, view: 'top' }, { key: '1', entity: 'kilo-0010', tier: 'shot', task: null, version: null, view: 'cmp' }] }).fetchImpl });
  const two = [{ key: '0', filename: 'a.mov' }, { key: '1', filename: 'b.mov' }];
  assert.deepEqual(Object.values(await odd.fileNames({ files: two, entities: [], views: ['cmp', 'bty'] })).map((a) => a.view), [null, null]);
  const none = createAi({ key: 'k', fetchImpl: fakeClaude({ files: [{ key: '0', entity: 'kilo-0010', tier: 'shot', task: null, version: null, view: 'bty' }] }).fetchImpl });
  assert.equal((await none.fileNames({ files: [two[0]], entities: [], views: [], useViews: false }))['0'].view, null);
  assert.equal(out['1'].fits, false);
  assert.equal(out['1'].version, null);
  assert.deepEqual([out['3'].tier, out['3'].version], ['set', null]);
});

test('ai: renames only what would change, and asks with what its files were called', async () => {
  const claude = fakeClaude({
    entities: [
      { id: 'a', name: 'ch01-0010', tier: 'shot', note: 'shot 1' },
      { id: 'b', name: 'robot', tier: 'asset' }, // unchanged
      { id: 'z', name: 'ch01-0020', tier: 'shot' }, // not asked about
    ],
  });
  const ai = createAi({ key: 'k', fetchImpl: claude.fetchImpl });
  const out = await ai.renameEntities({
    instruction: 'all shots of ch01',
    chosen: [{ id: 'a', name: 'opening', tier: 'asset', files: ['Opening_v2.mov'] }, { id: 'b', name: 'robot', tier: 'asset' }],
    entities: [...ENTITIES, { id: 'a', name: 'opening', tier: 'asset' }],
  });
  assert.deepEqual(out, { a: { name: 'ch01-0010', tier: 'shot', note: 'shot 1', fits: true } });
  const q = claude.asked[0].body;
  assert.match(q.messages[0].content, /a\topening\tasset\tfiles: Opening_v2\.mov/);
  // The ones being renamed are not listed as names the project already has.
  assert.doesNotMatch(q.system, /opening \(asset\)/);
});

test('ai: what goes wrong is said plainly', async () => {
  const fails = async (claude, re, status) => {
    const ai = createAi({ key: 'k', fetchImpl: claude.fetchImpl });
    await assert.rejects(ai.fileNames({ files: [{ key: '0', filename: 'a.mov' }] }), (err) => re.test(err.message) && (!status || err.status === status));
  };
  await fails(fakeClaude(null, { status: 401 }), /key was refused/, 503);
  await fails(fakeClaude(null, { status: 429 }), /busy/, 503);
  await fails(fakeClaude(null, { status: 400 }), /Claude said: nope/, 502);
  await fails(fakeClaude({ files: [] }, { stop: 'max_tokens' }), /cut short/);
  await fails(fakeClaude(null), /did not give an answer/);
  await fails({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }, /could not be reached/, 504);
});

test('ai: is told the project’s own convention, or that it has none', async () => {
  const claude = fakeClaude({ files: [] });
  const ai = createAi({ key: 'sk-test', base: 'http://claude.local/', fetchImpl: claude.fetchImpl });
  await ai.fileNames({ files: [{ key: '0', filename: 'a.mov' }], presetId: 'free', entities: [], tasks: ['anim'] });
  await ai.fileNames({ files: [{ key: '0', filename: 'a.mov' }], presetId: 'episodic', entities: [], tasks: ['anim'] });
  const [free, episodic] = claude.asked.map((q) => q.body.system);
  assert.match(free, /no naming convention/);
  assert.doesNotMatch(free, /four digits/);
  assert.match(episodic, /Episodic/);
  assert.match(episodic, /<sequence>-sh<shot>/);
});
