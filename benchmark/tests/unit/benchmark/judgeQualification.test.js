'use strict';

const mongoose = require('mongoose');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const JudgeQualification = require('../../../models/JudgeQualification');
const { SCORER_VERSION } = require('../../../src/services/scoring/scorerVersion');
const {
    assessJudge,
    assessJudgeCategories,
    assessLeaderboardRows,
    assessResult,
    buildAccuracyCalibrationReport,
    currentReferenceFingerprint,
    getQualificationRecord,
    listQualifications,
    recordAccuracyCalibration,
    versionsOf
} = require('../../../src/services/benchmark/judgeQualification');

const { buildJudgeQualificationContract } = require('../../../src/services/benchmark/judgeQualificationContract');

const JUDGE = { host: 'http://judge-a:11434', model: 'qwen3.8:27b-mtp-q8_0' };

function judgeConfig(judge = JUDGE, overrides = {}) {
    return { host: judge.host, model: judge.model, num_ctx: 65536, num_predict: 800,
        timeout: 60000, think: false, temperature: 0.1, seed: 7, voting_count: 1, max_retries: 2,
        execution_contract: { schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
            artifact: { model: judge.model, host: judge.host, digest: 'sha256:abc', runtimeFingerprint: 'runtime-a' } },
        ...overrides };
}
function target(judge = JUDGE, overrides = {}) {
    return { host: judge.host, model: judge.model, qualification_contract: buildJudgeQualificationContract(judgeConfig(judge, overrides)) };
}
JUDGE.qualification_contract = target().qualification_contract;

function summary(overrides = {}) {
    return {
        total: 20, scored: 20, mae: 0.79, bias: 0, correlation: 0.97, agreement_rate: 85,
        ordering: { accuracy_ties_half: 89.4 },
        identity: { total: 3, full_marks: 3, failed: [] },
        attention: { passed: 18, failed: 0, unknown: 0 },
        scoring_methods: { decomposed: 20 }, tier_breakdown: {}, keying_bias: null,
        ...overrides
    };
}

function report(overrides = {}, judge = JUDGE) {
    const set = require('../../../data/judge-calibration-set.json');
    return { judge_config: judgeConfig(judge), ...buildAccuracyCalibrationReport({
        host: judge.host, model: judge.model, numCtx: 65536, summary: summary(overrides),
        results: [{ id: 'cal-good-05', gold_score: 10, judge_score: 10, abs_diff: 0, identity_case: true,
            identity_full_marks: true, attention_check: { passed: true } }],
        calibrationSet: set
    }) };
}

let mongoServer;

test('a diagnostic cannot replace qualification even if its selected cases all pass', async () => {
    const initial = await recordAccuracyCalibration(report());
    await expect(recordAccuracyCalibration({ ...report(), diagnostic: true })).rejects.toThrow('cannot publish qualification');
    expect(await JudgeQualification.countDocuments()).toBe(1);
    const saved = await getQualificationRecord(initial.id);
    expect(saved.qualified).toBe(true);
});

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await JudgeQualification.deleteMany({});
});

