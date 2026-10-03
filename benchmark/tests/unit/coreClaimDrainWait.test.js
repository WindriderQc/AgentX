'use strict';

const { requestReleaseWithDrain } = require('../../src/clients/coreClaimDrainWait');
const expected = { hostUrl: 'http://host:11434', batchId: 'batch-a', claimGeneration: 'claim-a',
  admissionId: 'admission-a', admissionGeneration: 'generation-a' };
const pending = { ...expected, released: false, callerAbortRecoveryPending: true,
  contract: 'agentx.benchmark-caller-abort-drain/v1', retryAfterMs: 5_000 };

test('waits for an exact pending drain and returns the native release decision', async () => {
  let clock = 0;
  const released = { released: true, releaseReceipt: { verified: true } };
  const request = jest.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValueOnce(released);
  await expect(requestReleaseWithDrain(request, expected, {
    now: () => clock, sleep: async ms => { clock += ms; }
  })).resolves.toBe(released);
  expect(clock).toBe(10_000);
  expect(request).toHaveBeenCalledTimes(3);
});

test.each(['hostUrl', 'batchId', 'claimGeneration', 'admissionId', 'admissionGeneration', 'contract'])
('refuses a divergent %s without polling or forgetting ownership', async key => {
  const request = jest.fn().mockResolvedValue({ ...pending, [key]: 'foreign' });
  const sleep = jest.fn();
  await expect(requestReleaseWithDrain(request, expected, { sleep }))
    .rejects.toMatchObject({ code: 'BENCHMARK_DRAIN_RECEIPT_INVALID', retainAdmission: true });
  expect(request).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
});

test.each([0, -1, '5000', 50_000, null])('rejects invalid retry interval %s', async retryAfterMs => {
  await expect(requestReleaseWithDrain(async () => ({ ...pending, retryAfterMs }), expected))
    .rejects.toMatchObject({ code: 'BENCHMARK_DRAIN_RECEIPT_INVALID', retainAdmission: true });
});

test('a bounded drain timeout retains the admission instead of retrying forever', async () => {
  let clock = 0;
  const request = jest.fn().mockResolvedValue(pending);
  await expect(requestReleaseWithDrain(request, expected, {
    now: () => clock, sleep: async ms => { clock += ms; }, maxWaitMs: 8_000
  })).rejects.toMatchObject({ code: 'BENCHMARK_DRAIN_TIMEOUT', retainAdmission: true });
  expect(clock).toBe(8_000); expect(request).toHaveBeenCalledTimes(2);
});

test('an ordinary refusal and transport failure remain explicit decisions, without blind retries', async () => {
  const refusal = { released: false, reason: 'unproven runtime outcome' };
  const request = jest.fn().mockResolvedValue(refusal);
  await expect(requestReleaseWithDrain(request, expected)).resolves.toBe(refusal);
  expect(request).toHaveBeenCalledTimes(1);
  const error = new Error('Connection lost');
  await expect(requestReleaseWithDrain(async () => { throw error; }, expected)).rejects.toBe(error);
});
