/**
 * Judging Module Unit Tests
 * Tests for decoupled judging orchestration
 */

// Mock logger
jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock models
jest.mock('../../models/BenchmarkResult', () => ({
    findById: jest.fn(),
    find: jest.fn(),
    updateOne: jest.fn(),
    countDocuments: jest.fn()
}));

jest.mock('../../models/BenchmarkBatch', () => ({
    findById: jest.fn(),
    updateOne: jest.fn()
}));

// Mock qualityScorer
jest.mock('../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(),
    calculateCompositeScore: jest.fn(),
    JUDGE_CONFIG: { model: 'test-judge:latest', host: 'http://localhost:11434', timeout: 120000 }
}));

// Mock errorClassifier
jest.mock('../../src/services/benchmark/errorClassifier', () => ({
    classifyBenchmarkError: jest.fn().mockReturnValue({
        infra: false,
        type: 'judge_error',
        httpStatus: null,
        message: 'Judge failed'
    })
}));

// Mock ConcurrencyQueue
jest.mock('../../src/services/benchmark/ConcurrencyQueue', () => {
    return jest.fn().mockImplementation(() => ({
        add: jest.fn().mockImplementation(fn => {
            return fn().catch(() => {});
        }),
        drain: jest.fn().mockResolvedValue({ completed: 0, failed: 0, timedOut: false }),
        getStatus: jest.fn().mockReturnValue({ queued: 0, running: 0, completed: 0, failed: 0 })
    }));
});

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const { scoreResponse, calculateCompositeScore } = require('../../src/services/qualityScorer');
const { classifyBenchmarkError } = require('../../src/services/benchmark/errorClassifier');
const { applyScoresToResult, judgeResult, judgeBatch, stopJudging, getJudgingStatus } = require('../../src/services/benchmark/judging');

beforeEach(() => {
    jest.clearAllMocks();
});

// ---- applyScoresToResult ----

describe('applyScoresToResult', () => {
    const mockScores = {
        quality_score: 7.5,
        breakdown: { accuracy: 8, completeness: 7 },
        explanation: 'Good response',
        judge_prompt: 'Evaluate this',
        judge_model: 'test-judge:latest',
        judge_raw_response: '{"score": 7.5}',
        judge_hardware_snapshot: null,
        scoring_method: 'llm',
        scoring_type: 'reasoning',
        scoring_time_ms: 1200,
        quick_pattern: null,
        judge_confidence: 0.85,
        prompt_complexity: 'medium',
        needs_review: false,
        review_reason: null,
        truncation: null
    };

    const mockResultData = {
        latency: 500,
        tokens_per_sec: 25,
        prompt_category: 'coding',
        scoring_type: 'reasoning'
    };

    beforeEach(() => {
        calculateCompositeScore.mockReturnValue({
            composite_score: 72.5,
            composite_profile_used: 'coding',
            normalized: { quality: 0.75, latency: 0.8, speed: 0.6 }
        });
        BenchmarkResult.updateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    });

    it('should write correct $set fields to BenchmarkResult', async () => {
        const result = await applyScoresToResult('result-123', mockScores, mockResultData);

        expect(BenchmarkResult.updateOne).toHaveBeenCalledWith(
            { _id: 'result-123' },
            {
                $set: expect.objectContaining({
                    quality_score: 7.5,
                    quality_breakdown: { accuracy: 8, completeness: 7 },
                    scoring_method: 'llm',
                    composite_score: 72.5,
                    judge_confidence: 0.85,
                    needs_review: false
                })
            }
        );

        expect(result.quality_score).toBe(7.5);
        expect(result.composite_score).toBe(72.5);
    });

    it('should call calculateCompositeScore with correct args', async () => {
        await applyScoresToResult('result-123', mockScores, mockResultData);

        expect(calculateCompositeScore).toHaveBeenCalledWith(
            { latency: 500, tokens_per_sec: 25, quality_score: 7.5 },
            'coding'
        );
    });

    it('should handle llm_failed case with error classification', async () => {
        const failedScores = {
            ...mockScores,
            scoring_method: 'llm_failed',
            error: 'Connection timeout',
            explanation: 'Connection timeout'
        };

        await applyScoresToResult('result-123', failedScores, mockResultData);

        expect(classifyBenchmarkError).toHaveBeenCalledWith('Connection timeout');
        const updateCall = BenchmarkResult.updateOne.mock.calls[0][1].$set;
        expect(updateCall.error).toBe('Connection timeout');
        expect(updateCall.error_type).toBe('judge_error');
    });

    it('should include truncation fields when present', async () => {
        const scoresWithTruncation = {
            ...mockScores,
            truncation: { judge_truncated: true, judge_tokens: 4096 }
        };

        await applyScoresToResult('result-123', scoresWithTruncation, mockResultData);

        const updateCall = BenchmarkResult.updateOne.mock.calls[0][1].$set;
        expect(updateCall['truncation.judge_truncated']).toBe(true);
        expect(updateCall['truncation.judge_tokens']).toBe(4096);
    });

    it('should default prompt_category to interactive', async () => {
        await applyScoresToResult('result-123', mockScores, { ...mockResultData, prompt_category: null });

        expect(calculateCompositeScore).toHaveBeenCalledWith(
            expect.anything(),
            'interactive'
        );
    });
});

