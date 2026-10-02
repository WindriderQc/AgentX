const HostPreference = require('../../models/HostPreference');
const hostGate = require('../../src/services/hostGate');
const { restoreBenchmarkRuntime } = require('../../src/services/benchmarkRuntimeRestore');
const host = 'http://restore-fixture:11434';
const expiry = '2318-01-01T00:00:00Z';
const target = (model, size, contextLength) => ({ model, digest: model + '-digest', artifactSize: size,
  sizeVram: size, contextLength, keepAlive: -1, expiresAt: expiry });
const main = target('fixture:1', 1000, 4096), embed = target('qllama/bge-m3:f16', 100, 8192);
const info = entry => ({ name: entry.model, digest: entry.digest, size: entry.artifactSize,
  size_vram: entry.sizeVram, context_length: entry.contextLength, expires_at: expiry });
const snapshot = { exact: true, identityDigest: 'a'.repeat(64), residents: [embed, main] };
let running, originalFetch;
beforeEach(async () => {
  await HostPreference.deleteMany({});
  await HostPreference.create({ hostUrl: host, hostKey: 'primary', status: 'benchmarking', benchmarkClaim: { batchId: 'profile-fixture', claimGeneration: 'generation-1' } });
  originalFetch = global.fetch; running = [];
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ models: running.map(entry => ({ ...entry })) }) }));
  jest.spyOn(hostGate, 'hostHasInflightAnywhere').mockResolvedValue(false);
});
afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });
function dependencies(warm = null) {
  return { benchmarkRuntimeSnapshotIdentity: () => 'a'.repeat(64), desiredBenchmarkResidents: value => value.residents,
    benchmarkResidentExpiryMatches: () => true,
    warmDefaultModel: warm || jest.fn(async (_host, model) => {
      const entry = snapshot.residents.find(row => row.model === model); running = running.filter(row => row.name !== model);
      running.push(info(entry)); return { status: 'ok' };
    }),
    unloadModel: jest.fn(async (_host, model) => { running = running.filter(entry => entry.name !== model); return { status: 'ok' }; }) };
}
const claim = () => ({ batchId: 'profile-fixture', claimGeneration: 'generation-1', assertAuthorityActive: jest.fn() });
test('restores all residents, embedding included, in generative-then-embedding order', async () => {
  const deps = dependencies();
  const result = await restoreBenchmarkRuntime(host, snapshot, claim(), deps);
  expect(result).toMatchObject({ verified: true, residents: snapshot.residents });
  expect(deps.warmDefaultModel.mock.calls.map(call => call[1])).toEqual([main.model, embed.model]);
});
test.each([true, false])('a missing co-resident retries once and verifies the whole set (second succeeds=%s)', async succeeds => {
  let embeddingWarms = 0;
  const warm = jest.fn(async (_host, model) => {
    if (model === embed.model && (++embeddingWarms === 1 || !succeeds)) return { status: 'ok' };
    running = running.filter(entry => entry.name !== model); running.push(info(snapshot.residents.find(entry => entry.model === model)));
    return { status: 'ok' };
  });
  const result = await restoreBenchmarkRuntime(host, snapshot, claim(), dependencies(warm));
  expect(result.verified).toBe(succeeds); expect(embeddingWarms).toBe(2);
  expect(warm.mock.calls.map(call => call[1])).toEqual([main.model, embed.model, main.model, embed.model]);
  if (!succeeds) expect(result.error).toContain('did not verify the resident');
});
test('active inference prevents even the first restore mutation', async () => {
  hostGate.hostHasInflightAnywhere.mockResolvedValue(true);
  const deps = dependencies();
  expect(await restoreBenchmarkRuntime(host, snapshot, claim(), deps)).toMatchObject({ verified: false, status: 'busy' });
  expect(deps.warmDefaultModel).not.toHaveBeenCalled(); expect(deps.unloadModel).not.toHaveBeenCalled();
});
test('a changed owner before the retry forbids a second mutation', async () => {
  const deps = dependencies(jest.fn(async (_host, model) => {
    if (model === main.model) running.push(info(main));
    else await HostPreference.updateOne({ hostUrl: host }, { $set: { 'benchmarkClaim.claimGeneration': 'replacement' } });
    return { status: 'ok' };
  }));
  await expect(restoreBenchmarkRuntime(host, snapshot, claim(), deps)).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_LOST' });
  expect(deps.warmDefaultModel).toHaveBeenCalledTimes(2);
});
test('an unacknowledged warm is never retried as a residency miss', async () => {
  const deps = dependencies(jest.fn(async () => ({ status: 'error', error: 'terminal receipt missing' })));
  expect(await restoreBenchmarkRuntime(host, snapshot, claim(), deps)).toMatchObject({ verified: false });
  expect(deps.warmDefaultModel).toHaveBeenCalledTimes(1);
});

describe('GPU placement after restore (#50, #145)', () => {
  const spilledEmbed = { ...embed, sizeVram: 40 };
  const spilledSnapshot = { exact: true, identityDigest: 'a'.repeat(64), residents: [spilledEmbed, main] };
  const warmWith = (vramByModel) => jest.fn(async (_host, model) => {
    const entry = spilledSnapshot.residents.find(row => row.model === model);
    running = running.filter(row => row.name !== model);
    running.push({ ...info(entry), size_vram: vramByModel[model] ?? entry.sizeVram });
    return { status: 'ok' };
  });

  test('a resident that already spilled may come back with another GPU share, and the drift is reported', async () => {
    const warm = warmWith({ [embed.model]: 55 });
    const result = await restoreBenchmarkRuntime(host, spilledSnapshot, claim(), dependencies(warm));
    expect(result).toMatchObject({ verified: true, status: 'ready' });
    expect(result.placementDrift).toEqual([{ model: embed.model, expectedVram: 40, observedVram: 55 }]);
    expect(warm).toHaveBeenCalledTimes(2);
  });

  test('a resident that was wholly on the GPU must come back wholly on the GPU', async () => {
    const warm = warmWith({ [main.model]: 900 });
    const result = await restoreBenchmarkRuntime(host, spilledSnapshot, claim(), dependencies(warm));
    expect(result.verified).toBe(false);
    expect(result.error).toContain('GPU placement');
    expect(warm).toHaveBeenCalledTimes(4);
  });

  test('an exact restore reports no drift', async () => {
    const result = await restoreBenchmarkRuntime(host, snapshot, claim(), dependencies());
    expect(result.verified).toBe(true);
    expect(result.placementDrift).toBeUndefined();
  });
});
