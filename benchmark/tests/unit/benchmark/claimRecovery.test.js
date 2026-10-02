'use strict';

const mockGetBenchmarkClaims = jest.fn();
const mockReleaseBenchmarkClaim = jest.fn();
const mockAcquireBenchmarkClaims = jest.fn();

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
    getBenchmarkClaims: mockGetBenchmarkClaims,
    releaseBenchmarkClaim: mockReleaseBenchmarkClaim
}));
jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    acquireBenchmarkClaims: mockAcquireBenchmarkClaims,
    estimateBenchmarkClaimDurationMs: jest.fn(() => 60_000)
}));
jest.mock('../../../src/services/benchmark/judgeHostResolution', () => ({
    resolveJudgeHost: jest.fn(() => ({ judgeHost: null }))
}));
jest.mock('../../../src/services/benchmark/batchHelpers', () => ({
    groupModelsByHost: jest.fn(() => ({}))
}));

const logger = require('../../../config/logger');

const mockBenchmarkBatch = {
    find: jest.fn(),
    findById: jest.fn(),
    updateOne: jest.fn()
};
jest.mock('../../../models/BenchmarkBatch', () => mockBenchmarkBatch);

const {
    recoverLeakedClaims,
    reacquireActiveBatchClaims
} = require('../../../src/services/benchmark/claimRecovery');

function queryResult(value) {
    return {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(value)
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockBenchmarkBatch.find.mockReturnValue(queryResult([]));
    mockBenchmarkBatch.findById.mockReturnValue(queryResult(null));
    mockBenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 1 });
    mockGetBenchmarkClaims.mockResolvedValue([]);
    mockReleaseBenchmarkClaim.mockResolvedValue({ released: true });
    mockAcquireBenchmarkClaims.mockResolvedValue([]);
});

test('releases a claim after its batch was interrupted', async () => {
    const batchId = '507f1f77bcf86cd799439012';
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl: 'http://host.internal:11434' }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult({
        _id: batchId,
        status: 'interrupted'
    }));

    const outcome = await recoverLeakedClaims();

    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith('http://host.internal:11434', batchId);
    expect(outcome.released).toBe(1);
    expect(outcome.failed).toBe(0);
});

test('reports a refused startup release as failed rather than released', async () => {
    const batchId = '507f1f77bcf86cd799439099';
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl: 'http://host.internal:11434' }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult({
        _id: batchId,
        status: 'interrupted'
    }));
    mockReleaseBenchmarkClaim.mockResolvedValue({ released: false, reason: 'claim generation changed' });

    const outcome = await recoverLeakedClaims();

    expect(outcome).toMatchObject({ released: 0, failed: 1 });
    expect(outcome.details).toEqual([expect.objectContaining({
        batchId,
        reason: 'batch-interrupted',
        releaseReason: 'claim generation changed'
    })]);
    expect(logger.info).not.toHaveBeenCalledWith(
        '[ClaimRecovery] All claims reconciled, none required release',
        expect.any(Object)
    );
    expect(logger.warn).toHaveBeenCalledWith(
        '[ClaimRecovery] Some leaked claims remain active after startup reconciliation',
        expect.objectContaining({ count: 1 })
    );
});

test('releases an orphaned in-memory profiler claim without casting it as a batch id', async () => {
    const claim = {
        batchId: 'profile-e726031ada693290',
        hostUrl: 'http://profile-host.internal:11434'
    };
    mockGetBenchmarkClaims.mockResolvedValue([claim]);

    const outcome = await recoverLeakedClaims();

    expect(mockBenchmarkBatch.findById).not.toHaveBeenCalled();
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(claim.hostUrl, claim.batchId);
    expect(outcome).toMatchObject({ released: 1, failed: 0 });
    expect(outcome.details).toEqual([expect.objectContaining({
        batchId: claim.batchId,
        reason: 'orphaned-profiler-runtime'
    })]);
});

test('leaves an external non-batch claim untouched during Benchmark startup', async () => {
    const claim = {
        batchId: 'repo-coding-final-20260902',
        hostUrl: 'http://profile-host.internal:11434'
    };
    mockGetBenchmarkClaims.mockResolvedValue([claim]);

    const outcome = await recoverLeakedClaims();

    expect(mockBenchmarkBatch.findById).not.toHaveBeenCalled();
    expect(mockReleaseBenchmarkClaim).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ released: 0, failed: 0 });
});

test('stops a ghost batch with a stale heartbeat and releases its claim', async () => {
    const batchId = '507f1f77bcf86cd799439013';
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl: 'http://host.internal:11434' }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult({
        _id: batchId,
        status: 'running',
        last_activity_at: new Date(Date.now() - 60 * 60 * 1000)
    }));

    const outcome = await recoverLeakedClaims();

    expect(mockBenchmarkBatch.updateOne).toHaveBeenCalledWith(
        { _id: batchId, status: { $in: ['running', 'judging'] } },
        { $set: { status: 'stopped', completed_at: expect.any(Date) } }
    );
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith('http://host.internal:11434', batchId);
    expect(outcome).toMatchObject({ released: 1, failed: 0 });
});

test('does not re-claim a ghost batch with a stale heartbeat', async () => {
    mockBenchmarkBatch.find.mockReturnValue(queryResult([{
        _id: '507f1f77bcf86cd799439014',
        status: 'running',
        last_activity_at: new Date(Date.now() - 60 * 60 * 1000),
        host: 'http://host.internal:11434',
        models: ['candidate-model']
    }]));

    const outcome = await reacquireActiveBatchClaims();

    expect(outcome).toEqual({ checked: 1, reacquired: 0 });
    expect(mockAcquireBenchmarkClaims).not.toHaveBeenCalled();
});
