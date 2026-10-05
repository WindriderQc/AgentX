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
