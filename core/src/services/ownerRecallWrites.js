'use strict';

const { randomUUID } = require('node:crypto');
const Recall = require('../../models/OwnerRecallDocument');
const WC = { w: 1, j: true };
const failure = (message, code) => Object.assign(new Error(message), { statusCode: 409, code });

// A durable writer has no clock-based takeover: a lost RAG response can still
// finish after Core restarts. The forgotten marker always hides the document.
async function claim(value) {
  const writerToken = randomUUID();
  try {
    const row = await Recall.findOneAndUpdate({ documentId: value.documentId,
      state: { $ne: 'forgotten' }, writerToken: null }, { $set: {
      scope: 'owner', kind: value.kind, state: 'indexing', writerToken, writerStartedAt: new Date()
    } }, { upsert: true, new: false, runValidators: true, writeConcern: WC }).lean();
    return { row, writerToken };
  } catch (error) {
    if (error.code !== 11000) throw error;
    const row = await Recall.findOne({ documentId: value.documentId }).lean();
    if (row?.state === 'forgotten') return null;
    throw failure('A previous recall write requires settlement before another index attempt.', 'OWNER_RECALL_WRITE_PENDING');
  }
}

async function clearWriter(documentId, writerToken) {
  const reply = await Recall.updateOne({ documentId, writerToken, state: { $in: ['forgotten', 'inactive'] } },
    { $set: { writerToken: null, writerStartedAt: null } }, { writeConcern: WC });
  if (reply.matchedCount !== 1) throw failure('Recall writer settlement requires reconciliation.', 'OWNER_RECALL_WRITE_PENDING');
}

async function store(values, { write, erase }) {
  const result = { indexed: 0, unchanged: 0, refusedForgotten: 0, metadataUpdated: 0 };
  for (const value of values) {
    const prior = await Recall.findOne({ documentId: value.documentId }).lean();
    if (prior?.state === 'forgotten') { result.refusedForgotten++; continue; }
    if (prior?.writerToken) throw failure('A previous recall write requires settlement.', 'OWNER_RECALL_WRITE_PENDING');
    if (prior?.contentHash === value.contentHash && prior?.state === 'indexed') { result.unchanged++; continue; }
    const owned = await claim(value);
    if (!owned) { result.refusedForgotten++; continue; }
    const { row, writerToken } = owned;
    const { text: _omitted, indexText: _indexText, ...record } = value;
    const metadataOnly = row?.state === 'indexed' && row.indexTextHash === value.indexTextHash && row.indexedAt;
    let chunkCount = row?.chunkCount;
    if (!metadataOnly) {
      // Failure retains this exact writer. Neither an age nor an HTTP timeout
      // proves that the remote upsert finished; no replacement is dispatched.
      const reply = await write({ documents: [{ documentId: value.documentId, text: value.indexText,
        forceReindex: Boolean(row?.indexedAt) }] });
      const receipt = reply?.results?.find(r => r.documentId === value.documentId);
      if (!Number.isSafeInteger(receipt?.chunkCount) || receipt.chunkCount < 0) {
        throw Object.assign(new Error('RAG returned an incomplete recall write receipt; retain the writer for reconciliation.'),
          { statusCode: 502, code: 'OWNER_RECALL_WRITE_PENDING' });
      }
      chunkCount = receipt.chunkCount;
    }
    const saved = await Recall.updateOne({ documentId: value.documentId, writerToken, state: 'indexing' },
      { $set: { ...record, scope: 'owner', state: 'indexed', chunkCount, indexedAt: new Date(),
        writerToken: null, writerStartedAt: null } }, { writeConcern: WC });
    if (saved.matchedCount === 1) {
      result.indexed++;
      if (metadataOnly) result.metadataUpdated++;
      continue;
    }
    // The owner forgot while the upsert was in flight. It cannot become indexed
    // again. The now-terminal writer removes any late vectors before settling.
    await erase(value.documentId);
    await clearWriter(value.documentId, writerToken);
    result.refusedForgotten++;
  }
  return result;
}

async function forget(documentId, { erase }, { inactive = false } = {}) {
  let row;
  const filter = { documentId, ...(inactive ? { state: { $ne: 'forgotten' } } : {}) };
  const update = { $set: { scope: 'owner', kind: documentId.split(':')[0], state: inactive ? 'inactive' : 'forgotten',
    title: '', people: [], occurredAt: null, source: {}, chunkCount: 0 } };
  try {
    row = await Recall.findOneAndUpdate(filter, update, { new: true, upsert: true, writeConcern: WC }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    row = await Recall.findOneAndUpdate(filter, update, { new: true, writeConcern: WC }).lean();
    if (!row && inactive) return { authority: 'agentx.core', documentId, forgotten: true };
  }
  if (row.writerToken) {
    throw failure('The document is hidden. Its in-flight index must settle before forgetting can be confirmed.',
      'OWNER_RECALL_FORGET_PENDING');
  }
  await erase(documentId);
  return { authority: 'agentx.core', documentId, forgotten: true };
}

module.exports = { store, forget };
