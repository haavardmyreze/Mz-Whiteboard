'use strict';

// Claude, asked to sort out names: what a batch of imported files should be filed as, or what some of a
// project's assets, sets and shots should be renamed to. It only suggests; the page shows what it said in
// the rows and fields people already use, and nothing is filed or renamed until someone says so.
//
// Set ANTHROPIC_API_KEY to turn it on (the key stays on the server). AI_MODEL picks the model; Haiku is the
// default, quick and cheap enough for names, and claude-sonnet-5-5 can be set for harder sorting.
// What is sent: the instruction typed, the files' names (not the files), and the names of the project's
// assets, sets and shots and its tasks.

const naming = require('./public/naming');

const DEFAULT_MODEL = 'claude-haiku-5-5';
const API_VERSION = '2023-06-01';
const MAX_FILES = 300;
const MAX_ENTITIES = 300;
const MAX_KNOWN = 400; // names of the project's own told as context
const MAX_INSTRUCTION = 2000;

class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const clip = (text, n) => String(text == null ? '' : text).slice(0, n);
const versionOf = (n) => (Number.isSafeInteger(n) && n >= 1 && n <= 9999 ? n : null);

// The naming rules of a project's preset, in words, for the prompt.
function rules(presetId, tasks) {
  const p = naming.preset(presetId);
  return [
    `The project names things by the "${p.name}":`,
    '- Every name is lower case; words are joined by "-"; no spaces, no underscores.',
    ...p.tiers.map((t) => `- A ${t.one} is named ${t.shape}.`),
    `- Tasks are single tokens. This project has: ${(tasks && tasks.length ? tasks : p.tasks).join(', ')}.`,
  ].join('\n');
}

function knownList(entities) {
  const list = (entities || []).slice(0, MAX_KNOWN);
  if (!list.length) return 'The project has no assets, sets or shots yet.';
  const more = (entities.length > list.length) ? `\n(and ${entities.length - list.length} more)` : '';
  return `The project already has these (name, what it is):\n${list.map((e) => `${e.name} (${e.tier})`).join('\n')}${more}`;
}

