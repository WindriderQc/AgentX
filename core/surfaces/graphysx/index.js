'use strict';

// GraphysX proposals: Nestor turns a sentence into world commands, and a person decides.
//
// Owner decision, 2026-10-25 (America/Toronto): Core is the proposal provider for the GraphysX
// AgentX Center; GraphysX keeps no model of its own. The page sends `{ request, revision,
// scene }` — the person's words, the revision they are looking at and a bounded summary of
// the scene (ids, types, labels; at most 60) — and gets back `{ intent, commands }`, or an
// explicit refusal `{ ok: false, reason }` in a 200, which the page shows as a sentence.
//
// Core carries no hand-written copy of the world API. The vocabulary — operations, entity
// types, fields with their bounds, curated ids, prefabs and examples — is published by every
// GraphysX build at `/embed/world-vocabulary.json` and read from `GRAPHYSX_VOCABULARY_URL`.
// The prompt is rendered from it, and a model's answer is validated against it before anything
// is sent back, with the same structural rules the page applies on arrival: unknown operations,
// reserved id namespaces, oversize lists and references to ids the scene does not have are all
// decided here first, so the refusal is a sentence rather than a status code.
//
// Nothing here applies a change. The commands become a card in the browser, inert until a
// human presses Apply; the commit, its attribution and its undo path stay in GraphysX.

const { configuredModuleUrl } = require('../household/asset-relay');

const PROPOSE_ROUTE = '/api/graphysx/propose';
const VOCABULARY_ROUTE = '/api/graphysx/vocabulary';
const VOCABULARY_SCHEMA = 'graphysx.world-vocabulary/v1';
const VOCABULARY_MAX_BYTES = 1024 * 1024;
const VOCABULARY_CACHE_MS = 10 * 60_000;
const VOCABULARY_TIMEOUT_MS = 10_000;
const INFERENCE_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 2;
/** What the page may send; `scene.entities` is already capped at 60 by GraphysX. */
const REQUEST_LIMITS = Object.freeze({ requestChars: 2000, entities: 60, idChars: 80, labelChars: 240, typeChars: 40 });
/** Fallbacks only until the vocabulary is read; its `proposalLimits` win. */
const DEFAULT_PROPOSAL_LIMITS = Object.freeze({ commands: 40, intentChars: 200, replyBytes: 256 * 1024 });

function invalid(message, code = 'INVALID_PROPOSAL_REQUEST') {
  return Object.assign(new Error(message), { status: 400, code });
}

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);

/** The GraphysX vocabulary URL, e.g. https://graphysx.example/embed/world-vocabulary.json. */
function vocabularyUrl(env = process.env) {
  return configuredModuleUrl(env, 'GRAPHYSX_VOCABULARY_URL', 'GRAPHYSX_NOT_CONFIGURED', 'GraphysX vocabulary');
}

/**
 * Reads the vocabulary from GraphysX and keeps it for ten minutes; a stale copy beats a
 * missing one while GraphysX redeploys. Refuses anything that is not the vocabulary schema.
 */
function createVocabularyReader({ env = process.env, fetchWithTimeout, now = () => Date.now() } = {}) {
  const load = fetchWithTimeout || require('../../src/services/voice/transport').fetchWithTimeout;
  let cached = null;
  async function read() {
    const url = vocabularyUrl(env);
    if (cached && cached.url === url && now() - cached.at < VOCABULARY_CACHE_MS) return cached.vocabulary;
    try {
      const response = await load(url, { headers: { accept: 'application/json' } }, VOCABULARY_TIMEOUT_MS);
      if (!response.ok) throw Object.assign(new Error(`GraphysX answered ${response.status} for its vocabulary`), { status: 502, code: 'GRAPHYSX_VOCABULARY_UNAVAILABLE' });
      const body = await response.text();
      if (Buffer.byteLength(body) > VOCABULARY_MAX_BYTES) throw Object.assign(new Error('The GraphysX vocabulary is too large to read'), { status: 502, code: 'GRAPHYSX_VOCABULARY_UNAVAILABLE' });
      let vocabulary;
      try { vocabulary = JSON.parse(body); } catch { throw Object.assign(new Error('The GraphysX vocabulary is not JSON'), { status: 502, code: 'GRAPHYSX_VOCABULARY_UNAVAILABLE' }); }
      if (!isRecord(vocabulary) || vocabulary.schema !== VOCABULARY_SCHEMA || !isRecord(vocabulary.operations) || !isRecord(vocabulary.entityTypes)) {
        throw Object.assign(new Error('The GraphysX vocabulary does not have the expected schema'), { status: 502, code: 'GRAPHYSX_VOCABULARY_UNAVAILABLE' });
      }
      cached = { url, vocabulary, at: now() };
      return vocabulary;
    } catch (error) {
      if (cached && cached.url === url) return cached.vocabulary;
      throw error.status ? error : Object.assign(new Error(`The GraphysX vocabulary could not be read: ${error.message}`), { status: 502, code: 'GRAPHYSX_VOCABULARY_UNAVAILABLE' });
    }
  }
  read.loadedAt = () => (cached ? cached.at : null);
  return read;
}

