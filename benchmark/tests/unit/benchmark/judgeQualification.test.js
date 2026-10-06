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

const JUDGE = { host: 'http://judge-a:11434', model: 'qwen3.8:27b-mtp-q8_0' };

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
    return buildAccuracyCalibrationReport({
        host: judge.host, model: judge.model, numCtx: 65536, summary: summary(overrides),
        results: [{ id: 'cal-good-05', gold_score: 10, judge_score: 10, abs_diff: 0, identity_case: true,
            identity_full_marks: true, attention_check: { passed: true } }],
        calibrationSet: set
    });
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
        const judgeConfig = { ...JUDGE, num_ctx: 65536, num_predict: 800, think: false,
            execution_contract: { num_ctx: 65536, artifact: { digest: 'sha256:abc' } } };
        const saved = await recordAccuracyCalibration({ ...report(), judge_config: judgeConfig }, { digest: 'sha256:abc' });
        expect((await getQualificationRecord(saved.id)).judge_config).toEqual(judgeConfig);
        expect(saved).toMatchObject({ qualified: true, judge_digest: 'sha256:abc', scorer_version: SCORER_VERSION });

        const [same, otherHost, otherModel] = await assessLeaderboardRows([
            { judgeTargets: [{ model: JUDGE.model.toUpperCase(), host: 'http://JUDGE-A:11434/' }], scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [{ model: JUDGE.model, host: 'http://judge-b:11434' }], scorerVersions: { [SCORER_VERSION]: 12 } },
            { judgeTargets: [{ model: 'gemma4:e4b', host: JUDGE.host }], scorerVersions: { [SCORER_VERSION]: 12 } }
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
                reference_fingerprint: 'c'.repeat(64), qualified: true, failed: [] }]
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
                { judgeTargets: [JUDGE, { model: 'gemma4:e4b', host: JUDGE.host }], scorerVersions: { [SCORER_VERSION]: 3 } }
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
        const qualified = await assessResult({ judge_model: JUDGE.model, judge_host: JUDGE.host, scorer_version: SCORER_VERSION });
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
        // Settled without the judge: they neither validate nor fail it.
        { id: 'c5', category: 'math', gold_score: 10, judge_score: 10, abs_diff: 0, scoring_method: 'quick' },
        { id: 'c6', category: 'knowledge', gold_score: 0, judge_score: 6, abs_diff: 6, scoring_method: 'deterministic' },
    ];
    const calibration = (overrides = {}) => {
        const set = require('../../../data/judge-calibration-set.json');
        return buildAccuracyCalibrationReport({ host: JUDGE.host, model: JUDGE.model, summary: summary(overrides), results, calibrationSet: set });
    };

    test('a qualified judge is validated where its calibration cases agree, and named where they do not', async () => {
        await recordAccuracyCalibration(calibration());
        const categories = await assessJudgeCategories(JUDGE, ['math', 'creative', 'reasoning', 'translation']);
        expect(categories.math).toMatchObject({ status: 'validated', cases: 2, settled: 1, mae: 1, causes: [] });
        expect(categories.creative).toMatchObject({ status: 'failed', cases: 1, mae: 3, causes: ['category_mae_above_1.5'] });
        expect(categories.reasoning).toMatchObject({ status: 'failed', causes: ['attention_failed'] });
        expect(categories.translation).toMatchObject({ status: 'no_reference_cases', cases: 0 });
    });

    test('a category whose cases were all settled without the judge has no judged case', async () => {
        await recordAccuracyCalibration(calibration());
        const { knowledge } = await assessJudgeCategories(JUDGE, ['knowledge']);
        expect(knowledge).toMatchObject({ status: 'no_reference_cases', cases: 0, settled: 1, mae: null });
        const record = await getQualificationRecord((await listQualifications()).records[0].id);
        expect(record.cases.find(item => item.id === 'c5')).toMatchObject({ scoring_method: 'quick' });
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
