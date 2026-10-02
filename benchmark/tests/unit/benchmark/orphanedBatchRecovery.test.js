'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({
    getBenchmarkClaims: jest.fn(),
    releaseBenchmarkClaim: jest.fn(async () => ({ released: true }))
}));
jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    acquireBenchmarkClaims: jest.fn(async hosts => hosts),
    estimateBenchmarkClaimDurationMs: jest.fn(() => 60_000)
}));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getBenchmarkClaims, releaseBenchmarkClaim } = require('../../../src/clients/coreApiClient');
const { acquireBenchmarkClaims } = require('../../../src/services/benchmark/benchmarkClaimLifecycle');
const { recoverLeakedClaims, reacquireActiveBatchClaims } = require('../../../src/services/benchmark/claimRecovery');
const { interruptOrphanedBatches } = require('../../../src/services/benchmark/orphanedBatchRecovery');

const HOST = 'http://127.0.0.1:11434';
let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    jest.clearAllMocks();
    await BenchmarkBatch.deleteMany({});
});

async function runningBatch({ lastWriteAt, lastActivityAt }) {
    const batch = await BenchmarkBatch.create({
        host: HOST,
        models: ['model-a'],
        levels: [1],
        run_name: 'Crash test',
        status: 'running',
        total_tests: 4,
        active_slot: 'benchmark_singleton',
        execution_started_at: lastActivityAt,
        execution_pid: 1,
        last_activity_at: lastActivityAt
    });
    if (lastWriteAt) {
        await BenchmarkBatch.updateOne({ _id: batch._id }, { $set: { updated_at: lastWriteAt } }, { timestamps: false });
    }
    return batch;
}

async function restart(processStartedAt) {
    await interruptOrphanedBatches(processStartedAt);
    await recoverLeakedClaims();
    await reacquireActiveBatchClaims({ processStartedAt });
}

describe('orphaned batch recovery at startup', () => {
    test('a restart within five minutes of a crash interrupts the batch and releases its claim', async () => {
        const processStartedAt = new Date();
        const crashedAt = new Date(processStartedAt.getTime() - 60_000);
        const batch = await runningBatch({ lastWriteAt: crashedAt, lastActivityAt: crashedAt });
        getBenchmarkClaims.mockResolvedValue([{ hostUrl: HOST, batchId: String(batch._id) }]);

        await restart(processStartedAt);

        const refreshed = await BenchmarkBatch.findById(batch._id).lean();
        expect(refreshed.status).toBe('interrupted');
        expect(refreshed.active_slot).toBeNull();
        expect(releaseBenchmarkClaim).toHaveBeenCalledWith(HOST, String(batch._id));
        expect(acquireBenchmarkClaims).not.toHaveBeenCalled();
    });

    test('a batch this process runs is left running and keeps its claim', async () => {
        const processStartedAt = new Date(Date.now() - 1_000);
        const batch = await runningBatch({ lastActivityAt: new Date() });
        getBenchmarkClaims.mockResolvedValue([{ hostUrl: HOST, batchId: String(batch._id) }]);

        await restart(processStartedAt);

        const refreshed = await BenchmarkBatch.findById(batch._id).lean();
        expect(refreshed.status).toBe('running');
        expect(releaseBenchmarkClaim).not.toHaveBeenCalled();
        expect(acquireBenchmarkClaims).toHaveBeenCalledWith([HOST], String(batch._id), 60_000);
    });
});
