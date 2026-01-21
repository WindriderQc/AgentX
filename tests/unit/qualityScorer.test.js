/**
 * Quality Scorer Unit Tests
 * Tests for enhanced scoring dimensions and backward compatibility
 */

const {
    buildDynamicJudgePrompt,
    getScoringDimensions,
    scoreResponse,
    calculateCompositeScore,
    ENHANCED_SCORING_CONFIGS,
    SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES
} = require('../../src/services/qualityScorer');

// Mock logger to avoid console noise in tests
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

describe('Enhanced Scoring Dimensions', () => {
    describe('buildDynamicJudgePrompt', () => {
        it('should build a prompt with 8 dimensions for code category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.code.dimensions;
            const task = 'Write a function to sort an array';
            const expected = 'Efficient sorting algorithm';
            const response = 'function sort(arr) { return arr.sort(); }';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('You are a quality evaluator');
            expect(prompt).toContain('CRITERIA TO EVALUATE:');
            expect(prompt).toContain('correctness');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('efficiency');
            expect(prompt).toContain('maintainability');
            expect(prompt).toContain('error_handling');
            expect(prompt).toContain('documentation');
            expect(prompt).toContain('best_practices');
            expect(prompt).toContain('testability');
            expect(prompt).toContain(task);
            expect(prompt).toContain(expected);
            expect(prompt).toContain(response);
        });

        it('should build a prompt with 7 dimensions for reasoning category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.reasoning.dimensions;
            const task = 'Explain why the sky is blue';
            const expected = 'Scientific explanation';
            const response = 'The sky is blue because...';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('accuracy');
            expect(prompt).toContain('logic_soundness');
            expect(prompt).toContain('depth');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('completeness');
            expect(prompt).toContain('coherence');
            expect(prompt).toContain('method_quality');
        });

        it('should format dimension names in criteria list (replace underscores with spaces)', () => {
            const dimensions = [
                { name: 'error_handling', weight: 0.5, desc: 'Handles errors well?' },
                { name: 'test_coverage', weight: 0.5, desc: 'Good test coverage?' }
            ];

            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            // Criteria list should have formatted names
            expect(prompt).toContain('1. error handling (0-10): Handles errors well?');
            expect(prompt).toContain('2. test coverage (0-10): Good test coverage?');

            // JSON format should preserve original names for parsing
            expect(prompt).toContain('"error_handling": "X"');
            expect(prompt).toContain('"test_coverage": "X"');
        });

        it('should include JSON format template with all dimensions', () => {
            const dimensions = [
                { name: 'accuracy', weight: 0.5, desc: 'Is accurate?' },
                { name: 'clarity', weight: 0.5, desc: 'Is clear?' }
            ];

            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('"accuracy": "X"');
            expect(prompt).toContain('"clarity": "X"');
            expect(prompt).toContain('"overall": "X"');
            expect(prompt).toContain('"explanation": "brief reason"');
        });
    });

    describe('getScoringDimensions', () => {
        it('should use custom scoring_dimensions from prompt if defined', () => {
            const prompt = {
                name: 'Custom Prompt',
                scoring_type: 'code',
                scoring_dimensions: [
                    { name: 'custom_dim1', weight: 0.6, description: 'Custom dimension 1' },
                    { name: 'custom_dim2', weight: 0.4, description: 'Custom dimension 2' }
                ]
            };

            const result = getScoringDimensions(prompt);

            expect(result.useLegacy).toBe(false);
            expect(result.dimensions).toHaveLength(2);
            expect(result.dimensions[0].name).toBe('custom_dim1');
            expect(result.dimensions[0].weight).toBe(0.6);
            expect(result.dimensions[0].desc).toBe('Custom dimension 1');
            expect(result.weights).toEqual({ custom_dim1: 0.6, custom_dim2: 0.4 });
        });

        it('should use enhanced configs if no custom dimensions defined', () => {
            const prompt = {
                name: 'Test Prompt',
                scoring_type: 'code'
            };

            const result = getScoringDimensions(prompt);

            expect(result.useLegacy).toBe(false);
            expect(result.dimensions).toHaveLength(8); // code has 8 dimensions
            expect(result.dimensions[0].name).toBe('correctness');
            expect(result.weights.correctness).toBe(0.25);
        });

        it('should fall back to legacy config if enhanced not available', () => {
            const prompt = {
                name: 'Test Prompt',
                scoring_type: 'code'
            };

            // Temporarily remove enhanced config
            const originalConfig = ENHANCED_SCORING_CONFIGS.code;
            delete ENHANCED_SCORING_CONFIGS.code;

            const result = getScoringDimensions(prompt);

            // Restore config
            ENHANCED_SCORING_CONFIGS.code = originalConfig;

            expect(result.useLegacy).toBe(true);
            expect(result.legacyConfig).toBeDefined();
            expect(result.legacyConfig.weight).toBeDefined();
        });

        it('should use enhanced reasoning config by default', () => {
            const prompt = {
                name: 'Test Prompt'
                // no scoring_type specified, should default to 'reasoning'
            };

            const result = getScoringDimensions(prompt);

            expect(result.useLegacy).toBe(false);
            expect(result.dimensions).toHaveLength(7); // reasoning has 7 dimensions
        });

        it('should handle all enhanced category types', () => {
            const categories = ['code', 'reasoning', 'factual', 'math', 'creative'];

            categories.forEach(category => {
                const prompt = { name: 'Test', scoring_type: category };
                const result = getScoringDimensions(prompt);

                expect(result.useLegacy).toBe(false);
                expect(result.dimensions.length).toBeGreaterThanOrEqual(6);
                expect(result.dimensions.length).toBeLessThanOrEqual(12);
            });
        });
    });

    describe('ENHANCED_SCORING_CONFIGS Validation', () => {
        it('should have all required categories', () => {
            expect(ENHANCED_SCORING_CONFIGS).toHaveProperty('code');
            expect(ENHANCED_SCORING_CONFIGS).toHaveProperty('reasoning');
            expect(ENHANCED_SCORING_CONFIGS).toHaveProperty('factual');
            expect(ENHANCED_SCORING_CONFIGS).toHaveProperty('math');
            expect(ENHANCED_SCORING_CONFIGS).toHaveProperty('creative');
        });

        it('should have 6-12 dimensions per category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                const count = config.dimensions.length;
                expect(count).toBeGreaterThanOrEqual(6);
                expect(count).toBeLessThanOrEqual(12);
            });
        });

        it('should have weights that sum to 1.0 for each category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                const sum = config.dimensions.reduce((acc, dim) => acc + dim.weight, 0);
                expect(sum).toBeCloseTo(1.0, 2);
            });
        });

        it('should have all required fields for each dimension', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                config.dimensions.forEach(dim => {
                    expect(dim).toHaveProperty('name');
                    expect(dim).toHaveProperty('weight');
                    expect(dim).toHaveProperty('desc');
                    expect(typeof dim.name).toBe('string');
                    expect(typeof dim.weight).toBe('number');
                    expect(typeof dim.desc).toBe('string');
                });
            });
        });

        describe('Code category dimensions', () => {
            it('should have 8 dimensions', () => {
                expect(ENHANCED_SCORING_CONFIGS.code.dimensions).toHaveLength(8);
            });

            it('should include correctness as highest weight', () => {
                const dims = ENHANCED_SCORING_CONFIGS.code.dimensions;
                const correctness = dims.find(d => d.name === 'correctness');
                expect(correctness).toBeDefined();
                expect(correctness.weight).toBe(0.25);
            });
        });

        describe('Reasoning category dimensions', () => {
            it('should have 7 dimensions', () => {
                expect(ENHANCED_SCORING_CONFIGS.reasoning.dimensions).toHaveLength(7);
            });

            it('should include accuracy and logic_soundness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.reasoning.dimensions;
                const accuracy = dims.find(d => d.name === 'accuracy');
                const logic = dims.find(d => d.name === 'logic_soundness');
                expect(accuracy).toBeDefined();
                expect(logic).toBeDefined();
            });
        });

        describe('Factual category dimensions', () => {
            it('should have 6 dimensions', () => {
                expect(ENHANCED_SCORING_CONFIGS.factual.dimensions).toHaveLength(6);
            });

            it('should prioritize accuracy with highest weight', () => {
                const dims = ENHANCED_SCORING_CONFIGS.factual.dimensions;
                const accuracy = dims.find(d => d.name === 'accuracy');
                expect(accuracy.weight).toBe(0.35);
            });
        });

        describe('Math category dimensions', () => {
            it('should have 6 dimensions', () => {
                expect(ENHANCED_SCORING_CONFIGS.math.dimensions).toHaveLength(6);
            });

            it('should prioritize answer_correctness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.math.dimensions;
                const answer = dims.find(d => d.name === 'answer_correctness');
                expect(answer.weight).toBe(0.35);
            });
        });

        describe('Creative category dimensions', () => {
            it('should have 7 dimensions', () => {
                expect(ENHANCED_SCORING_CONFIGS.creative.dimensions).toHaveLength(7);
            });

            it('should include creativity and originality', () => {
                const dims = ENHANCED_SCORING_CONFIGS.creative.dimensions;
                const creativity = dims.find(d => d.name === 'creativity');
                const originality = dims.find(d => d.name === 'originality');
                expect(creativity).toBeDefined();
                expect(originality).toBeDefined();
            });
        });
    });

    describe('Backward Compatibility', () => {
        it('should maintain legacy SCORING_CONFIGS structure', () => {
            expect(SCORING_CONFIGS).toHaveProperty('code');
            expect(SCORING_CONFIGS).toHaveProperty('reasoning');
            expect(SCORING_CONFIGS).toHaveProperty('factual');
            expect(SCORING_CONFIGS).toHaveProperty('math');
            expect(SCORING_CONFIGS).toHaveProperty('creative');
        });

        it('should have legacy configs with weight and prompt properties', () => {
            Object.entries(SCORING_CONFIGS).forEach(([category, config]) => {
                expect(config).toHaveProperty('weight');
                expect(config).toHaveProperty('prompt');
                expect(typeof config.prompt).toBe('string');
                expect(typeof config.weight).toBe('object');
            });
        });

        it('should use legacy config for prompts without scoring_dimensions', () => {
            const prompt = {
                name: 'Legacy Prompt',
                scoring_type: 'code'
            };

            // Temporarily clear enhanced config to force legacy
            const originalEnhanced = ENHANCED_SCORING_CONFIGS.code;
            delete ENHANCED_SCORING_CONFIGS.code;

            const result = getScoringDimensions(prompt);

            // Restore
            ENHANCED_SCORING_CONFIGS.code = originalEnhanced;

            expect(result.useLegacy).toBe(true);
            expect(result.legacyConfig.weight).toBeDefined();
        });
    });

    describe('Integration with scoreResponse (mocked)', () => {
        // Note: This would require mocking the fetch call and judge model
        // For now, we test that the function exists and has correct signature

        it('should export scoreResponse function', () => {
            expect(typeof scoreResponse).toBe('function');
        });

        it('should handle custom dimensions in prompt object', async () => {
            const mockPrompt = {
                name: 'Custom Test',
                prompt: 'Write a hello world function',
                scoring_dimensions: [
                    { name: 'correctness', weight: 0.5, description: 'Works correctly?' },
                    { name: 'style', weight: 0.5, description: 'Good style?' }
                ]
            };

            const dimensions = getScoringDimensions(mockPrompt);

            expect(dimensions.useLegacy).toBe(false);
            expect(dimensions.dimensions).toHaveLength(2);
        });
    });

    describe('Category-Specific Composite Profiles (Phase 1 Week 5)', () => {
        const testMetrics = {
            latency: 5000,
            tokens_per_sec: 50,
            quality_score: 8.5
        };

        describe('CATEGORY_COMPOSITE_PROFILES Structure', () => {
            it('should export CATEGORY_COMPOSITE_PROFILES', () => {
                expect(CATEGORY_COMPOSITE_PROFILES).toBeDefined();
                expect(typeof CATEGORY_COMPOSITE_PROFILES).toBe('object');
            });

            it('should have all 12 categories defined', () => {
                const expectedCategories = [
                    // Original 6
                    'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
                    // Enhanced 6
                    'instruction-following', 'summarization', 'translation',
                    'multi-turn-reasoning', 'context-retention', 'edge-cases'
                ];

                expectedCategories.forEach(category => {
                    expect(CATEGORY_COMPOSITE_PROFILES).toHaveProperty(category);
                });

                expect(Object.keys(CATEGORY_COMPOSITE_PROFILES).length).toBe(12);
            });

            it('should have required fields for each category', () => {
                Object.entries(CATEGORY_COMPOSITE_PROFILES).forEach(([category, profile]) => {
                    expect(profile).toHaveProperty('weights');
                    expect(profile).toHaveProperty('latencyCap');
                    expect(profile).toHaveProperty('description');
                    expect(typeof profile.weights).toBe('object');
                    expect(typeof profile.latencyCap).toBe('number');
                    expect(typeof profile.description).toBe('string');
                });
            });

            it('should have weights that sum to 1.0 for each category', () => {
                Object.entries(CATEGORY_COMPOSITE_PROFILES).forEach(([category, profile]) => {
                    const sum = Object.values(profile.weights).reduce((a, b) => a + b, 0);
                    expect(sum).toBeCloseTo(1.0, 3);
                });
            });

            it('should have quality, latency, and speed weights for all categories', () => {
                Object.entries(CATEGORY_COMPOSITE_PROFILES).forEach(([category, profile]) => {
                    expect(profile.weights).toHaveProperty('quality');
                    expect(profile.weights).toHaveProperty('latency');
                    expect(profile.weights).toHaveProperty('speed');
                });
            });
        });

        describe('calculateCompositeScore with categories', () => {
            it('should accept category name and use category-specific weights', () => {
                const result = calculateCompositeScore(testMetrics, 'coding');

                expect(result).toHaveProperty('composite_score');
                expect(result).toHaveProperty('composite_profile_used');
                expect(result).toHaveProperty('weights');
                expect(result.composite_profile_used).toBe('category:coding');
                expect(result.weights.quality).toBe(0.6);
            });

            it('should produce different scores for different categories', () => {
                const codingResult = calculateCompositeScore(testMetrics, 'coding');
                const reasoningResult = calculateCompositeScore(testMetrics, 'reasoning');
                const creativeResult = calculateCompositeScore(testMetrics, 'creative');

                // Different weights should produce different scores
                expect(codingResult.composite_score).not.toBe(reasoningResult.composite_score);
                expect(reasoningResult.composite_score).not.toBe(creativeResult.composite_score);
            });

            it('should prioritize quality for reasoning category (80% weight)', () => {
                const result = calculateCompositeScore(testMetrics, 'reasoning');

                expect(result.weights.quality).toBe(0.8);
                expect(result.weights.latency).toBe(0.1);
                expect(result.weights.speed).toBe(0.1);
                expect(result.composite_profile_used).toBe('category:reasoning');
            });

            it('should balance quality and latency for coding category', () => {
                const result = calculateCompositeScore(testMetrics, 'coding');

                expect(result.weights.quality).toBe(0.6);
                expect(result.weights.latency).toBe(0.25);
                expect(result.weights.speed).toBe(0.15);
                expect(result.composite_profile_used).toBe('category:coding');
            });

            it('should work with all 12 categories', () => {
                const categories = Object.keys(CATEGORY_COMPOSITE_PROFILES);

                categories.forEach(category => {
                    const result = calculateCompositeScore(testMetrics, category);
                    expect(result.composite_score).toBeGreaterThan(0);
                    expect(result.composite_score).toBeLessThanOrEqual(100);
                    expect(result.composite_profile_used).toBe(`category:${category}`);
                });
            });
        });

        describe('Backward compatibility with legacy profiles', () => {
            it('should still accept legacy profile names (interactive, reasoning, coding)', () => {
                const interactiveResult = calculateCompositeScore(testMetrics, 'interactive');
                const reasoningResult = calculateCompositeScore(testMetrics, 'reasoning');
                const codingResult = calculateCompositeScore(testMetrics, 'coding');

                // Note: 'reasoning' and 'coding' are both category names and legacy profiles
                // Category profiles take priority
                expect(interactiveResult.composite_profile_used).toBe('profile:interactive');
                expect(reasoningResult.composite_profile_used).toBe('category:reasoning');
                expect(codingResult.composite_profile_used).toBe('category:coding');
            });

            it('should default to interactive profile when no parameter provided', () => {
                const result = calculateCompositeScore(testMetrics);

                expect(result.composite_profile_used).toBe('profile:interactive');
                expect(result.weights.quality).toBe(0.4);
                expect(result.weights.latency).toBe(0.4);
                expect(result.weights.speed).toBe(0.2);
            });

            it('should default to interactive profile for invalid category name', () => {
                const result = calculateCompositeScore(testMetrics, 'nonexistent-category');

                expect(result.composite_profile_used).toBe('profile:interactive');
            });

            it('should maintain backward compatibility with existing code', () => {
                // Old code calling with legacy profiles should still work
                const oldStyleResult = calculateCompositeScore(testMetrics, 'interactive');

                expect(oldStyleResult).toHaveProperty('composite_score');
                expect(oldStyleResult).toHaveProperty('normalized');
                expect(oldStyleResult).toHaveProperty('weights');
                expect(oldStyleResult).toHaveProperty('profile');
                expect(oldStyleResult.profile).toBe('interactive');
            });
        });

        describe('Composite score calculation accuracy', () => {
            it('should return score between 0 and 100', () => {
                const result = calculateCompositeScore(testMetrics, 'coding');

                expect(result.composite_score).toBeGreaterThanOrEqual(0);
                expect(result.composite_score).toBeLessThanOrEqual(100);
            });

            it('should handle edge case: zero latency', () => {
                const zeroLatencyMetrics = { ...testMetrics, latency: 0 };
                const result = calculateCompositeScore(zeroLatencyMetrics, 'coding');

                expect(result.composite_score).toBeGreaterThan(0);
                expect(result.normalized.latency).toBe(100); // 0 latency = perfect score
            });

            it('should handle edge case: very high latency', () => {
                const highLatencyMetrics = { ...testMetrics, latency: 300000 }; // 5 minutes
                const result = calculateCompositeScore(highLatencyMetrics, 'coding');

                expect(result.normalized.latency).toBeLessThan(10); // Very poor latency score
            });

            it('should handle edge case: zero tokens per second', () => {
                const zeroSpeedMetrics = { ...testMetrics, tokens_per_sec: 0 };
                const result = calculateCompositeScore(zeroSpeedMetrics, 'coding');

                expect(result.normalized.speed).toBe(0);
            });

            it('should handle edge case: zero quality score', () => {
                const zeroQualityMetrics = { ...testMetrics, quality_score: 0 };
                const result = calculateCompositeScore(zeroQualityMetrics, 'coding');

                expect(result.normalized.quality).toBe(0);
            });

            it('should handle invalid inputs gracefully', () => {
                const invalidMetrics = {
                    latency: 'not-a-number',
                    tokens_per_sec: null,
                    quality_score: undefined
                };
                const result = calculateCompositeScore(invalidMetrics, 'coding');

                // Invalid inputs are normalized to 0, but latency=0 gives perfect latency score
                // So composite score > 0 (from latency component)
                expect(result.composite_score).toBeGreaterThan(0);
                expect(result.normalized.quality).toBe(0);
                expect(result.normalized.speed).toBe(0);
                expect(result.normalized.latency).toBe(100); // 0 latency = perfect
            });
        });

        describe('Weight distribution validation', () => {
            it('should have reasoning-heavy categories weight quality at 75%+', () => {
                const reasoningCategories = ['reasoning', 'math', 'multi-turn-reasoning'];

                reasoningCategories.forEach(category => {
                    const profile = CATEGORY_COMPOSITE_PROFILES[category];
                    expect(profile.weights.quality).toBeGreaterThanOrEqual(0.75);
                });
            });

            it('should have coding category balance quality and latency', () => {
                const profile = CATEGORY_COMPOSITE_PROFILES.coding;

                expect(profile.weights.quality).toBeGreaterThanOrEqual(0.5);
                expect(profile.weights.latency).toBeGreaterThanOrEqual(0.2);
            });

            it('should have general category as most balanced', () => {
                const profile = CATEGORY_COMPOSITE_PROFILES.general;

                // General should not over-prioritize any single dimension
                expect(profile.weights.quality).toBeLessThanOrEqual(0.6);
                expect(profile.weights.latency).toBeGreaterThanOrEqual(0.2);
                expect(profile.weights.speed).toBeGreaterThanOrEqual(0.15);
            });
        });
    });
});
