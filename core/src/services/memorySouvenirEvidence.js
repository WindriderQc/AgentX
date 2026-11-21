'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { digest } = require('./personalHistorySourceReviewSources');
const error = (message, statusCode) => Object.assign(new Error(message), { statusCode, code: 'MEMORY_NOTE_INVALID' });
const stages = ({ includeEmbedding = false } = {}) => [...(includeEmbedding ? [] : [{ $project: { embedding: 0 } }]), { $project: { bytes: { $bsonSize: '$$ROOT' },
  row: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, 512 * 1024] }, '$$ROOT', null] } } }];

function summarize(packets, project) {
  if (packets.some(packet => !packet.row) || packets.reduce((sum, packet) => sum + packet.bytes, 0) > 8 * 1024 * 1024) {
    throw error('The complete souvenir evidence exceeds its bounded capacity', 413);
  }
  const unique = new Map();
  for (const { row } of packets) {
    if (!Number.isSafeInteger(row.revision ?? 0) || (row.revision ?? 0) < 0
      || !Array.isArray(row.sourceRefs) || row.sourceRefs.length > 125) throw error('Invalid native souvenir metadata', 409);
    const note = { id: String(row._id), revision: row.revision ?? 0,
      fingerprint: digest({ note: project(row), status: row.status, contentHash: row.contentHash || null, sourceTraceId: row.sourceTraceId || null,
        replacement: row.replacement || null, replacementKey: row.replacementKey || null, rollbackKey: row.rollbackKey || null }),
      sourceRefs: row.sourceRefs.map(ref => ({ system: ref.system, id: ref.id })),
      historyContextSha256: digest(row.historyContext || null),
      replacementPending: ['preparing', 'linked', 'undoing'].includes(row.replacement?.phase) };
    if (unique.has(note.id) && digest(unique.get(note.id)) !== digest(note)) throw error('A shared souvenir changed during observation', 409);
    unique.set(note.id, note);
  }
  return [...unique.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Called only from the trusted owner memory space: its active filter and
// projection remain the same as the ordinary selected souvenir reader.
function historyLookup(active, project, options) {
  return { stage: { $lookup: { from: MemoryNote.collection.name,
    let: { selectedNote: { $convert: { input: '$row.souvenirNoteId', to: 'objectId', onError: null, onNull: null } } },
    pipeline: [{ $match: { ...active, kind: 'souvenir', status: 'active',
      $expr: { $eq: ['$_id', '$$selectedNote'] } } }, ...stages(options)], as: 'souvenirEvidence' } },
  summarize: packets => summarize(packets, project) };
}

module.exports = { stages, summarize, historyLookup };
