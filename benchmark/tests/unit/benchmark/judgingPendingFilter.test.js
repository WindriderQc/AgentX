'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { preflightJudgeBatch } = require('../../../src/services/benchmark/judging');

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
    await Promise.all([BenchmarkBatch.collection.deleteMany({}), BenchmarkResult.collection.deleteMany({})]);
});

describe('pending judge results', () => {
    test('include a judged result the judge could not evaluate', async () => {
        const { insertedId: batchId } = await BenchmarkBatch.collection.insertOne({ status: 'completed', judge_status: 'completed' });
        const row = (scoring_method, quality_score) => ({ batch_id: batchId, success: true, response: 'answer', scoring_method, quality_score });
        await BenchmarkResult.collection.insertMany([
            row('pending', null),
            row('llm_failed', null),
            row('decomposed', null),
            row('reference', null),
            row('decomposed', 8),
            row('reference', 6),
            row('deterministic', 10),
            row('empty_response', 0)
        ]);

        expect((await preflightJudgeBatch(String(batchId))).pendingCount).toBe(4);
        expect((await preflightJudgeBatch(String(batchId), { force: true })).pendingCount).toBe(8);
    });
});
