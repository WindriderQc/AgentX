'use strict';
// Photo admission shares the existing runtime CAS document with its writers.
// Pausing never releases an admitted writer, changes its queue or expires.
const crypto = require('node:crypto');
const Runtime = require('../../../models/RuntimeCoordination');
const { ensureDocument } = require('../runtimeCoordinationState');
const { fail } = require('./importFiles');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESUME = 'RESUME_PHOTO_PROCESSING';
const WC = { w: 1, j: true };
const invalid = message => fail('PHOTO_CONTROL_INVALID', message);
const conflict = () => fail('PHOTO_CONTROL_CONFLICT', 'Photo control changed; read it before another explicit action');
const selection = { photoProcessingControl: 1, coreWriters: 1 };

function savedControl(row) {
  const value = row?.photoProcessingControl;
  if (value === undefined) return { version: 1, revision: 0, paused: false };
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.paused !== 'boolean' || !UUID.test(value.requestId || '')
    || !/^[a-f0-9]{64}$/.test(value.inputHash || '') || typeof value.principal !== 'string'
    || !value.principal || value.principal.length > 160
    || !(value.changedAt instanceof Date || typeof value.changedAt === 'string' && value.changedAt.length > 0)
    || !Number.isFinite(new Date(value.changedAt).getTime()))
    throw invalid('The durable photo control needs operator reconciliation');
  return value;
}

function snapshot(row) {
  const control = savedControl(row);
  const inFlight = (row?.coreWriters || []).filter(w => w.kind === 'photo-processing')
    .map(w => ({ operationId: w.operationId, queueId: w.queueId, state: w.state }));
  return { contract: 'agentx.photo-processing-control/v1', version: 1,
    revision: control.revision, paused: control.paused, acceptsNewBatches: !control.paused,
    inFlight, drained: inFlight.length === 0,
    ...(control.requestId && { requestId: control.requestId, inputHash: control.inputHash,
      principal: control.principal, changedAt: control.changedAt }) };
}

// Missing is the legacy, open state. A malformed stored control fails closed.
// This predicate is committed in the same Mongo document as writer admission.
function admissionFilter() {
  return { $or: [{ photoProcessingControl: { $exists: false } },
    { 'photoProcessingControl.version': 1, 'photoProcessingControl.paused': false,
      'photoProcessingControl.revision': { $gte: 1 } }] };
}

function createPhotoProcessingControl(deps = {}) {
  const model = deps.runtime || Runtime, ensure = deps.ensureDocument || ensureDocument;
  const read = () => model.findById('runtime').select(selection).lean();
  async function status() { return snapshot(await read()); }
  async function isPaused() { return (await status()).paused; }
  async function assertOpen() {
    if (await isPaused()) throw fail('PHOTO_PROCESSING_PAUSED', 'Photo processing is paused until an explicit owner resume');
  }
  async function change(input, principal, paused) {
    const fields = paused ? ['expectedRevision', 'requestId'] : ['confirmation', 'expectedRevision', 'requestId'];
    if (!input || Object.keys(input).sort().join() !== fields.join()
      || !UUID.test(input.requestId || '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || (!paused && input.confirmation !== RESUME) || typeof principal !== 'string'
      || !principal.trim() || principal.trim().length > 160 || /[\x00-\x1f]/.test(principal))
      throw invalid('Supply one request identity, current revision and explicit resume confirmation when resuming');
    principal = principal.trim();
    const requestId = input.requestId.toLowerCase();
    const inputHash = crypto.createHash('sha256').update(JSON.stringify({ requestId,
      expectedRevision: input.expectedRevision, paused, principal,
      ...(!paused && { confirmation: input.confirmation }) })).digest('hex');
    await ensure();
    const beforeRow = await read(), before = savedControl(beforeRow);
    const same = value => value.requestId === requestId && value.inputHash === inputHash;
    if (before.requestId === requestId) {
      if (!same(before)) throw conflict();
      return { ...snapshot(beforeRow), idempotent: true };
    }
    if (before.revision !== input.expectedRevision || before.revision >= Number.MAX_SAFE_INTEGER) throw conflict();
    const control = { version: 1, revision: before.revision + 1, paused, requestId, inputHash,
      principal, changedAt: new Date() };
    const filter = before.revision === 0 ? { photoProcessingControl: { $exists: false } }
      : { 'photoProcessingControl.revision': before.revision, 'photoProcessingControl.requestId': before.requestId };
    // Fixed, validated paths also support staging this exact owner artifact on
    // a legacy model before first installation. No loaded server is patched.
    const row = await model.findOneAndUpdate({ _id: 'runtime', ...filter },
      { $set: { photoProcessingControl: control } },
      { new: true, strict: false, strictQuery: false, writeConcern: WC }).select(selection).lean();
    if (row) {
      const retained = savedControl(row);
      if (!same(retained) || retained.revision !== control.revision || retained.paused !== paused)
        throw fail('PHOTO_CONTROL_RECEIPT_UNAVAILABLE', 'Observe the original photo control request before any retry');
      return { ...snapshot(row), idempotent: false };
    }
    const after = await read();
    if (same(savedControl(after))) return { ...snapshot(after), idempotent: true };
    throw conflict();
  }
  return { status, isPaused, assertOpen,
    pause: (input, principal) => change(input, principal, true),
    resume: (input, principal) => change(input, principal, false) };
}

module.exports = { ...createPhotoProcessingControl(), createPhotoProcessingControl, admissionFilter, RESUME };