/** The page's request, checked field by field; anything else is refused before any model runs. */
function checkProposalRequest(body) {
  if (!isRecord(body)) throw invalid('The body must be a proposal request object');
  const unknown = Object.keys(body).filter((key) => !['request', 'revision', 'scene'].includes(key));
  if (unknown.length) throw invalid(`Unknown field: ${unknown[0].slice(0, 40)}`);
  if (!text(body.request, REQUEST_LIMITS.requestChars) || !body.request.trim()) throw invalid(`request must be a sentence of at most ${REQUEST_LIMITS.requestChars} characters`);
  if (!Number.isInteger(body.revision) || body.revision < 0) throw invalid('revision must be a non-negative integer');
  const scene = body.scene;
  if (!isRecord(scene) || !text(scene.id, REQUEST_LIMITS.idChars) || !text(scene.label, REQUEST_LIMITS.labelChars) || !Array.isArray(scene.entities)) {
    throw invalid('scene must carry id, label and entities');
  }
  if (scene.entities.length > REQUEST_LIMITS.entities) throw invalid(`scene.entities must hold at most ${REQUEST_LIMITS.entities} entries`);
  const entities = scene.entities.map((entity, index) => {
    if (!isRecord(entity) || Object.keys(entity).length !== 3 || !text(entity.id, REQUEST_LIMITS.idChars) || !entity.id
      || !text(entity.type, REQUEST_LIMITS.typeChars) || !text(entity.label, REQUEST_LIMITS.labelChars)) {
      throw invalid(`scene.entities[${index}] must be { id, type, label }`);
    }
    return { id: entity.id, type: entity.type, label: entity.label };
  });
  return { request: body.request.trim(), revision: body.revision, scene: { id: scene.id, label: scene.label, entities } };
}

const range = (field) => (Array.isArray(field.range) ? `[${field.range[0]}..${field.range[1]}]` : '');
const fieldLine = (field) => `${field.name}${range(field)}${field.description ? ` — ${field.description}` : ''}`;
const idLine = (entry) => (entry.label ? `${entry.id} (${entry.label}${entry.description ? `: ${entry.description}` : ''})` : entry.id);

/**
 * The system prompt, rendered from the vocabulary. Compact on purpose — a local model has a
 * context budget — but complete: every operation, every entity type, every field with its
 * bounds, every curated id. The examples come from the vocabulary too.
 */
