'use strict';

// Temporary illustrations belong to their canonical image operation, never to
// the shared content-addressed archive until a specific keep intent is accepted.
const crypto = require('node:crypto');
const Image = require('../../../models/ImageOperation');
const { defaultArchive, createImageArchive } = require('../imageArchive');
const { decode } = require('./codec');
const { withSessionWrite, forSurface } = require('../surfaceConversationService');
const MAX_BYTES = 8 * 1024 * 1024; // Below BSON's 16 MiB bound, including the small request/receipt.
const { MAX_OUTPUT_PIXELS: MAX_PIXELS } = require('./sizes');
const WC = { w: 1, j: true };
const fail = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const scopeQuery = scope => Object.fromEntries(Object.entries(scope).map(([key, value]) => [`conversation.${key}`, value]));
const sessionScope = ({ surface, ...scope }) => scope;
const unkept = { 'illustration.keep': { $exists: false } };
const TTL = 10 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const terminal = ['completed', 'failed', 'cancelled', 'archive_failed'];

function validate(scope, input, body) {
  if (scope?.surface !== 'household' || scope.packId !== 'kidx_nestor' || scope.scopeId !== 'family'
    || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(scope.sessionId || '') || !input
    || (typeof input.epoch !== 'string' || !UUID.test(input.epoch)) || !Number.isFinite(Date.parse(input.expiresAt))
    || new Date(input.expiresAt).toISOString() !== input.expiresAt
    || body.parent || body.references?.length || body.expert || Number(body.width || 1024) * Number(body.height || 1024) > MAX_PIXELS) {
    throw fail('An illustration requires its exact Family session, epoch, expiry and small text-only preset.', 400);
  }
  return { epoch: input.epoch, expiresAt: input.expiresAt };
}

// This is retention metadata only; the existing configured scene mode remains
// the sole controller. New scenes after an explicit end receive a fresh epoch.
async function capture(scope) {
  validate(scope, { epoch: crypto.randomUUID(), expiresAt: new Date().toISOString() }, { width: 768, height: 768 });
  return withSessionWrite(scope.surface, scope.sessionId, async () => {
    const service = forSurface(scope.surface), query = sessionScope(scope);
    const session = await service.getSession(query);
    if (session?.status !== 'active') throw fail('The original conversation ended.');
    let state = session.illustrationRetention;
    const activityExpiry = new Date((Date.parse(session.lastTurnAt) || 0) + TTL).toISOString();
    if (state && !state.endedAt && session.lastTurnAt && new Date(session.lastTurnAt).toISOString() < state.expiresAt && activityExpiry > state.expiresAt) {
      state = { ...state, expiresAt: activityExpiry };
      await service.updateSession(query, { $set: { illustrationRetention: state } });
    }
    if (!state || state.endedAt || state.expiresAt <= new Date().toISOString()) {
      if (state) await expireConversation(scope, new Date().toISOString(), state.epoch);
      state = { epoch: crypto.randomUUID(), expiresAt: new Date(Date.now() + TTL).toISOString() };
      await service.updateSession(query, { $set: { illustrationRetention: state } });
    }
    return { epoch: state.epoch, expiresAt: state.expiresAt };
  });
}

async function touch(scope, at) {
  if (scope.surface !== 'household' || scope.packId !== 'kidx_nestor' || scope.scopeId !== 'family') return;
  return withSessionWrite(scope.surface, scope.sessionId, async () => {
    const service = forSurface(scope.surface), query = sessionScope(scope);
    const session = await service.getSession(query), state = session?.illustrationRetention;
    if (session?.status !== 'active' || !state || state.endedAt) return;
    if (!Number.isFinite(Date.parse(at)) || state.expiresAt <= new Date(at).toISOString()) return;
    const expiresAt = new Date(Math.max(Date.parse(at) + TTL, Date.parse(state.expiresAt))).toISOString();
    await service.updateSession(query, { $set: { 'illustrationRetention.expiresAt': expiresAt } });
    await Image.updateMany({ ...scopeQuery(scope), 'illustration.epoch': state.epoch, ...unkept,
      'illustration.contentRemovedAt': { $exists: false } }, { $set: { 'illustration.expiresAt': expiresAt } }, { writeConcern: WC });
  });
}

