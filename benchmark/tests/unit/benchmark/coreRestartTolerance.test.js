'use strict';

// #47: a Core restart must not cut a running workload whose admission Core
// confirmed beyond the restart, and must never hide an expired one.
jest.mock('../../../src/clients/coreApiClient', () => ({
    claimHostForBenchmark: jest.fn(),
    heartbeatBenchmarkClaim: jest.fn(),
    releaseBenchmarkClaim: jest.fn(),
    acquireWorkloadAdmission: jest.fn(),
    heartbeatWorkloadAdmission: jest.fn(),
    releaseWorkloadAdmission: jest.fn()
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { OUTBOUND_ERROR_CODES, OutboundHttpError } = require('../../../../shared/outboundHttpExecutor');
const coreApiClient = require('../../../src/clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('../../../src/services/benchmark/benchmarkClaimLifecycle');
const {
    heartbeatThroughCoreOutage,
    isCoreUnavailable,
    withinConfirmedAdmission
} = require('../../../src/services/benchmark/coreRestartTolerance');

const refused = () => new OutboundHttpError(OUTBOUND_ERROR_CODES.REQUEST_FAILED, { sinkId: 'core' });
const inMinutes = minutes => new Date(Date.now() + minutes * 60_000).toISOString();

describe('Core restart tolerance', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        coreApiClient.heartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: true });
    });

    test('only an unanswered Core is an outage; a Core decision never is', () => {
        expect(isCoreUnavailable(refused())).toBe(true);
        expect(isCoreUnavailable(new OutboundHttpError(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED))).toBe(true);
        expect(isCoreUnavailable(Object.assign(new Error('gateway'), { status: 502 }))).toBe(true);
        expect(isCoreUnavailable(Object.assign(new Error('conflict'), { status: 409 }))).toBe(false);
        expect(isCoreUnavailable(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
        expect(isCoreUnavailable(new Error('core unavailable'))).toBe(false);
    });

    test('tolerance ends a margin before the admission Core confirmed', () => {
        expect(withinConfirmedAdmission(inMinutes(5))).toBe(true);
        expect(withinConfirmedAdmission(inMinutes(0.4))).toBe(false);
        expect(withinConfirmedAdmission(null)).toBe(false);
    });

    test('the heartbeat loop keeps a workload through a Core restart and renews it afterwards', async () => {
        const onFatal = jest.fn();
        coreApiClient.heartbeatWorkloadAdmission
            .mockResolvedValueOnce({ heartbeat: true, expiresAt: inMinutes(5) })
            .mockRejectedValueOnce(refused())
            .mockRejectedValueOnce(refused())
            .mockResolvedValue({ heartbeat: true, expiresAt: inMinutes(5) });
        const stop = startBenchmarkClaimHeartbeat(['http://a:11434'], 'profile-1', 300_000, { onFatal, intervalMs: 5 });
        await stop.ready;
        await new Promise(resolve => setTimeout(resolve, 40));
        expect(coreApiClient.heartbeatWorkloadAdmission.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(() => stop.assertActive()).not.toThrow();
        expect(onFatal).not.toHaveBeenCalled();
        stop();
    });

    test('a Core outage is fatal once the confirmed admission no longer covers it', async () => {
        const onFatal = jest.fn();
        coreApiClient.heartbeatWorkloadAdmission
            .mockResolvedValueOnce({ heartbeat: true, expiresAt: inMinutes(0.4) })
            .mockRejectedValue(refused());
        const stop = startBenchmarkClaimHeartbeat([], 'profile-2', 30_000, { onFatal, intervalMs: 5 });
        await stop.ready;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(() => stop.assertActive()).toThrow(expect.objectContaining({ code: 'BENCHMARK_CLAIM_LOST' }));
        expect(onFatal).toHaveBeenCalledTimes(1);
        stop();
    });

    test('a dispatch heartbeat waits for Core to come back, then returns its answer', async () => {
        const heartbeat = jest.fn()
            .mockRejectedValueOnce(refused())
            .mockRejectedValueOnce(refused())
            .mockResolvedValue({ heartbeat: true });
        const onOutage = jest.fn();
        await expect(heartbeatThroughCoreOutage(heartbeat, {
            confirmedExpiresAt: () => inMinutes(5), retryMs: 1, onOutage
        })).resolves.toEqual({ heartbeat: true });
        expect(onOutage).toHaveBeenCalledTimes(2);
    });

    test('a dispatch heartbeat does not wait on a Core refusal or without a confirmed admission', async () => {
        const conflict = Object.assign(new Error('Core API 409'), { status: 409 });
        await expect(heartbeatThroughCoreOutage(jest.fn().mockRejectedValue(conflict), {
            confirmedExpiresAt: () => inMinutes(5), retryMs: 1
        })).rejects.toBe(conflict);
        const outage = refused();
        await expect(heartbeatThroughCoreOutage(jest.fn().mockRejectedValue(outage), {
            confirmedExpiresAt: () => null, retryMs: 1
        })).rejects.toBe(outage);
    });
});