function buildSystemPrompt(vocabulary) {
  const limits = { ...DEFAULT_PROPOSAL_LIMITS, ...(vocabulary.proposalLimits || {}) };
  const fields = vocabulary.fields || {};
  const block = (name, title) => (Array.isArray(fields[name]) && fields[name].length
    ? `${title || name}: ${fields[name].map((field) => (typeof field === 'string' ? field : fieldLine(field))).join('; ')}`
    : null);
  const lines = [
    'You compose changes to a GraphysX 3D world for the AgentX Center. You answer with JSON only.',
    `Reply shape: {"intent": "<one sentence, under ${limits.intentChars} characters, saying what the change does>", "commands": [<at most ${limits.commands} commands>]}.`,
    'If the request cannot be met with this vocabulary, reply {"ok": false, "reason": "<one sentence saying why>"} instead of inventing anything.',
    '',
    'RULES',
    ...(Array.isArray(vocabulary.rules) ? vocabulary.rules.map((rule) => `- ${rule}`) : []),
    `- Entity ids match ${vocabulary.idPattern || '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$'}; never start one with ${(vocabulary.reservedIdPrefixes || []).join(', ')}.`,
    '',
    'OPERATIONS',
    ...Object.entries(vocabulary.operations).map(([op, entry]) => `- ${op}: ${JSON.stringify(entry.shape)} — ${entry.description || ''}`),
    '',
    'ENTITY TYPES (primitive? physics? config block)',
    ...Object.entries(vocabulary.entityTypes).map(([type, entry]) => `- ${type}: ${entry.primitive ? 'primitive mesh' : 'not a mesh'}, ${entry.physics ? 'accepts physics' : 'no physics'}${entry.config ? `, config block "${entry.config}"` : ''}${entry.requires ? `, requires ${entry.requires.join(', ')}` : ''}${entry.fields ? `, fields ${entry.fields.join(', ')}` : ''}`),
    '',
    'FIELDS (name[min..max] — meaning)',
    block('entity', 'entity (spawn.entity)'),
    `patch (update.patch): ${(fields.patch || []).join(', ')}`,
    block('transform'), block('geometry'), block('material'), block('texture'), block('physics'), block('path'), block('asset'), block('agent'),
    block('emitter'), block('sound'), block('terrain'), block('water'), block('flock'), block('crowd'), block('formula'), block('dna'), block('forceField'), block('surface'), block('steering'),
    block('environment', 'environment (set-environment.environment)'), block('envelope'), block('bloom', 'post.bloom'), block('lighting'), block('dayNight'), block('ground'), block('environmentPhysics', 'environment.physics'), block('joint'),
    '',
    'BEHAVIORS (attach-behavior.behavior, or spawn.entity.behaviors[])',
    ...Object.entries(vocabulary.behaviors || {}).map(([type, entry]) => `- ${type}: fields ${entry.fields.join(', ')} — ${entry.description || ''}`),
    'INTERACTIONS (spawn.entity.interactions[] or update.patch.interactions; fired by interact)',
    ...Object.entries(vocabulary.interactions || {}).map(([type, entry]) => `- ${type}: fields ${entry.fields.join(', ')} — ${entry.description || ''}`),
    '',
    'CURATED IDS AND ENUMERATIONS',
    ...Object.entries(vocabulary.enums || {}).map(([name, values]) => `- ${name}: ${values.map((value) => (typeof value === 'string' ? value : idLine(value))).join(', ')}`),
    '',
    'PREFABS (spawn-prefab.prefabId)',
    ...(Array.isArray(vocabulary.prefabs) && vocabulary.prefabs.length
      ? vocabulary.prefabs.map((prefab) => `- ${prefab.id}: ${prefab.label}${prefab.summary ? ` — ${prefab.summary}` : ''}${prefab.entityCount ? ` (${prefab.entityCount} entities)` : ''}`)
      : ['- none published']),
    '',
    'EXAMPLES OF VALID COMMAND LISTS',
    ...Object.entries(vocabulary.examples || {}).map(([name, commands]) => `${name}: ${JSON.stringify(commands)}`),
  ].filter((line) => line !== null);
  return lines.join('\n');
}

function buildUserPrompt({ request, revision, scene }) {
  return JSON.stringify({
    request,
    scene: { id: scene.id, label: scene.label, revision, entities: scene.entities },
    note: 'Only the ids listed in scene.entities exist. Answer with the JSON reply shape and nothing else.'
  });
}

/** The first JSON object in a model's text, fences and chatter stripped; null when there is none. */
function parseModelReply(raw) {
  const value = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(value); } catch { /* fall through to the first balanced object */ }
  const start = value.indexOf('{');
  if (start === -1) return null;
  let depth = 0; let inString = false; let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(value.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** Any string anywhere in a command that reaches into a reserved id namespace. */
function findReservedPrefix(command, prefixes) {
  let found = null;
  const walk = (value, depth) => {
    if (found || depth > 12) return;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      found = prefixes.find((prefix) => trimmed.startsWith(prefix)) || null;
      return;
    }
    if (Array.isArray(value)) value.forEach((item) => walk(item, depth + 1));
    else if (isRecord(value)) Object.values(value).forEach((item) => walk(item, depth + 1));
  };
  walk(command, 0);
  return found;
}

const ID_REFERENCING_OPS = new Set(['update', 'remove', 'attach-behavior', 'detach-behavior', 'interact', 'steer']);

