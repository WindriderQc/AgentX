'use strict';

/**
 * The Core operations the benchmark may call: an allowlist of method and
 * path pattern with a deadline and size bounds each. coreApiClient refuses
 * any request that matches none of them.
 */

const DEFAULT_TIMEOUT_MS = 10000;
const PIN_RESTORE_TIMEOUT_MS = 600000;
const CLAIM_ACQUIRE_TIMEOUT_MS = Math.max(
  45_000,
  (Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000) + 15_000
);

const CORE_OPERATIONS = Object.freeze({
  MODEL_REGISTRIES: 'benchmark.core-api.model-registries',
  MODEL_REGISTRY: 'benchmark.core-api.model-registry',
  PUBLIC_CONFIG: 'benchmark.core-api.public-config',
  HOST_PREFERENCES: 'benchmark.core-api.host-preferences',
  ROUTING_CONFIG: 'benchmark.core-api.routing-config',
  RUNTIME_ACTIVE: 'benchmark.core-api.runtime-active',
  HOUSEHOLD_IDLE: 'benchmark.core-api.household-idle',
  HOST_RELOAD: 'benchmark.core-api.host-reload',
  PIN_CONTEXT_APPLY: 'benchmark.core-api.pin-context-apply',
  CLAIM_ACQUIRE: 'benchmark.core-api.claim-acquire',
  CLAIM_HEARTBEAT: 'benchmark.core-api.claim-heartbeat',
  CLAIM_RELEASE: 'benchmark.core-api.claim-release',
  CLAIM_RELEASE_RECOVERY: 'benchmark.core-api.claim-release-recovery',
  CLAIMS_ACTIVE: 'benchmark.core-api.claims-active',
  WORKLOAD_ACQUIRE: 'benchmark.core-api.workload-acquire',
  WORKLOAD_HEARTBEAT: 'benchmark.core-api.workload-heartbeat',
  WORKLOAD_RELEASE: 'benchmark.core-api.workload-release',
  WORKLOAD_RELEASE_RECOVERY: 'benchmark.core-api.workload-release-recovery',
  WORKLOAD_RECOVERY_ARM: 'benchmark.core-api.workload-recovery-arm',
  WORKLOAD_RECOVERY_ADOPT: 'benchmark.core-api.workload-recovery-adopt',
  WORKLOAD_RECOVERY_HEARTBEAT: 'benchmark.core-api.workload-recovery-heartbeat',
  WORKLOAD_RECOVERY_ASSERT: 'benchmark.core-api.workload-recovery-assert',
  WORKLOAD_RECOVERY_TRANSITION: 'benchmark.core-api.workload-recovery-transition',
  WORKLOAD_RECOVERY_HOST_RESTORE: 'benchmark.core-api.workload-recovery-host-restore',
  WORKLOAD_RECOVERY_RELEASE: 'benchmark.core-api.workload-recovery-release',
  WORKLOAD_YIELD_POINT: 'benchmark.core-api.workload-yield-point',
  INFERENCE_GENERATE: 'benchmark.core-api.inference-generate',
  INFERENCE_CONTRACT: 'benchmark.core-api.inference-contract',
});

function operation(method, pathPattern, {
  allowSearch = false,
  deadlineMs = DEFAULT_TIMEOUT_MS,
  maxRequestBytes = 0,
  maxResponseBytes = 1024 * 1024,
} = {}) {
  return Object.freeze({
    allowSearch,
    method,
    pathPattern,
    policy: Object.freeze({
      authoritySource: 'configured',
      deadlineMs,
      maxRequestBytes,
      maxResponseBytes,
    }),
  });
}

const CORE_OPERATION_SPECS = Object.freeze({
  [CORE_OPERATIONS.INFERENCE_CONTRACT]: operation('POST', '^/api/inference/contract/resolve$', {
    maxRequestBytes: 4 * 1024, maxResponseBytes: 256 * 1024,
  }),
  [CORE_OPERATIONS.MODEL_REGISTRIES]: operation('GET', '^/api/models/registry$', {
    allowSearch: true,
    maxResponseBytes: 2 * 1024 * 1024,
  }),
  [CORE_OPERATIONS.MODEL_REGISTRY]: operation('GET', '^/api/models/registry/[^/]+$', {
    allowSearch: true,
  }),
  [CORE_OPERATIONS.PUBLIC_CONFIG]: operation('GET', '^/api/config$', {
    deadlineMs: 2_000,
    maxResponseBytes: 64 * 1024,
  }),
  [CORE_OPERATIONS.HOST_PREFERENCES]: operation('GET', '^/api/nerve-center/host-preferences$'),
  [CORE_OPERATIONS.ROUTING_CONFIG]: operation('GET', '^/api/nerve-center/inference/routing-config$'),
  [CORE_OPERATIONS.RUNTIME_ACTIVE]: operation('GET', '^/api/nerve-center/runtime-coordination/active$'),
  [CORE_OPERATIONS.HOUSEHOLD_IDLE]: operation('GET', '^/api/nerve-center/interactive-priority/status$'),
  [CORE_OPERATIONS.HOST_RELOAD]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/reload$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS }
  ),
  // Operator-confirmed Profiler proposal; Core verifies residents and speed.
  [CORE_OPERATIONS.PIN_CONTEXT_APPLY]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/pin/context$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 4 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIM_ACQUIRE]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim$',
    { deadlineMs: CLAIM_ACQUIRE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIM_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIM_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.CLAIMS_ACTIVE]: operation(
    'GET',
    '^/api/nerve-center/host-preferences/benchmark-claims/active$'
  ),
  [CORE_OPERATIONS.CLAIM_RELEASE_RECOVERY]: operation(
    'POST',
    '^/api/nerve-center/host-preferences/[^/]+/benchmark-claim/[^/]+/release-receipt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_ACQUIRE]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions$',
    { deadlineMs: CLAIM_ACQUIRE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/workload-admissions/[^/]+$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/release-receipt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ARM]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/recovery$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ADOPT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/adopt$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_HEARTBEAT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/heartbeat$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_ASSERT]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/assert$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_TRANSITION]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/transition$',
    { maxRequestBytes: 64 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_HOST_RESTORE]: operation(
    'POST',
    '^/api/nerve-center/workload-recoveries/[^/]+/restore-hosts$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 64 * 1024, maxResponseBytes: 512 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_RECOVERY_RELEASE]: operation(
    'DELETE',
    '^/api/nerve-center/workload-recoveries/[^/]+$',
    { maxRequestBytes: 32 * 1024, maxResponseBytes: 256 * 1024 }
  ),
  [CORE_OPERATIONS.WORKLOAD_YIELD_POINT]: operation(
    'POST',
    '^/api/nerve-center/workload-admissions/[^/]+/yield-point$',
    { deadlineMs: 5_000, maxRequestBytes: 4 * 1024, maxResponseBytes: 16 * 1024 }
  ),
  [CORE_OPERATIONS.INFERENCE_GENERATE]: operation(
    'POST',
    '^/api/inference/generate$',
    { deadlineMs: PIN_RESTORE_TIMEOUT_MS, maxRequestBytes: 2 * 1024 * 1024, maxResponseBytes: 8 * 1024 * 1024 }
  ),
});

module.exports = { CORE_OPERATIONS, CORE_OPERATION_SPECS, PIN_RESTORE_TIMEOUT_MS };
