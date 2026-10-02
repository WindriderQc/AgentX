/**
 * Unit Tests for the Pin Reconciler
 *
 * The reconciler (`checkAndReloadDefaults`) and the pin auto-restore
 * grace-period state machine were extracted from
 * hostPreferenceService.js into pinReconciler.js. The facade
 * still re-exports them, and tests/unit/hostPreferenceService.test.js
 * continues to exercise them THROUGH the facade. This file exercises the
 * SAME grace-period transitions directly against pinReconciler.js so the
 * "trickiest concurrency logic in core" has focused, isolated coverage that
 * does not depend on the facade re-export.
 *
 * The grace window is driven down to a few ms via setPinRestoreGraceMs so the
 * timing scenarios run in-memory. The host is unreachable (port 11434 has no
 * listener), so `fetch` is mocked per-test to return a controlled `/api/ps`
 * payload.
 */

// Mock logger to suppress output during tests
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const mockObservePinRestoreFailure = jest.fn(async () => ({ emitted: 1, matched: 1 }));
const mockObservePinVramSpill = jest.fn(async () => ({ emitted: 1, matched: 1 }));
const mockResolvePinVramSpill = jest.fn(async () => 1);
jest.mock('../../src/services/laneObservabilityService', () => ({
  observeClaimReleaseFailure: jest.fn(),
  observePinRestoreFailure: (...args) => mockObservePinRestoreFailure(...args),
  observePinVramSpill: (...args) => mockObservePinVramSpill(...args),
  resolvePinVramSpill: (...args) => mockResolvePinVramSpill(...args)
}));

const mockRunHostModelOperation = jest.fn(async (_options, operation) => operation({
  signal: new AbortController().signal,
  assertActive: jest.fn()
}));
jest.mock('../../src/services/inferenceAdmissionService', () => ({
  runHostModelOperation: (...args) => mockRunHostModelOperation(...args)
}));

const HostPreference = require('../../models/HostPreference');
const reconciler = require('../../src/services/pinReconciler');

afterEach(async () => {
  await HostPreference.deleteMany({});
});

