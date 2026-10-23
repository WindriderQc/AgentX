'use strict';
const readiness = require('../../src/services/pipelineCodingReadiness');
const task = () => ({ title: 'Bounded source fix', spec: 'Preserve the caller when rejecting invalid input.', service: 'agentx-coding',
  automation: { scope: ['core/src/services/inferenceRuntimePolicy.js'], verificationProfile: 'agentx-core-runner-tests/v1', fingerprint: 'a'.repeat(64) } });
const definition = () => ({ acceptanceCriteria: ['Invalid input is rejected and valid input still succeeds.'],
  requiredCapabilities: ['source_read', 'source_write', 'cpu_tests'], estimate: { modelCalls: 20, workSeconds: 600 } });
const limits = { modelCalls: 32, workSeconds: 900 };
test('feasibility is a read-only contract assessment with no claim of model competence', () => {
  const input = task(), before = structuredClone(input);
  expect(readiness.assess(input, limits, definition())).toMatchObject({ status: 'ready', canAuthorize: true });
  expect(readiness.assess(input, limits, definition()).evidence).toContain('operator-declared');
  expect(input).toEqual(before);
});
test('undefined acceptance criteria require clarification rather than spending calls on a planner', () => {
  expect(readiness.assess(task(), limits)).toMatchObject({ status: 'needs_clarification', canAuthorize: false,
    issues: [expect.objectContaining({ code: 'acceptance_not_defined' })] });
});
test.each(['network', 'private_data', 'live_inference', 'deployment', 'physical_device'])('%s work cannot be silently delegated to the offline coding worker', capability => {
  const proposed = definition(); proposed.requiredCapabilities.push(capability);
  expect(readiness.assess(task(), limits, proposed)).toMatchObject({ status: 'unsupported_by_worker', canAuthorize: false,
    issues: [expect.objectContaining({ code: `capability_${capability}` })] });
});
test('missing verification and mismatched source areas are prerequisites, not model failures', () => {
  const input = task(); input.automation.verificationProfile = 'not-installed/v1';
  expect(readiness.assess(input, limits, definition()).status).toBe('missing_prerequisite');
  input.automation.verificationProfile = 'agentx-dispatcher-tests/v1';
  expect(readiness.assess(input, limits, definition()).issues[0].code).toBe('verification_scope_mismatch');
});
test('the bounded Core verifier does not certify unrelated files just because they share core/', () => {
  const input = task(); input.automation.scope = ['core/src/services/unrelated.js'];
  expect(readiness.assess(input, limits, definition()).issues[0].code).toBe('verification_scope_mismatch');
});
test.each(['workSeconds', 'modelCalls'])('a reviewed %s estimate above the envelope requires decomposition without changing the budget', field => {
  const proposed = definition(); proposed.estimate[field] = limits[field] + 1;
  expect(readiness.assess(task(), limits, proposed).status).toBe('needs_decomposition');
  expect(limits).toEqual({ modelCalls: 32, workSeconds: 900 });
});
test('unknown capabilities and malformed estimates are not accepted as proof', () => {
  const proposed = definition(); proposed.requiredCapabilities = ['magic'];
  expect(() => readiness.assess(task(), limits, proposed)).toThrow('Unknown capabilities');
  proposed.requiredCapabilities = ['source_read']; proposed.estimate.modelCalls = '20';
  expect(() => readiness.assess(task(), limits, proposed)).toThrow('whole-number');
});
test('private workflows never become feasible engineering work through a proposal preview', () => {
  const input = task(); input.service = 'personal';
  expect(readiness.assess(input, limits, definition())).toMatchObject({ status: 'unsupported_by_worker', executionAuthority: 'none' });
});
test('the review basis includes scope and verifier even when a proposal retains an old intent fingerprint', () => {
  const input = task(); const before = readiness.assess(input, limits, definition()).taskBasis;
  input.automation.scope = ['core/tests/unit/inferenceRuntimePolicy.test.js'];
  expect(readiness.assess(input, limits, definition()).taskBasis).not.toBe(before);
});
