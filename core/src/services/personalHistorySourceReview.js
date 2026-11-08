'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const privacy = require('./personalHistoryPrivacy');
const { sealText } = require('./identifierVault');
const { digest, failure, basis, collect, describe, initialCoverage, coverageOf } = require('./personalHistorySourceReviewSources');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^[a-f0-9]{24}$/;
const LIMIT = 20;
const unavailable = () => failure('The historical source review is unavailable.', 404, 'HISTORY_SOURCE_REVIEW_UNAVAILABLE');

function owner(deps) {
  if (deps?.audience !== 'owner') throw failure('Source reviews belong to the owner human surface.', 403, 'HISTORY_SOURCE_REVIEW_SCOPE');
}
function strict(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw failure('Use only the displayed source review fields.', 400, 'HISTORY_SOURCE_REVIEW_INVALID');
  }
}
function requestId(value) {
  if (!UUID.test(value || '')) throw failure('Retain the original UUID for this review request.', 400, 'HISTORY_SOURCE_REVIEW_INVALID');
}
function mail(deps) { return deps.mail || new (require('../../integrations/runtime-bridges/secretary-mail-control').SecretaryMailControl)(); }
async function load(id) {
  if (!ID.test(id || '')) throw unavailable();
  const row = await Entry.findOne({ _id: id, scope: 'owner', reviewState: { $ne: 'forgotten' } }).lean();
  if (!row) throw unavailable();
  if (await privacy.forgottenSource({ noteId: row.source?.personalNoteId, contentHash: row.contentHash })) {
    await privacy.suppress({ _id: row._id }); throw unavailable();
  }
  return row;
}
function find(row, id) {
  const review = (row.sourceReviews || []).find(review => review.requestId === id);
  if (!review) throw unavailable();
  if (digest(review.snapshot) !== review.snapshotHash) throw failure('The stored source review snapshot failed its integrity check.', 500, 'HISTORY_SOURCE_REVIEW_INTEGRITY');
  if (review.decisionIntent && digest(review.decisionIntent.input) !== review.decisionIntent.inputHash) {
    throw failure('The stored pending decision failed its integrity check.', 500, 'HISTORY_SOURCE_REVIEW_INTEGRITY');
  }
  return review;
}
function fence(row) {
  return { _id: row._id, scope: 'owner', reviewState: { $ne: 'forgotten' }, revision: row.revision,
    ...(row.context ? { 'context.revision': row.context.revision, 'context.inputHash': row.context.inputHash }
      : { context: null }) };
}
function current(row, review) {
  return basis(row) === (review.decision?.basisAfterHash || review.basisHash);
}
function historyOf(row) {
  return (row.sourceReviews || []).map(review => ({ requestId: review.requestId, preparedAt: review.preparedAt,
    decision: review.decision?.decision || null, decidedAt: review.decision?.at || null, entryCurrent: current(row, review) }));
}
function view(row, review, nativeState = 'not_rechecked') {
  return { requestId: review.requestId, entryRevision: review.entryRevision, snapshotHash: review.snapshotHash,
    preparedAt: review.preparedAt, scope: review.snapshot.scope, sources: review.snapshot.sources,
    coverage: coverageOf(review), progress: review.coverage, decision: review.decision || null,
    decisionIntent: review.decisionIntent || null, history: historyOf(row),
    entryCurrent: current(row, review), nativeState, executionAllowed: false,
    identity: 'Private LAN surface; no authenticated person or independent reviewer is established.' };
}
function summary(row) {
  const review = (row.sourceReviews || []).at(-1);
  return !review || row.reviewState === 'forgotten' ? null : {
    requestId: review.requestId, preparedAt: review.preparedAt, entryRevision: review.entryRevision,
    entryCurrent: current(row, review), coverage: coverageOf(review), decision: review.decision || null,
    nativeState: 'not_rechecked', executionAllowed: false, history: historyOf(row)
  };
}
async function latest(row, review) {
  const fresh = await load(String(row._id));
  if (!current(fresh, review)) throw failure('The assertion or its context changed; prepare a new review.');
  return fresh;
}

