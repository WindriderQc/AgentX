'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/services/benchmark/orphanedBatchRecovery', () => ({
  interruptOrphanedBatches: jest.fn(async () => 0),
  currentProcessStartedAt: jest.fn(() => new Date(0))
}));
jest.mock('../../src/services/benchmark/judgeQueueRecovery', () => ({ recoverJudgeQueue: jest.fn(async () => {}) }));
jest.mock('../../src/services/benchmark/claimRecovery', () => ({
  recoverLeakedClaims: jest.fn(async () => {}),
  reacquireActiveBatchClaims: jest.fn(async () => {})
}));
jest.mock('../../src/services/profiler/profilerProjectionRecovery', () => ({ startProfilerProjectionRecovery: jest.fn() }));
jest.mock('../../src/services/benchmark/benchmarkAuthorityReconciliation', () => ({
  startBenchmarkAuthorityReconciliation: jest.fn()
}));
jest.mock('../../src/services/registeredHostSync', () => ({ startRegisteredHostSync: jest.fn() }));
jest.mock('../../src/services/measurementCoverage/coverageJob', () => ({ getCoverageJob: jest.fn(() => ({ start: jest.fn() })) }));

const claimRecovery = require('../../src/services/benchmark/claimRecovery');
const { interruptOrphanedBatches } = require('../../src/services/benchmark/orphanedBatchRecovery');
const { recoverJudgeQueue } = require('../../src/services/benchmark/judgeQueueRecovery');
const { startProfilerProjectionRecovery } = require('../../src/services/profiler/profilerProjectionRecovery');
const { startBenchmarkAuthorityReconciliation } = require('../../src/services/benchmark/benchmarkAuthorityReconciliation');
const { startRegisteredHostSync } = require('../../src/services/registeredHostSync');
const { startStartupRecovery } = require('../../src/services/startupRecovery');
const { CORE_OPERATIONS, CORE_OPERATION_SPECS } = require('../../src/clients/coreOperations');
const { createAgentXProfileGuard } = require('../../../shared/agentxRuntimeProfile');

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('startup recovery', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(['demo', 'full'])('recovers claims, profiler projections and authority writes in %s', async profile => {
    startStartupRecovery(profile);
    await flush();
    expect(interruptOrphanedBatches).toHaveBeenCalledWith(new Date(0));
    expect(recoverJudgeQueue).toHaveBeenCalledTimes(1);
    expect(claimRecovery.recoverLeakedClaims).toHaveBeenCalledTimes(1);
    expect(claimRecovery.reacquireActiveBatchClaims).toHaveBeenCalledWith({ processStartedAt: new Date(0) });
    expect(startProfilerProjectionRecovery).toHaveBeenCalledTimes(1);
    expect(startBenchmarkAuthorityReconciliation).toHaveBeenCalledTimes(1);
  });

  it('settles orphaned batches before judge and claim recovery', async () => {
    let settle;
    interruptOrphanedBatches.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    startStartupRecovery('demo');
    await flush();
    expect(recoverJudgeQueue).not.toHaveBeenCalled();
    expect(claimRecovery.recoverLeakedClaims).not.toHaveBeenCalled();
    settle(1);
    await flush();
    expect(recoverJudgeQueue).toHaveBeenCalledTimes(1);
    expect(claimRecovery.recoverLeakedClaims).toHaveBeenCalledTimes(1);
  });

  it('syncs registered hosts only in the full profile', () => {
    startStartupRecovery('demo');
    expect(startRegisteredHostSync).not.toHaveBeenCalled();
    startStartupRecovery('full');
    expect(startRegisteredHostSync).toHaveBeenCalledTimes(1);
  });

  it('is started by the server for every profile', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(source).toMatch(/startStartupRecovery\(app\.locals\.agentxProfile\)/);
  });
});

// Every Core operation Benchmark calls in both profiles: claim recovery,
// profiler projection recovery, authority reconciliation, batch execution
// and the interactive-priority yield point. Pin context editing stays
// full-only (operator-confirmed Profiler proposal under Nerve Center), and so
// does the task routing table the coverage matrix reads: the demo profile has
// no Nerve Center, and coverage then covers the pinned models only.
const FULL_ONLY_OPERATIONS = ['PIN_CONTEXT_APPLY', 'ROUTING_CONFIG', 'RUNTIME_ACTIVE', 'HOUSEHOLD_IDLE'];
const DEMO_OPERATIONS = Object.keys(CORE_OPERATIONS).filter(name => !FULL_ONLY_OPERATIONS.includes(name));

function samplePath(pattern) {
  const target = pattern.replace(/^\^|\$$/g, '').replace(/\[\^\/\]\+/g, encodeURIComponent('http://127.0.0.1:11434'));
  expect(new RegExp(pattern).test(target)).toBe(true);
  return target;
}

function throughDemoGuard(method, target) {
  const guard = createAgentXProfileGuard('demo');
  const res = { setHeader: jest.fn(), status: jest.fn(() => res), json: jest.fn(() => res), type: jest.fn(() => res), send: jest.fn(() => res) };
  const next = jest.fn();
  guard({ method, path: target, url: target }, res, next);
  return { next, res };
}

describe('demo Core profile guard', () => {
  it('covers the workload yield point', () => {
    expect(DEMO_OPERATIONS).toContain('WORKLOAD_YIELD_POINT');
  });

  it.each(DEMO_OPERATIONS)('accepts the Benchmark operation %s', name => {
    const spec = CORE_OPERATION_SPECS[CORE_OPERATIONS[name]];
    const { next, res } = throughDemoGuard(spec.method, samplePath(spec.pathPattern));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each(FULL_ONLY_OPERATIONS)('rejects the full-only operation %s', name => {
    const spec = CORE_OPERATION_SPECS[CORE_OPERATIONS[name]];
    const { next, res } = throughDemoGuard(spec.method, samplePath(spec.pathPattern));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('rejects the full-only registered-host list', () => {
    const { next, res } = throughDemoGuard('GET', '/api/nerve-center/inference-hosts');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
