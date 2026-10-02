// verdict.js — plain-language verdicts for leaderboard rows.
//
// The server decides which rows are comparable and why the others are not
// (see src/services/benchmark/leaderboardGrouping.js). This module only
// turns those codes into one sentence each, explains which cohort a group's
// headline is and why, and renders the legend. An unknown code falls back to
// the raw code; it is never rendered as nothing.

export function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

// Every filterReason the service emits, plus the verdict reasons the grouping
// adds. Each sentence starts with a short label, then a colon.
export const REASON_TEXT = Object.freeze({
    quality_cohort_fingerprint_mismatch: 'Other cohort: these results were judged under a different judge, scorer version or context set than the cohort the board compares.',
    prompt_content_changed: 'Edited prompt: these results ran a prompt whose content has changed in the catalog since, or that left the catalog, so they are not compared with results on the current prompt.',
    mixed_scorer_versions: 'Mixed scorer generations: its rows were scored by two scorer generations, which are different scales and cannot be averaged.',
    excessive_empty_responses: 'Too many empty responses: more than half of its answers were empty, so its score is withheld.',
    mixed_execution_lanes: 'Mixed execution lanes: some rows ran through a harness and others directly, so the evidence is not one lane.',
    mixed_execution_target: 'Mixed execution targets: its harness rows came from more than one execution fingerprint.',
    incomplete_harness_execution_receipt: 'Incomplete execution receipt: a harness row lacks the complete worker receipt that proves how it ran.',
    mixed_judge_lanes: 'Mixed judge lanes: some rows were judged through a harness and others directly.',
    mixed_judge_target: 'Mixed judge targets: its harness-judged rows came from more than one judge fingerprint.',
    incomplete_harness_judge_receipt: 'Incomplete judge receipt: a harness-judged row lacks the complete worker receipt for its judging.',
    not_rankable: 'Unranked by the server: the server excluded it from ranking without recording a reason.',
    no_score: 'No score: no generalist score was computed for these results.',
    unversioned_scorer: 'Unversioned scorer: its rows carry no scorer version, so they cannot be placed on a scorer generation.',
    scorer_version_family_mismatch: 'Other scorer generation: it was scored by a different scorer generation than the one the board compares.',
    partial_scope: 'Partial coverage: some category or required hard level lacks enough scored results. It still ranks; its score carries the coverage and hard-level penalties.',
    grader_unqualified: 'Grader not qualified: a judge behind these results failed its calibration for this scorer version or is not recorded, so this order is provisional and carries no medal.',
    grader_qualification_unknown: 'Grader qualification unknown: no complete calibration record covers this judge and scorer version, so this order is provisional and carries no medal.'
});

// Why a grader is not qualified, one phrase per cause code.
export const GRADER_CAUSE_TEXT = Object.freeze({
    judge_identity_missing: 'some judged results do not record which judge graded them',
    scorer_version_missing: 'some results carry no scorer version',
    mixed_scorer_versions: 'the results span several scorer versions',
    no_calibration_record: 'this judge has never been calibrated',
    calibration_for_other_scorer_version: 'this judge was calibrated only under another scorer version',
    calibration_incomplete: 'its latest calibration did not finish (environment, not grading quality)',
    calibration_reference_set_changed: 'its calibration used an older reference set',
    calibration_failed_ordering: 'calibration failed: pairwise ordering below the threshold',
    calibration_failed_mae: 'calibration failed: mean absolute error above the threshold',
    calibration_failed_identity: 'calibration failed: a reference answer was marked down',
    calibration_failed_attention: 'calibration failed: a known-answer attention probe',
    calibration_failed_unspecified: 'calibration failed without a recorded criterion'
});

export function describeGraderCause(code) {
    return GRADER_CAUSE_TEXT[code] || code;
}

/** Whether a row's rank is authoritative: comparable and graded by a qualified judge. */
export function isAuthoritative(entry) {
    if (!entry || !isComparable(entry)) return false;
    return entry.verdict?.authoritative === true;
}

/** Reason codes that keep a comparable row's rank provisional. */
export function authorityReasons(entry) {
    if (!entry || !isComparable(entry) || isAuthoritative(entry)) return [];
    const reasons = entry.verdict?.authorityReasons;
    return Array.isArray(reasons) && reasons.length ? reasons : ['grader_qualification_unknown'];
}

/** "judge @ host: cause; cause" lines for the grader behind a row. */
export function graderSummary(entry) {
    const grader = entry?.graderQualification;
    if (!grader) return [];
    const judges = Array.isArray(grader.judges) ? grader.judges : [];
    const lines = judges.map(judge => {
        const who = judge.model || judge.host
            ? `${judge.model || 'unknown judge'} @ ${judge.host || 'unknown host'}`
            : `unidentified judge${judge.rows ? ` (${judge.rows} result${judge.rows === 1 ? '' : 's'})` : ''}`;
        if (judge.status === 'qualified') {
            const at = judge.record?.recorded_at ? `, calibrated ${judge.record.recorded_at.slice(0, 10)}` : '';
            return `${who}: qualified for scorer ${grader.scorer_version}${at}`;
        }
        return `${who}: ${(judge.causes || []).map(describeGraderCause).join('; ') || judge.status}`;
    });
    const rowCauses = (grader.causes || []).filter(code => !judges.some(judge => (judge.causes || []).includes(code)));
    if (rowCauses.length) lines.push(rowCauses.map(describeGraderCause).join('; '));
    return lines;
}