async function endReceipt(scope, requestId) {
  if (typeof requestId !== 'string' || !UUID.test(requestId)) throw fail('A stable end identity is required.', 400);
  const row = await Image.findOne({ ...scopeQuery(scope), 'illustration.end.requestId': requestId }).select('illustration.end').lean();
  return row?.illustration?.end || null;
}

async function end(scope, { epoch, requestId } = {}) {
  if (typeof epoch !== 'string' || typeof requestId !== 'string' || !UUID.test(epoch) || !UUID.test(requestId)) throw fail('An exact retention epoch and request identity are required.', 400);
  return withSessionWrite(scope.surface, scope.sessionId, async () => {
    const prior = await endReceipt(scope, requestId);
    if (prior && prior.epoch !== epoch) throw fail('End identity belongs to another epoch.');
    const anchor = await Image.findOne({ ...scopeQuery(scope), 'illustration.epoch': epoch }).sort({ createdAt: 1, _id: 1 }).lean();
    if (!anchor) throw fail('Unknown retention epoch.', 404);
    if (anchor.illustration.end && anchor.illustration.end.requestId !== requestId) {
      return { alreadyEnded: true, epoch, originalRequestId: anchor.illustration.end.requestId };
    }
    const receipt = prior || { requestId, epoch, state: 'accepted' };
    await Image.updateOne({ _id: anchor._id }, { $set: { 'illustration.end': receipt } }, { writeConcern: WC });
    const service = forSurface(scope.surface), query = sessionScope(scope);
    await service.updateSession({ ...query, 'illustrationRetention.epoch': epoch },
      { $set: { 'illustrationRetention.endedAt': new Date().toISOString() } });
    await expireConversation(scope, new Date().toISOString(), epoch);
    receipt.state = 'completed';
    await Image.updateOne({ _id: anchor._id }, { $set: { 'illustration.end': receipt } }, { writeConcern: WC });
    return { receipt };
  });
}

async function keepReceipt(id, scope, requestId) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{16,160}$/.test(requestId)) throw fail('A stable keep identity is required.', 400);
  const row = await Image.findOne({ _id: id, ...scopeQuery(scope), 'illustration.keep.requestId': requestId }).select('illustration.keep').lean();
  return row ? { requestId, imageId: id, state: row.illustration.keep.state } : null;
}

async function resumeKeeps() {
  const rows = await Image.find({ 'illustration.keep.state': 'accepted' }).select('_id conversation illustration.keep').sort({ 'illustration.keep.attemptAt': 1 }).limit(20).lean();
  for (const row of rows) {
    await Image.updateOne({ _id: row._id }, { $set: { 'illustration.keep.attemptAt': new Date().toISOString() } });
    try { await keep(row._id, row.conversation, row.illustration.keep.requestId); } catch { /* Original intent remains retryable. */ }
  }
  const ends = await Image.find({ 'illustration.end.state': 'accepted' }).select('_id conversation illustration.end').sort({ 'illustration.endAttemptAt': 1 }).limit(20).lean();
  for (const row of ends) {
    await Image.updateOne({ _id: row._id }, { $set: { 'illustration.endAttemptAt': new Date().toISOString() } });
    try { await end(row.conversation, row.illustration.end); } catch { /* The same durable end remains pending. */ }
  }
}

async function live(op) {
  if (await Image.exists({ ...scopeQuery(op.conversation), 'illustration.epoch': op.illustration.epoch, 'illustration.end': { $exists: true } })) return false;
  const session = await forSurface(op.conversation.surface).getSession(sessionScope(op.conversation));
  const row = await Image.findOne({ _id: op._id, 'illustration.epoch': op.illustration.epoch,
    'illustration.expiresAt': { $gt: new Date().toISOString() }, cancelRequested: { $ne: true } }).select('_id').lean();
  return Boolean(row && session?.status === 'active' && !session.illustrationRetention?.endedAt
    && session.illustrationRetention?.epoch === op.illustration.epoch);
}

