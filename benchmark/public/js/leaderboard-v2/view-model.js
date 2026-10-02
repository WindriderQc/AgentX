// view-model.js — leaderboard response rows → board entries and groups.
//
// The server emits one row per model, host and quality cohort, and one group
// per model and host (`groups`: a headline row plus the other cohorts as
// history). This module converts a row into what the boards render (0-10
// scores, labelled performance figures) and a group into a board group.
// Nothing here ranks or selects: the headline, the verdict and every reason
// come from the server and are only carried through.

import { isComparable } from './verdict.js';

/** Convert categoryAverages (0-100) to categoryScores (0-10) for category-map */
export function buildCategoryScores(categoryAverages) {
    if (!categoryAverages || typeof categoryAverages !== 'object') return {};
    const scores = {};
    for (const [cat, val] of Object.entries(categoryAverages)) {
        scores[cat] = val != null ? Number(val) / 10 : null;
    }
    return scores;
}

/** Use the exact filtered leaderboard cohort for category bars and map cells. */
export function buildCategoryDimensions(categoryScores) {
    return Object.entries(categoryScores || {})
        .filter(([, value]) => value !== null && value !== undefined && Number.isFinite(Number(value)))
        .map(([name, value]) => ({
            name,
            yesRate: Math.min(1, Math.max(0, Number(value) / 10))
        }));
}

function tenth(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value) / 10;
}

/**
 * Read each entry's performance from the server summaries, computed over
 * exactly the rows behind the entry's score, with every attempt of the same
 * scope as the success-rate denominator.
 *
 *   tokPerSec       — output tokens per second of total request time (mean)
 *   tokPerSecGen    — output tokens per second after prompt evaluation (mean), when recorded
 *   successRate     — successes / (attempts − infrastructure errors); null when unknown
 *   avgLatency      — mean latency in ms
 *   p95Latency      — 95th-percentile latency in ms
 *   benchmarkTtft   — measured time-to-first-token (ms); null if unavailable
 *   hostTtft        — warmed host baseline TTFT (ms); null if unavailable
 *   perfCoeff       — normalised tok/s (40 tok/s = 1.0) × success rate; null while success is unknown
 *
 * Mutates entries in place; returns the array.
 */
export function enrichWithPerfData(entries) {
    for (const entry of entries || []) {
        const perf = entry.performance || null;
        const attempts = entry.attempts || null;
        if (perf?.judgeModel) entry.judgeModel = perf.judgeModel;
        entry.successRate = attempts?.successRate ?? null;
        entry.successRateDetail = attempts;
        if (!perf) continue;

        entry.tokPerSec = perf.tokensPerSecTotal?.mean ?? null;
        entry.tokPerSecGen = perf.tokensPerSecGeneration?.mean ?? null;
        entry.speedDefinition = perf.tokensPerSecTotal?.definition || null;
        entry.avgLatency = perf.latencyMs?.mean ?? null;
        entry.p95Latency = perf.latencyMs?.p95 ?? null;
        entry.benchmarkTtft = perf.ttftMs?.measured?.mean ?? null;
        entry.ttft = entry.benchmarkTtft;
        entry.hostTtft = perf.ttftMs?.hostBaseline ?? null;

        // An unknown success rate is unknown, not 100%: the coefficient waits.
        if (entry.tokPerSec != null && entry.successRate != null) {
            const tokNorm = Math.min(1, entry.tokPerSec / 40);
            entry.perfCoeff = parseFloat((tokNorm * (entry.successRate / 100)).toFixed(3));
            entry.performanceCoeff = entry.perfCoeff;
        } else {
            entry.perfCoeff = null;
            entry.performanceCoeff = null;
        }
    }
    return entries;
}

