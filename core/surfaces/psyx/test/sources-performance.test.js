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