async function createOperation(record) {
  return withSessionWrite(record.conversation.surface, record.conversation.sessionId, async () => {
    const session = await forSurface(record.conversation.surface).getSession(sessionScope(record.conversation));
    if (await Image.exists({ ...scopeQuery(record.conversation), 'illustration.epoch': record.illustration.epoch, 'illustration.end': { $exists: true } })
      || session?.status !== 'active' || session.illustrationRetention?.endedAt
      || session.illustrationRetention?.epoch !== record.illustration.epoch
      || record.illustration.expiresAt <= new Date().toISOString()) {
      throw Object.assign(fail('The original illustration session ended before acceptance.'), { notSubmitted: true });
    }
    return (await Image.create([record], { writeConcern: WC }))[0];
  });
}

async function persistExecution(op, changes) {
  return withSessionWrite(op.conversation.surface, op.conversation.sessionId, async () => {
    if (!await live(op)) return null;
    return Image.findOneAndUpdate({ _id: op._id, cancelRequested: { $ne: true },
      'illustration.expiresAt': { $gt: new Date().toISOString() } }, { $set: changes },
    { new: true, writeConcern: WC }).select('+execution').lean();
  });
}

async function submit(op, effect) {
  await withSessionWrite(op.conversation.surface, op.conversation.sessionId, async () => {
    const prior = await Image.findById(op._id).select('illustration.submission').lean();
    if (prior?.illustration?.submission) throw Object.assign(fail('The original illustration send was already admitted; reconcile its own result.'), { runtimeUnknown: true });
    if (!await live(op)) throw Object.assign(fail('The illustration session ended before dispatch.'), { cancelled: true, notSubmitted: true });
    const admitted = await Image.updateOne({ _id: op._id, state: 'generating', dispatchStarted: true,
      'execution.graphSha256': op.executionSha256, 'illustration.submission': { $exists: false },
      'illustration.expiresAt': { $gt: new Date().toISOString() }, cancelRequested: { $ne: true } },
    { $set: { 'illustration.submission': { requestId: op._id, epoch: op.illustration.epoch,
      executionSha256: op.executionSha256, admittedAt: new Date().toISOString() } } }, { writeConcern: WC });
    if (!admitted.matchedCount) {
      const raced = await Image.findById(op._id).select('illustration.submission').lean();
      if (raced?.illustration?.submission) throw Object.assign(fail('The original illustration send is already admitted.'), { runtimeUnknown: true });
      throw Object.assign(fail('Illustration admission expired before dispatch.'), { cancelled: true, notSubmitted: true });
    }
  });
  // The exact send now owns its admission. Transport and worker startup never
  // hold the conversation's write fence; a later erasure cancels that same job.
  return effect();
}

async function retain(id, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES) throw fail('Temporary illustration exceeds its storage bound.', 413);
  const dimensions = decode(bytes, MAX_PIXELS);
  const artifact = { sha256: hash(bytes), size: bytes.length, mimeType: dimensions.mimeType,
    width: dimensions.width, height: dimensions.height, temporary: true };
  const op = await Image.findById(id).lean();
  if (!op?.illustration || !op.conversation) throw fail('Unknown temporary illustration.');
  await Image.updateOne({ _id: id }, { $set: { 'illustration.outputHash': artifact.sha256 } }, { writeConcern: WC });
  await withSessionWrite(op.conversation.surface, op.conversation.sessionId, async () => {
    const session = await forSurface(op.conversation.surface).getSession(sessionScope(op.conversation));
    const active = session?.status === 'active' && !session.illustrationRetention?.endedAt
      && session.illustrationRetention?.epoch === op.illustration.epoch;
    if (!active || !await live(op)) return;
    const retained = await Image.updateOne({ _id: id, ...unkept, 'illustration.expiresAt': { $gt: new Date().toISOString() },
      $expr: { $lt: [{ $add: [{ $bsonSize: '$$ROOT' }, bytes.length] }, 15 * 1024 * 1024] } },
    { $set: { temporaryImage: bytes, 'illustration.contentRetained': true } }, { writeConcern: WC });
    if (!retained.matchedCount && op.illustration.expiresAt > new Date().toISOString()) throw fail('Temporary illustration document exceeds its storage bound.', 413);
  });
  return artifact;
}

