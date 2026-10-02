'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
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

const claimRecovery = require('../../src/services/benchmark/claimRecovery');
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
    expect(claimRecovery.recoverLeakedClaims).toHaveBeenCalledTimes(1);
    expect(claimRecovery.reacquireActiveBatchClaims).toHaveBeenCalledTimes(1);
    expect(startProfilerProjectionRecovery).toHaveBeenCalledTimes(1);
    expect(startBenchmarkAuthorityReconciliation).toHaveBeenCalledTimes(1);
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

// Every Core operation the recovery paths call: claim recovery, profiler
// projection recovery and authority reconciliation.
const RECOVERY_OPERATIONS = [
  'HOST_PREFERENCES', 'HOST_RELOAD', 'CLAIMS_ACTIVE', 'CLAIM_ACQUIRE', 'CLAIM_HEARTBEAT', 'CLAIM_RELEASE',
  'CLAIM_RELEASE_RECOVERY', 'WORKLOAD_ACQUIRE', 'WORKLOAD_HEARTBEAT', 'WORKLOAD_RELEASE',
  'WORKLOAD_RELEASE_RECOVERY', 'WORKLOAD_RECOVERY_ARM', 'WORKLOAD_RECOVERY_ADOPT',
  'WORKLOAD_RECOVERY_HEARTBEAT', 'WORKLOAD_RECOVERY_ASSERT', 'WORKLOAD_RECOVERY_TRANSITION',
  'WORKLOAD_RECOVERY_HOST_RESTORE', 'WORKLOAD_RECOVERY_RELEASE'
];

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
  it.each(RECOVERY_OPERATIONS)('accepts the recovery operation %s', name => {
    const spec = CORE_OPERATION_SPECS[CORE_OPERATIONS[name]];
    const { next, res } = throughDemoGuard(spec.method, samplePath(spec.pathPattern));
    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rejects the full-only registered-host list', () => {
    const { next, res } = throughDemoGuard('GET', '/api/nerve-center/inference-hosts');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
