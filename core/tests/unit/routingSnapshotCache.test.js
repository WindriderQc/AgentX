'use strict';

// The effective routing snapshot is shared for a short TTL (#258): one build
// and one artifact identity resolution per exact model and host, invalidated
// by router configuration and host preference writes, and never at the cost
// of a caller's abort (#189). Past the fresh window a held snapshot is served
// at once while one background refresh replaces it.

jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));

const HostPreference = require('../../models/HostPreference');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const hostPreferenceService = require('../../src/services/hostPreferenceService');
const modelRouterConfig = require('../../src/services/modelRouterConfig');
const { resolveArtifactIdentity } = require('../../src/services/artifactIdentityService');
const { buildEffectiveRoutingSnapshot } = require('../../src/services/routing/effectiveRoutingSnapshot');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const logger = require('../../config/logger');
const {
  createRoutingSnapshotCache,
  invalidateRoutingSnapshots,
  snapshotCacheTtlMs,
  snapshotStaleMs
} = require('../../src/services/routing/routingSnapshotCache');

const HOST = 'http://ollama.test:11434';
const TTL_MS = 5000;
const STALE_MS = 300000;
const LIGHT = { includeCatalog: false };
const EXACT = { includeCatalog: false, includeArtifactIdentity: true };
const TASK_MODELS = {
  general_chat: { model: 'model-a', host: 'primary' },
  code_generation: { model: 'model-b', host: 'primary' },
  analysis: { model: 'model-a', host: 'primary' }
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Fake snapshot dependencies. Context info and the inference contract resolve
// the exact artifact identity as the real services do, against counted reads of
// the host catalog (/api/tags), the Benchmark host profile and the registry.
// The stale window is off unless a test asks for it.
function harness({ preferences = async () => [], routingVersion = null, stale = 0 } = {}) {
  const counts = { routerConfig: 0, preferences: 0, tags: 0, hostProfile: 0, registry: 0 };
  const state = {
    clock: 1_000_000, ttl: TTL_MS, stale, version: 'router-v1', gate: null, tagSignals: [], builds: []
  };
  let tagStarted = () => {};

  const identityDeps = {
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      counts.tags += 1;
      state.tagSignals.push(signal);
      tagStarted();
      const answer = () => resolve({
        ok: true,
        json: async () => ({ models: [{ name: 'model-a', digest: 'sha256:aaa' }, { name: 'model-b', digest: 'sha256:bbb' }] })
      });
      if (!state.gate) return answer();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      return state.gate.promise.then(answer);
    }),
    benchmarkClient: {
      getHostProfile: async () => {
        counts.hostProfile += 1;
        return { hostId: 'host-a', hostUrl: HOST };
      }
    },
    ModelRegistry: {
      findOne: () => ({ lean: async () => { counts.registry += 1; return null; } })
    }
  };

  const deps = {
    buildRouterConfigPayload: jest.fn(async () => {
      counts.routerConfig += 1;
      return { authority: { operational: 'router' }, hosts: { primary: HOST }, taskModels: TASK_MODELS };
    }),
    hostPreferenceService: {
      getAll: async () => { counts.preferences += 1; return preferences(); },
      getPinnedEntries: (pref) => pref.pinnedModels || []
    },
    getContextInfo: jest.fn(async (model, host, options = {}) => {
      const artifact = await resolveArtifactIdentity(model, host, {
        ...identityDeps, ...(options.deps || {}), ...(options.signal && { signal: options.signal })
      });
      return { num_ctx: 8192, source: 'modelfile', artifactDigest: artifact.digest };
    }),
    resolveInferenceContract: jest.fn(async (input, options = {}) => {
      const artifact = options.includeArtifactIdentity === true
        ? await resolveArtifactIdentity(input.model, input.host, { ...identityDeps, ...options })
        : null;
      return { artifact: { digest: artifact?.digest || null } };
    }),
    modelsMatch: (left, right) => left === right,
    ModelRegistry: { find: jest.fn() }
  };

  const build = jest.fn((options) => {
    const pending = buildEffectiveRoutingSnapshot(deps, options);
    state.builds.push(pending);
    return pending;
  });
  const cache = createRoutingSnapshotCache({
    build,
    routingVersion: routingVersion || (() => state.version),
    ttlMs: () => state.ttl,
    staleMs: () => state.stale,
    now: () => state.clock
  });
  const tagReads = (count) => new Promise((resolve) => {
    tagStarted = () => { if (counts.tags >= count) resolve(); };
    tagStarted();
  });
  return { cache, build, counts, deps, state, tagReads };
}

