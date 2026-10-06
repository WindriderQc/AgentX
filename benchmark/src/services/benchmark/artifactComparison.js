'use strict';

/**
 * Paired comparison of two artifacts, for example one model at Q8 and at Q4.
 *
 * Each arm is one (batch, model, host). Results are paired on the prompt they
 * ran: the catalog prompt id, and only when both rows carry a prompt
 * fingerprint, the same fingerprint (an edited prompt does not pair). The
 * repeats of a prompt are averaged inside an arm, so a prompt counts once.
 * Quality is reported in points (0–100), the leaderboard scale.
 *
 * The regression detector pairs on the same model and host, so two tags or two
 * endpoints never pair there. This comparison pairs across them and states
 * what can make the result non-authoritative: different quality cohorts or
 * scorer versions, or a judge from the contenders' own model family.
 */

const mongoose = require('mongoose');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { assessComparability } = require('./regressionDetector');
const { mean, sampleStdDev, normalizeBootstrapOptions, summarizePairedDeltas } = require('./pairedStatistics');

const MIN_CATEGORY_PAIRS = 2;
const NON_JUDGE_AUTHORITIES = new Set(['deterministic', 'executable']);
const RESULT_FIELDS = [
    'model', 'host', 'model_digest', 'prompt_id', 'prompt_fingerprint', 'prompt_name', 'prompt_category',
    'quality_score', 'judge_model', 'judge_scores.judge_model', 'evaluation_authority', 'scoring_method',
    'quality_cohort_fingerprint', 'scorer_version', 'repeat_index'
].join(' ');

const distinct = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** The model name lowercased, without `:latest`: equal names are one model. */
function baseModelName(name) {
    return String(name || '').trim().toLowerCase().replace(/:latest$/, '');
}

/**
 * The leading alphabetic run of the model's base name: `qwen` for
 * `qwen3.8:27b-mtp-q8_0` and for `hf.co/unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL`.
 * A name-based heuristic, stated as such in the result.
 */
function modelFamily(name) {
    const lastSegment = baseModelName(name).split('/').pop().split(':')[0];
    const match = lastSegment.match(/^[a-z]+/);
    return match ? match[0] : null;
}

function promptKey(row) {
    if (row.prompt_id) return `id:${row.prompt_id}`;
    return row.prompt_name ? `name:${row.prompt_name}` : null;
}

/** Group one arm's rows by prompt; repeats of a prompt are averaged. */
function buildArm(rows) {
    const prompts = new Map();
    const judgedJudges = [];
    let judgedRows = 0;
    let unjudgedRows = 0;
    for (const row of rows) {
        const key = promptKey(row);
        if (!key || !Number.isFinite(row.quality_score)) continue;
        if (!prompts.has(key)) {
            prompts.set(key, { key, name: row.prompt_name || null, category: row.prompt_category || 'uncategorized', fingerprints: new Set(), scores: [] });
        }
        const prompt = prompts.get(key);
        if (row.prompt_fingerprint) prompt.fingerprints.add(row.prompt_fingerprint);
        prompt.scores.push(row.quality_score * 10);
        if (NON_JUDGE_AUTHORITIES.has(row.evaluation_authority)) {
            unjudgedRows += 1;
        } else {
            judgedRows += 1;
            judgedJudges.push(row.judge_model, ...(row.judge_scores || []).map((score) => score?.judge_model));
        }
    }
    const repeatSpreads = [];
    for (const prompt of prompts.values()) {
        prompt.mean = mean(prompt.scores);
        if (prompt.scores.length > 1) repeatSpreads.push(sampleStdDev(prompt.scores));
    }
    return {
        models: distinct(rows.map((row) => row.model)),
        hosts: distinct(rows.map((row) => row.host)),
        digests: distinct(rows.map((row) => row.model_digest)),
        cohorts: distinct(rows.map((row) => row.quality_cohort_fingerprint)),
        scorerVersions: [...new Set(rows.map((row) => row.scorer_version || null))],
        judges: distinct(judgedJudges),
        rows: rows.length,
        judgedRows,
        unjudgedRows,
        prompts,
        // Mean spread of a prompt's score across its repeats: how much a
        // re-run moves one answer under the campaign's frozen seed policy.
        repeatSpread: repeatSpreads.length ? round1(mean(repeatSpreads)) : null,
        promptsWithRepeats: repeatSpreads.length
    };
}

