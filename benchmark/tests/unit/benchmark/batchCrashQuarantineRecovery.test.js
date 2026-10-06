'use strict';

/**
 * A batch whose runtime dies under it must not leave a quarantine nobody can
 * lift. These tests run the real execution, journal, reconciliation and Core
 * client code against a stand-in Core and a real journal collection. A
 * "restart" is what a restart really loses: the in-memory admission proofs.
 */

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createFakeCore } = require('../../helpers/fakeCoreCoordination');

const mockCore = createFakeCore();
const mockBatches = new Map();

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../../src/clients/coreHttp', () => ({
    coreRequest: (...args) => mockCore.coreRequest(...args),
    classifyCoreOperation: jest.fn()
}));
jest.mock('../../../src/clients/buddyEventClient', () => ({ emitBuddyEvent: jest.fn() }));
jest.mock('../../../src/services/qualityScorer', () => ({ JUDGE_CONFIG: { model: 'test-judge' } }));
jest.mock('../../../src/services/benchmark/config', () => ({ normalizeExecutionConfig: jest.fn(config => config || {}) }));
jest.mock('../../../src/services/benchmark/batchOrchestrator', () => ({
    runBatchOrchestrator: jest.fn(),
    abortActiveBatchRequests: jest.fn(() => ({ abortedRequestCount: 0 }))
}));
jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    startBenchmarkClaimHeartbeat: jest.fn(() => ({
        ready: Promise.resolve(),
        drain: jest.fn(async () => {}),
        getFailure: jest.fn(() => null),
        assertActive: jest.fn(() => true)
    }))
}));
jest.mock('../../../models/BenchmarkTimelineEntry', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../../models/BenchmarkBatch', () => {
    const read = id => {
        const doc = mockBatches.get(String(id));
        return doc ? { ...doc } : null;
    };
    const write = (filter, update) => {
        const doc = mockBatches.get(String(filter._id));
        if (!doc || (filter.status?.$in && !filter.status.$in.includes(doc.status))) return null;
        if (filter.authority_state?.$ne && filter.authority_state.$ne === doc.authority_state) return null;
        Object.assign(doc, update.$set || {});
        return { ...doc, save: async () => {} };
    };
    const query = value => ({ select: () => query(value), lean: async () => value, then: (ok, ko) => Promise.resolve(value).then(ok, ko) });
    return {
        findById: jest.fn(id => query(read(id))),
        findOneAndUpdate: jest.fn(async (filter, update) => write(filter, update)),
        updateOne: jest.fn(async (filter, update) => ({ matchedCount: write(filter, update) ? 1 : 0 }))
    };
});

const BenchmarkAuthorityReconciliation = require('../../../models/BenchmarkAuthorityReconciliation');
const { workloadAdmissionById, claimProofByOwner } = require('../../../src/clients/coreProofState');
const { acquireWorkloadAdmission } = require('../../../src/clients/coreApiClient');
const { runBatchOrchestrator } = require('../../../src/services/benchmark/batchOrchestrator');
const { executeBatch } = require('../../../src/services/benchmark/batchExecutionRun');
const { reconcilePendingResultInvalidations } = require('../../../src/services/benchmark/benchmarkAuthorityReconciliation');
const { recoverRecordlessQuarantines } = require('../../../src/services/benchmark/recordlessQuarantineRecovery');

const HOST = 'http://cpu-host.test:11434';
const PROMPTS = [{ _id: 'p1', name: 'Prompt 1', prompt: 'Test?', level: 1, category: 'reasoning' }];

function newBatch(status = 'running') {
    const id = new mongoose.Types.ObjectId().toString();
    mockBatches.set(id, { _id: id, status, execution_pid: null, execution_started_at: null });
    return id;
}

function restartBenchmark() {
    workloadAdmissionById.clear();
    claimProofByOwner.clear();
}

async function until(predicate) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('condition was not reached');
}

/** A workload Core still quarantines while Benchmark has no journal record of it. */
async function recordlessQuarantine(batchStatus) {
    const batchId = newBatch(batchStatus);
    await acquireWorkloadAdmission(batchId, { requestId: `benchmark:${batchId}`, batchId, hosts: [HOST] });
    mockCore.expireOwner(batchId);
    restartBenchmark();
    return batchId;
}

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
    await BenchmarkAuthorityReconciliation.deleteMany({});
    mockBatches.clear();
    mockCore.reset();
    restartBenchmark();
});

