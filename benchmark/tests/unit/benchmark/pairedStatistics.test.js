const {
    MIN_PAIRS,
    bootstrapMeanInterval,
    normalizeBootstrapOptions,
    seededRandom,
    summarizePairedDeltas
} = require('../../../src/services/benchmark/pairedStatistics');

// Deterministic deltas: a known mean effect plus centred noise of a given spread.
function deltasWithEffect(effect, n, spread, seed = 7) {
    const random = seededRandom(seed);
    const noise = Array.from({ length: n }, () => (random() - 0.5) * 2 * spread);
    const offset = noise.reduce((sum, value) => sum + value, 0) / n;
    return noise.map((value) => effect + value - offset);
}

describe('summarizePairedDeltas', () => {
    test('detects a known effect and recovers its size', () => {
        const result = summarizePairedDeltas(deltasWithEffect(-3, 40, 4));
        expect(result.method).toBe('paired_bootstrap');
        expect(result.meanDelta).toBe(-3);
        expect(result.significant).toBe(true);
        expect(result.bootstrapInterval[1]).toBeLessThan(0);
        expect(result.tInterval[0]).toBeLessThan(-3);
        expect(result.tInterval[1]).toBeGreaterThan(-3);
        expect(result.lowPairCount).toBe(false);
    });

    test('does not call noise a difference', () => {
        const result = summarizePairedDeltas(deltasWithEffect(0, 40, 6));
        expect(result.meanDelta).toBe(0);
        expect(result.significant).toBe(false);
        expect(result.bootstrapInterval[0]).toBeLessThan(0);
        expect(result.bootstrapInterval[1]).toBeGreaterThan(0);
    });

    test('reports a smallest detectable difference that shrinks with more prompts', () => {
        const few = summarizePairedDeltas(deltasWithEffect(0, 15, 10));
        const many = summarizePairedDeltas(deltasWithEffect(0, 60, 10));
        expect(few.minimumDetectableDelta).toBeGreaterThan(many.minimumDetectableDelta);
        // With 15 prompts and ~6 points of spread per prompt, about 4–5 points is the floor.
        expect(few.minimumDetectableDelta).toBeGreaterThan(3);
        expect(few.lowPairCount).toBe(false);
        expect(summarizePairedDeltas(deltasWithEffect(0, 8, 10)).lowPairCount).toBe(true);
    });

    test('refuses an interval below the minimum number of pairs', () => {
        const result = summarizePairedDeltas([5, -5].slice(0, MIN_PAIRS - 1));
        expect(result).toMatchObject({ method: 'insufficient_pairs', significant: false, bootstrapInterval: null, tInterval: null });
    });
});

describe('bootstrap seed compatibility', () => {
    const draws = (seed) => {
        const random = seededRandom(seed);
        return Array.from({ length: 3 }, () => random());
    };
    const seedOne = [0.6270739405881613, 0.002735721180215478, 0.5274470399599522];
    const values = [-12, -7, -3, 0, 1, 2, 4, 6, 9, 15, 17, 22, 31];

    test('honors zero and numeric zero strings with reproducible mulberry32 draws', () => {
        const expected = [0.26642920868471265, 0.0003297457005828619, 0.2232720274478197];
        expect(draws(0)).toEqual(expected);
        expect(draws(0)).toEqual(expected);
        expect(draws('0')).toEqual(expected);
        expect(draws(-0)).toEqual(expected);
    });

    test('preserves the default, invalid-input and wrapped nonzero fallbacks', () => {
        for (const seed of [undefined, NaN, Infinity, 'invalid', 1, 2 ** 32, -(2 ** 32)]) {
            expect(draws(seed)).toEqual(seedOne);
        }
    });

    test.each([
        [7, [0.011704753153026104, 0.06195825757458806, 0.97690763277933]],
        [42, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099]],
        [4294967295, [0.8964226141106337, 0.189478256739676, 0.7156526781618595]]
    ])('preserves the historical stream for seed %s', (seed, expected) => {
        expect(draws(seed)).toEqual(expected);
    });

    test.each([
        [200, [0.9980769230769231, 12.930769230769233]],
        [2000, [0.45961538461538476, 13.001923076923067]]
    ])('uses the zero stream for a bootstrap with %s iterations', (iterations, expected) => {
        const input = values.slice();
        expect(normalizeBootstrapOptions({ seed: 0, iterations })).toEqual({ seed: 0, iterations });
        expect(bootstrapMeanInterval(input, { seed: 0, iterations })).toEqual(expected);
        expect(input).toEqual(values);
    });

    test('reports the interval computed from seed zero in the paired summary', () => {
        expect(summarizePairedDeltas(values, { seed: 0 }).bootstrapInterval).toEqual([0.5, 13]);
        expect(summarizePairedDeltas(values)).toEqual(summarizePairedDeltas(values, { seed: 1 }));
    });
});

describe('bootstrap', () => {
    test('returns the same interval for the same seed and a different one for another seed', () => {
        const values = deltasWithEffect(1, 25, 5);
        expect(bootstrapMeanInterval(values, { seed: 3 })).toEqual(bootstrapMeanInterval(values, { seed: 3 }));
        expect(bootstrapMeanInterval(values, { seed: 3 })).not.toEqual(bootstrapMeanInterval(values, { seed: 4 }));
    });

    test('bounds the number of iterations', () => {
        expect(normalizeBootstrapOptions({ iterations: 5 }).iterations).toBe(200);
        expect(normalizeBootstrapOptions({ iterations: 10 ** 9 }).iterations).toBe(20000);
        expect(normalizeBootstrapOptions({})).toEqual({ iterations: 2000, seed: 1 });
    });
});
