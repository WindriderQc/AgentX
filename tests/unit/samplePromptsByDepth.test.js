/**
 * Unit Tests for samplePromptsByDepth
 */

const { samplePromptsByDepth } = require('../../src/services/benchmark/execution');

// Helper to generate mock prompts
function makePrompts(level, category, count) {
    const prompts = [];
    for (let i = 1; i <= count; i++) {
        prompts.push({
            level,
            category,
            prompt: `L${level}-${category}-${i}`,
            _id: `${level}_${category}_${i}`
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
            prompts.push(...makePrompts(level, `cat${cat}`, count));
        }
    }
    // Levels 4-5: 22 prompts, 10 categories
    for (let level = 4; level <= 5; level++) {
        for (let cat = 1; cat <= 10; cat++) {
            const count = cat <= 2 ? 3 : 2; // 2 cats × 3 + 8 cats × 2 = 22
            prompts.push(...makePrompts(level, `cat${cat}`, count));
        }
    }
    // Levels 6-8: 12 prompts, 6 categories (2 each)
    for (let level = 6; level <= 8; level++) {
        for (let cat = 1; cat <= 6; cat++) {
            prompts.push(...makePrompts(level, `cat${cat}`, 2));
        }
    }
    // Levels 9-10: 6 prompts, 6 categories (1 each)
    for (let level = 9; level <= 10; level++) {
        for (let cat = 1; cat <= 6; cat++) {
            prompts.push(...makePrompts(level, `cat${cat}`, 1));
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

    describe('depth: half', () => {
        it('should return ~50% per category, at least 1 each', () => {
            const config = { 4: 'half' };
            const level4 = allPrompts.filter(p => p.level === 4);
            const result = samplePromptsByDepth(level4, config);

            // Level 4: cat1,cat2 have 3 prompts (ceil(3/2)=2), cat3-10 have 2 prompts (ceil(2/2)=1)
            // Total: 2*2 + 8*1 = 12
            expect(result).toHaveLength(12);
        });

        it('should include at least 1 prompt from every category', () => {
            const config = { 6: 'half' };
            const level6 = allPrompts.filter(p => p.level === 6);
            const result = samplePromptsByDepth(level6, config);

            const categories = new Set(result.map(p => p.category));
            // Level 6 has 6 categories
            expect(categories.size).toBe(6);
        });
    });

    describe('mixed depths across levels', () => {
        it('should handle different depths for different levels', () => {
            const config = {
                1: 'full',
                2: 'light',
                3: 'off',
                4: 'single',
                5: 'half'
            };
            const prompts = allPrompts.filter(p => p.level <= 5);
            const result = samplePromptsByDepth(prompts, config);

            // Level 1 full = 16, level 2 light = 10, level 3 off = 0, level 4 single = 1, level 5 half = 12
            const byLevel = {};
            result.forEach(p => {
                if (!byLevel[p.level]) byLevel[p.level] = [];
                byLevel[p.level].push(p);
            });

            expect(byLevel[1] || []).toHaveLength(16);
            expect(byLevel[2] || []).toHaveLength(10);
            expect(byLevel[3]).toBeUndefined();
            expect(byLevel[4] || []).toHaveLength(1);
            expect(byLevel[5] || []).toHaveLength(12);
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
            // Only level 1 prompts should be included
            expect(result.every(p => p.level === 1)).toBe(true);
        });

        it('should handle a level with only 1 prompt at any depth', () => {
            const singlePrompt = [{ level: 99, category: 'solo', prompt: 'test', _id: '99_1' }];
            expect(samplePromptsByDepth(singlePrompt, { 99: 'full' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'half' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'light' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'single' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'off' })).toHaveLength(0);
        });

        it('should handle unknown depth value as off', () => {
            const config = { 1: 'unknown_depth' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            // Unknown depth should not match any case, resulting in no prompts
            expect(result).toHaveLength(0);
        });
    });
});
