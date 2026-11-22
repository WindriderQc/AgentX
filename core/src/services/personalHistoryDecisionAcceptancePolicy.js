'use strict';

const { digest, failure } = require('./personalHistorySourceReviewSources');
const { SECTIONS } = require('./personalHistoryFindingContract');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-decision-reconciliation-acceptance/v1';
const POLICY = 'explicit-action-deliverable-invoice-resolution/v1';
const GAP = 'native_decision_reconciliation_unavailable';
const unavailable = () => failure('The complete native decision acceptance evidence is unavailable.', 503, 'HISTORY_DECISION_ACCEPTANCE_UNAVAILABLE');
const requireEvidence = value => { if (!value) throw unavailable(); };
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const count = value => { requireEvidence(Number.isSafeInteger(value) && value >= 0); return value; };
function codes(value) {
  requireEvidence(Array.isArray(value) && value.every(code => typeof code === 'string' && code.length > 0 && code.length <= 100));
  return value;
}

function linkEvidence(row) {
  requireEvidence(id(row.entryId) && count(row.entryRevision) === row.entryRevision && hash(row.decisionFingerprint));
  const blockers = codes(row.blockers), note = row.note;
  if (row.state === 'not_linked') return requireEvidence(note === null && !blockers.length);
  if (row.state === 'unavailable') return requireEvidence(note === null && same(blockers, ['linked_souvenir_unavailable']));
  requireEvidence(note && id(note.id) && count(note.revision) === note.revision && hash(note.fingerprint)
    && ['sourceBinding', 'contextBinding', 'replacementPending'].every(key => typeof note[key] === 'boolean'));
  const expected = [];
  if (!note.sourceBinding) expected.push('linked_souvenir_source_mismatch');
  if (!note.contextBinding) expected.push('linked_souvenir_context_mismatch');
  if (note.replacementPending) expected.push('linked_souvenir_replacement_pending');
  requireEvidence(same(blockers, expected) && row.state === (expected.length ? 'needs_review' : 'current_link'));
}

function message(reference, finding, linked, current, selectedBlockers) {
  const inventory = finding.inventory, fc = finding.coverage, dc = linked.coverage;
  requireEvidence(Array.isArray(inventory?.findings) && Array.isArray(inventory.threadQuestions)
    && Array.isArray(fc?.findings) && Array.isArray(fc.unmatchedEntries)
    && Array.isArray(finding.coreScope?.members) && Array.isArray(linked.entries));
  requireEvidence(same(fc.findings.map(({ findingId, section }) => ({ findingId, section })), inventory.findings));
  for (const key of ['recordedFindings', 'noCoreReference', 'needsReview', 'observedDecision', 'threadQuestions', 'unmatchedEntries']) count(fc.counts?.[key]);
  for (const key of ['entries', 'notLinked', 'currentLinks', 'unavailable', 'needsReview']) count(dc?.counts?.[key]);
  requireEvidence(fc.counts.recordedFindings === fc.findings.length
    && fc.counts.threadQuestions === inventory.threadQuestions.length && fc.counts.unmatchedEntries === fc.unmatchedEntries.length);
  const statuses = { no_core_reference: 'noCoreReference', needs_review: 'needsReview', observed_decision: 'observedDecision' };
  for (const [status, key] of Object.entries(statuses)) requireEvidence(fc.counts[key] === fc.findings.filter(row => row.status === status).length);
  requireEvidence(fc.findings.every(row => Object.hasOwn(statuses, row.status)));
  const blockers = new Set([...codes(fc.blockers), ...codes(dc.blockers), ...codes(selectedBlockers)]);
  requireEvidence(fc.findings.length || blockers.has('empty_recorded_finding_set_not_semantic_acceptance'));
  requireEvidence(!fc.counts.threadQuestions || blockers.has('thread_questions_unresolved'));
  requireEvidence(!fc.counts.unmatchedEntries || blockers.has('core_references_outside_recorded_finding_set'));
  requireEvidence(!(fc.counts.noCoreReference || fc.counts.needsReview) || blockers.has('recorded_findings_need_review'));
  const pins = new Map(finding.coreScope.members.map(pin => [pin.entryId, pin]));
  requireEvidence(pins.size === finding.coreScope.members.length && [...pins.values()].every(pin => pin.sourceBinding === 'exact'
    && id(pin.entryId) && count(pin.entryRevision) === pin.entryRevision && hash(pin.fingerprint)));
  let records = 0;
  for (const item of fc.findings) {
    requireEvidence(Array.isArray(item.records) && Object.hasOwn(SECTIONS, item.section));
    if (!item.records.length) blockers.add('recorded_finding_without_decision');
    if (item.status !== 'observed_decision') blockers.add('recorded_decision_not_observed');
    const seen = new Set();
    for (const record of item.records) {
      const pin = pins.get(record.entryId);
      requireEvidence(pin && !seen.has(record.entryId) && count(record.revision) === record.revision
        && pin.entryRevision === record.revision && pin.fingerprint === record.fingerprint);
      seen.add(record.entryId); records++;
      if (codes(record.blockers).length) blockers.add('recorded_decision_not_observed');
      if (record.kind !== SECTIONS[item.section]) blockers.add('recorded_decision_not_observed');
      if (['action', 'deliverable', 'invoice'].includes(record.kind)) {
        if (!['resolved', 'dismissed'].includes(record.state)) blockers.add('actionable_record_not_resolved');
      } else if (record.kind === 'fact') {
        if (!['retained', 'resolved', 'dismissed'].includes(record.state)) blockers.add('information_decision_not_recorded');
      } else blockers.add('unsupported_record_kind');
    }
    requireEvidence(item.status === (!item.records.length ? 'no_core_reference'
      : item.records.some(record => record.blockers.length) ? 'needs_review' : 'observed_decision'));
  }
  requireEvidence(linked.entries.length === dc.counts.entries && linked.entries.length === pins.size);
  const seen = new Set(), states = { not_linked: 'notLinked', current_link: 'currentLinks', unavailable: 'unavailable', needs_review: 'needsReview' };
  for (const row of linked.entries) {
    linkEvidence(row);
    const pin = pins.get(row.entryId);
    requireEvidence(pin && !seen.has(row.entryId) && pin.entryRevision === row.entryRevision && pin.fingerprint === row.decisionFingerprint
      && Object.hasOwn(states, row.state)); seen.add(row.entryId);
    if (!['current_link', 'not_linked'].includes(row.state) || codes(row.blockers).length) blockers.add('linked_souvenirs_need_review');
  }
  for (const [state, key] of Object.entries(states)) requireEvidence(dc.counts[key] === linked.entries.filter(row => row.state === state).length);
  if (!current) blockers.add('human_confirmation_not_current');
  return { referenceSha256: digest(reference), recordedFindings: fc.counts.recordedFindings,
    observedDecisions: fc.counts.observedDecision, records, currentLinks: dc.counts.currentLinks,
    notLinked: dc.counts.notLinked, blockers: [...blockers].sort(), accepted: !blockers.size };
}

