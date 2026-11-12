'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activityView, gpuView, queueView } = require('../public/nestor-frames');

const at = Date.parse('2026-11-11T07:01:49.196Z');

test('model activity fills the quiet minutes with zero and keeps what runs now', () => {
  const view = activityView({ sampledAt: '2026-11-11T07:01:49.196Z',
    requests: { ok: true, data: { active: [{}, {}], heavyWorkInFlight: 1 } },
    recent: { ok: true, data: { windowMinutes: 3, total: 7, perMinute: [{ t: '2026-11-11T06:59:00.000Z', n: 5, failed: 1 }, { t: '2026-11-11T07:01:00.000Z', n: 2, failed: 0 }] } } }, at);
  assert.deepEqual(view, { series: [5, 0, 2], total: 7, failed: 1, minutes: 3, active: 2, heavy: 1 });
  assert.equal(activityView({ requests: { ok: false }, recent: { ok: false } }, at), null, 'a failed read is unavailable, not calm');
  assert.equal(activityView({ requests: { ok: true, data: { active: [] } }, recent: { ok: false } }, at).series, null);
});

test('GPU power is the last sample against its limit and an old sample is marked', () => {
  const rows = gpuView({ power: { ok: true, data: { hosts: {
    'host-a': { gpus: { 0: [{ t: '2026-11-11T07:01:47Z', w: 150, limit: 300 }], 1: [{ t: '2026-11-11T06:40:00Z', w: 30, limit: 300 }] } },
    'host-b': { gpus: { 0: [] } } } } } }, at);
  assert.deepEqual(rows.map(row => [row.label, row.watts, row.share, row.stale]),
    [['host-a · 0', 150, 0.5, false], ['host-a · 1', 30, 0.1, true], ['host-b', null, null, true]]);
  assert.equal(gpuView({ power: { ok: false } }, at), null);
});

test('the heavy-work frame uses the queue summary counts only', () => {
  assert.deepEqual(queueView({ available: true, summary: { counts: { running: 1, dispatching: 1, automatic_queue: 2, action_required: 5, uncertain: 0, finished: 170 } } }),
    { running: 2, waiting: 2, decide: 5, uncertain: 0 });
  assert.equal(queueView({ available: false }), null);
  assert.equal(queueView(null), null);
});

test('Super Dad loads the frames and the shared living screen; Famille gets neither frames nor the alert note', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('/assets/household/nestor-frames.css') && html.includes('/assets/household/nestor-frames.js'));
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  assert.match(page, /const ambient = window\.NestorAmbient\?\.mount\(\{ space \}\)/, 'both spaces get the living screen');
  assert.match(page, /const frames = family \? null : window\.NestorFrames\?\.mount/);
  // Per-surface receipt forwarding is exercised by the real composer/canvas
  // journey in core/tests/browser/nestorArtxConversationJourney.cjs.
  const { mount } = require('../public/nestor-frames');
  assert.equal(mount({ space: 'family', documentRef: { body: {} } }), null);
  require('../public/nestor-ambient');
  const { chipsForSpace } = globalThis.NestorAmbient;
  const chips = [{ id: 'alert', tone: 'critical', text: 'Système : un problème important' }, { id: 'iss', tone: 'sky', text: 'ISS' }];
  assert.deepEqual(chipsForSpace(chips, 'family').map(chip => chip.id), ['iss']);
  assert.deepEqual(chipsForSpace(chips, 'personal').map(chip => chip.id), ['alert', 'iss']);
});
