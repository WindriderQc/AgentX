const path = require('path');
const { loadConfigGoldset } = require('./retroCalibration');

function finiteValue(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function calibrationScore(value) {
    const numeric = finiteValue(value);
    return numeric !== null && numeric >= 0 && numeric <= 10 ? numeric : null;
}

function loadCalibrationSet(filePath) {
    const resolved = filePath || path.join(__dirname, '..', '..', '..', 'data', 'judge-calibration-set.json');
    return loadConfigGoldset(resolved);
}

function validateCalibrationSet(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('Calibration set is empty');
    }
    const missing = entries.filter((entry) =>
        !entry.prompt
        || !entry.response
        || !entry.category
        || calibrationScore(entry.expert_scores?.overall) === null
    );
    if (missing.length > 0) {
        throw new Error(`Calibration set has ${missing.length} invalid entries`);
    }
}

function evaluateCalibrationCase(entry, actual) {
    const humanScore = calibrationScore(entry.expert_scores.overall);
    const judgeScore = calibrationScore(actual.quality_score);
    const specifiedTolerance = finiteValue(entry.tolerance);
    const tolerance = specifiedTolerance !== null && specifiedTolerance >= 0 ? specifiedTolerance : 1.0;
    const absoluteError = judgeScore !== null && humanScore !== null ? Math.abs(judgeScore - humanScore) : null;
    const withinTolerance = absoluteError !== null && absoluteError <= tolerance;
    const expectedReview = entry.expected_review === true;
    const reviewMatch = actual.needs_review === expectedReview;
    const identityCase = isIdentityCase(entry);

    return {
        identity_case: identityCase,
        // Uses the case's own tolerance; no separate threshold to tune.
        identity_full_marks: identityCase ? judgeScore !== null && judgeScore >= SCALE_MAXIMUM - tolerance : null,
        keying: keyingCredit(actual.decomposed_breakdown),
        id: entry.name || entry._id,
        category: entry.category,
        tier: entry._config_tier || null,
        human_score: humanScore,
        judge_score: Number.isFinite(judgeScore) ? judgeScore : null,
        tolerance,
        absolute_error: absoluteError,
        within_tolerance: withinTolerance,
        expected_review: expectedReview,
        needs_review: !!actual.needs_review,
        review_match: reviewMatch,
        scoring_method: actual.scoring_method || null,
        judge_confidence: actual.judge_confidence ?? null
    };
}

function summarizeCalibrationResults(results) {
    const scored = results.filter((result) => result.absolute_error !== null);
    const total = results.length;
    const within = results.filter((result) => result.within_tolerance).length;
    const reviewMatches = results.filter((result) => result.review_match).length;
    const mae = scored.length > 0
        ? scored.reduce((sum, result) => sum + result.absolute_error, 0) / scored.length
        : null;

    const byCategory = {};
    for (const result of results) {
        if (!byCategory[result.category]) {
            byCategory[result.category] = { count: 0, within_tolerance: 0, mae_sum: 0, scored: 0 };
        }
        const bucket = byCategory[result.category];
        bucket.count += 1;
        if (result.within_tolerance) bucket.within_tolerance += 1;
        if (result.absolute_error !== null) {
            bucket.scored += 1;
            bucket.mae_sum += result.absolute_error;
        }
    }

    for (const bucket of Object.values(byCategory)) {
        bucket.tolerance_rate = bucket.count > 0 ? Math.round((bucket.within_tolerance / bucket.count) * 100) : 0;
        bucket.mae = bucket.scored > 0 ? Math.round((bucket.mae_sum / bucket.scored) * 100) / 100 : null;
        delete bucket.mae_sum;
    }

    return {
        total,
        scored: scored.length,
        within_tolerance: within,
        tolerance_rate: total > 0 ? Math.round((within / total) * 100) : 0,
        review_matches: reviewMatches,
        review_match_rate: total > 0 ? Math.round((reviewMatches / total) * 100) : 0,
        mae: mae === null ? null : Math.round(mae * 100) / 100,
        by_category: byCategory
    };
}

const SCALE_MAXIMUM = 10;
// Diagnostic bands only; they never decide qualification.
const STRONG_REFERENCE_MINIMUM = 8;
const WEAK_REFERENCE_MAXIMUM = 3;

