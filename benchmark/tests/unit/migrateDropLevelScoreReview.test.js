'use strict';

const { reviewFields, retiredPenalty } = require('../../scripts/migrate-drop-level-score-review');

const REASON = 'Level-score mismatch penalty: high score on difficult prompt may indicate misunderstanding';

describe('dropping the retired level-score review penalty', () => {
    test('restores the confidence and clears review when the penalty was the only cause', () => {
        const fields = reviewFields({ prompt_level: 5, quality_score: 10, judge_confidence: 0.6, review_reason: REASON });
        expect(retiredPenalty(5, 10)).toBeCloseTo(0.25);
        expect(fields).toEqual({ judge_confidence: 0.85, needs_review: false, review_reason: null });
    });

    test('keeps review when another reason still requires it', () => {
        const fields = reviewFields({
            prompt_level: 4, quality_score: 9, judge_confidence: 0.5,
            review_reason: `${REASON}; Judge failed the known-answer attention check; verdicts may follow disposition rather than the question`
        });
        expect(fields.needs_review).toBe(true);
        expect(fields.review_reason).toBe('Judge failed the known-answer attention check; verdicts may follow disposition rather than the question');
    });

    test('keeps review when the restored confidence is still low', () => {
        const fields = reviewFields({ prompt_level: 3, quality_score: 8, judge_confidence: 0.4, review_reason: `${REASON}; Dimension outlier` });
        expect(fields.needs_review).toBe(true);
        expect(fields.review_reason).toBe('Dimension outlier');
    });
});