describe('pinReconciler — pin auto-restore grace period', () => {
  const HOST_URL = 'http://recon-grace-host:11434';
  const PIN_MODEL = 'gemma4:26b';
  const OTHER_MODEL = 'qwen3.6:27b';
  const originalFetch = global.fetch;
  const originalGrace = reconciler.getPinRestoreGraceMs();

  function mockPs(loadedModelNames) {
    global.fetch = jest.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return {
          ok: true,
          json: async () => ({
            models: loadedModelNames.map(name => (typeof name === 'string' ? { name } : name))
          })
        };
      }
      // /api/generate (warmup) — return ok so the reconciler thinks the warm
      // succeeded and clears the grace stamp.
      return {
        ok: true,
        text: async () => '{"done":true}'
      };
    });
  }

  beforeEach(async () => {
    await HostPreference.create({
      hostUrl: HOST_URL,
      hostKey: 'primary',
      pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1 }],
      status: 'ready'
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    reconciler.setPinRestoreGraceMs(originalGrace);
  });

  it('getPinRestoreGraceMs / setPinRestoreGraceMs round-trip', () => {
    reconciler.setPinRestoreGraceMs(4242);
    expect(reconciler.getPinRestoreGraceMs()).toBe(4242);
    reconciler.setPinRestoreGraceMs(-1); // rejected — stays unchanged
    expect(reconciler.getPinRestoreGraceMs()).toBe(4242);
  });

  it('scenario 1 — pin loaded: no grace stamp, no warm', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    mockPs([PIN_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
    expect(after.status).toBe('ready');
  });

  it('does not mark a host ready when its embedding pin is displaced', async () => {
    await HostPreference.updateOne({ hostUrl: HOST_URL }, { $set: {
      status: 'ready',
      pinnedModels: [{ model: PIN_MODEL, keepAlive: -1 }, { model: 'qllama/bge-m3:f16', keepAlive: -1 }]
    } });
    mockPs([PIN_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.status).toBe('idle');
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    expect(global.fetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('scenario 2 — pin first displaced: stamps pinFirstDisplacedAt, no warm', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    mockPs([OTHER_MODEL]);
    const before = Date.now();
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    const stampedAt = new Date(after.pinFirstDisplacedAt).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before - 100);
    expect(stampedAt).toBeLessThanOrEqual(Date.now() + 100);
    expect(after.status).not.toBe('restoring');
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('scenario 3 — pin still in grace: no warm, stamp preserved', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    const stampedAt = new Date(Date.now() - 5_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: stampedAt } }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    expect(new Date(after.pinFirstDisplacedAt).getTime()).toBe(stampedAt.getTime());
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('scenario 4 — pin grace elapsed: warms and clears the stamp', async () => {
    reconciler.setPinRestoreGraceMs(50);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: new Date(Date.now() - 1_000) } }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls.length).toBeGreaterThanOrEqual(1);
    expect(mockRunHostModelOperation).toHaveBeenCalledWith(
      expect.objectContaining({ principal: 'core-pin-reconciler' }),
      expect.any(Function)
    );
    expect(after.pinFirstDisplacedAt).toBeFalsy();
  });

  it('observes a failed reconciler warm without changing the retry state machine', async () => {
    reconciler.setPinRestoreGraceMs(50);
    mockObservePinRestoreFailure.mockClear();
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: new Date(Date.now() - 1_000) } }
    );
    global.fetch = jest.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return { ok: true, json: async () => ({ models: [{ name: OTHER_MODEL }] }) };
      }
      return { ok: false, text: async () => 'warm failed' };
    });

    await reconciler.checkAndReloadDefaults();

    expect(mockObservePinRestoreFailure).toHaveBeenCalledWith(expect.objectContaining({
      host: HOST_URL,
      model: PIN_MODEL,
      source: 'pin-reconciler'
    }));
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
  });

  it('clears stamp when displacement resolves before grace elapses', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      { $set: { pinFirstDisplacedAt: new Date(Date.now() - 5_000) } }
    );
    mockPs([PIN_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
  });

  it('claim short-circuits before the grace check fires (defense in depth)', async () => {
    reconciler.setPinRestoreGraceMs(50);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          status: 'benchmarking',
          benchmarkClaim: {
            batchId: 'batch-x',
            prevStatus: 'ready',
            claimedAt: new Date(),
            estimatedDurationMs: 60_000
          }
        }
      }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeFalsy();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
    expect(after.status).toBe('benchmarking');
  });

  it('an active session hold short-circuits the restore like a claim', async () => {
    reconciler.setPinRestoreGraceMs(50);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          pinFirstDisplacedAt: new Date(Date.now() - 1_000),
          sessionHold: {
            holdId: 'hold-1',
            owner: 'extension/open',
            model: OTHER_MODEL,
            claimedAt: new Date(),
            lastActivityAt: new Date(),
            idleTtlMs: 600_000,
            expiresAt: new Date(Date.now() + 600_000)
          }
        }
      }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
    expect(after.sessionHold.holdId).toBe('hold-1');
    expect(after.loadedModels).toEqual([OTHER_MODEL]);
  });

  it('an expired session hold is cleared and the pin restores on the same tick', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          sessionHold: {
            holdId: 'hold-stale',
            owner: 'extension/open',
            model: OTHER_MODEL,
            claimedAt: new Date(Date.now() - 20 * 60_000),
            lastActivityAt: new Date(Date.now() - 11 * 60_000),
            idleTtlMs: 600_000,
            expiresAt: new Date(Date.now() - 60_000)
          }
        }
      }
    );
    mockPs([OTHER_MODEL]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.sessionHold.holdId).toBeNull();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls.length).toBeGreaterThanOrEqual(1);
    expect(after.pinFirstDisplacedAt).toBeFalsy();
  });

  it('treats a loaded pin with the wrong context as displaced', async () => {
    reconciler.setPinRestoreGraceMs(60_000);
    await HostPreference.findOneAndUpdate(
      { hostUrl: HOST_URL },
      {
        $set: {
          pinnedModels: [{ model: PIN_MODEL, autoRestore: true, keepAlive: -1, contextSize: 65536 }]
        }
      }
    );
    mockPs([{ name: PIN_MODEL, context_length: 32768 }]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinFirstDisplacedAt).toBeTruthy();
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });
});

