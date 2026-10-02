'use strict';
/**
 * Leaderboard verdicts and one group per model and host.
 *
 * `getGeneralistLeaderboard` emits one row per model, host and quality cohort
 * (judge, scorer version and contexts). A model benchmarked under thirteen
 * cohorts is thirteen rows, twelve of them a "non-comparable cohort". This
 * module projects those rows into one group per model and host:
 *
 * - the headline is the row from the cohort the board already selected as its
 *   comparable cohort (the most recent fingerprinted cohort in scope, see
 *   `selectedQualityCohortFingerprint`). A model with no row in that cohort
 *   shows its most recent cohort as the headline and stays unranked. The
 *   pooled local-only board has one row per model and host already; it is
 *   the headline;
 * - every other cohort is history, newest first, with the reason it is not
 *   the headline.
 *
 * It also settles a verdict per row. Only a comparable verdict may carry a
 * rank or a podium place, and only an authoritative one (comparable, graded
 * by a judge qualified for its exact identity and scorer version) a medal: the row is rankable and unfiltered, carries
 * a score and sits on the board's scorer generation. A row short of the full
 * scope (`fullScopeEligible`) still ranks: its score already carries the
 * coverage and hard-level penalties, and the verdict notes `partial_scope` so
 * the board shows what is missing. Everything else stays visible with the
 * reason it is not compared. The browser keeps one plain
 * sentence per reason code, for the codes below and for every `filterReason`
 * the service emits.
 */

const { majorMinor } = require('./leaderboardPerformance');

const HEADLINE_REASON = Object.freeze({
    COMPARABLE_COHORT: 'comparable_cohort',
    POOLED_COHORTS: 'pooled_cohorts',
    LATEST_EVIDENCE: 'latest_evidence'
});

const HISTORY_REASON = Object.freeze({
    OTHER_COHORT: 'other_cohort',
    OLDER_EVIDENCE: 'older_evidence'
});

// Reasons added here, on top of the row's own filterReason.
const VERDICT_REASON = Object.freeze({
    NOT_RANKABLE: 'not_rankable',
    NO_SCORE: 'no_score',
    UNVERSIONED_SCORER: 'unversioned_scorer',
    SCORER_FAMILY_MISMATCH: 'scorer_version_family_mismatch',
    PARTIAL_SCOPE: 'partial_scope',
    GRADER_UNQUALIFIED: 'grader_unqualified',
    GRADER_UNKNOWN: 'grader_qualification_unknown'
});

function timeValue(value) {
    const time = value ? new Date(value).getTime() : NaN;
    return Number.isFinite(time) ? time : 0;
}

function hasScore(row) {
    return row.generalistScore !== null && row.generalistScore !== undefined
        && Number.isFinite(Number(row.generalistScore));
}

function scorerVersionCounts(row) {
    const own = row.scorerVersions && typeof row.scorerVersions === 'object' ? row.scorerVersions : null;
    if (own && Object.keys(own).length) return own;
    return row.performance?.scorerVersions || {};
}

/** The most frequent versioned scorer behind the row, or null when every row is unversioned. */
function dominantScorerVersion(row) {
    const entries = Object.entries(scorerVersionCounts(row))
        .filter(([version]) => version !== 'unversioned')
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    return entries.length ? entries[0][0] : null;
}

function rowSpan(row) {
    return {
        earliest: row.performance?.earliestTimestamp || row.earliestTimestamp || null,
        latest: row.latestTimestamp || row.performance?.latestTimestamp || null
    };
}

/**
 * The scorer generation rows are compared on: that of the newest scored,
 * rankable evidence. On the cohort-narrowed board that is the selected
 * cohort's version (every scored row shares it). On the pooled local board
 * there is no selected cohort, so the family comes from the most recent
 * scored row across every model and host on the board: the newest evidence
 * defines the comparison, and older generations are flagged, not averaged.
 */
function comparisonScorerFamily(rows, selectedCohort) {
    const candidates = (rows || [])
        .filter(row => hasScore(row) && row.rankable !== false && !row.filtered
            && (!selectedCohort || row.qualityCohortFingerprint === selectedCohort))
        .map(row => ({ family: majorMinor(dominantScorerVersion(row)), at: timeValue(rowSpan(row).latest) }))
        .filter(item => item.family)
        .sort((a, b) => b.at - a.at);
    return candidates.length ? candidates[0].family : null;
}

/**
 * Whether a row's verdict is comparable, and why not otherwise. A row that
 * the service already unranked keeps its own reason; the generation and
 * scope gates apply to rows that would otherwise rank.
 */
