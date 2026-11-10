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

test('early stop reads and updates only the active host of a repeated model tag', async () => {
    BenchmarkResult.find.mockImplementation(filter => ({ select: () => ({ lean: async () =>
        Array.from({ length: 5 }, () => ({ quality_score: filter.host === 'http://weak.local' ? 1 : 9 })) }) }));
    const modelStartedAt = new Date('2026-01-01T00:00:00Z');
    const base = { batchId: 'synthetic', model: 'same-tag', modelStartedAt, executionConfig: { early_stop_enabled: true } };
    expect(await evaluateAndPersistEarlyStop({ ...base, hostUrl: 'http://strong.local' })).toBe(false);
    expect(BenchmarkBatch.updateOne).not.toHaveBeenCalled();
    expect(await evaluateAndPersistEarlyStop({ ...base, hostUrl: 'http://weak.local' })).toBe(true);
    expect(BenchmarkResult.find).toHaveBeenLastCalledWith(expect.objectContaining({
        batch_id: 'synthetic', model: 'same-tag', host: 'http://weak.local'
    }));
    expect(BenchmarkBatch.updateOne).toHaveBeenCalledWith({
        _id: 'synthetic', model_timings: { $elemMatch: {
            model: 'same-tag', host: 'http://weak.local', started_at: modelStartedAt, completed_at: null
        } }
    }, expect.anything());
});
