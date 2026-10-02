'use strict';

/**
 * Grader qualification for exact judge identities.
 *
 * `POST /judge/calibrate-accuracy` measures one judge (model on one host)
 * under the running scorer version against the reference set. This module
 * records that outcome and answers, for any judged evidence, whether its
 * grader is qualified:
 *
 * - qualified: the newest record for that judge, scorer version and the
 *   current reference set passes every criterion;
 * - unqualified: the newest record fails a criterion, or it was measured on
 *   another reference set;
 * - unknown: no record for that exact identity, or no scorer version;
 * - a judged grade that does not record its judge is unqualified (fail closed).
 *
 * A qualification is never inferred from readiness, a default selection, a
 * judge's completion rate or an older scorer version. Only `qualified` lets a
 * judged ranking be authoritative; the raw scores stay readable either way.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const JudgeQualification = require('../../../models/JudgeQualification');
const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { QUALIFICATION_CRITERIA, qualificationFailures } = require('./judgeCalibration');

const QUALIFICATION_SCHEMA = 'agentx.benchmark-grader-qualification/v1';
const GRADER_STATUS = Object.freeze({
    QUALIFIED: 'qualified',
    UNQUALIFIED: 'unqualified',
    UNKNOWN: 'unknown',
    NOT_APPLICABLE: 'not_applicable'
});

function modelKey(model) {
    return String(model || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function hostKey(host) {
    return hostUrlKey(host) || null;
}

function referenceSetFingerprint(set) {
    return crypto.createHash('sha256').update(JSON.stringify(set)).digest('hex');
}

function loadReferenceSet() {
    return require('../../../data/judge-calibration-set.json');
}

function currentReferenceFingerprint() {
    return referenceSetFingerprint(loadReferenceSet());
}

/**
 * The `calibrate-accuracy` response body. Kept here so the route stays a
 * transport and the persisted record reads the same fields.
 */
function buildAccuracyCalibrationReport({ host, model, numCtx = null, summary, results, calibrationSet }) {
    const failed = qualificationFailures(summary);
    return {
        host,
        model,
        valid: failed.length === 0,
        qualification: { criteria: QUALIFICATION_CRITERIA, failed },
        requested_num_ctx: numCtx ?? null,
        correlation: summary.correlation,
        mae: summary.mae,
        bias: summary.bias,
        agreement_rate: summary.agreement_rate,
        total: summary.total,
        scored: summary.scored,
        failed: summary.total - summary.scored,
        identity: summary.identity,
        keying_bias: summary.keying_bias,
        ordering: summary.ordering,
        attention: summary.attention,
        comparison_kind: 'scoring_pipeline_reference_agreement',
        reference_source: 'authored_calibration_set',
        reference_fingerprint: referenceSetFingerprint(calibrationSet),
        scorer_version: SCORER_VERSION,
        scoring_methods: summary.scoring_methods,
        tier_breakdown: summary.tier_breakdown,
        results
    };
}

function summarizeRecord(record) {
    if (!record) return null;
    return {
        id: record._id ? String(record._id) : null,
        recorded_at: record.recorded_at ? new Date(record.recorded_at).toISOString() : null,
        judge_model: record.judge_model,
        judge_host: record.judge_host,
        judge_digest: record.judge_digest || null,
        scorer_version: record.scorer_version,
        reference_source: record.reference_source || null,
        reference_fingerprint: record.reference_fingerprint,
        reference_count: record.reference_count || 0,
        requested_num_ctx: record.requested_num_ctx ?? null,
        qualified: record.qualified === true,
        failed: [...(record.failed || [])],
        metrics: record.metrics || null
    };
}

/**
 * Persist one calibration report. The judge digest is provenance only: result
 * rows do not record the judge artifact, so readers match on model and host.
 */
async function recordAccuracyCalibration(report, { digest = null } = {}) {
    // Fail fast instead of buffering the write until the driver times out.
    if (mongoose.connection.readyState !== 1) throw new Error('database unavailable; qualification not recorded');
    const record = await JudgeQualification.create({
        judge_model: report.model,
        judge_host: report.host,
        judge_model_key: modelKey(report.model),
        judge_host_key: hostKey(report.host) || String(report.host || ''),
        judge_digest: digest || null,
        scorer_version: report.scorer_version,
        reference_source: report.reference_source,
        reference_fingerprint: report.reference_fingerprint,
        reference_count: report.total || 0,
        requested_num_ctx: report.requested_num_ctx ?? null,
        qualified: report.valid === true,
        failed: report.qualification?.failed || [],
        criteria: report.qualification?.criteria || null,
        metrics: {
            mae: report.mae ?? null,
            correlation: report.correlation ?? null,
            agreement_rate: report.agreement_rate ?? null,
            ordering_ties_half: report.ordering?.accuracy_ties_half ?? null,
            identity: report.identity || null,
            attention: report.attention || null,
            scored: report.scored ?? null,
            total: report.total ?? null
        },
        cases: (report.results || []).map(item => ({
            id: item.id ?? null,
            category: item.category ?? null,
            tier: item.tier ?? null,
            gold_score: item.gold_score ?? null,
            judge_score: item.judge_score ?? null,
            abs_diff: item.abs_diff ?? null,
            identity_case: item.identity_case ?? null,
            identity_full_marks: item.identity_full_marks ?? null,
            attention_passed: typeof item.attention_check?.passed === 'boolean' ? item.attention_check.passed : null,
            error: item.error ?? null
        }))
    });
    return summarizeRecord(record.toObject());
}