describe('pinReconciler — pinned model VRAM spill', () => {
  const HOST_URL = 'http://recon-spill-host:11434';
  const PIN_MODEL = 'qwen3.8:27b-mtp-q8_0';
  const EMBED_MODEL = 'qllama/bge-m3:f16';
  const originalFetch = global.fetch;

  function mockPs(models) {
    global.fetch = jest.fn(async (url) => {
      if (typeof url === 'string' && url.endsWith('/api/ps')) {
        return { ok: true, json: async () => ({ models }) };
      }
      return { ok: true, text: async () => '{"done":true}' };
    });
  }

  function resident(name, size, sizeVram) {
    return { name, size, size_vram: sizeVram, expires_at: '2319-01-07T00:00:00Z' };
  }

  beforeEach(async () => {
    mockObservePinVramSpill.mockClear();
    mockResolvePinVramSpill.mockClear();
    await HostPreference.create({
      hostUrl: HOST_URL,
      hostKey: 'primary',
      displayName: 'Spill host',
      pinnedModels: [
        { model: PIN_MODEL, autoRestore: true, keepAlive: -1 },
        { model: EMBED_MODEL, autoRestore: true, keepAlive: -1 }
      ],
      status: 'ready'
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('records a CPU-resident pin, alerts, and does not reload it', async () => {
    mockPs([resident(PIN_MODEL, 30903852071, 0), resident(EMBED_MODEL, 664000265, 664000265)]);
    await reconciler.checkAndReloadDefaults();

    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinVramSpill.detectedAt).toBeTruthy();
    expect(after.pinVramSpill.models).toEqual([{ model: PIN_MODEL, size: 30903852071, sizeVram: 0 }]);
    expect(after.status).toBe('ready');
    expect(mockObservePinVramSpill).toHaveBeenCalledWith(expect.objectContaining({
      host: HOST_URL,
      hostKey: 'primary',
      spills: [{ model: PIN_MODEL, size: 30903852071, sizeVram: 0 }]
    }));
    const generateCalls = global.fetch.mock.calls.filter(
      c => typeof c[0] === 'string' && c[0].endsWith('/api/generate')
    );
    expect(generateCalls).toHaveLength(0);
  });

  it('keeps the first detection time while the spill persists', async () => {
    const detectedAt = new Date(Date.now() - 60_000);
    await HostPreference.updateOne({ hostUrl: HOST_URL }, { $set: { pinVramSpill: {
      detectedAt, models: [{ model: EMBED_MODEL, size: 1263009790, sizeVram: 581980651 }]
    } } });
    mockPs([resident(PIN_MODEL, 100, 100), resident(EMBED_MODEL, 1263009790, 581980651)]);
    await reconciler.checkAndReloadDefaults();

    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(new Date(after.pinVramSpill.detectedAt).getTime()).toBe(detectedAt.getTime());
    expect(mockObservePinVramSpill).toHaveBeenCalledTimes(1);
  });

  it('clears the record and resolves the alert once every pin fits', async () => {
    await HostPreference.updateOne({ hostUrl: HOST_URL }, { $set: { pinVramSpill: {
      detectedAt: new Date(), models: [{ model: PIN_MODEL, size: 100, sizeVram: 0 }]
    } } });
    mockPs([resident(PIN_MODEL, 100, 100), resident(EMBED_MODEL, 50, 50)]);
    await reconciler.checkAndReloadDefaults();

    const after = await HostPreference.findOne({ hostUrl: HOST_URL }).lean();
    expect(after.pinVramSpill).toBeNull();
    expect(mockResolvePinVramSpill).toHaveBeenCalledWith(expect.objectContaining({
      host: HOST_URL, health: expect.objectContaining({ status: 'healthy' })
    }));
    expect(mockObservePinVramSpill).not.toHaveBeenCalled();
  });

  it('stays quiet on a healthy host', async () => {
    mockPs([resident(PIN_MODEL, 100, 100), resident(EMBED_MODEL, 50, 50)]);
    await reconciler.checkAndReloadDefaults();
    expect(mockObservePinVramSpill).not.toHaveBeenCalled();
    expect(mockResolvePinVramSpill).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [{ name: PIN_MODEL }, { name: EMBED_MODEL }],
    [{ name: PIN_MODEL, size: 100, size_vram: null }, resident(EMBED_MODEL, 50, 50)]
  ].map(models => [models]))('keeps a previous spill when fresh inventory lacks full residency proof: %j', async (models) => {
    await HostPreference.updateOne({ hostUrl: HOST_URL }, { $set: { pinVramSpill: {
      detectedAt: new Date(), models: [{ model: PIN_MODEL, size: 100, sizeVram: 0 }]
    }, 'pinnedModels.0.autoRestore': false, 'pinnedModels.1.autoRestore': false } });
    mockPs(models);
    await reconciler.checkAndReloadDefaults();
    expect((await HostPreference.findOne({ hostUrl: HOST_URL }).lean()).pinVramSpill.models).toHaveLength(1);
    expect(mockResolvePinVramSpill).not.toHaveBeenCalled();
    expect(mockObservePinVramSpill).not.toHaveBeenCalled();
  });
});

describe('pinReconciler — CPU host residency', () => {
  const CPU_URL = 'http://recon-cpu-host:11435';
  const CPU_MODEL = 'gemma4:26b-a4b-it-qat';
  const hostConfig = require('../../src/helpers/ollamaHostConfig');
  const originalFetch = global.fetch;

  function mockPs(models) {
    global.fetch = jest.fn(async (url) => (typeof url === 'string' && url.endsWith('/api/ps')
      ? { ok: true, json: async () => ({ models }) }
      : { ok: true, text: async () => '{"done":true}' }));
  }

  beforeEach(async () => {
    mockObservePinVramSpill.mockClear();
    mockResolvePinVramSpill.mockClear();
    hostConfig.setRegisteredHosts([{ id: 'recon-cpu', url: CPU_URL, residency: 'cpu', maxInflight: 1 }]);
    await HostPreference.deleteMany({});
    await HostPreference.create({
      hostUrl: CPU_URL, hostKey: 'recon-cpu', displayName: 'CPU host',
      pinnedModels: [{ model: CPU_MODEL, autoRestore: true, keepAlive: -1, numThread: 6 }], status: 'ready'
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    hostConfig.setRegisteredHosts([]);
  });

  it('raises no alert for a CPU pin held outside VRAM', async () => {
    mockPs([{ name: CPU_MODEL, size: 17000000000, size_vram: 0, expires_at: '2319-01-07T00:00:00Z' }]);
    await reconciler.checkAndReloadDefaults();
    const after = await HostPreference.findOne({ hostUrl: CPU_URL }).lean();
    expect(after.pinVramSpill || null).toBeNull();
    expect(after.pinnedModels[0].numThread).toBe(6);
    expect(mockObservePinVramSpill).not.toHaveBeenCalled();
  });

  it('alerts when the CPU instance still loads its pin into VRAM', async () => {
    mockPs([{ name: CPU_MODEL, size: 17000000000, size_vram: 4000000000, expires_at: '2319-01-07T00:00:00Z' }]);
    await reconciler.checkAndReloadDefaults();
    expect(mockObservePinVramSpill).toHaveBeenCalledWith(expect.objectContaining({
      host: CPU_URL,
      spills: [{ model: CPU_MODEL, size: 17000000000, sizeVram: 4000000000, expected: 'cpu' }]
    }));
  });
});