async function read(op) {
  if (!op?.illustration || op.illustration.keep?.state === 'completed') return defaultArchive().read(op.artifact);
  const stored = await Image.findById(op._id).select('+temporaryImage').lean();
  const bytes = stored?.temporaryImage && (Buffer.isBuffer(stored.temporaryImage)
    ? stored.temporaryImage : Buffer.from(stored.temporaryImage.buffer || stored.temporaryImage));
  if (!bytes || !stored.artifact || bytes.length > MAX_BYTES || bytes.length !== stored.artifact.size
    || hash(bytes) !== stored.artifact.sha256
    || !stored.illustration.keep && stored.illustration.expiresAt <= new Date().toISOString()) throw fail('Illustration unavailable.', 404);
  decode(bytes, MAX_PIXELS);
  return { bytes, mimeType: stored.artifact.mimeType };
}

async function keep(id, scope, requestId) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9:_-]{16,160}$/.test(requestId)) throw fail('A stable keep identity is required.', 400);
  return withSessionWrite(scope.surface, scope.sessionId, async () => {
    let op = await Image.findOne({ _id: id, ...scopeQuery(scope), illustration: { $exists: true } }).select('+temporaryImage').lean();
    if (!op || op.state !== 'completed' || op.runtimeRestored !== true) throw fail('Only a completed illustration can be kept.');
    if (op.illustration.keep && op.illustration.keep.requestId !== requestId) throw fail('This illustration already has its own keep intent.');
    if (op.illustration.keep?.state === 'completed') return { id, kept: true, requestId };
    if (!op.illustration.keep) {
      const session = await forSurface(scope.surface).getSession(sessionScope(scope));
      if (session?.status !== 'active' || session.illustrationRetention?.epoch !== op.illustration.epoch || !await live(op)) throw fail('The original illustration session has ended.');
      const claimed = await Image.findOneAndUpdate({ _id: id, ...unkept,
        'illustration.expiresAt': { $gt: new Date().toISOString() }, temporaryImage: { $exists: true } },
      { $set: { 'illustration.keep': { requestId, state: 'accepted', acceptedAt: new Date().toISOString(), sha256: op.artifact.sha256 } } },
      { new: true, writeConcern: WC }).select('+temporaryImage').lean();
      if (!claimed) throw fail('The temporary illustration expired before keep was accepted.');
      op = claimed;
    }
    const original = await read(op);
    // The original acceptance time fixes the archive month across lost replies.
    const archive = createImageArchive({ dir: process.env.IMAGE_ARCHIVE_DIR, now: () => new Date(op.illustration.keep.acceptedAt) });
    const artifact = await archive.store({ bytes: original.bytes, name: `${id}.png`, origin: 'generated', context: {} });
    if (!artifact || artifact.sha256 !== op.illustration.keep.sha256) throw fail('The original keep archive could not be verified.');
    const saved = await Image.findOneAndUpdate({ _id: id, 'illustration.keep.requestId': requestId, 'illustration.keep.state': 'accepted' },
      { $set: { artifact: { ...artifact, width: op.artifact.width, height: op.artifact.height },
        'illustration.keep.state': 'completed' }, $unset: { temporaryImage: 1 } }, { new: true, writeConcern: WC }).lean();
    if (!saved) throw fail('Keep result is uncertain. Read the original keep identity.');
    return { id, kept: true, requestId };
  });
}

async function expireConversation(scope, at = new Date().toISOString(), epoch = null) {
  // Coordination receipts survive. An already accepted keep intent owns its
  // original copy even when the conversation ends before its reply arrives.
  return Image.updateMany({ ...scopeQuery(scope), illustration: { $exists: true }, ...(epoch && { 'illustration.epoch': epoch }), ...unkept },
    { $set: { 'illustration.expiresAt': at, 'illustration.contentRemovedAt': at, 'illustration.contentRetained': false, cancelRequested: true },
      $unset: { temporaryImage: 1, 'request.prompt': 1, 'request.visualPrompt': 1, 'execution.graph': 1 } }, { writeConcern: WC });
}

