const BenchmarkResult = require('../../../models/BenchmarkResult');
const {
    pairedModelCompare,
    assessComparability,
    getBatchPromptScores
} = require('../../../src/services/benchmark/regressionDetector');

function mk(prompts) {
    const entries = Object.entries(prompts);
    return {
        prompts: Object.fromEntries(entries.map(([name, value]) => [
            name,
            typeof value === 'number' ? { q: value, category: 'reasoning' } : value
        ])),
        avg_quality: entries.reduce((sum, [, value]) => sum + (typeof value === 'number' ? value : value.q), 0) / entries.length
    };
}

describe('pairedModelCompare', () => {
    test('ignores unpaired hard prompts when shared prompts did not regress', () => {
        const previous = mk({ a: 8, b: 8, c: 8 });
        const current = mk({ a: 8, b: 8, c: 8, hard1: 2, hard2: 2, hard3: 2 });

        const result = pairedModelCompare(current, previous);

        expect(result.method).toBe('paired');
        expect(result.meanDelta).toBe(0);
        expect(result.previous).toBe(80);
        expect(result.current).toBe(80);
    });

    test('requires paired confidence interval to exclude zero', () => {
        const result = pairedModelCompare(
            mk({ a: 8.1, b: 7.9, c: 8.2 }),
            mk({ a: 8.0, b: 8.0, c: 8.0 })
        );

        expect(result.method).toBe('paired');
        expect(result.significant).toBe(false);
    });

    test('falls back to low confidence when overlap is too small', () => {
        const result = pairedModelCompare(mk({ a: 8, b: 8 }), mk({ c: 5, d: 5 }));

        expect(result.method).toBe('unpaired_low_confidence');
        expect(result.significant).toBe(false);
        expect(result.n_pairs).toBe(0);
    });

    test('reports category deltas only from paired prompts', () => {
        const result = pairedModelCompare(
            mk({
                a: { q: 6, category: 'math' },
                b: { q: 6, category: 'math' },
                c: { q: 8, category: 'coding' }
            }),
            mk({
                a: { q: 8, category: 'math' },
                b: { q: 8, category: 'math' },
                c: { q: 8, category: 'coding' }
            })
        );

        expect(result.categoryDeltas).toEqual([
            expect.objectContaining({ category: 'math', meanDelta: -20, n: 2 })
        ]);
    });
});

describe('assessComparability', () => {
    test('accepts same major.minor scorer versions', () => {
        expect(assessComparability(['2.3.0'], ['2.3.4']).comparable).toBe(true);
    });

    test('rejects mixed versioned and unversioned batches', () => {
        const result = assessComparability(['2.3.0'], [null]);
        expect(result.comparable).toBe(false);
        expect(result.warnings.join(' ')).toMatch(/unversioned/);
    });
});

// Prompt names are literal data, including JavaScript's special property names.
// Build them from entries so the fixture itself does not use __proto__ setters.
const namedScores = (entries) => mk(Object.fromEntries(entries));

describe('literal prompt identities', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
        'does not pair a current-only %s name with an inherited property', (name) => {
            const result = pairedModelCompare(
                namedScores([['a', 8], ['b', 8], [name, 9]]),
                mk({ a: 8, b: 8, c: 8 })
            );
            expect(result).toEqual(expect.objectContaining({
                method: 'unpaired_low_confidence', n_pairs: 2, significant: false,
                previous: 80, current: 83.3, meanDelta: 3.3, ci_margin: null,
                categoryDeltas: []
            }));
        }
    );

    test('keeps statistics and category deltas on three genuine pairs', () => {
        const result = pairedModelCompare(
            namedScores([['a', 6], ['b', 6], ['c', 6], ['constructor', 1]]),
            mk({ a: 8, b: 8, c: 8 })
        );
        expect(result).toEqual(expect.objectContaining({
            method: 'paired', n_pairs: 3, previous: 80, current: 60,
            meanDelta: -20, ci_margin: 0, significant: true,
            categoryDeltas: [{ category: 'reasoning', n: 3, meanDelta: -20, previous: 80, current: 60 }]
        }));
    });

    test('retains genuine own observations for every special name', () => {
        const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
        const result = pairedModelCompare(
            namedScores(names.map(name => [name, 6])),
            namedScores(names.map(name => [name, 8]))
        );
        expect(result).toEqual(expect.objectContaining({
            method: 'paired', n_pairs: 4, previous: 80, current: 60,
            meanDelta: -20, significant: true
        }));
    });

    test('ignores an inherited custom score rather than treating it as an observation', () => {
        const previous = mk({ a: 8, b: 8, c: 8 });
        previous.prompts = Object.assign(Object.create({ inherited: { q: 1, category: 'reasoning' } }), previous.prompts);
        const result = pairedModelCompare(mk({ a: 8, b: 8, c: 8, inherited: 8 }), previous);
        expect(result).toEqual(expect.objectContaining({ n_pairs: 3, meanDelta: 0, previous: 80, current: 80 }));
    });

    test('aggregates all literal names into own observations without altering the prototype', async () => {
        const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'ordinary'];
        jest.spyOn(BenchmarkResult, 'aggregate').mockResolvedValueOnce(names.map((name, index) => ({
            _id: { model: 'model', host: 'host', prompt_name: name, category: 'reasoning' },
            avg_quality: index + 4
        })));
        const entry = (await getBatchPromptScores('current')).get('model@@host');
        expect(Object.keys(entry.prompts).sort()).toEqual([...names].sort());
        names.forEach((name, index) => {
            expect(Object.prototype.hasOwnProperty.call(entry.prompts, name)).toBe(true);
            expect(entry.prompts[name]).toEqual({ q: index + 4, category: 'reasoning' });
        });
        expect(entry.avg_quality).toBe(6);
        expect(Object.getPrototypeOf(entry.prompts)).not.toEqual(expect.objectContaining({ q: expect.any(Number) }));
    });

    test('preserves the missing-name fallback for ordinary aggregation', async () => {
        jest.spyOn(BenchmarkResult, 'aggregate').mockResolvedValueOnce([{
            _id: { model: 'model', host: 'host', prompt_name: null, category: 'reasoning' }, avg_quality: 7
        }]);
        const entry = (await getBatchPromptScores('current')).get('model@@host');
        expect(Object.entries(entry.prompts)).toEqual([['__unnamed_0', { q: 7, category: 'reasoning' }]]);
        expect(entry.avg_quality).toBe(7);
    });
});
