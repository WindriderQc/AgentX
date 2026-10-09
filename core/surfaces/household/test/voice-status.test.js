'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVoiceStatus, voiceLine } = require('../voice-status');

const catalog = (voxcpm, kokoro = true) => ({ providers: [
  { id: 'kokoro', available: kokoro, reason: '' },
  { id: 'voxcpm', available: voxcpm, reason: voxcpm ? '' : 'VoxCPM2 worker is unavailable' }
] });

test('the engines keep the time they last changed state', async () => {
  let clock = Date.parse('2026-10-03T03:00:00Z'), reply = catalog(true);
  const status = createVoiceStatus({ readCatalog: async () => reply, now: () => clock });
  const first = await status();
  assert.deepEqual(first.voxcpm, { configured: true, ready: true, reason: '', since: '2026-10-03T03:00:00.000Z' });
  clock += 60_000;
  assert.equal((await status()).voxcpm.since, '2026-10-03T03:00:00.000Z');
  reply = catalog(false); clock += 60_000;
  const down = await status();
  assert.deepEqual(down.voxcpm, { configured: true, ready: false, reason: 'VoxCPM2 worker is unavailable', since: '2026-10-03T03:02:00.000Z' });
  assert.equal(down.kokoro.since, '2026-10-03T03:00:00.000Z');
  assert.equal(voiceLine(down, () => '23:02'), 'Voix de Nestor (Gazz) indisponible depuis 23:02 · voix de secours Kokoro');
  assert.equal(voiceLine(first), '');
});

test('an unreachable VoiX leaves the engines unknown rather than down', async () => {
  const status = createVoiceStatus({ readCatalog: async () => { throw new Error('VoiX is unreachable'); } });
  const engines = await status();
  assert.deepEqual({ ready: engines.voxcpm.ready, configured: engines.voxcpm.configured, reason: engines.voxcpm.reason },
    { ready: null, configured: null, reason: 'VoiX is unreachable' });
  assert.equal(voiceLine(engines), '');
  assert.equal(voiceLine({ voxcpm: { configured: false, ready: false } }), '');
});
