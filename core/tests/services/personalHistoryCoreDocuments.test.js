'use strict';
jest.mock('../../src/services/memoryNoteIndex', () => ({ createIndex: () => ({ indexNote: async () => false }) }));
jest.mock('../../src/services/souvenirRecallSync', () => ({ scheduleSouvenirRecallSync: jest.fn() }));
const { BSON } = require('mongoose').mongo;
const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const memory = require('../../src/services/memoryNoteService');
const scope = require('../../src/services/personalHistoryMessageScope');
const codec = require('../../src/services/personalHistoryCoreDocuments');
const { source } = require('../fixtures/historyFindingProof');

describe('internal full Core BSON reader with unchanged metadata-only defaults', () => {
  let id, noteId;
  const reference = Object.fromEntries(['system', 'messageId', 'threadId', 'sourceSha256'].map(k => [k, source[k]]));
  const read = fullDocuments => scope.observeSelection([reference], { souvenirs: memory.personal(), fullDocuments });
  beforeAll(async () => { for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); } });
  beforeEach(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) await model.deleteMany({});
    id = (await history.record({ kind: 'fact', text: 'Synthetic private BSON source', sourceDate: null, source })).entry.id;
    noteId = (await history.keepAsSouvenir(id, { revision: 0 })).souvenirNoteId;
  });
  const scalar = () => ({ double: new BSON.Double(1), integer: new BSON.Int32(2),
    long: BSON.Long.fromString('9007199254740999'), binary: new BSON.Binary(Buffer.from([1, 2, 3])),
    date: new Date('2001-01-01T00:00:00.000Z'), unknownBody: 'Synthetic complete private body' });

  test('native raw aggregation preserves complete source BSON types and embedding bytes without changing v1 pins', async () => {
    const oid = new BSON.ObjectId(id), nid = new BSON.ObjectId(noteId);
    await Entry.collection.updateOne({ _id: oid }, { $set: { restorationMarker: scalar(),
      context: { revision: 1, inputHash: 'a'.repeat(64), sources: [{ id: 'synthetic-body', kind: 'mail',
        bodySha256: 'b'.repeat(64), body: 'Synthetic private context body' }], timeline: {} } } });
    await MemoryNote.collection.updateOne({ _id: nid }, { $set: { restorationMarker: scalar(), embedding: [new BSON.Double(0.25)] } });
    const ordinary = await read(false), full = await read(true);
    expect(full.messages).toEqual(ordinary.messages); expect(full.souvenirs).toEqual(ordinary.souvenirs);
    expect(ordinary.documents).toBeUndefined(); expect(ordinary.rows[0].context.sources[0].body).toBeUndefined();
    expect(full.documents.history[0].context.sources[0].body).toBe('Synthetic private context body');
    const h = full.documents.history[0], n = full.documents.souvenirs[0];
    expect(h.restorationMarker.double).toBeInstanceOf(BSON.Double);
    expect(h.restorationMarker.integer).toBeInstanceOf(BSON.Int32);
    expect(h.restorationMarker.long).toBeInstanceOf(BSON.Long);
    expect(h.restorationMarker.binary).toBeInstanceOf(BSON.Binary);
    expect(h.restorationMarker.date).toBeInstanceOf(Date);
    expect(n.embedding[0]).toBeInstanceOf(BSON.Double);
    expect(BSON.serialize(h).equals(await Entry.collection.findOne({ _id: oid }, { raw: true }))).toBe(true);
    expect(BSON.serialize(n).equals(await MemoryNote.collection.findOne({ _id: nid }, { raw: true }))).toBe(true);
  });
  test('complete source bodies and vectors consume the bounded native record budget', async () => {
    await Entry.collection.updateOne({ _id: new BSON.ObjectId(id) }, { $set: { privateExtra: 'x'.repeat(600 * 1024) } });
    await expect(read(true)).rejects.toMatchObject({ statusCode: 413 });
  });
  test('forgotten rows are not copied into a restoration candidate', async () => {
    await history.review(id, { revision: 1, state: 'forgotten' });
    const full = await read(true);
    expect(full.documents).toEqual({ history: [], souvenirs: [] });
  });
  test('unsupported raw BSON cannot silently become a normalized JSON document', () => {
    const undefinedDocument = Buffer.from([8, 0, 0, 0, 6, 120, 0, 0]);
    const header = Buffer.alloc(4); header.writeInt32LE(18);
    const frame = Buffer.concat([header, Buffer.from([3, 114, 111, 119, 0]), undefinedDocument, Buffer.from([0])]);
    expect(() => codec.typedDocuments([frame])).toThrow(expect.objectContaining({ statusCode: 503, code: 'HISTORY_CORE_DOCUMENT_FORMAT' }));
    expect(() => codec.typedDocuments([{}])).toThrow(expect.objectContaining({ statusCode: 503 }));
  });
});
