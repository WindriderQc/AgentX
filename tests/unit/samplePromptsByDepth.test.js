/**
 * Unit Tests for samplePromptsByDepth
 */

const { samplePromptsByDepth } = require('../../src/services/benchmark/promptSampling');

// Helper to generate mock prompts
function makePrompts(level, category, count, opts) {
    const prompts = [];
    for (let i = 1; i <= count; i++) {
        prompts.push({
            level,
            category,
            prompt: `L${level}-${category}-${i}`,
            _id: `${level}_${category}_${i}`,
            ...(opts && opts.representative && i === 1 ? { representative: true } : {})
        });
    }
    return prompts;
}

// Build a realistic prompt set matching the documented distribution
function buildFullPromptSet() {
    const prompts = [];
    // Levels 1-3: 16 prompts, 10 categories (roughly 1-2 per cat)
    for (let level = 1; level <= 3; level++) {
        for (let cat = 1; cat <= 10; cat++) {
            const count = cat <= 6 ? 2 : 1; // 6 cats × 2 + 4 cats × 1 = 16
            // Mark first category's first prompt as representative
            prompts.push(...makePrompts(level, `cat${cat}`, count, cat === 1 ? { representative: true } : {}));
        }
    }
    // Levels 4-5: 22 prompts, 10 categories
    for (let level = 4; level <= 5; level++) {
        for (let cat = 1; cat <= 10; cat++) {
            const count = cat <= 2 ? 3 : 2; // 2 cats × 3 + 8 cats × 2 = 22
            prompts.push(...makePrompts(level, `cat${cat}`, count, cat === 1 ? { representative: true } : {}));
        }
    }
    // Levels 6-8: 12 prompts, 6 categories (2 each)
    for (let level = 6; level <= 8; level++) {
        for (let cat = 1; cat <= 6; cat++) {
            prompts.push(...makePrompts(level, `cat${cat}`, 2, cat === 1 ? { representative: true } : {}));
        }
    }
    // Levels 9-10: 6 prompts, 6 categories (1 each)
    for (let level = 9; level <= 10; level++) {
        for (let cat = 1; cat <= 6; cat++) {
            prompts.push(...makePrompts(level, `cat${cat}`, 1, cat === 1 ? { representative: true } : {}));
        }
    }
    return prompts;
}

describe('samplePromptsByDepth', () => {
    const allPrompts = buildFullPromptSet();

    describe('depth: off', () => {
        it('should return no prompts for levels set to off', () => {
            const config = { 1: 'off', 2: 'off', 3: 'off' };
            const level1to3 = allPrompts.filter(p => p.level <= 3);
            const result = samplePromptsByDepth(level1to3, config);
            expect(result).toHaveLength(0);
        });
    });

    describe('depth: full', () => {
        it('should return all prompts for a level', () => {
            const config = { 1: 'full' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(level1.length);
        });

        it('should include every prompt (no filtering)', () => {
            const config = { 6: 'full' };
            const level6 = allPrompts.filter(p => p.level === 6);
            const result = samplePromptsByDepth(level6, config);
            expect(result).toEqual(expect.arrayContaining(level6));
        });
    });

    describe('depth: single', () => {
        it('should return exactly 1 prompt for the level', () => {
            const config = { 4: 'single' };
            const level4 = allPrompts.filter(p => p.level === 4);
            const result = samplePromptsByDepth(level4, config);
            expect(result).toHaveLength(1);
            expect(level4).toContainEqual(result[0]);
        });

        it('should pick the representative prompt deterministically', () => {
            const config = { 1: 'single' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(1);
            expect(result[0].representative).toBe(true);
        });

        it('should return the same prompt every time (deterministic)', () => {
            const config = { 1: 'single' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const results = [];
            for (let i = 0; i < 10; i++) {
                results.push(samplePromptsByDepth(level1, config)[0]);
            }
            // All 10 runs should return the exact same prompt
            const first = results[0];
            expect(results.every(r => r._id === first._id)).toBe(true);
        });

        it('should fall back to first prompt when no representative exists', () => {
            const noRepPrompts = [
                { level: 50, category: 'a', prompt: 'first', _id: '50_1' },
                { level: 50, category: 'b', prompt: 'second', _id: '50_2' },
            ];
            const result = samplePromptsByDepth(noRepPrompts, { 50: 'single' });
            expect(result).toHaveLength(1);
            expect(result[0]._id).toBe('50_1');
        });
    });

    describe('depth: light', () => {
        it('should return 1 prompt per category', () => {
            const config = { 1: 'light' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            // Level 1 has 10 categories
            expect(result).toHaveLength(10);
            // Verify each category represented exactly once
            const categories = result.map(p => p.category);
            expect(new Set(categories).size).toBe(10);
        });

        it('should return 1 prompt per category for levels with fewer categories', () => {
            const config = { 9: 'light' };
            const level9 = allPrompts.filter(p => p.level === 9);
            const result = samplePromptsByDepth(level9, config);
            // Level 9 has 6 categories with 1 prompt each
            expect(result).toHaveLength(6);
        });
    });

    describe('mixed depths across levels', () => {
        it('should handle different depths for different levels', () => {
            const config = {
                1: 'full',
                2: 'light',
                3: 'off',
                4: 'single',
                5: 'full'
            };
            const prompts = allPrompts.filter(p => p.level <= 5);
            const result = samplePromptsByDepth(prompts, config);

            const byLevel = {};
            result.forEach(p => {
                if (!byLevel[p.level]) byLevel[p.level] = [];
                byLevel[p.level].push(p);
            });

            expect(byLevel[1] || []).toHaveLength(16);
            expect(byLevel[2] || []).toHaveLength(10);
            expect(byLevel[3]).toBeUndefined();
            expect(byLevel[4] || []).toHaveLength(1);
            expect(byLevel[5] || []).toHaveLength(22);
        });
    });

    describe('edge cases', () => {
        it('should return empty array for empty prompts', () => {
            const result = samplePromptsByDepth([], { 1: 'full' });
            expect(result).toHaveLength(0);
        });

        it('should handle string level keys in config', () => {
            const config = { '1': 'full' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(level1.length);
        });

        it('should treat missing config levels as off', () => {
            const config = { 1: 'full' }; // No config for level 2
            const prompts = allPrompts.filter(p => p.level <= 2);
            const result = samplePromptsByDepth(prompts, config);
            expect(result.every(p => p.level === 1)).toBe(true);
        });

        it('should handle a level with only 1 prompt at any depth', () => {
            const singlePrompt = [{ level: 99, category: 'solo', prompt: 'test', _id: '99_1' }];
            expect(samplePromptsByDepth(singlePrompt, { 99: 'full' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'light' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'single' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'off' })).toHaveLength(0);
        });

        it('should handle unknown depth value as off', () => {
            const config = { 1: 'unknown_depth' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(0);
        });
    });
});
