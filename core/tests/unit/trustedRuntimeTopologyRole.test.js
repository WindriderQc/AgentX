'use strict';

// Topology role routes (#360, phase 2) through the trusted runtime services:
// runtime-bridge dispatch, the effective routing snapshot and the principal alias.

const {
  TrustedRuntimeServiceError, buildEffectiveRoutingSnapshot, executeRoutedInference
} = require('../../src/extensions/trustedRuntimeServices');
const { resolvePrincipalAlias } = require('../../integrations/runtime-bridges/principal-model');

const LANE = 'http://lane.test:11437';
const POOLED = 'http://pooled.test:11434';

function response(body) {
  return { ok: true, status: 200, headers: new Map(), body: null, text: jest.fn(async () => JSON.stringify(body)) };
}

function roleRecommendation(laneContext) {
  return {
    model: 'lane-pin', host: 'lane-a', url: LANE, source: 'topology_role', reason: 'resolved',
    claimId: null, claimExpiresAt: null, recommendation: null, readiness: null,
    topology: { role: 'conversation', group: 'dual-gpu', mode: 'lanes', laneContext }
  };
}

function deps(recommendation, overrides = {}) {
  return {
    beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
      signal: signal || new AbortController().signal, markDispatched: jest.fn(), assertActive: jest.fn(),
      complete: jest.fn(async () => ({ released: true })), abandon: jest.fn(async () => ({ released: true }))
    })),
    getAdvisoryModelForTask: jest.fn(async () => recommendation),
    getTargetForModel: jest.fn(() => 'http://other.test:11434'),
    resolveHostKey: jest.fn(() => 'lane-a'),
    assertHostAvailableForConsumer: jest.fn(async () => null),
    validateHostUrl: jest.fn(host => ({ valid: true, host })),
    hostPreferenceService: {
      getByHost: jest.fn(async () => ({ pinnedModels: [{ model: 'lane-pin', contextSize: 1200, keepAlive: -1 }] })),
      prepareExclusiveModel: jest.fn(async () => ({ status: 'ready', unloaded: [] }))
    },
    modelsMatch: (left, right) => left === right,
    resolveInferenceContract: jest.fn(async () => ({
      version: 1,
      contextBudget: { windowTokens: 1200, input: { estimatedTokens: 1000 }, output: { reservedTokens: 200 } }
    })),
    applyContractOutputLimit: jest.fn(),
    hostGate: { acquire: jest.fn(async () => jest.fn()), acquireExclusive: jest.fn(async () => jest.fn()) },
    recordInference: jest.fn(async () => null),
    fetch: jest.fn(async () => response({ model: 'lane-pin', response: 'ok', done: true })),
    ...overrides
  };
}

const request = { mode: 'generate', taskType: 'general_chat', prompt: 'hello' };

