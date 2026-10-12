'use strict';

/**
 * The comparison-specific frozen contract of a paired artifact comparison (#569).
 *
 * Two batches with different candidate models, artifacts, hosts or runtimes
 * may still be comparable even when their immutable `quality_cohort_fingerprint`
 * differs: the contender set is part of that fingerprint by construction. The
 * terms that actually make two measurements comparable are the frozen common
 * ones — scorer version, judge identity/execution/qualification/settings,
 * controlled generation, budget, sampling, seed and thinking settings — plus
 * the prompt fingerprints that pairing itself enforces.
 *
 * This module establishes that contract from saved metadata ONLY: the batch
 * document (execution config, frozen inference contract campaign, judge
 * config, cohort fingerprint) and what the result rows themselves carry
 * (scorer version, judge provenance, execution settings, cohort fingerprint).
 * It never resolves live defaults, looks up live hosts, models or prompts,
 * invokes a model, or rewrites a historical cohort. A value that was never
 * saved is absent; a term that is internally mixed on one arm, or saved on one
 * arm and absent on the other, is ambiguous. Neither absence nor ambiguity is
 * treated as a verified match, so they never manufacture compatibility.
 *
 * Two kinds of evidence, clearly distinguished in the result:
 *  - `same_quality_cohort`: both arms' saved cohort fingerprints agree. That
 *    shared cohort is the comparison evidence, as before — it already froze the
 *    scorer, judge and generation terms, so no per-term re-verification is
 *    demanded. It is never allowed to override contradictory explicit
 *    metadata: when a frozen term disagrees, the contradiction is reported and
 *    the comparison falls back to the explicit frozen contract (and is not
 *    authoritative).
 *  - `frozen_contract`: the arms are different cohorts (or no shared cohort).
 *    Compatibility is decided term by term from the frozen evidence above.
 *
 * Contender identity differences alone (digest, host/runtime fingerprint) are
 * expected between artifacts: they are retained as provenance on both arms and
 * reported as non-authoritative confounds, never as a reason to refuse
 * pairing. Differing effective contexts or generation controls are likewise
 * explicit non-authoritative confounds.
 */

const SCORER_TERMS = Object.freeze(['scorer_version']);
const JUDGE_TERMS = Object.freeze([
    'judge_identity', 'judge_num_ctx', 'judge_execution_contract',
    'judge_qualification_contract', 'judge_settings', 'judge_multi_judge'
]);
// Judge terms whose absence we cannot tolerate when the arms actually carried
 // judged rows: the judge is the authority for those scores, so a missing
 // judge contract cannot be assumed fair. `judge_multi_judge` is deliberately
 // excluded — its absence just means no multi-judge escalation.
const REQUIRED_JUDGE_TERMS = new Set(JUDGE_TERMS.filter((term) => term !== 'judge_multi_judge'));
const CONTEXT_TERMS = Object.freeze(['num_ctx']);
const BUDGET_TERMS = Object.freeze(['num_predict']);
const CONTROL_TERMS = Object.freeze([
    'temperature', 'top_p', 'top_k', 'repeat_penalty', 'seed', 'seed_policy',
    'sampling_profile', 'api_mode', 'response_mode', 'response_budget_rule', 'think'
]);
const GENERATION_TERMS = Object.freeze([...CONTEXT_TERMS, ...BUDGET_TERMS, ...CONTROL_TERMS]);
// Non-authoritative confounds: these differ between artifacts by definition or
 // break equivalence, but they do not by themselves hide the pairing.
const CONFOUND_BY_TERM = Object.freeze({
    num_ctx: 'effective_context',
    num_predict: 'token_budget',
    temperature: 'generation_controls',
    top_p: 'generation_controls',
    top_k: 'generation_controls',
    repeat_penalty: 'generation_controls',
    seed: 'generation_controls',
    seed_policy: 'generation_controls',
    sampling_profile: 'generation_controls',
    api_mode: 'generation_controls',
    response_mode: 'generation_controls',
    response_budget_rule: 'generation_controls',
    think: 'generation_controls'
});
const { judgeCohortSettings, multiJudgeCohortSettings } = require('../../../../shared/benchmarkTargetContract');

const NON_JUDGE_AUTHORITIES = new Set(['deterministic', 'executable']);
const MIXED = Symbol('mixed');

const distinct = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
const hostOf = (value) => String(value || '').replace(/\/+$/, '').toLowerCase();
const identityOf = (model, host) => (model ? `${String(model).trim().toLowerCase()}@${hostOf(host)}` : null);