describe('judge qualification records', () => {
    test('the report states the criteria it failed and the exact identity it measured', () => {
        const failing = report({ ordering: { accuracy_ties_half: 76 }, mae: 1.6 });
        expect(failing).toMatchObject({
            valid: false,
            qualification: { failed: ['ordering', 'mae'] },
            scorer_version: SCORER_VERSION,
            reference_fingerprint: currentReferenceFingerprint(),
            requested_num_ctx: 65536
        });
        expect(report().valid).toBe(true);
    });

    test('a passing record qualifies the exact judge, host and scorer version only', async () => {
        const config = judgeConfig();
        const saved = await recordAccuracyCalibration({ ...report(), judge_config: config }, { digest: 'sha256:abc' });
        expect((await getQualificationRecord(saved.id)).judge_config).toEqual(config);
        expect(saved).toMatchObject({ qualified: true, judge_digest: 'sha256:abc', scorer_version: SCORER_VERSION });

        const [same, otherHost, otherModel] = await assessLeaderboardRows([
            { judgeTargets: [{ ...target(), model: JUDGE.model.toUpperCase(), host: 'http://JUDGE-A:11434/' }], scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [target({ model: JUDGE.model, host: 'http://judge-b:11434' })], scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [target({ model: 'gemma4:e4b', host: JUDGE.host })], scorerVersions: { [SCORER_VERSION]: 12 } }
        ]);
        expect(same).toMatchObject({ status: 'qualified', authoritative: true, causes: [] });
        expect(same.judges[0].record).toMatchObject({ id: saved.id, reference_fingerprint: currentReferenceFingerprint() });
        expect(otherHost).toMatchObject({ status: 'unknown', authoritative: false, causes: ['no_calibration_record'] });
        expect(otherModel).toMatchObject({ status: 'unknown', causes: ['no_calibration_record'] });
    });

    test('an older scorer version, a failed or stale record never qualifies', async () => {
        await recordAccuracyCalibration(report());
        const [otherVersion] = await assessLeaderboardRows([
            { judgeTargets: [JUDGE], scorerVersions: { '2.16.0': 4 } }
        ]);
        expect(otherVersion).toMatchObject({ status: 'unknown', causes: ['calibration_for_other_scorer_version'] });

        // A newer failing run withdraws the qualification.
        await new Promise(resolve => setTimeout(resolve, 5));
        await recordAccuracyCalibration(report({ identity: { total: 3, full_marks: 2, failed: ['cal-good-05'] } }));
        const [withdrawn] = await assessLeaderboardRows([{ judgeTargets: [JUDGE], scorerVersions: { [SCORER_VERSION]: 4 } }]);
        expect(withdrawn).toMatchObject({ status: 'unqualified', authoritative: false, causes: ['calibration_failed_identity'] });

        const stale = assessJudge({
            ...JUDGE, scorerVersion: SCORER_VERSION, referenceFingerprint: 'b'.repeat(64),
            records: [{ ...JUDGE, judge_model: JUDGE.model, judge_host: JUDGE.host, scorer_version: SCORER_VERSION,
                reference_fingerprint: 'c'.repeat(64), qualified: true, failed: [], qualification_contract: JUDGE.qualification_contract }]
        });
        expect(stale).toMatchObject({ status: 'unqualified', causes: ['calibration_reference_set_changed'] });
    });

    test('an incomplete run neither qualifies nor withdraws', async () => {
        await recordAccuracyCalibration(report());
        await new Promise(resolve => setTimeout(resolve, 5));
        await recordAccuracyCalibration(report({ scored: 12 }));
        const [row] = await assessLeaderboardRows([{ judgeTargets: [JUDGE], scorerVersions: { [SCORER_VERSION]: 4 } }]);
        expect(row.status).toBe('qualified');

        await JudgeQualification.deleteMany({});
        await recordAccuracyCalibration(report({ scored: 12 }));
        const [onlyIncomplete] = await assessLeaderboardRows([{ judgeTargets: [JUDGE], scorerVersions: { [SCORER_VERSION]: 4 } }]);
        expect(onlyIncomplete).toMatchObject({ status: 'unknown', causes: ['calibration_incomplete'] });
    });

    test('rows without a judge, a scorer version or with several judges are assessed strictly', async () => {
        await recordAccuracyCalibration(report());
        const [noJudge, noVersion, mixed, deterministic] = [
            ...(await assessLeaderboardRows([
                { judgeTargets: [], scorerVersions: { [SCORER_VERSION]: 3 } },
                { judgeTargets: [JUDGE], scorerVersions: { unversioned: 3 } },
                { judgeTargets: [JUDGE, target({ model: 'gemma4:e4b', host: JUDGE.host })], scorerVersions: { [SCORER_VERSION]: 3 } }
            ])),
            ...(await assessLeaderboardRows([{ judgeTargets: [] }], { axis: 'deterministic' }))
        ];
        expect(noJudge).toMatchObject({ status: 'unknown', causes: ['judge_identity_missing'] });
        expect(noVersion).toMatchObject({ status: 'unknown', causes: ['scorer_version_missing'] });
        expect(mixed).toMatchObject({ status: 'unknown', authoritative: false, causes: ['no_calibration_record'] });
        expect(deterministic).toMatchObject({ status: 'not_applicable', authoritative: true });
        expect(versionsOf({ '2.17.0': 1, '2.16.0': 1 }).causes).toEqual(['mixed_scorer_versions']);
    });

    test('judged results without a recorded judge make an otherwise qualified row unqualified', async () => {
        await recordAccuracyCalibration(report());
        const [partial, complete, deterministicOnly] = await assessLeaderboardRows([
            // The aggregation drops the incomplete identity from judgeTargets; its count remains.
            { judgeTargets: [JUDGE], judgedRows: 12, judgeIdentityMissingRows: 2, scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [JUDGE], judgedRows: 12, judgeIdentityMissingRows: 0, scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [], judgedRows: 0, judgeIdentityMissingRows: 0, scorerVersions: { [SCORER_VERSION]: 5 } }
        ]);
        expect(partial).toMatchObject({ status: 'unqualified', authoritative: false, causes: ['judge_identity_missing'] });
        expect(partial.judges).toEqual(expect.arrayContaining([
            expect.objectContaining({ status: 'qualified' }),
            expect.objectContaining({ model: null, host: null, status: 'unqualified', causes: ['judge_identity_missing'], rows: 2 })
        ]));
        expect(complete).toMatchObject({ status: 'qualified', authoritative: true });
        expect(deterministicOnly).toMatchObject({ status: 'not_applicable', authoritative: true, reason: 'no_judged_rows' });

        const single = await assessResult({ judge_model: JUDGE.model, judge_host: null, scorer_version: SCORER_VERSION });
        expect(single).toMatchObject({ status: 'unqualified', authoritative: false, causes: ['judge_identity_missing'] });
    });

    test('a stored result is assessed on its own judge and scorer version', async () => {
        await recordAccuracyCalibration(report());
        const qualified = await assessResult({ judge_model: JUDGE.model, judge_host: JUDGE.host, judge_qualification_contract: JUDGE.qualification_contract, scorer_version: SCORER_VERSION });
        expect(qualified.status).toBe('qualified');
        const notUsed = await assessResult({}, { judgeUsed: false });
        expect(notUsed.status).toBe('not_applicable');
    });

    test('the listing keeps the newest record per identity with its current status and cases on demand', async () => {
        const first = await recordAccuracyCalibration(report());
        await new Promise(resolve => setTimeout(resolve, 5));
        await recordAccuracyCalibration(report({ scored: 3 }));
        const listing = await listQualifications();
        expect(listing).toMatchObject({ scorer_version: SCORER_VERSION, reference_fingerprint: currentReferenceFingerprint() });
        expect(listing.records).toHaveLength(1);
        expect(listing.records[0]).toMatchObject({
            failed: ['incomplete'],
            current: { status: 'qualified', causes: [], decisive_record_id: first.id }
        });
        const full = await getQualificationRecord(first.id);
        expect(full.cases[0]).toMatchObject({ id: 'cal-good-05', attention_passed: true, identity_full_marks: true });
    });
});