// ---- judgeResult ----

describe('judgeResult', () => {
    const mockResult = {
        _id: 'result-123',
        success: true,
        response: 'The answer is 42',
        prompt: 'What is the meaning?',
        prompt_name: 'test-prompt',
        prompt_level: 3,
        prompt_category: 'reasoning',
        expected_answer: '42',
        scoring_type: 'reasoning',
        judge_model: 'test-judge:latest',
        judge_host: 'http://localhost:11434',
        latency: 1000,
        tokens_per_sec: 30
    };

    beforeEach(() => {
        BenchmarkResult.findById.mockResolvedValue(mockResult);
        scoreResponse.mockResolvedValue({
            quality_score: 8.0,
            breakdown: {},
            explanation: 'Good',
            scoring_method: 'llm',
            scoring_type: 'reasoning',
            scoring_time_ms: 500,
            judge_model: 'test-judge:latest',
            judge_confidence: 0.9,
            needs_review: false
        });
        calculateCompositeScore.mockReturnValue({
            composite_score: 75,
            composite_profile_used: 'reasoning',
            normalized: {}
        });
        BenchmarkResult.updateOne.mockResolvedValue({ matchedCount: 1 });
    });

    it('should load result and call scoreResponse', async () => {
        const result = await judgeResult('result-123');

        expect(BenchmarkResult.findById).toHaveBeenCalledWith('result-123');
        expect(scoreResponse).toHaveBeenCalledWith({
            response: 'The answer is 42',
            prompt: expect.objectContaining({
                prompt: 'What is the meaning?',
                name: 'test-prompt',
                level: 3,
                category: 'reasoning'
            }),
            judgeConfig: expect.objectContaining({
                model: 'test-judge:latest'
            })
        });
        expect(result.quality_score).toBe(8.0);
    });

    it('should throw on not found', async () => {
        BenchmarkResult.findById.mockResolvedValue(null);
        await expect(judgeResult('bad-id')).rejects.toThrow('not found');
    });

    it('should throw on failed test', async () => {
        BenchmarkResult.findById.mockResolvedValue({ ...mockResult, success: false });
        await expect(judgeResult('result-123')).rejects.toThrow('Cannot judge failed');
    });

    it('should throw on empty response', async () => {
        BenchmarkResult.findById.mockResolvedValue({ ...mockResult, response: '' });
        await expect(judgeResult('result-123')).rejects.toThrow('No response');
    });

    it('should merge judgeConfig overrides', async () => {
        await judgeResult('result-123', { model: 'custom-judge:latest', host: 'http://custom:11434' });

        expect(scoreResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                judgeConfig: {
                    model: 'custom-judge:latest',
                    host: 'http://custom:11434'
                }
            })
        );
    });
});

