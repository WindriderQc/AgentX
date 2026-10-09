'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const ImageOperation = require('../../../models/ImageOperation');
const { defaultArchive } = require('../imageArchive');
const { decode } = require('./codec');
const { TRANSFORM, validateParent, prepareReferences } = require('./parentReference');
const { loadConfig } = require('./config');
const { createComfyClient } = require('./comfyClient');
const { reserve } = require('./gpuReservation');
const { workflow } = require('./workflows');
const { qualified, MAX_OUTPUT_PIXELS } = require('./sizes');
const logger = require('../../../config/logger');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const ACTIVE = ['accepted', 'reserving', 'generating', 'archiving', 'restoring'];
let initialized;

// Restart never replays an uncertain external effect. Its GPU journal remains fenced.
async function initialize() {
  if (!initialized) initialized = (async () => {
    await ImageOperation.createCollection();
    await ImageOperation.createIndexes();
    await ImageOperation.updateMany({ state: { $in: ACTIVE } }, { $set: {
      state: 'unknown', error: 'Service redémarré pendant une opération. Récupération requise ; aucune nouvelle génération automatique.'
    } }, { writeConcern: { w: 1, j: true } });
  })();
  return initialized;
}
function publicOperation(op) {
  const studioPath = `/images?operation=${op._id}`;
  let studioUrl;
  try {
    const url = new URL(process.env.CORE_PUBLIC_URL);
    if (['http:', 'https:'].includes(url.protocol)) studioUrl = url.origin + studioPath;
  } catch { /* A local deployment may only have relative browser routes. */ }
  return { id: op._id, state: op.state, profile: op.profile.id, label: op.profile.label,
    studioPath, ...(studioUrl && { studioUrl }),
    createdAt: op.createdAt, updatedAt: op.updatedAt, runtimeRestored: op.runtimeRestored,
    cancelRequested: op.cancelRequested, error: op.error || null, timings: op.timings || null,
    ...(op.artifact && { artifact: { sha256: op.artifact.sha256, mimeType: op.artifact.mimeType,
      width: op.artifact.width, height: op.artifact.height, url: `/api/images/operations/${op._id}/image` } }) };
}
async function save(id, changes, unset = {}) {
  return ImageOperation.findByIdAndUpdate(id, { $set: changes, ...(Object.keys(unset).length && { $unset: unset }) },
    { new: true, writeConcern: { w: 1, j: true } }).lean();
}
function validate(body, config) {
  if (!body || typeof body !== 'object' || typeof body.actionKey !== 'string' || !/^[a-zA-Z0-9:_.-]{8,160}$/.test(body.actionKey)) throw fail('Une identité de demande est requise.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 8000) throw fail('Décris l’image en 8 000 caractères au maximum.');
  const id = body.profile || config.defaultProfile;
  const profile = config.profiles[id];
  if (!profile) throw fail('Profil image inconnu.');
  const width = Number(body.width || 1024), height = Number(body.height || 1024);
  if (!qualified(profile, width, height)) throw fail('Résolution non qualifiée pour ce profil.');
  const seed = body.seed === undefined ? crypto.randomInt(0, 2 ** 48 - 1) : Number(body.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw fail('Graine invalide.');
  const parent = validateParent(body.parent);
  if (body.references !== undefined && !Array.isArray(body.references)) throw fail('Références image invalides.');
  if ((body.references || []).length + (parent ? 1 : 0) > 2) throw fail('Deux références au maximum, parent compris.');
  const originals = (body.references || []).map(item => {
    if (typeof item !== 'string' || item.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(item)) throw fail('Référence image invalide ou trop volumineuse.');
    const bytes = Buffer.from(item, 'base64');
    try {
      const image = decode(bytes, 4194304);
      if (Math.max(image.width, image.height) / Math.min(image.width, image.height) > 8) throw new Error('Extreme aspect ratio');
    } catch { throw fail('La référence doit être une image PNG/JPEG complète de 4 MP maximum, avec un ratio maximal de 8:1.'); }
    return bytes;
  });
  const request = { prompt: body.prompt.trim(), width, height, seed };
  // Omitted seed remains omitted in the identity: a replay returns the original random seed.
  const requestHash = hash(JSON.stringify({ ...request, seed: body.seed ?? null, profile: id, references: originals.map(hash),
    ...(parent && { parent: { ...parent, transform: TRANSFORM } }) }));
  return { profile: { ...profile, id }, request, requestHash, originals, parent };
}
async function accept(body, { conversation, signal } = {}) {
  await initialize();
  const config = loadConfig();
  if (!config || !defaultArchive().enabled) throw fail('Le service d’images locales n’est pas configuré.', 503);
  const input = validate(body, config);
  if (conversation) {
    conversation = normalizeConversation(conversation);
    input.requestHash = hash(JSON.stringify([input.requestHash, conversation.surface, conversation.sessionId, conversation.packId, conversation.scopeId]));
  }
  const prior = await ImageOperation.findOne({ actionKey: body.actionKey }).lean();
  if (prior) {
    if (prior.requestHash !== input.requestHash) throw fail('Cette identité appartient déjà à une autre demande.', 409);
    return publicOperation(prior);
  }
  signal?.throwIfAborted();
  const prepared = await prepareReferences(input.originals, input.parent, conversation, image);
  signal?.throwIfAborted();
  const client = createComfyClient(config.workerUrl);
  try { await client.ready(input.profile); } catch { throw fail('Le PC image est indisponible ou occupé. Fais une nouvelle demande quand il sera disponible.', 503); }
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  let op;
  try {
    op = await ImageOperation.create([{ _id: id, actionKey: body.actionKey, requestHash: input.requestHash,
      ...(conversation && { conversation }), workerSlot: config.workerUrl, workerUrl: config.workerUrl, state: 'accepted', profile: input.profile, request: input.request,
      references: prepared.references, ...(prepared.lineage && { lineage: prepared.lineage }), jobId: id }], { writeConcern: { w: 1, j: true } });
    op = op[0].toObject();
    op.references = prepared.references;
  } catch (error) {
    if (error.code !== 11000) throw error;
    const raced = await ImageOperation.findOne({ actionKey: body.actionKey }).lean();
    if (raced && raced.requestHash === input.requestHash) return publicOperation(raced);
    throw fail('Une image est déjà en cours ou doit être récupérée. Fais une nouvelle demande après sa fin.', 409);
  }
  setImmediate(() => execute(op, config, client).catch(error => logger.error('Local image operation failed', { id, error: error.message })));
  return publicOperation(op);
}
async function archive(id, client, output) {
  const bytes = await client.read(output);
  const decoded = decode(bytes, MAX_OUTPUT_PIXELS);
  const receipt = await defaultArchive().store({ bytes, name: `${id}.png`, origin: 'generated', context: {} });
  if (!receipt) throw new Error('Image archive is disabled');
  return { ...receipt, width: decoded.width, height: decoded.height };
}
async function execute(op, config, client) {
  const start = Date.now();
  let reservation, terminal = true, output, artifact, generationError;
  const cancelled = async () => (await ImageOperation.findById(op._id).select('cancelRequested').lean())?.cancelRequested === true;
  const persist = changes => save(op._id, changes);
  try {
    await persist({ state: 'reserving' });
    reservation = await reserve(config, op, persist, cancelled);
    await client.ready(op.profile);
    const stats = await client.json('/system_stats');
    if (stats.devices?.[0]?.vram_free < stats.devices?.[0]?.vram_total * 0.75) throw new Error('GPU utilisé par une autre application. Nouvelle demande requise.');
    const refs = [];
    for (let i = 0; i < op.references.length; i++) {
      await reservation.assertOwned(); refs.push(await client.upload(Buffer.from(op.references[i]), `agentx-${op._id}-${i}.png`));
    }
    if (await cancelled()) throw Object.assign(new Error('Image request cancelled'), { cancelled: true });
    await persist({ state: 'generating', dispatchStarted: true }); op.dispatchStarted = true;
    await reservation.assertOwned(); terminal = false;
    await client.submit(op.jobId, workflow(op.profile, op.request, refs, op._id));
    output = await client.observe(op.jobId, { timeoutMs: config.timeoutMs, cancelled,
      assertOwned: reservation.assertOwned, onTerminal: async () => { terminal = true; } });
    await persist({ state: 'archiving', output });
    artifact = await archive(op._id, client, output);
    await persist({ artifact });
  } catch (error) { if (error.notSubmitted) terminal = true; generationError = error; }
  if (reservation && terminal) {
    try {
      await persist({ state: 'restoring' });
      await reservation.verified({ jobTerminal: true, dispatched: op.dispatchStarted, hasOutput: Boolean(output) });
      await client.free(reservation.assertOwned);
      await reservation.restore();
      await persist({ runtimeRestored: true });
    } catch (error) { terminal = false; generationError = error; await reservation.quarantine(error.message); }
  } else if (reservation) await reservation.quarantine(generationError?.message || 'Unknown image outcome');
  const state = !terminal || generationError?.runtimeUnknown ? 'unknown' : artifact ? 'completed'
    : output ? 'archive_failed' : generationError?.cancelled ? 'cancelled' : 'failed';
  await save(op._id, { state, error: generationError?.message || null, timings: { totalMs: Date.now() - start } },
    state === 'unknown' ? {} : { workerSlot: 1, references: 1, admission: 1 });
}
async function get(id) {
  await initialize();
  const op = await ImageOperation.findById(id).lean();
  if (!op) throw fail('Opération image inconnue.', 404);
  return publicOperation(op);
}
// The native conversation adapter observes only the already accepted action.
// Reading this receipt does not initialize/recover a worker or dispatch work.
async function getForAction(id, actionKey) {
  const op = await ImageOperation.findOne({ _id: id, actionKey }).lean();
  if (!op) throw fail('Opération image inconnue pour cette demande.', 404);
  return publicOperation(op);
}
function normalizeConversation(conversation) {
  const keys = ['surface', 'sessionId', 'packId', 'scopeId'];
  if (!conversation || !keys.every(key => typeof conversation[key] === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(conversation[key]))) throw fail('Conversation image invalide.');
  return Object.fromEntries(keys.map(key => [key, conversation[key]]));
}
function conversationQuery(conversation) {
  return Object.fromEntries(Object.entries(normalizeConversation(conversation)).map(([key, value]) => [`conversation.${key}`, value]));
}
async function getForConversation(id, conversation) {
  await initialize();
  const op = await ImageOperation.findOne({ _id: id, ...conversationQuery(conversation) }).lean();
  if (!op) throw fail('Image inconnue dans cette conversation.', 404);
  return publicOperation(op);
}
async function listForConversation(conversation) {
  await initialize();
  return (await ImageOperation.find(conversationQuery(conversation)).sort({ createdAt: -1 }).limit(30).lean()).map(publicOperation);
}
async function draft(id) {
  const op = await ImageOperation.findById(id).select('+request').lean();
  if (!op) throw fail('Opération image inconnue.', 404);
  return { ...op.request, profile: op.profile.id };
}
async function list() {
  await initialize();
  return (await ImageOperation.find().sort({ createdAt: -1 }).limit(30).lean()).map(publicOperation);
}
async function cancel(id) {
  await initialize();
  const op = await ImageOperation.findById(id).lean();
  if (!op) throw fail('Opération image inconnue.', 404);
  if (ACTIVE.includes(op.state)) return publicOperation(await save(id, { cancelRequested: true }));
  return publicOperation(op);
}
async function image(id) {
  const op = await ImageOperation.findById(id).lean();
  if (!op?.artifact) throw fail('Image non disponible.', 404);
  const root = path.resolve(process.env.IMAGE_ARCHIVE_DIR);
  const file = path.resolve(root, op.artifact.path);
  if (!file.startsWith(root + path.sep)) throw fail('Invalid artifact path', 500);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size !== op.artifact.size) throw fail('Image archive integrity check failed', 503);
  const bytes = await fs.readFile(file);
  if (hash(bytes) !== op.artifact.sha256) throw fail('Image archive integrity check failed', 503);
  return { bytes, mimeType: op.artifact.mimeType };
}
async function retryArchive(id) {
  const op = await ImageOperation.findById(id).select('+output +workerUrl').lean();
  if (op?.state !== 'archive_failed' || !op.runtimeRestored) throw fail('Cette opération ne permet pas une reprise d’archive.', 409);
  const config = loadConfig();
  if (!config || op.workerUrl !== config.workerUrl) throw fail('Le worker initial doit être configuré pour récupérer cette image.', 409);
  const artifact = await archive(id, createComfyClient(config.workerUrl), op.output);
  return publicOperation(await save(id, { artifact, state: 'completed', error: null }));
}
async function recover(id) {
  await initialize();
  const op = await ImageOperation.findById(id).select('+admission +snapshot +output +workerUrl').lean();
  if (!op) throw fail('Opération image inconnue.', 404);
  const config = loadConfig();
  if (!config) throw fail('Image worker configuration is required', 503);
  if (op.workerUrl !== config.workerUrl) throw fail('Le worker initial doit être configuré pour récupérer cette image.', 409);
  const client = createComfyClient(config.workerUrl);
  const result = await require('./imageRecovery').recoverOperation(op, client,
    (changes, unset) => save(id, changes, unset), output => archive(id, client, output));
  return publicOperation(result);
}
function status() {
  const config = loadConfig();
  const quick = ([config?.conversationProfile, ...Object.keys(config?.profiles || {})]).find(id => {
    const p = config?.profiles[id]; return p?.family === 'klein' && p.steps <= 8;
  });
  const p = config?.profiles[quick];
  return { configured: Boolean(config && defaultArchive().enabled), defaultProfile: config?.defaultProfile || null,
    conversationProfile: p ? { id: quick, width: Math.min(1024, Math.floor(Math.sqrt(p.maxPixels) / 32) * 32), height: Math.min(1024, Math.floor(Math.sqrt(p.maxPixels) / 32) * 32) } : null,
    profiles: Object.entries(config?.profiles || {}).map(([id, p]) => ({ id, label: p.label || id, maxPixels: p.maxPixels, license: p.license || null })) };
}
module.exports = { accept, get, getForAction, getForConversation, listForConversation, draft, list, cancel, image, retryArchive, recover, status, validate, publicOperation };
