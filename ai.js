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

// What an instruction can name to fill in. The tier goes with the entity, and so does its chapter.
const FIELDS = ['entity', 'task', 'version', 'view'];
const clip = (text, n) => String(text == null ? '' : text).slice(0, n);
const versionOf = (n) => (Number.isSafeInteger(n) && n >= 1 && n <= 9999 ? n : null);

// How names are written in a project, in words, for the prompt (see naming.js).
function rules(tasks) {
  return [
    'The project is made of assets, sets, and shots in sequences, named this way:',
    '- Every name is lower case; words are joined by "-"; no spaces, no underscores.',
    `- A shot is <sequence>-<shot number in ${naming.DIGITS} digits> (kilo-0010, ch01-0020); its sequence is everything before the number.`,
    '- An asset or a set is named in plain words, like the project\'s own names that are like it (if it has char-robot, a new character is char-something).',
    '- It has only assets, sets and shots: nothing is anything else.',
    `- Tasks are single tokens. This project has: ${(tasks && tasks.length ? tasks : naming.TASKS).join(', ')}.`,
  ].join('\n');
}
// Whether a name is written as what it is: a shot as a shot, anything else not as one.
const fitsTier = (name, tier) => (tier === 'shot') === (naming.tierOf(name) === 'shot');
// An answer that is no name: a placeholder for "I cannot tell" (unknown, none, <UNKNOWN>, n/a, tbd).
const placeholder = (said) => /[<>]/.test(String(said || '')) || /^(unknown|none|null|nothing|n-?a|tbd|tba|excluded?|skip(ped)?)$/.test(naming.tokenize(said) || '');

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
  // already. Returns { key -> { entity, tier, task, version, view, note, fits } }, with only the fields the
  // instruction asked to fill in when it named some.
  async function fileNames({ instruction, files, entities, tasks, views = [], useViews = true, useTasks = true }) {
    const list = (files || []).slice(0, MAX_FILES).filter((f) => f && f.key != null && f.filename);
    if (!list.length) throw new AiError('No files to ask about', 400);
    const tiers = naming.TIERS;
    const system = [
      'You file review media (renders, playblasts, stills) into an animation and VFX project\'s catalogue. Each file becomes a version of an asset, a set or a shot, under a task.',
      rules(tasks),
      knownList(entities),
      [
        'For each file, say:',
        '- entity: the asset, set or shot it is a version of, named by the rules above. When it is one the project has, use that exact name.',
        '- tier: what the entity is.',
        useTasks ? '- task: the task, from the project\'s tasks when one fits; a new task only when the file name or the instruction clearly names one; otherwise null.'
          : '- task: always null: this project does not count its versions by task, whatever a file name says.',
        '- version: the version number, only when the original file name or the instruction gives one (v3, v003, _003 at the end); otherwise null, and the catalogue numbers it.',
        useViews
          ? `- view: which view of its version the file is. This project shows each version these ways: ${views.slice(0, 12).join(', ')}; the first, ${views[0]}, is the main one, so a file that is a new version is null, and only a file that is one of the others gets its name. Use only these names. Give one when the instruction asks for it or the file name says it (a word after the version, as in _v012_${views[1] || 'bty'}). Two files that are views of the same version get the same version number.`
          : '- view: always null: this project shows each version one way, whatever a file name says.',
        '- note: a few words on why, for the person checking your answer.',
        'Read everything the original file name says. The person\'s instruction comes first where it says otherwise, but every name keeps the shape the rules give.',
        'An instruction is always about how the files are named, never about which files are filed: every file is filed, and you answer for every one. When it says to exclude, drop, remove, strip or ignore a word (a project code, a prefix, a client name), it means leaving that word out of the names: "psh26 should be excluded" files PSH26_HAUS_0110_vr_v500.mp4 as the shot haus-0110, version 500.',
        'Never answer a placeholder (unknown, none, n/a, <UNKNOWN>): when you cannot tell, answer what the file is set to now.',
        'Say in `only` which fields the instruction asks you to fill in, when it names them ("fill in chapter, shot and version" is entity, version; the entity includes its chapter or sequence and its tier). Leave `only` null when it does not name any. Whatever is not in `only` is left as it is, whatever you answer for it; what you do answer for is yours to change or to clear.',
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
          only: { type: ['array', 'null'], items: { type: 'string', enum: FIELDS }, description: 'The fields the instruction says to fill in, when it names them; null when it does not.' },
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
        required: ['files', 'only'],
      },
    };
    const out = await ask({ system, user, tool, maxTokens: Math.min(32000, 600 + 140 * list.length) });
    const keys = new Set(list.map((f) => String(f.key)));
    // Asked to fill in only some fields, an answer has only those: the rest are not in it, so they stay.
    const only = Array.isArray(out.only) ? out.only.filter((f) => FIELDS.includes(f)) : [];
    const takes = (field) => !only.length || only.includes(field);
    const answers = {};
    for (const a of Array.isArray(out.files) ? out.files : []) {
      const k = a && String(a.key);
      if (!keys.has(k) || answers[k]) continue;
      const answer = { note: clip(a.note, 200) };
      if (takes('entity')) {
        const entity = naming.tokenize(a.entity);
        if (!entity || placeholder(a.entity)) continue;
        const tier = tiers.includes(a.tier) ? a.tier : naming.kindOf(entity, entities || []) || null;
        if (!tier) continue;
        Object.assign(answer, { entity, tier, fits: fitsTier(entity, tier) });
      }
      if (takes('task')) answer.task = (useTasks && naming.tokenize(a.task)) || null;
      if (takes('version')) answer.version = versionOf(a.version);
      if (takes('view')) answer.view = useViews && views.slice(1).includes(naming.tokenize(a.view)) ? naming.tokenize(a.view) : null;
      answers[k] = answer;
    }
    return answers;
  }

  // New names, or what they are, for some of a project's assets, sets and shots. `chosen`: [{ id, name,
  // tier, versions: [file names it was filed from] }]. Returns { id -> { name, tier, note, fits } }, only for
  // those it would change.
  async function renameEntities({ instruction, chosen, entities, tasks }) {
    const list = (chosen || []).slice(0, MAX_ENTITIES);
    if (!list.length) throw new AiError('Nothing to ask about', 400);
    const tiers = naming.TIERS;
    const ids = new Set(list.map((e) => e.id));
    const system = [
      'You tidy up the names of assets, sets and shots in an animation and VFX project\'s catalogue.',
      rules(tasks),
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
      answers[e.id] = { name, tier, note: clip(a.note, 200), fits: fitsTier(name, tier) };
    }
    return answers;
  }

  return { enabled, model: use, fileNames, renameEntities, MAX_FILES, MAX_ENTITIES };
}

module.exports = { createAi, AiError, DEFAULT_MODEL };
