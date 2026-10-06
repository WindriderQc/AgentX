'use strict';

const { buildJudgeQualificationContract, qualificationContractFingerprint } = require('../../../src/services/benchmark/judgeQualificationContract');
const { freezeJudgeConfig } = require('../../../src/services/benchmark/judgeExecutionContract');
const { diagnosticInput } = require('../../../src/services/benchmark/judgeCalibrationDiagnostic');

const resolver = async (_path, options) => {
    const { model, host, options: settings } = JSON.parse(options.body);
    return { version: 'agentx.inference-contract.v1',
        artifact: { model, host, digest: 'digest-a', runtimeFingerprint: 'runtime-a', identityQualified: true, registryQualified: true },
        contextBudget: { windowTokens: settings.num_ctx || 65536 } };
};

async function frozen(multi = null) {
    return freezeJudgeConfig({ model: 'judge:latest', host: 'http://judge:11434', seed: null,
        ...(multi ? { multi_judge: multi } : {}) }, { resolveContract: resolver });
}

test('one canonical contract uses the resolved cohort settings and preserves null versus zero seed', async () => {
    const config = await frozen();
    const contract = buildJudgeQualificationContract(config);
    expect(contract.settings.seed).toBeNull();
    expect(qualificationContractFingerprint(buildJudgeQualificationContract({ ...config, seed: 0 })))
        .not.toBe(qualificationContractFingerprint(contract));
    delete config.seed;
    expect(buildJudgeQualificationContract(config)).toBeNull();
});

test('escalation policy, every participant and the tiebreaker enter the contract; transient usage does not', async () => {
    const judge = { model: 'judge:latest', host: 'http://judge:11434' };
    const config = await frozen({ enabled: true, judges: [judge, { ...judge, model: 'secondary' }], tiebreaker: { ...judge, model: 'tie' } });
    const key = multi => qualificationContractFingerprint(buildJudgeQualificationContract(config, { escalation: multi }));
    const base = key(config.multi_judge);
    expect(base).not.toBe(key(null));
    expect(base).toBe(key({ ...config.multi_judge, _escalation: { used: 10, budget: 20 } }));
    for (const [field, value] of Object.entries({ escalation_budget_percent: 50, confidenceThreshold: 0.5, autoMinLevel: 2,
        escalateOnJudgeFailure: false, escalateOnReview: false, escalateOnLowConfidence: false, escalateOnHighLevel: false })) {
        expect(key({ ...config.multi_judge, [field]: value })).not.toBe(base);
    }
    expect(key({ ...config.multi_judge, tiebreaker: { ...config.multi_judge.tiebreaker, seed: 42 } })).not.toBe(base);
    expect(key({ ...config.multi_judge, judges: config.multi_judge.judges.slice(1) })).not.toBe(base);
});

test('complete explicit calibrations may publish; partial selections stay diagnostic', () => {
    const cases = [{ id: 'a' }, { id: 'b' }];
    expect(diagnosticInput({ num_ctx: 8192, num_predict: 1600, timeout: 120000, think: true,
        temperature: 0.2, seed: null, voting_count: 3, max_retries: 0 }, cases)).toMatchObject({ diagnostic: false,
            options: { temperature: 0.2, seed: null, voting_count: 3, max_retries: 0 } });
    expect(diagnosticInput({ case_ids: ['b', 'a', 'a'] }, cases).diagnostic).toBe(false);
    expect(diagnosticInput({ case_ids: ['a'], think: true }, cases).diagnostic).toBe(true);
});

test.each([{ seed: '7' }, { seed: 0.5 }, { temperature: -1 }, { voting_count: 0 }, { max_retries: -1 }])(
    'refuses invalid explicit settings before calibration: %j', input => {
        expect(() => diagnosticInput(input, [{ id: 'a' }])).toThrow();
    });
