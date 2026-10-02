'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { applyJudgeCohort, cohortFingerprintForBatch, selectComparisonCohort } = require('../../../src/services/benchmark/qualityCohort');

const QWEN = { host: 'http://judge-a:11434', model: 'qwen3.8:27b-mtp-q8_0' };
const GEMMA = { host: 'http://judge-b:11434', model: 'gemma4:12b-it-qat' };
const EXEC = { response_mode: 'final_only', think: false, temperature: 0.2, seed: 42, response_max_tokens: 32000 };

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await BenchmarkPrompt.insertMany([1, 2, 3, 4, 5].map(level => ({
        name: `prompt-${level}`, prompt: `question ${level}`, level, category: 'math', expected_answer: String(level)
    })));
});

afterEach(async () => {
    await Promise.all([BenchmarkPrompt.deleteMany({}), BenchmarkBatch.collection.deleteMany({}), BenchmarkResult.collection.deleteMany({})]);
});

describe('quality cohort', () => {
    test('batches of one campaign at different levels share one cohort', async () => {
        const levelOne = { levels: [1], execution_config: EXEC, campaign_kind: 'model' };
        const levelFive = { levels: [5], execution_config: EXEC, campaign_kind: 'model' };

        expect(await cohortFingerprintForBatch(levelOne, QWEN)).toBe(await cohortFingerprintForBatch(levelFive, QWEN));
    });

    test('another judge, other generation settings or an edited catalog start another cohort', async () => {
        const batch = { execution_config: EXEC, campaign_kind: 'model' };
        const base = await cohortFingerprintForBatch(batch, QWEN);

        expect(await cohortFingerprintForBatch(batch, GEMMA)).not.toBe(base);
        expect(await cohortFingerprintForBatch({ ...batch, execution_config: { ...EXEC, think: true } }, QWEN)).not.toBe(base);
        await BenchmarkPrompt.updateOne({ name: 'prompt-3' }, { $set: { expected_answer: 'changed' } });
        expect(await cohortFingerprintForBatch(batch, QWEN)).not.toBe(base);
    });

    test('the board compares the cohort covering the most models, the most recent on a tie', async () => {
        const row = (cohort, model, day) => ({ quality_cohort_fingerprint: cohort, model, host: 'http://gpu:11434', timestamp: new Date(`2026-09-${day}T00:00:00Z`) });
        await BenchmarkResult.collection.insertMany([
            row('campaign', 'a', 23), row('campaign', 'a', 23), row('campaign', 'b', 23), row('campaign', 'c', 23),
            row('thinking-rerun', 'a', 25), row('thinking-rerun', 'b', 25),
            row('', 'd', 26)
        ]);
        expect(await selectComparisonCohort({})).toBe('campaign');

        await BenchmarkResult.collection.insertOne(row('thinking-rerun', 'c', 25));
        expect(await selectComparisonCohort({})).toBe('thinking-rerun');
        expect(await selectComparisonCohort({ model: 'nobody' })).toBeNull();
    });

    test('a re-judge moves every result of the batch to the judge that ran', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({
            execution_config: EXEC, campaign_kind: 'model', judge_config: GEMMA
        });
        await BenchmarkResult.collection.insertMany([
            { batch_id: batchId, scoring_method: 'decomposed', quality_cohort_fingerprint: 'first-judge' },
            { batch_id: batchId, scoring_method: 'deterministic', quality_cohort_fingerprint: 'first-judge' }
        ]);

        const cohort = await applyJudgeCohort(batchId, QWEN);

        expect(cohort).toBe(await cohortFingerprintForBatch({ execution_config: EXEC, campaign_kind: 'model' }, QWEN));
        const stored = await BenchmarkResult.collection.find({ batch_id: batchId }).toArray();
        expect(stored.map(r => r.quality_cohort_fingerprint)).toEqual([cohort, cohort]);
    });
});
