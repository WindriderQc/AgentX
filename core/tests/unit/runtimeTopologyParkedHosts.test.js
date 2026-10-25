/**
 * Endpoints of an inactive topology mode are parked (#360, phase 4): stopped
 * on purpose. Consumers that iterate registered hosts must not probe, restore,
 * mark offline or alert on them.
 */
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockObservePinRestoreFailure = jest.fn(async () => ({ emitted: 1, matched: 1 }));
const mockObservePinVramSpill = jest.fn(async () => ({ emitted: 1, matched: 1 }));
jest.mock('../../src/services/laneObservabilityService', () => ({
  observeClaimReleaseFailure: jest.fn(),
  observePinRestoreFailure: (...args) => mockObservePinRestoreFailure(...args),
  observePinVramSpill: (...args) => mockObservePinVramSpill(...args),
  resolvePinVramSpill: jest.fn(async () => 0)
}));

const PARKED = 'http://gpu-host:11437';
const ACTIVE = 'http://gpu-host:11434';
jest.mock('../../src/services/runtimeTopologyParking', () => ({
  isParkedHost: url => String(url).replace(/\/$/, '') === 'http://gpu-host:11437',
  defaultParking: { switchInProgress: () => null }
}));

const HostPreference = require('../../models/HostPreference');
const reconciler = require('../../src/services/pinReconciler');
const hostPrefService = require('../../src/services/hostPreferenceService');
const { readHostGpuHealth } = require('../../src/services/hostGpuHealthService');

describe('parked hosts make no noise', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    await HostPreference.deleteMany({});
    await HostPreference.create({ hostUrl: PARKED, hostKey: 'lane-a', status: 'ready',
      pinnedModels: [{ model: 'lane-model', autoRestore: true, keepAlive: -1, contextSize: 98304 }] });
    global.fetch = jest.fn(async (url) => {
      if (String(url).startsWith(PARKED)) throw new Error('connect ECONNREFUSED');
      return { ok: true, json: async () => ({ models: [] }), text: async () => '{"done":true}' };
    });
    mockObservePinRestoreFailure.mockClear();
    mockObservePinVramSpill.mockClear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('the pin reconciler neither probes nor marks a parked host offline, and raises nothing', async () => {
    await reconciler.checkAndReloadDefaults();
    expect(global.fetch.mock.calls.some(([url]) => String(url).startsWith(PARKED))).toBe(false);
    const pref = await HostPreference.findOne({ hostUrl: PARKED }).lean();
    expect(pref.status).toBe('ready');
    expect(mockObservePinRestoreFailure).not.toHaveBeenCalled();
    expect(mockObservePinVramSpill).not.toHaveBeenCalled();
  });

  it('a pin restore on a parked host is skipped without an incident', async () => {
    const result = await hostPrefService.restorePinnedModels(PARKED);
    expect(result).toMatchObject({ status: 'parked', parked: true, verified: false });
    expect(mockObservePinRestoreFailure).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('GPU health of a parked host is not applicable', async () => {
    const health = await readHostGpuHealth(PARKED);
    expect(health).toMatchObject({ status: 'not_applicable', reason: 'topology_parked' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('router host health reports parked, not offline', async () => {
    const { checkHostHealth } = require('../../src/services/modelRouter');
    const health = await checkHostHealth(PARKED);
    expect(health.status).toBe('parked');
  });

  it('the implicit embedding chain leaves parked hosts out', () => {
    jest.isolateModules(() => {
      const previous = { ...process.env };
      process.env.OLLAMA_HOST = ACTIVE;
      process.env.OLLAMA_HOST_2 = PARKED;
      delete process.env.AGENTX_EMBEDDING_HOST_CHAIN;
      try {
        const { embeddingHostCandidates } = require('../../src/services/embeddingHostChain');
        const chain = embeddingHostCandidates(ACTIVE);
        expect(chain).toContain(ACTIVE);
        expect(chain).not.toContain(PARKED);
      } finally {
        process.env = previous;
      }
    });
  });

  it('the ecosystem summary counts parked hosts apart from offline ones', () => {
    const { summarizeCluster, summarizeOperationalAttention } = require('../../src/services/ecosystemSnapshotService');
    const summary = summarizeCluster([{ status: 'online' }, { status: 'parked' }]);
    expect(summary).toMatchObject({ status: 'ok', offlineHosts: 0, parkedHosts: 1 });
    const attention = summarizeOperationalAttention({ clusterHealth: summary, hostPreferences: [
      { hostUrl: PARKED, hostKey: 'lane-a', status: 'offline', pinnedModels: [{ model: 'lane-model' }] }] });
    expect(JSON.stringify(attention)).not.toContain('host_preference_offline');
    expect(JSON.stringify(attention)).not.toContain('hosts_offline');
  });
});
