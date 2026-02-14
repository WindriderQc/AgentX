/**
 * Compliance Scorer Unit Tests
 * Tests for hybrid scoring: deterministic accuracy + LLM compliance
 */

const {
    COMPLIANCE_QUESTIONS,
    scoreCompliance,
    blendHybridScore,
    DEFAULT_HYBRID_WEIGHTS
} = require('../../src/services/scoring/complianceScorer');

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock decomposedJudge.scoreDimension
jest.mock('../../src/services/decomposedJudge', () => ({
    scoreDimension: jest.fn()
}));

// Mock node-fetch (required by decomposedJudge internally)
jest.mock('node-fetch', () => jest.fn());

const { scoreDimension } = require('../../src/services/decomposedJudge');

describe('Compliance Scorer', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('COMPLIANCE_QUESTIONS structure', () => {
        it('should have exactly 3 questions', () => {
            expect(COMPLIANCE_QUESTIONS).toHaveLength(3);
        });

        it('should have weights that sum to 1.0', () => {
            const sum = COMPLIANCE_QUESTIONS.reduce((acc, q) => acc + q.weight, 0);
            expect(sum).toBeCloseTo(1.0, 3);
        });

        it('should have required fields on each question', () => {
            COMPLIANCE_QUESTIONS.forEach(q => {
                expect(q).toHaveProperty('q');
                expect(q).toHaveProperty('weight');
                expect(typeof q.q).toBe('string');
                expect(typeof q.weight).toBe('number');
                expect(q.weight).toBeGreaterThan(0);
                expect(q.weight).toBeLessThanOrEqual(1);
            });
        });

        it('first question should be about avoiding unnecessary text (highest weight)', () => {
            expect(COMPLIANCE_QUESTIONS[0].q).toContain('unnecessary extra text');
            expect(COMPLIANCE_QUESTIONS[0].weight).toBe(0.40);
        });

        it('second question should be about formatting instructions', () => {
            expect(COMPLIANCE_QUESTIONS[1].q).toContain('formatting');
            expect(COMPLIANCE_QUESTIONS[1].weight).toBe(0.35);
        });

        it('third question should be about directness', () => {
            expect(COMPLIANCE_QUESTIONS[2].q).toContain('directly address');
            expect(COMPLIANCE_QUESTIONS[2].weight).toBe(0.25);
        });
    });

    describe('scoreCompliance', () => {
        const mockPrompt = {
            name: 'Test Prompt',
            prompt: 'Give only the answer to 5 + 2',
            expected_answer: '7'
        };
        const mockJudgeConfig = { host: 'http://localhost:11434', model: 'test-model' };

        it('should return score 10 when all questions answered YES', async () => {
            scoreDimension.mockResolvedValue({
                score: 10,
                breakdown: [
                    { question: COMPLIANCE_QUESTIONS[0].q, answer: true, contributed: true },
                    { question: COMPLIANCE_QUESTIONS[1].q, answer: true, contributed: true },
                    { question: COMPLIANCE_QUESTIONS[2].q, answer: true, contributed: true }
                ],
                earned: 1.0,
                total: 1.0
            });

            const result = await scoreCompliance('7', mockPrompt, mockJudgeConfig);

            expect(result).not.toBeNull();
            expect(result.score).toBe(10);
            expect(scoreDimension).toHaveBeenCalledWith(
                '7',
                COMPLIANCE_QUESTIONS,
                mockJudgeConfig,
                { task: mockPrompt.prompt, expected: mockPrompt.expected_answer }
            );
        });

        it('should return score 0 when all questions answered NO', async () => {
            scoreDimension.mockResolvedValue({
                score: 0,
                breakdown: [
                    { question: COMPLIANCE_QUESTIONS[0].q, answer: false, contributed: false },
                    { question: COMPLIANCE_QUESTIONS[1].q, answer: false, contributed: false },
                    { question: COMPLIANCE_QUESTIONS[2].q, answer: false, contributed: false }
                ],
                earned: 0,
                total: 1.0
            });

            const result = await scoreCompliance('The answer is 7, because...', mockPrompt, mockJudgeConfig);

            expect(result).not.toBeNull();
            expect(result.score).toBe(0);
        });

        it('should return null on failure (graceful degradation)', async () => {
            scoreDimension.mockRejectedValue(new Error('Judge HTTP 500'));

            const result = await scoreCompliance('7', mockPrompt, mockJudgeConfig);

            expect(result).toBeNull();
        });

        it('should pass task context to scoreDimension', async () => {
            scoreDimension.mockResolvedValue({ score: 7, breakdown: [] });

            await scoreCompliance('answer', mockPrompt, mockJudgeConfig);

            expect(scoreDimension).toHaveBeenCalledWith(
                'answer',
                COMPLIANCE_QUESTIONS,
                mockJudgeConfig,
                { task: 'Give only the answer to 5 + 2', expected: '7' }
            );
        });

        it('should handle prompt without expected_answer', async () => {
            scoreDimension.mockResolvedValue({ score: 5, breakdown: [] });
            const prompt = { name: 'No expected', prompt: 'Do something' };

            const result = await scoreCompliance('response', prompt, mockJudgeConfig);

            expect(result).not.toBeNull();
            expect(scoreDimension).toHaveBeenCalledWith(
                'response',
                COMPLIANCE_QUESTIONS,
                mockJudgeConfig,
                { task: 'Do something', expected: '' }
            );
        });
    });

    describe('blendHybridScore', () => {
        const makeCriteriaResult = (score, matched = true) => ({
            score,
            matched,
            deterministic_type: 'criteria',
            details: 'Matched 3/3 patterns'
        });

        it('should blend with default weights (0.70/0.30)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 5, breakdown: [] },
                'unknown-category'
            );

            // 10*0.70 + 5*0.30 = 7.0 + 1.5 = 8.5
            expect(result.quality_score).toBe(8.5);
            expect(result.scoring_method).toBe('hybrid');
            expect(result.accuracy_score).toBe(10);
            expect(result.compliance_score).toBe(5);
        });

        it('should use context-retention weights (0.75/0.25)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 6, breakdown: [] },
                'context-retention'
            );

            // 10*0.75 + 6*0.25 = 7.5 + 1.5 = 9.0
            expect(result.quality_score).toBe(9);
        });

        it('should use instruction-following weights (0.55/0.45)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 4, breakdown: [] },
                'instruction-following'
            );

            // 10*0.55 + 4*0.45 = 5.5 + 1.8 = 7.3
            expect(result.quality_score).toBe(7.3);
        });

        it('should use summarization weights (0.60/0.40)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(8),
                { score: 6, breakdown: [] },
                'summarization'
            );

            // 8*0.60 + 6*0.40 = 4.8 + 2.4 = 7.2
            expect(result.quality_score).toBe(7.2);
        });

        it('should use translation weights (0.70/0.30)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(9),
                { score: 7, breakdown: [] },
                'translation'
            );

            // 9*0.70 + 7*0.30 = 6.3 + 2.1 = 8.4
            expect(result.quality_score).toBe(8.4);
        });

        it('should use multi-turn-reasoning weights (0.75/0.25)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 2, breakdown: [] },
                'multi-turn-reasoning'
            );

            // 10*0.75 + 2*0.25 = 7.5 + 0.5 = 8.0
            expect(result.quality_score).toBe(8);
        });

        it('should use edge-cases weights (0.70/0.30)', () => {
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 10, breakdown: [] },
                'edge-cases'
            );

            // 10*0.70 + 10*0.30 = 7.0 + 3.0 = 10.0
            expect(result.quality_score).toBe(10);
        });

        it('should clamp scores to 0-10 range', () => {
            const result = blendHybridScore(
                { score: 15, matched: true },
                { score: -5, breakdown: [] },
                'general'
            );

            // Clamped: accuracy=10, compliance=0 → 10*0.70 + 0*0.30 = 7.0
            expect(result.accuracy_score).toBe(10);
            expect(result.compliance_score).toBe(0);
            expect(result.quality_score).toBe(7);
        });

        it('should return correct result structure', () => {
            const result = blendHybridScore(
                makeCriteriaResult(8),
                { score: 6, breakdown: [{ question: 'q1', answer: true }] },
                'context-retention'
            );

            expect(result).toHaveProperty('quality_score');
            expect(result).toHaveProperty('scoring_method', 'hybrid');
            expect(result).toHaveProperty('scoring_type', 'context-retention');
            expect(result).toHaveProperty('deterministic_type', 'criteria');
            expect(result).toHaveProperty('matched_expected', true);
            expect(result).toHaveProperty('accuracy_score');
            expect(result).toHaveProperty('compliance_score');
            expect(result).toHaveProperty('explanation');
            expect(result).toHaveProperty('breakdown');
            expect(result).toHaveProperty('judge_confidence', 0.95);
            expect(result).toHaveProperty('needs_review', false);
            expect(result.breakdown).toHaveProperty('overall');
            expect(result.breakdown).toHaveProperty('accuracy');
            expect(result.breakdown).toHaveProperty('compliance');
        });

        it('should handle NaN/undefined scores gracefully', () => {
            const result = blendHybridScore(
                { score: undefined, matched: false },
                { score: NaN, breakdown: [] },
                'general'
            );

            expect(result.accuracy_score).toBe(0);
            expect(result.compliance_score).toBe(0);
            expect(result.quality_score).toBe(0);
        });

        it('should include compliance_details in breakdown when available', () => {
            const breakdown = [
                { question: 'Q1', answer: true, contributed: true },
                { question: 'Q2', answer: false, contributed: false }
            ];
            const result = blendHybridScore(
                makeCriteriaResult(10),
                { score: 5, breakdown },
                'context-retention'
            );

            expect(result.breakdown.compliance_details).toEqual(breakdown);
        });
    });

    describe('DEFAULT_HYBRID_WEIGHTS', () => {
        it('should have accuracy and compliance weights summing to 1.0', () => {
            expect(DEFAULT_HYBRID_WEIGHTS.accuracy + DEFAULT_HYBRID_WEIGHTS.compliance).toBeCloseTo(1.0, 3);
        });

        it('should default to 0.70/0.30', () => {
            expect(DEFAULT_HYBRID_WEIGHTS.accuracy).toBe(0.70);
            expect(DEFAULT_HYBRID_WEIGHTS.compliance).toBe(0.30);
        });
    });
});