/** Convert generalist leaderboard entry to the shape expected by the boards. */
export function toGeneralistBoardEntry(entry, scoreAxis = 'composite') {
    // generalistScore is 0-100 scale; board expects 0-10
    const score = entry.generalistScore != null ? entry.generalistScore / 10 : null;
    const categoryScores = buildCategoryScores(entry.categoryAverages || {});
    const perf = entry.performance || null;
    const cohortScore = perf?.score && perf.score.mean != null
        ? { field: perf.score.field, mean10: Number(perf.score.mean) / (perf.score.scale || 10) * 10, sampleSize: perf.score.sampleSize || 0 }
        : null;
    const boardEntry = {
        model:           entry.model,
        host:            entry.host || null,
        score,
        qualityScore:    score,        // best proxy available at this stage
        performanceCoeff: null,        // set by the performance pass below
        generalistScore: entry.generalistScore ?? null,
        // The score and its parts, all on the visible 0-10 scale: the raw
        // quality before any penalty, then each penalty and bonus. A filtered
        // row's zero is a withheld score, not a measurement.
        scoreParts: score == null || entry.filtered ? null : {
            score,
            quality: tenth(entry.weightedSum),
            coverage: tenth(entry.coveragePenalty) ?? 0,
            difficulty: tenth(entry.difficultyPenalty) ?? 0,
            evidence: tenth(entry.evidenceConfidencePenalty) ?? 0
        },
        coverage:        entry.coverage ?? null,
        testedCategories: entry.testedCategories ?? null,
        testCount:       entry.totalTests || 0,
        resultCount:     perf?.rows ?? entry.totalTests ?? 0,
        cohortScore,
        promptLevelCounts: entry.promptLevelCounts || {},
        minPromptLevel:  entry.minPromptLevel ?? null,
        maxPromptLevel:  entry.maxPromptLevel ?? null,
        contextCounts:   Object.keys(entry.contextCounts || {}).length ? entry.contextCounts : (perf?.contexts || {}),
        judgeTargets:    entry.judgeTargets || [],
        judgeModels:     entry.judgeModels || [],
        judgeModel:      perf?.judgeModel || entry.judgeModels?.[0] || null,
        scorerVersions:  Object.keys(entry.scorerVersions || {}).length ? entry.scorerVersions : (perf?.scorerVersions || {}),
        earliestTimestamp: perf?.earliestTimestamp || entry.earliestTimestamp || null,
        latestTimestamp: entry.latestTimestamp || perf?.latestTimestamp || null,
        difficultyPenalty: entry.difficultyPenalty ?? 0,
        difficultyCoverage: entry.difficultyCoverage ?? null,
        host_available: entry.host_available !== false,
        residency:       entry.residency || null,
        fullScopeMinLevel: entry.fullScopeMinLevel ?? null,
        requiredPromptLevels: entry.requiredPromptLevels || [],
        missingRequiredLevelsByCategory: entry.missingRequiredLevelsByCategory || {},
        fullScopeEligible: entry.fullScopeEligible === true,
        evidenceStatus: entry.evidenceStatus || null,
        evidenceConfidence: entry.evidenceConfidence ?? null,
        evidenceConfidenceCoverage: entry.evidenceConfidenceCoverage ?? null,
        evidenceConfidenceTarget: entry.evidenceConfidenceTarget ?? null,
        evidenceConfidencePenalty: entry.evidenceConfidencePenalty ?? 0,
        needsReviewCount: entry.needsReviewCount || 0,
        lowConfidenceCount: entry.lowConfidenceCount || 0,
        categoryScores,
        categoryEvidence: entry.categoryEvidence || {},
        dimensions: buildCategoryDimensions(categoryScores),
        scoreAxis,
        // API margins are on the normalized 0-100 axis; every visible score on
        // this board is 0-10, so the detailed row must use the same conversion
        // as the podium.
        confidence:      entry.confidenceMargin != null ? Number(entry.confidenceMargin) / 10 : null,
        confidenceMethod: entry.confidenceMethod || null,
        confidenceSampleSize: entry.confidenceSampleSize || 0,
        confidenceRepeatCount: entry.confidenceRepeatCount || 0,
        evidenceCompatibility: entry.evidenceCompatibility || 'comparable',
        reviewCount:     entry.needsReviewCount || 0,
        trend:           null,
        filtered:        entry.filtered || false,
        rankable:        entry.rankable !== false,
        filterReason:    entry.filterReason || null,
        verdict:         entry.verdict || null,
        graderQualification: entry.graderQualification || null,
        historyReason:   entry.historyReason || null,
        harnessEvidence: entry.harnessEvidence || null,
        executionTarget: entry.executionTarget || null,
        provider:        entry.provider || 'ollama',
        tier:            entry.tier || 'local',
        harness:         entry.harness || null,
        pricing:         entry.pricing || null,
        providerCostNanodollars: entry.providerCostNanodollars || 0,
        qualityCohortFingerprint: entry.qualityCohortFingerprint || null,
        performance: perf,
        thinking: perf?.thinking || null,
        attempts: entry.attempts || null
    };
    enrichWithPerfData([boardEntry]);
    return boardEntry;
}

function fallbackGroup(row) {
    return {
        key: `${row.model || ''}@@${row.host || ''}`,
        model: row.model,
        host: row.host || null,
        rank: null,
        comparable: isComparable(row),
        verdict: row.verdict || null,
        headline: row,
        headlineReason: null,
        history: [],
        cohortCount: 1,
        resultCount: row.totalTests || 0,
        earliestTimestamp: row.earliestTimestamp || null,
        latestTimestamp: row.latestTimestamp || null
    };
}

/** A server group → a board group with converted headline and history entries. */
export function toBoardGroup(group, { scoreAxis = 'composite', hostNameMap = {} } = {}) {
    const rawRows = [group.headline, ...(group.history || [])];
    enrichWithPerfData(rawRows);
    const hostName = hostNameMap[group.host] || null;
    const convert = (row) => {
        const entry = toGeneralistBoardEntry(row, scoreAxis);
        if (hostName) entry.hostName = hostName;
        return entry;
    };
    const headline = convert(group.headline);
    if (hostName) group.headline.hostName = hostName;
    return {
        key: group.key || `${group.model || ''}@@${group.host || ''}`,
        model: group.model,
        host: group.host || null,
        hostName,
        rank: group.rank ?? null,
        comparable: isComparable(headline),
        verdict: headline.verdict,
        headline,
        raw: group.headline,
        headlineReason: group.headlineReason || null,
        history: (group.history || []).map(convert),
        cohortCount: group.cohortCount ?? rawRows.length,
        resultCount: group.resultCount ?? rawRows.reduce((sum, row) => sum + (row.totalTests || 0), 0),
        earliestTimestamp: group.earliestTimestamp || headline.earliestTimestamp || null,
        latestTimestamp: group.latestTimestamp || headline.latestTimestamp || null
    };
}

/**
 * Board groups from a leaderboard response. A response without `groups`
 * (an older server) yields one group per flat row, with no history.
 */
export function groupsFromResponse(data, { scoreAxis = 'composite', hostNameMap = {}, selectedHost = null } = {}) {
    const serverGroups = Array.isArray(data?.groups)
        ? data.groups
        : (data?.leaderboard || []).map(fallbackGroup);
    return serverGroups
        .filter(group => !selectedHost || (group.host || '') === selectedHost)
        .map(group => toBoardGroup(group, { scoreAxis, hostNameMap }));
}
