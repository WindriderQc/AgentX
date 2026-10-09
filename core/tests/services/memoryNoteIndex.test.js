'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace } = require('../../src/services/memoryNoteService');
const { createIndex, cosine } = require('../../src/services/memoryNoteIndex');

// A tiny stand-in for the embedding model: one axis per topic word.
const AXES = ['coffee', 'tea', 'hockey', 'garden'];
const SYNONYMS = { espresso: 'coffee', latte: 'coffee', drink: 'coffee', canadiens: 'hockey', skating: 'hockey', tomatoes: 'garden' };
const fakeEmbed = async (text) => {
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  return AXES.map(axis => words.filter(word => word === axis || SYNONYMS[word] === axis).length + 0.01);
};
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

describe('memory note meaning index with real Mongo', () => {
  let embed, model, index, owner, family;
  beforeAll(async () => { await MemoryNote.createCollection(); await MemoryNote.createIndexes(); });
  beforeEach(async () => {
    await MemoryNote.deleteMany({});
    embed = jest.fn(fakeEmbed);
    model = 'fake-embed-v1';
    index = createIndex({ embed: (...args) => embed(...args), model: () => model });
    owner = forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'], index });
    family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'], index });
  });

  test('a note is found by meaning without a word in common', async () => {
    await owner.remember({ text: 'I never touch espresso in the morning' });
    await owner.remember({ text: 'The tomatoes need water twice a week' });
    await settle();
    const found = await owner.similar('What do I drink at breakfast?', { minScore: 0.5 });
    expect(found.results[0].notes.map(note => note.text)).toEqual(['I never touch espresso in the morning']);
    expect((await owner.search('What do I drink at breakfast?')).notes).toEqual([]);
    expect(found).toMatchObject({ indexed: 2, unindexed: 0 });
  });

  test('ordinary reads never carry the vector', async () => {
    const saved = await owner.remember({ text: 'Hockey night is Saturday' });
    await settle();
    expect(Object.keys(saved)).not.toContain('embedding');
    expect(Object.keys((await owner.list()).notes[0])).not.toContain('embedding');
    expect((await owner.similar('skating')).results[0].notes[0]).not.toHaveProperty('embedding');
    const row = await MemoryNote.findById(saved.id).select('+embedding').lean();
    expect(row.embedding).toHaveLength(AXES.length);
    expect(row.embeddingModel).toBe('fake-embed-v1');
  });

  test('a search by meaning stays inside its space, both ways', async () => {
    await owner.remember({ text: 'Private: my coffee budget is too high' });
    const shared = await family.record({ text: 'Family rule: no coffee for children' });
    await settle();
    expect((await family.similar('coffee')).results[0].notes.map(note => note.id)).toEqual([shared.id]);
    expect((await owner.similar('coffee')).results[0].notes.map(note => note.text)).toEqual(['Private: my coffee budget is too high']);
  });

  test('forgotten and expired notes leave the index with the note', async () => {
    const gone = await owner.remember({ text: 'Old tea preference' });
    await settle();
    await owner.forget(gone.id);
    await MemoryNote.create({ packId: 'personal_operator', scopeId: 'personal', scope: 'owner', sensitivity: 'private',
      text: 'Expired tea note', expiresAt: new Date(Date.now() - 1000), embedding: await fakeEmbed('tea'),
      embeddingModel: 'fake-embed-v1', embeddedHash: require('node:crypto').createHash('sha256').update('Expired tea note').digest('hex') });
    expect((await owner.similar('tea')).results[0].notes).toEqual([]);
  });

  test('a corrected note is searched by its new text, never its old vector', async () => {
    const saved = await owner.remember({ text: 'I love coffee' });
    await settle();
    await MemoryNote.updateOne({ _id: saved.id }, { $set: { text: 'I love hockey' } });
    expect((await owner.similar('coffee', { minScore: 0.5 })).results[0].notes).toEqual([]);
    expect(await owner.similar('coffee')).toMatchObject({ indexed: 0, unindexed: 1 });
    expect(await owner.reindex()).toMatchObject({ stale: 1, indexed: 1, failed: 0 });
    expect((await owner.similar('canadiens', { minScore: 0.5 })).results[0].notes.map(note => note.id)).toEqual([saved.id]);
  });

  test('a note is saved even when the embedding host is down, and indexed by a later rebuild', async () => {
    embed.mockRejectedValue(new Error('embedding unavailable'));
    const saved = await owner.remember({ text: 'Garden plan for spring' });
    await settle();
    expect((await owner.list()).notes.map(note => note.id)).toEqual([saved.id]);
    const down = await owner.similar('tomatoes');
    expect(down).toMatchObject({ indexed: 0, unindexed: 1 });
    expect(down.results[0].notes).toEqual([]);
    expect(await owner.reindex()).toMatchObject({ stale: 1, indexed: 0, failed: 1, lastError: 'embedding unavailable' });
    embed.mockImplementation(fakeEmbed);
    expect(await owner.reindex()).toMatchObject({ stale: 1, indexed: 1 });
    expect((await owner.similar('tomatoes', { minScore: 0.5 })).results[0].notes).toHaveLength(1);
  });

  test('changing the embedding model makes every vector stale until rebuilt', async () => {
    await owner.remember({ text: 'Tea in the afternoon' });
    await settle();
    model = 'fake-embed-v2';
    expect(await owner.similar('tea')).toMatchObject({ indexed: 0, unindexed: 1 });
    expect(await owner.reindex()).toMatchObject({ model: 'fake-embed-v2', stale: 1, indexed: 1 });
    expect(await owner.similar('tea')).toMatchObject({ indexed: 1, unindexed: 0 });
  });

  test('rebuilding one space leaves the other untouched', async () => {
    await family.record({ text: 'Family garden day' });
    await settle();
    model = 'fake-embed-v2';
    expect(await owner.reindex()).toMatchObject({ notes: 0, stale: 0 });
    expect(await family.reindex()).toMatchObject({ notes: 1, stale: 1, indexed: 1 });
  });

  test('cosine refuses mismatched or empty vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});
