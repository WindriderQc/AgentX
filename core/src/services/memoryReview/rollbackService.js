'use strict';

const MemoryReviewRun = require('../../../models/MemoryReviewRun');
const { personal } = require('../memoryNoteService');
const policy = require('./policy');
const { redact } = require('./contentGuard');

// The existing operator boundary owns rollback. No automatic or agent tool
// receives this mutation; the exact reviewed replacement is its durable key.
async function rollbackCandidate(runId, candidateId, { by, ownerNotes = personal() } = {}) {
  const refuse = (message, status = 409) => new policy.MemoryReviewError(message, { status });
  if (policy.serverMode() !== 'apply') throw refuse('Rollback requires server apply mode', 403);
  const reviewer = String(by || '').trim().slice(0, 64);
  if (!reviewer) throw refuse('Rollback requires an operator identity', 400);
  let run = await MemoryReviewRun.findOne({ runId });
  const candidate = run?.candidates.find(item => item.candidateId === candidateId);
  if (!candidate) throw refuse('The reviewed replacement does not exist', 404);
  if (run.mode !== 'apply' || !run.applyAuthorization?.at || candidate.type !== 'supersedes'
      || !candidate.review?.at || candidate.supersedes?.authority !== 'local_memory') throw refuse('This run has no reviewed owner replacement to roll back', 403);
  if (candidate.status === 'rolled_back') return { candidateId, status: 'rolled_back', alreadyRolledBack: true };
  const now = new Date();
  const elem = { candidateId, $or: [{ status: { $in: ['applied', 'rollback_failed'] } },
    { status: 'rolling_back', 'rollback.leaseUntil': { $lte: now } }] };
  run = await MemoryReviewRun.findOneAndUpdate({ runId, mode: 'apply', 'applyAuthorization.at': { $ne: null },
    candidates: { $elemMatch: elem } }, { $set: { 'candidates.$[c].status': 'rolling_back',
    'candidates.$[c].rollback': { by: reviewer, at: now, leaseUntil: new Date(+now + 300000), result: null } },
  $push: { audit: { $each: [{ at: now, event: 'candidate_rollback_started', by: reviewer, candidateId, level: 'info' }],
    $slice: -policy.LIMITS.MAX_AUDIT_ENTRIES } } }, { new: true, arrayFilters: [{ 'c.candidateId': candidateId }] });
  if (!run) throw refuse('The replacement is not applied or rollback is already in progress');
  let status = 'rolled_back', result;
  try {
    await ownerNotes.rollbackSupersession({ id: candidate.supersedes.ref,
      key: `memory-review:${runId}:${candidateId}` });
    result = `restored owner note ${candidate.supersedes.ref}`;
  } catch (error) {
    status = 'rollback_failed';
    result = redact(String(error.message)).slice(0, 1000);
  }
  const saved = await MemoryReviewRun.updateOne({ runId, candidates: { $elemMatch: { candidateId,
    status: 'rolling_back', 'rollback.at': now } } }, { $set: { 'candidates.$[c].status': status,
    'candidates.$[c].rollback.leaseUntil': null, 'candidates.$[c].rollback.result': result },
  $push: { audit: { $each: [{ at: new Date(), event: status === 'rolled_back' ? 'candidate_rolled_back' : 'candidate_rollback_failed',
    by: reviewer, candidateId, level: status === 'rolled_back' ? 'info' : 'error', detail: result }],
  $slice: -policy.LIMITS.MAX_AUDIT_ENTRIES } } }, { arrayFilters: [{ 'c.candidateId': candidateId }] });
  if (!saved.matchedCount) throw refuse('Rollback outcome requires reconciliation with the original operation');
  return { candidateId, status, result };
}

module.exports = { rollbackCandidate };
