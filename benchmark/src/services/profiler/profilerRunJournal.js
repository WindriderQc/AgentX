'use strict';
const crypto = require('node:crypto');
const HostProfile = require('../../../models/HostProfile');
const hostProfileService = require('./hostProfileService');
const { getWorkloadRecoveryIdentity } = require('../../clients/coreApiClient');
const { withMutationJournal } = require('./profilerMutationObservation');
const journals = new WeakMap();

function journalError(message, code = 'PROFILER_RUN_JOURNAL_LOST') {
  return Object.assign(new Error(message), { code, retainAdmission: true });
}
async function createRunJournal(lease, { hostId, hostUrl, modelName }) {
  lease.assertActive();
  const identity = getWorkloadRecoveryIdentity(lease.operationId);
  if (!identity?.recoveryId || !identity?.recoveryRequestId) throw journalError('Profiler run requires durable Core recovery identity');
  const proof = lease.authorityProof();
  const ownerId = `profiler-run:${process.pid}:${crypto.randomUUID()}`;
  const ownerEpoch = crypto.randomUUID();
  const reconciliation = { state: 'prepared', operation: 'profile_run', operationId: lease.operationId,
    workloadId: lease.operationId, admissionId: proof.admissionId, admissionGeneration: proof.generation,
    admissionPrincipal: proof.principal, recoveryId: identity.recoveryId, recoveryRequestId: identity.recoveryRequestId,
    ownerId, ownerEpoch, ownerClaimedAt: new Date(), model: modelName, startedAt: new Date(),
    pendingRequests: 0, serverTerminalObserved: true, serverTerminalAt: new Date(),
    reason: 'No profile runtime request dispatched yet' };
  await hostProfileService.upsertAuthority({ hostId, hostUrl, reconciliation }, {
    authorityService: 'profiler-profile', authorityProof: proof, signal: lease.signal,
    assertAuthorityActive: lease.assertActive,
    authorityFilter: { $or: [
      { 'reconciliation.state': 'resolved' },
      { 'reconciliation.state': { $exists: false } }
    ] } });
  const filter = { hostId, 'reconciliation.operationId': lease.operationId,
    'reconciliation.admissionGeneration': proof.generation,
    'reconciliation.ownerId': ownerId, 'reconciliation.ownerEpoch': ownerEpoch,
    'reconciliation.state': { $ne: 'resolved' } };
  let pending = 0;
  let uncertain = false;
  let sequence = 0;
  const tickets = new Set();
  let cancellation = null;
  async function update(fields, requireLease = true) {
    if (requireLease) lease.assertActive();
    const result = await HostProfile.updateOne(filter, { $set: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [`reconciliation.${key}`, value])) },
    requireLease ? { signal: lease.signal } : {});
    if (result.matchedCount !== 1) throw journalError('Profiler journal writer epoch was replaced');
    if (requireLease) lease.assertActive();
  }
  // An operator cancel aborted the pending request: it becomes terminal only
  // with the runtime's stop proof, otherwise it stays UNKNOWN as before.
  async function settleCancelAbort(error) {
    const result = await cancellation.resolveAbort();
    if (result.proven) {
      await update({ pendingRequests: 0, serverTerminalObserved: true, serverTerminalAt: new Date(),
        cancelAbort: { proven: true, receipt: result.receipt }, ownerClaimedAt: new Date(), reason: null }, false);
      tickets.clear(); pending = 0;
      error.cancelAbortReceipt = result.receipt;
      return;
    }
    uncertain = true;
    error.cancelStopUnproven = true;
    error.message = `${error.message}; ${result.reason}. The request stays UNKNOWN until a runtime restart attestation`;
    await update({ cancelAbort: { proven: false, reason: result.reason, evidence: result.evidence } }, false);
  }
  const journal = {
    hostId,
    heartbeat: () => update({ ownerClaimedAt: new Date() }),
    async beforeMutation(request = null) {
      cancellation?.assertNotCancelled();
      if (uncertain || pending) throw journalError('Prior profiler request has no terminal receipt', 'PROFILER_MUTATION_OUTCOME_UNKNOWN');
      await lease.assertDispatchActive();
      const ticket = ++sequence;
      await update({ state: 'mutating', pendingRequests: 1, serverTerminalObserved: false,
        serverTerminalAt: null, ownerClaimedAt: new Date(), reason: 'Runtime request dispatched; terminal receipt pending' });
      pending = 1; tickets.add(ticket);
      cancellation?.track(ticket, request);
      return ticket;
    },
    async completeMutation(ticket) {
      if (!tickets.has(ticket) || uncertain) throw journalError('Profiler terminal receipt does not match the pending request');
      await update({ pendingRequests: 0, serverTerminalObserved: true, serverTerminalAt: new Date(),
        ownerClaimedAt: new Date(), reason: null });
      tickets.delete(ticket); pending = 0;
      cancellation?.settle(ticket);
    },
    async unknownMutation(ticket, error) {
      if (!uncertain && error?.code === 'PROFILE_CANCELLED' && cancellation?.isAbortedTicket(ticket)) {
        await update({ reason: 'Profile cancel aborted the request; awaiting runtime stop proof' }, false);
        return;
      }
      uncertain = true;
      await update({ state: 'unknown', serverTerminalObserved: false,
        reason: error?.code || 'Profiler request terminality unknown' }, false);
    },
    async run(operation, modelName, { cancellation: runCancellation = null } = {}) {
      cancellation = runCancellation;
      try {
        await update({ model: modelName, ownerClaimedAt: new Date() });
        const result = await withMutationJournal(journal, operation);
        if (pending || uncertain) throw journalError('Profiler request terminality remains unknown', 'PROFILER_MUTATION_OUTCOME_UNKNOWN');
        await update({ state: 'pending_reconciliation', reason: 'Profile requests settled; exact host restoration pending' });
        return result;
      } catch (error) {
        if (pending && !uncertain && [...tickets].some(ticket => cancellation?.isAbortedTicket(ticket))) {
          await settleCancelAbort(error).catch(() => { uncertain = true; });
        }
        if (pending || uncertain || error.retainAdmission || lease.signal.aborted) {
          uncertain = true;
          await update({ state: 'unknown', serverTerminalObserved: false,
            reason: error.cancelStopUnproven ? 'PROFILE_CANCEL_STOP_UNPROVEN' : error.code || 'Profiler interrupted' }, false);
          error.retainAdmission = true;
          await lease.abandon(error);
        } else await update({ state: 'pending_reconciliation', reason: 'Profile ended; acknowledged runtime requests require restoration' });
        throw error;
      } finally {
        cancellation = null;
      }
    },
    async beforeWorkloadRelease(result) {
      if (pending || uncertain || result.failed) throw journalError('Profiler cannot release before exact restoration');
      await update({ state: 'verified', reason: null, releaseReceipt: result, lastObservedAt: new Date() });
    },
    afterWorkloadRelease: releaseReceipt => update({ state: 'resolved', reason: null, resolvedAt: new Date(),
      releaseReceipt, ownerId: null, ownerEpoch: null, ownerClaimedAt: null }, false),
  };
  lease.attachReconciliation(journal);
  return journal;
}
async function journalFor(lease, host) {
  let byHost = journals.get(lease);
  if (!byHost) { byHost = new Map(); journals.set(lease, byHost); }
  if (!byHost.has(host.hostId)) byHost.set(host.hostId, await createRunJournal(lease, host));
  return byHost.get(host.hostId);
}
async function prepareProfilerRunJournals(lease, hosts, modelName) {
  for (const host of hosts) await journalFor(lease, { ...host, modelName });
}
async function runJournaledProfile(lease, host, operation, options = {}) {
  return (await journalFor(lease, host)).run(operation, host.modelName, options);
}
module.exports = { runJournaledProfile, createRunJournal, prepareProfilerRunJournals };