/**
 * A model's reply, checked against the vocabulary and the scene summary. The structural rules
 * are the page's (`validateProviderCommands` in GraphysX): list, non-empty, bounded, known ops,
 * no reserved namespace. On top, what the page cannot know without the vocabulary: entity types,
 * prefab ids, and that `update`/`remove`/… name ids the scene actually has while `spawn` names
 * new ones. Returns the proposal, or a sentence a person can read.
 */
function validateProposal(reply, { vocabulary, scene }) {
  const limits = { ...DEFAULT_PROPOSAL_LIMITS, ...(vocabulary.proposalLimits || {}) };
  if (isRecord(reply) && reply.ok === false) {
    const reason = typeof reply.reason === 'string' && reply.reason.trim() ? reply.reason.trim().replace(/\s+/g, ' ').slice(0, 300) : 'The model declined without saying why.';
    return { ok: false, reason, declined: true };
  }
  if (!isRecord(reply)) return { ok: false, reason: 'The model did not answer with a JSON proposal.' };
  const intent = typeof reply.intent === 'string' ? reply.intent.trim().replace(/\s+/g, ' ') : '';
  if (!intent) return { ok: false, reason: 'The model did not say what the change does.' };
  if (intent.length > limits.intentChars) return { ok: false, reason: `The stated intent is ${intent.length} characters; ${limits.intentChars} is the most a card can show.` };
  const commands = reply.commands;
  if (!Array.isArray(commands)) return { ok: false, reason: 'The model did not return a list of commands.' };
  if (commands.length === 0) return { ok: false, reason: 'The model returned no changes to make.' };
  if (commands.length > limits.commands) return { ok: false, reason: `The model asked for ${commands.length} changes; ${limits.commands} is the most that can be reviewed at once.` };

  const known = new Set(scene.entities.map((entity) => entity.id));
  const spawned = new Set();
  const idPattern = new RegExp(vocabulary.idPattern || '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$');
  const prefixes = Array.isArray(vocabulary.reservedIdPrefixes) ? vocabulary.reservedIdPrefixes : [];
  const prefabIds = new Set((vocabulary.prefabs || []).map((prefab) => prefab.id));
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const at = `Change ${index + 1}`;
    if (!isRecord(command)) return { ok: false, reason: `${at} is not an object.` };
    if (typeof command.op !== 'string' || !vocabulary.operations[command.op]) return { ok: false, reason: `${at} uses an operation the world does not have (${String(command.op).slice(0, 40)}).` };
    const reserved = findReservedPrefix(command, prefixes);
    if (reserved) return { ok: false, reason: `${at} uses the reserved id namespace "${reserved}", which only the browser may own.` };
    if (command.op === 'spawn') {
      if (!isRecord(command.entity)) return { ok: false, reason: `${at} spawns nothing: entity is missing.` };
      const { id, type } = command.entity;
      if (typeof id !== 'string' || !idPattern.test(id)) return { ok: false, reason: `${at} needs a valid new entity id.` };
      if (known.has(id) || spawned.has(id)) return { ok: false, reason: `${at} reuses the id "${id}", which already exists.` };
      if (typeof type !== 'string' || !vocabulary.entityTypes[type]) return { ok: false, reason: `${at} asks for an entity type the world does not have (${String(type).slice(0, 40)}).` };
      if (typeof command.entity.parentId === 'string' && !known.has(command.entity.parentId) && !spawned.has(command.entity.parentId)) {
        return { ok: false, reason: `${at} parents under "${command.entity.parentId}", which does not exist.` };
      }
      spawned.add(id);
    } else if (command.op === 'spawn-prefab') {
      if (typeof command.prefabId !== 'string' || (prefabIds.size && !prefabIds.has(command.prefabId))) return { ok: false, reason: `${at} asks for a prefab the world does not have (${String(command.prefabId).slice(0, 40)}).` };
      const prefix = command.options && typeof command.options.idPrefix === 'string' ? command.options.idPrefix : null;
      if (prefix) {
        if (!idPattern.test(prefix) || known.has(prefix) || spawned.has(prefix)) return { ok: false, reason: `${at} needs a valid new id prefix.` };
        spawned.add(prefix);
      }
    } else if (ID_REFERENCING_OPS.has(command.op)) {
      if (typeof command.id !== 'string' || (!known.has(command.id) && !spawned.has(command.id))) {
        return { ok: false, reason: `${at} (${command.op}) names "${String(command.id).slice(0, 40)}", which is not in this scene.` };
      }
    } else if (command.op === 'select') {
      if (!Array.isArray(command.ids) || command.ids.some((id) => typeof id !== 'string' || (!known.has(id) && !spawned.has(id)))) {
        return { ok: false, reason: `${at} selects an id that is not in this scene.` };
      }
    }
  }
  return { ok: true, intent, commands };
}

