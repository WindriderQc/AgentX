const {
    buildComparisonContract,
    collectArmEvidence,
    _internal: { extractControl }
} = require('../../../src/services/benchmark/artifactComparisonContract');

const SPEC_A = { batch_id: '64b000000000000000000001', model: 'synthetic-a:q8' };
const SPEC_B = { batch_id: '64b000000000000000000002', model: 'synthetic-b:q4' };
const HOST_A = 'http://synthetic-host-a:11434';
const HOST_B = 'http://synthetic-host-b:11434';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function executionSettings(overrides = {}) {
    return {
        num_ctx: 8192, num_predict: 2048, temperature: 0.2, top_p: 0.9, top_k: 40,
        repeat_penalty: 1.05, seed: 42, seed_policy: 'fixed', sampling_profile: 'controlled',
        ...overrides
    };
}

function candidate(model, host, digest, overrides = {}) {
    return {
        model, host,
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
        contract: { artifact: { digest, runtimeFingerprint: `runtime-${digest.slice(0, 8)}` } },
        ...overrides
    };
}

function judgeConfig(judgeModel = 'gemma4-synthetic:e4b', overrides = {}) {
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
        },
        ...overrides
    };
}

function batchDoc({ batchId, cohort, model, host, digest, candidates, judges, executionConfig, batchContractFingerprint }) {
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
            candidates: candidates || [candidate(model, host, digest)],
            judges: judges || [judgeConfig()]
        }
    };
}

function rows(model, host, digest, { count = 3, cohort = 'cohort-x', settings = null, scorerVersion = '3.1.0' } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push({
            model, host, model_digest: digest,
            prompt_id: `prompt-${i}`, prompt_fingerprint: `fp-${i}`, prompt_name: `Prompt ${i}`,
            prompt_category: i % 2 ? 'coding' : 'agent', quality_score: 7, judge_model: 'gemma4-synthetic:e4b',
            evaluation_authority: 'judge', quality_cohort_fingerprint: cohort,
            scorer_version: scorerVersion, repeat_index: 0,
            execution_settings: settings || executionSettings(),
            success: true, infra_error: null, needs_review: false, excluded_from_leaderboard: false
        });
    }
    return out;
}

function makeArm({ spec, side, base = {} }) {
    const { model = spec.model, host = side === 'a' ? HOST_A : HOST_B, digest = side === 'a' ? DIGEST_A : DIGEST_B,
        cohort, judges, candidates, executionConfig, settings, scorerVersion, count, batch } = base;
    return {
        spec,
        batch: batch !== undefined ? batch : batchDoc({
            batchId: spec.batch_id, cohort: cohort || `cohort-${side}`, model, host, digest,
            judges, candidates, executionConfig
        }),
        rows: rows(model, host, digest, { settings, scorerVersion, count, cohort: cohort || `cohort-${side}` })
    };
}
const armA = (base = {}) => makeArm({ spec: SPEC_A, side: 'a', base });
const armB = (base = {}) => makeArm({ spec: SPEC_B, side: 'b', base });

