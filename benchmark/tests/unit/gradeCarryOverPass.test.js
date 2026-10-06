'use strict';

/**
 * The carry-over pass on a real collection: what a scorer change leaves valid
 * counts again in the coverage matrix and moves to the current cohort; what it
 * does not is left exactly as it was.
 */

const mongoose = require('mongoose');
const mongoOptions = require('../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const { buildPromptFingerprint } = require('../../../shared/benchmarkTargetContract');
const { cohortFingerprintForBatch } = require('../../src/services/benchmark/qualityCohort');
const { computeCoverage } = require('../../src/services/measurementCoverage/coverageState');
const { carryOverStoredGrades } = require('../../src/services/measurementCoverage/gradeCarryOverPass');
const { SCORER_VERSION, SCORER_CARRY_OVER } = require('../../src/services/scoring/scorerVersion');

// The last declared step: 2.19.0 -> 2.20.0 binds coding, instruction and creative.
const PREVIOUS = SCORER_CARRY_OVER.at(-1).from;
const HOST = 'http://host-a:11434';
const MODEL = 'model-a:7b';
const JUDGE = { host: 'http://judge-a:11434', model: 'judge-a:12b' };

let mongoServer;
let batch;
let prompts;
let previousCohort;

async function answer(category, fields = {}) {
    const prompt = prompts[category];
    return BenchmarkResult.create({
        batch_id: batch._id, model: MODEL, host: HOST, prompt: prompt.prompt, success: true,
        prompt_name: prompt.name, prompt_category: category, prompt_level: prompt.level,
        prompt_fingerprint: buildPromptFingerprint(prompt), scoring_type: category,
        scorer_version: PREVIOUS, quality_cohort_fingerprint: previousCohort,
        scoring_method: 'deterministic', quality_score: 10, composite_score: 9, latency: 1000, tokens_per_sec: 20,
        ...fields
    });
}

const stored = id => BenchmarkResult.findById(id).lean();

async function coveredPrompts() {
    const catalog = new Map(Object.values(prompts).map(prompt => [buildPromptFingerprint(prompt), { id: String(prompt._id), category: prompt.category }]));
    const answers = new Map([[`${HOST}::${MODEL}`, new Map()]]);
    for (const row of await BenchmarkResult.find({ scorer_version: SCORER_VERSION, quality_score: { $type: 'number' } }).lean()) {
        answers.get(`${HOST}::${MODEL}`).set(row.prompt_fingerprint, []);
    }
    const coverage = computeCoverage({ scope: [{ hostUrl: HOST, model: MODEL }], catalog, hostIds: new Map(), readiness: new Map(), answers });
    return coverage.cells[0].catalog.covered;
}

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

beforeEach(async () => {
    await Promise.all([BenchmarkBatch.deleteMany({}), BenchmarkPrompt.deleteMany({}), BenchmarkResult.deleteMany({})]);
    prompts = {};
    for (const category of ['math', 'coding', 'translation']) {
        prompts[category] = (await BenchmarkPrompt.create({ name: `${category}-1`, prompt: `A ${category} task`, level: 1, category })).toObject();
    }
    batch = (await BenchmarkBatch.create({
        run_name: 'coverage bite', host: HOST, models: [MODEL], levels: [1], total_tests: 3,
        judge_config: JUDGE, execution_config: { temperature: 0 }
    })).toObject();
    previousCohort = await cohortFingerprintForBatch(batch, batch.judge_config, { scorerVersion: PREVIOUS });
});

describe('carrying stored grades over to the current scorer version', () => {
    test('re-opens only what the scorer change affects, in the matrix and in the cohort alike', async () => {
        const untouched = await answer('math');
        const bounded = await answer('coding', { scoring_method: 'decomposed', quality_score: 8, subjective_score: 8,
            quality_breakdown: { correctness: 10, clarity: 10, efficiency: 0, robustness: 10 }, quality_explanation: 'Correct.' });
        expect(await coveredPrompts()).toBe(0);

        const summary = await carryOverStoredGrades();

        expect(summary).toMatchObject({ examined: 2, carried: 2, changed: 1, left: 0 });
        expect(await coveredPrompts()).toBe(2);
        const currentCohort = await cohortFingerprintForBatch(batch, batch.judge_config);
        expect(currentCohort).not.toBe(previousCohort);
        expect(await stored(untouched._id)).toMatchObject({
            scorer_version: SCORER_VERSION, quality_score: 10, composite_score: 9, quality_cohort_fingerprint: currentCohort,
            scorer_history: [{ scorer_version: PREVIOUS, quality_score: 10, quality_cohort_fingerprint: previousCohort, rules: [] }]
        });
        const rewritten = await stored(bounded._id);
        expect(rewritten).toMatchObject({
            scorer_version: SCORER_VERSION, quality_score: 4, subjective_score: 4, quality_cohort_fingerprint: currentCohort,
            scorer_history: [{ scorer_version: PREVIOUS, quality_score: 8, composite_score: 9 }]
        });
        expect(rewritten.composite_score).not.toBe(9);
        expect(rewritten.quality_explanation).toBe(`Correct. Bounded at efficiency + 4. Carried over from scorer ${PREVIOUS} (was 8).`);
    });

    test('is idempotent', async () => {
        const row = await answer('math');
        await carryOverStoredGrades();
        await expect(carryOverStoredGrades()).resolves.toMatchObject({ examined: 0, carried: 0 });
        expect((await stored(row._id)).scorer_history).toHaveLength(1);
    });

    test('a dry run reports and writes nothing', async () => {
        const row = await answer('math');
        await expect(carryOverStoredGrades({ dryRun: true })).resolves.toMatchObject({ carried: 1, dryRun: true });
        expect(await stored(row._id)).toMatchObject({ scorer_version: PREVIOUS, quality_cohort_fingerprint: previousCohort });
    });

    test('leaves untouched what it cannot derive, and says why', async () => {
        const first = SCORER_CARRY_OVER[0];
        const needsJudge = await answer(Object.keys(first.categories)[0], { scorer_version: first.from,
            quality_cohort_fingerprint: await cohortFingerprintForBatch(batch, batch.judge_config, { scorerVersion: first.from }) });
        const otherJudge = await answer('math', { quality_cohort_fingerprint: 'cohort-of-a-standalone-judge-run' });
        const excluded = await answer('math', { excluded_from_leaderboard: true });
        const editedPrompt = await answer('math', { prompt_fingerprint: 'an-earlier-wording' });
        const ungraded = await answer('math', { quality_score: null });
        const unreproduced = await answer('coding', { scoring_method: 'decomposed', quality_score: 7.3,
            quality_breakdown: { correctness: 10, clarity: 10, efficiency: 0, robustness: 10 } });

        const summary = await carryOverStoredGrades();

        expect(summary).toMatchObject({ examined: 3, carried: 0, left: 3 });
        expect(Object.keys(summary.reasons).sort()).toEqual([
            expect.stringContaining('asks the judge something new'),
            'cohort does not follow from the batch settings',
            'stored grade does not follow from its dimension scores'
        ].sort());
        for (const row of [needsJudge, otherJudge, excluded, editedPrompt, ungraded, unreproduced]) {
            const after = await stored(row._id);
            expect(after.scorer_version).toBe(row.scorer_version);
            expect(after.scorer_history).toBeUndefined();
        }
        expect(await coveredPrompts()).toBe(0);
    });

    test('a result outside every cohort keeps none', async () => {
        const row = await answer('math', { quality_cohort_fingerprint: null });
        await carryOverStoredGrades();
        expect(await stored(row._id)).toMatchObject({ scorer_version: SCORER_VERSION, quality_cohort_fingerprint: null });
    });
});