function pairArms(armA, armB) {
    const pairs = [];
    const fingerprintMismatch = [];
    for (const [key, a] of armA.prompts) {
        const b = armB.prompts.get(key);
        if (!b) continue;
        const sameFingerprint = !a.fingerprints.size || !b.fingerprints.size
            || [...a.fingerprints].some((fingerprint) => b.fingerprints.has(fingerprint));
        if (!sameFingerprint) {
            fingerprintMismatch.push(a.name || key);
            continue;
        }
        pairs.push({ key, name: a.name || b.name, category: a.category, a: a.mean, b: b.mean, delta: b.mean - a.mean });
    }
    return {
        pairs,
        onlyA: [...armA.prompts.keys()].filter((key) => !armB.prompts.has(key)).length,
        onlyB: [...armB.prompts.keys()].filter((key) => !armA.prompts.has(key)).length,
        fingerprintMismatch
    };
}

function summarizePairs(pairs, bootstrap) {
    return {
        meanA: round1(mean(pairs.map((pair) => pair.a))),
        meanB: round1(mean(pairs.map((pair) => pair.b))),
        ...summarizePairedDeltas(pairs.map((pair) => pair.delta), bootstrap)
    };
}

/**
 * Whether the judge is independent from both contenders. `self` when a judge
 * is one of the contender models, `same_family` when it shares their family
 * (by name), else `independent`. Rows scored by executed tests or
 * deterministic checks have no judge and do not count.
 */
function assessJudgeIndependence(armA, armB) {
    const contenders = distinct([...armA.models, ...armB.models]);
    const judges = distinct([...armA.judges, ...armB.judges]);
    const rank = { independent: 0, same_family: 1, self: 2 };
    let verdict = 'independent';
    const relations = judges.map((judge) => {
        let relation = 'independent';
        for (const contender of contenders) {
            if (baseModelName(judge) === baseModelName(contender)) relation = 'self';
            else if (relation !== 'self' && modelFamily(judge) && modelFamily(judge) === modelFamily(contender)) relation = 'same_family';
        }
        if (rank[relation] > rank[verdict]) verdict = relation;
        return { judge, family: modelFamily(judge), relation };
    });
    const judgedRows = armA.judgedRows + armB.judgedRows;
    return {
        method: 'model_name_family',
        judgedRows,
        judges: relations,
        verdict: judgedRows ? verdict : 'not_applicable',
        authoritative: !judgedRows || verdict === 'independent'
    };
}

function describeArm(spec, arm) {
    return {
        batchId: spec.batch_id,
        model: spec.model,
        host: spec.host || null,
        hosts: arm.hosts,
        digests: arm.digests,
        rows: arm.rows,
        judgedRows: arm.judgedRows,
        unjudgedRows: arm.unjudgedRows,
        prompts: arm.prompts.size,
        judges: arm.judges,
        repeatSpread: arm.repeatSpread,
        promptsWithRepeats: arm.promptsWithRepeats
    };
}

/**
 * Compare two arms already loaded as result rows. Pure: the route loads the
 * rows; tests pass synthetic ones.
 */
