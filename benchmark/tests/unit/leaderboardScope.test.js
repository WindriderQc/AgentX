/* Regression: the real service must keep score, speed and attempts on one scope. */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoOptions = require('../../../shared/testing/mongoOptions');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/benchmark/execution', () => ({}));
jest.mock('../../src/services/benchmark/init', () => ({}));
jest.mock('../../src/services/benchmark/judging', () => ({}));
jest.mock('../../src/services/benchmark/efficiencyMap', () => ({}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: () => [] }));
jest.mock('../../src/services/benchmark/modelAvailability', () => ({
  getCurrentHostModelSnapshot: async () => ({}),
  isModelAvailableForRow: () => true,
  serializeHostModelSnapshot: () => ({})
}));
jest.mock('../../src/services/benchmark/scoringProfile', () => ({ getScoringProfile: async () => ({}) }));
jest.mock('../../src/services/benchmark/judgeQualification', () => ({
  assessLeaderboardRows: async rows => rows.map(() => ({ status: 'unknown', qualified: false }))
}));
jest.mock('../../src/services/probePlacement', () => ({ residencyOf: () => 'gpu' }));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const { buildPromptFingerprint } = require('../../../shared/benchmarkTargetContract');
const service = require('../../src/services/benchmark');
const HOST = 'http://test-host.example:11434';
let mongo;
let fingerprint;
const row = (extra = {}) => ({
  model: 'model-a', host: HOST, batch_id: new mongoose.Types.ObjectId(),
  prompt: 'What is 2 + 2?', prompt_name: 'addition', prompt_category: 'math', prompt_level: 1,
  response: '4', success: true, quality_score: 8, composite_score: 80,
  scorer_version: '2.21.0', quality_cohort_fingerprint: 'common', prompt_fingerprint: fingerprint,
  tokens: 100, latency: 5000, tokens_per_sec: 20, judge_model: 'judge-a',
  execution_settings: { num_ctx: 32768 }, timestamp: new Date('2026-09-24T00:00:00Z'), ...extra
});
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), mongoOptions);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([BenchmarkResult.deleteMany({}), BenchmarkPrompt.deleteMany({})]);
  const prompt = await BenchmarkPrompt.create({ name: 'addition', category: 'math', level: 1,
    prompt: 'What is 2 + 2?', expected_answer: '4' });
  fingerprint = buildPromptFingerprint(prompt.toObject());
});

test.each([true, false])('cloud=%s keeps historical contexts out of both score and performance', async includeCloud => {
  await BenchmarkResult.collection.insertMany([
    row(), row(), row({ model: 'model-b' }),
    row({ quality_score: null, composite_score: null, success: false }),
    row({ quality_score: null, composite_score: null, success: false, infra_error: true }),
    ...Array.from({ length: 8 }, () => row({ quality_cohort_fingerprint: 'other', quality_score: 10,
      tokens_per_sec: 100, execution_settings: { num_ctx: 196608 }, timestamp: new Date('2026-10-25') })),
    row({ model: 'cloud-only', host: 'harness://test', quality_cohort_fingerprint: 'cloud-history',
      execution_target: { tier: 'paid_cloud' } })
  ]);
  const result = await service.getGeneralistLeaderboard({ axis: 'quality', includeCloud });
  const group = result.groups.find(item => item.model === 'model-a');
  expect(result.selectedQualityCohortFingerprint).toBe('common');
  expect(group.headline).toMatchObject({ totalTests: 2, contextCounts: { 32768: 2 },
    performance: { rows: 2, tokensPerSecTotal: { mean: 20 } },
    attempts: { attempts: 4, infraErrors: 1, successes: 2, successRateDenominator: 3 } });
  expect(group.history).toHaveLength(1);
  expect(group.history[0].performance.rows).toBe(8);
  expect(result.groups.some(item => item.model === 'cloud-only')).toBe(includeCloud);
});

test.each([true, false])('cloud=%s excludes edited prompts from score, speed and attempts together', async includeCloud => {
  await BenchmarkResult.collection.insertMany([
    row(), row({ model: 'model-b' }),
    row({ prompt_fingerprint: 'old-content', quality_score: 10, tokens_per_sec: 100 }),
    row({ prompt_fingerprint: 'old-content', quality_score: null, success: false })
  ]);
  const result = await service.getGeneralistLeaderboard({ axis: 'quality', includeCloud });
  const group = result.groups.find(item => item.model === 'model-a');
  expect(group.headline).toMatchObject({ totalTests: 1, performance: { rows: 1, tokensPerSecTotal: { mean: 20 } },
    attempts: { attempts: 1, successRate: 100 } });
  expect(group.history[0]).toMatchObject({ promptContentStale: true, totalTests: 1 });
  expect(group.history[0].performance).toBeUndefined();
});

test('local-only legacy evidence without a cohort remains unranked', async () => {
  await BenchmarkResult.collection.insertMany([row({ quality_cohort_fingerprint: null })]);
  const result = await service.getGeneralistLeaderboard({ includeCloud: false });
  expect(result.comparison.comparableCount).toBe(0);
  expect(result.groups[0]).toMatchObject({ comparable: false, rank: null });
  expect(result.comparison.rule).not.toContain('pooled');
});
