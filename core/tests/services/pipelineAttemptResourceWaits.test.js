'use strict';

const InferenceLog = require('../../models/InferenceLog');
const { readAttemptResourceWaits } = require('../../src/services/pipelineAttemptResourceWaits');
const { resourceWaitKey } = require('../../src/services/pipelineAttemptPhases');

const NOW = new Date('2026-10-05T12:00:00.000Z');
const FROM = new Date('2026-09-28T12:00:00.000Z');
const call = (fields) => ({ host: 'http://ollama.test:11434', model: 'model-a', caller: 'proxy',
  timestamp: new Date('2026-10-05T10:00:00.000Z'), ...fields });

describe('pipeline attempt resource waits', () => {
  beforeEach(async () => { await InferenceLog.deleteMany({}); });

  test('sums admission, gate, backoff and retried-call waits per attempt', async () => {
    await InferenceLog.insertMany([
      call({ workItemId: '0720', attempt: 1, admissionWaitMs: 5, hostGateWaitMs: 1_200 }),
      call({ workItemId: '0720', attempt: 1, admissionWaitMs: 7, hostGateWaitMs: 0, retry: {
        attempts: 2, delayMs: 2_000, history: [{ attempt: 1, cause: 'workload_reserved', delayMs: 2_000, admissionMs: 3, hostGateMs: 40 }]
      } }),
      call({ workItemId: '0720', attempt: 2, hostGateWaitMs: 90 }),
      call({ workItemId: '0720', attempt: 2, admissionWaitMs: 1, retry: 'legacy text' }),
      call({ workItemId: '0721', attempt: 1, admissionWaitMs: 4,
        timestamp: new Date('2026-09-01T00:00:00.000Z') }),
      call({ workItemId: 'other', attempt: 1, admissionWaitMs: 999 }),
    ]);
    const waits = await readAttemptResourceWaits(
      [{ pipelineId: '0720' }, { pipelineId: '0721' }, { pipelineId: null }], { from: FROM, to: NOW });
    expect(waits.get(resourceWaitKey('0720', 1))).toEqual({ calls: 2, measuredCalls: 2, waitMs: 5 + 1_200 + 7 + 2_000 + 3 + 40 });
    expect(waits.get(resourceWaitKey('0720', 2))).toEqual({ calls: 2, measuredCalls: 1, waitMs: 91 });
    expect(waits.has(resourceWaitKey('0721', 1))).toBe(false);
    expect([...waits.keys()].some((key) => key.startsWith('other'))).toBe(false);
  });

  test('reads nothing without pipeline ids', async () => {
    const model = { aggregate: jest.fn() };
    await expect(readAttemptResourceWaits([], { from: FROM, to: NOW }, { model })).resolves.toEqual(new Map());
    expect(model.aggregate).not.toHaveBeenCalled();
  });
});
