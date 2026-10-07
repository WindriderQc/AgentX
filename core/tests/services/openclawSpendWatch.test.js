'use strict';

const { createOpenClawSpendWatch } = require('../../src/services/execution/openclawSpendWatch');

function fixture({ nanodollars, lastStep = null, stored = true }) {
  const spend = { nanodollars, paidCalls: 12, unknownCostCalls: 1, since: '2026-10-07T00:00:00.000Z' };
  const events = [];
  const watch = createOpenClawSpendWatch({
    client: { catalog: async () => ({ spend: spend.nanodollars == null ? null : spend }) },
    alertService: { evaluateEvent: async event => { events.push(event); return stored ? [{ id: 'alert' }] : []; } },
    Alert: { findOne: () => ({ sort: () => ({ lean: async () => (lastStep == null ? null : { context: { additionalData: { step: lastStep } } }) }) }) },
    logger: { warn() {} }
  });
  return { watch, events, spend };
}

describe('OpenClaw paid spend watch', () => {
  it('stays silent below the first 10 USD and without a native total', async () => {
    const below = fixture({ nanodollars: 9_999_999_999 });
    await below.watch.check();
    const absent = fixture({ nanodollars: null });
    await absent.watch.check();
    expect([below.events.length, absent.events.length]).toEqual([0, 0]);
  });

  it('announces each newly crossed 10 USD step once', async () => {
    const { watch, events, spend } = fixture({ nanodollars: 10_000_000_000 });
    await watch.check();
    await watch.check();
    spend.nanodollars = 31_500_000_000;
    await watch.check();
    expect(events.map(event => event.additionalData.stepUsd)).toEqual([10, 30]);
    expect(events[1]).toMatchObject({ metric: 'openclaw_paid_spend_step',
      additionalData: { incidentKey: 'step-3', totalUsd: '31.50', paidCalls: 12, unknownCostCalls: 1 } });
  });

  it('does not repeat a step announced before a Core restart and retries a step that was not stored', async () => {
    const restarted = fixture({ nanodollars: 25_000_000_000, lastStep: 2 });
    await restarted.watch.check();
    expect(restarted.events).toHaveLength(0);
    const unstored = fixture({ nanodollars: 25_000_000_000, stored: false });
    await unstored.watch.check();
    await unstored.watch.check();
    expect(unstored.events).toHaveLength(2);
  });
});
