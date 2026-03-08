/**
 * Unit tests for generalistScore pure functions.
 * Tests the scoring formula, normalization, and category handling.
 */

const {
    normalizeQualityTo100,
    normalizeCategoryKey,
    calculateGeneralistScoreFromCategories,
    confidenceMargin,
    COVERAGE_PENALTY_MAX,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    EMPTY_RESPONSE_FILTER_THRESHOLD
} = require('../../../src/services/benchmark/generalistScore');

// Minimal weight map used in all formula tests so results are deterministic
// regardless of changes to the real GENERALIST_CATEGORY_WEIGHTS config.
const TEST_WEIGHTS = {
    coding: 0.40,
    reasoning: 0.40,
    math: 0.20
};

describe('normalizeQualityTo100', () => {
    it('converts 0-10 scale to 0-100', () => {
        expect(normalizeQualityTo100(7.5)).toBe(75);
        expect(normalizeQualityTo100(10)).toBe(100);
        expect(normalizeQualityTo100(0)).toBe(0);
    });

    it('clamps out-of-range 0-10 values', () => {
        expect(normalizeQualityTo100(-1)).toBe(0);
        expect(normalizeQualityTo100(11)).toBe(100);
    });

    it('handles non-finite gracefully', () => {
        expect(normalizeQualityTo100(null)).toBe(0);
        expect(normalizeQualityTo100(undefined)).toBe(0);
        expect(normalizeQualityTo100('abc')).toBe(0);
        expect(normalizeQualityTo100(NaN)).toBe(0);
    });
});

describe('normalizeCategoryKey', () => {
    it('normalizes "code" alias to "coding"', () => {
        expect(normalizeCategoryKey('code')).toBe('coding');
    });

    it('converts snake_case to kebab-case', () => {
        expect(normalizeCategoryKey('context_retention')).toBe('context-retention');
        expect(normalizeCategoryKey('multi_turn_reasoning')).toBe('multi-turn-reasoning');
    });

    it('lowercases and trims whitespace', () => {
        expect(normalizeCategoryKey('  Debugging  ')).toBe('debugging');
        expect(normalizeCategoryKey('CODING')).toBe('coding');
    });

    it('returns null for falsy input', () => {
        expect(normalizeCategoryKey('')).toBeNull();
        expect(normalizeCategoryKey(null)).toBeNull();
        expect(normalizeCategoryKey(undefined)).toBeNull();
    });
});

describe('calculateGeneralistScoreFromCategories', () => {
    describe('perfect coverage', () => {
        it('computes weighted quality when all categories have scores', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 0.5, attempted: true },
                reasoning: { avg: 6, count: 5, stddev: 0.5, attempted: true },
                math: { avg: 10, count: 5, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            // weightedQuality = (8*10*0.4 + 6*10*0.4 + 10*10*0.2) / 1.0
            // = (32 + 24 + 20) = 76
            expect(result.generalistScore).toBeCloseTo(76 + CONSISTENCY_BONUS, 1);
            expect(result.coveragePenalty).toBe(0);
            expect(result.coverage).toBe(100);
            expect(result.testedCategories).toBe(3);
        });
    });

    describe('coverage penalty', () => {
        it('penalizes missing categories proportional to weight', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, attempted: true }
                // reasoning (0.40) and math (0.20) are missing
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            const expectedPenalty = (0.40 + 0.20) * COVERAGE_PENALTY_MAX; // 12.0
            expect(result.coveragePenalty).toBeCloseTo(expectedPenalty, 1);
        });

        it('coverage percent reflects tested fraction', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 0, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.coverage).toBe(33); // 1/3 = 33%
        });
    });

    describe('attempted-but-no-score (infrastructure / judge failures)', () => {
        it('does not penalize coverage for attempted categories with no quality score', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, attempted: true },
                reasoning: { attempted: true, count: 0 },  // infra/judge failure
                math: { avg: 7, count: 3, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.coveragePenalty).toBe(0);
            expect(result.coverage).toBe(100);
            expect(result.testedCategories).toBe(3);
        });

        it('treats judge_failed categories (count=0, attempted=true) same as infra failures', () => {
            const scores = {
                coding: { avg: 7, count: 3, stddev: 0.5, attempted: true },
                reasoning: { attempted: true, count: 0, judge_failed: true },
                math: { avg: 9, count: 2, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.coveragePenalty).toBe(0);
            expect(result.testedCategories).toBe(3);
        });
    });

    describe('consistency bonus', () => {
        it('awards bonus when avg within-category stddev is below threshold', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 0.5, attempted: true },
                reasoning: { avg: 8, count: 3, stddev: 0.5, attempted: true },
                math: { avg: 8, count: 3, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            // avg stddev = 5 (normalized to 0-100) < CONSISTENCY_STDDEV_THRESHOLD (15)
            expect(result.consistencyBonus).toBe(CONSISTENCY_BONUS);
        });

        it('withholds bonus when avg stddev exceeds threshold', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 2, attempted: true },    // 20 on 0-100
                reasoning: { avg: 8, count: 3, stddev: 2, attempted: true }, // 20 on 0-100
                math: { avg: 8, count: 3, stddev: 2, attempted: true }       // 20 on 0-100
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.consistencyBonus).toBe(0);
        });

        it('withholds consistency bonus for near-zero quality models', () => {
            const scores = {
                coding: { avg: 0.5, count: 3, stddev: 0.1, attempted: true },
                reasoning: { avg: 0.5, count: 3, stddev: 0.1, attempted: true },
                math: { avg: 0.5, count: 3, stddev: 0.1, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.consistencyBonus).toBe(0);
        });
    });

    describe('edge cases', () => {
        it('returns zero generalistScore for empty scores', () => {
            const result = calculateGeneralistScoreFromCategories({}, TEST_WEIGHTS);
            expect(result.generalistScore).toBe(0);
            expect(result.testedCategories).toBe(0);
        });

        it('generalistScore is never negative', () => {
            // Extreme penalty scenario
            const result = calculateGeneralistScoreFromCategories({
                coding: { avg: 0.1, count: 1, attempted: true }
            }, TEST_WEIGHTS);
            expect(result.generalistScore).toBeGreaterThanOrEqual(0);
        });

        it('handles null/undefined weights gracefully', () => {
            const result = calculateGeneralistScoreFromCategories({}, null);
            expect(result.generalistScore).toBe(0);
        });
    });
});

describe('confidenceMargin', () => {
    it('returns null for n < 2', () => {
        expect(confidenceMargin(10, 1)).toBeNull();
        expect(confidenceMargin(10, 0)).toBeNull();
    });

    it('returns null for non-finite stddev', () => {
        expect(confidenceMargin(NaN, 5)).toBeNull();
    });

    it('decreases as n increases', () => {
        const small = confidenceMargin(15, 3);
        const large = confidenceMargin(15, 30);
        expect(small).toBeGreaterThan(large);
    });
});

describe('constants sanity checks', () => {
    it('COVERAGE_PENALTY_MAX is positive', () => {
        expect(COVERAGE_PENALTY_MAX).toBeGreaterThan(0);
    });

    it('CONSISTENCY_BONUS is positive', () => {
        expect(CONSISTENCY_BONUS).toBeGreaterThan(0);
    });

    it('EMPTY_RESPONSE_FILTER_THRESHOLD is between 0 and 1', () => {
        expect(EMPTY_RESPONSE_FILTER_THRESHOLD).toBeGreaterThan(0);
        expect(EMPTY_RESPONSE_FILTER_THRESHOLD).toBeLessThanOrEqual(1);
    });
});
