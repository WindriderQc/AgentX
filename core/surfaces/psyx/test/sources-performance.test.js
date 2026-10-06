'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSources } = require('../src/sources');
test('disabled dream sources perform no source reads and a subset reads only the selected source', async () => {
  const calls = [];
  const sources = createSources({ runtimeServices: { memory: { notes: { personal: () => ({ list: async () => { calls.push('notes'); return { notes: [] }; } }) } },
    tasks: { personal: { list: async () => { calls.push('tasks'); return { tasks: [] }; } } } }, mailJournal: { search: async () => { calls.push('mail'); return { entries: [] }; } } });
  assert.deepEqual(await sources.gather({ keys: [] }), { sources: [], unavailable: [] }); assert.deepEqual(calls, []);
  await sources.gather({ keys: ['tasks'] }); assert.deepEqual(calls, ['tasks']);
});

test('a 300-note collection declares the remaining notes and preserves the admitted text', async () => {
  const calls = [];
  const reader = createSources({ runtimeServices: { memory: { notes: { personal: () => ({
    list: async ({ offset }) => {
      calls.push(offset);
      return { notes: Array.from({ length: 100 }, (_, n) => ({ text: `note-${offset + n} END` })),
        total: 450, truncated: true, nextOffset: offset + 100 };
    }
  }) } } } });
  const { sources } = await reader.gather({ keys: ['notes'] });
  assert.deepEqual(calls, [0, 100, 200]);
  assert.deepEqual(sources[0].collection, { collectedItems: 300, availableItems: 450, complete: false, reason: 'collection_limit' });
  assert.ok(sources[0].text.includes('note-299 END'));
});

test('a full task page does not invent an exhaustive count', async () => {
  const reader = createSources({ runtimeServices: { tasks: { personal: { list: async () => ({
    tasks: Array.from({ length: 100 }, (_, n) => ({ title: `task-${n}` }))
  }) } } } });
  const { sources } = await reader.gather({ keys: ['tasks'] });
  assert.deepEqual(sources[0].collection, { collectedItems: 100, availableItems: null, complete: null, reason: 'collection_limit_total_unknown' });
});

test('mail collection reports a stalled timestamp cursor instead of claiming complete coverage', async () => {
  let calls = 0;
  const reader = createSources({ mailJournal: { search: async () => {
    calls++;
    return { entries: Array.from({ length: 50 }, (_, n) => ({ id: `mail-${n}`, summary: `summary-${n}`, occurredAt: '2026-10-01T10:00:00Z' })),
      total: 150, truncated: true };
  } } });
  const { sources } = await reader.gather({ keys: ['mail'] });
  assert.equal(calls, 2);
  assert.deepEqual(sources[0].collection, { collectedItems: 50, availableItems: 150, complete: false, reason: 'pagination_not_advancing' });
});
