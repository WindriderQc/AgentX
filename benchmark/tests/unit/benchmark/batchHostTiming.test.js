jest.mock('../../../config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../../../models/BenchmarkBatch', () => ({ updateOne: jest.fn(async () => ({})) }));
jest.mock('../../../src/services/benchmark/modelWarmup', () => ({}));
jest.mock('../../../src/services/benchmark/workloadYield', () => ({}));
jest.mock('../../../src/services/benchmark/performanceBaseline', () => ({}));
jest.mock('../../../src/services/benchmark/earlyStop', () => ({}));
jest.mock('../../../src/services/benchmark/buddySurfaceEvents', () => ({ emitLifecycle: jest.fn() }));
jest.mock('../../../src/services/benchmark/inferenceContractSnapshot', () => ({
    getFrozenModelExecutionConfig: () => { throw new Error('synthetic model failure'); }
}));
jest.mock('../../../src/services/benchmark/resumeRevalidation', () => ({}));

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { createHostBatchRunner } = require('../../../src/services/benchmark/batchHostExecution');

test('same tag on different hosts records and closes its own timing even after failure', async () => {
    const runner = createHostBatchRunner({
        batchId: 'synthetic',
        shouldStopBatch: async () => false,
        resolveJudgeTargetForHost: async () => 'http://judge.local',
        recordBatchTimelineEvent: async () => {},
        executionConfig: {}
    }, jest.fn());
    for (const host of ['http://a.local', 'http://b.local']) {
        await runner(host, ['same-tag']);
    }
    const calls = BenchmarkBatch.updateOne.mock.calls;
    expect(calls).toHaveLength(4);
    ['http://a.local', 'http://b.local'].forEach((host, i) => {
        const start = calls[i * 2][1].$push.model_timings;
        expect(start).toEqual(expect.objectContaining({ model: 'same-tag', host, completed_at: null }));
        expect(calls[i * 2 + 1][0]).toEqual({
            _id: 'synthetic', model_timings: { $elemMatch: {
                model: 'same-tag', host, started_at: start.started_at
            } }
        });
        expect(calls[i * 2 + 1][1].$set['model_timings.$.completed_at']).toBeInstanceOf(Date);
    });
});
