'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockJudgeResult = jest.fn();
jest.mock('../../../src/services/benchmark/judgeExecutor', () => ({
    judgeResult: (...args) => mockJudgeResult(...args),
    applyScoresToResult: jest.fn()
}));
const mockPrepare = jest.fn(async config => ({ ...config, num_ctx: 65536 }));
jest.mock('../../../src/services/benchmark/standaloneJudgePreparation', () => ({
    prepareStandaloneJudge: (...args) => mockPrepare(...args),
    judgeDrainBudgetMs: () => 50
}));
jest.mock('../../../src/services/benchmark/qualityCohort', () => ({
    applyJudgeCohort: jest.fn(async () => null), cohortFingerprintForBatch: jest.fn(async () => 'prepared-runtime-cohort')
}));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { judgeBatch } = require('../../../src/services/benchmark/judging');

let mongoServer;
beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('standalone judge run over its budget (#59)', () => {
    test('stops starting calls, lets the running one finish, and leaves unjudged results pending', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({ status: 'completed', judge_status: 'completed' });
        await BenchmarkResult.collection.insertMany([1, 2, 3, 4].map(n => ({
            batch_id: batchId, success: true, response: `answer ${n}`, scoring_method: 'pending', quality_score: null, prompt_name: `p${n}`
        })));
        const started = [];
        mockJudgeResult.mockImplementation(async (resultId, config) => {
            started.push({ resultId, numCtx: config.num_ctx, cohort: config.quality_cohort_fingerprint });
            await new Promise(resolve => setTimeout(resolve, 300));
        });

        const outcome = await judgeBatch(String(batchId), { judgeConfig: { host: 'http://judge:11434', model: 'judge' }, concurrency: 1 });

        expect(outcome.timedOut).toBe(true);
        // The call running at the deadline finished before judgeBatch returned; no other call started.
        expect(started).toHaveLength(1);
        await new Promise(resolve => setTimeout(resolve, 400));
        expect(started).toHaveLength(1);
        // Every call used the prepared judge config (contract num_ctx).
        expect(mockPrepare).toHaveBeenCalledTimes(1);
        expect(started[0].numCtx).toBe(65536);
        expect(started[0].cohort).toBe('prepared-runtime-cohort');

        const rows = await BenchmarkResult.collection.find({ batch_id: batchId }).toArray();
        expect(rows.filter(row => row.scoring_method === 'llm_failed')).toHaveLength(0);
        expect(rows.filter(row => row.scoring_method === 'pending')).toHaveLength(4);
        const batch = await BenchmarkBatch.collection.findOne({ _id: batchId });
        expect(batch.judge_status).toBe('failed');
        expect(batch.judge_failed || 0).toBe(0);
    });

    test('runtime drift clears an old grade without assigning the new runtime cohort', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({ status: 'completed', judge_status: 'completed' });
        const { insertedId: resultId } = await BenchmarkResult.collection.insertOne({ batch_id: batchId,
            success: true, response: 'answer', scoring_method: 'decomposed', quality_score: 9,
            composite_score: 8, quality_cohort_fingerprint: 'old-runtime', prompt_fingerprint: 'p' });
        mockJudgeResult.mockReset();
        mockJudgeResult.mockRejectedValue(Object.assign(new Error('judge runtime changed'), { code: 'JUDGE_EXECUTION_CONTRACT_MISMATCH' }));
        const outcome = await judgeBatch(String(batchId), { force: true, judgeConfig: { host: 'http://judge:11434', model: 'judge' } });
        expect(outcome.failed).toBe(1);
        const result = await BenchmarkResult.collection.findOne({ _id: resultId });
        expect(result).toMatchObject({ scoring_method: 'llm_failed', quality_score: null, composite_score: null,
            needs_review: true, quality_cohort_fingerprint: 'old-runtime' });
    });

    test('a run that loses its admission stops, records no judge failures and leaves no call running', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({ status: 'completed', judge_status: 'completed' });
        await BenchmarkResult.collection.insertMany([1, 2, 3].map(n => ({
            batch_id: batchId, success: true, response: `answer ${n}`, scoring_method: 'pending', quality_score: null
        })));
        const controller = new AbortController();
        Object.defineProperty(controller.signal, 'workloadId', { value: `judge-batch:${batchId}` });
        let running = 0;
        mockJudgeResult.mockReset();
        mockJudgeResult.mockImplementation(async () => {
            running += 1;
            // The admission heartbeat fails while the first call runs.
            setTimeout(() => controller.abort(Object.assign(new Error('workload admission lost'), { code: 'BENCHMARK_CLAIM_LOST' })), 10);
            await new Promise(resolve => setTimeout(resolve, 100));
            running -= 1;
        });
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);

        await expect(judgeBatch(String(batchId), { judgeConfig: { host: 'http://judge:11434', model: 'judge', cancelSignal: controller.signal }, concurrency: 1 }))
            .rejects.toThrow('workload admission lost');
        expect(running).toBe(0);
        await new Promise(resolve => setTimeout(resolve, 50));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
        expect(mockJudgeResult).toHaveBeenCalledTimes(1);
        const rows = await BenchmarkResult.collection.find({ batch_id: batchId }).toArray();
        expect(rows.filter(row => row.scoring_method === 'llm_failed')).toHaveLength(0);
    });

    test('a failed judge warmup stops the run before any judge call', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({ status: 'completed', judge_status: 'completed' });
        await BenchmarkResult.collection.insertOne({ batch_id: batchId, success: true, response: 'answer', scoring_method: 'pending', quality_score: null });
        mockJudgeResult.mockClear();
        mockPrepare.mockRejectedValueOnce(new Error('Warmup failed: cold load timed out'));

        await expect(judgeBatch(String(batchId), { judgeConfig: { host: 'http://judge:11434', model: 'judge' } }))
            .rejects.toThrow('cold load timed out');
        expect(mockJudgeResult).not.toHaveBeenCalled();
        const row = await BenchmarkResult.collection.findOne({ batch_id: batchId });
        expect(row.scoring_method).toBe('pending');
    });
});