/**
 * Compose one proposal: prompt from the vocabulary, one admitted inference through Core's
 * router, the answer validated. A second attempt carries the first refusal back to the model;
 * after that the refusal is the answer. Returns what the page will receive.
 */
async function proposeWorldChange(request, { vocabulary, execute, signal, timeoutMs = INFERENCE_TIMEOUT_MS, callerDetail = 'graphysx-propose' } = {}) {
  const system = buildSystemPrompt(vocabulary);
  let prompt = buildUserPrompt(request);
  let last = { ok: false, reason: 'The model did not answer.' };
  let model = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await execute({
      callerDetail, taskType: 'analysis', stream: false, think: false, format: 'json',
      system, prompt, options: { temperature: 0.2, num_predict: 3000 }
    }, { signal, timeoutMs });
    if (signal?.aborted) return null;
    if (!result?.ok) {
      return { ok: false, reason: result?.body?.message || 'No model is available to compose this right now.', status: result?.status || 503 };
    }
    model = result.headers?.['X-Resolved-Model'] || model;
    const body = result.body || {};
    const raw = body.response ?? body.message?.content ?? body.content ?? '';
    last = validateProposal(parseModelReply(raw), { vocabulary, scene: request.scene });
    if (last.ok || last.declined) break;
    prompt = `${buildUserPrompt(request)}\nYour previous answer was refused: ${last.reason} Answer again with the JSON reply shape only.`;
  }
  return last.ok ? { ok: true, intent: last.intent, commands: last.commands, model } : { ok: false, reason: last.reason, model };
}

function register({ app, express, env = process.env, fetchWithTimeout, execute, readVocabulary } = {}) {
  const vocabulary = readVocabulary || createVocabularyReader({ env, fetchWithTimeout });
  const run = execute || ((body, options) => require('../../src/services/inferenceService').executeInference(body, options));
  const fail = (res, error) => res.status(error.status || 500).json({ ok: false, status: 'error', code: error.code || 'GRAPHYSX_PROPOSE_FAILED', message: error.message, reason: error.message });

  app.get(VOCABULARY_ROUTE, async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const value = await vocabulary();
      return res.json({ ok: true, data: {
        url: vocabularyUrl(env), schema: value.schema, worldSchema: value.worldSchema, loadedAt: vocabulary.loadedAt ? new Date(vocabulary.loadedAt()).toISOString() : null,
        operations: Object.keys(value.operations).length, entityTypes: Object.keys(value.entityTypes).length, prefabs: (value.prefabs || []).length,
        proposalLimits: value.proposalLimits || DEFAULT_PROPOSAL_LIMITS
      } });
    } catch (error) { return fail(res, error); }
  });

  app.post(PROPOSE_ROUTE, express.json({ limit: '128kb' }), async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    let request;
    try { request = checkProposalRequest(req.body); } catch (error) { return fail(res, error); }
    let value;
    try { value = await vocabulary(); } catch (error) { return fail(res, error); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.on('close', abort);
    try {
      const result = await proposeWorldChange(request, { vocabulary: value, execute: run, signal: controller.signal });
      if (!result) return undefined;
      if (result.ok) return res.json({ intent: result.intent, commands: result.commands, model: result.model });
      // A refusal is a successful answer whose content is "no": the page reads `reason`.
      return res.status(result.status || 200).json({ ok: false, reason: result.reason, model: result.model || null });
    } catch (error) {
      return fail(res, Object.assign(new Error('The proposal could not be composed.'), { status: 502, code: 'GRAPHYSX_PROPOSE_FAILED', cause: error }));
    } finally {
      req.off('close', abort);
    }
  });
}

module.exports = {
  register, vocabularyUrl, createVocabularyReader, checkProposalRequest, buildSystemPrompt, buildUserPrompt,
  parseModelReply, validateProposal, proposeWorldChange, PROPOSE_ROUTE, VOCABULARY_ROUTE, VOCABULARY_SCHEMA, REQUEST_LIMITS, MAX_ATTEMPTS
};
