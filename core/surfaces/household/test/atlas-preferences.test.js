'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const prefs = require('../../../src/services/atlasDisplayPreferences');

test('optional private preferences expose only bounded presentation fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-display-'));
  const file = path.join(directory, 'display.json');
  try {
    assert.deepEqual(await prefs.read(''), { storyThreads: [] });
    assert.deepEqual(await prefs.read(file), { storyThreads: [] });
    await fs.writeFile(file, JSON.stringify({ sourceStatement: 'Never returned', storyThreads: [{ id: 'chosen-subject', label: 'Synthetic subject',
      eventIds: ['legacy-event'], queries: [['word']], confirmed: true }, { id: '../unsafe', label: 'Invalid' }, { id: 123, label: 'Invalid numeric ID' }] }));
    const answer = await prefs.read(file);
    assert.equal(answer.storyThreads.length, 1);assert.equal(answer.storyThreads[0].label, 'Synthetic subject');
    assert.equal(answer.sourceStatement, undefined);assert.equal(answer.storyThreads[0].confirmed, undefined);
    await fs.writeFile(file, '{');assert.deepEqual(await prefs.read(file), { storyThreads: [] });
    await fs.writeFile(file, ' '.repeat(32769));assert.deepEqual(await prefs.read(file), { storyThreads: [] });
    assert.deepEqual(await prefs.read(directory), { storyThreads: [] });
  } finally { await fs.rm(directory, { recursive: true }); }
});
