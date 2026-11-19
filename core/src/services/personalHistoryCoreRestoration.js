'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const scope = require('./personalHistoryMessageScope');
const contract = require('./personalHistoryCoreRestorationContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const { GAPS } = require('./personalHistoryPreservationContract');

function unavailable() {
  return failure('The selected native Core storage cannot be qualified.', 503, 'HISTORY_CORE_RESTORATION_UNAVAILABLE');
}

async function read(sources, notes) {
  try {
    // Source collection validators/options are not a restore input. This
    // bounded capability qualifies the product's ordinary model collections.
    for (const model of [Entry, MemoryNote]) {
      const info = await model.db.db.listCollections({ name: model.collection.name }, { nameOnly: false }).next();
      if (!info || info.type !== 'collection' || Object.keys(info.options || {}).length) throw unavailable();
    }
    const indexes = { history: await Entry.collection.indexes(), souvenirs: await MemoryNote.collection.indexes() };
    // Last source query follows index/catalog reads and all privacy awaits.
    const selected = await scope.observeSelection(sources, { souvenirs: notes, fullDocuments: true });
    return { selected, payload: { history: { documents: selected.documents.history, indexes: indexes.history },
      souvenirs: { documents: selected.documents.souvenirs, indexes: indexes.souvenirs } } };
  } catch (error) {
    if (error.statusCode === 413) throw failure('The complete selected Core documents exceed their capacity.', 413, 'HISTORY_CORE_RESTORATION_CAPACITY');
    if (error.statusCode === 409) throw contract.changed();
    throw unavailable();
  }
}

function scratchReaders(restored, notes) {
  const entryStore = { aggregate: pipeline => ({ option: options => restored.history.aggregate(pipeline, options).toArray() }) };
  const souvenirs = { historyEvidenceLookup: options => {
    const plan = notes.historyEvidenceLookup(options);
    return { ...plan, stage: { $lookup: { ...plan.stage.$lookup, from: restored.souvenirs.collectionName } } };
  } };
  return { entryStore, souvenirs };
}

async function discover(input, deps) {
  if (deps?.audience !== 'owner') throw failure('Core restoration evidence belongs to the owner surface.', 403, 'HISTORY_CORE_RESTORATION_SCOPE');
  const sources = contract.selection(input);
  const notes = deps.notes || require('./memoryNoteService').personal();
  const initial = await read(sources, notes);
  const bindings = contract.bindings(sources, initial.selected), bindingsSha256 = digest(bindings);
  if (input.expectedBindingsSha256 !== undefined && input.expectedBindingsSha256 !== bindingsSha256) throw contract.changed();
  const engine = require('./coreTemporaryRestoration');
  const before = engine.describe(initial.payload);
  const restoration = await engine.restore(Entry.db.db, initial.payload, { expectedVerificationSha256: bindingsSha256,
    verify: async restored => {
      // Reuse actual owner queries, policy, projections and decision hashes on
      // the restored collections, rather than merely parsing a JSON export.
      const selected = await scope.observeSelection(sources, { ...scratchReaders(restored, notes), fullDocuments: true });
      return digest(contract.bindings(sources, selected));
    } });
  const final = await read(sources, notes);
  if (digest(engine.describe(final.payload)) !== digest(before)
    || digest(contract.bindings(sources, final.selected)) !== bindingsSha256) throw contract.changed();
  const snapshot = { contract: contract.CONTRACT, bindings, bindingsSha256, restoration };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
    throw failure('The complete Core restoration proof exceeds its capacity.', 413, 'HISTORY_CORE_RESTORATION_CAPACITY');
  }
  const fingerprint = digest(snapshot);
  return { authority: 'agentx.core', contract: contract.CONTRACT, observationId: input.observationId, observedAt: new Date().toISOString(),
    snapshot, fingerprint, status: input.expected === undefined ? 'observed' : input.expected === fingerprint ? 'observed_match' : 'changed',
    consistency: 'native-typed-core-restore-with-final-source-fence', scope: 'selected-current-history-and-linked-active-souvenirs',
    indexState: 'mongo-index-definitions-only', reviewOnly: true, atomicBatch: false, semanticAcceptance: false,
    authenticatedPerson: null, canonicalEffects: 0, executionAllowed: false, cleanupStatus: 'blocked', nativeValidationGaps: GAPS };
}

module.exports = { discover, CONTRACT: contract.CONTRACT };
