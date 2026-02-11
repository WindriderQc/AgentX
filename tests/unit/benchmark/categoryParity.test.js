const { ENHANCED_SCORING_CONFIGS } = require('../../../src/services/scoring/scoringConfigs');
const { normalizeCategoryKey, getCategoryParitySnapshot } = require('../../../src/services/benchmark/categoryParity');

describe('Benchmark category parity', () => {
    describe('normalizeCategoryKey', () => {
        it('normalizes code aliases and snake case', () => {
            expect(normalizeCategoryKey('code')).toBe('coding');
            expect(normalizeCategoryKey('context_retention')).toBe('context-retention');
            expect(normalizeCategoryKey('  Debugging  ')).toBe('debugging');
        });
    });

    describe('getCategoryParitySnapshot', () => {
        it('reports healthy parity when active prompt categories match scoring categories', async () => {
            const promptCategories = Object.keys(ENHANCED_SCORING_CONFIGS);
            const snapshot = await getCategoryParitySnapshot({ promptCategories });

            expect(snapshot.hasDrift).toBe(false);
            expect(snapshot.drift.in_scoring_not_in_active_prompts).toEqual([]);
            expect(snapshot.drift.in_active_prompts_not_in_scoring).toEqual([]);
        });

        it('detects missing active prompt categories', async () => {
            const promptCategories = Object.keys(ENHANCED_SCORING_CONFIGS)
                .filter((cat) => cat !== 'general');
            const snapshot = await getCategoryParitySnapshot({ promptCategories });

            expect(snapshot.hasDrift).toBe(true);
            expect(snapshot.drift.in_scoring_not_in_active_prompts).toContain('general');
        });
    });
});