async function expireImage(id, scope, at = new Date().toISOString()) {
  return Image.updateOne({ _id: id, ...scopeQuery(scope), illustration: { $exists: true }, ...unkept },
    { $set: { 'illustration.expiresAt': at, 'illustration.contentRemovedAt': at, 'illustration.contentRetained': false },
      $unset: { temporaryImage: 1, 'request.prompt': 1, 'request.visualPrompt': 1, 'execution.graph': 1 } }, { writeConcern: WC });
}

async function expireDue() {
  const rows = await Image.find({ illustration: { $exists: true }, ...unkept,
    'illustration.expiresAt': { $lte: new Date().toISOString() },
    $or: [{ temporaryImage: { $exists: true } }, { 'request.prompt': { $exists: true } }, { 'execution.graph': { $exists: true } }] })
    .select('_id conversation illustration.epoch').limit(100).lean();
  for (const row of rows) await withSessionWrite(row.conversation.surface, row.conversation.sessionId, async () => {
    const session = await forSurface(row.conversation.surface).getSession(sessionScope(row.conversation));
    const state = session?.illustrationRetention;
    // The transcript's canonical human activity also repairs a crash between
    // recordTurn and the best-effort retention extension. Never revive erased bytes.
    const canonicalExpiry = new Date((Date.parse(session?.lastTurnAt) || 0) + TTL).toISOString();
    const closed = await Image.exists({ ...scopeQuery(row.conversation), 'illustration.epoch': row.illustration.epoch,
      'illustration.end': { $exists: true } });
    if (session?.status === 'active' && state?.epoch === row.illustration.epoch && !state.endedAt && !closed
      && session.lastTurnAt && new Date(session.lastTurnAt).toISOString() < state.expiresAt
      && canonicalExpiry > new Date().toISOString()) {
      await Image.updateOne({ _id: row._id, ...unkept, 'illustration.contentRemovedAt': { $exists: false } },
        { $max: { 'illustration.expiresAt': canonicalExpiry } }, { writeConcern: WC });
      return;
    }
    await Image.updateOne({ _id: row._id, ...unkept, 'illustration.expiresAt': { $lte: new Date().toISOString() } },
      { $set: { 'illustration.contentRemovedAt': new Date().toISOString(), 'illustration.contentRetained': false, cancelRequested: true },
        $unset: { temporaryImage: 1, 'request.prompt': 1, 'request.visualPrompt': 1, 'execution.graph': 1 } }, { writeConcern: WC });
  });
}

async function discardWorkerOutput(op, client) {
  if (!op?.illustration || !op.output || !terminal.includes(op.state) || op.illustration.workerRemoval?.removed) return;
  await Image.updateOne({ _id: op._id }, { $set: { 'illustration.workerRemovalAttemptAt': new Date().toISOString() } }, { writeConcern: WC });
  try {
    const stored = await Image.findById(op._id).select('illustration.outputHash').lean();
    const sha256 = op.artifact?.sha256 || stored?.illustration?.outputHash;
    const receipt = await client.discardOutput(op.jobId, sha256);
    if (receipt?.contract !== 'agentx.image-output-removal/v1' || receipt.jobId !== op.jobId
      || receipt.sha256 !== sha256 || receipt.removed !== true) throw fail('Unverified worker output removal.');
    await Image.updateOne({ _id: op._id, jobId: op.jobId }, { $set: { 'illustration.workerRemoval': receipt },
      $unset: { 'illustration.workerRemovalPending': 1 } }, { writeConcern: WC });
  } catch {
    await Image.updateOne({ _id: op._id }, { $set: { 'illustration.workerRemovalPending': true } }, { writeConcern: WC });
  }
}

module.exports = { capture, touch, end, endReceipt, keepReceipt, resumeKeeps, MAX_BYTES, MAX_PIXELS, validate, retain, read, keep, expireConversation, expireImage, expireDue,
  discardWorkerOutput, persistExecution, submit, createOperation };
