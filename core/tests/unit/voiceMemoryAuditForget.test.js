'use strict';

const { createVoixMemoryAuditWorker } = require('../../surfaces/household/voice-memory-audit');

function harness(notes) {
  const turn = { traceId: 'trace-1', source: 'voix-native', memoryState: 'captured', inputText: '' };
  const updates = [];
  const conversations = {
    updateTurn: jest.fn(async (filter, update) => {
      updates.push(update.$set);
      return filter.memoryState === 'captured' ? turn : null;
    }),
  };
  const personalNotes = {
    list: jest.fn(async ({ query }) => {
      const hits = notes.filter(note => note.text.toLowerCase().includes(query.toLowerCase()));
      return { notes: hits.slice(0, 2), total: hits.length };
    }),
    forget: jest.fn(async id => ({ removed: true, id })),
  };
  const worker = createVoixMemoryAuditWorker({ conversations, personalNotes, models: {},
    cleanText: (value, max) => String(value || '').trim().slice(0, max), logger: null });
  return { turn, updates, personalNotes, worker };
}

const notes = [
  { id: 'a'.repeat(24), text: 'Synthetic dentist appointment on Tuesday' },
  { id: 'b'.repeat(24), text: 'Synthetic dentist prefers mornings' },
  { id: 'c'.repeat(24), text: 'Synthetic library card renewal' },
];

describe('voice "forget" requests', () => {
  test('forget the single note a phrase matches', async () => {
    const { turn, personalNotes, worker } = harness(notes);
    turn.inputText = 'Oublie library card';
    const result = await worker.processVoixMemoryAudit('trace-1');
    expect(personalNotes.forget).toHaveBeenCalledWith('c'.repeat(24));
    expect(result.memoryIds).toEqual([`forgotten:${'c'.repeat(24)}`]);
  });

  test('leave every note when a phrase matches several', async () => {
    const { turn, personalNotes, worker } = harness(notes);
    turn.inputText = 'Oublie dentist';
    const result = await worker.processVoixMemoryAudit('trace-1');
    expect(personalNotes.forget).not.toHaveBeenCalled();
    expect(result.memoryIds).toEqual(['forget:ambiguous:2']);
  });

  test('record a miss without forgetting anything', async () => {
    const { turn, personalNotes, worker } = harness(notes);
    turn.inputText = 'Oublie le garage';
    const result = await worker.processVoixMemoryAudit('trace-1');
    expect(personalNotes.forget).not.toHaveBeenCalled();
    expect(result.memoryIds).toEqual(['forgotten:no-match']);
  });

  test('ignore a phrase too short to name a note', async () => {
    const { turn, personalNotes, worker } = harness([{ id: 'd'.repeat(24), text: 'Synthetic ça marche' }]);
    turn.inputText = 'Oublie ça';
    const result = await worker.processVoixMemoryAudit('trace-1');
    expect(personalNotes.list).not.toHaveBeenCalled();
    expect(personalNotes.forget).not.toHaveBeenCalled();
    expect(result.memoryIds).toEqual(['forgotten:no-match']);
  });
});
