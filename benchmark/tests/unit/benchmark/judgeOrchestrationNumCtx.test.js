'use strict';

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../../../models/BenchmarkResult', () => ({}));
jest.mock('../../../models/BenchmarkBatch', () => ({}));
jest.mock('../../../models/BenchmarkTimelineEntry', () => ({}));
jest.mock('../../../models/JudgeQueueEntry', () => ({ create: jest.fn() }));
jest.mock('../../../src/services/qualityScorer', () => ({ JUDGE_CONFIG: { model: 'judge:latest', num_ctx: null } }));
jest.mock('../../../src/services/benchmark/modelWarmup', () => ({ warmupModel: jest.fn() }));
jest.mock('../../../src/services/benchmark/judging', () => ({ judgeResult: jest.fn() }));
jest.mock('../../../src/services/benchmark/judgeHostResolution', () => ({ resolveJudgeHost: jest.fn() }));
jest.mock('../../../src/services/benchmark/errorClassifier', () => ({ classifyBenchmarkError: jest.fn() }));

const JudgeQueueEntry = require('../../../models/JudgeQueueEntry');
const { createJudgeOrchestrator } = require('../../../src/services/benchmark/judgeOrchestration');

const HOST = 'http://judge-host:11434';

function orchestrator(judgeConfig, resolveJudgeContractNumCtx) {
  return createJudgeOrchestrator({
    batchId: 'batch-1',
    judgeConfig,
    judgeQueue: { waitForCapacity: jest.fn(), add: jest.fn().mockResolvedValue(undefined) },
    executionConfig: {},
    recordBatchTimelineEvent: jest.fn(),
    setBatchPhase: jest.fn(),
    resolveJudgeContractNumCtx
  });
}

describe('judge num_ctx resolution', () => {
  beforeEach(() => {
    JudgeQueueEntry.create.mockReset();
    JudgeQueueEntry.create.mockResolvedValue(null);
  });

  it('keeps an explicit judge context without asking Core', async () => {
    const contract = jest.fn();
    const judge = orchestrator({ model: 'judge:latest', num_ctx: 16384 }, contract);

    await expect(judge.resolveJudgeNumCtx('judge:latest', HOST, { num_ctx: 16384 })).resolves.toBe(16384);
    expect(contract).not.toHaveBeenCalled();
  });

  it('uses the inference contract context when none is configured, once per host and model', async () => {
    const contract = jest.fn().mockResolvedValue({ num_ctx: 65536, source: 'inference_contract:host_pin' });
    const judge = orchestrator({ model: 'judge:latest' }, contract);

    await expect(judge.resolveJudgeNumCtx('judge:latest', HOST, {})).resolves.toBe(65536);
    await expect(judge.resolveJudgeNumCtx('judge:latest', HOST, {})).resolves.toBe(65536);
    expect(contract).toHaveBeenCalledTimes(1);
    expect(contract).toHaveBeenCalledWith('judge:latest', HOST);
  });

  it('falls back to omitting num_ctx when the contract cannot be resolved', async () => {
    const contract = jest.fn().mockRejectedValue(new Error('Core unavailable'));
    const judge = orchestrator({ model: 'judge:latest' }, contract);

    await expect(judge.resolveJudgeNumCtx('judge:latest', HOST, {})).resolves.toBeNull();
  });

  it('sends judge calls with the same context the warmup used', async () => {
    const contract = jest.fn().mockResolvedValue({ num_ctx: 65536, source: 'inference_contract:host_pin' });
    const judge = orchestrator({ model: 'judge:latest' }, contract);

    await judge.enqueueJudgeTask('candidate:latest', { name: 'p' }, HOST, 'result-1');

    expect(JudgeQueueEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      judgeConfig: expect.objectContaining({ host: HOST, num_ctx: 65536 })
    }));
  });
});

describe('judge warmup on a separate host', () => {
  const { warmupModel } = require('../../../src/services/benchmark/modelWarmup');
  const { resolveJudgeHost } = require('../../../src/services/benchmark/judgeHostResolution');
  const BenchmarkBatch = require('../../../models/BenchmarkBatch');

  it('leaves the judge host\'s other residents loaded', async () => {
    BenchmarkBatch.updateOne = jest.fn().mockResolvedValue({});
    resolveJudgeHost.mockReturnValue({ judgeHost: HOST, resolution: 'explicit' });
    const judge = orchestrator({ model: 'judge:latest', num_ctx: 16384 }, jest.fn());

    await judge.resolveJudgeTargetForHost('http://candidate-host:11434');

    expect(warmupModel).toHaveBeenCalledWith(HOST, 'judge:latest', expect.objectContaining({
      num_ctx: 16384, preUnloadOthers: false
    }));
  });
});
