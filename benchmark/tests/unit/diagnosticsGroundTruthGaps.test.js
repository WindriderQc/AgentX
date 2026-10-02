const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/services/judgeValidation', () => ({}));
jest.mock('../../models/JudgeGroundTruth', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/benchmark/calibrationRunner', () => ({}));
jest.mock('../../models/JudgeAccuracyMatrix', () => ({}));
jest.mock('../../src/services/benchmark/driftDetector', () => ({}));
jest.mock('../../src/services/benchmark/retroCalibration', () => ({
    runRetroCalibration: jest.fn(),
    getCoverageStats: jest.fn()
}));
jest.mock('../../src/services/judgeFeedbackLoop', () => ({}));
jest.mock('../../src/services/judgeGovernance', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({}));
jest.mock('../../models/BenchmarkResult', () => ({}));

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { getCoverageStats } = require('../../src/services/benchmark/retroCalibration');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

function createApp() {
    const app = express();
    app.use(diagnosticsRouter);
    return app;
}

describe('GET /judge/ground-truth/gaps', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('uses cryptographically verified coverage while retaining raw and retro counts', async () => {
        getCoverageStats.mockResolvedValue({
            cells: [
                { category: 'coding', difficulty: 1, count: 0, all_count: 3, retro: 3 },
                { category: 'math', difficulty: 2, count: 3, all_count: 4, retro: 1 }
            ]
        });

        const response = await request(createApp())
            .get('/judge/ground-truth/gaps')
            .expect(200);

        expect(response.body.status).toBe('success');
        expect(response.body.data).toMatchObject({
            total_entries: 3,
            total_all_entries: 7,
            retro_entries: 4,
            total_cells: 35,
            empty_cells: 34,
            coverage_pct: 3,
            coverage_basis: 'occupied_cells',
            target_per_cell: 5,
            cells_meeting_target: 0,
            target_coverage_pct: 0,
            hard_scope: {
                levels: [4, 5],
                total_cells: 14,
                entries: 0,
                occupied_cells: 0,
                cells_meeting_target: 0,
                target_coverage_pct: 0,
                ready: false
            }
        });

        expect(response.body.data.grid).toEqual(expect.arrayContaining([
            { category: 'coding', difficulty: 1, count: 0, all_count: 3, retro: 3 },
            { category: 'math', difficulty: 2, count: 3, all_count: 4, retro: 1 }
        ]));
        expect(getCoverageStats).toHaveBeenCalledTimes(1);
        expect(JudgeGroundTruth.aggregate).not.toHaveBeenCalled();
    });

    it('does not mark hard scope ready when raw rows outnumber qualified reviews', async () => {
        const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
        getCoverageStats.mockResolvedValue({
            cells: categories.flatMap(category => [4, 5].map(difficulty => ({
                category,
                difficulty,
                count: 4,
                all_count: 5,
                retro: 0
            })))
        });

        const response = await request(createApp())
            .get('/judge/ground-truth/gaps')
            .expect(200);

        expect(response.body.data).toMatchObject({
            total_entries: 56,
            total_all_entries: 70,
            cells_meeting_target: 0,
            hard_scope: {
                entries: 56,
                occupied_cells: 14,
                cells_meeting_target: 0,
                ready: false
            }
        });
    });

    it('fails closed when coverage computation rejects', async () => {
        getCoverageStats.mockRejectedValue(Object.assign(
            new Error('one qualified prompt is assigned to multiple coverage cells'),
            { code: 'HUMAN_EVIDENCE_PROMPT_CELL_CONFLICT' }
        ));

        const response = await request(createApp())
            .get('/judge/ground-truth/gaps')
            .expect(500);

        expect(response.body).toEqual({
            status: 'error',
            error: 'one qualified prompt is assigned to multiple coverage cells'
        });
        expect(response.body.data).toBeUndefined();
    });
});
