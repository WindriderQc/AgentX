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
    'judge_qualification_contract', 'judge_settings', 'judge_multi_judge', 'judge_participants'
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
    'sampling_profile', 'api_mode', 'response_mode', 'response_budget_rule', 'think', 'send_think',
    'answer_contract_mode', 'include_length_hint', 'thinking_final_answer_policy'
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
    think: 'generation_controls',
    send_think: 'generation_controls',
    answer_contract_mode: 'generation_controls', include_length_hint: 'generation_controls',
    thinking_final_answer_policy: 'generation_controls'
});
const { judgeCohortSettings, multiJudgeCohortSettings } = require('../../../../shared/benchmarkTargetContract');

const { normalizeModelTag } = require('../../../../shared/modelNames');
const { normalizeHostUrl } = require('../../../../shared/artifactIdentity');
const { fingerprint } = require('../../../../shared/workerContract');
const { qualificationContractFingerprint } = require('./judgeQualificationContract');
const { seedForRepeat } = require('./config');
const REQUIRED_GENERATION_TERMS = new Set(GENERATION_TERMS.filter(term => term !== 'response_budget_rule'));

const NON_JUDGE_AUTHORITIES = new Set(['deterministic', 'executable']);
const MIXED = Symbol('mixed');
const SAVED_NULL = Symbol('saved-null');

const distinct = (values) => [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ''))];
const hostOf = normalizeHostUrl;
const identityOf = (model, host) => (model ? `${normalizeModelTag(model).toLowerCase()}@${hostOf(host)}` : null);

function normalizeScalar(value) {
    if (value === SAVED_NULL) return value;
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

// Writer qualification folds :latest even when the saved execution retains it.
// Normalize identities only; artifact digests, settings and policy stay exact.
function judgeJson(value) {
    function canonical(node) {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(canonical);
        return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key,
            typeof entry === 'string' && key === 'model' ? normalizeModelTag(entry).toLowerCase()
                : typeof entry === 'string' && key === 'host' ? hostOf(entry) : canonical(entry)]));
    }
    return stableJson(canonical(value));
}

/**
 * A whole-object control (judge execution/qualification settings, multi-judge
 * policy). All saved copies must agree, else `MIXED`; none saved is absent.
 */
function resolveObjectControl(sources) {
    const values = sources
        .filter((value) => value !== null && value !== undefined)
        .map(judgeJson);
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
    return matched;
}

/**
 * The one control value an arm's saved evidence carries for `term`, across
 * every source where the arm could have frozen it: the result rows' execution
 * settings, the batch's frozen campaign (candidate and fixed settings), and
 * the batch's saved execution config.
 */
function normalizeMode(value) {
    const mode = normalizeScalar(value);
    if (['off', 'final-only', 'final'].includes(mode)) return 'final_only';
    if (['explicit-thinking', 'thinking', 'on'].includes(mode)) return 'explicit_thinking';
    if (['best-qualified', 'thinking_mode'].includes(mode)) return 'best_qualified';
    return mode;
}

function extractControl(rows, batch, spec, term) {
    const candidates = armCandidates(batch, spec);
    const fixed = batch?.inference_contract_campaign?.fixedSettings || null;
    const executionConfig = batch?.execution_config || null;
    const frozen = [...candidates.map(candidate => candidate.execution?.sampling), fixed, executionConfig];
    const seeds = sources => sources.filter(source => source && Object.hasOwn(source, 'seed'))
        .map(source => source.seed === null ? SAVED_NULL : source.seed);
    if (term === 'seed' && extractControl(rows, batch, spec, 'seed_policy') === 'repeat_index_v1') {
        const base = resolveControl(seeds(frozen));
        if (base === null || base === MIXED || (base !== SAVED_NULL && !Number.isSafeInteger(base))) return MIXED;
        const valid = rows.every(row => Object.hasOwn(row.execution_settings || {}, 'seed')
            && Number.isSafeInteger(row.repeat_index) && row.repeat_index >= 0
            && row.execution_settings.seed === seedForRepeat({ seed: base === SAVED_NULL ? null : base,
                seed_policy: 'repeat_index_v1' }, row.repeat_index));
        return valid ? base : MIXED;
    }
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
        seed: seeds([...rows.map(row => row.execution_settings), ...frozen]),
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
        response_mode: [...rows.map(row => row.execution_settings?.think_mode), ...candidates.map(candidate => candidate.mode?.name),
            batch?.inference_contract_campaign?.responseMode, executionConfig?.response_mode].map(normalizeMode),
        response_budget_rule: [executionConfig?.response_budget_rule],
        think: [...rows.map(row => row.execution_settings?.think), ...candidates.map(candidate => candidate.mode?.think)],
        send_think: candidates.map(candidate => candidate.mode?.sendThink),
        answer_contract_mode: [fixed?.answer_contract_mode, executionConfig?.answer_contract_mode],
        include_length_hint: [fixed?.include_length_hint, executionConfig?.include_length_hint],
        thinking_final_answer_policy: [fixed?.thinking_final_answer_policy, executionConfig?.thinking_final_answer_policy]
    };
    return resolveControl(sources[term] || []);
}

