'use strict';

jest.mock('../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(), JUDGE_CONFIG: {}, ENHANCED_SCORING_CONFIGS: {}
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoOptions = require('../../../shared/testing/mongoOptions');
const BenchmarkResult = require('../../models/BenchmarkResult');
const { runBiasDetection, runCalibrationAnalysis } = require('../../src/services/judgeValidationAnalysis');
const { runConsistencyTest } = require('../../src/services/judgeValidation');
const { scoreResponse } = require('../../src/services/qualityScorer');

jest.setTimeout(30000);
let mongo;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), mongoOptions);
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});
beforeEach(async () => { jest.clearAllMocks(); await BenchmarkResult.deleteMany({}); });

test('current judge methods contribute to diagnostics; deterministic passes and excluded rows do not', async () => {
    const batch = new mongoose.Types.ObjectId();
    const base = { batch_id: batch, model: 'candidate', judge_model: 'judge', judge_host: 'http://judge:11434',
        scorer_version: '2.12.0', success: true, quality_score: 5, response: 'Answer',
        prompt_category: 'math', prompt_level: 1, timestamp: new Date() };
    const rows = ['llm_judge', 'decomposed', 'reference', 'reference_quick', 'hybrid']
        .flatMap(scoring_method => Array.from({ length: 12 }, () => ({ ...base, scoring_method })));
    rows.push(...Array.from({ length: 60 }, () => ({ ...base, scoring_method: 'deterministic', quality_score: 10 })),
        ...Array.from({ length: 60 }, () => ({ ...base, scoring_method: 'decomposed', excluded_from_leaderboard: true })),
        ...Array.from({ length: 60 }, () => ({ ...base, scoring_method: 'decomposed', judge_model: 'other-judge' })));
    await BenchmarkResult.collection.insertMany(rows);
    const scope = { judgeModel: 'judge', judgeHost: base.judge_host, scorerVersion: '2.12.0', batchId: String(batch) };
    const bias = await runBiasDetection({ ...scope, sampleSize: 200 });
    const calibration = await runCalibrationAnalysis(scope);
    expect(bias.summary.samples_analyzed).toBe(60);
    expect(calibration.summary.samples_analyzed).toBe(60);
    expect(calibration.summary.mean).toBe(5);
    expect(bias.scope).toMatchObject(scope);
    expect(calibration.measurement_basis).toBe('score_distribution_not_accuracy');
});

test('missing cohorts stay explicitly empty rather than mixing other judge versions', async () => {
    await BenchmarkResult.collection.insertOne({ model: 'candidate', judge_model: 'old-judge', success: true,
        quality_score: 10, scoring_method: 'decomposed', timestamp: new Date() });
    expect(await runCalibrationAnalysis({ judgeModel: 'new-judge' })).toMatchObject({ success: false, samples_found: 0 });
});

test.each(['coding', 'reasoning'])('consistency preserves the selected cohort and explicit rubric over category %s', async (category) => {
    const batch = new mongoose.Types.ObjectId();
    const base = { batch_id: batch, success: true, quality_score: 5, scoring_method: 'decomposed',
        response: 'Answer', prompt: 'Task', prompt_category: category, prompt_level: 4,
        scoring_type: 'coding', scoring_plan: 'reference', reference_answer: 'Reference',
        judge_criteria: ['Correct result'], output_contract: { format: 'text' }, scorer_version: '2.12.0' };
    await BenchmarkResult.collection.insertMany([base,
        { ...base, batch_id: new mongoose.Types.ObjectId(), scoring_method: 'llm_judge' },
        { ...base, excluded_from_leaderboard: true }, { ...base, scorer_version: '2.11.0' }]);
    scoreResponse.mockResolvedValue({ quality_score: 8, scoring_method: 'reference',
        judge_prompt: 'actual prompt', judge_raw_response: 'actual raw evidence' });
    const result = await runConsistencyTest({ batchId: String(batch), scorerVersion: '2.12.0',
        sampleSize: 10, repeats: 3, judgeConfig: { host: 'http://judge:11434', model: 'judge' } });
    expect(result.summary).toMatchObject({ samples_tested: 1, repeats_per_sample: 3, pass: true });
    expect(scoreResponse).toHaveBeenCalledTimes(3);
    expect(scoreResponse.mock.calls[0][0].prompt).toMatchObject({ category, level: 4,
        scoring_type: 'coding', scoring_plan: 'reference', reference_answer: 'Reference',
        judge_criteria: ['Correct result'], output_contract: { format: 'text' } });
    expect(result.scope).toMatchObject({ batchId: String(batch), scorerVersion: '2.12.0' });
    expect(result.details[0].evaluations).toHaveLength(3);
    expect(result.details[0].evaluations[0]).toMatchObject({ judge_prompt: 'actual prompt',
        judge_raw_response: 'actual raw evidence' });
    expect(await BenchmarkResult.countDocuments({ quality_score: 5 })).toBe(4);
});

test('an incomplete repeat cannot certify perfect consistency from the two surviving grades', async () => {
    await BenchmarkResult.collection.insertOne({ success: true, quality_score: 5,
        scoring_method: 'llm_judge', response: 'Answer', prompt_category: 'reasoning' });
    scoreResponse.mockResolvedValueOnce({ quality_score: 8 }).mockResolvedValueOnce({ quality_score: null,
        error: 'Judge unavailable' }).mockResolvedValueOnce({ quality_score: 8 });
    const result = await runConsistencyTest({ sampleSize: 1, repeats: 3 });
    expect(result.summary).toMatchObject({ pass: false, consistency_score: null, failed_evaluations: 1 });
    expect(result.details[0].evaluations).toHaveLength(3);
});

test('all failed repeats retain their evidence and have no consistency score', async () => {
    await BenchmarkResult.collection.insertOne({ success: true, quality_score: 5,
        scoring_method: 'reference', response: 'Answer', prompt_category: 'reasoning' });
    scoreResponse.mockResolvedValue({ quality_score: null, error: 'Output incomplete', judge_raw_response: 'raw' });
    const result = await runConsistencyTest({ sampleSize: 1, repeats: 3 });
    expect(result).toMatchObject({ success: false, summary: { samples_tested: 0,
        failed_evaluations: 3, consistency_score: null, pass: false } });
    expect(result.details[0].evaluations).toHaveLength(3);
    expect(result.details[0].evaluations[0].judge_raw_response).toBe('raw');
});

test('cancellation stops repeat evaluation instead of consuming the remaining attempts', async () => {
    await BenchmarkResult.collection.insertOne({ success: true, quality_score: 5,
        scoring_method: 'decomposed', response: 'Answer', prompt_category: 'math' });
    const controller = new AbortController();
    scoreResponse.mockImplementationOnce(async () => {
        controller.abort(new Error('Claim ended'));
        return { quality_score: 8 };
    });
    await expect(runConsistencyTest({ sampleSize: 1, repeats: 3,
        judgeConfig: { cancelSignal: controller.signal } })).rejects.toThrow();
    expect(scoreResponse).toHaveBeenCalledTimes(1);
});
