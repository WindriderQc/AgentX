'use strict';

const Entry = require('../../models/PersonalHistoryEntry');
const MemoryNote = require('../../models/MemoryNote');
const Suppression = require('../../models/PersonalHistorySuppression');
const history = require('../../src/services/personalHistoryService');
const { forSpace, personal } = require('../../src/services/memoryNoteService');
const { handleMcpMessage } = require('../../src/services/mcpSkillBus');
const { memoryBlock } = require('../../surfaces/household/persona-prompt');

const source = n => ({ system: 'gmail', threadId: `thread0${n}`, messageId: `message${n}`,
  sourceSha256: String(n).repeat(64), findingId: 'e'.repeat(64), direction: 'received' });

async function keepSynthetic() {
  const { entry } = await history.record({ kind: 'fact', text: 'Synthetic canoe trip on the lake with a friend',
    sourceDate: '2016-08-01T12:00:00Z', people: ['Synthetic Friend'], places: ['Synthetic Lake'],
    relatedSources: [source(2)], source: source(1) });
  return history.keepAsSouvenir(entry.id, { revision: 0, eventDate: '2016-07-30', eventDatePrecision: 'day' });
}

describe('Nestor recalls a kept souvenir with its date, people and sources', () => {
  beforeAll(async () => {
    for (const model of [Entry, MemoryNote, Suppression]) { await model.createCollection(); await model.createIndexes(); }
  });
  beforeEach(async () => { await Entry.deleteMany({}); await MemoryNote.deleteMany({}); await Suppression.deleteMany({}); });

  test('the owner voice prompt shows the date, people, places and source count', async () => {
    const { souvenirNoteId } = await keepSynthetic();
    const { notes } = await personal().search('canoe trip lake');
    expect(notes[0]).toMatchObject({ id: souvenirNoteId, kind: 'souvenir', people: ['Synthetic Friend'] });
    const block = memoryBlock(notes);
    expect(block).toContain('[kept from archived mail] 2016-07-30 : Synthetic canoe trip on the lake with a friend');
    expect(block).toContain('(souvenir; people: Synthetic Friend; places: Synthetic Lake; sources: 2 archived messages)');
  });

  test('a souvenir whose text does not hold its date gets the date in the prompt', () => {
    const block = memoryBlock([{ kind: 'souvenir', text: 'Synthetic move to a new house', eventDate: '2014-05-01',
      people: [], places: [], sourceRefs: [{ system: 'personal-history', id: 'a'.repeat(24) }] }]);
    expect(block).toContain('- Synthetic move to a new house (souvenir; date 2014-05-01)');
    expect(memoryBlock([{ kind: 'fact', text: 'Synthetic plain note', people: ['Ignored'] }])).toContain('- Synthetic plain note\n'.trim());
    expect(memoryBlock([{ kind: 'fact', text: 'Synthetic plain note', people: ['Ignored'] }])).not.toContain('Ignored');
  });

  test('MCP memory_search returns the souvenir date, people and sources', async () => {
    const { souvenirNoteId } = await keepSynthetic();
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'memory_search', arguments: { query: 'canoe trip' } } });
    expect(response.result.structuredContent.notes[0]).toMatchObject({ id: souvenirNoteId, kind: 'souvenir',
      eventDate: '2016-07-30', eventDatePrecision: 'day', people: ['Synthetic Friend'], places: ['Synthetic Lake'] });
    expect(response.result.structuredContent.notes[0].sourceRefs).toHaveLength(3);
  });

  test('family spaces and child-safe recall never see the owner souvenir', async () => {
    await keepSynthetic();
    for (const space of [{ audience: 'household', scopeId: 'personal', packIds: ['personal_operator'] },
      { audience: 'household', scopeId: 'family', packIds: ['voix_family'] }]) {
      const notes = forSpace(space);
      expect((await notes.search('canoe trip lake')).notes).toEqual([]);
      expect((await notes.list({ kind: 'souvenir' })).total).toBe(0);
    }
  });
});
