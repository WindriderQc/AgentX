'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openClawPanelStatus, panelCrewReady } = require('../panel-status');

test('a slow OpenClaw inventory cannot hold the Household panel response', async () => {
  let settle;
  const evidence = {
    contractVersion: 1,
    getOpenClawStatusProjection: () => new Promise(resolve => { settle = resolve; })
  };
  const startedAt = Date.now();
  const crew = await openClawPanelStatus(evidence, 15);
  assert.equal(crew.status, 'unknown');
  assert.match(crew.error, /timed out/);
  assert.ok(Date.now() - startedAt < 500);
  settle({ status: 'online', gateway: { reachable: true }, agents: 12 });
});

test('missing evidence is unknown; an observed offline gateway is down', async () => {
  const missing = await openClawPanelStatus(null);
  assert.equal(missing.status, 'unknown');
  assert.match(missing.error, /AgentX runtime evidence/);
  assert.equal(panelCrewReady([{ id: 'openclaw', status: 'unknown' }, { id: 'agentx', status: 'ok' }], { status: 'ok' }), true);

  const offline = await openClawPanelStatus({
    contractVersion: 1,
    getOpenClawStatusProjection: async () => ({ status: 'offline', gateway: { reachable: false } })
  });
  assert.equal(offline.status, 'down');
  assert.equal(panelCrewReady([offline, { id: 'agentx', status: 'ok' }], { status: 'ok' }), false);
});

test('invalid or failed evidence is unknown, not a verified outage', async () => {
  for (const getOpenClawStatusProjection of [
    async () => ({}),
    async () => { throw new Error('collector unavailable'); }
  ]) {
    const crew = await openClawPanelStatus({ contractVersion: 1, getOpenClawStatusProjection });
    assert.equal(crew.status, 'unknown');
    assert.ok(crew.error);
  }
});
