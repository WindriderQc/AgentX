'use strict';

/**
 * Reconciliation invalidates a batch without erasing the diagnosis the batch's
 * own code recorded. The update is a pipeline that only MongoDB evaluates, so
 * these tests run against a real collection.
 */

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { invalidateResource } = require('../../../src/services/benchmark/authorityResourceInvalidation');

const RECONCILED = 'Authority was lost during terminal_reconciliation; durable reconciliation invalidated this projection';
let mongoServer;

async function insertBatch(fields) {
    const _id = new mongoose.Types.ObjectId();
    await BenchmarkBatch.collection.insertOne({ _id, status: 'failed', __v: 0, ...fields });
    return String(_id);
}

// The journal record each kind writes for one batch.
async function recordFor(kind, batchId) {
    const base = { _id: new mongoose.Types.ObjectId(), kind, batchId, workloadId: batchId, phase: 'terminal_reconciliation' };
    if (kind === 'batch_invalidation') return { ...base, resourceType: 'BenchmarkBatch', resultId: batchId };
    if (kind === 'workload_invalidation') return { ...base, resourceType: 'BenchmarkWorkload', resultId: `workload:${batchId}` };
    const resultId = new mongoose.Types.ObjectId();
    await BenchmarkResult.collection.insertOne({ _id: resultId, batch_id: batchId, quality_score: 8, __v: 0 });
    return { ...base, resourceType: 'BenchmarkResult', resultId: String(resultId) };
}

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
}, 60_000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await BenchmarkBatch.collection.deleteMany({});
    await BenchmarkResult.collection.deleteMany({});
});

const KINDS = ['batch_invalidation', 'result_invalidation', 'workload_invalidation'];

describe('a reconciled batch keeps its own diagnosis', () => {
    test.each(KINDS)('%s keeps the reason of a batch its own code invalidated', async kind => {
        const batchId = await insertBatch({ authority_state: 'authority_invalidated', authority_reconciliation_reason: 'execution_crash' });

        await invalidateResource(await recordFor(kind, batchId));

        expect(await BenchmarkBatch.findById(batchId).lean()).toMatchObject({
            authority_state: 'authority_invalidated',
            authority_reconciliation_reason: 'execution_crash',
            __v: 1
        });
    });

    test.each(KINDS)('%s gives its reason to a batch that was only awaiting reconciliation', async kind => {
        const batchId = await insertBatch({
            authority_state: 'pending_reconciliation',
            authority_reconciliation_reason: 'BenchmarkBatch persistence acknowledgement was ambiguous'
        });

        await invalidateResource(await recordFor(kind, batchId));

        expect(await BenchmarkBatch.findById(batchId).lean()).toMatchObject({
            authority_state: 'authority_invalidated',
            authority_reconciliation_reason: RECONCILED,
            __v: 1
        });
    });

    test('an invalidated batch without a reason gets the reconciliation reason', async () => {
        const batchId = await insertBatch({ authority_state: 'authority_invalidated' });

        await invalidateResource(await recordFor('batch_invalidation', batchId));

        expect(await BenchmarkBatch.findById(batchId).lean())
            .toMatchObject({ authority_reconciliation_reason: RECONCILED });
    });

    test('the other fields of each kind are still written', async () => {
        const batchId = await insertBatch({ status: 'running', authority_state: 'authority_invalidated', authority_reconciliation_reason: 'execution_crash' });
        const receipt = await invalidateResource(await recordFor('workload_invalidation', batchId));

        expect(receipt).toMatchObject({ afterVersion: 1, affected: { batch: 1 } });
        expect(await BenchmarkBatch.findById(batchId).lean()).toMatchObject({
            status: 'failed',
            failure_reason: 'workload_authority_reconciled_after_owner_loss',
            completed_at: expect.any(Date)
        });

        const resultRecord = await recordFor('result_invalidation', batchId);
        await invalidateResource(resultRecord);
        expect(await BenchmarkResult.findById(resultRecord.resultId).lean()).toMatchObject({
            excluded_from_leaderboard: true, scoring_method: 'authority_invalidated', quality_score: null
        });
        expect(await BenchmarkBatch.findById(batchId).lean())
            .toMatchObject({ authority_reconciliation_reason: 'execution_crash', __v: 2 });
    });
});
