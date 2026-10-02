/**
 * Unit tests for retroCalibration.js
 * Tests stratified sampling logic, score-and-promote flow, and coverage stats.
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../models/BenchmarkResult', () => ({
    aggregate: jest.fn()
}));

jest.mock('../../models/BenchmarkBatch', () => ({
    findById: jest.fn()
}));

jest.mock('../../models/JudgeGroundTruth', () => ({
    findOne: jest.fn(),
    create: jest.fn(),
    updateOne: jest.fn(),
    aggregate: jest.fn(),
    find: jest.fn()
}));

jest.mock('../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { scoreResponse } = require('../../src/services/qualityScorer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    buildStratifiedSample,
    scoreAndPromote,
    runRetroCalibration,
    getCoverageStats,
    loadConfigGoldset,
    loadHumanReviewGroundTruth,
    loadQualifiedHumanGroundTruth,
    loadUnionedGoldset,
    SCORE_BUCKETS,
    CATEGORIES
} = require('../../src/services/benchmark/retroCalibration');

const FAKE_BATCH_ID = new mongoose.Types.ObjectId().toHexString();

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkBatch.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ _id: FAKE_BATCH_ID })
        })
    });
});

describe('SCORE_BUCKETS', () => {
    test('defines 5 buckets covering 0-10 range', () => {
        expect(SCORE_BUCKETS).toHaveLength(5);
        expect(SCORE_BUCKETS[0].min).toBe(0);
        expect(SCORE_BUCKETS[SCORE_BUCKETS.length - 1].max).toBe(10);
    });

    test('buckets are contiguous', () => {
        for (let i = 1; i < SCORE_BUCKETS.length; i++) {
            const prev = SCORE_BUCKETS[i - 1];
            const curr = SCORE_BUCKETS[i];
            expect(curr.min).toBeGreaterThan(prev.max - 0.02);
        }
    });
});

describe('CATEGORIES', () => {
    test('lists all 7 benchmark categories', () => {
        expect(CATEGORIES).toHaveLength(7);
        expect(CATEGORIES).toContain('coding');
        expect(CATEGORIES).toContain('creative');
        expect(CATEGORIES).toContain('translation');
    });
});

describe('buildStratifiedSample', () => {
    test('queries per category x bucket and aggregates results', async () => {
        BenchmarkResult.aggregate.mockResolvedValue([
            { _id: 'r1', prompt_category: 'coding', quality_score: 1.5, prompt: 'code task', response: 'fn()' }
        ]);

        const samples = await buildStratifiedSample(FAKE_BATCH_ID, 2);

        // 7 categories x 5 buckets = 35 aggregate calls
        expect(BenchmarkResult.aggregate).toHaveBeenCalledTimes(35);
        // Should have 35 samples (1 per call)
        expect(samples).toHaveLength(35);
        // Each sample should have _score_bucket and _original_score
        expect(samples[0]._score_bucket).toBeDefined();
        expect(samples[0]._original_score).toBeDefined();
    });

    test('returns empty array when no results match', async () => {
        BenchmarkResult.aggregate.mockResolvedValue([]);
        const samples = await buildStratifiedSample(FAKE_BATCH_ID, 3);
        expect(samples).toHaveLength(0);
    });

    test('uses correct match criteria excluding failed scoring methods', async () => {
        BenchmarkResult.aggregate.mockResolvedValue([]);
        await buildStratifiedSample(FAKE_BATCH_ID, 1);

        const firstCall = BenchmarkResult.aggregate.mock.calls[0][0];
        const matchStage = firstCall.find(s => s.$match);
        expect(matchStage.$match.batch_id).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(matchStage.$match.scoring_method.$nin).toEqual(
            expect.arrayContaining(['empty_response', 'skipped', 'llm_failed', 'pending'])
        );
    });
});

describe('scoreAndPromote', () => {
    const refConfig = { model: 'qwq:32b', host: 'http://192.0.2.66:11434' };

    const makeSample = (overrides = {}) => ({
        _id: 'result1',
        batch_id: FAKE_BATCH_ID,
        prompt: 'Write hello world',
        response: 'print("Hello, World!")',
        prompt_category: 'coding',
        prompt_level: 2,
        expected_answer: 'print("Hello, World!")',
        quality_score: 7.5,
        _score_bucket: '6-8',
        _original_score: 7.5,
        ...overrides
    });

    test('creates ground truth entries from scored samples', async () => {
        const samples = [makeSample()];
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        JudgeGroundTruth.create.mockResolvedValue({});
        scoreResponse.mockResolvedValue({
            quality_score: 8.0,
            scoring_method: 'decomposed',
            breakdown: { correctness: 9, clarity: 7 },
            explanation: 'Good code'
        });

        const result = await scoreAndPromote(samples, refConfig);

        expect(result.created).toBe(1);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);
        expect(JudgeGroundTruth.create).toHaveBeenCalledWith(
            expect.objectContaining({
                name: `retro-${FAKE_BATCH_ID}-result1`,
                category: 'coding',
                created_by: 'retro-calibration',
                tags: expect.arrayContaining(['retro', 'auto-generated']),
                active: true
            })
        );
    });

    test('skips existing ground truth entries by default', async () => {
        const samples = [makeSample()];
        JudgeGroundTruth.findOne.mockResolvedValue({ _id: 'existing' });

        const result = await scoreAndPromote(samples, refConfig);

        expect(result.skipped).toBe(1);
        expect(result.created).toBe(0);
        expect(scoreResponse).not.toHaveBeenCalled();
    });

    test('handles null scores from reference judge', async () => {
        const samples = [makeSample()];
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        scoreResponse.mockResolvedValue({
            quality_score: null,
            scoring_method: 'llm_failed',
            error: 'timeout'
        });

        const result = await scoreAndPromote(samples, refConfig);

        expect(result.errors).toBe(1);
        expect(result.created).toBe(0);
    });

    test('dry run does not create entries', async () => {
        const samples = [makeSample()];
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        scoreResponse.mockResolvedValue({
            quality_score: 8.0,
            scoring_method: 'decomposed',
            breakdown: { correctness: 9 }
        });

        const result = await scoreAndPromote(samples, refConfig, { dryRun: true });

        expect(result.created).toBe(1);
        expect(JudgeGroundTruth.create).not.toHaveBeenCalled();
    });

    test('handles duplicate key errors gracefully', async () => {
        const samples = [makeSample()];
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        scoreResponse.mockResolvedValue({
            quality_score: 8.0,
            scoring_method: 'decomposed',
            breakdown: {}
        });
        JudgeGroundTruth.create.mockRejectedValue({ code: 11000, message: 'Duplicate key' });

        const result = await scoreAndPromote(samples, refConfig);

        expect(result.skipped).toBe(1);
        expect(result.errors).toBe(0);
    });

    test('invalidates a promoted row whose create races admission loss', async () => {
        const controller = new AbortController();
        const lost = Object.assign(new Error('retro admission lost'), { code: 'BENCHMARK_CLAIM_LOST' });
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        scoreResponse.mockResolvedValue({
            quality_score: 8,
            scoring_method: 'decomposed',
            breakdown: {}
        });
        JudgeGroundTruth.create.mockImplementationOnce(async () => {
            controller.abort(lost);
            return [{}];
        });
        JudgeGroundTruth.updateOne.mockResolvedValue({ matchedCount: 1 });

        await expect(scoreAndPromote([makeSample()], refConfig, {
            cancelSignal: controller.signal
        })).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED',
            authorityCompensated: true
        });

        expect(JudgeGroundTruth.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ _id: expect.any(mongoose.Types.ObjectId) }),
            { $set: expect.objectContaining({ active: false, authority_state: 'authority_invalidated' }) },
            { upsert: true }
        );
    });

    test('retains admission when a raced promotion cannot be invalidated', async () => {
        const controller = new AbortController();
        const lost = Object.assign(new Error('retro admission lost'), { code: 'BENCHMARK_CLAIM_LOST' });
        JudgeGroundTruth.findOne.mockResolvedValue(null);
        scoreResponse.mockResolvedValue({
            quality_score: 8,
            scoring_method: 'decomposed',
            breakdown: {}
        });
        JudgeGroundTruth.create.mockImplementationOnce(async () => {
            controller.abort(lost);
            return [{}];
        });
        JudgeGroundTruth.updateOne.mockRejectedValueOnce(new Error('invalidation unavailable'));

        await expect(scoreAndPromote([makeSample()], refConfig, {
            cancelSignal: controller.signal
        })).rejects.toMatchObject({
            code: 'GROUND_TRUTH_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error)
        });
    });
});

describe('runRetroCalibration', () => {
    test('returns zero message when no samples match', async () => {
        BenchmarkResult.aggregate.mockResolvedValue([]);

        const result = await runRetroCalibration(FAKE_BATCH_ID, { model: 'qwq:32b', host: 'http://localhost' });

        expect(result.samples).toBe(0);
        expect(result.results.total).toBe(0);
        expect(result.message).toContain('No samples');
    });

});

// Union loader tests
describe('loadConfigGoldset', () => {
    test('loads and normalizes the config goldset', () => {
        const tmp = path.join(os.tmpdir(), `goldset-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify([
            { id: 'a1', category: 'coding', prompt: 'p', response: 'r',
              expected_answer: 'e', gold_score: 7, tier: 'good' }
        ]));
        const out = loadConfigGoldset(tmp);
        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('config-goldset-a1');
        expect(out[0].source).toBe('config-goldset');
        expect(out[0].expert_scores.overall).toBe(7);
        fs.unlinkSync(tmp);
    });

    test('returns empty array for missing file', () => {
        expect(loadConfigGoldset('/nonexistent/file.json')).toEqual([]);
    });
});

describe('loadHumanReviewGroundTruth', () => {
    test('queries for courthouse-review and human-validation-sprint-* sources', async () => {
        const chain = {
            limit: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([
                { name: 'courthouse-review-abc', source: 'courthouse-review' }
            ])
        };
        JudgeGroundTruth.find.mockReturnValue(chain);

        const out = await loadHumanReviewGroundTruth();
        expect(JudgeGroundTruth.find).toHaveBeenCalled();
        const args = JudgeGroundTruth.find.mock.calls[0][0];
        expect(args.active).toBe(true);
        expect(args.$or).toEqual(expect.arrayContaining([
            { source: 'courthouse-review' },
            { source: { $regex: '^human-validation-sprint-' } }
        ]));
        expect(out).toHaveLength(1);
    });
});

describe('loadQualifiedHumanGroundTruth', () => {
    test('requires a qualified review lane and the exact judge identity', async () => {
        const judgeIdentityFingerprint = 'a'.repeat(64);
        const docs = [{
            name: 'qualified-human-1',
            provenance_class: 'independent_human_score',
            source_result_id: 'source-1'
        }];
        const chain = {
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(docs)
        };
        JudgeGroundTruth.find.mockReturnValue(chain);

        const out = await loadQualifiedHumanGroundTruth({
            category: 'math',
            judge_identity_fingerprint: judgeIdentityFingerprint
        });

        expect(JudgeGroundTruth.find).toHaveBeenCalledWith({
            active: true,
            category: 'math',
            judge_identity_fingerprint: judgeIdentityFingerprint,
            $or: [
                {
                    provenance_class: 'independent_human_score',
                    review_protocol: { $in: ['blind_independent', 'blind_double_review'] }
                },
                {
                    provenance_class: 'adjudicated_human_score',
                    review_protocol: 'adjudicated'
                }
            ]
        });
        expect(out).toEqual(docs);
    });

    test('applies the limit after loading', async () => {
        const docs = [
            { name: 'first', source_result_id: 'source-1' },
            { name: 'second', source_result_id: 'source-2' }
        ];
        JudgeGroundTruth.find.mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(docs)
        });
        await expect(loadQualifiedHumanGroundTruth({ limit: 1 })).resolves.toEqual([docs[0]]);
    });

    test('fails closed instead of double-weighting two reviews for one source result', async () => {
        const docs = [
            { name: 'first', source_result_id: 'same-source' },
            { name: 'second', source_result_id: 'same-source' }
        ];
        JudgeGroundTruth.find.mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(docs)
        });
        await expect(loadQualifiedHumanGroundTruth()).rejects.toMatchObject({
            code: 'HUMAN_EVIDENCE_DUPLICATE_SOURCE',
            statusCode: 409
        });
    });
});

describe('loadUnionedGoldset', () => {
    test('unions config goldset with human reviews, dedupes by name', async () => {
        const tmp = path.join(os.tmpdir(), `goldset-${Date.now()}-u.json`);
        fs.writeFileSync(tmp, JSON.stringify([
            { id: 'a1', category: 'coding', prompt: 'p1', response: 'r1', gold_score: 7 },
            { id: 'a2', category: 'math', prompt: 'p2', response: 'r2', gold_score: 5 }
        ]));

        const chain = {
            limit: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([
                { name: 'courthouse-review-xyz', source: 'courthouse-review',
                  category: 'reasoning', prompt: 'p3', response: 'r3',
                  expert_scores: { overall: 8 } }
            ])
        };
        JudgeGroundTruth.find.mockReturnValue(chain);

        const out = await loadUnionedGoldset({ configPath: tmp });
        expect(out).toHaveLength(3);
        const names = out.map(e => e.name).sort();
        expect(names).toContain('config-goldset-a1');
        expect(names).toContain('courthouse-review-xyz');
        fs.unlinkSync(tmp);
    });

    test('human entry overrides config entry with same name', async () => {
        const tmp = path.join(os.tmpdir(), `goldset-${Date.now()}-o.json`);
        fs.writeFileSync(tmp, JSON.stringify([
            { id: 'dup', category: 'coding', prompt: 'p', response: 'r', gold_score: 3 }
        ]));
        const chain = {
            limit: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([
                { name: 'config-goldset-dup', source: 'courthouse-review',
                  category: 'coding', prompt: 'p', response: 'r',
                  expert_scores: { overall: 9 } }
            ])
        };
        JudgeGroundTruth.find.mockReturnValue(chain);

        const out = await loadUnionedGoldset({ configPath: tmp });
        expect(out).toHaveLength(1);
        expect(out[0].source).toBe('courthouse-review');
        expect(out[0].expert_scores.overall).toBe(9);
        fs.unlinkSync(tmp);
    });

    test('includeConfig=false skips config', async () => {
        const chain = {
            limit: jest.fn().mockReturnThis(),
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([])
        };
        JudgeGroundTruth.find.mockReturnValue(chain);
        const out = await loadUnionedGoldset({ includeConfig: false });
        expect(out).toHaveLength(0);
    });
});

describe('getCoverageStats', () => {
    function qualifiedRows(category, difficulty, count, prefix = `${category}-${difficulty}`) {
        return Array.from({ length: count }, (_, index) => ({
            name: `${prefix}-${index}`,
            category,
            difficulty,
            source_result_id: `${prefix}-source-${index}`,
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent',
            prompt: `${prefix}-prompt-${index}`
        }));
    }

    function mockQualifiedRows(rows) {
        JudgeGroundTruth.find.mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue(rows)
        });
    }

    test('returns coverage matrix with qualified-human totals', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 3, retro_count: 1, seed_count: 2 },
            { _id: { category: 'coding', difficulty: 2 }, count: 6, retro_count: 4, seed_count: 2 }
        ]);
        mockQualifiedRows([
            ...qualifiedRows('coding', 1, 2, 'coding-one'),
            ...qualifiedRows('coding', 2, 2, 'coding-two')
        ]);

        const coverage = await getCoverageStats();

        expect(coverage.total_entries).toBe(4);
        expect(coverage.total_all_entries).toBe(9);
        expect(coverage.total_cells).toBe(35);
        expect(coverage.cells).toHaveLength(2);
        expect(coverage.cells[0].meets_target).toBe(false);
        expect(coverage.cells[1].meets_target).toBe(false);
        expect(coverage.cells[1].meets_target_with_retro).toBe(true);
        expect(coverage.cells[0].all_count).toBe(3);
        expect(coverage.cells[1].all_count).toBe(6);
        expect(coverage.cells[0].count).toBe(2);
        expect(coverage.cells[1].count).toBe(2);
        expect(coverage.human_entries).toBe(4);
        expect(coverage.retro_entries).toBe(5);
        expect(coverage.coverage_percent).toBe(0);
        expect(coverage.by_category).toEqual({ coding: 4 });
        expect(coverage.by_category_human).toEqual({ coding: 4 });
        expect(coverage.by_category_all).toEqual({ coding: 9 });
    });

    test('retro-only inflation does not satisfy coverage target', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 6, retro_count: 6, seed_count: 0 }
        ]);
        mockQualifiedRows([]);

        const coverage = await getCoverageStats();

        expect(coverage.cells[0].count).toBe(0);
        expect(coverage.cells[0].all_count).toBe(6);
        expect(coverage.cells[0].meets_target).toBe(false);
        expect(coverage.cells[0].meets_target_with_retro).toBe(true);
        expect(coverage.total_entries).toBe(0);
        expect(coverage.total_all_entries).toBe(6);
        expect(coverage.human_entries).toBe(0);
        expect(coverage.retro_entries).toBe(6);
        expect(coverage.cells_meeting_target).toBe(0);
        expect(coverage.cells_meeting_target_with_retro).toBe(1);
        expect(coverage.coverage_percent).toBe(0);
    });

    test('mixed qualified and retro rows count only qualified humans toward target', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'math', difficulty: 3 }, count: 6, retro_count: 3, seed_count: 3 }
        ]);
        mockQualifiedRows(qualifiedRows('math', 3, 3));

        const coverage = await getCoverageStats();

        expect(coverage.cells[0].count).toBe(3);
        expect(coverage.cells[0].all_count).toBe(6);
        expect(coverage.cells[0].meets_target).toBe(false);
        expect(coverage.total_entries).toBe(3);
        expect(coverage.total_all_entries).toBe(6);
        expect(coverage.by_category).toEqual({ math: 3 });
        expect(coverage.by_category_all).toEqual({ math: 6 });
    });

    test('qualified-human cell that legitimately meets target', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 5, retro_count: 0, seed_count: 5 }
        ]);
        mockQualifiedRows(qualifiedRows('coding', 1, 5));

        const coverage = await getCoverageStats();

        expect(coverage.cells[0].count).toBe(5);
        expect(coverage.cells[0].all_count).toBe(5);
        expect(coverage.cells[0].meets_target).toBe(true);
        expect(coverage.cells[0].meets_target_with_retro).toBe(true);
        expect(coverage.total_entries).toBe(5);
        expect(coverage.total_all_entries).toBe(5);
        expect(coverage.cells_meeting_target).toBe(1);
        expect(coverage.cells_meeting_target_with_retro).toBe(1);
        expect(coverage.coverage_percent).toBe(Math.round((1 / 35) * 100));
        expect(coverage.by_category).toEqual({ coding: 5 });
    });

    test('counts repeated candidate results for one prompt as one independent prompt', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 5, retro_count: 0, seed_count: 5 }
        ]);
        const repeated = qualifiedRows('coding', 1, 5, 'same-prompt').map(row => ({
            ...row,
            prompt: 'the same prompt'
        }));
        mockQualifiedRows(repeated);

        const coverage = await getCoverageStats();

        expect(coverage.cells[0]).toMatchObject({
            count: 1,
            human: 1,
            meets_target: false
        });
        expect(coverage.total_entries).toBe(1);
        expect(coverage.cells_meeting_target).toBe(0);
    });

    test('fails closed when one prompt is assigned to multiple cells', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 1, retro_count: 0, seed_count: 1 },
            { _id: { category: 'math', difficulty: 2 }, count: 1, retro_count: 0, seed_count: 1 }
        ]);
        const sharedPrompt = 'a prompt shared across cells';
        mockQualifiedRows([
            { ...qualifiedRows('coding', 1, 1, 'coding-cell')[0], prompt: sharedPrompt },
            { ...qualifiedRows('math', 2, 1, 'math-cell')[0], prompt: sharedPrompt }
        ]);

        await expect(getCoverageStats()).rejects.toMatchObject({
            code: 'HUMAN_EVIDENCE_PROMPT_CELL_CONFLICT',
            statusCode: 409
        });
    });

    test('separates human-derived from retro-calibration coverage', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            { _id: { category: 'coding', difficulty: 1 }, count: 8, retro_count: 2, seed_count: 3 },
            { _id: { category: 'math', difficulty: 3 }, count: 5, retro_count: 5, seed_count: 0 }
        ]);
        mockQualifiedRows(qualifiedRows('coding', 1, 6));

        const coverage = await getCoverageStats();

        expect(coverage.human_entries).toBe(6);
        expect(coverage.retro_entries).toBe(7);
        expect(coverage.total_entries).toBe(6);
        expect(coverage.total_all_entries).toBe(13);
        expect(coverage.by_category_human).toEqual({ coding: 6, math: 0 });
        expect(coverage.by_category_all).toEqual({ coding: 8, math: 5 });

        // coding 1: 6 human ≥ 5 → counts both ways.
        // math 3: 5 total but 0 human → only the with-retro view passes.
        expect(coverage.cells_meeting_target).toBe(1);
        expect(coverage.cells_meeting_target_with_retro).toBe(2);
        expect(coverage.coverage_percent).toBe(Math.round((1 / 35) * 100));
        expect(coverage.coverage_percent_with_retro).toBe(Math.round((2 / 35) * 100));

        const mathCell = coverage.cells.find(c => c.category === 'math');
        expect(mathCell.human).toBe(0);
        expect(mathCell.meets_target).toBe(false);
        expect(mathCell.meets_target_with_retro).toBe(true);
    });
});