export const HEADLINE_REASON_TEXT = Object.freeze({
    comparable_cohort: 'it is the cohort the board compares: the quality cohort (one judge, scorer version and context set for every model) covering the most models, and this model has results in it',
    pooled_cohorts: 'the local-only board pools every cohort of this model and host into one score, guarded against mixed scorer generations',
    latest_evidence: 'this model has no results in the cohort the board compares, so its most recent cohort is shown and it stays unranked'
});

export const HISTORY_REASON_TEXT = Object.freeze({
    other_cohort: 'not the cohort the board compares',
    older_evidence: 'older evidence than the headline'
});

/** One plain sentence for a reason code; the raw code when it is unknown. */
export function humanizeReason(code) {
    if (code === null || code === undefined || code === '') return 'Not comparable: no reason recorded.';
    return REASON_TEXT[code] || `Not comparable: ${code}.`;
}

/** The short label before the colon, for chips and the legend. */
export function reasonLabel(code) {
    const sentence = humanizeReason(code);
    const colon = sentence.indexOf(':');
    return colon > 0 ? sentence.slice(0, colon) : sentence;
}

export function shortCohort(fingerprint) {
    const text = String(fingerprint || '').replace(/^sha256:/, '');
    return text ? text.slice(0, 10) : 'none';
}

/**
 * Whether a row's verdict is comparable. The server settles this; a row from
 * a response without verdicts falls back to the same gate: rankable,
 * unfiltered and scored. Partial coverage does not block a rank.
 */
export function isComparable(entry) {
    if (!entry) return false;
    if (entry.verdict && typeof entry.verdict.comparable === 'boolean') return entry.verdict.comparable;
    return entry.rankable !== false && !entry.filtered
        && (entry.generalistScore ?? entry.score) != null;
}

/** Reason codes for a row that is not comparable; empty for a comparable row. */
export function verdictReasons(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.verdict?.reasons)) return entry.verdict.reasons;
    if (isComparable(entry)) return [];
    if (entry.filtered || entry.rankable === false) return [entry.filterReason || 'not_rankable'];
    return ['no_score'];
}

/** Whether a ranked row misses part of the full scope. */
export function isPartialCoverage(entry) {
    if (!entry) return false;
    if (Array.isArray(entry.verdict?.notes)) return entry.verdict.notes.includes('partial_scope');
    return entry.fullScopeEligible === false;
}

/** "Creative L4, Reasoning L5" — the required cells a row has no scored results for. */
export function coverageGaps(entry) {
    const missing = entry?.missingRequiredLevelsByCategory || {};
    return Object.entries(missing)
        .filter(([, levels]) => Array.isArray(levels) && levels.length)
        .map(([category, levels]) => `${category.charAt(0).toUpperCase()}${category.slice(1)} ${levels.map(level => `L${level}`).join('/')}`)
        .join(', ');
}

/** "Headline: cohort abc123 — because …" for a group. */
export function describeHeadline(group) {
    const headline = group?.headline || group || {};
    const cohort = shortCohort(headline.qualityCohortFingerprint);
    const reason = group?.headlineReason || null;
    if (!reason) {
        return `Headline: cohort ${cohort} — the only cohort of this model and host in view.`;
    }
    const text = HEADLINE_REASON_TEXT[reason] || `headline rule ${reason}`;
    return `Headline: cohort ${cohort} because ${text}.`;
}

/** Why a history row is not the headline. */
export function describeHistoryRow(row) {
    const reason = row?.historyReason || null;
    if (!reason) return 'not the headline';
    return HISTORY_REASON_TEXT[reason] || reason;
}

/** Every reason code present on a board, headline and history rows alike. */
export function collectReasonCodes(groups) {
    const codes = new Set();
    for (const group of groups || []) {
        for (const row of [group.headline, ...(group.history || [])]) {
            for (const code of [...verdictReasons(row), ...authorityReasons(row)]) codes.add(code);
            if (isPartialCoverage(row)) codes.add('partial_scope');
        }
    }
    return [...codes];
}

/** Legend for the reason codes on the board, plus what a rank means here. */
export function reasonLegendHtml(codes) {
    const items = (codes || []).map(code => `<dt data-reason="${esc(code)}">${esc(reasonLabel(code))}</dt><dd>${esc(humanizeReason(code))}</dd>`).join('');
    return `<details class="cb-legend">
    <summary>How to read verdicts and ranks</summary>
    <p>The score is the average judged quality over every category and level, minus a penalty for missing coverage and hard levels. A rank (#1, #2, …) orders the models judged on the same terms: one judge, one scorer generation and one prompt catalog. A model with partial coverage still ranks, with its gaps shown on the row. Results judged on other terms are listed apart, without a rank. A rank is authoritative only when the judge behind it passed calibration for the exact scorer version; otherwise it is marked provisional, carries no medal, and the causes are listed on the row. A rank measures benchmark results; it never changes routing.</p>
    ${items ? `<dl>${items}</dl>` : '<p>Every row on this board is ranked.</p>'}
  </details>`;
}
