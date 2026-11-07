'use strict';

const health = require('../../src/services/ollamaWatchdogHealth');
const host = { id: 'synthetic', url: 'http://synthetic.test:11434', name: 'Synthetic' };
beforeEach(() => { health.stats.history.length = 0; });

test('concurrent operations keep their producer origin and identity across asynchronous completion', async () => {
  let finishManual;
  const manual = health.runObserved('manual', async () => {
    health.recordEvent('force_unjam', host);
    await new Promise(resolve => { finishManual = resolve; });
    health.recordEvent('reload_success', host);
  });
  await health.runCycleObserved(async () => {
    health.recordEvent('jam_detected', host);
    finishManual();
    await manual;
    health.recordEvent('unjam_success', host);
  });
  const [force, jam, reload, unjam] = health.stats.history;
  expect(force).toMatchObject({ origin: 'manual', operationId: expect.any(String) });
  expect(reload).toMatchObject({ origin: 'manual', operationId: force.operationId });
  expect(jam).toMatchObject({ origin: 'autonomous', operationId: expect.any(String) });
  expect(unjam).toMatchObject({ origin: 'autonomous', operationId: jam.operationId });
  expect(jam.operationId).not.toBe(force.operationId);
});

test('a manually requested probe cycle keeps manual origin; unscoped legacy events stay unclassified', async () => {
  await health.runObserved('manual', () => health.runCycleObserved(() => health.recordEvent('jam_detected', host)));
  expect(health.stats.history[0].origin).toBe('manual');
  health.recordEvent('reload_success', host);
  expect(health.stats.history[1]).not.toHaveProperty('origin');
  expect(health.stats.history[1]).not.toHaveProperty('operationId');
});

test('snapshot reads neither append events nor invent execution identity', () => {
  health.recordEvent('legacy', host);
  const before = JSON.stringify(health.stats);
  health.hostSnapshots([host]);
  health.hostSnapshots([host]);
  expect(JSON.stringify(health.stats)).toBe(before);
});