describe('judge validation per prompt category (#397)', () => {
    const results = [
        { id: 'c1', category: 'math', gold_score: 10, judge_score: 9, abs_diff: 1 },
        { id: 'c2', category: 'math', gold_score: 2, judge_score: 3, abs_diff: 1 },
        { id: 'c3', category: 'creative', gold_score: 5, judge_score: 8, abs_diff: 3 },
        { id: 'c4', category: 'reasoning', gold_score: 10, judge_score: 10, abs_diff: 0, identity_case: true, identity_full_marks: true,
            attention_check: { passed: false } },
    ];
    const calibration = (overrides = {}) => {
        const set = require('../../../data/judge-calibration-set.json');
        return { ...buildAccuracyCalibrationReport({ host: JUDGE.host, model: JUDGE.model, summary: summary(overrides), results, calibrationSet: set }), judge_config: judgeConfig() };
    };

    test('a qualified judge is validated where its calibration cases agree, and named where they do not', async () => {
        await recordAccuracyCalibration(calibration());
        const categories = await assessJudgeCategories(JUDGE, ['math', 'creative', 'reasoning', 'translation']);
        expect(categories.math).toMatchObject({ status: 'validated', cases: 2, mae: 1, causes: [] });
        expect(categories.creative).toMatchObject({ status: 'failed', cases: 1, mae: 3, causes: ['category_mae_above_1.5'] });
        expect(categories.reasoning).toMatchObject({ status: 'failed', causes: ['attention_failed'] });
        expect(categories.translation).toMatchObject({ status: 'no_reference_cases', cases: 0 });
    });

    test('a judge without a qualifying calibration is unvalidated everywhere', async () => {
        expect(await assessJudgeCategories(JUDGE, ['math'])).toEqual({
            math: { status: 'unvalidated', cases: 0, mae: null, causes: ['no_calibration_record'] }
        });
        await recordAccuracyCalibration(calibration({ mae: 2 }));
        const { math } = await assessJudgeCategories(JUDGE, ['math']);
        expect(math).toMatchObject({ status: 'unvalidated', causes: ['calibration_failed_mae'] });
    });
});