function normalizedText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * A case whose response is the expected answer itself. Its correct grade needs
 * no reviewer: whatever the rubric asks, the reference answer is what full
 * marks looks like.
 */
function isIdentityCase(entry) {
    const response = normalizedText(entry?.response);
    return response.length > 0 && response === normalizedText(entry?.expected_answer);
}

/**
 * Count credited yes/no questions by keying. A negatively keyed question
 * ("is anything wrong?") earns credit for NO. Errors are not answers.
 */
function keyingCredit(decomposedBreakdown) {
    const counts = { positive: { asked: 0, credited: 0 }, negative: { asked: 0, credited: 0 } };
    if (!decomposedBreakdown || typeof decomposedBreakdown !== 'object') return null;
    for (const questions of Object.values(decomposedBreakdown)) {
        if (!Array.isArray(questions)) continue;
        for (const question of questions) {
            if (typeof question?.answer !== 'boolean') continue;
            const bucket = question.inverted === true ? counts.negative : counts.positive;
            bucket.asked += 1;
            if (question.contributed === true) bucket.credited += 1;
        }
    }
    return counts.positive.asked + counts.negative.asked > 0 ? counts : null;
}

function round(value, factor) {
    return Math.round(value * factor) / factor;
}

function keyingBand(results) {
    const band = { positive: { asked: 0, credited: 0 }, negative: { asked: 0, credited: 0 } };
    for (const result of results) {
        for (const keying of ['positive', 'negative']) {
            band[keying].asked += result.keying?.[keying]?.asked || 0;
            band[keying].credited += result.keying?.[keying]?.credited || 0;
        }
    }
    for (const keying of ['positive', 'negative']) {
        band[keying].credit_rate = band[keying].asked > 0
            ? Math.round((band[keying].credited / band[keying].asked) * 100)
            : null;
    }
    // Percentage points a strong answer loses merely because a question is
    // phrased negatively. Near zero for a judge that reads polarity.
    band.gap = band.positive.credit_rate !== null && band.negative.credit_rate !== null
        ? band.positive.credit_rate - band.negative.credit_rate
        : null;
    return band;
}

/**
 * Statistics for one accuracy-calibration run. `results` are the per-case rows
 * returned by the route; `total` is the size of the calibration set.
 */
