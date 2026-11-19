'use strict';

const restoration = require('./personalHistoryRestorationScope');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-review-manifest/v1';
const changed = () => failure('The complete selected native review evidence is unavailable or inconsistent.', 409, 'HISTORY_REVIEW_MANIFEST_CHANGED');
const requireEvidence = condition => { if (!condition) throw changed(); };
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);

function selection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['checks', 'before', 'observationId', 'expected'].includes(key))
    || typeof input.before !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.before)
    || !Number.isFinite(Date.parse(input.before)) || new Date(input.before).toISOString() !== input.before) {
    throw failure('Use exact retained review restoration checks and a canonical UTC cutoff.', 400, 'HISTORY_REVIEW_MANIFEST_INVALID');
  }
  const checks = restoration.selection({ checks: input.checks, observationId: input.observationId,
    ...(input.expected !== undefined && { expected: input.expected }), verification: 'review-restoration' });
  return { checks, sources: checks.map(check => check.source), before: input.before };
}

function component(value, contract) {
  requireEvidence(value?.snapshot?.contract === contract && typeof value.fingerprint === 'string'
    && /^[a-f0-9]{64}$/.test(value.fingerprint) && value.fingerprint === digest(value.snapshot));
  return { fingerprint: value.fingerprint, snapshot: value.snapshot };
}

function build(before, checks, values) {
  const sources = checks.map(check => check.source);
  const decisions = component(values.decisions, 'agentx.history-global-decisions/v1');
  const downstream = component(values.downstream, 'agentx.history-global-downstream/v1');
  const restored = component(values.restoration, 'agentx.history-restoration-scope/v2');
  const mailbox = values.mailbox;
  requireEvidence(Array.isArray(decisions.snapshot.findings) && Array.isArray(downstream.snapshot.members)
    && Array.isArray(restored.snapshot.members) && Array.isArray(mailbox));
  requireEvidence(same(decisions.snapshot.sources, sources) && same(downstream.snapshot.sources, sources)
    && decisions.snapshot.sourceSetSha256 === digest(sources) && downstream.snapshot.sourceSetSha256 === digest(sources)
    && restored.snapshot.sourceSetSha256 === digest(sources)
    && same(decisions.snapshot.findings?.map(row => row.reference), sources)
    && same(downstream.snapshot.members?.map(row => row.reference), sources)
    && same(restored.snapshot.members?.map(({ snapshot, ...check }) => check), checks)
    && Array.isArray(mailbox) && same(mailbox.map(row => row.reference), sources));
  const live = mailbox.map(row => ({ reference: row.reference, ...component(row, 'agentx.history-mailbox-scope/v1') }));
  requireEvidence(live.every(row => /^[a-f0-9]{64}$/.test(row.snapshot.mailbox?.accountSelectionSha256 || ''))
    && new Set(live.map(row => row.snapshot.mailbox.accountSelectionSha256)).size === 1);
  const messages = sources.map((reference, i) => {
    const finding = decisions.snapshot.findings[i];
    const linked = downstream.snapshot.members[i].snapshot;
    const copy = restored.snapshot.members[i].snapshot;
    const current = live[i].snapshot;
    requireEvidence(same(linked.reference, reference) && same(current.reference, reference)
      && same(linked.findingScope, component(finding, 'agentx.history-finding-scope/v1'))
      && same(current.coreScope, finding.snapshot.coreScope)
      && copy.contract === 'agentx.history-preservation/v3' && copy.status === 'verified_scope'
      && Array.isArray(copy.copies) && copy.copies.length === 2);
    for (const member of copy.copies) requireEvidence(member.status === 'available'
      && member.content?.reviewPacket?.evidenceHash === finding.snapshot.inventory?.evidenceHash
      && member.content?.reviewPacket?.reviewSha256 === finding.snapshot.inventory?.reviewSha256);
    const cutoff = current.mailbox.current && BigInt(current.mailbox.current.internalDate) >= BigInt(Date.parse(before))
      ? ['live_message_outside_cutoff'] : [];
    const blockers = [...new Set([...finding.snapshot.coverage.blockers, ...linked.coverage.blockers, ...current.coverage.blockers, ...cutoff])];
    return { reference, blockers, reviewStatus: blockers.length ? 'held' : 'observed', candidateForOwnerReview: false };
  });
  const evidenceHeldMessages = messages.filter(row => row.blockers.length).length;
  const snapshot = { contract: CONTRACT, before, sources, sourceSetSha256: digest(sources), checksSha256: digest(checks),
    decisions, downstream, restoration: restored, mailbox: live,
    coverage: { messages, counts: { messages: sources.length, entries: decisions.snapshot.coverage.counts.entries,
      observedNotes: downstream.snapshot.coverage.counts.observedNotes,
      livePresent: live.filter(row => row.snapshot.mailbox.status === 'present').length,
      evidenceHeldMessages, candidatesForOwnerReview: 0 },
    blockers: [...GAPS, ...(evidenceHeldMessages ? ['selected_evidence_needs_review'] : [])] } };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
    throw failure('The complete selected review manifest exceeds its capacity.', 413, 'HISTORY_REVIEW_MANIFEST_CAPACITY');
  }
  return snapshot;
}

module.exports = { CONTRACT, selection, build, changed, same };
