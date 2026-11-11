'use strict';

jest.mock('../../../src/clients/coreApiClient', () => ({
  acquireWorkloadAdmission: jest.fn().mockResolvedValue({ acquired: true }),
  releaseWorkloadAdmission: jest.fn(),
  transitionWorkloadRecovery: jest.fn().mockResolvedValue({ transitioned: true }),
  heartbeatWorkloadAdmission: jest.fn(),
  heartbeatBenchmarkClaim: jest.fn()
}));
jest.mock('../../../src/services/benchmark/benchmarkAuthorityReconciliation', () => ({
  prepareWorkloadAuthority: jest.fn().mockResolvedValue({ _id: 'synthetic-guard' })
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const core = require('../../../src/clients/coreApiClient');
const { beginManagedWorkload } = require('../../../src/services/benchmark/workloadAdmissionLifecycle');

test('Core cancellation aborts only its native writer and hands uncertain work to recovery', async () => {
  core.heartbeatWorkloadAdmission.mockImplementation(async id => id === 'judge-cancel'
    ? { heartbeat: false, code: 'WORKLOAD_CANCEL_REQUESTED', reason: 'Operator stop' }
    : { heartbeat: true, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // Deliver cancellation on a later heartbeat so the writer has already started.
  core.heartbeatWorkloadAdmission.mockResolvedValueOnce({ heartbeat: true });
  jest.useFakeTimers();
  let target;
  let other;
  try {
    target = await beginManagedWorkload('judge-cancel', { kind: 'judge', hosts: ['http://judge-a:11434'] });
    other = await beginManagedWorkload('judge-untouched', { kind: 'judge', hosts: ['http://judge-b:11434'] });
    const aborted = jest.fn();
    target.signal.addEventListener('abort', aborted, { once: true });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(target.signal.aborted).toBe(true);
    expect(target.signal.reason.code).toBe('WORKLOAD_CANCEL_REQUESTED');
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(other.signal.aborted).toBe(false);
    expect(other.assertActive()).toBe(true);
    await target.retainForRecovery(target.signal.reason);
    expect(core.transitionWorkloadRecovery).toHaveBeenCalledWith('judge-cancel', 'UNKNOWN', expect.any(Object));
    expect(core.releaseWorkloadAdmission).not.toHaveBeenCalled();
    const calls = core.heartbeatWorkloadAdmission.mock.calls.filter(([id]) => id === 'judge-cancel').length;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(core.heartbeatWorkloadAdmission.mock.calls.filter(([id]) => id === 'judge-cancel')).toHaveLength(calls);
    expect(other.signal.aborted).toBe(false);
  } finally {
    await target?.abandon();
    await other?.abandon();
    jest.useRealTimers();
  }
});
