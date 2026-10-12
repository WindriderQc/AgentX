const express = require('express');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
const {
    modelFamily,
    compareArmRows,
    compareArtifacts,
    _internal: { armFilter, loadArmBatch }
} = require('../../../src/services/benchmark/artifactComparison');

const Q8 = 'qwen3.8-synthetic:27b-q8_0';
const Q4 = 'qwen3.8-synthetic:27b-q4_K_M';
const HOST_A = 'http://synthetic-host-a:11434';
const HOST_B = 'http://synthetic-host-b:11434';
const BATCH_A = '64b000000000000000000001';
const BATCH_B = '64b000000000000000000002';

// The frozen contract evidence saved on a result row and on the batch.
// Identical across the arms except where a test overrides it.
function executionSettings(overrides = {}) {
    return {
        num_ctx: 8192, num_predict: 2048, temperature: 0.2, top_p: 0.9, top_k: 40,
        repeat_penalty: 1.05, seed: 42, seed_policy: 'fixed', sampling_profile: 'controlled',
        ...overrides
    };
}
function candidateContract(digest, host) {
    return {
        model: null, host,
        artifactDigest: digest,
        contractFingerprint: `contract-${digest.slice(0, 8)}`,
        mode: { name: 'final_only', think: false, sendThink: true, rankable: true },
        execution: {
            num_ctx: 8192,
            num_predict: 2048,
            num_predict_source: 'core_default_reserve',
            sampling: {
                profile: 'controlled', temperature: 0.2, top_p: 0.9, top_k: 40,
                repeat_penalty: 1.05, seed: 42, seed_policy: 'fixed'
            }
        },
        contract: { artifact: { digest, runtimeFingerprint: `runtime-${digest.slice(0, 8)}` } }
    };
}
function judgeConfig(judgeModel = 'gemma4-synthetic:e4b') {
    return {
        model: judgeModel,
        num_ctx: 4096,
        settings: {
            numCtx: 4096, numPredict: 1024, timeoutMs: 60000, temperature: 0,
            seed: 7, maxRetries: 2, votingCount: 1, think: false, responseCharBudget: null
        },
        executionContract: {
            schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 4096,
            artifact: { model: judgeModel, host: 'http://synthetic-judge:11434' }
        },
        qualificationContract: {
            schema: 'agentx.benchmark-judge-qualification-contract/v1',
            artifact: { model: judgeModel, host: 'http://synthetic-judge:11434' }
        }
    };
}
function batchDoc({ batchId, cohort, digest, host, candidates, judges, executionConfig, batchContractFingerprint }) {
    return {
        _id: batchId,
        host,
        quality_cohort_fingerprint: cohort,
        batch_contract_fingerprint: batchContractFingerprint || null,
        execution_config: executionConfig || {},
        inference_contract_campaign: {
            schemaVersion: 1,
            responseMode: 'final_only',
            fixedSettings: {
                sampling_profile: 'controlled', temperature: 0.2, top_p: 0.9, top_k: 40,
                repeat_penalty: 1.05, seed: 42, seed_policy: 'fixed', api_mode: 'chat', repeats: 1
            },
            candidates,
            judges: judges || [judgeConfig()]
        }
    };
}