function summarizeAccuracyCalibration(results, total) {
    const successful = results.filter(result => result.success && result.judge_score !== null);
    const n = successful.length;

    const mae = n > 0 ? round(successful.reduce((sum, r) => sum + r.abs_diff, 0) / n, 100) : null;
    // Positive bias: the judge scores higher than the reference.
    const bias = n > 0 ? round(successful.reduce((sum, r) => sum + r.diff, 0) / n, 100) : null;
    const agreements = successful.filter(result => result.abs_diff <= 1).length;
    const agreementRate = results.length > 0 ? Math.round((agreements / results.length) * 100) : 0;

    let correlation = null;
    if (n >= 3) {
        const gold = successful.map(result => result.gold_score);
        const judge = successful.map(result => result.judge_score);
        const meanGold = gold.reduce((a, b) => a + b, 0) / n;
        const meanJudge = judge.reduce((a, b) => a + b, 0) / n;
        let numerator = 0, goldSquares = 0, judgeSquares = 0;
        for (let i = 0; i < n; i++) {
            const dg = gold[i] - meanGold;
            const dj = judge[i] - meanJudge;
            numerator += dg * dj;
            goldSquares += dg * dg;
            judgeSquares += dj * dj;
        }
        const denominator = Math.sqrt(goldSquares * judgeSquares);
        correlation = denominator > 0 ? round(numerator / denominator, 1000) : 0;
    }

    // Share of case pairs with different reference scores that the judge
    // orders the same way. A ranking or a certified winner rests on this,
    // not on absolute agreement; ties count as neither right nor wrong.
    let orderedPairs = 0, tiedPairs = 0, comparablePairs = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            if (successful[i].gold_score === successful[j].gold_score) continue;
            comparablePairs += 1;
            const judgeSign = Math.sign(successful[i].judge_score - successful[j].judge_score);
            const goldSign = Math.sign(successful[i].gold_score - successful[j].gold_score);
            if (judgeSign === 0) tiedPairs += 1;
            else if (judgeSign === goldSign) orderedPairs += 1;
        }
    }
    const ordering = {
        comparable_pairs: comparablePairs,
        ordered: orderedPairs,
        tied: tiedPairs,
        accuracy: comparablePairs > 0 ? Math.round((orderedPairs / comparablePairs) * 100) : null,
        // A tie is half right: the judge did not invert the pair, it failed to
        // separate it. This is the figure qualification uses.
        accuracy_ties_half: comparablePairs > 0
            ? Math.round(((orderedPairs + tiedPairs / 2) / comparablePairs) * 1000) / 10
            : null
    };

    const byTier = {};
    for (const result of successful) {
        if (!byTier[result.tier]) byTier[result.tier] = { count: 0, totalError: 0, totalBias: 0 };
        byTier[result.tier].count += 1;
        byTier[result.tier].totalError += result.abs_diff;
        byTier[result.tier].totalBias += result.diff;
    }
    const tierBreakdown = {};
    for (const [tier, stats] of Object.entries(byTier)) {
        tierBreakdown[tier] = {
            count: stats.count,
            mae: round(stats.totalError / stats.count, 100),
            bias: round(stats.totalBias / stats.count, 100)
        };
    }

    const scoringMethods = successful.reduce((counts, result) => {
        const method = result.scoring_method || 'unknown';
        counts[method] = (counts[method] || 0) + 1;
        return counts;
    }, {});

    const identityCases = results.filter(result => result.identity_case === true);
    const identityFailures = identityCases.filter(result => result.identity_full_marks !== true);
    const identity = {
        total: identityCases.length,
        full_marks: identityCases.length - identityFailures.length,
        failed: identityFailures.map(result => result.id)
    };

    // Known-answer probes (rubric 2.15): a judge that fails them answered by
    // disposition rather than by reading the question.
    const attention = { passed: 0, failed: 0, unknown: 0 };
    for (const result of successful) {
        const passed = result.attention_check?.passed;
        if (passed === true) attention.passed += 1;
        else if (passed === false) attention.failed += 1;
        else attention.unknown += 1;
    }

    const keyingBias = {
        strong: keyingBand(successful.filter(result => result.gold_score >= STRONG_REFERENCE_MINIMUM)),
        weak: keyingBand(successful.filter(result => result.gold_score <= WEAK_REFERENCE_MAXIMUM))
    };

    return {
        total,
        scored: n,
        mae,
        bias,
        agreement_rate: agreementRate,
        correlation,
        ordering,
        tier_breakdown: tierBreakdown,
        scoring_methods: scoringMethods,
        identity,
        attention,
        keying_bias: keyingBias
    };
}

// Qualification criteria. The product ranks models, so a judge qualifies on
// how reliably it orders pairs of answers, not on how often it lands within a
// point of an authored grade: on the 20 authored references, the judge with
// the best absolute agreement was the worst at ordering. Absolute agreement
// and correlation stay in the report as diagnostics.
const QUALIFICATION_CRITERIA = Object.freeze({
    ordering_ties_half_min: 85,
    mae_max: 1.5,
    identity: 'every reference answer earns full marks',
    attention: 'no failed known-answer probe'
});

/**
 * Which criteria a run fails. Empty when the run qualifies.
 */
function qualificationFailures(summary) {
    const failures = [];
    if (!(summary.total > 0) || summary.scored !== summary.total) failures.push('incomplete');
    const ordering = summary.ordering?.accuracy_ties_half;
    if (!Number.isFinite(ordering) || ordering < QUALIFICATION_CRITERIA.ordering_ties_half_min) failures.push('ordering');
    if (!Number.isFinite(summary.mae) || summary.mae > QUALIFICATION_CRITERIA.mae_max) failures.push('mae');
    // A pipeline that marks down the reference answer itself is not qualified,
    // whatever its averages; summaries without identity cases pass this test.
    if (summary.identity && summary.identity.full_marks !== summary.identity.total) failures.push('identity');
    if (summary.attention && summary.attention.failed > 0) failures.push('attention');
    return failures;
}

function isAccuracyCalibrationValid(summary) {
    return qualificationFailures(summary).length === 0;
}

module.exports = {
    QUALIFICATION_CRITERIA,
    SCALE_MAXIMUM,
    isAccuracyCalibrationValid,
    qualificationFailures,
    isIdentityCase,
    keyingCredit,
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeAccuracyCalibration,
    summarizeCalibrationResults
};
