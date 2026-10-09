'use strict';

jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { freezeJudgeConfig } = require('../../../src/services/benchmark/judgeExecutionContract');
const { buildOllamaTarget, buildQualityCohortFingerprint } = require('../../../../shared/benchmarkTargetContract');

const JUDGE = { model: 'judge:latest', host: 'http://judge:11434' };
function snapshot(model = JUDGE.model, host = JUDGE.host, numCtx = 65536) {
    return { version: 'agentx.inference-contract.v1',
        artifact: { model, host, hostId: host, digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64),
            identityQualified: true, registryQualified: true },
        qualification: { qualified: false, stale: true },
        contextBudget: { windowTokens: numCtx, source: 'host_preference_pin' }
    };
}
const resolve = jest.fn(async (_path, options) => {
    const request = JSON.parse(options.body);
    return snapshot(request.model, request.host, request.options.num_ctx || 65536);
});
beforeEach(() => resolve.mockClear());

test('freezes the automatic pin and exact identity despite a stale candidate profile', async () => {
    const frozen = await freezeJudgeConfig(JUDGE, { resolveContract: resolve });
    expect(frozen).toMatchObject({ num_ctx: 65536, execution_contract: {
        schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
        artifact: { model: JUDGE.model, host: JUDGE.host, digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) }
    } });
    expect(JSON.parse(resolve.mock.calls[0][1].body).options).not.toHaveProperty('num_ctx');
});

test('keeps an explicit context while still verifying the current identity', async () => {
    const frozen = await freezeJudgeConfig({ ...JUDGE, num_ctx: 32768 }, { resolveContract: resolve });
    expect(frozen.num_ctx).toBe(32768);
    expect(JSON.parse(resolve.mock.calls[0][1].body).options.num_ctx).toBe(32768);
    expect(resolve).toHaveBeenCalledTimes(1);
});

test.each([
    data => { data.contextBudget.windowTokens = null; },
    data => { data.contextBudget.windowTokens = 0; },
    data => { data.contextBudget.windowTokens = 8192.5; },
    data => { data.artifact.digest = null; },
    data => { data.artifact.runtimeFingerprint = null; },
    data => { data.artifact.host = 'http://other:11434'; },
    data => { data.artifact.model = 'other:latest'; },
    data => { data.artifact.identityQualified = false; }
])('refuses an incomplete or mismatched contract before any inference', async change => {
    const data = snapshot(); change(data);
    await expect(freezeJudgeConfig(JUDGE, { resolveContract: async () => data }))
        .rejects.toMatchObject({ code: 'JUDGE_EXECUTION_CONTRACT_UNRESOLVED' });
});

test('freezes all secondary judges and the tiebreaker before the run', async () => {
    const config = { ...JUDGE, multi_judge: { enabled: true, escalation_budget_percent: 20,
        judges: [JUDGE, { ...JUDGE, model: 'second:latest' }], tiebreaker: { ...JUDGE, model: 'tie:latest' } } };
    const frozen = await freezeJudgeConfig(config, { resolveContract: resolve });
    expect(frozen.multi_judge.judges.map(judge => judge.num_ctx)).toEqual([65536, 65536]);
    expect(frozen.multi_judge.tiebreaker.execution_contract.artifact.model).toBe('tie:latest');
    expect(config).not.toHaveProperty('execution_contract');
});

test('automatic context, digest and runtime settings each separate quality cohorts', async () => {
    const frozen = await freezeJudgeConfig(JUDGE, { resolveContract: resolve });
    const cohort = config => buildQualityCohortFingerprint({ scorerVersion: 'test',
        judgeTarget: buildOllamaTarget(JUDGE.host, JUDGE.model), judgeConfig: config, executionConfig: {} });
    for (const variant of [
        { ...frozen, num_ctx: 32768 },
        { ...frozen, execution_contract: { ...frozen.execution_contract, artifact: { ...frozen.execution_contract.artifact, digest: 'c'.repeat(64) } } },
        { ...frozen, execution_contract: { ...frozen.execution_contract, artifact: { ...frozen.execution_contract.artifact, runtimeFingerprint: 'd'.repeat(64) } } }
    ]) expect(cohort(variant)).not.toBe(cohort(frozen));
    expect(cohort({ ...frozen, observed_at: new Date() })).toBe(cohort(frozen));
});

test('multi-judge identity and policy separate cohorts while escalation usage does not', async () => {
    const frozen = await freezeJudgeConfig({ ...JUDGE, multi_judge: { enabled: true, judges: [JUDGE], tiebreaker: JUDGE } }, { resolveContract: resolve });
    const cohort = config => buildQualityCohortFingerprint({ scorerVersion: 'test',
        judgeTarget: buildOllamaTarget(JUDGE.host, JUDGE.model), judgeConfig: config, executionConfig: {} });
    const multi = frozen.multi_judge;
    expect(cohort({ ...frozen, multi_judge: { ...multi, _escalation: { used: 5 }, tiebreaker: { ...multi.tiebreaker, judgeCallEvidence: [] } } }))
        .toBe(cohort(frozen));
    expect(cohort({ ...frozen, multi_judge: { ...multi, escalation_budget_percent: 50 } })).not.toBe(cohort(frozen));
    expect(cohort({ ...frozen, multi_judge: { ...multi, judges: [{ ...multi.judges[0], seed: 42 }] } })).not.toBe(cohort(frozen));
});