function normalizeScalar(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        const trimmed = value.trim().toLowerCase();
        return trimmed === '' ? null : trimmed;
    }
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'boolean') return value;
    return null;
}

/**
 * One scalar control from several evidence sources. A single shared value
 * wins; nothing saved resolves to null (absent); sources that disagree are
 * ambiguous (`MIXED`) instead of being averaged or overwritten.
 */
function resolveControl(sources) {
    const values = sources.map(normalizeScalar).filter((value) => value !== null);
    const unique = distinct(values);
    if (unique.length > 1) return MIXED;
    return unique.length === 1 ? unique[0] : null;
}

function stableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

/**
 * A whole-object control (judge execution/qualification settings, multi-judge
 * policy). All saved copies must agree, else `MIXED`; none saved is absent.
 */
function resolveObjectControl(sources) {
    const values = sources
        .filter((value) => value !== null && value !== undefined)
        .map(stableJson);
    const unique = distinct(values);
    if (unique.length > 1) return MIXED;
    return unique.length === 1 ? unique[0] : null;
}

function getPath(value, path) {
    return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), value);
}

/** The campaign candidates of one arm, matched to the requested model/host. */
function armCandidates(batch, spec) {
    const campaign = batch?.inference_contract_campaign;
    const candidates = Array.isArray(campaign?.candidates) ? campaign.candidates : [];
    if (!candidates.length) return [];
    const requestedModel = String(spec.model || '').trim().toLowerCase();
    const requestedHost = spec.host ? String(spec.host).replace(/\/+$/, '').toLowerCase() : null;
    const matched = candidates.filter((candidate) =>
        String(candidate?.model || '').trim().toLowerCase() === requestedModel
        && (!requestedHost || String(candidate?.host || '').replace(/\/+$/, '').toLowerCase() === requestedHost));
    return matched.length ? matched : (candidates.length === 1 ? candidates : []);
}

/**
 * The one control value an arm's saved evidence carries for `term`, across
 * every source where the arm could have frozen it: the result rows' execution
 * settings, the batch's frozen campaign (candidate and fixed settings), and
 * the batch's saved execution config.
 */
