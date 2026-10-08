'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { agentxCrew, openClawPanelStatus, panelCrewReady } = require('../panel-status');

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

test('optional Data down degrades the AgentX tile and names it; a required service down is down', () => {
  const required = ['Core', 'Benchmark', 'RAG'].map(name => ({ id: name.toLowerCase(), name, status: 'ok' }));
  const data = status => ({ id: 'data', name: 'Data', status, optional: true });

  assert.deepEqual(agentxCrew(required), {
    id: 'agentx', name: 'AgentX', role: 'Router · RAG · shared memory authority',
    status: 'ok', detail: '3/3 platform services ready', href: '/agent-ops'
  });
  assert.equal(agentxCrew([...required, data('ok')]).status, 'ok');
  assert.equal(agentxCrew([...required, data('ok')]).detail, '3/3 platform services ready');

  const degraded = agentxCrew([...required, data('down')]);
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.detail, '3/3 platform services ready · optional Data unavailable');
  assert.equal(panelCrewReady([degraded], { status: 'ok' }), false);

  const down = agentxCrew([{ ...required[0], status: 'down' }, required[1], required[2], data('ok')]);
  assert.equal(down.status, 'down');
  assert.equal(down.detail, '2/3 platform services ready');
});
