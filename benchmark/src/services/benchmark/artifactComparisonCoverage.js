'use strict';

/**
 * Score eligibility and pairing coverage for the paired artifact comparison.
 *
 * A loaded result row is one measurement the arm ran. It only enters the
 * paired statistics when it is eligible: it ran successfully, is not an
 * infrastructure failure, does not await manual review, is not excluded from
 * the leaderboard, has a usable prompt identity and carries a finite score.
 * Everything else is excluded, with the first reason it failed.
 *
 * The reasons are overlapping flags, not a partition: one row can fail several
 * at once. Every applicable flag is counted for that row, so the per-reason
 * counts account for the overlap and intentionally add up to more than the
 * number of excluded rows; each excluded row carries at least one of them.
 *
 * A zero score is a score: `quality_score === 0` is a legitimate 0-point
 * answer and is eligible. A missing, pending or review-needed score is
 * provisional: it is excluded and never silently accepted or turned into 0.
 */

const EXCLUSION_REASONS = Object.freeze([
    'failed_or_infra_error',
    'needs_review',
    'excluded_from_leaderboard',
    'missing_prompt_identity',
    'missing_or_non_finite_score'
]);

function promptKey(row) {
    if (row.prompt_id) return `id:${row.prompt_id}`;
    return row.prompt_name ? `name:${row.prompt_name}` : null;
}

/** Every eligibility flag a row carries; the row is excluded if any apply. */
function exclusionFlags(row) {
    const flags = [];
    if (row.success === false || row.infra_error === true) flags.push('failed_or_infra_error');
    if (row.needs_review === true) flags.push('needs_review');
    if (row.excluded_from_leaderboard === true) flags.push('excluded_from_leaderboard');
    if (!promptKey(row)) flags.push('missing_prompt_identity');
    const score = row.quality_score;
    if (score === null || score === undefined || !Number.isFinite(score)) flags.push('missing_or_non_finite_score');
    return flags;
}

/** The first eligibility reason a row fails, or null when it is eligible. */
function exclusionReason(row) {
    return exclusionFlags(row)[0] || null;
}

/**
 * The coverage of one arm's loaded rows. `rows` is the full set loaded for the
 * arm (before eligibility); `eligibleRows` is the subset that enters the
 * statistics. `partialPrompts` are prompts with at least one, but not all, of
 * their repeats eligible: their average then covers fewer runs than the arm's
 * repeats, so the pairing is partial and visible.
 */
function coverageForArm(rows) {
    const eligibleRows = [];
    const reasonCounts = {};
    for (const reason of EXCLUSION_REASONS) reasonCounts[reason] = 0;

    const promptsByEligibility = new Map();
    let eligiblePromptCount = 0;
    for (const row of rows) {
        const key = promptKey(row);
        const flags = exclusionFlags(row);
        const eligible = flags.length === 0;
        if (eligible) {
            eligibleRows.push(row);
        } else {
            // Overlapping flags: each applicable flag is counted for the row.
            for (const flag of flags) reasonCounts[flag] += 1;
        }

        if (key) {
            let prompt = promptsByEligibility.get(key);
            if (!prompt) {
                prompt = { key, eligible: 0, total: 0 };
                promptsByEligibility.set(key, prompt);
            }
            prompt.total += 1;
            if (eligible) prompt.eligible += 1;
        }
    }
    for (const prompt of promptsByEligibility.values()) {
        if (prompt.eligible > 0) eligiblePromptCount += 1;
    }

    const originalPromptCount = promptsByEligibility.size;
    const excludedPromptCount = originalPromptCount - eligiblePromptCount;
    const partialPromptCount = [...promptsByEligibility.values()].filter((prompt) => prompt.eligible > 0 && prompt.eligible < prompt.total).length;

    return {
        originalRows: rows.length,
        originalPrompts: originalPromptCount,
        includedRows: eligibleRows.length,
        includedPrompts: eligiblePromptCount,
        excludedRows: rows.length - eligibleRows.length,
        excludedPrompts: excludedPromptCount,
        partialPrompts: partialPromptCount,
        // Overlapping flags, not a partition: the counts may sum above excludedRows.
        reasons: reasonCounts,
        eligibleRows
    };
}

module.exports = {
    EXCLUSION_REASONS,
    promptKey,
    exclusionFlags,
    exclusionReason,
    coverageForArm
};