describe('routing snapshot cache', () => {
  test('callers within the TTL share one frozen snapshot and one set of host reads', async () => {
    const { cache, counts } = harness();
    const first = await cache.get(LIGHT);
    const second = await cache.get(LIGHT);

    expect(second).toBe(first);
    // Three tasks route two exact artifacts: each is resolved once.
    expect(counts).toEqual({ routerConfig: 1, preferences: 1, tags: 2, hostProfile: 2, registry: 2 });
    expect(first.tasks.analysis.contextInfo.artifactDigest).toBe('sha256:aaa');

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.tasks.general_chat)).toBe(true);
    expect(() => { first.tasks.general_chat.model = 'changed'; }).toThrow(TypeError);
    expect(() => { first.tasks.injected = {}; }).toThrow(TypeError);
    expect((await cache.get(LIGHT)).tasks.general_chat.model).toBe('model-a');
  });

  test('one identity resolution answers both reads of a task and every option set within the TTL', async () => {
    const { cache, counts } = harness();
    const exact = await cache.get({ includeCatalog: false, includeArtifactIdentity: true });
    expect(exact.tasks.code_generation.inferenceContract.artifact.digest).toBe('sha256:bbb');
    expect(counts).toMatchObject({ routerConfig: 1, tags: 2, hostProfile: 2, registry: 2 });

    const light = await cache.get(LIGHT);
    expect(light).not.toBe(exact);
    expect(light.tasks.code_generation.inferenceContract.artifact.digest).toBeNull();
    expect(counts).toMatchObject({ routerConfig: 2, tags: 2, hostProfile: 2, registry: 2 });
  });

  test('an expired snapshot is rebuilt from live reads', async () => {
    const { cache, counts, state } = harness();
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS - 1;
    expect(await cache.get(LIGHT)).toBe(first);

    state.clock += 1;
    const rebuilt = await cache.get(LIGHT);
    expect(rebuilt).not.toBe(first);
    expect(counts).toEqual({ routerConfig: 2, preferences: 2, tags: 4, hostProfile: 4, registry: 4 });
  });

  test('a host preference or pin write discards the held snapshot and identities', async () => {
    const { cache, counts } = harness();
    const first = await cache.get(LIGHT);
    invalidateRoutingSnapshots();

    expect(await cache.get(LIGHT)).not.toBe(first);
    expect(counts).toEqual({ routerConfig: 2, preferences: 2, tags: 4, hostProfile: 4, registry: 4 });
  });

  test('a router configuration change discards the held snapshot', async () => {
    const { cache, counts, state } = harness();
    const first = await cache.get(LIGHT);
    state.version = 'router-v2';

    const rebuilt = await cache.get(LIGHT);
    expect(rebuilt).not.toBe(first);
    expect(await cache.get(LIGHT)).toBe(rebuilt);
    expect(counts.routerConfig).toBe(2);
  });

  test('an unreadable router configuration version shares nothing', async () => {
    const { cache, counts } = harness({ routingVersion: () => { throw new Error('version unavailable'); } });
    const first = await cache.get(LIGHT);

    expect(await cache.get(LIGHT)).not.toBe(first);
    expect(counts.routerConfig).toBe(2);
  });

  test('concurrent callers share one build', async () => {
    const { cache, counts, state, tagReads } = harness();
    state.gate = deferred();
    const callers = [cache.get(LIGHT), cache.get(LIGHT), cache.get(LIGHT)];
    await tagReads(1);
    state.gate.resolve();

    const [first, second, third] = await Promise.all(callers);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(counts).toEqual({ routerConfig: 1, preferences: 1, tags: 2, hostProfile: 2, registry: 2 });
  });

  test('a caller that leaves detaches itself and the build continues for the others', async () => {
    const { cache, counts, state, tagReads } = harness();
    state.gate = deferred();
    const leaving = new AbortController();
    const staying = new AbortController();
    const left = cache.get({ ...LIGHT, signal: leaving.signal });
    const stayed = cache.get({ ...LIGHT, signal: staying.signal });
    await tagReads(1);

    leaving.abort(new Error('caller left'));
    await expect(left).rejects.toThrow('caller left');
    expect(state.tagSignals.every((signal) => !signal.aborted)).toBe(true);

    state.gate.resolve();
    const snapshot = await stayed;
    expect(snapshot.tasks.general_chat.contextInfo.artifactDigest).toBe('sha256:aaa');
    expect(counts).toMatchObject({ routerConfig: 1, tags: 2 });
    expect(await cache.get(LIGHT)).toBe(snapshot);
  });

  test('a caller without a signal keeps the shared build alive', async () => {
    const { cache, counts, state, tagReads } = harness();
    state.gate = deferred();
    const leaving = new AbortController();
    const left = cache.get({ ...LIGHT, signal: leaving.signal });
    const stayed = cache.get(LIGHT);
    await tagReads(1);

    leaving.abort(new Error('caller left'));
    await expect(left).rejects.toThrow('caller left');
    expect(state.tagSignals[0].aborted).toBe(false);

    state.gate.resolve();
    expect((await stayed).tasks.code_generation.model).toBe('model-b');
    expect(counts.routerConfig).toBe(1);
  });

  test('the build stops opening host reads once every caller has left, and is not kept', async () => {
    const { cache, counts, state, tagReads } = harness();
    state.gate = deferred();
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    const first = cache.get({ ...LIGHT, signal: firstCaller.signal });
    const second = cache.get({ ...LIGHT, signal: secondCaller.signal });
    await tagReads(1);

    firstCaller.abort(new Error('first left'));
    secondCaller.abort(new Error('second left'));
    await expect(first).rejects.toThrow('first left');
    await expect(second).rejects.toThrow('second left');
    await expect(state.builds[0]).rejects.toThrow('second left');

    // Only the first task's identity read ever started.
    expect(state.tagSignals).toHaveLength(1);
    expect(state.tagSignals[0].aborted).toBe(true);
    expect(counts).toMatchObject({ routerConfig: 1, tags: 1 });

    state.gate = null;
    const snapshot = await cache.get(LIGHT);
    expect(snapshot.tasks.general_chat.contextInfo.artifactDigest).toBe('sha256:aaa');
    expect(counts).toMatchObject({ routerConfig: 2, tags: 3 });
  });

  test('a caller that already left starts no build', async () => {
    const { cache, build } = harness();
    const controller = new AbortController();
    controller.abort(new Error('caller left'));

    await expect(cache.get({ ...LIGHT, signal: controller.signal })).rejects.toThrow('caller left');
    expect(build).not.toHaveBeenCalled();
  });

  test('an identity read cut short by another build is resolved again, not reused', async () => {
    const { cache, deps, state, tagReads } = harness();
    state.gate = deferred();
    const leaving = new AbortController();
    const abandoned = cache.get({ ...LIGHT, signal: leaving.signal });
    await tagReads(1);
    const exact = cache.get({ includeCatalog: false, includeArtifactIdentity: true });
    // The second build is now waiting on the first build's pending identity.
    while (deps.getContextInfo.mock.calls.length < 2) await new Promise(setImmediate);
    expect(state.tagSignals).toHaveLength(1);

    leaving.abort(new Error('caller left'));
    await expect(abandoned).rejects.toThrow('caller left');
    await tagReads(2);
    state.gate.resolve();

    const snapshot = await exact;
    expect(snapshot.tasks.general_chat.contextInfo.artifactDigest).toBe('sha256:aaa');
    expect(snapshot.tasks.general_chat.inferenceContract.artifact.digest).toBe('sha256:aaa');
  });

  test('a write that lands during a build keeps its result away from later callers', async () => {
    const { cache, counts, state, tagReads } = harness();
    state.gate = deferred();
    const pending = cache.get(LIGHT);
    await tagReads(1);
    invalidateRoutingSnapshots();
    state.gate.resolve();

    const delivered = await pending;
    expect(delivered.tasks.general_chat.model).toBe('model-a');
    expect(await cache.get(LIGHT)).not.toBe(delivered);
    expect(counts.routerConfig).toBe(2);
  });

  test('a failed build is not kept', async () => {
    const { cache, counts, deps } = harness();
    deps.buildRouterConfigPayload.mockRejectedValueOnce(new Error('router configuration unavailable'));

    await expect(cache.get(LIGHT)).rejects.toThrow('router configuration unavailable');
    expect((await cache.get(LIGHT)).tasks.general_chat.model).toBe('model-a');
    expect(counts.routerConfig).toBe(1);
    expect(deps.buildRouterConfigPayload).toHaveBeenCalledTimes(2);
  });

  test('a TTL of 0 disables sharing and passes the caller options through', async () => {
    const { cache, build, counts, state } = harness();
    state.ttl = 0;
    const options = { includeCatalog: false };
    const first = await cache.get(options);
    const second = await cache.get(options);

    expect(second).not.toBe(first);
    expect(build).toHaveBeenNthCalledWith(1, options);
    expect(build.mock.calls[1][0]).toBe(options);
    // No shared identity either: each task reads its own.
    expect(counts).toEqual({ routerConfig: 2, preferences: 2, tags: 6, hostProfile: 6, registry: 6 });
  });

  test('a caller choosing router options gets its own build', async () => {
    const { cache, build, deps } = harness();
    const options = { includeCatalog: false, routerOptions: { force: true } };
    await cache.get(options);
    await cache.get(options);

    expect(build).toHaveBeenCalledTimes(2);
    expect(deps.buildRouterConfigPayload).toHaveBeenLastCalledWith({ force: true });
  });

  test('reads the TTL from AGENTX_ROUTING_SNAPSHOT_CACHE_MS', () => {
    expect(snapshotCacheTtlMs(undefined)).toBe(5000);
    expect(snapshotCacheTtlMs('')).toBe(5000);
    expect(snapshotCacheTtlMs('0')).toBe(0);
    expect(snapshotCacheTtlMs('250')).toBe(250);
    expect(snapshotCacheTtlMs('-1')).toBe(5000);
    expect(snapshotCacheTtlMs('soon')).toBe(5000);
  });
});

