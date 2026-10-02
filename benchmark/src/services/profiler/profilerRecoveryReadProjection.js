'use strict';

function date(value) {
  const time = value ? new Date(value) : null;
  return time && Number.isFinite(time.getTime()) ? time.toISOString() : null;
}

// Browser observations carry no coordination identities, epochs or release tokens.
function projectRecovery(profile, now = new Date()) {
  const journal = profile?.reconciliation;
  if (!journal?.state) return null;
  const age = now - new Date(journal.ownerClaimedAt);
  const recentWriter = Boolean(journal.ownerClaimedAt && Number.isFinite(age) && age >= 0 && age <= 60000);
  const terminal = journal.serverTerminalObserved === true;
  const unresolved = journal.state !== 'resolved';
  let code = 'inspect_recovery', label = 'Recovery state needs inspection';
  let action = 'Inspect the operation and Core ownership before changing the runtime.';
  if (!unresolved) {
    code = journal.releaseReceipt?.released === true ? 'released' : 'closed_unverified';
    label = code === 'released' ? 'Runtime release recorded' : 'Journal closed; release unverified';
    action = 'Verify live residency separately before qualifying the host.';
  } else if (journal.state === 'prepared' && recentWriter) {
    code = 'prepared'; label = 'Profiling prepared'; action = 'Observe the current operation; no model request is recorded yet.';
  } else if (journal.state === 'mutating' && recentWriter) {
    code = 'running'; label = 'Profiling in progress'; action = 'Observe the existing operation and its request receipts.';
  } else if (journal.operatorRequiredAt) {
    code = 'operator_required'; label = 'Automatic recovery stopped';
    // The recorded reason can carry runtime paths; it stays in the journal.
    action = `Automatic recovery stopped after ${Number(journal.failedAttempts) || 0} failed attempts. `
      + 'Read the journal reason, fix the cause (host reachable, GPU memory free), then clear reconciliation.operatorRequiredAt to resume (docs/OPERATIONS.md, Profiler restoration).';
  } else if (!terminal) {
    code = 'terminal_unknown'; label = 'Runtime request outcome unknown';
    action = 'Inspect the old writer and outstanding request. Recovery needs verified termination before restoration.';
  } else if (journal.state === 'verified') {
    code = 'release_pending'; label = 'Restoration verified; release pending';
    action = 'Wait for the recovery worker to record the Core release receipt; inspect ownership if it remains pending.';
  } else {
    code = 'restore_pending'; label = 'Runtime restoration pending';
    action = 'The recovery worker can reconcile recorded terminal requests under Core ownership. Refresh to inspect progress.';
  }
  return { hostId: String(profile.hostId || '').slice(0, 100), hostLabel: String(profile.displayName || profile.hostId || 'Host').slice(0, 160),
    operationId: String(journal.operationId || '').slice(0, 200) || null, operation: String(journal.operation || '').slice(0, 80) || null,
    state: journal.state, code, label, action, unresolved, attention: unresolved && !['prepared', 'running'].includes(code),
    serverTerminalObserved: terminal, recordedRequestsPending: Number.isSafeInteger(journal.pendingRequests) && journal.pendingRequests >= 0 ? journal.pendingRequests : null,
    startedAt: date(journal.startedAt), lastEvidenceAt: date(journal.lastObservedAt || journal.serverTerminalAt || journal.ownerClaimedAt),
    resolvedAt: date(journal.resolvedAt),
    failedAttempts: Number.isSafeInteger(journal.failedAttempts) && journal.failedAttempts > 0 ? journal.failedAttempts : 0,
    nextAttemptAt: unresolved && !journal.operatorRequiredAt ? date(journal.nextAttemptAt) : null,
    authorization: 'not_granted' };
}

function projectHostProfileForRead(profile) {
  if (!profile) return profile;
  if (!profile.reconciliation) return profile;
  const { reconciliation: _journal, ...safe } = profile;
  return { ...safe, recovery: projectRecovery(profile) };
}
module.exports = { projectRecovery, projectHostProfileForRead };
