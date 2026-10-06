'use strict';
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { withRepoAdmission, buildAdmittedCallModel } = require('../../../src/services/qualification/repoLiveAdmission');
const { runQualification } = require('../../../src/services/qualification/repoQualificationRunner');
const { loadRepoTasks } = require('../../../src/services/qualification/repoTaskFixtures');
const args = { core: 'http://core:3080', host: 'http://ollama:11434', claimId: 'repo-test', modelTimeoutMs: 1000, gradeTimeoutMs: 1000 };
function setup() {
  const events = [], signal = new AbortController().signal;
  const workload = { signal, assertActive: jest.fn(), complete: jest.fn(async () => events.push('complete')),
    retainForRecovery: jest.fn(async () => events.push('retain')) };
  const deps = { configuredCoreOrigin: () => args.core, connectDB: jest.fn(async () => events.push('connect')),
    disconnectDB: jest.fn(async () => events.push('disconnect')),
    beginManagedWorkload: jest.fn(async () => { events.push('admit'); return workload; }),
    claimHostForBenchmark: jest.fn(async () => { events.push('claim'); return { claimed: true, claimGeneration: 'generation-a' }; }),
    getBenchmarkClaims: jest.fn(async () => [{ hostUrl: args.host, batchId: args.claimId, claimGeneration: 'generation-a' }]),
    releaseBenchmarkClaim: jest.fn(async () => { events.push('restore'); return { released: true }; }),
    startHeartbeat: () => ({ ready: Promise.resolve(), assertActive: jest.fn(), stop: async () => events.push('stop') }) };
  return { deps, events, workload };
}

test('admission precedes the claim and confirmed restoration precedes workload release', async () => {
  const { deps, events } = setup();
  expect(await withRepoAdmission(args, async session => { await session.assertActive(); events.push('infer'); return 'result'; }, deps)).toBe('result');
  expect(events).toEqual(['connect', 'admit', 'claim', 'infer', 'restore', 'complete', 'stop', 'disconnect']);
});
test('a refused claim never dispatches and releases its empty admission', async () => {
  const { deps, workload } = setup(); deps.claimHostForBenchmark.mockResolvedValue({ claimed: false, reason: 'busy' });
  const operation = jest.fn(); await expect(withRepoAdmission(args, operation, deps)).rejects.toThrow('busy');
  expect(operation).not.toHaveBeenCalled(); expect(deps.releaseBenchmarkClaim).not.toHaveBeenCalled();
  expect(workload.complete).toHaveBeenCalled();
});
test.each(['unknown', 'lost'])('%s completion/authority is retained without clearing the host', async mode => {
  const { deps, workload } = setup();
  if (mode === 'lost') deps.getBenchmarkClaims.mockResolvedValue([{ hostUrl: args.host, batchId: args.claimId, claimGeneration: 'replacement' }]);
  await expect(withRepoAdmission(args, async () => { throw Object.assign(new Error('unknown'), { retainAdmission: true }); }, deps)).rejects.toThrow();
  expect(deps.releaseBenchmarkClaim).not.toHaveBeenCalled(); expect(workload.complete).not.toHaveBeenCalled();
  expect(workload.retainForRecovery).toHaveBeenCalled();
});
test('unconfirmed restoration cannot acknowledge a completed workload', async () => {
  const { deps, workload } = setup(); deps.releaseBenchmarkClaim.mockResolvedValue({ released: false });
  await expect(withRepoAdmission(args, async () => 'done', deps)).rejects.toThrow('restoration not confirmed');
  expect(workload.complete).not.toHaveBeenCalled(); expect(workload.retainForRecovery).toHaveBeenCalled();
});
test('every attempt uses the owned Core admission, frozen settings and a fresh artifact guard', async () => {
  const session = { workloadId: args.claimId, signal: new AbortController().signal, assertActive: jest.fn() }, guard = jest.fn();
  const generate = jest.fn(async () => ({ model: 'candidate', done: true, done_reason: 'stop',
    message: { content: 'diff', thinking: 'audit' }, prompt_eval_count: 12, eval_count: 7 }));
  const call = buildAdmittedCallModel({ host: args.host, timeoutMs: 1000, session, generateImpl: generate, assertArtifact: guard,
    modelConfigs: new Map([['candidate', { artifact_digest: 'digest', num_ctx: 8192, response_max_tokens: 4096, think: false, temperature: 0.2 }]]) });
  expect(await call({ model: 'candidate', prompt: 'repair', seed: 101 })).toMatchObject({ content: 'diff', metrics: { effectiveModel: 'candidate', promptEvalCount: 12, evalCount: 7 } });
  expect(generate).toHaveBeenCalledWith(args.claimId, expect.objectContaining({ options: { num_ctx: 8192, num_predict: 4096, temperature: 0.2, seed: 101 }, rawResponse: true }), expect.objectContaining({ signal: expect.anything() }));
  await call({ model: 'candidate', prompt: 'repair', seed: 202 }); expect(guard).toHaveBeenCalledTimes(2);
  generate.mockResolvedValue({ model: 'candidate', done: false });
  await expect(call({ model: 'candidate', prompt: 'repair', seed: 303 })).rejects.toMatchObject({ retainAdmission: true });
});
test('unknown inference stops a matrix instead of becoming a failed sample and continuing', async () => {
  const call = jest.fn(async () => { throw Object.assign(new Error('unknown'), { retainAdmission: true }); });
  await expect(runQualification({ tasks: loadRepoTasks().slice(0, 2), models: ['candidate'], attempts: 2, callModel: call, attemptSeeds: [101, 202] })).rejects.toThrow('unknown');
  expect(call).toHaveBeenCalledTimes(1);
});
