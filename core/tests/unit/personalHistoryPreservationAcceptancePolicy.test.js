'use strict';
const { build, GAP } = require('../../src/services/personalHistoryPreservationAcceptancePolicy');
const { GAP: DECISION_GAP } = require('../../src/services/personalHistoryDecisionAcceptancePolicy');
const { GAPS } = require('../../src/services/personalHistoryPreservationContract');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');
const { evidence, refresh } = require('../fixtures/historyPreservationAcceptanceEvidence');
const evaluate = ({ d, s, preview }) => build(d, s, preview);

describe('approved selected native preservation acceptance', () => {
  test('current exact restorations and disjoint machine/device sets accept both bounded contracts', () => {
    const result = evaluate(evidence({ messages: 2 }));
    expect(result).toMatchObject({ preservationStatus: 'accepted_scope', preservationAccepted: true, decisionReconciliationAccepted: true,
      counts: { messages: 2, primaryDisks: 1, mirrorDisks: 1, heldMessages: 0 }, blockers: [] });
    expect(result.remainingNativeValidationGaps).toEqual(GAPS.filter(gap => ![GAP, DECISION_GAP].includes(gap)));
  });
  test('preservation remains independent from an unresolved invoice decision', () => {
    const result = evaluate(evidence({ invoiceRetained: true }));
    expect(result.preservationAccepted).toBe(true); expect(result.decisionReconciliationAccepted).toBe(false);
    expect(result.remainingNativeValidationGaps).toEqual(GAPS.filter(gap => gap !== GAP));
  });
  test('cross-message overlap holds the entire selection even when every message has disjoint devices', () => {
    const value = evidence({ messages: 2 });
    value.s.snapshot.members[1].copies[0].storage.physicalDiskIdsSha256 = ['c'.repeat(64)];
    value.s.snapshot.members[1].copies[1].storage.physicalDiskIdsSha256 = ['f'.repeat(64)];
    const result = evaluate(refresh(value));
    expect(result.counts.heldMessages).toBe(0); expect(result.blockers).toContain('selected_device_identity_overlap');
    expect(result.preservationAccepted).toBe(false); expect(result.remainingNativeValidationGaps).toContain(GAP);
  });
  test.each(['unknown', 'same_machine', 'identity_drift', 'stale_human'])('holds native ambiguity: %s', variant => {
    const value = evidence({ messages: 2 });
    if (variant === 'unknown') Object.assign(value.s.snapshot.members[0].copies[1].storage,
      { status: 'unqualified', physicalDiskIdsSha256: [], blockers: ['mount_type_unsupported'] });
    if (variant === 'same_machine') for (let i = 0; i < 2; i++) {
      value.s.snapshot.members[i].copies[1].machineIdSha256 = '1'.repeat(64);
      value.preview.manifest.restoration.snapshot.members[i].snapshot.copies[1].machineIdSha256 = '1'.repeat(64);
    }
    if (variant === 'identity_drift') {
      value.s.snapshot.members[1].copies[1].archiveIdSha256 = 'f'.repeat(64);
      value.preview.manifest.restoration.snapshot.members[1].snapshot.copies[1].archiveIdSha256 = 'f'.repeat(64);
    }
    if (variant === 'stale_human') value.d.currentObservation.snapshot.confirmationStatus = 'changed';
    const result = evaluate(refresh(value)); expect(result.preservationAccepted).toBe(false); expect(result.remainingNativeValidationGaps).toContain(GAP);
  });
  test.each([
    v => { v.s.snapshot.members.pop(); },
    v => { v.s.snapshot.members.reverse(); },
    v => { v.s.snapshot.coreScopes[0].members[0].entryRevision = 2; },
    v => { v.s.snapshot.members[0].copies[0].content.metadataSha256 = 'f'.repeat(64); },
    v => { v.s.snapshot.members[0].copies[0].storage.files = true; },
    v => { v.s.snapshot.members[0].copies[0].storage.physicalIndependenceAccepted = true; }
  ])('omitted, reordered or mismatched native evidence is unavailable, never partial acceptance', mutate => {
    const value = evidence({ messages: 2 }); mutate(value); value.s.fingerprint = digest(value.s.snapshot);
    expect(() => evaluate(value)).toThrow(expect.objectContaining({ statusCode: 503 }));
  });
});
