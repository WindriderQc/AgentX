/**
 * Quality Scorer Unit Tests
 * Tests for enhanced scoring dimensions and consolidated scoring system
 */

const {
    buildDynamicJudgePrompt,
    getScoringDimensions,
    scoreResponse,
    calculateCompositeScore,
    quickScore,
    criteriaBasedScore,
    extractCriterionPattern,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES
} = require('../../src/services/qualityScorer');

// Mock logger to avoid console noise in tests
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock fetch for scoreResponse tests
jest.mock('node-fetch', () => jest.fn());

// Mock hardware profile service
jest.mock('../../src/services/hardwareProfileService', () => ({
    detectHardware: jest.fn().mockResolvedValue(null)
}));

describe('Enhanced Scoring Dimensions', () => {
    describe('buildDynamicJudgePrompt', () => {
        it('should build a prompt with 4 core dimensions for code category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.code.core_dimensions;
            const task = 'Write a function to sort an array';
            const expected = 'Efficient sorting algorithm';
            const response = 'function sort(arr) { return arr.sort(); }';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('You are a quality evaluator');
            expect(prompt).toContain('CRITERIA TO EVALUATE:');
            expect(prompt).toContain('correctness');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('efficiency');
            expect(prompt).toContain('robustness');
            expect(prompt).toContain(task);
            expect(prompt).toContain(expected);
            expect(prompt).toContain(response);
        });

        it('should build a prompt with 4 core dimensions for reasoning category', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.reasoning.core_dimensions;
            const task = 'Explain why the sky is blue';
            const expected = 'Scientific explanation';
            const response = 'The sky is blue because...';

            const prompt = buildDynamicJudgePrompt(dimensions, task, expected, response);

            expect(prompt).toContain('accuracy');
            expect(prompt).toContain('logic_soundness');
            expect(prompt).toContain('clarity');
            expect(prompt).toContain('completeness');
            expect(dimensions.length).toBe(4);
        });

        it('should format dimension names in criteria list (replace underscores with spaces)', () => {
            const dimensions = [
                { name: 'error_handling', weight: 0.5, desc: 'Handles errors well?' },
                { name: 'test_coverage', weight: 0.5, desc: 'Good test coverage?' }
            ];

            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('1. error handling (0-10): Handles errors well?');
            expect(prompt).toContain('2. test coverage (0-10): Good test coverage?');
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

        it('should include empty response handling instructions', () => {
            const dimensions = ENHANCED_SCORING_CONFIGS.code.core_dimensions;
            const prompt = buildDynamicJudgePrompt(dimensions, 'task', 'expected', 'response');

            expect(prompt).toContain('RESPONSE TO EVALUATE section is empty or blank');
            expect(prompt).toContain('assign 0 to all dimensions');
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

            expect(result.category).toBe('custom');
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

            expect(result.category).toBe('code');
            expect(result.dimensions.length).toBe(4);
            expect(result.dimensions[0].name).toBe('correctness');
            expect(result.weights.correctness).toBeGreaterThan(0);
        });

        it('should fall back to general config for unknown scoring_type', () => {
            const prompt = {
                name: 'Test Prompt',
                scoring_type: 'unknown-category'
            };

            const result = getScoringDimensions(prompt);

            // Should fall back to 'general' dimensions
            expect(result.category).toBe('unknown-category');
            expect(result.dimensions.length).toBe(4);
            expect(result.dimensions[0].name).toBe('helpfulness');
        });

        it('should use general config by default when no scoring_type specified', () => {
            const prompt = {
                name: 'Test Prompt'
            };

            const result = getScoringDimensions(prompt);

            expect(result.category).toBe('general');
            expect(result.dimensions.length).toBe(4);
        });

        it('should handle all 16 enhanced category types', () => {
            const categories = Object.keys(ENHANCED_SCORING_CONFIGS);

            categories.forEach(category => {
                const prompt = { name: 'Test', scoring_type: category };
                const result = getScoringDimensions(prompt);

                expect(result.dimensions.length).toBe(4);
                expect(result.weights).toBeDefined();
            });
        });
    });

    describe('quickScore', () => {
        it('should return score 10 for correct capital answer', () => {
            const response = 'The capital of France is Paris.';
            const prompt = { prompt: 'What is the capital of France?', expected_answer: 'Paris' };

            const result = quickScore(response, prompt);

            expect(result).not.toBeNull();
            expect(result.quick).toBe(true);
            expect(result.score).toBe(10);
            expect(result.matched).toBe(true);
        });

        it('should return score 0 for incorrect answer', () => {
            const response = 'The capital of France is London.';
            const prompt = { prompt: 'What is the capital of France?', expected_answer: 'Paris' };

            const result = quickScore(response, prompt);

            expect(result).not.toBeNull();
            expect(result.score).toBe(0);
            expect(result.matched).toBe(false);
        });

        it('should return null for prompts without expected_answer', () => {
            const response = 'Some response';
            const prompt = { prompt: 'Explain something complex' };

            const result = quickScore(response, prompt);

            expect(result).toBeNull();
        });

        it('should match math answers correctly', () => {
            const response = 'The answer is 42.';
            const prompt = { prompt: 'What is 15 + 27?', expected_answer: '42' };

            const result = quickScore(response, prompt);

            expect(result).not.toBeNull();
            expect(result.score).toBe(10);
        });

        it('should use word boundaries to avoid false positives', () => {
            const response = 'The answer is 320.'; // Contains "32" but not as standalone
            const prompt = { prompt: 'What comes next in 2, 4, 8, 16?', expected_answer: '32' };

            const result = quickScore(response, prompt);

            // Should NOT match because 32 is not a word boundary in 320
            expect(result).not.toBeNull();
            expect(result.score).toBe(0);
        });
    });

    describe('ENHANCED_SCORING_CONFIGS Validation', () => {
        it('should have all 16 required categories', () => {
            const expectedCategories = [
                'code', 'reasoning', 'factual', 'math', 'creative', 'general',
                'instruction-following', 'summarization', 'translation',
                'multi-turn-reasoning', 'context-retention', 'edge-cases',
                'refactoring', 'debugging', 'explanation', 'dialogue'
            ];

            expectedCategories.forEach(category => {
                expect(ENHANCED_SCORING_CONFIGS).toHaveProperty(category);
            });
        });

        it('should have exactly 4 core dimensions per category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                expect(config.core_dimensions.length).toBe(4);
            });
        });

        it('should have core_dimension weights that sum to 1.0 for each category', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                const sum = config.core_dimensions.reduce((acc, dim) => acc + dim.weight, 0);
                expect(sum).toBeCloseTo(1.0, 2);
            });
        });

        it('should have all required fields for each core dimension', () => {
            Object.entries(ENHANCED_SCORING_CONFIGS).forEach(([category, config]) => {
                config.core_dimensions.forEach(dim => {
                    expect(dim).toHaveProperty('name');
                    expect(dim).toHaveProperty('weight');
                    expect(dim).toHaveProperty('desc');
                    expect(typeof dim.name).toBe('string');
                    expect(typeof dim.weight).toBe('number');
                    expect(typeof dim.desc).toBe('string');
                });
            });
        });

        describe('Category-specific validations', () => {
            it('code: should include correctness as highest-weighted dimension', () => {
                const dims = ENHANCED_SCORING_CONFIGS.code.core_dimensions;
                const correctness = dims.find(d => d.name === 'correctness');
                expect(correctness).toBeDefined();
                expect(correctness.weight).toBeGreaterThanOrEqual(0.3);
            });

            it('reasoning: should include accuracy and logic_soundness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.reasoning.core_dimensions;
                expect(dims.find(d => d.name === 'accuracy')).toBeDefined();
                expect(dims.find(d => d.name === 'logic_soundness')).toBeDefined();
            });

            it('math: should prioritize answer_correctness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.math.core_dimensions;
                const answer = dims.find(d => d.name === 'answer_correctness');
                expect(answer).toBeDefined();
                expect(answer.weight).toBeGreaterThanOrEqual(0.35);
            });

            it('creative: should include originality', () => {
                const dims = ENHANCED_SCORING_CONFIGS.creative.core_dimensions;
                expect(dims.find(d => d.name === 'originality')).toBeDefined();
            });

            it('debugging: should include root_cause and fix_correctness', () => {
                const dims = ENHANCED_SCORING_CONFIGS.debugging.core_dimensions;
                expect(dims.find(d => d.name === 'root_cause')).toBeDefined();
                expect(dims.find(d => d.name === 'fix_correctness')).toBeDefined();
            });
        });
    });

    describe('Category-Specific Composite Profiles', () => {
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

            it('should have all required categories including code alias', () => {
                const expectedCategories = [
                    'code', 'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
                    'instruction-following', 'summarization', 'translation',
                    'multi-turn-reasoning', 'context-retention', 'edge-cases',
                    'refactoring', 'debugging', 'explanation', 'dialogue'
                ];

                expectedCategories.forEach(category => {
                    expect(CATEGORY_COMPOSITE_PROFILES).toHaveProperty(category);
                });
            });

            it('should have code and coding profiles with identical weights', () => {
                expect(CATEGORY_COMPOSITE_PROFILES.code.weights).toEqual(
                    CATEGORY_COMPOSITE_PROFILES.coding.weights
                );
            });

            it('should have weights that sum to 1.0 for each category', () => {
                Object.entries(CATEGORY_COMPOSITE_PROFILES).forEach(([category, profile]) => {
                    const sum = Object.values(profile.weights).reduce((a, b) => a + b, 0);
                    expect(sum).toBeCloseTo(1.0, 3);
                });
            });
        });

        describe('calculateCompositeScore', () => {
            it('should accept category name and use category-specific weights', () => {
                const result = calculateCompositeScore(testMetrics, 'code');

                expect(result).toHaveProperty('composite_score');
                expect(result).toHaveProperty('composite_profile_used');
                expect(result.composite_profile_used).toBe('category:code');
                expect(result.weights.quality).toBe(0.6);
            });

            it('should produce different scores for different categories', () => {
                const codeResult = calculateCompositeScore(testMetrics, 'code');
                const reasoningResult = calculateCompositeScore(testMetrics, 'reasoning');

                expect(codeResult.composite_score).not.toBe(reasoningResult.composite_score);
            });

            it('should prioritize quality for reasoning category (80% weight)', () => {
                const result = calculateCompositeScore(testMetrics, 'reasoning');

                expect(result.weights.quality).toBe(0.8);
                expect(result.weights.latency).toBe(0.1);
                expect(result.weights.speed).toBe(0.1);
            });

            it('should default to interactive profile for unknown category', () => {
                const result = calculateCompositeScore(testMetrics, 'nonexistent');

                expect(result.composite_profile_used).toBe('profile:interactive');
            });

            it('should handle edge cases gracefully', () => {
                const invalidMetrics = {
                    latency: 'not-a-number',
                    tokens_per_sec: null,
                    quality_score: undefined
                };
                const result = calculateCompositeScore(invalidMetrics, 'code');

                expect(result.composite_score).toBeGreaterThanOrEqual(0);
                expect(result.normalized.quality).toBe(0);
                expect(result.normalized.speed).toBe(0);
            });

            it('should cap latency score at 0 when exceeding latencyCap', () => {
                const highLatencyMetrics = { ...testMetrics, latency: 100000 };
                const result = calculateCompositeScore(highLatencyMetrics, 'factual');

                // factual has 30s cap, 100s should give 0 latency score
                expect(result.normalized.latency).toBe(0);
            });
        });
    });

    describe('scoreResponse edge cases', () => {
        it('should export scoreResponse function', () => {
            expect(typeof scoreResponse).toBe('function');
        });

        it('should return score 0 with empty_response method for empty responses', async () => {
            const result = await scoreResponse({
                response: '',
                prompt: { prompt: 'Test prompt', scoring_type: 'general' }
            });

            expect(result.quality_score).toBe(0);
            expect(result.scoring_method).toBe('empty_response');
            expect(result.explanation).toContain('NO response');
        });

        it('should return score 0 with empty_response method for whitespace-only responses', async () => {
            const result = await scoreResponse({
                response: '   \n\t  ',
                prompt: { prompt: 'Test prompt', scoring_type: 'general' }
            });

            expect(result.quality_score).toBe(0);
            expect(result.scoring_method).toBe('empty_response');
        });

        it('should skip LLM judge when skipLLM is true', async () => {
            const result = await scoreResponse({
                response: 'Some response',
                prompt: { prompt: 'Test prompt' },
                skipLLM: true
            });

            expect(result.scoring_method).toBe('skipped');
            expect(result.quality_score).toBeNull();
        });

        it('should use deterministic numeric scoring path for math prompts and return quality_score', async () => {
            const result = await scoreResponse({
                response: 'x = 6',
                prompt: {
                    prompt: 'Solve for x: 7x = 42',
                    scoring_type: 'math',
                    expected_answer: '6',
                    level: 3
                }
            });

            expect(result.scoring_method).toBe('deterministic');
            expect(result.quality_score).toBe(10);
            expect(result.judge_confidence).toBe(1);
            expect(result.needs_review).toBe(false);
        });
    });

    describe('extractCriterionPattern', () => {
        it('should extract proper noun phrases (stripping leading verbs)', () => {
            const pattern = extractCriterionPattern('Names Pine Ridge as the closed trail');
            expect(pattern).toBe('Pine\\s+Ridge');
            // Verify it works as a regex against actual text
            expect(new RegExp(pattern, 'i').test('The Pine Ridge trail is closed')).toBe(true);
        });

        it('should extract number+unit patterns', () => {
            const pattern = extractCriterionPattern('States the total budget as 1.2 million');
            // Pattern is regex-escaped: 1\.2\s*million
            expect(new RegExp(pattern, 'i').test('The budget is 1.2 million')).toBe(true);
        });

        it('should extract quoted values', () => {
            const pattern = extractCriterionPattern('Mentions "rye sandwiches" as the food');
            expect(pattern).toBe('rye sandwiches');
        });

        it('should return null for empty/trivial strings', () => {
            const pattern = extractCriterionPattern('is it');
            expect(pattern).toBeNull();
        });

        it('should handle multi-word proper nouns like Alder Cove', () => {
            const pattern = extractCriterionPattern('Names Alder Cove as the campsite');
            expect(pattern).toBe('Alder\\s+Cove');
            expect(new RegExp(pattern, 'i').test('staying at Alder Cove')).toBe(true);
        });
    });

    describe('criteriaBasedScore', () => {
        it('should score Lake Trip Journal data correctly (full match)', () => {
            const response = 'The Pine Ridge trail is closed. They had rye sandwiches for lunch. They will stay at Alder Cove campsite.';
            const prompt = {
                name: 'Lake Trip Journal',
                expected_answer: '1. Pine Ridge\n2. Rye sandwiches\n3. Alder Cove',
                judge_criteria: [
                    'Names Pine Ridge as the closed trail',
                    'Identifies rye sandwiches as the main lunch item',
                    'Names Alder Cove as the campsite'
                ]
            };

            const result = criteriaBasedScore(response, prompt);
            expect(result).not.toBeNull();
            expect(result.score).toBe(10);
            expect(result.matched).toBe(true);
        });

        it('should score partial matches proportionally', () => {
            const response = 'The Pine Ridge trail is closed. They had some food. They camped at Alder Cove.';
            const prompt = {
                name: 'Lake Trip Journal',
                expected_answer: '1. Pine Ridge\n2. Rye sandwiches\n3. Alder Cove',
                judge_criteria: [
                    'Names Pine Ridge as the closed trail',
                    'Identifies rye sandwiches as the main lunch item',
                    'Names Alder Cove as the campsite'
                ]
            };

            const result = criteriaBasedScore(response, prompt);
            expect(result).not.toBeNull();
            // Pine Ridge matched, rye sandwiches NOT matched, Alder Cove matched
            // expected_answer lines: Pine Ridge (already covered), Rye sandwiches (not matched), Alder Cove (covered)
            expect(result.score).toBeGreaterThan(0);
            expect(result.score).toBeLessThan(10);
        });

        it('should return null when no judge_criteria', () => {
            const result = criteriaBasedScore('some response', { expected_answer: 'foo' });
            expect(result).toBeNull();
        });

        it('should return null when judge_criteria is empty', () => {
            const result = criteriaBasedScore('some response', {
                expected_answer: 'foo',
                judge_criteria: []
            });
            expect(result).toBeNull();
        });

        it('should handle criteria with numbers', () => {
            const response = 'The budget is $1.2 million for the project.';
            const prompt = {
                expected_answer: '$1.2 million',
                judge_criteria: ['States the total budget as $1.2 million']
            };

            const result = criteriaBasedScore(response, prompt);
            expect(result).not.toBeNull();
            expect(result.score).toBe(10);
        });
    });
});
