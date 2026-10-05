'use strict';

const InferenceLog = require('../../models/InferenceLog');
const {
  buildDistributionPipeline,
  parseGroupBy,
  parseGroupLimit,
  shapeDistribution,
} = require('../../src/services/inferenceDistributionService');

const NOW = new Date('2026-10-04T12:00:00Z');
const WINDOW = { timestamp: { $gte: new Date('2026-10-01T00:00:00Z'), $lte: NOW } };
const label = (_field, value) => value;

function row(overrides = {}) {
  return {
    host: 'http://ollama-a.test:11434',
    model: 'model-a',
    caller: 'proxy',
    consumerContract: 'openclaw-pipeline-runtime-v1',
    status: 'success',
    num_ctx: 65536,
    timestamp: new Date('2026-10-03T10:00:00Z'),
    ...overrides,
  };
}

async function distribution(groupBy = ['consumerContract'], limit = 50, match = WINDOW) {
  const [facet] = await InferenceLog.aggregate(buildDistributionPipeline({ match, groupBy, limit }));
  return shapeDistribution(facet, { groupBy, limit, sanitizeLabel: label });
}

describe('inference distribution aggregation', () => {
  beforeEach(async () => {
    await InferenceLog.deleteMany({});
  });

  afterAll(async () => {
    await InferenceLog.deleteMany({});
  });

  test('reports percentiles, buckets and context fill per traffic class', async () => {
    await InferenceLog.insertMany([
      row({ tokensIn: 10000, tokensOut: 200, durationMs: 9000, loadMs: 0, promptEvalMs: 4000, evalMs: 3000 }),
      row({ tokensIn: 20000, tokensOut: 300, durationMs: 12000 }),
      row({ tokensIn: 30000, tokensOut: 400, durationMs: 15000 }),
      row({ tokensIn: 40000, tokensOut: 500, durationMs: 18000 }),
      row({ tokensIn: 0, estimatedInputTokensAtDispatch: 150000, status: 'timeout', durationMs: 600000 }),
      row({ consumerContract: 'household-runtime-v1', taskType: 'voice_persona_chat', tokensIn: 3000, tokensOut: 80, durationMs: 2000, firstTokenMs: 450 }),
      row({ tokensIn: 99999, timestamp: new Date('2026-09-01T00:00:00Z') }),
    ]);

    const result = await distribution();

    expect(result.totals.calls).toBe(6);
    expect(result.truncated).toBe(false);
    const pipeline = result.groups.find(group => group.key.consumerContract === 'openclaw-pipeline-runtime-v1');
    expect(pipeline.calls).toBe(5);
    expect(pipeline.statuses).toEqual({ success: 4, error: 0, timeout: 1 });

    // tokensIn 0 means "not reported": the dispatch estimate stands in for it.
    const input = pipeline.metrics.inputTokens;
    expect(input.count).toBe(5);
    expect(input.max).toBe(150000);
    expect(input.p50).toBe(30000);
    expect(input.p99).toBe(150000);
    expect(pipeline.metrics.tokensOut).toMatchObject({ count: 4, max: 500 });
    expect(pipeline.metrics.firstTokenMs).toEqual({ count: 0, p50: null, p90: null, p95: null, p99: null, max: null });

    // Only the row reporting every phase yields time spent outside the model.
    expect(pipeline.metrics.nonModelMs).toMatchObject({ count: 1, max: 2000 });

    const buckets = Object.fromEntries(pipeline.inputTokenBuckets.map(bucket => [bucket.label, bucket.calls]));
    expect(buckets).toEqual({
      '<=8k': 0, '<=16k': 1, '<=32k': 2, '<=64k': 1, '<=96k': 0, '<=128k': 0, '<=192k': 1, '>192k': 0,
    });

    // 40000/65536 = 0.61, 150000/65536 = 2.29.
    expect(pipeline.contextFill.count).toBe(5);
    expect(pipeline.contextFill.thresholds).toEqual([
      { atLeast: 0.5, calls: 2 }, { atLeast: 0.75, calls: 1 }, { atLeast: 0.9, calls: 1 },
    ]);
    expect(pipeline.metrics.contextFill.max).toBe(2.289);

    const household = result.groups.find(group => group.key.consumerContract === 'household-runtime-v1');
    expect(household.metrics.firstTokenMs).toMatchObject({ count: 1, p50: 450, max: 450 });
  });

  test('groups by two fields, labels missing values and reports truncation', async () => {
    await InferenceLog.insertMany([
      row({ model: 'model-a', tokensIn: 1000 }),
      row({ model: 'model-a', tokensIn: 2000 }),
      row({ model: 'model-b', tokensIn: 3000 }),
      row({ consumerContract: null, model: 'model-c', tokensIn: 4000 }),
    ]);

    const result = await distribution(['consumerContract', 'model'], 2);

    expect(result.groupBy).toEqual(['consumerContract', 'model']);
    expect(result.groups).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.groups[0].key).toEqual({ consumerContract: 'openclaw-pipeline-runtime-v1', model: 'model-a' });
    expect(result.groups[0].calls).toBe(2);

    const all = await distribution(['consumerContract', 'model'], 10);
    expect(all.groups.map(group => group.key)).toContainEqual({ consumerContract: 'unknown', model: 'model-c' });
  });

  test('returns empty metrics instead of zeros when nothing matches', async () => {
    const result = await distribution();

    expect(result.totals.calls).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.totals.metrics.inputTokens).toEqual({ count: 0, p50: null, p90: null, p95: null, p99: null, max: null });
    expect(result.percentileMethod).toBe('approximate');
  });
});

describe('distribution query parsing', () => {
  test('defaults to consumerContract and accepts at most two known fields', () => {
    expect(parseGroupBy(undefined)).toEqual(['consumerContract']);
    expect(parseGroupBy('taskType, model')).toEqual(['taskType', 'model']);
    expect(parseGroupBy('model,model')).toEqual(['model']);
    expect(() => parseGroupBy('callerDetail')).toThrow(/groupBy accepts/);
    expect(() => parseGroupBy('model,host,taskType')).toThrow(/groupBy accepts/);
  });

  test('bounds the group limit', () => {
    expect(parseGroupLimit(undefined)).toBe(50);
    expect(parseGroupLimit('10')).toBe(10);
    expect(() => parseGroupLimit('0')).toThrow(/limit/);
    expect(() => parseGroupLimit('201')).toThrow(/limit/);
    expect(() => parseGroupLimit('2.5')).toThrow(/limit/);
  });
});