function compareArmRows(specA, rowsA, specB, rowsB, options = {}) {
    const bootstrap = normalizeBootstrapOptions(options.bootstrap);
    const armA = buildArm(rowsA);
    const armB = buildArm(rowsB);
    const { pairs, onlyA, onlyB, fingerprintMismatch } = pairArms(armA, armB);

    const byCategory = new Map();
    for (const pair of pairs) {
        if (!byCategory.has(pair.category)) byCategory.set(pair.category, []);
        byCategory.get(pair.category).push(pair);
    }
    const categories = [...byCategory.entries()]
        .filter(([, categoryPairs]) => categoryPairs.length >= MIN_CATEGORY_PAIRS)
        .map(([category, categoryPairs]) => ({ category, ...summarizePairs(categoryPairs, bootstrap) }))
        .sort((left, right) => left.category.localeCompare(right.category));

    const scorer = assessComparability(armB.scorerVersions, armA.scorerVersions);
    const sameCohort = armA.cohorts.length === 1 && armB.cohorts.length === 1 && armA.cohorts[0] === armB.cohorts[0];
    const sameArtifact = armA.digests.length === 1 && armB.digests.length === 1 && armA.digests[0] === armB.digests[0];
    const judgeIndependence = assessJudgeIndependence(armA, armB);
    const warnings = [...scorer.warnings];
    if (!sameCohort) warnings.push('The arms were not scored in one quality cohort: scorer, judge or generation settings differ, or a cohort is missing.');
    if (fingerprintMismatch.length) warnings.push(`${fingerprintMismatch.length} prompt(s) changed between the arms and were left out.`);
    if (judgeIndependence.verdict === 'self') warnings.push('A judge is one of the compared models: judged scores are not authoritative.');
    if (judgeIndependence.verdict === 'same_family') warnings.push('A judge belongs to the compared models\' family: judged scores may favour it.');
    if (sameArtifact) warnings.push('Both arms ran the same artifact: the difference measures run-to-run noise.');

    return {
        method: 'paired_bootstrap_v1',
        scale: 'points_0_100',
        bootstrap,
        a: describeArm(specA, armA),
        b: describeArm(specB, armB),
        pairing: { shared: pairs.length, onlyA, onlyB, fingerprintMismatch },
        overall: summarizePairs(pairs, bootstrap),
        categories,
        judgeIndependence,
        comparability: {
            authoritative: scorer.comparable && sameCohort && judgeIndependence.authoritative,
            sameCohort,
            sameArtifact,
            scorer,
            warnings
        }
    };
}

function armFilter(spec) {
    return {
        batch_id: new mongoose.Types.ObjectId(spec.batch_id),
        model: spec.model,
        ...(spec.host && { host: spec.host }),
        ...(spec.categories && { prompt_category: { $in: spec.categories } }),
        success: true,
        infra_error: { $ne: true },
        needs_review: { $ne: true },
        excluded_from_leaderboard: { $ne: true },
        quality_score: { $ne: null }
    };
}

async function loadArmRows(spec, Model = BenchmarkResult) {
    return Model.find(armFilter(spec)).select(RESULT_FIELDS).lean();
}

/**
 * @param {{batch_id:string, model:string, host?:string}} a
 * @param {{batch_id:string, model:string, host?:string}} b
 * @param {{categories?:string[], bootstrap?:{iterations?:number, seed?:number}}} options
 */
async function compareArtifacts(a, b, options = {}, { Model } = {}) {
    const categories = options.categories?.length ? options.categories : null;
    const [rowsA, rowsB] = await Promise.all([
        loadArmRows({ ...a, categories }, Model),
        loadArmRows({ ...b, categories }, Model)
    ]);
    for (const [label, rows] of [['a', rowsA], ['b', rowsB]]) {
        if (!rows.length) {
            throw Object.assign(new Error(`Arm ${label} has no scored result for that batch, model and host`),
                { statusCode: 404, code: 'COMPARISON_ARM_EMPTY' });
        }
    }
    return { ...compareArmRows(a, rowsA, b, rowsB, options), ...(categories && { categoryFilter: categories }) };
}

module.exports = {
    MIN_CATEGORY_PAIRS,
    modelFamily,
    buildArm,
    pairArms,
    assessJudgeIndependence,
    compareArmRows,
    compareArtifacts,
    _internal: { armFilter }
};