describe('buildComparisonContract', () => {
    test('different single-contender batches with the same frozen common contract are compatible', () => {
        const contract = buildComparisonContract(armA(), armB());
        expect(contract.compatible).toBe(true);
        expect(contract.authoritative).toBe(true);
        expect(contract.sameCohort).toBe(false);
        expect(contract.evidence).toBe('frozen_contract');
        // Contender identity is retained, reported as confounds, and does not
        // invalidate the comparison.
        expect(contract.confounds).toEqual(['artifact_digest', 'runtime_fingerprint']);
        expect(contract.provenance.a.candidates).toMatchObject([{ artifactDigest: DIGEST_A, numCtx: 8192, numPredict: 2048 }]);
        expect(contract.provenance.b.candidates).toMatchObject([{ artifactDigest: DIGEST_B }]);
        expect(Object.values(contract.checks).every((check) => check.status === 'match' || check.status === 'absent')).toBe(true);
    });

    test('compatible batches in one saved cohort keep the legacy same-cohort evidence', () => {
        const contract = buildComparisonContract(
            armA({ cohort: 'shared' }),
            armB({ cohort: 'shared' }));
        expect(contract).toMatchObject({
            sameCohort: true, compatible: true, evidence: 'same_quality_cohort', authoritative: true
        });
        expect(contract.reasons).not.toContain('frozen_contract_contradicts_shared_cohort');
    });

    test('an incompatible scorer version is not compatible', () => {
        const contract = buildComparisonContract(
            armA({ scorerVersion: '3.1.0' }),
            armB({ scorerVersion: '4.0.0' }));
        expect(contract.compatible).toBe(false);
        expect(contract.checks.scorer_version.status).toBe('mismatch');
        expect(contract.reasons).toContain('scorer_version_mismatch');
    });

    test('an incompatible judge is not compatible', () => {
        const contract = buildComparisonContract(
            armA({ judges: [judgeConfig('gemma4-synthetic:e4b')] }),
            armB({ judges: [judgeConfig('llama4-synthetic:13b')] }));
        expect(contract.compatible).toBe(false);
        expect(contract.checks.judge_identity.status).toBe('mismatch');
    });

    test('an incompatible judge setting is not compatible', () => {
        const contract = buildComparisonContract(
            armA({ judges: [judgeConfig()] }),
            armB({ judges: [judgeConfig(undefined, { settings: { numCtx: 8192, numPredict: 1024, timeoutMs: 60000, temperature: 0, seed: 7, maxRetries: 2, votingCount: 1, think: false, responseCharBudget: null } })] }));
        expect(contract.compatible).toBe(false);
        expect(contract.checks.judge_settings.status).toBe('mismatch');
    });

    test('different generation controls are not compatible but are explicit non-authoritative confounds', () => {
        const contract = buildComparisonContract(
            armA({ settings: executionSettings({ temperature: 0.2 }) }),
            armB({ settings: executionSettings({ temperature: 0.8 }) }));
        expect(contract.compatible).toBe(false);
        expect(contract.checks.temperature.status).toBe('mismatch');
        expect(contract.confounds).toContain('generation_controls');
        expect(contract.warnings.join(' ')).toMatch(/non-authoritative confound/);
    });

    test('different effective contexts are explicit non-authoritative confounds', () => {
        const contract = buildComparisonContract(
            armA({ settings: executionSettings({ num_ctx: 8192 }), batch: batchDoc({ batchId: SPEC_A.batch_id, cohort: 'cohort-a', model: SPEC_A.model, host: HOST_A, digest: DIGEST_A, candidates: [candidate(SPEC_A.model, HOST_A, DIGEST_A, { execution: { ...candidate(SPEC_A.model, HOST_A, DIGEST_A).execution, num_ctx: 8192 } })]) }),
            armB({ settings: executionSettings({ num_ctx: 4096 }), batch: batchDoc({ batchId: SPEC_B.batch_id, cohort: 'cohort-b', model: SPEC_B.model, host: HOST_B, digest: DIGEST_B, candidates: [candidate(SPEC_B.model, HOST_B, DIGEST_B, { execution: { ...candidate(SPEC_B.model, HOST_B, DIGEST_B).execution, num_ctx: 4096 } })]) }));
        expect(contract.compatible).toBe(false);
        expect(contract.checks.num_ctx.status).toBe('mismatch');
        expect(contract.confounds).toContain('effective_context');
    });

    test('missing judge metadata on judged arms cannot manufacture compatibility', () => {
        // No batch documents: the judge terms are absent on both arms, and the
        // arms carried judged rows — the judge cannot be verified as fair, so
        // the contract stays non-compatible rather than assuming it.
        const bareA = { spec: SPEC_A, batch: null, rows: rows(SPEC_A.model, HOST_A, DIGEST_A) };
        const bareB = { spec: SPEC_B, batch: null, rows: rows(SPEC_B.model, HOST_B, DIGEST_B) };
        const contract = buildComparisonContract(bareA, bareB);
        expect(contract.checks.judge_identity.status).toBe('absent');
        expect(contract.checks.judge_settings.status).toBe('absent');
        expect(contract.checks.temperature.status).toBe('match');
        expect(contract.compatible).toBe(false);
        expect(contract.reasons).toContain('frozen_evidence_missing:judge_identity');
        expect(contract.reasons).toContain('frozen_evidence_missing:judge_settings');
        expect(contract.warnings.join(' ')).toMatch(/No saved judge/);
    });

    test('missing judge metadata on non-judged arms is harmless', () => {
        // Deterministic arms never used a judge: the absent judge terms cannot
        // contradict anything, so the contract is established.
        const bareA = { spec: SPEC_A, batch: null, rows: rows(SPEC_A.model, HOST_A, DIGEST_A, {}).map((row) => ({ ...row, evaluation_authority: 'deterministic', judge_model: null })) };
        const bareB = { spec: SPEC_B, batch: null, rows: rows(SPEC_B.model, HOST_B, DIGEST_B, {}).map((row) => ({ ...row, evaluation_authority: 'deterministic', judge_model: null })) };
        const contract = buildComparisonContract(bareA, bareB);
        expect(contract.checks.judge_identity.status).toBe('absent');
        expect(contract.compatible).toBe(true);
        expect(contract.evidence).toBe('frozen_contract');
        expect(contract.reasons).toEqual([]);
    });

    test('absent on one arm and present on the other is ambiguous, not compatible', () => {
        const withBatch = armA();
        const withoutBatch = { spec: SPEC_B, batch: null, rows: rows(SPEC_B.model, HOST_B, DIGEST_B) };
        const contract = buildComparisonContract(withBatch, withoutBatch);
        expect(contract.checks.judge_identity.status).toBe('ambiguous');
        expect(contract.compatible).toBe(false);
        expect(contract.reasons).toContain('frozen_evidence_missing:judge_identity');
    });

    test('internally mixed frozen evidence is ambiguous', () => {
        const mixed = armA({ settings: executionSettings({ temperature: 0.2 }) });
        mixed.rows[1] = { ...mixed.rows[1], execution_settings: executionSettings({ temperature: 0.9 }) };
        const contract = buildComparisonContract(mixed, armB());
        expect(contract.checks.temperature.status).toBe('ambiguous');
        expect(contract.reasons).toContain('frozen_evidence_mixed:temperature');
        expect(contract.compatible).toBe(false);
    });

    test('a shared cohort never overrides contradictory explicit metadata', () => {
        const contract = buildComparisonContract(
            armA({ cohort: 'shared', scorerVersion: '3.1.0' }),
            armB({ cohort: 'shared', scorerVersion: '4.0.0' }));
        expect(contract.sameCohort).toBe(true);
        expect(contract.compatible).toBe(false);
        expect(contract.evidence).toBe('frozen_contract');
        expect(contract.reasons).toContain('frozen_contract_contradicts_shared_cohort');
    });

    test('collects per-arm provenance without touching live registries', () => {
        const evidence = collectArmEvidence(armA());
        expect(evidence.candidateProvenance).toEqual([{
            model: SPEC_A.model, host: HOST_A, artifactDigest: DIGEST_A,
            runtimeFingerprint: `runtime-${DIGEST_A.slice(0, 8)}`,
            contractFingerprint: `contract-${DIGEST_A.slice(0, 8)}`,
            numCtx: 8192, numPredict: 2048, numPredictSource: 'core_default_reserve'
        }]);
        expect(evidence.judges).toEqual(['gemma4-synthetic:e4b@http://synthetic-judge:11434']);
    });

    test('extractControl prefers a single saved value over nothing and never invents one', () => {
        const batch = batchDoc({ batchId: SPEC_A.batch_id, cohort: 'c', model: SPEC_A.model, host: HOST_A, digest: DIGEST_A });
        expect(extractControl(rows(SPEC_A.model, HOST_A, DIGEST_A), batch, SPEC_A, 'seed')).toBe(42);
        const emptyBatch = { ...batch, inference_contract_campaign: null, execution_config: {} };
        const noSettings = rows(SPEC_A.model, HOST_A, DIGEST_A).map((row) => ({ ...row, execution_settings: null }));
        expect(extractControl(noSettings, emptyBatch, SPEC_A, 'seed')).toBeNull();
    });
});
