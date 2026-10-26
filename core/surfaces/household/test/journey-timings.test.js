'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../public/journey-timings');

test('request, processing, tool, opening, document load and rendered frame stay distinct', () => {
  let now = 1000;
  const m = create({ now: () => now });
  m.begin('turn'); now = 1100; m.stream('turn', { type: 'accepted' });
  now = 1300; m.stream('turn', { type: 'status', phase: 'activity', activity: { kind: 'processing' } });
  now = 2000; m.stream('turn', { type: 'status', phase: 'activity', activity: { kind: 'tool', tool: 'read' } });
  now = 2200; m.stream('turn', { type: 'status', phase: 'activity', activity: { kind: 'tool_result', tool: 'read', status: 'completed' } });
  now = 2500; m.open('card', 'diskx'); now = 2700; m.stream('turn', { type: 'done' });
  m.mark('card', 'frameLoadedAt', 3000); m.absorb('card', { firstFrameAt: 3500 });
  const s = m.snapshot();
  assert.equal(s.requests[0].demandMs, 100); assert.equal(s.requests[0].processingObservedMs, 1400);
  assert.equal(s.requests[0].tools[0].observedMs, 200);
  assert.equal(s.presentations[0].requestId, 'turn');
  assert.equal(s.presentations[0].requestToOpeningMs, 1500);
  assert.equal(s.presentations[0].openingToLoadMs, 500); assert.equal(s.presentations[0].loadToFirstFrameMs, 500);
  assert.equal(s.presentations[0].openingToFirstFrameMs, 1000);
  assert.equal(s.presentations[0].requestToFirstFrameMs, 2500);
});

test('a first frame can precede load; missing and cross-turn evidence stay unknown', () => {
  let now = 1;
  const m = create({ now: () => now }); m.begin('a'); now = 2; m.open('a-card', 'ecosystem');
  now = 3; m.begin('b'); m.stream('a', { type: 'done' }); m.open('b-card', 'diskx');
  m.absorb('a-card', { firstFrameAt: 4 }); m.mark('a-card', 'frameLoadedAt', 5);
  const s = m.snapshot();
  assert.equal(s.presentations[0].loadToFirstFrameMs, null);
  assert.equal(s.presentations[1].requestId, 'b'); assert.equal(s.presentations[1].openingToFirstFrameMs, null);
  assert.equal(s.requests[1].processingObservedMs, null);
  m.stream('b', { type: 'done' }); m.open('standalone', 'diskx');
  assert.equal(m.snapshot().presentations.at(-1).requestId, null);
});


test('reconciling the same request identity keeps its original demand clock', () => {
  let now = 1000; const m = create({ now: () => now });
  m.begin('same'); now = 9000; m.begin('same');
  assert.equal(m.snapshot().requests[0].requestedAt, 1000);
});