function extractControl(rows, batch, spec, term) {
    const candidates = armCandidates(batch, spec);
    const fixed = batch?.inference_contract_campaign?.fixedSettings || null;
    const executionConfig = batch?.execution_config || null;
    const sources = {
        num_ctx: [
            ...rows.map((row) => getPath(row, 'execution_settings.num_ctx')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.num_ctx')),
            executionConfig?.num_ctx
        ],
        num_predict: [
            ...rows.map((row) => getPath(row, 'execution_settings.num_predict')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.num_predict')),
            executionConfig?.num_predict ?? executionConfig?.response_max_tokens
        ],
        temperature: [
            ...rows.map((row) => getPath(row, 'execution_settings.temperature')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.temperature')),
            fixed?.temperature, executionConfig?.temperature
        ],
        top_p: [
            ...rows.map((row) => getPath(row, 'execution_settings.top_p')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.top_p')),
            fixed?.top_p, executionConfig?.top_p
        ],
        top_k: [
            ...rows.map((row) => getPath(row, 'execution_settings.top_k')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.top_k')),
            fixed?.top_k, executionConfig?.top_k
        ],
        repeat_penalty: [
            ...rows.map((row) => getPath(row, 'execution_settings.repeat_penalty')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.repeat_penalty')),
            fixed?.repeat_penalty, executionConfig?.repeat_penalty
        ],
        seed: [
            ...rows.map((row) => getPath(row, 'execution_settings.seed')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.seed')),
            fixed?.seed, executionConfig?.seed
        ],
        seed_policy: [
            ...rows.map((row) => getPath(row, 'execution_settings.seed_policy')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.seed_policy')),
            fixed?.seed_policy, executionConfig?.seed_policy
        ],
        sampling_profile: [
            ...rows.map((row) => getPath(row, 'execution_settings.sampling_profile')),
            ...candidates.map((candidate) => getPath(candidate, 'execution.sampling.profile')),
            fixed?.sampling_profile, executionConfig?.sampling_profile
        ],
        api_mode: [fixed?.api_mode, executionConfig?.api_mode],
        response_mode: [batch?.inference_contract_campaign?.responseMode, executionConfig?.response_mode],
        response_budget_rule: [executionConfig?.response_budget_rule],
        think: [...candidates.map((candidate) => candidate?.mode?.think)]
    };
    return resolveControl(sources[term] || []);
}

function judgedRows(rows) {
    return rows.filter((row) => !NON_JUDGE_AUTHORITIES.has(row.evaluation_authority));
}

/** The judge terms one arm's saved evidence carries, from every source. */
function judgeSources(rows, batch) {
    const judgeConfig = batch?.judge_config && typeof batch.judge_config === 'object'
        ? batch.judge_config
        : null;
    const judged = judgedRows(rows);

    const identities = [];
    if (judgeConfig?.model) identities.push(identityOf(judgeConfig.model, judgeConfig.host));
    const multiJudges = judgeConfig?.multi_judge?.enabled ? (judgeConfig.multi_judge.judges || []) : [];
    for (const judge of multiJudges) if (judge?.model) identities.push(identityOf(judge.model, judge.host));
    if (judgeConfig?.multi_judge?.enabled && judgeConfig.multi_judge.tiebreaker?.model) {
        identities.push(identityOf(judgeConfig.multi_judge.tiebreaker.model, judgeConfig.multi_judge.tiebreaker.host));
    }
    for (const row of judged) {
        identities.push(identityOf(row.judge_model, row.judge_host));
        const names = Array.isArray(row.judge_scores) ? row.judge_scores.map((score) => score?.judge_model) : [];
        const hosts = Array.isArray(row.judge_scores) ? row.judge_scores.map((score) => score?.judge_host) : [];
        names.forEach((name, index) => identities.push(identityOf(name, hosts[index] || row.judge_host)));
    }

    return {
        identity: resolveControl(identities),
        numCtx: resolveControl([
            judgeConfig?.num_ctx,
            ...judged.map((row) => getPath(row, 'judge_execution_contract.num_ctx'))
        ]),
        execution: resolveObjectControl([
            judgeConfig?.execution_contract,
            ...judged.map((row) => row.judge_execution_contract)
        ]),
        qualification: resolveObjectControl(judged.map((row) => row.judge_qualification_contract)),
        // The batch's frozen judge config normalizes to the same settings shape
        // the qualification contract froze at scoring time.
        settings: resolveObjectControl([
            judgeConfig ? judgeCohortSettings(judgeConfig) : null,
            ...judged.map((row) => getPath(row, 'judge_qualification_contract.settings'))
        ]),
        multiJudge: resolveObjectControl([
            judgeConfig?.multi_judge?.enabled ? multiJudgeCohortSettings(judgeConfig.multi_judge) : null,
            ...judged.map((row) => getPath(row, 'judge_qualification_contract.escalation'))
        ])
    };
}

/**
 * One arm's frozen evidence: the saved cohort, its candidate provenance, the
 * judge terms and the controlled generation/budget/sampling terms.
 */
function collectArmEvidence({ spec, batch, rows }) {
    const candidates = armCandidates(batch, spec);
    const campaign = batch?.inference_contract_campaign || null;
    const judged = judgedRows(rows);
    const judge = judgeSources(rows, batch);
    const judgeIdentity = judged.length ? judge.identity : (judge.identity || null);

    const controls = {};
    for (const term of GENERATION_TERMS) {
        controls[term] = extractControl(rows, batch, spec, term);
    }

    const rowCohorts = distinct(rows.map((row) => row.quality_cohort_fingerprint));
    return {
        spec,
        batch,
        rows,
        hasJudged: judged.length > 0,
        cohortFingerprint: rowCohorts[0] || batch?.quality_cohort_fingerprint || null,
        candidateProvenance: candidates.map((candidate) => ({
            model: candidate.model || null,
            host: candidate.host || null,
            artifactDigest: candidate.artifactDigest || null,
            runtimeFingerprint: getPath(candidate, 'contract.artifact.runtimeFingerprint') || null,
            contractFingerprint: candidate.contractFingerprint || null,
            numCtx: getPath(candidate, 'execution.num_ctx') ?? null,
            numPredict: getPath(candidate, 'execution.num_predict') ?? null,
            numPredictSource: getPath(candidate, 'execution.num_predict_source') || null
        })),
        rowCohorts,
        judge: { ...judge, identity: judgeIdentity },
        scorerVersion: resolveControl([
            ...rows.map((row) => row.scorer_version),
            campaign?.fixedSettings?.scorer_version
        ]),
        controls
    };
}

function compareTerm(valueA, valueB) {
    const mixed = valueA === MIXED || valueB === MIXED;
    if (mixed) return { status: 'ambiguous', kind: 'mixed', valueA: 'mixed', valueB: 'mixed' };
    const missing = (value) => value === null || value === undefined;
    if (missing(valueA) && missing(valueB)) return { status: 'absent', valueA: null, valueB: null };
    if (missing(valueA) !== missing(valueB)) {
        // One arm saved a value, the other has no comparable evidence for it.
        return { status: 'ambiguous', kind: 'missing', valueA, valueB };
    }
    return stableJson(valueA) === stableJson(valueB)
        ? { status: 'match', valueA, valueB }
        : { status: 'mismatch', valueA, valueB };
}

function termCategory(term) {
    if (SCORER_TERMS.includes(term)) return 'scorer';
    if (JUDGE_TERMS.includes(term)) return 'judge';
    return 'generation';
}

/**
 * Build the comparison contract from two arms' saved metadata. Pure and
 * read-only: `arm` is `{ spec, batch, rows }` where `batch` is the saved
 * BenchmarkBatch document (or null) and `rows` the loaded result rows.
 */
function buildComparisonContract(armA, armB) {
    const evidenceA = collectArmEvidence(armA);
    const evidenceB = collectArmEvidence(armB);
    const hasJudged = evidenceA.hasJudged || evidenceB.hasJudged;

    const checks = { scorer_version: compareTerm(evidenceA.scorerVersion, evidenceB.scorerVersion) };
    for (const [name, judgeA, judgeB] of [
        ['judge_identity', evidenceA.judge.identity, evidenceB.judge.identity],
        ['judge_num_ctx', evidenceA.judge.numCtx, evidenceB.judge.numCtx],
        ['judge_execution_contract', evidenceA.judge.execution, evidenceB.judge.execution],
        ['judge_qualification_contract', evidenceA.judge.qualification, evidenceB.judge.qualification],
        ['judge_settings', evidenceA.judge.settings, evidenceB.judge.settings],
        ['judge_multi_judge', evidenceA.judge.multiJudge, evidenceB.judge.multiJudge]
    ]) {
        checks[name] = compareTerm(judgeA, judgeB);
    }
    for (const term of GENERATION_TERMS) {
        checks[term] = compareTerm(evidenceA.controls[term], evidenceB.controls[term]);
    }

    // The shared-cohort evidence is the saved cohort of the arms' own rows.
    // Arms whose rows carry no cohort fall back to the batch document's.
    // A cohort that disagrees with the saved metadata never gets to stand in
    // for it.
    const armCohort = (evidence) => evidence.rowCohorts.length === 1
        ? evidence.rowCohorts[0]
        : (evidence.rowCohorts.length === 0 ? evidence.cohortFingerprint : null);
    const cohortA = armCohort(evidenceA);
    const cohortB = armCohort(evidenceB);
    const sameCohort = Boolean(cohortA) && cohortA === cohortB
        && (evidenceA.rowCohorts.length > 0 || !evidenceA.batch?.quality_cohort_fingerprint
            || evidenceA.batch.quality_cohort_fingerprint === cohortA)
        && (evidenceB.rowCohorts.length > 0 || !evidenceB.batch?.quality_cohort_fingerprint
            || evidenceB.batch.quality_cohort_fingerprint === cohortB);
    const contradicted = Object.values(checks).some((check) => check.status === 'mismatch' || check.status === 'ambiguous');

    // Strict per-term verification, used whenever the shared cohort is not the
    // evidence: every frozen term must be verified, and a missing judge
    // contract on judged arms cannot be assumed fair.
    const strictCompatible = Object.entries(checks).every(([term, check]) => {
        const category = termCategory(term);
        if (check.status === 'match') return true;
        if (check.status === 'mismatch' || check.status === 'ambiguous') return false;
        // status === 'absent'
        if (category === 'scorer') return true; // both unversioned: legacy, assumed comparable
        if (category === 'judge') return !hasJudged || !REQUIRED_JUDGE_TERMS.has(term);
        return true; // generation absent on both arms: no evidence of a difference
    });

    let evidence;
    let compatible;
    if (sameCohort && !contradicted) {
        // The saved shared cohort is the comparison evidence, as before.
        evidence = 'same_quality_cohort';
        compatible = true;
    } else {
        evidence = 'frozen_contract';
        compatible = strictCompatible;
    }

    const reasons = [];
    const confounds = new Set();
    for (const [term, check] of Object.entries(checks)) {
        if (check.status === 'mismatch') {
            reasons.push(`${term}_mismatch`);
            const confound = CONFOUND_BY_TERM[term];
            if (confound) confounds.add(confound);
        } else if (check.status === 'ambiguous') {
            reasons.push(`frozen_evidence_${check.kind}:${term}`);
        } else if (check.status === 'absent' && termCategory(term) === 'judge'
            && REQUIRED_JUDGE_TERMS.has(term) && hasJudged && evidence === 'frozen_contract') {
            // A judged arm with no saved judge contract: cannot verify the judge.
            reasons.push(`frozen_evidence_missing:${term}`);
        }
    }
    if (sameCohort && contradicted) reasons.push('frozen_contract_contradicts_shared_cohort');

    // Contender identity: expected to differ, retained for both arms.
    const digestA = distinct(evidenceA.rows.map((row) => row.model_digest));
    const digestB = distinct(evidenceB.rows.map((row) => row.model_digest));
    if (digestA.length && digestB.length && digestA.join(',') !== digestB.join(',')) confounds.add('artifact_digest');
    const runtimeA = evidenceA.candidateProvenance.map((candidate) => candidate.runtimeFingerprint).filter(Boolean);
    const runtimeB = evidenceB.candidateProvenance.map((candidate) => candidate.runtimeFingerprint).filter(Boolean);
    if (runtimeA.length && runtimeB.length && runtimeA.join(',') !== runtimeB.join(',')) confounds.add('runtime_fingerprint');

    // Confounds are only surfaced as warnings when the explicit frozen
    // contract is the evidence: under a shared cohort, different contender
    // artifacts are the point of the comparison, not a warning.
    const warnings = [];
    if (evidence === 'frozen_contract') {
        for (const [term, check] of Object.entries(checks)) {
            if (check.status === 'mismatch') {
                warnings.push(`Frozen comparison term differs between the arms: ${term}.`);
            } else if (check.status === 'ambiguous') {
                warnings.push(`Frozen comparison term cannot be verified from saved evidence: ${term}.`);
            } else if (check.status === 'absent' && termCategory(term) === 'judge'
                && REQUIRED_JUDGE_TERMS.has(term) && hasJudged) {
                warnings.push(`No saved judge ${term.replace('judge_', '')} evidence: judged scores cannot be verified as comparable.`);
            }
        }
        if (confounds.has('artifact_digest')) warnings.push('The arms ran different artifact digests: retained as provenance, a confound, not a defect.');
        if (confounds.has('runtime_fingerprint')) warnings.push('The arms ran different host/runtime fingerprints: a non-authoritative confound.');
        if (confounds.has('effective_context')) warnings.push('The arms used different effective contexts: a non-authoritative confound.');
        if (confounds.has('token_budget')) warnings.push('The arms used different response token budgets: a non-authoritative confound.');
        if (confounds.has('generation_controls')) warnings.push('The arms used different controlled generation settings: a non-authoritative confound.');
    }

    return {
        schema: 'agentx.benchmark-comparison-contract/v1',
        evidence,
        sameCohort,
        compatible,
        established: compatible,
        authoritative: compatible,
        checks,
        reasons,
        confounds: [...confounds].sort(),
        warnings,
        provenance: {
            a: armProvenance(evidenceA),
            b: armProvenance(evidenceB)
        }
    };
}

function armProvenance(evidence) {
    return {
        batchId: evidence.spec.batch_id,
        qualityCohortFingerprint: evidence.batch?.quality_cohort_fingerprint || null,
        batchContractFingerprint: evidence.batch?.batch_contract_fingerprint || null,
        rowCohorts: evidence.rowCohorts,
        candidates: evidence.candidateProvenance,
        judges: evidence.judge.identity ? evidence.judge.identity.split(', ').filter(Boolean) : []
    };
}

module.exports = {
    SCORER_TERMS,
    JUDGE_TERMS,
    REQUIRED_JUDGE_TERMS,
    CONTEXT_TERMS,
    BUDGET_TERMS,
    CONTROL_TERMS,
    GENERATION_TERMS,
    CONFOUND_BY_TERM,
    buildComparisonContract,
    collectArmEvidence,
    _internal: { compareTerm, extractControl, armCandidates, resolveControl, stableJson, MIXED }
};