function judgedRows(rows) {
    return rows.filter((row) => !NON_JUDGE_AUTHORITIES.has(row.evaluation_authority));
}

/** Validate the saved target, including artifact, effective context and qualification. */
function qualifiedTarget(model, host, execution, qualification) {
    if (!qualificationContractFingerprint(qualification)
        || execution?.schema !== 'agentx.benchmark-judge-execution/v1'
        || identityOf(model, host) !== identityOf(execution.artifact?.model, execution.artifact?.host)
        || identityOf(model, host) !== identityOf(qualification.artifact.model, qualification.artifact.host)
        || execution.num_ctx !== qualification.settings.numCtx) return false;
    return ['digest', 'runtimeFingerprint', 'hostId'].every(key =>
        (execution.artifact?.[key] ?? null) === (qualification.artifact[key] ?? null));
}

/** Actual votes must account for the frozen policy and received consensus. */
function completeJudgedRow(row) {
    if (!qualifiedTarget(row.judge_model, row.judge_host, row.judge_execution_contract, row.judge_qualification_contract)) return false;
    const scores = Array.isArray(row.judge_scores) ? row.judge_scores : [];
    const multi = row.judge_escalated || row.judge_tiebreaker_used || row.judge_consensus || scores.length;
    if (!multi) return true;
    const policy = row.judge_qualification_contract.escalation;
    if (!row.judge_escalated || !policy || !['agreement', 'tiebreaker_resolved'].includes(row.judge_consensus)) return false;
    const used = row.judge_tiebreaker_used === true;
    if (used !== (row.judge_consensus === 'tiebreaker_resolved') || (used && !policy.tiebreaker)) return false;
    const expected = [...policy.judges, ...(used ? [policy.tiebreaker] : [])];
    if (scores.length !== expected.length || new Set(scores.map(score => identityOf(score.judge_model, score.judge_host))).size !== scores.length) return false;
    for (const vote of scores) {
        const target = expected.find(judge => identityOf(judge.model, judge.host) === identityOf(vote.judge_model, vote.judge_host));
        if (!target || !Number.isFinite(vote.quality_score) || vote.quality_score < 0 || vote.quality_score > 10
            || !qualifiedTarget(vote.judge_model, vote.judge_host, vote.execution_contract, vote.qualification_contract)
            || judgeJson(target.contract) !== judgeJson(vote.execution_contract)
            || stableJson(target.settings) !== stableJson(vote.qualification_contract.settings)
            || (vote.qualification_contract.escalation !== null
                && judgeJson(vote.qualification_contract.escalation) !== judgeJson(policy))) return false;
    }
    const primaryScores = policy.judges.map(judge => scores.find(vote => identityOf(vote.judge_model, vote.judge_host) === identityOf(judge.model, judge.host)).quality_score);
    const divergence = Math.max(...primaryScores) - Math.min(...primaryScores);
    // Writer consensus uses a two-point spread and population standard deviation / 5.
    if ((divergence > 2) !== used || (row.judge_divergence != null
        && (!Number.isFinite(row.judge_divergence) || Math.abs(row.judge_divergence - divergence) > 1e-8))) return false;
    const values = scores.map(score => score.quality_score);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
    return 1 - deviation / 5 >= 0.7;
}

