'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  CLUSTER_SOURCE,
  loadJobsFromAgentX,
  loadJobsFromFile,
  parseCronSchedule,
  projectDelivery,
  resolveModel,
  tombstoneMissingEntries,
  toEntry,
} = require('../sync-openclaw-schedule');

test('refuses redirects to another origin', async () => {
  let receiverRequests = 0;
  const receiver = http.createServer((request, response) => {
    receiverRequests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jobs: [] }));
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = receiver.address().port;
  const redirector = http.createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${receiverPort}/capture` });
    response.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const sourceUrl = `http://127.0.0.1:${redirector.address().port}/jobs`;
  try {
    await assert.rejects(
      loadJobsFromAgentX(sourceUrl),
      /fetch failed/,
    );
  } finally {
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => receiver.close(resolve));
  }
  assert.equal(receiverRequests, 0);
});

test('loads both wrapped and array OpenClaw job files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-openclaw-jobs-'));
  try {
    const wrapped = path.join(root, 'wrapped.json');
    const array = path.join(root, 'array.json');
    fs.writeFileSync(wrapped, JSON.stringify({ jobs: [{ id: 'one' }] }));
    fs.writeFileSync(array, JSON.stringify([{ id: 'two' }]));
    assert.equal(loadJobsFromFile(wrapped)[0].id, 'one');
    assert.equal(loadJobsFromFile(array)[0].id, 'two');
  } finally {
    for (const name of ['wrapped.json', 'array.json']) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(root);
  }
});

test('normalizes cron and interval schedules', () => {
  assert.deepEqual(parseCronSchedule({ schedule: { kind: 'cron', expr: '0 8 * * 1-5' } }), {
    type: 'cron', cron: '0 8 * * 1-5', timezone: 'UTC',
  });
  assert.deepEqual(parseCronSchedule({ schedule: { kind: 'every', everyMs: 900000, tz: 'UTC' } }), {
    type: 'interval', intervalMs: 900000, timezone: 'UTC',
  });
});

test('preserves explicitly configured job timezones', () => {
  assert.equal(parseCronSchedule({ schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'Europe/Paris' } }).timezone, 'Europe/Paris');
});

test('preserves only explicit model routing', () => {
  assert.deepEqual(resolveModel(' custom/model ', ' primary '), {
    model: 'custom/model', host: 'primary',
  });
  assert.deepEqual(resolveModel('fast'), { model: 'fast', host: null });
  assert.deepEqual(resolveModel(), { model: null, host: null });
});

test('uses the Product-compatible generic system source and bounds delivery metadata', () => {
  assert.equal(CLUSTER_SOURCE, 'agentx-system');
  assert.deepEqual(projectDelivery({
    mode: 'announce',
    channel: 'telegram',
    to: '-1000000000000',
    threadId: 3,
  }), {
    mode: 'announce',
    channel: 'telegram',
    hasTarget: true,
    hasThread: true,
  });
  assert.equal(projectDelivery(null), null);
});

test('converts one official job without copying prompt content', () => {
  const entry = toEntry({
    id: 'weekly-review',
    agentId: 'leadx',
    schedule: { kind: 'cron', expr: '0 9 * * 1' },
    payload: { model: 'qwen3.8:27b-mtp-q8_0', host: 'primary', message: 'private prompt text' },
    delivery: { mode: 'announce', channel: 'telegram', to: '-1000000000000', threadId: 3 },
    state: { lastStatus: 'ok', nextRunAtMs: 123 },
  });
  assert.equal(entry.sourceId, 'oc-weekly-review');
  assert.equal(entry.source, 'agentx-system');
  assert.equal(entry.taskType, 'diagnostics');
  assert.equal(entry.metadata.originalJobId, 'weekly-review');
  assert.equal(entry.model, 'qwen3.8:27b-mtp-q8_0');
  assert.equal(entry.host, 'primary');
  assert.equal(entry.metadata.scheduler, 'openclaw');
  assert.deepEqual(entry.metadata.delivery, {
    mode: 'announce', channel: 'telegram', hasTarget: true, hasThread: true,
  });
  assert.equal(JSON.stringify(entry).includes('private prompt text'), false);
  assert.equal(JSON.stringify(entry).includes('-1000000000000'), false);
});

test('reads flattened state from the bounded AgentX cron projection', () => {
  const entry = toEntry({
    id: 'watchdog-id',
    name: 'gmail-secretary-health-watchdog',
    agentId: 'main',
    enabled: true,
    schedule: { kind: 'every', everyMs: 900000 },
    lastStatus: 'ok',
    lastRunAtMs: 1787884342861,
    lastDurationMs: 3227,
    nextRunAtMs: 1787885242861,
    consecutiveErrors: 0,
  });
  assert.equal(entry.lastRun.getTime(), 1787884342861);
  assert.equal(entry.estimatedDurationMs, 3227);
  assert.equal(entry.metadata.lastStatus, 'ok');
  assert.equal(entry.metadata.nextRunAtMs, 1787885242861);
});

test('disables mirror rows that disappeared from the official OpenClaw inventory', () => {
  const existing = [{
    source: 'agentx-system',
    sourceId: 'oc-memory-maintenance',
    name: 'Memory Maintenance',
    taskType: 'maintenance',
    schedule: { type: 'cron', cron: '0 22 * * 0,3', timezone: 'America/Toronto' },
    enabled: true,
    metadata: { originalJobId: 'memory-maintenance' },
  }];
  const tombstones = tombstoneMissingEntries(existing, []);
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].source, 'agentx-system');
  assert.equal(tombstones[0].enabled, false);
  assert.equal(tombstones[0].metadata.mirrorState, 'absent-from-openclaw');
});