function createAi({ key = process.env.ANTHROPIC_API_KEY, model = process.env.AI_MODEL, base = process.env.ANTHROPIC_BASE_URL, fetchImpl = fetch, timeoutMs = 90000 } = {}) {
  const enabled = !!(key && key.trim());
  const use = (model && model.trim()) || DEFAULT_MODEL;
  const url = `${(base && base.trim()) || 'https://api.anthropic.com'}`.replace(/\/+$/, '') + '/v1/messages';

  // One question, one answer: Claude must answer by calling `tool`, so what comes back is its input.
  async function ask({ system, user, tool, maxTokens }) {
    if (!enabled) throw new AiError('Claude is not set up on this server', 503);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key.trim(), 'anthropic-version': API_VERSION },
        body: JSON.stringify({
          model: use,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          tools: [tool],
          tool_choice: { type: 'tool', name: tool.name },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AiError(err.name === 'TimeoutError' ? 'Claude took too long to answer. Try fewer at a time' : `Claude could not be reached: ${err.message}`, 504);
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      // said below
    }
    if (!res.ok) {
      const said = body && body.error && body.error.message;
      if (res.status === 401 || res.status === 403) throw new AiError('The server\'s Claude API key was refused. An admin needs to check ANTHROPIC_API_KEY', 503);
      if (res.status === 429 || res.status === 529) throw new AiError('Claude is busy right now. Try again in a minute', 503);
      throw new AiError(`Claude said: ${said || `error ${res.status}`}`);
    }
    if (body && body.stop_reason === 'max_tokens') throw new AiError('Claude\'s answer was cut short. Try fewer at a time');
    const call = body && Array.isArray(body.content) && body.content.find((c) => c.type === 'tool_use' && c.name === tool.name);
    if (!call || !call.input || typeof call.input !== 'object') throw new AiError('Claude did not give an answer that could be used');
    return call.input;
  }

  // What each file should be filed as. `files`: [{ key, filename, now: { entity, task, version, view } }] where
  // `now` is what its row says at the moment; `views` are the views the project's versions are shown in
  // already. Returns { key -> { entity, tier, task, version, view, note, fits } }.
  async function fileNames({ instruction, files, presetId, entities, tasks, views = [], useTasks = true }) {
    const list = (files || []).slice(0, MAX_FILES).filter((f) => f && f.key != null && f.filename);
    if (!list.length) throw new AiError('No files to ask about', 400);
    const tiers = naming.preset(presetId).tiers.map((t) => t.id);
    const system = [
      'You file review media (renders, playblasts, stills) into an animation and VFX project\'s catalogue. Each file becomes a version of an asset, a set or a shot, under a task.',
      rules(presetId, tasks),
      knownList(entities),
      [
        'For each file, say:',
        '- entity: the asset, set or shot it is a version of, named by the rules above. When it is one the project has, use that exact name.',
        '- tier: what the entity is.',
        useTasks ? '- task: the task, from the project\'s tasks when one fits; a new task only when the file name or the instruction clearly names one; otherwise null.'
          : '- task: always null: this project does not count its versions by task, whatever a file name says.',
        '- version: the version number, only when the original file name or the instruction gives one (v3, v003, _003 at the end); otherwise null, and the catalogue numbers it.',
        `- view: which view of its version the file is, when a version is shown more than one way: the unwrapped picture (cmp, vr) and how it looks projected (bty, bty-left, top, side...). A single lower-case token. Give one when the instruction asks for it or the file name says it (a word after the version, as in _v012_bty); otherwise null, as most files have none.${views.length ? ` The project's versions use these views already: ${views.slice(0, 40).join(', ')}.` : ''} Two files that are views of the same version (cmp and bty of v3, say) get the same version number.`,
        '- note: a few words on why, for the person checking your answer.',
        'Read everything the original file name says. The person\'s instruction comes first where it says otherwise, but every name keeps the shape the rules give.',
        'Answer for every file, with the key it was given.',
      ].join('\n'),
    ].join('\n\n');
    const user = [
      `Instruction: ${clip(instruction, MAX_INSTRUCTION).trim() || '(none: file them by what their names say)'}`,
      '',
      'Files (key, original name, and what it is set to now, if anything):',
      ...list.map((f) => {
        const now = f.now || {};
        const said = [now.entity, now.task, now.version && `v${now.version}`, now.view && `view ${now.view}`].filter(Boolean).join(' ');
        return `${clip(f.key, 40)}\t${clip(f.filename, 255)}${said ? `\tnow: ${clip(said, 120)}` : ''}`;
      }),
    ].join('\n');
    const tool = {
      name: 'file_versions',
      description: 'What each file is to be filed as.',
      input_schema: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                entity: { type: 'string' },
                tier: { type: 'string', enum: tiers },
                task: { type: ['string', 'null'] },
                version: { type: ['integer', 'null'] },
                view: { type: ['string', 'null'] },
                note: { type: 'string' },
              },
              required: ['key', 'entity', 'tier', 'task', 'version', 'view'],
            },
          },
        },
        required: ['files'],
      },
    };
    const out = await ask({ system, user, tool, maxTokens: Math.min(32000, 600 + 140 * list.length) });
    const keys = new Set(list.map((f) => String(f.key)));
    const answers = {};
    for (const a of Array.isArray(out.files) ? out.files : []) {
      const k = a && String(a.key);
      if (!keys.has(k) || answers[k]) continue;
      const entity = naming.tokenize(a.entity);
      if (!entity) continue;
      const tier = tiers.includes(a.tier) ? a.tier : naming.tierOf(entity, presetId) || null;
      if (!tier) continue;
      answers[k] = {
        entity, tier, task: (useTasks && naming.tokenize(a.task)) || null, version: versionOf(a.version), view: naming.tokenize(a.view).slice(0, 40) || null,
        note: clip(a.note, 200), fits: naming.tierOf(entity, presetId) === tier,
      };
    }
    return answers;
  }

  // New names, or what they are, for some of a project's assets, sets and shots. `chosen`: [{ id, name,
  // tier, versions: [file names it was filed from] }]. Returns { id -> { name, tier, note, fits } }, only for
  // those it would change.
  async function renameEntities({ instruction, chosen, presetId, entities, tasks }) {
    const list = (chosen || []).slice(0, MAX_ENTITIES);
    if (!list.length) throw new AiError('Nothing to ask about', 400);
    const tiers = naming.preset(presetId).tiers.map((t) => t.id);
    const ids = new Set(list.map((e) => e.id));
    const system = [
      'You tidy up the names of assets, sets and shots in an animation and VFX project\'s catalogue.',
      rules(presetId, tasks),
      knownList((entities || []).filter((e) => !ids.has(e.id))),
      [
        'For each of the ones you are given, say its name and tier as they should be, by the person\'s instruction and the rules above. Use what the files it was filed from were called when they say more than its name does.',
        'A name must not be one the project already has (listed above), and no two of yours may be the same.',
        'Leave one as it is by giving its name and tier unchanged. Add a note of a few words on why, for the person checking your answer.',
        'Answer for every one, with the id it was given.',
      ].join('\n'),
    ].join('\n\n');
    const user = [
      `Instruction: ${clip(instruction, MAX_INSTRUCTION).trim() || '(none: make the names follow the rules)'}`,
      '',
      'Assets, sets and shots (id, name, what it is, and what some of its files were called):',
      ...list.map((e) => `${e.id}\t${e.name}\t${e.tier}${e.files && e.files.length ? `\tfiles: ${e.files.slice(0, 3).map((n) => clip(n, 120)).join(', ')}` : ''}`),
    ].join('\n');
    const tool = {
      name: 'rename',
      description: 'The name and tier each should have.',
      input_schema: {
        type: 'object',
        properties: {
          entities: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' }, tier: { type: 'string', enum: tiers }, note: { type: 'string' } },
              required: ['id', 'name', 'tier'],
            },
          },
        },
        required: ['entities'],
      },
    };
    const out = await ask({ system, user, tool, maxTokens: Math.min(32000, 600 + 120 * list.length) });
    const byId = new Map(list.map((e) => [e.id, e]));
    const answers = {};
    for (const a of Array.isArray(out.entities) ? out.entities : []) {
      const e = a && byId.get(String(a.id));
      if (!e || answers[e.id]) continue;
      const name = naming.tokenize(a.name);
      const tier = tiers.includes(a.tier) ? a.tier : e.tier;
      if (!name || (name === e.name && tier === e.tier)) continue;
      answers[e.id] = { name, tier, note: clip(a.note, 200), fits: naming.tierOf(name, presetId) === tier };
    }
    return answers;
  }

  return { enabled, model: use, fileNames, renameEntities, MAX_FILES, MAX_ENTITIES };
}

module.exports = { createAi, AiError, DEFAULT_MODEL };
