'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { project } = require('../public/nestor-progress');
const row = extra => ({ id: 'one', browserStartedAt: 1000, live: true, ...extra });

test('short work is quiet, long work is timed and only supplied estimates appear', () => {
  assert.deepEqual(project({ turns: [row()] }, 5999), []);
  const [running] = project({ turns: [row({ currentActivity: { kind: 'tool', tool: 'read' } })] }, 6100);
  assert.equal(running.state, 'tool'); assert.equal(running.elapsedMs, 5100);
  assert.equal(Object.hasOwn(running, 'remainingMs'), false);
  const [work] = project({ turns: [{ works: [{ id: 'work', state: 'running', receivedAt: new Date(1000).toISOString(), remainingMs: 2500 }] }] }, 7000);
  assert.equal(work.remainingMs, 2500);
});

test('completion and error freeze elapsed; interruption, stale telemetry and tool completion are explicit', () => {
  const complete = row({ done: true, live: false, browserEndedAt: 8000 });
  assert.equal(project({ turns: [complete] }, 20000)[0].elapsedMs, 7000);
  assert.equal(project({ turns: [complete] }, 20000)[0].state, 'completed');
  assert.equal(project({ turns: [row({ error: true, browserEndedAt: 1001 })] }, 20000)[0].state, 'failed');
  assert.equal(project({ turns: [row({ interrupted: true, browserEndedAt: 8000 })] }, 20000)[0].state, 'interrupted');
  assert.equal(project({ turns: [row()], stale: true }, 7000)[0].stale, true);
  assert.equal(project({ turns: [row({ currentActivity: { kind: 'tool_result', status: 'completed' } })] }, 7000)[0].state, 'running');
});

test('a deferred request follows its durable owner without a duplicate waiting badge', () => {
  const work = { id: 'work', state: 'queued', receivedAt: new Date(1000).toISOString() };
  const items = project({ turns: [row({ deferred: true, works: [work] })] }, 9000);
  assert.deepEqual(items.map(item => item.id), ['work']);
});
