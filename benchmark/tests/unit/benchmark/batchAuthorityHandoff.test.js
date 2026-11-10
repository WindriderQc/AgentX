'use strict';

jest.mock('../../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({ transitionWorkloadRecovery: jest.fn() }));
jest.mock('../../../src/services/benchmark/benchmarkAuthorityReconciliation', () => ({
    enqueueAuthorityInvalidation: jest.fn()
}));
const logger = require('../../../config/logger');
const { transitionWorkloadRecovery } = require('../../../src/clients/coreApiClient');
const { enqueueAuthorityInvalidation } = require('../../../src/services/benchmark/benchmarkAuthorityReconciliation');
const { retainAdmissionHeartbeat } = require('../../../src/services/benchmark/batchAuthorityRecovery');
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const context = { workloadId: 'workload-a', phase: 'terminal_reconciliation' };
const moved = () => logger.error.mock.calls.some(([message]) => message.includes('moved to durable'));

beforeEach(() => {
    jest.resetAllMocks();
    enqueueAuthorityInvalidation.mockResolvedValue({ _id: 'journal-a' });
    transitionWorkloadRecovery.mockResolvedValue({ transitioned: true });
});

test('awaits the journal, Core acknowledgement and heartbeat drain before lifecycle completion', async () => {
    const journal = deferred(), transition = deferred(), drain = deferred();
    enqueueAuthorityInvalidation.mockReturnValue(journal.promise);
    transitionWorkloadRecovery.mockReturnValue(transition.promise);
    const heartbeat = { drain: jest.fn(() => drain.promise) };
    let settled = false;
    const pending = retainAdmissionHeartbeat(heartbeat, null, context).then(result => { settled = true; return result; });
    await flush();
    expect(transitionWorkloadRecovery).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(moved()).toBe(false);
    journal.resolve({ _id: 'journal-a' });
    await flush();
    expect(transitionWorkloadRecovery).toHaveBeenCalledWith('workload-a', 'UNKNOWN', expect.any(Object));
    expect(heartbeat.drain).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    transition.resolve({ transitioned: true });
    await flush();
    expect(heartbeat.drain).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    drain.resolve();
    await expect(pending).resolves.toMatchObject({ retained: true, handoffCompleted: true });
    expect(moved()).toBe(true);
});

test('journal failure still hands durable Core quarantine to the recordless restart sweep', async () => {
    enqueueAuthorityInvalidation.mockRejectedValue(new Error('journal unavailable'));
    const heartbeat = { drain: jest.fn(async () => {}) };
    await expect(retainAdmissionHeartbeat(heartbeat, null, context)).resolves.toMatchObject({ retained: true, handoffCompleted: true });
    expect(transitionWorkloadRecovery).toHaveBeenCalledTimes(1);
    expect(heartbeat.drain).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('restart sweep'), expect.any(Object));
});

test.each(['rejected', 'unacknowledged'])('a %s transfer never claims successful handoff or releases the fence', async mode => {
    if (mode === 'rejected') transitionWorkloadRecovery.mockRejectedValue(new Error('Core unavailable'));
    else transitionWorkloadRecovery.mockResolvedValue({ transitioned: false });
    const heartbeat = { drain: jest.fn(async () => {}) };
    await expect(retainAdmissionHeartbeat(heartbeat, null, context)).resolves.toMatchObject({
        retained: true, recoveryRequired: true, handoffCompleted: false
    });
    // Stop the dead owner's renewal so fenced recovery can adopt after expiry.
    expect(heartbeat.drain).toHaveBeenCalledTimes(1);
    expect(moved()).toBe(false);
});

test('drain failure remains diagnostic and does not mask the owning execution error', async () => {
    const heartbeat = { drain: jest.fn(async () => { throw new Error('drain failed'); }) };
    await expect(retainAdmissionHeartbeat(heartbeat, null, context)).resolves.toMatchObject({ retained: true, handoffCompleted: true });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('heartbeat drain failed'), expect.any(Object));
});