/**
 * Whether one judge identity is qualified under `scorerVersion`.
 * `records` are this identity's records, any scorer version, newest first.
 */
function assessJudge({ host, model, scorerVersion, records = [], referenceFingerprint }) {
    const judge = { model: model || null, host: host || null };
    if (!model || !host) {
        // Fail closed: a grade whose judge is not recorded cannot be checked.
        return { ...judge, status: GRADER_STATUS.UNQUALIFIED, causes: ['judge_identity_missing'], record: null };
    }
    if (!scorerVersion) {
        return { ...judge, status: GRADER_STATUS.UNKNOWN, causes: ['scorer_version_missing'], record: null };
    }
    const sameVersion = records.filter(record => record.scorer_version === scorerVersion);
    // An incomplete run (a call failed, timed out or was cancelled) says
    // nothing about grading quality: it neither qualifies nor withdraws.
    const latest = sameVersion.find(record => !(record.failed || []).includes('incomplete')) || null;
    if (!latest && sameVersion.length) {
        return {
            ...judge,
            status: GRADER_STATUS.UNKNOWN,
            causes: ['calibration_incomplete'],
            record: summarizeRecord(sameVersion[0])
        };
    }
    if (!latest) {
        const causes = records.length ? ['calibration_for_other_scorer_version'] : ['no_calibration_record'];
        return {
            ...judge,
            status: GRADER_STATUS.UNKNOWN,
            causes,
            record: null,
            other_versions: [...new Set(records.map(record => record.scorer_version))]
        };
    }
    const causes = [];
    if (latest.qualified !== true) {
        const failed = latest.failed?.length ? latest.failed : ['unspecified'];
        for (const criterion of failed) causes.push(`calibration_failed_${criterion}`);
    }
    if (referenceFingerprint && latest.reference_fingerprint !== referenceFingerprint) {
        causes.push('calibration_reference_set_changed');
    }
    return {
        ...judge,
        status: causes.length ? GRADER_STATUS.UNQUALIFIED : GRADER_STATUS.QUALIFIED,
        causes,
        record: summarizeRecord(latest)
    };
}

/**
 * Combine the judges behind one piece of evidence. Every judge must be
 * qualified for the evidence to be authoritative.
 */
function combineJudges(judges, { scorerVersion = null, scorerCauses = [] } = {}) {
    const causes = [...new Set([...scorerCauses, ...judges.flatMap(judge => judge.causes)])];
    let status = GRADER_STATUS.QUALIFIED;
    if (!judges.length || scorerCauses.length) status = GRADER_STATUS.UNKNOWN;
    else if (judges.some(judge => judge.status === GRADER_STATUS.UNQUALIFIED)) status = GRADER_STATUS.UNQUALIFIED;
    else if (judges.some(judge => judge.status !== GRADER_STATUS.QUALIFIED)) status = GRADER_STATUS.UNKNOWN;
    if (!judges.length && !causes.length) causes.push('judge_identity_missing');
    return {
        schema: QUALIFICATION_SCHEMA,
        status,
        authoritative: status === GRADER_STATUS.QUALIFIED,
        scorer_version: scorerVersion,
        causes,
        judges
    };
}

function notApplicable(reason) {
    return {
        schema: QUALIFICATION_SCHEMA,
        status: GRADER_STATUS.NOT_APPLICABLE,
        authoritative: true,
        scorer_version: null,
        causes: [],
        reason,
        judges: []
    };
}

/** Records per judge identity (any scorer version), newest first. */
async function loadRecordsFor(identities) {
    const pairs = new Map();
    for (const { host, model } of identities) {
        const hKey = hostKey(host);
        const mKey = modelKey(model);
        if (hKey && mKey) pairs.set(`${hKey}@@${mKey}`, { judge_host_key: hKey, judge_model_key: mKey });
    }
    const byIdentity = new Map();
    if (!pairs.size) return byIdentity;
    const records = await JudgeQualification.find({ $or: [...pairs.values()] }, { cases: 0 })
        .sort({ recorded_at: -1, _id: -1 })
        .lean();
    for (const record of records) {
        const key = `${record.judge_host_key}@@${record.judge_model_key}`;
        if (!byIdentity.has(key)) byIdentity.set(key, []);
        byIdentity.get(key).push(record);
    }
    return byIdentity;
}

