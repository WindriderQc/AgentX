'use strict';
/**
 * Leaderboard performance and attempt summaries are computed on the server
 * over the rows behind each entry's score, with every attempt of the same
 * scope as the success-rate denominator. Real in-memory Mongo, because the
 * whole point is the aggregation.
 */
const mongoose = require('mongoose');
const mongoOptions = require('../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    attemptScope,
    getLeaderboardPerformanceSummary,
    majorMinor,
    scorerVersionsByEntry
} = require('../../src/services/benchmark/leaderboardPerformance');

let mongoServer;
const HOST = 'http://host-a.example:11434';
const COHORT = 'cohort-a';

function row(overrides = {}) {
    return {
        batch_id: new mongoose.Types.ObjectId(),
        model: 'model-x', host: HOST, prompt: 'p', response: 'r',
        success: true, quality_score: 8, scorer_version: '2.15.0',
        quality_cohort_fingerprint: COHORT,
        tokens: 100, latency: 5000, tokens_per_sec: 20, prompt_eval_duration_ms: 1000,
        timestamp: new Date('2026-09-22T00:00:00Z'),
        ...overrides
    };
}

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});
afterAll(async () => { await mongoose.disconnect(); await mongoServer.stop(); });
beforeEach(async () => { await BenchmarkResult.deleteMany({}); });

const scoreMatch = { success: true, infra_error: { $ne: true }, needs_review: { $ne: true },
    excluded_from_leaderboard: { $ne: true }, quality_score: { $ne: null }, host: HOST };

describe('attempt scope', () => {
    test('keeps the scope filters and drops outcome and score filters', () => {
        expect(attemptScope({ ...scoreMatch, prompt_level: { $gte: 4 }, quality_cohort_fingerprint: COHORT }))
            .toEqual({ host: HOST, prompt_level: { $gte: 4 }, quality_cohort_fingerprint: COHORT });
    });
});

describe('success rate', () => {
    test('uses every attempt of the scope as the denominator, minus infrastructure errors', async () => {
        await BenchmarkResult.insertMany([
            row(), row(), row({ quality_score: null }),                 // 3 successes, one unscored
            row({ success: false, quality_score: null, error: 'bad answer' }),
            row({ success: false, quality_score: null, infra_error: true, error: 'ECONNRESET' }),
            row({ needs_review: true })                                 // success, but out of the score
        ]);
        const summary = await getLeaderboardPerformanceSummary(scoreMatch);
        const { attempts, performance } = summary.lookup('model-x', HOST, COHORT);
        expect(attempts).toMatchObject({ attempts: 6, successes: 4, executionFailures: 1, infraErrors: 1,
            needsReview: 1, unscored: 1, successRate: 80, successRateDenominator: 5 });
        // Performance covers only the rows that carry the score.
        expect(performance.rows).toBe(2);
    });

    test('a set with failures never reads as 100%, and an empty denominator is unknown', async () => {
        await BenchmarkResult.insertMany([row(), row({ success: false, quality_score: null })]);
        expect((await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT).attempts.successRate).toBe(50);
        await BenchmarkResult.deleteMany({});
        await BenchmarkResult.insertMany([row({ success: false, quality_score: null, infra_error: true })]);
        const { attempts } = (await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT);
        expect(attempts).toMatchObject({ attempts: 1, successRate: null, successRateDenominator: 0 });
    });
});

