'use strict';

const MemoryNote = require('../../models/MemoryNote');
const { forSpace } = require('../../src/services/memoryNoteService');
const { createIndex } = require('../../src/services/memoryNoteIndex');
const dedup = require('../../src/services/memoryReview/dedupService');

const AXES = ['coffee', 'hockey', 'garden'];
const fakeEmbed = async (text) => {
  const words = String(text).toLowerCase().match(/[a-z]+/g) || [];
  return AXES.map(axis => words.filter(word => word === axis).length + 0.01);
};
const settle = () => new Promise(resolve => setTimeout(resolve, 60));
const noRag = { searchSimilarChunks: jest.fn().mockResolvedValue([]) };

describe('memory review dedup against the owner notes, real Mongo', () => {
  let embed, owner, family;
  beforeAll(async () => { await MemoryNote.createCollection(); await MemoryNote.createIndexes(); });
  beforeEach(async () => {
    await MemoryNote.deleteMany({});
    noRag.searchSimilarChunks.mockClear();
    embed = jest.fn(fakeEmbed);
    const index = createIndex({ embed: (...args) => embed(...args), model: () => 'fake-embed-v1' });
    owner = forSpace({ audience: 'owner', scopeId: 'personal', packIds: ['personal_operator'], index });
    family = forSpace({ audience: 'household', scopeId: 'family', packIds: ['kidx_nestor'], index });
  });

  const observation = (id, text) => ({ observationId: id, text, recurrence: { observationCount: 1 } });

  test('an existing owner note comes back as dedup context for the observation that repeats it', async () => {
    const note = await owner.remember({ text: 'coffee is not for me' });
    await family.record({ text: 'coffee is for grown-ups' });
    await settle();
    const context = await dedup.buildRagDedupContext(
      [observation('obs-1', 'I really dislike coffee'), observation('obs-2', 'hockey tonight')],
      { ragClient: noRag, ownerNotes: owner });
    expect(context.degraded).toBe(false);
    expect(context.ragMatches).toEqual([expect.objectContaining({
      observationId: 'obs-1', source: 'owner-memory', documentId: note.id, gist: 'coffee is not for me',
    })]);
    const conflicts = dedup.duplicateConflictsFor({ evidence: [{ observationId: 'obs-1' }] }, context.ragMatches);
    expect(conflicts).toEqual([expect.objectContaining({ authority: 'local_memory', sourceRef: note.id })]);
  });

  test('a final candidate statement that restates a note carries that note as a conflict', async () => {
    const note = await owner.remember({ text: 'garden work happens on Sunday' });
    await settle();
    const result = await dedup.searchCandidateDuplicates(
      [{ candidateId: 'c1', statement: 'Owner does the garden on Sunday' }, { candidateId: 'c2', statement: 'Owner watches hockey' }],
      { ragClient: noRag, ownerNotes: owner });
    expect(result.degraded).toBe(false);
    expect(result.byId.get('c1')).toEqual([expect.objectContaining({ authority: 'local_memory', sourceRef: note.id })]);
    expect(result.byId.get('c2') || []).toEqual([]);
  });

  test('with no note there is no embedding call and no degradation', async () => {
    const context = await dedup.buildRagDedupContext([observation('obs-1', 'coffee')], { ragClient: noRag, ownerNotes: owner });
    expect(context).toMatchObject({ ragMatches: [], degraded: false });
    expect(embed).not.toHaveBeenCalled();
  });

  test('notes that are not indexed yet degrade the dedup instead of reading as nothing known', async () => {
    embed.mockRejectedValueOnce(new Error('embedding unavailable'));
    await owner.remember({ text: 'coffee is not for me' });
    await settle();
    const context = await dedup.buildRagDedupContext([observation('obs-1', 'coffee')], { ragClient: noRag, ownerNotes: owner });
    expect(context.degraded).toBe(true);
    expect(context.degradedReason).toContain('1 owner note(s) are not indexed yet');
  });

  test('an embedding outage is reported as degraded dedup, never as "nothing known"', async () => {
    await owner.remember({ text: 'coffee is not for me' });
    await settle();
    embed.mockRejectedValue(new Error('embedding unavailable'));
    const context = await dedup.buildRagDedupContext([observation('obs-1', 'coffee')], { ragClient: noRag, ownerNotes: owner });
    expect(context.degraded).toBe(true);
    expect(context.degradedReason).toContain('owner notes could not be searched');
  });
});