// ---- judgeBatch ----

describe('judgeBatch', () => {
    beforeEach(() => {
        BenchmarkBatch.findById.mockResolvedValue({
            _id: 'batch-123',
            status: 'completed',
            calculateMetrics: jest.fn().mockResolvedValue(undefined)
        });
        BenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 1 });
        BenchmarkResult.find.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([
                    { _id: 'r1', prompt_name: 'p1', prompt_level: 1, prompt_category: 'coding' },
                    { _id: 'r2', prompt_name: 'p2', prompt_level: 2, prompt_category: 'reasoning' }
                ])
            })
        });
        BenchmarkResult.findById.mockResolvedValue({
            _id: 'r1',
            success: true,
            response: 'test',
            prompt: 'q',
            prompt_name: 'p1',
            prompt_level: 1,
            prompt_category: 'coding',
            latency: 500,
            tokens_per_sec: 20,
            judge_model: 'test-judge:latest',
            judge_host: 'http://localhost:11434'
        });
        scoreResponse.mockResolvedValue({
            quality_score: 7.0,
            scoring_method: 'llm',
            scoring_time_ms: 300,
            judge_model: 'test-judge:latest',
            judge_confidence: 0.8,
            needs_review: false
        });
        calculateCompositeScore.mockReturnValue({
            composite_score: 70,
            composite_profile_used: 'coding',
            normalized: {}
        });
        BenchmarkResult.updateOne.mockResolvedValue({ matchedCount: 1 });
    });

    it('should find pending results and judge them', async () => {
        const result = await judgeBatch('batch-123');

        expect(BenchmarkResult.find).toHaveBeenCalledWith(
            expect.objectContaining({
                batch_id: 'batch-123',
                success: true,
                scoring_method: { $in: ['pending', 'llm_failed'] }
            })
        );
        expect(result).toHaveProperty('judged');
        expect(result).toHaveProperty('failed');
        expect(result).toHaveProperty('timedOut');
    });

    it('should reject if batch is still running', async () => {
        BenchmarkBatch.findById.mockResolvedValue({ _id: 'batch-123', status: 'running' });

        await expect(judgeBatch('batch-123')).rejects.toThrow('still running');
    });

    it('should return zeros for empty batch', async () => {
        BenchmarkResult.find.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue([])
            })
        });

        const result = await judgeBatch('batch-123');
        expect(result).toEqual({ judged: 0, failed: 0, timedOut: false });
    });

    it('should throw if batch not found', async () => {
        BenchmarkBatch.findById.mockResolvedValue(null);
        await expect(judgeBatch('bad-batch')).rejects.toThrow('not found');
    });

    it('should include all results when force=true', async () => {
        await judgeBatch('batch-123', { force: true });

        const findCall = BenchmarkResult.find.mock.calls[0][0];
        expect(findCall.scoring_method).toBeUndefined();
    });
});

// ---- stopJudging ----

describe('stopJudging', () => {
    it('should return false when no active judging', () => {
        const result = stopJudging('non-existent-batch');
        expect(result).toBe(false);
    });
});

// ---- getJudgingStatus ----

describe('getJudgingStatus', () => {
    it('should return batch counters when no active job', async () => {
        BenchmarkBatch.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    judge_status: 'completed',
                    judge_total: 10,
                    judge_completed: 10,
                    judge_failed: 1
                })
            })
        });

        const status = await getJudgingStatus('batch-123');

        expect(status.active).toBe(false);
        expect(status.judge_status).toBe('completed');
        expect(status.judge_total).toBe(10);
        expect(status.judge_completed).toBe(10);
    });

    it('should throw if batch not found', async () => {
        BenchmarkBatch.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(null)
            })
        });

        await expect(getJudgingStatus('bad-batch')).rejects.toThrow('not found');
    });
});