async function prepare(id, input, deps) {
  owner(deps); strict(input, ['requestId', 'revision']); requestId(input.requestId);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw failure('The displayed entry revision is required.', 400);
  const row = await load(id);
  const transportKey = digest(input.requestId);
  if (await Entry.exists({ scope: 'owner', _id: { $ne: row._id }, sourceReviewRequestKeys: transportKey })) {
    throw failure('This request identity belongs to another historical assertion.');
  }
  const old = (row.sourceReviews || []).find(review => review.requestId === input.requestId);
  if (old) {
    find(row, input.requestId);
    if (old.entryRevision !== input.revision) throw failure('This request identity has another entry revision.');
    await latest(row, old);
    return { replayed: true, review: view(row, old) };
  }
  if (row.revision !== input.revision) throw failure('The historical assertion changed; reload it.');
  if ((row.sourceReviews || []).length >= LIMIT) throw failure('Source review capacity reached; retain the existing review history.', 409);
  const snapshot = await collect(row, mail(deps));
  await latest(row, { basisHash: basis(row) });
  const review = { requestId: input.requestId, entryRevision: row.revision, basisHash: basis(row),
    contextRevision: row.context?.revision || 0, contextHash: row.context?.inputHash || '',
    snapshot, snapshotHash: digest(snapshot), preparedAt: new Date(), coverage: initialCoverage(snapshot), readRevision: 0, decisionIntent: null, decision: null };
  let saved;
  try { saved = await Entry.findOneAndUpdate({ ...fence(row), sourceReviewRequestKeys: { $ne: transportKey },
    $expr: { $lt: [{ $size: { $ifNull: ['$sourceReviews', []] } }, LIMIT] } },
  { $push: { sourceReviews: review }, $addToSet: { sourceReviewRequestKeys: transportKey } }, { new: true, runValidators: true }).lean(); }
  catch (error) {
    if (error.code === 11000) throw failure('This request identity belongs to another historical assertion.');
    throw error;
  }
  if (!saved) {
    const fresh = await load(id), existing = find(fresh, input.requestId);
    if (existing.entryRevision !== input.revision) throw failure('This request identity has another entry revision.');
    await latest(fresh, existing);
    return { replayed: true, review: view(fresh, existing) };
  }
  // The privacy owner can erase independently while native reads are pending.
  const fresh = await latest(saved, review);
  return { replayed: false, review: view(fresh, find(fresh, input.requestId), 'observed') };
}

async function get(id, key, deps) {
  owner(deps); requestId(key);
  let row;
  try { row = await load(id); }
  catch (error) {
    // A retained opaque transport fence can confirm erasure without returning
    // the forgotten snapshot or reason, including for an uncertain client write.
    if (error.statusCode === 404 && ID.test(id || '') && await Entry.exists({ _id: id, scope: 'owner',
      reviewState: 'forgotten', sourceReviewRequestKeys: digest(key) })) return { erased: true, requestId: key, executionAllowed: false };
    throw error;
  }
  const review = find(row, key);
  if (!current(row, review)) return { review: view(row, review, 'stale') };
  const observed = await collect(row, mail(deps));
  const fresh = await latest(row, review);
  return { review: view(fresh, find(fresh, key), digest(observed) === review.snapshotHash ? 'observed' :
    observed.sources.some(source => source.status === 'unavailable') ? 'unknown' : 'stale') };
}

async function page(id, key, input, deps) {
  owner(deps); requestId(key); strict(input, ['source', 'part', 'offset']);
  if (![input.source, input.part, input.offset].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw failure('Choose an exact source, text part and continuation offset.', 400);
  }
  const row = await load(id), review = find(row, key);
  if (!current(row, review) || review.decision) throw failure('Read the current undecided source review.');
  const source = review.snapshot.sources[input.source];
  const progress = review.coverage.find(p => p.source === input.source && p.part === input.part);
  if (!source || source.status !== 'available' || !progress || input.offset > progress.nextOffset) {
    throw failure('Follow the recorded source reading continuation; pages cannot be skipped.', 400);
  }
  const result = await mail(deps).archived({ messageId: source.reference.messageId, sha256: source.reference.sourceSha256,
    part: input.part, offset: input.offset });
  if (digest(describe(source.reference, result)) !== digest(source)) throw failure('The native source version changed.');
  const part = source.parts.find(part => part.partIndex === input.part);
  const end = result.nextOffset === null ? part.totalChars : result.nextOffset;
  if (result.bodyReadable !== true || result.selectedPartIndex !== input.part || result.offset !== input.offset || result.totalChars !== part.totalChars
    || !Number.isSafeInteger(end) || end < input.offset || end > part.totalChars
    || (end === input.offset && end !== part.totalChars) || typeof result.body !== 'string'
    || Array.from(result.body).length !== end - input.offset || result.bodyTruncated !== (end < part.totalChars)) {
    throw failure('The native reader did not confirm the exact source page.');
  }
  if (progress.served && end <= progress.nextOffset) {
    const fresh = await latest(row, review);
    return { page: { source: input.source, part: input.part, offset: input.offset, nextOffset: result.nextOffset, body: result.body },
      review: view(fresh, find(fresh, key), 'observed'), replayed: true };
  }
  const coverage = review.coverage.map(p => p === progress ? { ...p, nextOffset: Math.max(p.nextOffset, end), served: true } : p);
  const saved = await Entry.findOneAndUpdate({ ...fence(row), sourceReviews: { $elemMatch: {
    requestId: key, snapshotHash: review.snapshotHash, readRevision: review.readRevision, decision: null } } },
  { $set: { 'sourceReviews.$.coverage': coverage }, $inc: { 'sourceReviews.$.readRevision': 1 } }, { new: true, runValidators: true }).lean();
  if (!saved) { await load(id); throw failure('The source reading state changed; reconcile this same review.'); }
  const fresh = await latest(saved, review);
  return { page: { source: input.source, part: input.part, offset: input.offset, nextOffset: result.nextOffset, body: result.body },
    review: view(fresh, find(fresh, key), 'observed') };
}