describe('qualification belongs to the recorded execution contract', () => {
    const result = config => ({ judge_host: config.host, judge_model: config.model,
        judge_qualification_contract: buildJudgeQualificationContract(config), scorer_version: SCORER_VERSION });

    const variants = [
        ['digest', config => { config.execution_contract.artifact.digest = 'other-digest'; }],
        ['registration identity', config => { config.execution_contract.artifact.hostId = 'registration-b'; }],
        ['runtime', config => { config.execution_contract.artifact.runtimeFingerprint = 'runtime-b'; }],
        ['context', config => { config.num_ctx = config.execution_contract.num_ctx = 32768; }],
        ['output budget', config => { config.num_predict = 1600; }],
        ['timeout', config => { config.timeout = 120000; }],
        ['thinking', config => { config.think = true; }],
        ['temperature', config => { config.temperature = 0.2; }],
        ['seed', config => { config.seed = 0; }],
        ['unseeded', config => { config.seed = null; }],
        ['votes', config => { config.voting_count = 3; }],
        ['retries', config => { config.max_retries = 1; }],
        ['response coverage', config => { config.response_char_budget = 4000; }]
    ];
    test.each(variants)('changing %s prevents reuse and another contract failure cannot withdraw qualification', async (_name, change) => {
        await recordAccuracyCalibration(report());
        const different = judgeConfig(); change(different);
        expect(await assessResult(result(different))).toMatchObject({ status: 'unknown', causes: ['no_calibration_for_contract'] });
        await recordAccuracyCalibration({ ...report({ mae: 3 }), judge_config: different });
        expect(await assessResult(result(different))).toMatchObject({ status: 'unqualified', causes: ['calibration_failed_mae'] });
        expect(await assessResult(result(judgeConfig()))).toMatchObject({ status: 'qualified' });
        expect((await listQualifications()).records).toHaveLength(2);
    });

    test('old records and verdicts stay unknown even when the batch or saved config has current settings', async () => {
        const legacy = await recordAccuracyCalibration(report());
        await JudgeQualification.updateOne({ _id: legacy.id }, { $unset: { qualification_contract: 1, qualification_contract_fingerprint: 1 } });
        expect(await assessResult(result(judgeConfig()))).toMatchObject({ status: 'unknown', causes: ['no_calibration_for_contract'] });
        await recordAccuracyCalibration(report());
        const old = { judge_host: JUDGE.host, judge_model: JUDGE.model, scorer_version: SCORER_VERSION,
            judge_config: judgeConfig(), judge_execution_contract: judgeConfig().execution_contract };
        expect(await assessResult(old)).toMatchObject({ status: 'unknown', causes: ['judge_contract_missing'] });
        const missingSeed = result(judgeConfig()); delete missingSeed.judge_qualification_contract.settings.seed;
        expect(await assessResult(missingSeed)).toMatchObject({ status: 'unknown', causes: ['judge_contract_missing'] });
        const listing = await listQualifications();
        expect(listing.records.find(row => !row.qualification_contract).current.status).toBe('unknown');
    });

    test('category validation uses the same contract as results and the board', async () => {
        await recordAccuracyCalibration(report());
        const changed = target(JUDGE, { think: true });
        const categories = await assessJudgeCategories(changed, ['math']);
        expect(categories.math).toMatchObject({ status: 'unvalidated', causes: ['no_calibration_for_contract'] });
        const [row] = await assessLeaderboardRows([{ judgeTargets: [JUDGE, changed], judgedRows: 2,
            scorerVersions: { [SCORER_VERSION]: 2 } }]);
        expect(row).toMatchObject({ authoritative: false, status: 'unknown' });
    });

    test('every secondary and tiebreaker is checked against its own saved contract', async () => {
        const second = { host: 'http://judge-b:11434', model: 'second:latest' };
        const tie = { host: 'http://judge-c:11434', model: 'tie:latest' };
        await recordAccuracyCalibration(report());
        await recordAccuracyCalibration(report({}, second));
        const combined = { ...result(judgeConfig()), judge_escalated: true, judge_tiebreaker_used: true,
            judge_scores: [second, tie].map(judge => ({ judge_host: judge.host, judge_model: judge.model,
                qualification_contract: target(judge).qualification_contract })) };
        expect(await assessResult(combined)).toMatchObject({ status: 'unknown', authoritative: false });
        await recordAccuracyCalibration(report({}, tie));
        expect(await assessResult(combined)).toMatchObject({ status: 'qualified', authoritative: true });
        const policy = { enabled: true, judges: [judgeConfig(), judgeConfig(second)], tiebreaker: judgeConfig(tie) };
        const policyResult = { ...combined, judge_qualification_contract: buildJudgeQualificationContract(judgeConfig(), { escalation: policy }),
            judge_scores: [second, tie].map(judge => ({ judge_host: judge.host, judge_model: judge.model,
                qualification_contract: buildJudgeQualificationContract(judgeConfig(judge), { escalation: policy }) })) };
        expect(await assessResult(policyResult)).toMatchObject({ status: 'unknown', authoritative: false, causes: ['no_calibration_for_contract'] });
        combined.judge_scores[0].qualification_contract.settings.numPredict = 1600;
        expect(await assessResult(combined)).toMatchObject({ status: 'unknown', authoritative: false });
        delete combined.judge_scores[0].qualification_contract;
        expect((await assessResult(combined)).causes).toContain('judge_contract_missing');
        combined.judge_scores = [];
        expect((await assessResult(combined)).authoritative).toBe(false);
    });

    test('a partial replay preserves untouched contracts and clears old consensus on the replayed row', async () => {
        const BenchmarkResult = require('../../../models/BenchmarkResult');
        const { applyScoresToResult } = require('../../../src/services/benchmark/judgeExecutor');
        const batchId = new mongoose.Types.ObjectId();
        const ids = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
        const first = judgeConfig();
        const changed = judgeConfig(JUDGE, { seed: null, num_predict: 1600 });
        await BenchmarkResult.collection.insertMany(ids.map(_id => ({ _id, batch_id: batchId,
            ...result(first), judge_scores: [{ judge_model: 'old-secondary', judge_host: 'http://old:11434' }],
            judge_escalated: true, quality_score: 7 })));
        try {
            await applyScoresToResult(String(ids[0]), { quality_score: 8, scoring_method: 'decomposed' },
                { prompt_category: 'knowledge', latency: 100, tokens_per_sec: 20 }, changed);
            const stored = await BenchmarkResult.find({ batch_id: batchId }).sort({ _id: 1 }).lean();
            const replayed = stored.find(row => String(row._id) === String(ids[0]));
            const untouched = stored.find(row => String(row._id) === String(ids[1]));
            expect(replayed.judge_qualification_contract).toEqual(buildJudgeQualificationContract(changed));
            expect(replayed.judge_scores).toEqual([]);
            expect(replayed.judge_escalated).toBe(false);
            expect(untouched.judge_qualification_contract).toEqual(buildJudgeQualificationContract(first));
            expect(untouched.quality_score).toBe(7);
            const { getLeaderboardEntryStats } = require('../../../src/services/benchmark/generalistScoreAggregation');
            const stats = await getLeaderboardEntryStats({ batch_id: batchId });
            const row = [...stats.values()][0];
            expect(row.judgeTargets.some(judge => judge.model === 'old-secondary')).toBe(true);
            expect(row.judgeTargets.some(judge => judge.qualification_contract?.settings.seed === null)).toBe(true);
        } finally { await BenchmarkResult.collection.deleteMany({ batch_id: batchId }); }
    });
});
