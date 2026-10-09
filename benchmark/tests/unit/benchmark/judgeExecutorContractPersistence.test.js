'use strict';

jest.mock('../../../models/BenchmarkResult', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(), calculateCompositeScore: () => ({ composite_score: 6, normalized: {} })
}));
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { scoreResponse } = require('../../../src/services/qualityScorer');
const { judgeResult } = require('../../../src/services/benchmark/judgeExecutor');
const { freezeJudgeConfig } = require('../../../src/services/benchmark/judgeExecutionContract');

const resolver = async (_path, options) => {
    const { model, host } = JSON.parse(options.body);
    return { version: 'agentx.inference-contract.v1', contextBudget: { windowTokens: 65536 },
        artifact: { model, host, digest: 'digest-a', runtimeFingerprint: 'runtime-a', identityQualified: true, registryQualified: true } };
};

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkResult.findById.mockResolvedValue({ success: true, response: 'answer', prompt: 'question',
        prompt_category: 'knowledge', prompt_level: 4, prompt_snapshot_embedded: true,
        judge_scores: [{ judge_model: 'previous-judge' }], judge_escalated: true });
    BenchmarkResult.updateOne.mockResolvedValue({ matchedCount: 1 });
});

test('primary, secondary, tiebreaker and their execution policy commit with the consensus in one write', async () => {
    const primary = { host: 'http://judge:11434', model: 'primary', seed: null, num_predict: 1600 };
    const config = await freezeJudgeConfig({ ...primary, multi_judge: { enabled: true, autoMinLevel: 1,
        judges: [primary, { ...primary, model: 'secondary', num_predict: 3200 }],
        tiebreaker: { ...primary, model: 'tie', think: true } } }, { resolveContract: resolver });
    scoreResponse.mockResolvedValueOnce({ quality_score: 3, judge_confidence: 0.9, scoring_method: 'decomposed' })
        .mockResolvedValueOnce({ quality_score: 9 }).mockResolvedValueOnce({ quality_score: 6 });
    await judgeResult('result-id', config);
    expect(BenchmarkResult.updateOne).toHaveBeenCalledTimes(1);
    const saved = BenchmarkResult.updateOne.mock.calls[0][1].$set;
    expect(saved).toMatchObject({ quality_score: 6, judge_model: 'primary', judge_host: primary.host,
        judge_tiebreaker_used: true, judge_escalated: true,
        judge_qualification_contract: { settings: { seed: null, numPredict: 1600 },
            escalation: { autoMinLevel: 1, tiebreaker: { model: 'tie' } } } });
    expect(saved.judge_scores.map(score => score.qualification_contract.settings.numPredict)).toEqual([1600, 3200, 1600]);
    expect(saved.judge_scores[2].qualification_contract.settings.think).toBe(true);
});

test('a single rejudge removes previous consensus and saves the current contract', async () => {
    const config = await freezeJudgeConfig({ host: 'http://judge:11434', model: 'replacement', seed: 0 }, { resolveContract: resolver });
    scoreResponse.mockResolvedValueOnce({ quality_score: 8, scoring_method: 'decomposed' });
    await judgeResult('result-id', config);
    expect(BenchmarkResult.updateOne.mock.calls[0][1].$set).toMatchObject({
        judge_model: 'replacement', judge_scores: [], judge_escalated: false, judge_consensus: null,
        judge_qualification_contract: { settings: { seed: 0 }, escalation: null }
    });
});
