const {
    DEFAULT_GOLDSET_PATH,
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults
} = require('../../../src/services/benchmark/judgeCalibration');

describe('judgeCalibration', () => {
    it('loads and validates the default gold set', () => {
        const calibrationSet = loadCalibrationSet(DEFAULT_GOLDSET_PATH);

        expect(Array.isArray(calibrationSet)).toBe(true);
        expect(calibrationSet.length).toBeGreaterThan(0);
        expect(validateCalibrationSet(calibrationSet)).toBe(true);
    });

    it('evaluates score delta and review alignment for a calibration case', () => {
        const result = evaluateCalibrationCase(
            {
                id: 'coding-partial-bug',
                category: 'coding',
                level: 4,
                human_score: 5,
                tolerance: 1,
                expected_review: true
            },
            {
                quality_score: 5.8,
                needs_review: true
            }
        );

        expect(result.within_tolerance).toBe(true);
        expect(result.review_match).toBe(true);
        expect(result.score_delta).toBe(0.8);
    });

    it('summarizes calibration metrics across cases', () => {
        const summary = summarizeCalibrationResults([
            {
                actual_score: 8,
                score_delta: 0.5,
                within_tolerance: true,
                review_match: true
            },
            {
                actual_score: 4,
                score_delta: 1.5,
                within_tolerance: false,
                review_match: false
            },
            {
                actual_score: null,
                score_delta: null,
                within_tolerance: false,
                review_match: true
            }
        ]);

        expect(summary).toEqual({
            total_cases: 3,
            scored_cases: 2,
            within_tolerance_rate: 33,
            mae: 1,
            review_match_rate: 67
        });
    });
});
