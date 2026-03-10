/**
 * Unit tests for promptSampling
 * Pure functions — no mocks needed.
 */
const { groupBy, randomPick, samplePromptsByDepth } = require('../../../src/services/benchmark/promptSampling');

describe('groupBy', () => {
    it('groups by string key', () => {
        const items = [
            { cat: 'a', v: 1 },
            { cat: 'b', v: 2 },
            { cat: 'a', v: 3 }
        ];
        const groups = groupBy(items, 'cat');
        expect(groups.a).toHaveLength(2);
        expect(groups.b).toHaveLength(1);
    });

    it('groups by function', () => {
        const groups = groupBy([1, 2, 3, 4], x => x % 2 === 0 ? 'even' : 'odd');
        expect(groups.even).toEqual([2, 4]);
        expect(groups.odd).toEqual([1, 3]);
    });

    it('returns empty object for empty array', () => {
        expect(groupBy([], 'key')).toEqual({});
    });
});

describe('randomPick', () => {
    it('returns all items when n >= array length', () => {
        const arr = [1, 2, 3];
        expect(randomPick(arr, 5)).toHaveLength(3);
        expect(randomPick(arr, 3)).toHaveLength(3);
    });

    it('returns exactly n items when n < array length', () => {
        const arr = [1, 2, 3, 4, 5];
        expect(randomPick(arr, 2)).toHaveLength(2);
        expect(randomPick(arr, 1)).toHaveLength(1);
    });

    it('returns empty array for empty input', () => {
        expect(randomPick([], 1)).toEqual([]);
    });

    it('does not mutate the original array', () => {
        const arr = [1, 2, 3, 4, 5];
        const copy = [...arr];
        randomPick(arr, 3);
        expect(arr).toEqual(copy);
    });

    it('returns n = 0 as empty array', () => {
        expect(randomPick([1, 2, 3], 0)).toHaveLength(0);
    });
});

describe('samplePromptsByDepth', () => {
    const prompts = [
        { level: 1, category: 'coding', text: 'c1' },
        { level: 1, category: 'coding', text: 'c2' },
        { level: 1, category: 'coding', text: 'c3' },
        { level: 1, category: 'reasoning', text: 'r1' },
        { level: 1, category: 'reasoning', text: 'r2' },
        { level: 2, category: 'coding', text: 'c4' },
        { level: 2, category: 'math', text: 'm1' },
    ];

    it('returns empty for all-off depth config', () => {
        const result = samplePromptsByDepth(prompts, { 1: 'off', 2: 'off' });
        expect(result).toHaveLength(0);
    });

    it('returns all prompts for full depth', () => {
        const result = samplePromptsByDepth(prompts, { 1: 'full', 2: 'full' });
        expect(result).toHaveLength(prompts.length);
    });

    it('single depth returns exactly one prompt per level (not per category)', () => {
        const result = samplePromptsByDepth(prompts, { 1: 'single' });
        expect(result).toHaveLength(1);
    });

    it('single depth does not push undefined for empty levels', () => {
        const sparsePrompts = [{ level: 1, category: 'coding', text: 'c1' }];
        // level 99 has no prompts — should produce nothing, not undefined
        const result = samplePromptsByDepth(sparsePrompts, { 1: 'single', 99: 'single' });
        expect(result).not.toContain(undefined);
        expect(result).toHaveLength(1);
    });

    it('light depth returns one prompt per category per level', () => {
        const result = samplePromptsByDepth(prompts, { 1: 'light' });
        // level 1 has 2 categories: coding and reasoning → 2 prompts
        expect(result).toHaveLength(2);
    });

    it('half depth returns roughly half per category', () => {
        const result = samplePromptsByDepth(prompts, { 1: 'half' });
        // coding (3) → ceil(3/2) = 2, reasoning (2) → ceil(2/2) = 1 → total = 3
        expect(result).toHaveLength(3);
    });

    it('omits levels not in depth config', () => {
        // Only configure level 2; level 1 prompts should not appear
        const result = samplePromptsByDepth(prompts, { 2: 'full' });
        expect(result.every(p => p.level === 2)).toBe(true);
        expect(result).toHaveLength(2);
    });

    it('returns empty array for empty prompts input', () => {
        const result = samplePromptsByDepth([], { 1: 'full' });
        expect(result).toHaveLength(0);
    });
});