function verdictFor(row, comparisonFamily) {
    const reasons = [];
    const notes = [];
    const scorerVersion = dominantScorerVersion(row);
    const scorerFamily = majorMinor(scorerVersion);
    if (row.filtered || row.rankable === false) {
        reasons.push(row.filterReason || VERDICT_REASON.NOT_RANKABLE);
    } else if (!hasScore(row)) {
        reasons.push(VERDICT_REASON.NO_SCORE);
    } else {
        if (!scorerFamily) reasons.push(VERDICT_REASON.UNVERSIONED_SCORER);
        else if (comparisonFamily && scorerFamily !== comparisonFamily) reasons.push(VERDICT_REASON.SCORER_FAMILY_MISMATCH);
        if (row.fullScopeEligible !== true) notes.push(VERDICT_REASON.PARTIAL_SCOPE);
    }
    const comparable = reasons.length === 0;
    // Comparable says the rows were judged on the same terms. Authoritative
    // additionally needs a grader qualified for that exact judge and scorer
    // version; a row without an assessment is not authoritative.
    const grader = row.graderQualification || null;
    const authorityReasons = [];
    if (comparable) {
        if (!grader) authorityReasons.push(VERDICT_REASON.GRADER_UNKNOWN);
        else if (grader.authoritative !== true) {
            authorityReasons.push(grader.status === 'unqualified'
                ? VERDICT_REASON.GRADER_UNQUALIFIED
                : VERDICT_REASON.GRADER_UNKNOWN);
        }
    }
    return {
        comparable,
        authoritative: comparable && authorityReasons.length === 0,
        authorityReasons,
        graderStatus: grader?.status || 'unknown',
        graderCauses: grader?.causes || [],
        reasons: [...new Set(reasons)],
        notes,
        scorerVersion,
        scorerFamily,
        comparisonScorerFamily: comparisonFamily
    };
}

function sortNewestFirst(rows) {
    return [...rows].sort((a, b) => timeValue(rowSpan(b).latest) - timeValue(rowSpan(a).latest)
        || (b.generalistScore ?? -1) - (a.generalistScore ?? -1));
}

// `members` arrive newest first. Within a choice the most recent *scored*
// row is preferred over a more recent unscored one, on purpose: a scored
// row is the one the board ranked, and an unscored row of the same model
// and host says nothing a score does not. Only when no row carries a score
// is the most recent row the headline.
function pickHeadline(members, selectedCohort) {
    if (selectedCohort) {
        const inCohort = members.filter(row => row.qualityCohortFingerprint === selectedCohort);
        const headline = inCohort.find(hasScore) || inCohort[0] || null;
        if (headline) return { headline, headlineReason: HEADLINE_REASON.COMPARABLE_COHORT };
    }
    const headline = members.find(hasScore) || members[0];
    return {
        headline,
        headlineReason: !selectedCohort && hasScore(headline)
            ? HEADLINE_REASON.POOLED_COHORTS
            : HEADLINE_REASON.LATEST_EVIDENCE
    };
}

/**
 * Project flat leaderboard rows into one group per model and host.
 * Rows are annotated in place with `verdict` (every row) and `historyReason`
 * (history rows), so the flat shape carries the verdict too.
 *
 * @param {object[]} rows - `leaderboard` rows from getGeneralistLeaderboard
 * @param {{ selectedQualityCohortFingerprint?: string|null }} options
 */
function groupLeaderboard(rows, { selectedQualityCohortFingerprint = null } = {}) {
    const selected = selectedQualityCohortFingerprint || null;
    const comparisonFamily = comparisonScorerFamily(rows, selected);
    const byKey = new Map();
    for (const row of rows || []) {
        row.verdict = verdictFor(row, comparisonFamily);
        const key = `${row.model}@@${row.host || ''}`;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(row);
    }

    const groups = [];
    for (const [key, members] of byKey) {
        const newestFirst = sortNewestFirst(members);
        const { headline, headlineReason } = pickHeadline(newestFirst, selected);
        const history = newestFirst.filter(row => row !== headline);
        for (const row of history) {
            row.historyReason = selected ? HISTORY_REASON.OTHER_COHORT : HISTORY_REASON.OLDER_EVIDENCE;
        }
        const spans = members.map(rowSpan);
        const earliest = spans.map(span => timeValue(span.earliest)).filter(Boolean);
        const latest = spans.map(span => timeValue(span.latest)).filter(Boolean);
        groups.push({
            key,
            model: headline.model,
            host: headline.host || null,
            rank: null,
            comparable: headline.verdict.comparable,
            authoritative: headline.verdict.authoritative,
            verdict: headline.verdict,
            headline,
            headlineReason,
            history,
            cohortCount: members.length,
            resultCount: members.reduce((sum, row) => sum + (Number(row.totalTests) || 0), 0),
            earliestTimestamp: earliest.length ? new Date(Math.min(...earliest)).toISOString() : null,
            latestTimestamp: latest.length ? new Date(Math.max(...latest)).toISOString() : null
        });
    }

    // Comparable verdicts rank by score; everything else follows, best
    // evidence first, without a rank.
    groups.sort((a, b) => {
        if (a.comparable !== b.comparable) return a.comparable ? -1 : 1;
        const byScore = (b.headline.generalistScore ?? -Infinity) - (a.headline.generalistScore ?? -Infinity);
        if (byScore) return byScore;
        return timeValue(b.latestTimestamp) - timeValue(a.latestTimestamp);
    });
    let rank = 0;
    for (const group of groups) group.rank = group.comparable ? ++rank : null;

    return {
        groups,
        comparableCount: rank,
        authoritativeCount: groups.filter(group => group.authoritative).length,
        groupCount: groups.length,
        comparisonScorerFamily: comparisonFamily,
        selectedQualityCohortFingerprint: selected
    };
}

module.exports = {
    HEADLINE_REASON,
    HISTORY_REASON,
    VERDICT_REASON,
    comparisonScorerFamily,
    dominantScorerVersion,
    groupLeaderboard,
    verdictFor
};
