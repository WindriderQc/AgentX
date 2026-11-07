process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';

const service = require('../../src/services/modelReadinessService');

function verifiedReadiness(overrides = {}) {
  return {
    stage: 'profiled',
    profileDepth: 'standard',
    benchmarkQualified: true,
    stale: false,
    authorityVerified: true,
    authority: {
      contract: 'agentx.profiler-readiness/v2',
      receiptVersion: 2,
      receiptVerified: true,
      liveIdentityVerified: true,
      evidenceQualified: true,
      verified: true
    },
    ...overrides
  };
}

describe('modelReadinessService v2 authority', () => {
  beforeEach(() => service.clearReadinessCache());

  test('invalidation during an owner read refreshes that caller and prevents stale cache insertion', async () => {
    let finish;
    const prior = new Promise(resolve => { finish = resolve; });
    const client = { getReadinessProfiles: jest.fn().mockReturnValueOnce(prior)
      .mockResolvedValue([{ name: 'current-model', readiness: {} }]) };
    const pending = service.loadReadinessIndex({ benchmarkClient: client });
    service.clearReadinessCache();
    finish([{ name: 'historical-model', readiness: {} }]);
    expect([...(await pending).keys()]).toEqual(['current-model']);
    expect([...(await service.loadReadinessIndex({ benchmarkClient: client })).keys()]).toEqual(['current-model']);
    expect(client.getReadinessProfiles).toHaveBeenCalledTimes(2);
  });

  test('only exact live v2 authority can make a profile routing-ready', () => {
    expect(service._normalizeReadinessEntry(verifiedReadiness(), 'primary', 'host')).toMatchObject({
      isReady: true,
      authorityVerified: true
    });

    for (const weak of [
      { authorityVerified: false },
      { authority: { contract: 'agentx.profiler-readiness/v1', verified: true } },
      { authority: { contract: 'agentx.profiler-readiness/v2', receiptVersion: 2, receiptVerified: true, liveIdentityVerified: false, evidenceQualified: true, verified: true } },
      { stale: true }
    ]) {
      expect(service._normalizeReadinessEntry(verifiedReadiness(weak), 'primary', 'host').isReady).toBe(false);
    }
  });

  test('best-host selection never prefers a qualified-looking projection without v2 authority', () => {
    const best = service.getBestReadiness({
      primary: verifiedReadiness({ authorityVerified: false }),
      secondary: verifiedReadiness({ stage: 'profiled' })
    });
    expect(best.hostId).toBe('secondary');
    expect(best.isReady).toBe(true);
  });

  test('normalizes legacy readiness as visible but non-authoritative', async () => {
    const result = await service.getModelReadiness('model-a', 'http://primary:11434', {
      useCache: false,
      profiles: [{
        name: 'model-a',
        readiness: {
          primary: {
            stage: 'benchmarked',
            profileDepth: 'full',
            benchmarkQualified: true,
            stale: false
          }
        }
      }]
    });
    expect(result.readiness).toMatchObject({
      stage: 'benchmarked',
      benchmarkQualified: true,
      authorityVerified: false,
      isReady: false
    });
  });
});
