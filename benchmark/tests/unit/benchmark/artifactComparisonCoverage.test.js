const {
    EXCLUSION_REASONS,
    exclusionReason,
    coverageForArm,
    promptKey
} = require('../../../src/services/benchmark/artifactComparisonCoverage');

function row(overrides = {}) {
    return {
        model: 'synthetic-a:q8', host: 'http://synthetic-host-a:11434', model_digest: 'digest-a',
        prompt_id: 'prompt-1', prompt_fingerprint: 'fp-1', prompt_name: 'Prompt 1', prompt_category: 'coding',
        quality_score: 8, judge_model: 'gemma4-synthetic:e4b', evaluation_authority: 'judge',
        quality_cohort_fingerprint: 'cohort-1', scorer_version: '3.1.0', repeat_index: 0,
        success: true, infra_error: null, needs_review: false, excluded_from_leaderboard: false,
        ...overrides
    };
}

describe('exclusionReason', () => {
    test('a clean row is eligible', () => {
        expect(exclusionReason(row())).toBeNull();
    });

    test('failed or infra-error rows are excluded', () => {
        expect(exclusionReason(row({ success: false }))).toBe('failed_or_infra_error');
        expect(exclusionReason(row({ success: true, infra_error: true }))).toBe('failed_or_infra_error');
    });

    test('review-needed rows are excluded even when they carry a score', () => {
        expect(exclusionReason(row({ needs_review: true, quality_score: 9 }))).toBe('needs_review');
    });

    test('leaderboard-excluded rows are excluded', () => {
        expect(exclusionReason(row({ excluded_from_leaderboard: true }))).toBe('excluded_from_leaderboard');
    });

    test('a missing prompt identity is excluded', () => {
        expect(exclusionReason(row({ prompt_id: null, prompt_name: null }))).toBe('missing_prompt_identity');
        expect(promptKey(row({ prompt_id: 'x' }))).toBe('id:x');
        expect(promptKey(row({ prompt_id: null, prompt_name: 'Fallback' }))).toBe('name:Fallback');
        expect(promptKey(row({ prompt_id: null, prompt_name: null }))).toBeNull();
    });

    test('missing or non-finite scores are excluded; a zero score is a score', () => {
        expect(exclusionReason(row({ quality_score: null }))).toBe('missing_or_non_finite_score');
        expect(exclusionReason(row({ quality_score: undefined }))).toBe('missing_or_non_finite_score');
        expect(exclusionReason(row({ quality_score: NaN }))).toBe('missing_or_non_finite_score');
        expect(exclusionReason(row({ quality_score: 0 }))).toBeNull();
    });

    test('reason precedence keeps one reason per row while the flags stay overlapping', () => {
        // This row is failed, review-needed and unscored: one row, three flags.
        const flagged = row({ success: false, needs_review: true, quality_score: null });
        expect(exclusionReason(flagged)).toBe('failed_or_infra_error');
        expect(EXCLUSION_REASONS).toEqual([
            'failed_or_infra_error', 'needs_review', 'excluded_from_leaderboard',
            'missing_prompt_identity', 'missing_or_non_finite_score'
        ]);
    });
});

describe('coverageForArm', () => {
    test('conserves the original row and prompt denominators', () => {
        const rows = [
            row(), row({ repeat_index: 1 }), // prompt-1, 2 repeats, both eligible
            row({ prompt_id: 'prompt-2', prompt_name: 'Prompt 2', quality_score: 6 }),
            row({ prompt_id: 'prompt-2', prompt_name: 'Prompt 2', repeat_index: 1, needs_review: true }) // partial
        ];
        const coverage = coverageForArm(rows);
        expect(coverage.originalRows).toBe(4);
        expect(coverage.originalPrompts).toBe(2);
        expect(coverage.includedRows).toBe(3);
        expect(coverage.includedPrompts).toBe(2);
        expect(coverage.excludedRows).toBe(1);
        expect(coverage.excludedPrompts).toBe(0);
        expect(coverage.partialPrompts).toBe(1);
        expect(coverage.reasons.needs_review).toBe(1);
        expect(coverage.includedRows + coverage.excludedRows).toBe(coverage.originalRows);
        expect(coverage.eligibleRows).toHaveLength(3);
    });

    test('an all-excluded arm keeps its denominators and empty eligible set', () => {
        const rows = [
            row({ excluded_from_leaderboard: true }),
            row({ prompt_id: 'prompt-2', prompt_name: 'Prompt 2', excluded_from_leaderboard: true })
        ];
        const coverage = coverageForArm(rows);
        expect(coverage).toMatchObject({
            originalRows: 2, originalPrompts: 2, includedRows: 0, includedPrompts: 0,
            excludedRows: 2, excludedPrompts: 2, partialPrompts: 0
        });
        expect(coverage.eligibleRows).toEqual([]);
    });

    test('missing identity rows have no prompt denominator but keep their row count', () => {
        const coverage = coverageForArm([row({ prompt_id: null, prompt_name: null, quality_score: null })]);
        expect(coverage).toMatchObject({
            originalRows: 1, originalPrompts: 0, includedRows: 0, excludedRows: 1, excludedPrompts: 0
        });
        expect(coverage.reasons.missing_prompt_identity).toBe(1);
    });

    test('reason counts may exceed the excluded rows because the flags overlap', () => {
        const coverage = coverageForArm([
            row({ success: false, infra_error: true, needs_review: true, excluded_from_leaderboard: true, quality_score: null }),
            row({ needs_review: true })
        ]);
        expect(coverage.excludedRows).toBe(2);
        const total = Object.values(coverage.reasons).reduce((sum, count) => sum + count, 0);
        expect(total).toBeGreaterThan(coverage.excludedRows);
        expect(coverage.reasons).toMatchObject({
            failed_or_infra_error: 1, needs_review: 2, excluded_from_leaderboard: 1, missing_or_non_finite_score: 0
        });
    });
});