/** Primary and participant contracts are separate canonical collections, never scalars. */
function judgeSources(rows, batch) {
    const judged = judgedRows(rows);
    const judgeConfig = judged.length ? batch?.judge_config || null : null;
    const identities = [];
    if (judgeConfig?.model) identities.push(identityOf(judgeConfig.model, judgeConfig.host));
    const configured = judgeConfig?.multi_judge?.enabled ? [...(judgeConfig.multi_judge.judges || []),
        ...(judgeConfig.multi_judge.tiebreaker ? [judgeConfig.multi_judge.tiebreaker] : [])] : [];
    configured.forEach(judge => identities.push(identityOf(judge.model, judge.host)));
    for (const row of judged) {
        identities.push(identityOf(row.judge_model, row.judge_host));
        (row.judge_scores || []).forEach(score => identities.push(identityOf(score.judge_model, score.judge_host)));
    }
    const judges = distinct(identities).sort();
    const legacy = !judgeConfig && judged.every(row => !row.judge_execution_contract && !row.judge_qualification_contract
        && !row.judge_escalated && !row.judge_consensus && !row.judge_tiebreaker_used && !(row.judge_scores || []).length);
    return {
        judges, identity: judges.length ? stableJson(judges) : null,
        complete: judged.every(completeJudgedRow), legacy,
        numCtx: resolveControl([judgeConfig?.num_ctx, ...judged.map(row => row.judge_execution_contract?.num_ctx)]),
        execution: resolveObjectControl([judgeConfig?.execution_contract, ...judged.map(row => row.judge_execution_contract)]),
        qualification: resolveObjectControl(judged.map(row => row.judge_qualification_contract
            ? { ...row.judge_qualification_contract, escalation: null } : null)),
        settings: resolveObjectControl([judgeConfig ? judgeCohortSettings(judgeConfig) : null,
            ...judged.map(row => row.judge_qualification_contract?.settings)]),
        multiJudge: resolveObjectControl([judgeConfig?.multi_judge?.enabled ? multiJudgeCohortSettings(judgeConfig.multi_judge) : null,
            ...judged.map(row => row.judge_qualification_contract?.escalation)]),
        participants: participantEvidence(judged)
    };
}

// Escalation is selected per result, not once for the entire campaign.
function participantEvidence(rows) {
    const evidence = new Map();
    for (const row of rows) {
        const key = `${row.prompt_id || row.prompt_name || row.prompt_fingerprint}|${row.repeat_index ?? 0}`;
        const value = judgeJson({ escalated: !!row.judge_escalated, tiebreaker: !!row.judge_tiebreaker_used,
            votes: (row.judge_scores || []).map(score => ({
                identity: identityOf(score.judge_model, score.judge_host), execution: score.execution_contract,
                qualification: score.qualification_contract ? { ...score.qualification_contract, escalation: null } : null
            })).sort((a, b) => String(a.identity).localeCompare(String(b.identity))) });
        if (evidence.has(key) && evidence.get(key) !== value) evidence.set(key, MIXED);
        else evidence.set(key, value);
    }
    return evidence;
}

function compareParticipants(a, b) {
    const left = {}, right = {};
    for (const key of [...a.keys()].filter(key => b.has(key)).sort()) {
        if (a.get(key) === MIXED || b.get(key) === MIXED) return compareTerm(MIXED, MIXED);
        left[key] = a.get(key); right[key] = b.get(key);
    }
    return compareTerm(stableJson(left), stableJson(right));
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
        candidateSelectionVerified: !campaign || (candidates.length > 0
            && (spec.host || distinct(candidates.map(candidate => hostOf(candidate.host))).length === 1)
            && rows.every(row => candidates.some(candidate => hostOf(candidate.host) === hostOf(row.host)))),
        judges: judge.judges,
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
    if (valueA === MIXED || valueB === MIXED) return { status: 'ambiguous', kind: 'mixed', valueA: 'mixed', valueB: 'mixed' };
    const missing = value => value === null || value === undefined;
    const display = value => value === SAVED_NULL ? null : value;
    if (missing(valueA) && missing(valueB)) return { status: 'absent', valueA: null, valueB: null };
    if (missing(valueA) !== missing(valueB)) return { status: 'ambiguous', kind: 'missing', valueA: display(valueA), valueB: display(valueB) };
    return { status: stableJson(valueA) === stableJson(valueB) ? 'match' : 'mismatch', valueA: display(valueA), valueB: display(valueB) };
}

