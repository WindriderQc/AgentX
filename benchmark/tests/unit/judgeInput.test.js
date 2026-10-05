const { assertJudgeInputUnmodified, assertJudgeOutputComplete } = require('../../src/services/scoring/judgeInput');

test.each([{ done_reason: 'length' }, { done: false }])('rejects explicitly incomplete judge output: %j', data => {
    expect(() => assertJudgeOutputComplete(data)).toThrow('quality was not evaluated');
});

test('completed and legacy verdicts without completion metadata retain their existing behavior', () => {
    expect(() => assertJudgeOutputComplete({ done: true, done_reason: 'stop' })).not.toThrow();
    expect(() => assertJudgeOutputComplete({})).not.toThrow();
});

test.each(['truncation', 'condensation'])('rejects reported upstream %s', change => {
    expect(() => assertJudgeInputUnmodified({ agentx_contract: { contextBudget: {
        transformations: { [change]: { applied: true } }
    } } })).toThrow('quality was not evaluated');
});

test('an estimate alone does not pretend truncation was measured', () => {
    expect(() => assertJudgeInputUnmodified({ agentx_contract: { contextBudget: {
        input: { fits: false }, transformations: { upstreamTruncationRisk: true }
    } } })).not.toThrow();
    expect(() => assertJudgeInputUnmodified({})).not.toThrow();
});

const frozen = { schema: 'agentx.benchmark-judge-execution/v1', num_ctx: 65536,
    artifact: { model: 'judge:latest', host: 'http://judge:11434', hostId: 'judge-host',
        digest: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64) } };
const judgeResponse = () => ({ agentx_contract: { artifact: { ...frozen.artifact,
    identityQualified: true, registryQualified: true }, contextBudget: { windowTokens: 65536 } } });

test('accepts the exact frozen judge identity and window', () => {
    expect(() => assertJudgeInputUnmodified(judgeResponse(), { execution_contract: frozen })).not.toThrow();
});

test.each(['model', 'host', 'hostId', 'digest', 'runtimeFingerprint', 'identityQualified', 'registryQualified'])
('rejects a judge response whose %s changed', field => {
    const data = judgeResponse();
    data.agentx_contract.artifact[field] = field.endsWith('Qualified') ? false : 'changed';
    expect(() => assertJudgeInputUnmodified(data, { execution_contract: frozen })).toThrow('frozen contract');
});

test('rejects an omitted contract or a changed automatic window', () => {
    expect(() => assertJudgeInputUnmodified({}, { execution_contract: frozen })).toThrow('frozen contract');
    const data = judgeResponse();
    data.agentx_contract.contextBudget.windowTokens = 4096;
    expect(() => assertJudgeInputUnmodified(data, { execution_contract: frozen })).toThrow('frozen contract');
});