describe('performance', () => {
    test('separates total and generation throughput and measured from baseline TTFT', async () => {
        await BenchmarkResult.insertMany([
            // The older row carries the baseline; the newer one has none.
            row({ tokens: 100, latency: 5000, tokens_per_sec: 20, prompt_eval_duration_ms: 1000,
                time_to_first_token_ms: 400, ttft_measurement: 'streamed_wall_clock',
                performance_baseline: { timeToFirstTokenMs: 150, ttftMeasurement: 'streamed_wall_clock' },
                timestamp: new Date('2026-09-21T00:00:00Z') }),
            row({ tokens: 100, latency: 10000, tokens_per_sec: 10, prompt_eval_duration_ms: null,
                time_to_first_token_ms: 900, ttft_measurement: null, timestamp: new Date('2026-09-22T00:00:00Z') })
        ]);
        const { performance } = (await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT);
        expect(performance.tokensPerSecTotal).toMatchObject({ mean: 15, median: 15, sampleSize: 2 });
        // 100 tokens over (5000 - 1000) ms; the second row has no prompt evaluation time.
        expect(performance.tokensPerSecGeneration).toMatchObject({ mean: 25, sampleSize: 1 });
        expect(performance.latencyMs).toMatchObject({ mean: 7500, p95: 10000, sampleSize: 2 });
        expect(performance.ttftMs).toEqual({ measured: { mean: 400, sampleSize: 1 }, hostBaseline: 150 });
    });

    test('keeps cohorts, hosts and models apart', async () => {
        await BenchmarkResult.insertMany([
            row({ tokens_per_sec: 10 }),
            row({ tokens_per_sec: 50, quality_cohort_fingerprint: 'cohort-b' }),
            row({ tokens_per_sec: 90, host: 'http://host-b.example:11434' })
        ]);
        const summary = await getLeaderboardPerformanceSummary({ ...scoreMatch, host: { $exists: true } });
        expect(summary.lookup('model-x', HOST, COHORT).performance.tokensPerSecTotal.mean).toBe(10);
        expect(summary.lookup('model-x', HOST, 'cohort-b').performance.tokensPerSecTotal.mean).toBe(50);
        expect(summary.lookup('model-x', 'http://host-b.example:11434', COHORT).performance.tokensPerSecTotal.mean).toBe(90);
        expect(summary.lookup('model-x', HOST, 'cohort-none')).toEqual({ performance: null, attempts: null });
    });

    test('reports the plain mean of the axis field per cohort, on that field\'s scale', async () => {
        await BenchmarkResult.insertMany([
            row({ quality_score: 8, composite_score: 80 }),
            row({ quality_score: 6, composite_score: 60 }),
            row({ quality_score: 9, composite_score: 90, quality_cohort_fingerprint: 'cohort-b' })
        ]);
        const quality = await getLeaderboardPerformanceSummary(scoreMatch, { scoreField: 'quality_score' });
        expect(quality.lookup('model-x', HOST, COHORT).performance.score).toEqual({ field: 'quality_score', scale: 10, mean: 7, sampleSize: 2 });
        expect(quality.lookup('model-x', HOST, 'cohort-b').performance.score).toEqual({ field: 'quality_score', scale: 10, mean: 9, sampleSize: 1 });
        const composite = await getLeaderboardPerformanceSummary(scoreMatch, { scoreField: 'composite_score' });
        expect(composite.lookup('model-x', HOST, COHORT).performance.score).toEqual({ field: 'composite_score', scale: 100, mean: 70, sampleSize: 2 });
        // Without an axis there is no mean to report.
        expect((await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT).performance.score).toBeNull();
    });

    test('reports the most used judge, contexts and scorer versions', async () => {
        await BenchmarkResult.insertMany([
            row({ judge_model: 'judge-a', execution_settings: { num_ctx: 8192 } }),
            row({ judge_model: 'judge-a', execution_settings: { num_ctx: 8192 } }),
            row({ judge_model: 'judge-b', execution_settings: { num_ctx: 65536 }, scorer_version: null })
        ]);
        const { performance } = (await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT);
        expect(performance.judgeModel).toBe('judge-a');
        expect(performance.contexts).toEqual({ 8192: 2, 65536: 1 });
        expect(performance.scorerVersions).toEqual({ '2.15.0': 2, unversioned: 1 });
        expect(performance.mixedScorerVersions).toBe(false);
    });
});

describe('rows written before a field existed', () => {
    test('are counted as unversioned and keep the per-row arrays aligned', async () => {
        // Raw inserts bypass Mongoose defaults, so these fields are missing, not null.
        await BenchmarkResult.collection.insertMany([
            { model: 'model-x', host: HOST, quality_cohort_fingerprint: COHORT, success: true, quality_score: 7,
              tokens: 100, latency: 5000, tokens_per_sec: 20, timestamp: new Date('2026-09-20T00:00:00Z') },
            { model: 'model-x', host: HOST, quality_cohort_fingerprint: COHORT, success: true, quality_score: 7,
              tokens: 100, latency: 5000, tokens_per_sec: 20, prompt_eval_duration_ms: 1000, scorer_version: '2.15.0',
              timestamp: new Date('2026-09-21T00:00:00Z') }
        ]);
        const { performance } = (await getLeaderboardPerformanceSummary(scoreMatch)).lookup('model-x', HOST, COHORT);
        expect(performance.rows).toBe(2);
        expect(performance.scorerVersions).toEqual({ '2.15.0': 1, unversioned: 1 });
        // Only the row with a recorded prompt evaluation time yields a generation rate: 100 / 4 s.
        expect(performance.tokensPerSecGeneration).toMatchObject({ mean: 25, sampleSize: 1 });
        expect(performance.tokensPerSecTotal).toMatchObject({ mean: 20, sampleSize: 2 });
        const versions = await scorerVersionsByEntry(scoreMatch);
        expect(versions.get(`model-x@@${HOST}`)).toEqual({ counts: { '2.15.0': 1, unversioned: 1 }, mixed: false });
    });
});

describe('scorer version guard', () => {
    test('flags an entry whose scored rows span two scorer generations', async () => {
        await BenchmarkResult.insertMany([
            row({ scorer_version: '2.14.0' }), row({ scorer_version: '2.15.0' }),
            row({ model: 'model-y', scorer_version: '2.15.0' }), row({ model: 'model-y', scorer_version: '2.15.1' })
        ]);
        const versions = await scorerVersionsByEntry({ ...scoreMatch });
        expect(versions.get(`model-x@@${HOST}`)).toEqual({ counts: { '2.14.0': 1, '2.15.0': 1 }, mixed: true });
        expect(versions.get(`model-y@@${HOST}`)).toEqual({ counts: { '2.15.0': 1, '2.15.1': 1 }, mixed: false });
        expect(majorMinor('2.15.1')).toBe('2.15');
        expect(majorMinor(null)).toBeNull();
    });
});