/** Catalogue fingerprints do not cover appended instructions. Compare saved effective requests per shared prompt without exposing their text. */
function effectivePromptChecks(rowsA, rowsB) {
    const fields = ['hint_applied', 'hint_text', 'answer_contract_applied', 'answer_contract_mode',
        'answer_contract_target_tokens', 'answer_contract_max_tokens', 'answer_contract_text',
        'thinking_final_answer_text'];
    const collect = rows => {
        const prompts = new Map();
        for (const row of rows) {
            const key = row.prompt_id ? `id:${row.prompt_id}` : row.prompt_name ? `name:${row.prompt_name}` : null;
            if (!key) continue;
            const saved = Object.fromEntries(fields.filter(field => Object.hasOwn(row.execution_settings || {}, field))
                .map(field => [field, row.execution_settings[field]]));
            if (typeof row.prompt === 'string') saved.prompt = row.prompt;
            const value = Object.keys(saved).length ? fingerprint(saved) : null;
            if (!prompts.has(key)) prompts.set(key, new Set());
            prompts.get(key).add(value);
        }
        return prompts;
    };
    const a = collect(rowsA), b = collect(rowsB), valuesA = {}, valuesB = {};
    let hasEvidence = false;
    for (const key of [...a.keys()].filter(key => b.has(key)).sort()) {
        if (a.get(key).size !== 1 || b.get(key).size !== 1) return compareTerm(MIXED, MIXED);
        const left = [...a.get(key)][0], right = [...b.get(key)][0];
        if ((left === null) !== (right === null)) return compareTerm(left, right);
        hasEvidence ||= left !== null;
        valuesA[key] = left; valuesB[key] = right;
    }
    return compareTerm(hasEvidence ? stableJson(valuesA) : null, hasEvidence ? stableJson(valuesB) : null);
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

    const checks = { scorer_version: compareTerm(evidenceA.scorerVersion, evidenceB.scorerVersion),
        effective_prompt: effectivePromptChecks(armA.rows, armB.rows),
        judge_participants: compareParticipants(evidenceA.judge.participants, evidenceB.judge.participants) };
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
        if (category === 'scorer') return false;
        if (category === 'judge') return !hasJudged || !REQUIRED_JUDGE_TERMS.has(term);
        return !REQUIRED_GENERATION_TERMS.has(term);
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
    if (!evidenceA.candidateSelectionVerified || !evidenceB.candidateSelectionVerified) reasons.push('candidate_selection_unverified');
    if ([evidenceA, evidenceB].some(arm => arm.hasJudged && !arm.judge.complete
        && !(sameCohort && !contradicted && arm.judge.legacy))) reasons.push('judge_evidence_unverified');
    compatible = compatible && reasons.length === 0;
    const confounds = new Set();
    for (const [term, check] of Object.entries(checks)) {
        if (check.status === 'mismatch') {
            reasons.push(`${term}_mismatch`);
            const confound = CONFOUND_BY_TERM[term];
            if (confound) confounds.add(confound);
        } else if (check.status === 'ambiguous') {
            reasons.push(`frozen_evidence_${check.kind}:${term}`);
        } else if (check.status === 'absent' && evidence === 'frozen_contract'
            && (termCategory(term) === 'scorer' || REQUIRED_GENERATION_TERMS.has(term)
                || (REQUIRED_JUDGE_TERMS.has(term) && hasJudged))) {
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

    // Artifact differences are provenance; unverifiable controls explain why
    // an otherwise paired comparison cannot be authoritative.
    const warnings = [];
    if (reasons.includes('candidate_selection_unverified')) warnings.push('Saved campaign candidates do not unambiguously bind to the selected model and host.');
    if (reasons.includes('judge_evidence_unverified')) warnings.push('Saved judge qualifications or consensus evidence are incomplete or contradictory.');
    if (confounds.has('artifact_digest')) warnings.push('The arms ran different artifact digests: retained as provenance, a confound, not a defect.');
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
        for (const term of reasons.filter(reason => reason.startsWith('frozen_evidence_missing:')).map(reason => reason.split(':')[1])) {
            if (termCategory(term) !== 'judge') warnings.push(`No saved ${term} evidence: the comparison contract cannot be verified.`);
        }
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
        judges: evidence.judge.judges
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