async function decide(id, key, input, deps) {
  owner(deps); requestId(key);
  const referenceOnly = typeof input?.intentHash === 'string';
  strict(input, referenceOnly ? ['intentHash'] : ['snapshotHash', 'revision', 'decision', 'reason']);
  if (referenceOnly ? !/^[a-f0-9]{64}$/.test(input.intentHash) : !/^[a-f0-9]{64}$/.test(input.snapshotHash || '') || !Number.isSafeInteger(input.revision)
    || !['reviewed_scope', 'needs_follow_up'].includes(input.decision) || typeof input.reason !== 'string'
    || !input.reason.trim() || input.reason.length > 2000) throw failure('Choose the displayed review scope, revision and explicit decision.', 400);
  const row = await load(id), review = find(row, key);
  const intentHash = referenceOnly ? input.intentHash : digest(input);
  if (review.decision) {
    if (review.decision.intentHash !== intentHash) throw failure('This source review already has a different decision.');
    const fresh = await load(id);
    return { replayed: true, receipt: find(fresh, key).decision, review: view(fresh, find(fresh, key)) };
  }
  if (!review.decisionIntent) {
    if (referenceOnly) throw failure('The original intent is not yet observed; reconcile it without replacing its contents.', 409, 'HISTORY_SOURCE_REVIEW_INTENT_UNKNOWN');
    if (!current(row, review) || input.revision !== review.entryRevision || input.snapshotHash !== review.snapshotHash) {
      throw failure('The assertion or displayed source review changed.');
    }
    if (input.decision === 'reviewed_scope' && coverageOf(review).status !== 'served_selected_text') {
      throw failure('Complete the selected text reading or record the remaining work.', 409, 'HISTORY_SOURCE_REVIEW_INCOMPLETE');
    }
    const reason = (await sealText(input.reason.trim(), { seenIn: 'history-source-review' })).text;
    await latest(row, review);
    const retainedInput = { ...input, reason };
    const decisionIntent = { intentHash, input: retainedInput, inputHash: digest(retainedInput), at: new Date(), executionAllowed: false };
    const reserved = await Entry.findOneAndUpdate({ ...fence(row), sourceReviews: { $elemMatch: {
      requestId: key, snapshotHash: review.snapshotHash, readRevision: review.readRevision, decisionIntent: null, decision: null } } },
    { $set: { 'sourceReviews.$.decisionIntent': decisionIntent } }, { new: true, runValidators: true }).lean();
    if (!reserved) {
      const fresh = await load(id), prior = find(fresh, key);
      if (prior.decision?.intentHash !== intentHash && prior.decisionIntent?.intentHash !== intentHash) {
        throw failure('The assertion or pending intent changed before reservation.');
      }
    }
    return decide(id, key, { intentHash }, deps);
  }
  if (review.decisionIntent.intentHash !== intentHash) throw failure('This source review retains a different pending intent.');
  input = review.decisionIntent.input;
  if (!current(row, review) || input.revision !== review.entryRevision || input.snapshotHash !== review.snapshotHash) {
    throw failure('The assertion or displayed source review changed.');
  }
  if (input.decision === 'reviewed_scope' && coverageOf(review).status !== 'served_selected_text') {
    throw failure('Complete the selected text reading or record the remaining work.', 409, 'HISTORY_SOURCE_REVIEW_INCOMPLETE');
  }
  const observed = await collect(row, mail(deps));
  // Another retry can finish this same reserved intent while the original
  // native read is still pending. Its receipt is terminal for that identity.
  const reconciled = await load(id), prior = find(reconciled, key);
  if (prior.decision?.intentHash === intentHash) return { replayed: true, receipt: prior.decision, review: view(reconciled, prior) };
  if (digest(observed) !== review.snapshotHash) throw failure('The native sources changed or became unavailable; nothing was accepted.');
  if (!current(reconciled, review)) throw failure('The assertion or its context changed; prepare a new review.');
  const receipt = { requestId: key, snapshotHash: review.snapshotHash, intentHash, decision: input.decision, reason: input.reason,
    at: new Date(), entryRevision: row.revision, resultingRevision: row.revision + 1,
    basisAfterHash: basis({ ...row, revision: row.revision + 1 }), coverage: coverageOf(review),
    recordedVia: 'private_lan_surface', authenticatedPerson: null, executionAllowed: false };
  const saved = await Entry.findOneAndUpdate({ ...fence(row), sourceReviews: { $elemMatch: {
    requestId: key, snapshotHash: review.snapshotHash, readRevision: review.readRevision, 'decisionIntent.intentHash': intentHash, decision: null } } },
  { $set: { 'sourceReviews.$.decision': receipt }, $inc: { revision: 1 } }, { new: true, runValidators: true }).lean();
  if (!saved) {
    const fresh = await load(id), prior = find(fresh, key);
    if (prior.decision?.intentHash === intentHash) return { replayed: true, receipt: prior.decision, review: view(fresh, prior) };
    throw failure('The assertion or source review changed before its decision.');
  }
  const fresh = await load(id), committed = find(fresh, key);
  return { replayed: false, receipt: committed.decision, review: view(fresh, committed, 'observed') };
}

module.exports = { prepare, get, page, decide, summary };