describe('routing snapshot stale window', () => {
  beforeEach(() => logger.debug.mockClear());

  test('a stale hit returns without waiting and starts exactly one refresh', async () => {
    const { cache, build, counts, state, tagReads } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    // The refresh's host reads hang: the callers below are answered regardless.
    state.gate = deferred();

    expect(await cache.get(LIGHT)).toBe(first);
    expect(await cache.get(LIGHT)).toBe(first);
    state.clock += STALE_MS - TTL_MS - 1;
    expect(await cache.get(LIGHT)).toBe(first);

    await tagReads(3);
    expect(build).toHaveBeenCalledTimes(2);
    expect(counts).toMatchObject({ routerConfig: 2, tags: 3 });
    state.gate.resolve();
    await state.builds[1];
  });

  test('the refreshed snapshot is served to the next caller', async () => {
    const { cache, build, state } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;

    expect(await cache.get(LIGHT)).toBe(first);
    const refreshed = await state.builds[1];
    expect(refreshed).not.toBe(first);
    expect(await cache.get(LIGHT)).toBe(refreshed);
    expect(build).toHaveBeenCalledTimes(2);

    // The refreshed snapshot goes stale in turn and is replaced the same way.
    state.clock += TTL_MS;
    expect(await cache.get(LIGHT)).toBe(refreshed);
    const next = await state.builds[2];
    expect(await cache.get(LIGHT)).toBe(next);
    expect(build).toHaveBeenCalledTimes(3);
  });

  test('past the stale window the caller waits for a build', async () => {
    const { cache, build, state, tagReads } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += STALE_MS;
    state.gate = deferred();
    let answered = false;
    const waiting = cache.get(LIGHT).then((snapshot) => { answered = true; return snapshot; });

    await tagReads(3);
    expect(answered).toBe(false);
    state.gate.resolve();
    expect(await waiting).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('a write discards a stale snapshot at once, even while its refresh runs', async () => {
    const { cache, build, state, tagReads } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    state.gate = deferred();
    expect(await cache.get(LIGHT)).toBe(first);
    await tagReads(3);

    invalidateRoutingSnapshots();
    let answered = false;
    const waiting = cache.get(LIGHT).then((snapshot) => { answered = true; return snapshot; });
    await tagReads(4);
    expect(answered).toBe(false);
    expect(build).toHaveBeenCalledTimes(3);

    state.gate.resolve();
    const rebuilt = await waiting;
    expect(rebuilt).not.toBe(first);
    // The refresh that started before the write is not the snapshot kept.
    await state.builds[1];
    expect(await cache.get(LIGHT)).toBe(rebuilt);
    expect(build).toHaveBeenCalledTimes(3);
  });

  test('a router configuration change discards a stale snapshot at once', async () => {
    const { cache, build, state } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    state.version = 'router-v2';

    const rebuilt = await cache.get(LIGHT);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toBe(await state.builds[1]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('a stale window of 0 makes every caller past the fresh window wait for a build', async () => {
    const { cache, build, state } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    state.stale = 0;

    const rebuilt = await cache.get(LIGHT);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toBe(await state.builds[1]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('a failed background refresh keeps the held snapshot and the next caller refreshes again', async () => {
    const { cache, build, deps, state } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    deps.buildRouterConfigPayload.mockRejectedValueOnce(new Error('router configuration unavailable'));

    expect(await cache.get(LIGHT)).toBe(first);
    await expect(state.builds[1]).rejects.toThrow('router configuration unavailable');
    expect(logger.debug).toHaveBeenCalledWith(
      '[RoutingSnapshotCache] background refresh failed',
      { error: 'router configuration unavailable' }
    );

    expect(await cache.get(LIGHT)).toBe(first);
    const refreshed = await state.builds[2];
    expect(await cache.get(LIGHT)).toBe(refreshed);
    expect(refreshed).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(3);

    // Once the held snapshot leaves the stale window, a failure reaches the caller.
    state.clock += STALE_MS;
    deps.buildRouterConfigPayload.mockRejectedValueOnce(new Error('router configuration unavailable'));
    await expect(cache.get(LIGHT)).rejects.toThrow('router configuration unavailable');
  });

  test('a background refresh belongs to no caller and is never aborted by one leaving', async () => {
    const { cache, build, state, tagReads } = harness({ stale: STALE_MS });
    const first = await cache.get(LIGHT);
    state.clock += TTL_MS;
    state.gate = deferred();
    const served = new AbortController();
    expect(await cache.get({ ...LIGHT, signal: served.signal })).toBe(first);
    await tagReads(3);
    served.abort(new Error('caller left'));

    // The held snapshot leaves the stale window: this caller waits on the refresh.
    state.clock += STALE_MS;
    const waiter = new AbortController();
    const waiting = cache.get({ ...LIGHT, signal: waiter.signal });
    waiter.abort(new Error('caller left'));
    await expect(waiting).rejects.toThrow('caller left');
    expect(state.tagSignals.at(-1).aborted).toBe(false);

    state.gate.resolve();
    const refreshed = await state.builds[1];
    expect(await cache.get(LIGHT)).toBe(refreshed);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('the exact-artifact view is never served stale', async () => {
    const { cache, build, state } = harness({ stale: STALE_MS });
    const first = await cache.get(EXACT);
    state.clock += TTL_MS;

    const rebuilt = await cache.get(EXACT);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt).toBe(await state.builds[1]);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test('reads the stale window from AGENTX_ROUTING_SNAPSHOT_STALE_MS', () => {
    expect(snapshotStaleMs(undefined)).toBe(300000);
    expect(snapshotStaleMs('')).toBe(300000);
    expect(snapshotStaleMs('0')).toBe(0);
    expect(snapshotStaleMs('60000')).toBe(60000);
    expect(snapshotStaleMs('-1')).toBe(300000);
    expect(snapshotStaleMs('later')).toBe(300000);
  });
});

describe('routing snapshot invalidation by the real writers', () => {
  afterEach(async () => {
    await HostPreference.deleteMany({});
    await RouterTaskConfig.deleteMany({});
  });

  test('pin and host preference writes are visible to the next caller', async () => {
    await HostPreference.create({ hostUrl: HOST, hostKey: 'primary', pinnedModels: [] });
    const { cache, counts } = harness({ preferences: () => hostPreferenceService.getAll() });

    const before = await cache.get(LIGHT);
    expect(before.tasks.general_chat.pinAligned).toBe(false);

    await hostPreferenceService.addPinnedModel(HOST, 'model-a', { contextSize: 16384 });
    const pinned = await cache.get(LIGHT);
    expect(pinned.tasks.general_chat).toMatchObject({ pinAligned: true, contextSize: 16384 });

    await hostPreferenceService.updatePinnedModel(HOST, 'model-a', { contextSize: 32768 });
    expect((await cache.get(LIGHT)).tasks.general_chat.contextSize).toBe(32768);

    await hostPreferenceService.updatePreference(HOST, { displayName: 'Synthetic host' });
    expect((await cache.get(LIGHT)).hostPreferences[0].displayName).toBe('Synthetic host');

    await hostPreferenceService.deletePreference(HOST);
    expect((await cache.get(LIGHT)).hostPreferences).toEqual([]);
    expect(counts.routerConfig).toBe(5);

    await cache.get(LIGHT);
    expect(counts.routerConfig).toBe(5);
  });

  test('a pin write is visible to the next caller although a stale snapshot is held', async () => {
    await HostPreference.create({ hostUrl: HOST, hostKey: 'primary', pinnedModels: [] });
    const { cache, state } = harness({ preferences: () => hostPreferenceService.getAll(), stale: STALE_MS });
    const before = await cache.get(LIGHT);
    state.clock += TTL_MS;

    await hostPreferenceService.addPinnedModel(HOST, 'model-a', { contextSize: 16384 });
    const pinned = await cache.get(LIGHT);
    expect(pinned).not.toBe(before);
    expect(pinned.tasks.general_chat).toMatchObject({ pinAligned: true, contextSize: 16384 });
  });

  test('router task override writes are visible to the next caller', async () => {
    await modelRouterConfig.ensureTaskModelOverridesLoaded({ force: true });
    const { host } = modelRouterConfig.getModelForTask('analysis');
    const { cache, counts } = harness({ routingVersion: modelRouterConfig.getRoutingConfigVersion });
    try {
      const first = await cache.get(LIGHT);
      expect(await cache.get(LIGHT)).toBe(first);

      await modelRouterConfig.saveTaskModelOverride('analysis', { model: 'synthetic-override', host });
      const afterSave = await cache.get(LIGHT);
      expect(afterSave).not.toBe(first);
      expect(await cache.get(LIGHT)).toBe(afterSave);

      await modelRouterConfig.resetTaskModelOverride('analysis');
      expect(await cache.get(LIGHT)).not.toBe(afterSave);
      expect(counts.routerConfig).toBe(3);
    } finally {
      await modelRouterConfig.resetAllTaskModelOverrides();
    }
  });
});

describe('trusted runtime services', () => {
  const FRESH_ENV = 'AGENTX_ROUTING_SNAPSHOT_CACHE_MS';
  const STALE_ENV = 'AGENTX_ROUTING_SNAPSHOT_STALE_MS';
  const saved = {};

  beforeEach(() => {
    for (const name of [FRESH_ENV, STALE_ENV]) saved[name] = process.env[name];
  });
  afterEach(() => {
    for (const name of [FRESH_ENV, STALE_ENV]) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  test('routing.getEffectiveSnapshot shares the snapshot unless the TTL is 0', async () => {
    const { deps } = harness();
    const services = createTrustedRuntimeServices({ ...deps, getRoutingConfigVersion: () => 'router-v1' });

    delete process.env[FRESH_ENV];
    const first = await services.routing.getEffectiveSnapshot(LIGHT);
    expect(await services.routing.getEffectiveSnapshot(LIGHT)).toBe(first);
    expect(deps.buildRouterConfigPayload).toHaveBeenCalledTimes(1);

    process.env[FRESH_ENV] = '0';
    expect(await services.routing.getEffectiveSnapshot(LIGHT)).not.toBe(first);
    await services.routing.getEffectiveSnapshot(LIGHT);
    expect(deps.buildRouterConfigPayload).toHaveBeenCalledTimes(3);
  });

  test('routing.getEffectiveSnapshot serves a held snapshot inside AGENTX_ROUTING_SNAPSHOT_STALE_MS', async () => {
    const { deps } = harness();
    const services = createTrustedRuntimeServices({ ...deps, getRoutingConfigVersion: () => 'router-v1' });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    process.env[FRESH_ENV] = '1';
    process.env[STALE_ENV] = '60000';

    const first = await services.routing.getEffectiveSnapshot(LIGHT);
    await pause();
    expect(await services.routing.getEffectiveSnapshot(LIGHT)).toBe(first);
    await pause();
    expect(deps.buildRouterConfigPayload).toHaveBeenCalledTimes(2);

    process.env[STALE_ENV] = '0';
    expect(await services.routing.getEffectiveSnapshot(LIGHT)).not.toBe(first);
    expect(deps.buildRouterConfigPayload).toHaveBeenCalledTimes(3);
  });
});
