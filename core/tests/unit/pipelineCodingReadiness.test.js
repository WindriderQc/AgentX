'use strict';
const readiness = require('../../src/services/pipelineCodingReadiness');
const task = () => ({ title: 'Bounded source fix', spec: 'Preserve the caller when rejecting invalid input.', service: 'agentx-coding',
  automation: { scope: ['core/src/services/inferenceRuntimePolicy.js'], verificationProfile: 'agentx-core-runner-tests/v1', fingerprint: 'a'.repeat(64) } });
const definition = () => ({ acceptanceCriteria: ['Invalid input is rejected and valid input still succeeds.'],
  requiredCapabilities: ['source_read', 'source_write', 'cpu_tests'], estimate: { modelCalls: 20, workSeconds: 600 } });
const limits = { modelCalls: 32, workSeconds: 900 };
test('regression edits are optional and operator-declared, with no semantic quality claim', () => {
  expect(readiness.definition(definition())).not.toHaveProperty('requiredRegressionTests');
  expect(readiness.definition({ ...definition(), requiredRegressionTests: [] })).not.toHaveProperty('requiredRegressionTests');
  const input = task(), path = 'core/tests/unit/inferenceRuntimePolicy.test.js';
  input.automation.scope.push(path);
  const proposed = { ...definition(), requiredRegressionTests: [path] };
  expect(readiness.assess(input, limits, proposed)).toMatchObject({ canAuthorize: true,
    definition: { requiredRegressionTests: [path] } });
  expect(proposed.requiredRegressionTests).toEqual([path]);
});
test.each(['../test.py', '/test.py', 'test//one.py', './test.py', 'test/../one.py', 'test\\one.py', 'test\none.py', ''])
('required regression paths reject malformed input %j', path => {
  expect(() => readiness.definition({ ...definition(), requiredRegressionTests: [path] })).toThrow('repository-relative');
});
test('duplicate regression paths and non-array declarations are invalid', () => {
  for (const paths of [['test.py', 'test.py'], 'test.py', [null], Array.from({ length: 21 }, (_, i) => `test${i}.py`)])
    expect(() => readiness.definition({ ...definition(), requiredRegressionTests: paths })).toThrow('repository-relative');
});
test.each(['core/src/services/inferenceRuntimePolicy.js', 'core/tests/unit/unrelated.test.js', 'test.py'])
('regression target %s must be a native test in the exact writable scope', path => {
  expect(readiness.assess(task(), limits, { ...definition(), requiredRegressionTests: [path] })).toMatchObject({
    canAuthorize: false, issues: [expect.objectContaining({ code: 'regression_tests_unverifiable' })] });
});
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
test('a continuation verifier override is assessed and invalidates the earlier review basis', () => {
  const input = task(); const before = readiness.taskBasis(input);
  input.codingAutonomy = { verificationProfile: 'agentx-dispatcher-tests/v1' };
  expect(readiness.taskBasis(input)).not.toBe(before);
  expect(readiness.assess(input, limits, definition()).issues[0].code).toBe('verification_scope_mismatch');
});

describe('bounded Schedule UI verification', () => {
  const profile = require('../../../integrations/coding/schedule_ui_profile.json');
  const input = scope => ({ ...task(), automation: { scope, verificationProfile: profile.id } });

  test('the reviewed UI files are feasible without claiming execution authority', () => {
    const candidate = input([...profile.sourceFiles, ...profile.testFiles]);
    const before = structuredClone(candidate);
    expect(readiness.assess(candidate, limits, definition())).toMatchObject({
      status: 'ready', canAuthorize: true, executionAuthority: 'none', verificationProfile: profile.id
    });
    expect(candidate).toEqual(before);
  });

  test.each(['core/src/services/clusterScheduleService.js', 'core/routes/cluster-schedule.js',
    'core/public/js/cluster-schedule-unreviewed.js', 'core/tests/unit/unrelated.test.js',
    'core/views/pages/cluster-schedule.ejs', 'integrations/coding/coding_verification.py'])
  ('unreviewed area %s requires a separate verifier', path => {
    expect(readiness.assess(input([profile.sourceFiles[0], path]), limits, definition())).toMatchObject({
      status: 'missing_prerequisite', canAuthorize: false,
      issues: [expect.objectContaining({ code: 'verification_scope_mismatch' })]
    });
  });

  test('Schedule scope does not widen the existing Core runtime verifier', () => {
    const candidate = input(profile.sourceFiles);
    candidate.automation.verificationProfile = 'agentx-core-runner-tests/v1';
    expect(readiness.assess(candidate, limits, definition()).canAuthorize).toBe(false);
  });
});
