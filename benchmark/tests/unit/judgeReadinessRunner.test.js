'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { getJudgeReadiness } = require('../../src/services/benchmark/judgeReadiness');

function runner(available, mode = 'volume') {
    return {
        mode,
        isAvailable: () => available,
        describe: () => ({ mode, jobs_dir: '/jobs', available, reason: null, heartbeat_at: null, runner_version: '1' })
    };
}

describe('execution-scored evidence follows the code runner', () => {
    test('is available when the runner answers, whatever the judge situation', async () => {
        const readiness = await getJudgeReadiness({
            hosts: [], defaults: {}, config: null, env: {}, codeRunner: runner(true, 'local')
        });
        expect(readiness.ready).toBe(false);
        expect(readiness.evidence_modes.execution_scored).toMatchObject({
            status: 'available',
            label: 'Execution-scored evidence',
            runner: { mode: 'local', available: true }
        });
        expect(readiness.evidence_modes.execution_scored.description).toContain('local runner');
    });

    test('is blocked without a runner, and says the rows ask for review', async () => {
        const readiness = await getJudgeReadiness({
            hosts: [], defaults: {}, config: null, env: {}, codeRunner: runner(false, 'off')
        });
        expect(readiness.evidence_modes.execution_scored.status).toBe('blocked');
        expect(readiness.evidence_modes.execution_scored.description).toContain('ask for review');
        // The other modes are untouched by the runner.
        expect(readiness.evidence_modes.deterministic.status).toBe('available');
    });
});
