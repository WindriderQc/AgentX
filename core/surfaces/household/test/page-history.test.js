'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.AgentXScreenPages = require('../../../public/js/screen-pages');
globalThis.AgentXScreenPages.configure([{ id: 'analytics', label: 'Activity', href: '/analytics', mode: 'frame' }]);
require('../public/page-history');
const { metadata } = globalThis.NestorPageHistory;
const block = Object.freeze({ kind: 'page', body: 'analytics', title: 'Earlier activity' });

test('historical metadata copies only the matching canonical input observation without renewing it', () => {
  const snapshot = { kind: 'page', page: 'analytics', status: 'visible', read: { status: 'available',
    observedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:05:00Z', totals: { calls: 42, avgLatencyMs: null }, units: { calls: 'calls' } } };
  const turn = { createdAt: '2026-01-01T00:01:00Z', clientTurnId: 'earlier', presentationContext: snapshot, display: [block] };
  const before = JSON.stringify(turn);
  const history = metadata(block, turn);
  assert.deepEqual(history.snapshot, snapshot);
  assert.equal(history.recordedAt, '2026-01-01T00:01:00.000Z');
  history.snapshot.read.totals.calls = 999;
  assert.equal(JSON.stringify(turn), before, 'the canonical turn, display and read remain unchanged');
  assert.equal(metadata(block, turn).snapshot.read.expiresAt, '2026-01-01T00:05:00Z', 'reading an old observation never refreshes expiry');
  assert.equal(metadata(block, { ...turn, traceId: 'canonical-trace' }).sourceTurnId, 'canonical-trace', 'complete canonical conversation context identifies a turn by its trace');
});

test('legacy, different pages and different focus never acquire an invented observation', () => {
  assert.equal(metadata(block).snapshot, null);
  assert.equal(metadata(block, null).recordedAt, null);
  assert.equal(metadata(block, { presentationContext: { kind: 'page', page: 'analytics section=trend' } }).snapshot, null);
  assert.equal(metadata(block, { presentationContext: { kind: 'page', page: 'https://arbitrary.test' } }).snapshot, null);
  assert.equal(metadata(block, { presentationContext: { kind: 'image', page: 'analytics' } }).snapshot, null);
});

test('a selected historical card never resolves a live read or forwards its old numbers as current evidence', () => {
  const { presentationEvidence } = require('../screen-context');
  const selected = presentationEvidence([{ contract: 'agentx.presentation/v1', kind: 'page', page: 'analytics', status: 'unavailable',
    observation: 'historical_reference', historical: { recordedAt: '2026-01-01', sourceTurnId: 'earlier' }, read: { totals: { calls: 999 } } }], globalThis.AgentXScreenPages);
  assert.equal(selected.observation, 'historical_reference');
  assert.equal(selected.read, undefined);
  assert.equal(selected.historical.sourceTurnId, 'earlier');
});

