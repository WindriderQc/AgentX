const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/scoring/judgeCall', () => ({ callJudge: jest.fn() }));
const { callJudge } = require('../../src/services/scoring/judgeCall');

jest.mock('../../src/services/benchmark/judgeReadiness', () => {
    const actual = jest.requireActual('../../src/services/benchmark/judgeReadiness');
    return {
        ...actual,
        resolveReadyJudgeTarget: jest.fn()
    };
});

jest.mock('../../src/services/benchmark/judging', () => ({
    judgeResult: jest.fn(),
    stopJudging: jest.fn()
}));

jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => ({
    runManagedWorkload: jest.fn(async (_id, _options, task) => task({ signal: undefined, assertActive: () => true })),
    withManagedWorkloadRoute: (_kind, _resolveOptions, handler) => handler
}));

jest.mock('../../models/BenchmarkResult', () => ({
    findById: jest.fn(() => ({
        select: jest.fn(() => ({
            lean: jest.fn(async () => ({
                _id: '507f1f77bcf86cd799439011',
                batch_id: null
            }))
        }))
    }))
}));

jest.mock('../../src/services/benchmark/executionHostValidator', () => ({
    validateExecutionHost: jest.fn(async () => ({ valid: true, available_models: [] }))
}));

jest.mock('../../src/services/benchmark/modelDigestService', () => ({
    getModelDigest: jest.fn(async () => null)
}));

jest.mock('../../src/services/benchmark/sweepRunner', () => ({
    runSweep: jest.fn()
}));

const readinessService = require('../../src/services/benchmark/judgeReadiness');
const { judgeResult } = require('../../src/services/benchmark/judging');
const { validateExecutionHost } = require('../../src/services/benchmark/executionHostValidator');
const resultsRouter = require('../../routes/benchmark/results');
const coreRouter = require('../../routes/benchmark/core');
const sweepsRouter = require('../../routes/benchmark/sweeps');

const app = express();
app.use(express.json());
app.use('/api/benchmark', resultsRouter);
app.use('/api/benchmark', coreRouter);
app.use('/api/benchmark', sweepsRouter);

const blocked = {
    ready: false,
    code: 'no_judge_selected',
    error: 'No selected, reachable judge is ready.',
    readiness: {
        ready: false,
        status: 'blocked',
        setup: { href: '#the-bench', label: 'Choose a judge' }
    }
};

describe('judge-required API action gates', () => {
    afterEach(() => jest.clearAllMocks());

    test.each(['calibrate', 'calibrate-accuracy'])('rejects invalid context before %s inference', async endpoint => {
        const response = await request(app).post(`/api/benchmark/judge/${endpoint}`).send({ num_ctx: 0 });
        expect(response.status).toBe(400);
        expect(readinessService.resolveReadyJudgeTarget).not.toHaveBeenCalled();
        expect(callJudge).not.toHaveBeenCalled();
    });

    test('uses the requested context throughout quick calibration', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true, target: { host: 'http://judge:11434', model: 'judge:14b' }
        });
        callJudge.mockResolvedValue({ success: true, scores: { overall: 8, accuracy: 8 } });
        const response = await request(app).post('/api/benchmark/judge/calibrate').send({ num_ctx: 8192 });
        expect(response.body.data.requested_num_ctx).toBe(8192);
        expect(callJudge.mock.calls.every(([, config]) => config.num_ctx === 8192)).toBe(true);
    });

    test('retains accuracy judge evidence and the requested context', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true, target: { host: 'http://judge:11434', model: 'judge:14b' }
        });
        const scorer = jest.spyOn(require('../../src/services/qualityScorer'), 'scoreResponse').mockResolvedValue({
            quality_score: 0, scoring_method: 'decomposed', explanation: 'Missing behavior',
            breakdown: { correctness: 0 }, judge_prompt: '["criterion"]', judge_raw_response: '{"calls":[]}'
        });
        try {
            const response = await request(app).post('/api/benchmark/judge/calibrate-accuracy').send({ num_ctx: 8192 });
            expect(response.status).toBe(200);
            expect(response.body.data.requested_num_ctx).toBe(8192);
            expect(scorer.mock.calls.every(([input]) => input.judgeConfig.num_ctx === 8192)).toBe(true);
            expect(response.body.data.results[0]).toMatchObject({ judge_score: 0,
                explanation: 'Missing behavior', judge_prompt: '["criterion"]', judge_raw_response: '{"calls":[]}' });
            // Without a database the report is still returned; the missing record is stated.
            expect(response.body.data.valid).toBe(false);
            expect(response.body.data.qualification_record).toEqual({ error: expect.stringMatching(/not recorded/) });
        } finally { scorer.mockRestore(); }
    });

    test('allows a cold judge to load before applying the warm quick-check timeout', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true, target: { host: 'http://judge:11434', model: 'judge:14b' }
        });
        callJudge.mockResolvedValue({ success: true, scores: { overall: 8, accuracy: 8 } });
        const response = await request(app).post('/api/benchmark/judge/calibrate').send({});
        expect(response.status).toBe(200);
        expect(callJudge).toHaveBeenCalledTimes(5);
        expect(callJudge.mock.calls[0][1].timeout).toBe(120000);
        expect(callJudge.mock.calls.slice(1).every(([, config]) => config.timeout === 20000)).toBe(true);
    });

    test('blocks re-judge before invoking the judge service', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/results/507f1f77bcf86cd799439011/rejudge')
            .send({});

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(judgeResult).not.toHaveBeenCalled();
    });

    test('passes the probed target to re-judge when ready', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true,
            target: { host: 'http://judge:11434', model: 'judge:7b', source: 'request' },
            readiness: { ready: true }
        });
        judgeResult.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', quality_score: 8 });

        const response = await request(app)
            .post('/api/benchmark/results/507f1f77bcf86cd799439011/rejudge')
            .send({ judge_host: 'http://judge:11434', judge_model: 'judge:7b' });

        expect(response.status).toBe(200);
        expect(judgeResult).toHaveBeenCalledWith('507f1f77bcf86cd799439011', {
            host: 'http://judge:11434',
            model: 'judge:7b'
        });
    });

    test('blocks benchmark launch before execution-host work begins', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/batch')
            .send({
                host: 'http://exec:11434',
                models: ['candidate:7b'],
                levels: [1]
            });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(validateExecutionHost).not.toHaveBeenCalled();
    });

    test('lets a launch with a larger judge budget and timeout reach the readiness check', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/batch')
            .send({
                host: 'http://exec:11434',
                models: ['candidate:7b'],
                levels: [1],
                judge_config: { num_predict: 8192, timeout: 300000 }
            });

        // Before, these limits were refused with 400 before any check ran.
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
    });

    test('blocks an executing sweep before its runner can launch a batch', async () => {
        const { runSweep } = require('../../src/services/benchmark/sweepRunner');
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/sweeps/run')
            .send({ execute: true, host: 'alpha', candidates: [{ model: 'candidate:7b' }] });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(runSweep).not.toHaveBeenCalled();
    });
});