// One row per prompt and repeat. `score(index, repeat)` is on the 0–10 result scale.
function rows(model, { prompts = 20, repeats = 2, score, category = (index) => (index % 2 ? 'coding' : 'agent'),
    judge = 'gemma4-synthetic:e4b', cohort = 'cohort-1', digest = `${model}-digest`, host = HOST_A,
    authority = 'judge', scorerVersion = '3.1.0', executionSettings: settings = executionSettings() } = {}) {
    const out = [];
    for (let index = 0; index < prompts; index++) {
        for (let repeat = 0; repeat < repeats; repeat++) {
            out.push({
                model, host, model_digest: digest,
                prompt_id: `prompt-${index}`, prompt_fingerprint: `fp-${index}`, prompt_name: `Prompt ${index}`,
                prompt_category: category(index), quality_score: score(index, repeat), judge_model: judge,
                evaluation_authority: typeof authority === 'function' ? authority(index) : authority,
                quality_cohort_fingerprint: cohort, scorer_version: scorerVersion, repeat_index: repeat,
                execution_settings: settings,
                success: true, infra_error: null, needs_review: false, excluded_from_leaderboard: false
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
        expect(result.pairing).toMatchObject({ shared: 20, onlyA: 0, onlyB: 0, fingerprintMismatch: [], ambiguousFingerprints: [], eligibleOnly: true });
        expect(result.overall.meanDelta).toBe(-2);
        expect(result.overall.significant).toBe(true);
        expect(result.categories.map((category) => category.category)).toEqual(['agent', 'coding']);
        expect(result.a).toMatchObject({ prompts: 20, rows: 40, judgedRows: 40, repeatSpread: 0, promptsWithRepeats: 20 });
        expect(result.b.repeatSpread).toBe(0.7);
        expect(result.judgeIndependence.verdict).toBe('independent');
        expect(result.comparability).toMatchObject({ authoritative: true, sameCohort: true, sameArtifact: false });
        // The only warning names the expected confound, retained as provenance.
        expect(result.comparability.warnings).toHaveLength(1);
        expect(result.comparability.warnings[0]).toMatch(/different artifact digests/);
        expect(result.contract.confounds).toEqual(['artifact_digest']);
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
        expect(result.pairing).toMatchObject({ shared: 19, onlyA: 2, onlyB: 0, fingerprintMismatch: ['Prompt 0'], ambiguousFingerprints: [] });
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

    test('switches to the explicit frozen contract when the arms carry different saved cohorts', () => {
        const result = compareArmRows(armA, rows(Q8, { score: difficulty }), armB, rows(Q4, { score: difficulty, cohort: 'cohort-2' }));
        expect(result.comparability).toMatchObject({ authoritative: true, sameCohort: false, evidence: 'frozen_contract' });
        expect(result.contract.compatible).toBe(true);
    });
});

describe('coverage', () => {
    test('reports unequal review exclusions and overlapping reasons without pretending a partition', () => {
        const a = rows(Q8, { score: difficulty, prompts: 6 });
        // prompt-0: one repeat fails hard, one is infra-error (overlaps: also
        // its score is null); prompt-1: both repeats need review; prompt-2: one
        // repeat is leaderboard-excluded.
        a[0] = { ...a[0], success: false, quality_score: null, infra_error: true };
        a[1] = { ...a[1], needs_review: true, quality_score: 7 };
        a[2] = { ...a[2], needs_review: true, quality_score: 8 };
        a[4] = { ...a[4], excluded_from_leaderboard: true, quality_score: 6 };

        const result = compareArmRows(armA, a, armB, rows(Q4, { score: difficulty, prompts: 6 }));
        expect(result.coverage.a).toMatchObject({
            originalRows: 12, originalPrompts: 6, includedRows: 8, includedPrompts: 5,
            excludedRows: 4, excludedPrompts: 1, partialPrompts: 2
        });
        // prompt-0 row 0 carries both flags at once.
        expect(result.coverage.a.reasons).toMatchObject({
            failed_or_infra_error: 1, needs_review: 2, excluded_from_leaderboard: 1,
            missing_prompt_identity: 0, missing_or_non_finite_score: 0
        });
        // Denominator conservation: every loaded row is either included or excluded,
        // and no prompt disappears.
        expect(result.coverage.a.includedRows + result.coverage.a.excludedRows).toBe(result.coverage.a.originalRows);
        expect(result.coverage.a.includedPrompts + result.coverage.a.excludedPrompts).toBe(result.coverage.a.originalPrompts);
        // The 4 excluded rows carry 4 flags in total here (no overlap), and
        // every per-reason count counts rows, never more than the excluded set.
        expect(Object.values(result.coverage.a.reasons).reduce((sum, count) => sum + count, 0)).toBe(result.coverage.a.excludedRows);
        expect(result.coverage.b.includedRows).toBe(12);
        // The statistics still describe only the eligible pairs.
        expect(result.a.prompts).toBe(5);
        expect(result.pairing.eligibleOnly).toBe(true);
        expect(result.pairing.note).toMatch(/does not establish equivalence/);
    });

    test('keeps a zero score eligible but excludes missing, pending and review-needed scores', () => {
        const a = rows(Q8, { score: difficulty, prompts: 4, repeats: 1 });
        a[0] = { ...a[0], quality_score: 0 };          // a valid 0 is a score
        a[1] = { ...a[1], quality_score: null, scoring_method: 'pending' }; // provisional, never a 0
        a[2] = { ...a[2], quality_score: null, needs_review: true };
        const b = rows(Q4, { score: difficulty, prompts: 4, repeats: 1 });
        const result = compareArmRows(armA, a, armB, b);
        expect(result.coverage.a.includedRows).toBe(2); // the 0-score row and prompt-3
        expect(result.coverage.a.reasons).toMatchObject({
            missing_or_non_finite_score: 1, needs_review: 1, failed_or_infra_error: 0
        });
        // The zero row paired and counts as 0 points, not as missing:
        // arm A mean over {0, difficulty(3)*10 = 51} while B keeps all four.
        expect(result.overall.meanA).toBe(25.5);
        expect(result.overall.n).toBe(2);
        expect(result.pairing.shared).toBe(2);
    });

    test('a nonempty all-excluded arm gets explicit coverage, null means and zero pairs, not a 404', () => {
        const a = rows(Q8, { score: difficulty, prompts: 5, repeats: 2 }).map((row) => ({ ...row, excluded_from_leaderboard: true }));
        const result = compareArmRows(armA, a, armB, rows(Q4, { score: difficulty, prompts: 5 }));
        expect(result.coverage.a).toMatchObject({ originalRows: 10, includedRows: 0, includedPrompts: 0, excludedRows: 10, excludedPrompts: 5 });
        expect(result.pairing).toMatchObject({ shared: 0, onlyA: 0, onlyB: 5 });
        expect(result.overall).toMatchObject({ meanA: null, meanB: null, n: 0, significant: false, bootstrapInterval: null, tInterval: null });
        expect(result.categories).toEqual([]);
        expect(result.a.prompts).toBe(0);
        expect(result.a.rows).toBe(0);
        expect(result.comparability.authoritative).toBe(true); // no statistic was invented to contradict itself
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
    test('loads every row of the arm, before eligibility, with the same selection boundaries', () => {
        expect(armFilter({ ...armA, host: HOST_A, categories: ['coding'] })).toEqual({
            batch_id: expect.any(Object), model: Q8, host: HOST_A, prompt_category: { $in: ['coding'] }
        });
    });

    function modelWithRows(rowsA, rowsB) {
        return {
            find: (filter) => ({
                select: () => ({ lean: async () => (filter.model === Q8 ? rowsA : rowsB) })
            })
        };
    }
    function batchModelWithDocs(docA, docB) {
        return {
            findById: (id) => ({
                select: () => ({ lean: async () => (String(id) === BATCH_A ? docA : docB) })
            })
        };
    }

    test('refuses an arm with no rows at all (404)', async () => {
        const Model = { find: () => ({ select: () => ({ lean: async () => [] }) }) };
        await expect(compareArtifacts(armA, armB, {}, { Model })).rejects.toMatchObject({ statusCode: 404, code: 'COMPARISON_ARM_EMPTY' });
    });

    test('excludes an all-excluded arm neither as 404 nor as fabricated statistics', async () => {
        const rowsA = rows(Q8, { score: difficulty, prompts: 4, repeats: 2 }).map((row) => ({ ...row, needs_review: true }));
        const Model = modelWithRows(rowsA, rows(Q4, { score: difficulty, prompts: 4, repeats: 2 }));
        const data = await compareArtifacts(armA, armB, {}, { Model });
        expect(data.coverage.a).toMatchObject({ originalRows: 8, includedRows: 0, excludedRows: 8, excludedPrompts: 4 });
        expect(data.overall.n).toBe(0);
        expect(data.overall.meanA).toBeNull();
        expect(data.overall.bootstrapInterval).toBeNull();
    });

    test('establishes the frozen contract from saved batch and result metadata', async () => {
        const Model = modelWithRows(rows(Q8, { score: difficulty, prompts: 4, repeats: 2 }), rows(Q4, { score: difficulty, prompts: 4, repeats: 2 }));
        const BatchModel = batchModelWithDocs(
            batchDoc({
                batchId: BATCH_A, cohort: 'cohort-a', digest: 'digest-a', host: HOST_A,
                candidates: [candidateContract('digest-a', HOST_A)]
            }),
            batchDoc({
                batchId: BATCH_B, cohort: 'cohort-b', digest: 'digest-b', host: HOST_B,
                candidates: [candidateContract('digest-b', HOST_B)]
            }));
        const data = await compareArtifacts(armA, armB, {}, { Model, BatchModel });
        expect(data.contract.evidence).toBe('frozen_contract');
        expect(data.contract.compatible).toBe(true);
        expect(data.contract.confounds).toEqual(['artifact_digest', 'runtime_fingerprint']);
        expect(data.comparability).toMatchObject({ authoritative: true, sameCohort: false, evidence: 'frozen_contract' });
        expect(data.contract.provenance.a.candidates).toMatchObject([{ artifactDigest: 'digest-a', numCtx: 8192, numPredict: 2048 }]);
        expect(data.contract.provenance.b.qualityCohortFingerprint).toBe('cohort-b');
    });

    test('keeps the legacy same-cohort comparison when the saved cohorts agree', async () => {
        const rowsA = rows(Q8, { score: difficulty, prompts: 4, repeats: 2, cohort: 'shared-cohort', digest: 'digest-a', host: HOST_A });
        const rowsB = rows(Q4, { score: difficulty, prompts: 4, repeats: 2, cohort: 'shared-cohort', digest: 'digest-b', host: HOST_B });
        const Model = modelWithRows(rowsA, rowsB);
        const BatchModel = batchModelWithDocs(
            batchDoc({ batchId: BATCH_A, cohort: 'shared-cohort', digest: 'digest-a', host: HOST_A, candidates: [candidateContract('digest-a', HOST_A)] }),
            batchDoc({ batchId: BATCH_B, cohort: 'shared-cohort', digest: 'digest-b', host: HOST_B, candidates: [candidateContract('digest-b', HOST_B)] }));
        const data = await compareArtifacts(armA, armB, {}, { Model, BatchModel });
        expect(data.contract).toMatchObject({ evidence: 'same_quality_cohort', sameCohort: true, compatible: true });
        expect(data.comparability).toMatchObject({ authoritative: true, sameCohort: true, evidence: 'same_quality_cohort' });
    });

    test('loads the batch document read-only', async () => {
        const seen = [];
        const BatchModel = {
            findById: (id) => {
                seen.push(String(id));
                return { select: (fields) => { seen.push(fields); return { lean: async () => null }; } };
            }
        };
        await compareArtifacts(armA, armB, {}, { Model: modelWithRows(rows(Q8, { score: difficulty, prompts: 2, repeats: 1 }), rows(Q4, { score: difficulty, prompts: 2, repeats: 1 })), BatchModel });
        expect(seen).toContain(BATCH_A);
        expect(seen).toContain(BATCH_B);
        expect(loadArmBatch({ batch_id: BATCH_A }, null)).resolves.toBeNull();
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
