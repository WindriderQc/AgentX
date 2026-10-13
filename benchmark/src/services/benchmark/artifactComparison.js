'use strict';

/**
 * Paired comparison of two artifacts, for example one model at Q8 and at Q4.
 *
 * Each arm is one (batch, model, host, optional category). Every result row of
 * the arm is loaded first; only the eligible rows (successful, reviewed,
 * leaderboard-admitted, finite score, usable prompt identity) enter the paired
 * statistics, and the coverage block reports what was left out and why. The
 * statistics then describe the eligible paired subset, nothing more.
 *
 * Results are paired on the prompt they ran: the catalog prompt id, and only
 * when both rows carry a prompt fingerprint, the same fingerprint (an edited
 * prompt does not pair). The repeats of a prompt are averaged inside an arm,
 * so a prompt counts once. Quality is reported in points (0–100), the
 * leaderboard scale.
 *
 * Two batches with different contender cohorts may still be comparable: the
 * comparison contract (artifactComparisonContract.js) is established from
 * saved batch/result metadata only — frozen scorer version, judge identity and
 * settings, controlled generation, budget, sampling, seed and thinking — and
 * differs from the legacy same-cohort evidence, which keeps working when the
 * arms' saved quality cohort fingerprints agree.
 *
 * The regression detector pairs on the same model and host, so two tags or two
 * endpoints never pair there. This comparison pairs across them and states
 * what can make the result non-authoritative: a contract that cannot be
 * established from saved evidence, or a judge from the contenders' own model
 * family.
 */

const mongoose = require('mongoose');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { assessComparability } = require('./regressionDetector');
const { mean, sampleStdDev, normalizeBootstrapOptions, summarizePairedDeltas } = require('./pairedStatistics');
const { coverageForArm } = require('./artifactComparisonCoverage');
const { buildComparisonContract } = require('./artifactComparisonContract');