describe('a batch that crashes when its runtime dies', () => {
    test('journals its quarantine, and the restarted service lifts it without an operator', async () => {
        const batchId = newBatch();
        // The runtime was killed mid-batch: the in-flight request ends with a
        // socket hang-up and the host claim cannot be released.
        runBatchOrchestrator.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

        await expect(executeBatch(batchId, HOST, ['model-a'], PROMPTS, {})).rejects.toThrow('socket hang up');
        await until(() => mockCore.workload(batchId)?.recoveryState === 'UNKNOWN');

        expect(mockBatches.get(batchId)).toMatchObject({
            status: 'failed', authority_reconciliation_reason: 'execution_crash'
        });
        const core = mockCore.workload(batchId);
        expect(await BenchmarkAuthorityReconciliation.findOne({ workloadId: batchId }).lean()).toMatchObject({
            kind: 'batch_invalidation',
            state: 'pending_reconciliation',
            admissionId: core.admissionId,
            admissionGeneration: core.generation,
            recoveryId: core.recoveryId,
            recoveryRequestId: `recovery:benchmark:${batchId}`
        });

        restartBenchmark();
        // The host still carries the request of unknown outcome: not yet.
        mockCore.blockHostRestore('host has an inference of unknown outcome');
        await expect(reconcilePendingResultInvalidations()).resolves.toMatchObject({ resolved: 0, pending: 1 });
        expect(mockCore.workload(batchId)).not.toBeNull();

        mockCore.blockHostRestore(null);
        await expect(reconcilePendingResultInvalidations()).resolves.toMatchObject({ resolved: 1, pending: 0 });
        expect(mockCore.workloads()).toEqual([]);
        expect(await BenchmarkAuthorityReconciliation.findOne({ workloadId: batchId }).lean())
            .toMatchObject({ state: 'resolved' });
    });
});

describe('a quarantine Core holds with no journal record', () => {
    test('is journaled from Core\'s proof once its batch is terminal, then lifted', async () => {
        const batchId = await recordlessQuarantine('failed');
        const core = mockCore.workload(batchId);

        await expect(recoverRecordlessQuarantines()).resolves.toMatchObject({ journaled: [batchId] });
        expect(await BenchmarkAuthorityReconciliation.findOne({ workloadId: batchId }).lean()).toMatchObject({
            kind: 'batch_invalidation',
            state: 'pending_reconciliation',
            admissionId: core.admissionId,
            recoveryId: core.recoveryId
        });

        await expect(reconcilePendingResultInvalidations()).resolves.toMatchObject({ resolved: 1 });
        expect(mockCore.workloads()).toEqual([]);
    });

    test('is left alone while its batch is not terminal or is unknown here', async () => {
        const running = await recordlessQuarantine('running');
        const unknown = await recordlessQuarantine('failed');
        mockBatches.delete(unknown);

        await expect(recoverRecordlessQuarantines()).resolves.toMatchObject({ journaled: [] });
        expect(await BenchmarkAuthorityReconciliation.countDocuments({})).toBe(0);
        expect(mockCore.workload(running)).not.toBeNull();
    });

    test('is left alone while its owner is still live', async () => {
        const batchId = newBatch('failed');
        await acquireWorkloadAdmission(batchId, { requestId: `benchmark:${batchId}`, batchId, hosts: [HOST] });
        restartBenchmark();

        await expect(recoverRecordlessQuarantines()).resolves.toMatchObject({ journaled: [] });
        expect(await BenchmarkAuthorityReconciliation.countDocuments({})).toBe(0);
    });

    test('is not journaled twice', async () => {
        const batchId = await recordlessQuarantine('stopped');

        await recoverRecordlessQuarantines();
        await expect(recoverRecordlessQuarantines()).resolves.toMatchObject({ journaled: [] });
        expect(await BenchmarkAuthorityReconciliation.countDocuments({ workloadId: batchId })).toBe(1);
    });

    test('re-arms the record an earlier admission of the same batch left resolved', async () => {
        const batchId = await recordlessQuarantine('failed');
        await recoverRecordlessQuarantines();
        await reconcilePendingResultInvalidations();
        expect(mockCore.workloads()).toEqual([]);

        await acquireWorkloadAdmission(batchId, { requestId: `benchmark:${batchId}`, batchId, hosts: [HOST] });
        mockCore.expireOwner(batchId);
        restartBenchmark();
        const second = mockCore.workload(batchId);

        await expect(recoverRecordlessQuarantines()).resolves.toMatchObject({ journaled: [batchId] });
        const rearmed = await BenchmarkAuthorityReconciliation.findOne({ workloadId: batchId }).lean();
        expect(rearmed).toMatchObject({ state: 'pending_reconciliation', admissionId: second.admissionId });
        expect(rearmed.releaseReceipt).toBeUndefined();
        await expect(reconcilePendingResultInvalidations()).resolves.toMatchObject({ resolved: 1 });
        expect(mockCore.workloads()).toEqual([]);
    });
});
