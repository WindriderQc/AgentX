const { loadBrowserModule } = require('../../helpers/browserModule');
const MODEL = 'example:7b';
const HOST = 'http://test-host.example:11434';
const verified = (extra = {}) => ({ stage: 'profiled', authorityVerified: true, stale: false,
  benchmarkQualified: true, artifact: { model: MODEL, hostUrl: HOST, digest: 'sha256:one', runtimeFingerprint: 'runtime-one' }, ...extra });
const moduleWith = readiness => loadBrowserModule('model-profiler/components/readiness-cache.js',
  'getReadinessMap, getBadgeHtml', { fetch: async () => ({ ok: true, json: async () => ({ data: [{ name: MODEL, readiness }] }) }) });

test('keeps host identities and labels the badge as current installation evidence only', async () => {
  const ui = moduleWith({ a: verified(), b: verified({ artifact: { model: MODEL, hostUrl: 'http://other:11434' } }) });
  const map = await ui.getReadinessMap();
  const badge = ui.getBadgeHtml(MODEL, map, { host: HOST });
  expect(badge).toContain('Current host profile verified');
  expect(badge).toContain('does not qualify historical benchmark results');
  expect(badge).not.toContain('1/2');
  expect(ui.getBadgeHtml(MODEL, map, { host: 'http://missing:11434' })).toBe('');
});

test.each([
  { stale: true }, { authorityVerified: false }, { benchmarkQualified: false },
  { artifact: { model: MODEL, hostUrl: HOST, digest: 'changed' } },
  { artifact: { model: 'different-model', hostUrl: HOST, digest: 'one', runtimeFingerprint: 'one' } }
])('withholds stale, unverified or mismatched profiles: %j', async extra => {
  const ui = moduleWith({ a: verified(extra) });
  expect(ui.getBadgeHtml(MODEL, await ui.getReadinessMap(), { host: HOST })).toBe('');
});

test.each([{ host: HOST, host_available: false }, { host: HOST, executionTarget: { executionKind: 'harness' } }, {}])(
  'does not attach current direct-host readiness to an unavailable or unidentified target: %j', async target => {
    const ui = moduleWith({ a: verified() });
    expect(ui.getBadgeHtml(MODEL, await ui.getReadinessMap(), target)).toBe('');
  });
