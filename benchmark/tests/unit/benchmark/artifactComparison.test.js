const express = require('express');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
const {
    modelFamily,
    compareArmRows,
    compareArtifacts,
    _internal: { armFilter }
} = require('../../../src/services/benchmark/artifactComparison');

const Q8 = 'qwen3.8-synthetic:27b-q8_0';
const Q4 = 'qwen3.8-synthetic:27b-q4_K_M';
const BATCH_A = '64b000000000000000000001';
const BATCH_B = '64b000000000000000000002';

// One row per prompt and repeat. `score(index, repeat)` is on the 0–10 result scale.
function rows(model, { prompts = 20, repeats = 2, score, category = (index) => (index % 2 ? 'coding' : 'agent'),
    judge = 'gemma4-synthetic:e4b', cohort = 'cohort-1', digest = `${model}-digest`, authority = 'judge' } = {}) {
    const out = [];
    for (let index = 0; index < prompts; index++) {
        for (let repeat = 0; repeat < repeats; repeat++) {
            out.push({
                model, host: 'http://synthetic-host:11434', model_digest: digest,
                prompt_id: `prompt-${index}`, prompt_fingerprint: `fp-${index}`, prompt_name: `Prompt ${index}`,
                prompt_category: category(index), quality_score: score(index, repeat), judge_model: judge,
                evaluation_authority: typeof authority === 'function' ? authority(index) : authority,
                quality_cohort_fingerprint: cohort, scorer_version: '3.1.0', repeat_index: repeat
            });
        }
    }
    return out;
}

// Prompt difficulty varies a lot; the artifact effect is small and constant.
const difficulty = (index) => 4 + ((index * 37) % 50) / 10;
const armA = { batch_id: BATCH_A, model: Q8 };
const armB = { batch_id: BATCH_B, model: Q4 };

describe('compareArmRows', () => {
    test('pairs prompts across two tags and recovers a 2-point loss hidden by prompt difficulty', () => {
        const result = compareArmRows(armA, rows(Q8, { score: (index) => difficulty(index) }),
            armB, rows(Q4, { score: (index, repeat) => difficulty(index) - 0.2 + (repeat ? 0.05 : -0.05) }));
        expect(result.pairing).toEqual({ shared: 20, onlyA: 0, onlyB: 0, fingerprintMismatch: [] });
        expect(result.overall.meanDelta).toBe(-2);
        expect(result.overall.significant).toBe(true);
        expect(result.categories.map((category) => category.category)).toEqual(['agent', 'coding']);
        expect(result.a).toMatchObject({ prompts: 20, rows: 40, judgedRows: 40, repeatSpread: 0, promptsWithRepeats: 20 });
        expect(result.b.repeatSpread).toBe(0.7);
        expect(result.judgeIndependence.verdict).toBe('independent');
        expect(result.comparability).toMatchObject({ authoritative: true, sameCohort: true, sameArtifact: false, warnings: [] });
    });

    test('measures run-to-run noise when both arms ran the same artifact', () => {
        const noisy = (seed) => (index) => difficulty(index) + (((index * seed) % 7) - 3) / 10;
        const result = compareArmRows(armA, rows(Q8, { score: noisy(3) }), { ...armA, batch_id: BATCH_B }, rows(Q8, { score: noisy(5) }));
        expect(result.overall.significant).toBe(false);
        expect(result.comparability.sameArtifact).toBe(true);
        expect(result.comparability.warnings.join(' ')).toMatch(/run-to-run noise/);
    });

    test('leaves out a prompt edited between the arms and counts unpaired prompts', () => {
        const edited = rows(Q4, { score: difficulty }).map((row) => (row.prompt_id === 'prompt-0' ? { ...row, prompt_fingerprint: 'fp-edited' } : row));
        const result = compareArmRows(armA, rows(Q8, { score: difficulty, prompts: 22 }), armB, edited);
        expect(result.pairing).toMatchObject({ shared: 19, onlyA: 2, onlyB: 0, fingerprintMismatch: ['Prompt 0'] });
        expect(result.comparability.warnings.join(' ')).toMatch(/changed between the arms/);
    });

    test('marks judged scores non-authoritative when the judge is a contender or of its family', () => {
        const self = compareArmRows(armA, rows(Q8, { score: difficulty, judge: Q8 }), armB, rows(Q4, { score: difficulty, judge: Q8 }));
        expect(self.judgeIndependence).toMatchObject({ verdict: 'self', authoritative: false });
        expect(self.comparability.authoritative).toBe(false);

        const family = compareArmRows(armA, rows(Q8, { score: difficulty, judge: 'qwen3.6-synthetic:35b' }), armB, rows(Q4, { score: difficulty, judge: 'qwen3.6-synthetic:35b' }));
        expect(family.judgeIndependence.verdict).toBe('same_family');
        expect(family.comparability.authoritative).toBe(false);
    });

    test('ignores the judge for results scored by executed tests', () => {
        const executed = { score: difficulty, judge: Q8, authority: 'executable' };
        const result = compareArmRows(armA, rows(Q8, executed), armB, rows(Q4, executed));
        expect(result.judgeIndependence).toMatchObject({ verdict: 'not_applicable', authoritative: true, judgedRows: 0 });
        expect(result.a.unjudgedRows).toBe(40);
    });

    test('flags arms scored in different cohorts', () => {
        const result = compareArmRows(armA, rows(Q8, { score: difficulty }), armB, rows(Q4, { score: difficulty, cohort: 'cohort-2' }));
        expect(result.comparability).toMatchObject({ authoritative: false, sameCohort: false });
    });
});

describe('modelFamily', () => {
    test.each([
        ['qwen3.8:27b-mtp-q8_0', 'qwen'],
        ['hf.co/unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL', 'qwen'],
        ['gemma4:e4b', 'gemma'],
        ['qllama/bge-m3:f16', 'bge']
    ])('%s → %s', (name, family) => expect(modelFamily(name)).toBe(family));
});

describe('compareArtifacts', () => {
    test('loads only scored, valid rows of each arm', () => {
        expect(armFilter({ ...armA, host: 'http://synthetic-host:11434', categories: ['coding'] })).toMatchObject({
            model: Q8, host: 'http://synthetic-host:11434', prompt_category: { $in: ['coding'] },
            success: true, infra_error: { $ne: true }, needs_review: { $ne: true }, quality_score: { $ne: null }
        });
    });

    test('refuses an empty arm', async () => {
        const Model = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
        await expect(compareArtifacts(armA, armB, {}, { Model })).rejects.toMatchObject({ statusCode: 404, code: 'COMPARISON_ARM_EMPTY' });
    });
});

describe('POST /comparison/paired', () => {
    let harness;
    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use(require('../../../routes/benchmark/artifactComparison'));
        harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
    });
    afterAll(async () => { await harness?.close(); });

    test.each([
        [{ a: { batch_id: 'nope', model: Q8 }, b: armB }, /a.batch_id/],
        [{ a: armA, b: { batch_id: BATCH_B } }, /b.model/],
        [{ a: armA, b: armB, categories: ['nonsense'] }, /categories/]
    ])('rejects an invalid request (%#)', async (body, message) => {
        const response = await harness.request.post('/comparison/paired').send(body).expect(400);
        expect(response.body.error).toMatch(message);
    });
});