function recordsFor(byIdentity, host, model) {
    return byIdentity.get(`${hostKey(host)}@@${modelKey(model)}`) || [];
}

function versionsOf(scorerVersions) {
    const versions = Object.keys(scorerVersions || {}).filter(version => version && version !== 'unversioned');
    const causes = [];
    if (!versions.length) causes.push('scorer_version_missing');
    else if (versions.length > 1) causes.push('mixed_scorer_versions');
    if (versions.length && Object.prototype.hasOwnProperty.call(scorerVersions, 'unversioned')) {
        causes.push('scorer_version_missing');
    }
    return { version: versions.length === 1 ? versions[0] : null, causes: [...new Set(causes)] };
}

/**
 * Grader qualification for leaderboard rows (`judgeTargets`, `scorerVersions`).
 * Returns one assessment per row, in order.
 */
async function assessLeaderboardRows(rows, { axis = 'composite' } = {}) {
    if (axis === 'deterministic') return rows.map(() => notApplicable('deterministic_axis'));
    const identities = rows.flatMap(row => row.judgeTargets || []);
    const [byIdentity, referenceFingerprint] = await Promise.all([
        loadRecordsFor(identities),
        Promise.resolve(currentReferenceFingerprint())
    ]);
    return rows.map(row => {
        // No judged row at all: the grade is deterministic, no judge to qualify.
        if (row.judgedRows === 0) return notApplicable('no_judged_rows');
        const { version, causes: scorerCauses } = versionsOf(row.scorerVersions);
        const targets = (row.judgeTargets || []).filter(target => target && (target.model || target.host));
        const judges = targets.map(target => assessJudge({
            host: target.host,
            model: target.model,
            scorerVersion: version,
            records: recordsFor(byIdentity, target.host, target.model),
            referenceFingerprint
        }));
        // Judged rows without a complete judge identity make the whole row
        // unqualified: part of its score comes from a grader nobody can check.
        if (Number(row.judgeIdentityMissingRows) > 0) {
            judges.push({
                model: null, host: null, status: GRADER_STATUS.UNQUALIFIED,
                causes: ['judge_identity_missing'], record: null,
                rows: Number(row.judgeIdentityMissingRows)
            });
        }
        return combineJudges(judges, { scorerVersion: version, scorerCauses });
    });
}

/** Grader qualification for one stored result. */
async function assessResult(result = {}, { judgeUsed = true } = {}) {
    if (!judgeUsed) return notApplicable('no_llm_judge');
    const byIdentity = await loadRecordsFor([{ host: result.judge_host, model: result.judge_model }]);
    const judge = assessJudge({
        host: result.judge_host,
        model: result.judge_model,
        scorerVersion: result.scorer_version || null,
        records: recordsFor(byIdentity, result.judge_host, result.judge_model),
        referenceFingerprint: currentReferenceFingerprint()
    });
    return combineJudges([judge], { scorerVersion: result.scorer_version || null });
}

/**
 * The newest record of every judge identity and scorer version, plus the
 * scorer version and reference set that currently qualify evidence.
 */
async function listQualifications({ limit = 50 } = {}) {
    const records = await JudgeQualification.find({}, { cases: 0 })
        .sort({ recorded_at: -1, _id: -1 })
        .limit(500)
        .lean();
    const referenceFingerprint = currentReferenceFingerprint();
    const groups = new Map();
    for (const record of records) {
        const key = `${record.judge_host_key}@@${record.judge_model_key}@@${record.scorer_version}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    const latest = [...groups.values()].slice(0, limit).map(group => {
        const assessment = group[0].scorer_version === SCORER_VERSION
            ? assessJudge({
                host: group[0].judge_host,
                model: group[0].judge_model,
                scorerVersion: SCORER_VERSION,
                records: group,
                referenceFingerprint
            })
            : { status: GRADER_STATUS.UNKNOWN, causes: ['calibration_for_other_scorer_version'] };
        return { ...summarizeRecord(group[0]), current: { status: assessment.status, causes: assessment.causes, decisive_record_id: assessment.record?.id || null } };
    });
    return {
        schema: QUALIFICATION_SCHEMA,
        scorer_version: SCORER_VERSION,
        reference_fingerprint: referenceFingerprint,
        criteria: QUALIFICATION_CRITERIA,
        records: latest
    };
}

/** Full record, per-case grades included. */
async function getQualificationRecord(id) {
    const record = await JudgeQualification.findById(id).lean();
    if (!record) return null;
    return { ...summarizeRecord(record), cases: record.cases || [] };
}

module.exports = {
    GRADER_STATUS,
    QUALIFICATION_SCHEMA,
    assessJudge,
    assessLeaderboardRows,
    assessResult,
    buildAccuracyCalibrationReport,
    combineJudges,
    currentReferenceFingerprint,
    getQualificationRecord,
    listQualifications,
    loadReferenceSet,
    notApplicable,
    recordAccuracyCalibration,
    referenceSetFingerprint,
    summarizeRecord,
    versionsOf
};
