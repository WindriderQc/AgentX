jest.mock('../../../config/logger', () => ({ warn: jest.fn() }));
jest.mock('../../../models/BenchmarkResult', () => ({ find: jest.fn() }));
jest.mock('../../../models/BenchmarkBatch', () => ({ updateOne: jest.fn(async () => ({})) }));

const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { evaluateAndPersistEarlyStop } = require('../../../src/services/benchmark/earlyStop');

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkResult.find.mockReturnValue({ select: () => ({ lean: async () =>
        Array.from({ length: 5 }, () => ({ quality_score: 1 })) }) });
});

test('complete coverage proceeds even after the first five low scores', async () => {
    const timeline = jest.fn();
    expect(await evaluateAndPersistEarlyStop({ batchId: 'synthetic', model: 'candidate',
        hostUrl: 'http://candidate.local', executionConfig: { early_stop_enabled: false },
        recordBatchTimelineEvent: timeline })).toBe(false);
    expect(BenchmarkResult.find).not.toHaveBeenCalled();
    expect(BenchmarkBatch.updateOne).not.toHaveBeenCalled();
    expect(timeline).not.toHaveBeenCalled();
});

test('the existing enabled policy records why coverage stopped', async () => {
    const timeline = jest.fn(async () => {});
    expect(await evaluateAndPersistEarlyStop({ batchId: 'synthetic', model: 'candidate',
        hostUrl: 'http://candidate.local', executionConfig: { early_stop_enabled: true },
        recordBatchTimelineEvent: timeline })).toBe(true);
    expect(BenchmarkBatch.updateOne).toHaveBeenCalledWith(expect.anything(), { $set: expect.objectContaining({
        'model_timings.$.early_stopped': true,
        'model_timings.$.early_stop_judged_count': 5,
        'model_timings.$.early_stop_reason': expect.stringContaining('after 5 judged prompts')
    }) });
    expect(timeline).toHaveBeenCalledWith('model_early_stopped', expect.objectContaining({ judged_count: 5 }));
});
