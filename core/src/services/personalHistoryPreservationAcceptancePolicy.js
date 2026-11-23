'use strict';

const decision = require('./personalHistoryDecisionAcceptancePolicy');
const storage = require('./personalHistoryStorageContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');
const CONTRACT = 'agentx.history-preservation-acceptance/v1';
const POLICY = 'native-distinct-machines-and-whole-devices/v1';
const GAP = 'native_preservation_acceptance_unavailable';
const unavailable = () => failure('The complete selected native preservation acceptance evidence is unavailable.', 503, 'HISTORY_PRESERVATION_ACCEPTANCE_UNAVAILABLE');
const requireEvidence = value => { if (!value) throw unavailable(); };
const same = (a, b) => a !== undefined && b !== undefined && digest(a) === digest(b);

function build(d, s, preview) {
  const manifest = preview?.manifest, current = d?.currentObservation;
  requireEvidence(d?.authority === 'agentx.core' && d.contract === decision.CONTRACT && d.fingerprint === digest(d.snapshot)
    && same(d.snapshot, decision.build(current, preview)) && d.decisionReconciliationAccepted === d.snapshot.decisionReconciliationAccepted
    && s?.authority === 'agentx.core' && s.contract === 'agentx.history-storage-scope/v1'
    && s.snapshot?.contract === s.contract && s.fingerprint === digest(s.snapshot)
    && same(s.snapshot.sources, manifest.sources) && s.snapshot.sourceSetSha256 === manifest.sourceSetSha256);
  const sources = manifest.sources, members = s.snapshot.members;
  const restores = manifest.restoration?.snapshot?.members;
  requireEvidence(Array.isArray(members) && members.length === sources.length && Array.isArray(restores) && restores.length === sources.length
    && same(members.map(row => row.reference), sources)
    && same(s.snapshot.coreScopes, manifest.decisions.snapshot.findings.map(row => ({ reference: row.reference, members: row.snapshot.coreScope.members }))));
  const blockers = new Set(), copies = [], unions = [new Set(), new Set()];
  let heldMessages = 0;
  for (let i = 0; i < members.length; i++) {
    const member = members[i], restored = restores[i];
    requireEvidence(same(restored.source, sources[i]) && restored.snapshot?.contract === 'agentx.history-preservation/v3'
      && restored.snapshot.status === 'verified_scope' && Array.isArray(restored.snapshot.copies) && restored.snapshot.copies.length === 2
      && Array.isArray(member.copies) && member.copies.length === 2);
    for (let j = 0; j < 2; j++) {
      const copy = member.copies[j], name = j === 0 ? 'primary' : 'mirror';
      requireEvidence(copy.copy === name);
      const { storage: topology, ...data } = copy;
      requireEvidence(same({ ...data, status: 'available' }, restored.snapshot.copies[j]));
      storage.describeStorage(topology, copy.restoration);
      if (!i) copies.push({ copy: name, machineIdSha256: copy.machineIdSha256, archiveIdSha256: copy.archiveIdSha256 });
      else if (copy.machineIdSha256 !== copies[j].machineIdSha256 || copy.archiveIdSha256 !== copies[j].archiveIdSha256) blockers.add('storage_copy_identity_changed');
      for (const id of topology.physicalDiskIdsSha256) unions[j].add(id);
      if (topology.status !== 'observed_local_devices') blockers.add('storage_topology_unqualified');
    }
    const coverage = storage.coverage(member.copies);
    requireEvidence(same(coverage, member.coverage));
    if (coverage.blockers.length) { heldMessages++; blockers.add('selected_storage_evidence_held'); }
  }
  requireEvidence(same(s.snapshot.coverage, { counts: { messages: sources.length,
    distinctKernelDeviceMessages: sources.length - heldMessages, heldMessages }, blockers: heldMessages ? ['selected_storage_evidence_held'] : [] }));
  if (copies[0].machineIdSha256 === copies[1].machineIdSha256) blockers.add('same_native_machine');
  if ([...unions[0]].some(id => unions[1].has(id))) blockers.add('selected_device_identity_overlap');
  if (current.snapshot.confirmationStatus !== 'current') blockers.add('human_confirmation_not_current');
  const accepted = blockers.size === 0;
  const snapshot = { contract: CONTRACT, scope: 'selected-originals-review-files-and-current-core-roundtrip', policy: POLICY,
    binding: { decisionReconciliationSha256: d.fingerprint, storageScopeSha256: s.fingerprint,
      manifestSha256: current.snapshot.current.manifestSha256, coreRestorationSha256: current.snapshot.current.coreRestorationSha256,
      sourceSetSha256: manifest.sourceSetSha256, checksSha256: manifest.checksSha256, before: manifest.before },
    copies: copies.map((copy, j) => ({ ...copy, physicalDiskIdsSha256: [...unions[j]].sort() })),
    counts: { messages: sources.length, primaryDisks: unions[0].size, mirrorDisks: unions[1].size, heldMessages },
    blockers: [...blockers].sort(), preservationStatus: accepted ? 'accepted_scope' : 'held_scope', preservationAccepted: accepted,
    decisionReconciliationAccepted: d.decisionReconciliationAccepted,
    remainingNativeValidationGaps: GAPS.filter(gap => !(gap === GAP && accepted) && !(gap === decision.GAP && d.decisionReconciliationAccepted)) };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024) throw failure('Complete native preservation metadata exceeds its capacity.', 413, 'HISTORY_PRESERVATION_ACCEPTANCE_CAPACITY');
  return snapshot;
}

module.exports = { CONTRACT, POLICY, GAP, build, unavailable };
