'use strict';

const { randomUUID } = require('node:crypto');
const messageScope = require('./personalHistoryMessageScope');
const decisions = require('./personalHistoryGlobalDecisions');
const downstream = require('./personalHistoryGlobalDownstream');
const restoration = require('./personalHistoryRestorationScope');
const mailbox = require('./personalHistoryMailboxScope');
const singleDownstream = require('./personalHistoryDownstreamScope');
const history = require('./personalHistoryService');
const contract = require('./personalHistoryReviewManifestContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');

async function discover(input, deps) {
  if (deps?.audience !== 'owner' || ['findings', 'preservation', 'mailbox'].some(key => deps[key]?.audience !== 'owner')) {
    throw failure('Native review manifests belong to the owner surface.', 403, 'HISTORY_REVIEW_MANIFEST_SCOPE');
  }
  const { checks, sources, before } = contract.selection(input);
  const notes = deps.findings.notes || require('./memoryNoteService').personal();
  const initial = await messageScope.observeSelection(sources, { souvenirs: notes });
  if (initial.messages.some(row => row.members.some(pin => pin.sourceBinding !== 'exact'))) throw contract.changed();
  const decisionProof = await decisions.discover({ sources, observationId: randomUUID() }, deps.findings);
  const expectedScopes = initial.messages.map(({ reference, members }) => ({ reference, contract: messageScope.CONTRACT, members,
    fingerprint: digest({ contract: messageScope.CONTRACT, reference, entries: members }) }));
  if (!contract.same(decisionProof.snapshot.coreScopes, expectedScopes)) throw contract.changed();
  const downstreamProof = await downstream.discover({ sources, observationId: randomUUID() }, deps.findings);
  for (let i = 0; i < sources.length; i++) {
    const pins = initial.messages[i].members, ids = new Set(pins.map(row => row.entryId));
    const links = singleDownstream.links(initial.rows.filter(row => ids.has(String(row._id))).map(history.project), initial.souvenirs, pins);
    if (!contract.same(downstreamProof.snapshot.members[i]?.snapshot.entries, links)) throw contract.changed();
  }
  const restored = await restoration.observe({ checks, observationId: randomUUID(), verification: 'review-restoration' }, deps.preservation);
  const live = [];
  for (const reference of sources) {
    const value = await mailbox.discover({ source: reference, observationId: randomUUID() }, deps.mailbox);
    live.push({ reference, fingerprint: value.fingerprint, snapshot: value.snapshot });
  }
  const snapshot = contract.build(before, checks, { decisions: decisionProof, downstream: downstreamProof, restoration: restored, mailbox: live });
  // This final joined read follows every native archive/restore/provider call.
  // Earlier linked notes can change during later long restoration probes;
  // an earlier per-component fence must never stand for this final graph.
  const final = await messageScope.observeSelection(sources, { souvenirs: notes });
  if (!contract.same(initial.messages, final.messages) || !contract.same(initial.souvenirs, final.souvenirs)) throw contract.changed();
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: contract.CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'composed-native-scopes-with-final-joined-core-note-fence', reviewOnly: true,
    atomicBatch: false, semanticAcceptance: false, authenticatedPerson: null, mailboxEffects: 0, approvalBound: false,
    executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT: contract.CONTRACT };
