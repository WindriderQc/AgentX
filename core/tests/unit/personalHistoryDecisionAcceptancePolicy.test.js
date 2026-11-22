'use strict';

const { build, CONTRACT, GAP } = require('../../src/services/personalHistoryDecisionAcceptancePolicy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { reconcile, SECTIONS } = require('../../src/services/personalHistoryFindingContract');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const reference = { system: 'gmail', messageId: '1234567890abcdef', threadId: '2234567890abcdef', sourceSha256: 'a'.repeat(64) };

function evidence({ section = 'invoices', state = 'resolved', reason = 'Synthetic explicit decision', date = '2026-01-01T00:00:00.000Z', questions = [], linkedState = 'not_linked', mailbox = [], confirmationStatus = 'current' } = {}) {
  const id = 'b'.repeat(24), findingId = 'c'.repeat(64), fingerprint = 'd'.repeat(64);
  const inventory = { reference, findings: [{ findingId, section }], threadQuestions: questions };
  const entry = { id, revision: 1, kind: SECTIONS[section], reviewState: state, source: { ...reference, findingId }, decision: { reason, at: date } };
  const coreScope = { members: [{ entryId: id, entryRevision: 1, fingerprint, sourceBinding: 'exact' }] };
  const snapshot = { inventory, coreScope, coverage: reconcile(inventory, [entry], [{ fingerprint, snapshot: { entryId: id, pendingSourceDecisions: 0 } }]) };
  const finding = { reference, fingerprint: digest(snapshot), snapshot };
  const link = { reference, snapshot: { reference, findingScope: { fingerprint: finding.fingerprint, snapshot },
    entries: [{ entryId: id, entryRevision: 1, decisionFingerprint: fingerprint, state: linkedState,
      note: ['current_link', 'needs_review'].includes(linkedState) ? { id: 'f'.repeat(24), revision: 1, fingerprint,
        sourceBinding: true, contextBinding: linkedState === 'current_link', replacementPending: false } : null,
      blockers: linkedState === 'unavailable' ? ['linked_souvenir_unavailable'] : linkedState === 'needs_review' ? ['linked_souvenir_context_mismatch'] : [] }],
    coverage: { counts: { entries: 1, notLinked: Number(linkedState === 'not_linked'), currentLinks: Number(linkedState === 'current_link'),
      unavailable: Number(linkedState === 'unavailable'), needsReview: Number(linkedState === 'needs_review') }, blockers: [...snapshot.coverage.blockers] } } };
  const blockers = [...new Set([...snapshot.coverage.blockers, ...mailbox])];
  const manifest = { sources: [reference], sourceSetSha256: digest([reference]), checksSha256: 'e'.repeat(64), before: '2026-01-01T00:00:00.000Z',
    decisions: { snapshot: { findings: [finding] } }, downstream: { snapshot: { members: [link] } },
    coverage: { messages: [{ reference, blockers, reviewStatus: blockers.length ? 'held' : 'observed' }], counts: { messages: 1, evidenceHeldMessages: Number(blockers.length > 0) } } };
  const preview = { manifest, coreRestoration: { synthetic: 'native Core proof' } };
  const current = { contract: 'agentx.history-manifest-confirmation-current/v1', confirmationStatus, selectedMessages: 1,
    sourceSetSha256: manifest.sourceSetSha256, checksSha256: manifest.checksSha256, before: manifest.before,
    current: { manifestSha256: digest(manifest), coreRestorationSha256: digest(preview.coreRestoration) } };
  return { observation: { authority: 'agentx.core', contract: current.contract, snapshot: current, fingerprint: digest(current) }, preview };
}
const evaluate = pair => build(pair.observation, pair.preview);
const rehash = pair => {
  pair.observation.snapshot.current.manifestSha256 = digest(pair.preview.manifest);
  pair.observation.fingerprint = digest(pair.observation.snapshot); return pair;
};

describe('selected native decision acceptance policy', () => {
  test.each(['actions', 'deliverables', 'invoices'])('%s requires explicit resolution or dismissal', section => {
    for (const state of ['resolved', 'dismissed']) {
      const value = evaluate(evidence({ section, state }));
      expect(value.contract).toBe(CONTRACT); expect(value.decisionReconciliationAccepted).toBe(true);
      expect(value.remainingNativeValidationGaps).toEqual(GAPS.filter(g => g !== GAP));
    }
    const value = evaluate(evidence({ section, state: 'retained' }));
    expect(value.messages[0].blockers).toContain('actionable_record_not_resolved');
    expect(value.remainingNativeValidationGaps).toEqual(GAPS);
  });
  test('a retained information decision admits no link or a current link', () => {
    for (const linkedState of ['not_linked', 'current_link']) expect(evaluate(evidence({ section: 'memories', state: 'retained', linkedState })).decisionReconciliationAccepted).toBe(true);
  });
  test.each([
    [{ date: null }, 'recorded_decision_not_observed'], [{ reason: '' }, 'recorded_decision_not_observed'],
    [{ state: 'candidate' }, 'actionable_record_not_resolved'], [{ questions: [{ questionId: 'f'.repeat(64) }] }, 'thread_questions_unresolved'],
    [{ linkedState: 'unavailable' }, 'linked_souvenirs_need_review'], [{ linkedState: 'needs_review' }, 'linked_souvenirs_need_review'],
    [{ confirmationStatus: 'changed' }, 'human_confirmation_not_current'],
    [{ mailbox: ['live_message_outside_cutoff'] }, 'live_message_outside_cutoff'],
    [{ mailbox: ['live_message_changed'] }, 'live_message_changed']
  ])('holds incomplete decisions, links, original inspection or mailbox evidence %j', (options, blocker) => {
    const value = evaluate(evidence(options)); expect(value.messages[0].blockers).toContain(blocker);
    expect(value.acceptanceStatus).toBe('blocked_scope'); expect(value.remainingNativeValidationGaps).toEqual(GAPS);
  });
  test('empty native findings never become vacuous acceptance', () => {
    const pair = evidence(), f = pair.preview.manifest.decisions.snapshot.findings[0].snapshot;
    f.inventory.findings = []; f.coreScope.members = [];
    f.coverage = reconcile(f.inventory, [], []);
    const linked = pair.preview.manifest.downstream.snapshot.members[0].snapshot;
    linked.findingScope = { snapshot: f, fingerprint: digest(f) }; linked.entries = [];
    linked.coverage = { counts: { entries: 0, notLinked: 0, currentLinks: 0, unavailable: 0, needsReview: 0 }, blockers: f.coverage.blockers };
    pair.preview.manifest.coverage.messages[0].blockers = f.coverage.blockers;
    pair.preview.manifest.coverage.messages[0].reviewStatus = 'held'; pair.preview.manifest.coverage.counts.evidenceHeldMessages = 1;
    pair.preview.manifest.decisions.snapshot.findings[0].fingerprint = digest(f);
    expect(evaluate(rehash(pair)).messages[0].blockers).toContain('empty_recorded_finding_set_not_semantic_acceptance');
  });
  test.each([
    p => { p.preview.manifest.decisions.snapshot.findings[0].snapshot.coverage.counts.recordedFindings = 0; },
    p => { p.preview.manifest.downstream.snapshot.members[0].snapshot.entries = []; },
    p => { p.preview.manifest.decisions.snapshot.findings[0].snapshot.coreScope.members[0].entryRevision++; },
    p => { p.preview.manifest.coverage.messages = []; },
    p => { p.preview.manifest.coverage.counts.evidenceHeldMessages = 1; }
  ])('incomplete or internally inconsistent evidence is unavailable, never partial acceptance', mutate => {
    const pair = evidence(); mutate(pair); rehash(pair);
    expect(() => evaluate(pair)).toThrow(expect.objectContaining({ statusCode: 503, code: 'HISTORY_DECISION_ACCEPTANCE_UNAVAILABLE' }));
  });
  test.each(['boolean_revision', 'missing_note', 'inconsistent_binding', 'boolean_note_revision'])('refuses malformed link/pin metadata: %s', variant => {
    const pair = evidence({ linkedState: 'current_link' });
    const f = pair.preview.manifest.decisions.snapshot.findings[0], linked = pair.preview.manifest.downstream.snapshot.members[0].snapshot;
    if (variant === 'boolean_revision') {
      f.snapshot.coreScope.members[0].entryRevision = true; f.snapshot.coverage.findings[0].records[0].revision = true;
      linked.entries[0].entryRevision = true;
    } else if (variant === 'missing_note') linked.entries[0].note = null;
    else if (variant === 'inconsistent_binding') linked.entries[0].note.sourceBinding = false;
    else linked.entries[0].note.revision = true;
    f.fingerprint = digest(f.snapshot); linked.findingScope.fingerprint = f.fingerprint;
    expect(() => evaluate(rehash(pair))).toThrow(expect.objectContaining({ statusCode: 503 }));
  });
});
