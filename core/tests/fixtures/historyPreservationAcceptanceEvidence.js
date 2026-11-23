'use strict';
const { randomUUID } = require('node:crypto');
const { storagePacket } = require('./historyStoragePacket');
const storage = require('../../src/services/personalHistoryStorageContract');
const { reconcile } = require('../../src/services/personalHistoryFindingContract');
const decision = require('../../src/services/personalHistoryDecisionAcceptancePolicy');
const { digest } = require('../../src/services/personalHistorySourceReviewSources');

// Minimal pure policy inputs. Native transport/receipt/Core restoration paths
// have a separate real HTTP/files/Mongo fixture, with no supplied proof inputs.
function evidence({ messages = 1, invoiceRetained = false, confirmationStatus = 'current' } = {}) {
  const sources = Array.from({ length: messages }, (_, i) => ({ system: 'gmail', messageId: '1234567890abcde' + i,
    threadId: '2234567890abcdef', sourceSha256: 'a'.repeat(64) }));
  const findings = [], linked = [], restored = [], members = [], coreScopes = [];
  sources.forEach((reference, i) => {
    const entryId = 'b'.repeat(23) + i, findingId = 'c'.repeat(63) + i, fingerprint = 'd'.repeat(64);
    const pins = [{ entryId, entryRevision: 1, fingerprint, sourceBinding: 'exact' }];
    const inventory = { reference, findings: [{ findingId, section: invoiceRetained ? 'invoices' : 'memories' }], threadQuestions: [] };
    const entry = { id: entryId, revision: 1, kind: invoiceRetained ? 'invoice' : 'fact', reviewState: 'retained',
      source: { ...reference, findingId }, decision: { reason: 'Synthetic recorded decision', at: '2026-01-01T00:00:00.000Z' } };
    const snapshot = { inventory, coreScope: { members: pins }, coverage: reconcile(inventory, [entry], [{ fingerprint,
      snapshot: { entryId, pendingSourceDecisions: 0 } }]) };
    const finding = { reference, fingerprint: digest(snapshot), snapshot }; findings.push(finding);
    linked.push({ reference, snapshot: { reference, findingScope: { fingerprint: finding.fingerprint, snapshot },
      entries: [{ entryId, entryRevision: 1, decisionFingerprint: fingerprint, state: 'not_linked', note: null, blockers: [] }],
      coverage: { counts: { entries: 1, notLinked: 1, currentLinks: 0, unavailable: 0, needsReview: 0 }, blockers: [] } } });
    const nonce = randomUUID();
    const copies = ['primary', 'mirror'].map(copy => ({ copy, ...storage.describe(storagePacket({ ...reference, requestId: nonce }, copy), nonce, reference) }));
    restored.push({ source: reference, snapshot: { contract: 'agentx.history-preservation/v3', status: 'verified_scope',
      copies: copies.map(({ storage: ignored, ...copy }) => ({ ...copy, status: 'available' })) } });
    members.push({ reference, copies, coverage: storage.coverage(copies) }); coreScopes.push({ reference, members: pins });
  });
  const manifest = { sources, sourceSetSha256: digest(sources), checksSha256: 'e'.repeat(64), before: '2026-01-01T00:00:00.000Z',
    decisions: { snapshot: { findings } }, downstream: { snapshot: { members: linked } }, restoration: { snapshot: { members: restored } },
    coverage: { messages: sources.map(reference => ({ reference, blockers: [], reviewStatus: 'observed' })), counts: { messages, evidenceHeldMessages: 0 } } };
  const preview = { manifest, coreRestoration: { synthetic: 'native typed Core restoration' } };
  const currentSnapshot = { contract: 'agentx.history-manifest-confirmation-current/v1', confirmationStatus, selectedMessages: messages,
    sourceSetSha256: manifest.sourceSetSha256, checksSha256: manifest.checksSha256, before: manifest.before,
    current: { manifestSha256: digest(manifest), coreRestorationSha256: digest(preview.coreRestoration) } };
  const d = { authority: 'agentx.core', contract: decision.CONTRACT,
    currentObservation: { authority: 'agentx.core', contract: currentSnapshot.contract, snapshot: currentSnapshot, fingerprint: digest(currentSnapshot) } };
  const s = { authority: 'agentx.core', contract: 'agentx.history-storage-scope/v1',
    snapshot: { contract: 'agentx.history-storage-scope/v1', sources, sourceSetSha256: manifest.sourceSetSha256, coreScopes, members } };
  return refresh({ d, s, preview });
}

function refresh(value) {
  const { d, s, preview } = value;
  for (const member of s.snapshot.members) member.coverage = storage.coverage(member.copies);
  const held = s.snapshot.members.filter(row => row.coverage.blockers.length).length;
  s.snapshot.coverage = { counts: { messages: s.snapshot.members.length, distinctKernelDeviceMessages: s.snapshot.members.length - held, heldMessages: held },
    blockers: held ? ['selected_storage_evidence_held'] : [] }; s.fingerprint = digest(s.snapshot);
  d.currentObservation.snapshot.current.manifestSha256 = digest(preview.manifest);
  d.currentObservation.fingerprint = digest(d.currentObservation.snapshot);
  d.snapshot = decision.build(d.currentObservation, preview); d.fingerprint = digest(d.snapshot);
  d.decisionReconciliationAccepted = d.snapshot.decisionReconciliationAccepted;
  return value;
}

module.exports = { evidence, refresh };