describe('runtime-bridge dispatch of a role route', () => {
  it('dispatches to the resolved endpoint when input plus output fits the lane exactly', async () => {
    const d = deps(roleRecommendation(1200));
    const result = await executeRoutedInference(d, request);
    expect(d.fetch).toHaveBeenCalledWith(`${LANE}/api/generate`, expect.any(Object));
    expect(result.metadata).toMatchObject({
      model: 'lane-pin', hostUrl: LANE, routingSource: 'topology_role',
      topology: { role: 'conversation', mode: 'lanes', laneContext: 1200 }
    });
  });

  it('refuses one token over with LANE_CONTEXT_EXCEEDED, records it, and dispatches nothing', async () => {
    const d = deps(roleRecommendation(1199));
    const error = await executeRoutedInference(d, request).catch(caught => caught);
    expect(error).toBeInstanceOf(TrustedRuntimeServiceError);
    expect(error).toMatchObject({ code: 'LANE_CONTEXT_EXCEEDED', statusCode: 413 });
    expect(error.details).toEqual({
      estimatedInputTokens: 1000, outputBudget: 200, laneContext: 1199,
      role: 'conversation', mode: 'lanes', group: 'dual-gpu', suggestion: 'queue_for_pooled'
    });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.recordInference).toHaveBeenCalledWith(expect.objectContaining({ error: 'LANE_CONTEXT_EXCEEDED' }));
  });

  it('refuses an unresolved role with its reason before choosing any host', async () => {
    const d = deps({
      model: null, host: null, url: null, source: 'topology_role_unresolved',
      topology: { role: 'background', group: 'dual-gpu', mode: 'pooled', laneContext: null },
      refusal: { status: 503, code: 'TOPOLOGY_ROLE_UNRESOLVED', reason: 'role_not_in_active_mode',
        message: 'The background role does not resolve (role_not_in_active_mode); the request was not dispatched.',
        data: { role: 'background', group: 'dual-gpu', mode: 'pooled', reason: 'role_not_in_active_mode' } }
    });
    await expect(executeRoutedInference(d, request)).rejects.toMatchObject({
      code: 'TOPOLOGY_ROLE_UNRESOLVED', statusCode: 503,
      details: { role: 'background', reason: 'role_not_in_active_mode' }
    });
    expect(d.getTargetForModel).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('never sends a refused role route to a fallback ladder rung', async () => {
    const { refusedBeforeDispatch } = require('../../src/services/routing/taskFallbackLadder');
    const fallbackAfterRefusal = jest.fn(async () => ({ model: 'small', host: 'tertiary', url: 'http://tertiary.test:11434' }));
    const d = deps(roleRecommendation(1200), {
      assertHostAvailableForConsumer: jest.fn(async () => {
        throw Object.assign(new Error('claimed'), { code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503 });
      }),
      refusedBeforeDispatch, fallbackAfterRefusal
    });
    await expect(executeRoutedInference(d, request)).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_ACTIVE' });
    expect(fallbackAfterRefusal).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});

describe('effective routing snapshot', () => {
  function snapshotDeps(payload) {
    return {
      buildRouterConfigPayload: jest.fn(async () => ({
        authority: { operational: 'router' }, hosts: { primary: 'http://primary.test:11434', 'lane-a': LANE }, ...payload
      })),
      hostPreferenceService: {
        getAll: jest.fn(async () => [
          { hostUrl: 'http://primary.test:11434', pinnedModels: [{ model: 'model-a', contextSize: 32768 }] },
          { hostUrl: LANE, pinnedModels: [{ model: 'lane-pin', contextSize: 98304 }] },
          { hostUrl: POOLED, pinnedModels: [{ model: 'pooled-pin', contextSize: 196608 }] }
        ]),
        getPinnedEntries: pref => pref.pinnedModels
      },
      getContextInfo: jest.fn(async () => null),
      resolveInferenceContract: jest.fn(async () => ({ version: 1 })),
      modelsMatch: (left, right) => left === right,
      ModelRegistry: { find: jest.fn() }
    };
  }

  it('is unchanged for host routes: no topology fields and no principal topology', async () => {
    const snapshot = await buildEffectiveRoutingSnapshot(snapshotDeps({
      taskModels: { daily_operator: { model: 'model-a', host: 'primary' } }
    }), { includeCatalog: false });
    expect(Object.keys(snapshot.tasks.daily_operator).sort()).toEqual([
      'configuredModel', 'contextInfo', 'contextSize', 'contextSource', 'hostKey', 'hostPreference', 'hostUrl',
      'inferenceContract', 'keepAlive', 'model', 'pinAligned', 'taskType'
    ]);
    expect(snapshot).not.toHaveProperty('principalTopology');
  });

  it('serves a resolved role route with its endpoint pin, and an unresolved one with no model', async () => {
    const snapshot = await buildEffectiveRoutingSnapshot(snapshotDeps({
      taskModels: {
        analysis: { model: null, host: null, role: 'conversation' },
        summarization: { model: null, host: null, role: 'background' }
      },
      topology: { declared: true, valid: true, principal: null, resolutions: {
        analysis: { ok: true, role: 'conversation', group: 'dual-gpu', mode: 'lanes', url: LANE, host: 'lane-a', model: 'lane-pin', laneContext: 98304 },
        summarization: { ok: false, role: 'background', group: 'dual-gpu', mode: 'pooled', reason: 'role_not_in_active_mode' }
      } }
    }), { includeCatalog: false });
    expect(snapshot.tasks.analysis).toMatchObject({
      model: 'lane-pin', hostKey: 'lane-a', hostUrl: LANE, contextSize: 98304, pinAligned: true,
      topology: { role: 'conversation', mode: 'lanes', reason: null }
    });
    expect(snapshot.tasks.summarization).toMatchObject({
      model: null, hostUrl: null, pinAligned: false, topology: { role: 'background', reason: 'role_not_in_active_mode' }
    });
  });

  it('adds the principal topology target when the principal route names a role', async () => {
    const snapshot = await buildEffectiveRoutingSnapshot(snapshotDeps({
      taskModels: { daily_operator: { model: null, host: null, role: 'conversation' } },
      topology: { declared: true, valid: true, resolutions: {
        daily_operator: { ok: false, role: 'conversation', group: 'dual-gpu', mode: 'pooled', reason: 'role_not_in_active_mode' }
      }, principal: { ok: true, role: 'pooled', requestedRole: 'conversation', group: 'dual-gpu', mode: 'pooled',
        url: POOLED, host: null, model: 'pooled-pin', laneContext: 196608 } }
    }), { includeCatalog: false });
    expect(snapshot.principalTopology).toMatchObject({
      taskType: 'daily_operator', model: 'pooled-pin', hostUrl: POOLED, contextSize: 196608, pinAligned: true,
      topology: { role: 'pooled', requestedRole: 'conversation', mode: 'pooled' }
    });
    const target = resolvePrincipalAlias(snapshot, 'agentx-primary');
    expect(target).toMatchObject({ model: 'pooled-pin', hostUrl: POOLED, numCtx: 196608, exclusiveHost: false });
  });
});

describe('principal alias', () => {
  const hostRoute = { tasks: { daily_operator: { model: 'model-a', hostUrl: 'http://primary.test:11434', contextSize: 32768, pinAligned: true } } };

  it('keeps following the principal route when no principal topology is present', () => {
    expect(resolvePrincipalAlias(hostRoute, 'agentx-primary')).toMatchObject({ model: 'model-a', numCtx: 32768 });
  });

  it('follows the principal topology target when present, over the task route', () => {
    const snapshot = { ...hostRoute, principalTopology: {
      model: 'lane-pin', hostUrl: LANE, contextSize: 98304, pinAligned: true, topology: { role: 'conversation', mode: 'lanes' }
    } };
    expect(resolvePrincipalAlias(snapshot, 'agentx-primary')).toMatchObject({ model: 'lane-pin', hostUrl: LANE, numCtx: 98304 });
  });

  it('refuses an unresolved principal role with its reason, never the task route', () => {
    const snapshot = { ...hostRoute, principalTopology: {
      model: null, hostUrl: null, contextSize: null, pinAligned: false, topology: { role: 'conversation', reason: 'transitional' }
    } };
    expect(() => resolvePrincipalAlias(snapshot, 'agentx-primary')).toThrow(expect.objectContaining({
      code: 'PRINCIPAL_MODEL_UNAVAILABLE', statusCode: 409, reason: 'transitional'
    }));
  });
});