const MIN_CATEGORY_PAIRS = 2;
const NON_JUDGE_AUTHORITIES = new Set(['deterministic', 'executable']);
const RESULT_FIELDS = [
    'model', 'host', 'model_digest', 'prompt', 'prompt_id', 'prompt_fingerprint', 'prompt_name', 'prompt_category',
    'quality_score', 'judge_model', 'judge_host', 'judge_scores', 'evaluation_authority',
    'judge_escalated', 'judge_consensus', 'judge_divergence', 'judge_tiebreaker_used',
    'success', 'infra_error', 'needs_review', 'excluded_from_leaderboard',
    'scoring_method', 'quality_cohort_fingerprint', 'scorer_version', 'repeat_index', 'execution_settings',
    'judge_execution_contract', 'judge_qualification_contract'
].join(' ');
const BATCH_FIELDS = [
    'quality_cohort_fingerprint', 'batch_contract_fingerprint', 'host',
    'execution_config', 'inference_contract_campaign', 'judge_config'
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

/**
 * Group one arm's eligible rows by prompt; repeats of a prompt are averaged.
 * Rows are already eligibility-filtered; the coverage of the full row set is
 * reported separately by artifactComparisonCoverage.
 */
function buildArm(rows) {
    const prompts = new Map();
    const judgedJudges = [];
    let judgedRows = 0;
    let unjudgedRows = 0;
    for (const row of rows) {
        const key = row.prompt_id ? `id:${row.prompt_id}` : (row.prompt_name ? `name:${row.prompt_name}` : null);
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
        // Mixed fingerprints on the repeats of one prompt: the arm blended
        // prompt versions here, so the prompt cannot join an authoritative pair.
        prompt.ambiguous = prompt.fingerprints.size > 1;
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
    const ambiguousFingerprints = [];
    for (const [key, a] of armA.prompts) {
        const b = armB.prompts.get(key);
        if (!b) continue;
        if (a.ambiguous || b.ambiguous) {
            ambiguousFingerprints.push(a.name || key);
            continue;
        }
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
        fingerprintMismatch,
        ambiguousFingerprints
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
 * rows; tests pass synthetic ones. `options.batches` may carry the saved
 * BenchmarkBatch documents of both arms, which feed the comparison contract
 * together with the rows.
 */
function compareArmRows(specA, rowsA, specB, rowsB, options = {}) {
    const bootstrap = normalizeBootstrapOptions(options.bootstrap);
    const coverageA = coverageForArm(rowsA);
    const coverageB = coverageForArm(rowsB);
    const armA = buildArm(coverageA.eligibleRows);
    const armB = buildArm(coverageB.eligibleRows);
    const { pairs, onlyA, onlyB, fingerprintMismatch, ambiguousFingerprints } = pairArms(armA, armB);

    const byCategory = new Map();
    for (const pair of pairs) {
        if (!byCategory.has(pair.category)) byCategory.set(pair.category, []);
        byCategory.get(pair.category).push(pair);
    }
    const categories = [...byCategory.entries()]
        .filter(([, categoryPairs]) => categoryPairs.length >= MIN_CATEGORY_PAIRS)
        .map(([category, categoryPairs]) => ({ category, ...summarizePairs(categoryPairs, bootstrap) }))
        .sort((left, right) => left.category.localeCompare(right.category));

    const scorer = assessComparability([...new Set(rowsB.map(row => row.scorer_version || null))],
        [...new Set(rowsA.map(row => row.scorer_version || null))]);
    const sameArtifact = armA.digests.length === 1 && armB.digests.length === 1 && armA.digests[0] === armB.digests[0];
    const judgeIndependence = assessJudgeIndependence(armA, armB);
    // The contract reads every saved row, eligible or not: its judge and
    // generation evidence is independent of score eligibility.
    const contract = buildComparisonContract(
        { spec: specA, batch: options.batches?.a || null, rows: rowsA },
        { spec: specB, batch: options.batches?.b || null, rows: rowsB });

    const warnings = [...scorer.warnings, ...contract.warnings];
    if (fingerprintMismatch.length) warnings.push(`${fingerprintMismatch.length} prompt(s) changed between the arms and were left out.`);
    if (ambiguousFingerprints.length) warnings.push(`${ambiguousFingerprints.length} prompt(s) carry mixed fingerprints and were left out.`);
    if (judgeIndependence.verdict === 'self') warnings.push('A judge is one of the compared models: judged scores are not authoritative.');
    if (judgeIndependence.verdict === 'same_family') warnings.push('A judge belongs to the compared models\' family: judged scores may favour it.');
    if (sameArtifact) warnings.push('Both arms ran the same artifact: the difference measures run-to-run noise.');

    return {
        method: 'paired_bootstrap_v1',
        scale: 'points_0_100',
        bootstrap,
        a: describeArm(specA, armA),
        b: describeArm(specB, armB),
        coverage: {
            a: describeCoverage(coverageA),
            b: describeCoverage(coverageB),
            note: 'Reasons are overlapping flags, not a partition: one row can carry several, so per-reason counts may sum above the excluded rows.'
        },
        pairing: {
            shared: pairs.length,
            onlyA,
            onlyB,
            fingerprintMismatch,
            ambiguousFingerprints,
            eligibleOnly: true,
            note: 'Statistics describe the eligible paired subset only: a non-significant result on this subset does not establish equivalence of the original campaigns.'
        },
        overall: summarizePairs(pairs, bootstrap),
        categories,
        judgeIndependence,
        contract,
        comparability: {
            authoritative: scorer.comparable && contract.authoritative && judgeIndependence.authoritative,
            sameCohort: contract.sameCohort,
            evidence: contract.evidence,
            sameArtifact,
            scorer,
            contract: {
                compatible: contract.compatible,
                established: contract.established,
                reasons: contract.reasons,
                confounds: contract.confounds
            },
            warnings
        }
    };
}

function describeCoverage(coverage) {
    return {
        originalRows: coverage.originalRows,
        originalPrompts: coverage.originalPrompts,
        includedRows: coverage.includedRows,
        includedPrompts: coverage.includedPrompts,
        excludedRows: coverage.excludedRows,
        excludedPrompts: coverage.excludedPrompts,
        partialPrompts: coverage.partialPrompts,
        reasons: coverage.reasons
    };
}

/**
 * Every result row of the arm, eligibility included: failed, infra-error,
 * review, leaderboard-excluded, unscored and identity-less rows stay in the
 * denominator. Arm selection (batch, model, host, category) is untouched.
 */
function armFilter(spec) {
    return {
        batch_id: new mongoose.Types.ObjectId(spec.batch_id),
        model: spec.model,
        ...(spec.host && { host: spec.host }),
        ...(spec.categories && { prompt_category: { $in: spec.categories } })
    };
}

async function loadArmRows(spec, Model = BenchmarkResult) {
    return Model.find(armFilter(spec)).select(RESULT_FIELDS).lean();
}

async function loadArmBatch(spec, Batch = BenchmarkBatch) {
    const query = Batch?.findById?.(spec.batch_id);
    if (!query || typeof query.select !== 'function') return null;
    return query.select(BATCH_FIELDS).lean();
}

/**
 * @param {{batch_id:string, model:string, host?:string}} a
 * @param {{batch_id:string, model:string, host?:string}} b
 * @param {{categories?:string[], bootstrap?:{iterations?:number, seed?:number}}} options
 */
async function compareArtifacts(a, b, options = {}, { Model, BatchModel = BenchmarkBatch } = {}) {
    const categories = options.categories?.length ? options.categories : null;
    // The saved batch documents enrich the contract with the frozen campaign
    // evidence; the row evidence alone is the fallback. The default batch
    // model is only queried on a live connection, so an isolated comparison
    // (tests) still works without one.
    const batchEnabled = (BatchModel !== BenchmarkBatch || mongoose.connection.readyState === 1);
    const [rowsA, rowsB, batchA, batchB] = await Promise.all([
        loadArmRows({ ...a, categories }, Model),
        loadArmRows({ ...b, categories }, Model),
        batchEnabled ? loadArmBatch(a, BatchModel) : Promise.resolve(null),
        batchEnabled ? loadArmBatch(b, BatchModel) : Promise.resolve(null)
    ]);
    for (const [label, rows] of [['a', rowsA], ['b', rowsB]]) {
        if (!rows.length) {
            throw Object.assign(new Error(`Arm ${label} has no scored result for that batch, model and host`),
                { statusCode: 404, code: 'COMPARISON_ARM_EMPTY' });
        }
    }
    return {
        ...compareArmRows(a, rowsA, b, rowsB, { ...options, batches: { a: batchA, b: batchB } }),
        ...(categories && { categoryFilter: categories })
    };
}

module.exports = {
    MIN_CATEGORY_PAIRS,
    modelFamily,
    buildArm,
    pairArms,
    assessJudgeIndependence,
    compareArmRows,
    compareArtifacts,
    _internal: { armFilter, loadArmBatch }
};