function build(observation, preview) {
  const current = observation?.snapshot, manifest = preview?.manifest;
  requireEvidence(observation?.authority === 'agentx.core' && observation.contract === 'agentx.history-manifest-confirmation-current/v1'
    && current?.contract === observation.contract && observation.fingerprint === digest(current)
    && ['current', 'changed'].includes(current.confirmationStatus)
    && digest(manifest) === current.current.manifestSha256 && digest(preview.coreRestoration) === current.current.coreRestorationSha256
    && Array.isArray(manifest.sources) && manifest.sources.length >= 1 && manifest.sources.length <= 20
    && count(current.selectedMessages) === manifest.sources.length
    && digest(manifest.sources) === current.sourceSetSha256 && manifest.sourceSetSha256 === current.sourceSetSha256
    && manifest.checksSha256 === current.checksSha256 && manifest.before === current.before);
  const findings = manifest.decisions?.snapshot?.findings, linked = manifest.downstream?.snapshot?.members;
  const coverage = manifest.coverage;
  requireEvidence(Array.isArray(findings) && Array.isArray(linked)
    && Array.isArray(coverage?.messages) && same(coverage.messages.map(row => row.reference), manifest.sources)
    && coverage.messages.every(row => row.reviewStatus === (codes(row.blockers).length ? 'held' : 'observed'))
    && count(coverage.counts?.messages) === manifest.sources.length
    && count(coverage.counts.evidenceHeldMessages) === coverage.messages.filter(row => codes(row.blockers).length).length
    && same(findings.map(row => row.reference), manifest.sources) && same(linked.map(row => row.reference), manifest.sources));
  const messages = manifest.sources.map((reference, i) => {
    requireEvidence(same(linked[i].snapshot.reference, reference)
      && same(linked[i].snapshot.findingScope, { fingerprint: findings[i].fingerprint, snapshot: findings[i].snapshot }));
    return message(reference, findings[i].snapshot, linked[i].snapshot, current.confirmationStatus === 'current', coverage.messages[i].blockers);
  });
  const counts = { messages: messages.length, acceptedMessages: messages.filter(row => row.accepted).length,
    blockedMessages: messages.filter(row => !row.accepted).length, recordedFindings: 0, records: 0, currentLinks: 0, notLinked: 0 };
  for (const row of messages) for (const key of ['recordedFindings', 'records', 'currentLinks', 'notLinked']) counts[key] += row[key];
  const accepted = counts.blockedMessages === 0;
  const snapshot = { contract: CONTRACT, scope: 'selected-recorded-findings-and-linked-core-decisions', policy: POLICY,
    currentConfirmation: { fingerprint: observation.fingerprint, snapshot: current }, messages, counts,
    acceptanceStatus: accepted ? 'accepted_scope' : 'blocked_scope', decisionReconciliationAccepted: accepted,
    remainingNativeValidationGaps: accepted ? GAPS.filter(gap => gap !== GAP) : [...GAPS] };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024) throw failure('The complete decision acceptance metadata exceeds its capacity.',
    413, 'HISTORY_DECISION_ACCEPTANCE_CAPACITY');
  return snapshot;
}

module.exports = { CONTRACT, POLICY, GAP, build, unavailable };
