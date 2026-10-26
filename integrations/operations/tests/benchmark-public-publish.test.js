'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  UNLISTED_HOST,
  UnsafePublicationError,
  assertPublicSafe,
  buildPublication,
  createHostResolver,
  createModelFilter,
  findPrivateLocations,
} = require('../benchmark-public/projection');
const { writeOutbox } = require('../benchmark-public/outbox');
const { rsyncArgs, validateTarget } = require('../benchmark-public/delivery');
const { parseArgs, publish } = require('../benchmark-public-publish');

// Synthetic private payloads shaped like Benchmark's API, with addresses
// planted in every place the real responses carry them.
const HOST_NAMES = {
  'http://192.168.2.99:11434': 'UGFrank',
  'http://192.168.2.99:11435': 'UGFrank CPU',
  'http://192.168.2.199:11434': 'UGAlien',
  'http://10.0.0.7:11434': '10.0.0.7',
  'http://ollama-box.lan:11434': 'Box',
};

function leaderboardRow(model, host, score, extra = {}) {
  return {
    model,
    host,
    host_available: true,
    executionTarget: { host, id: `ollama:${host}`, label: model },
    provider: 'ollama',
    tier: 'local',
    rankable: true,
    generalistScore: score,
    coverage: 88,
    totalTests: 104,
    testedCategories: 7,
    confidenceMargin: 4.91,
    evidenceStatus: 'partial_scope',
    categoryAverages: { coding: 100, reasoning: 79.0666, 'bad key!': 3 },
    judgeTargets: [{ host, model: 'judge:27b' }],
    judgeModels: ['judge:27b'],
    promptCoverage: { missing: [{ name: 'Private prompt name' }] },
    harnessEvidence: { executionTargetFingerprints: ['abc'] },
    latestTimestamp: '2026-09-24T00:01:54.412Z',
    residency: 'gpu',
    prompt: 'private prompt',
    response: 'private response',
    ...extra,
  };
}

function fixture() {
  return {
    hostNames: HOST_NAMES,
    summary: {
      total_tests: 3192,
      successful: 3175,
      failed: 17,
      leaderboard: [{ model: 'qwen2.5:3b', host: 'http://192.168.2.99:11434' }],
    },
    leaderboard: {
      axis: 'quality',
      categoryWeights: { coding: 0.18, reasoning: 0.17 },
      primaryHostUrl: 'http://192.168.2.199:11434',
      configuredHosts: [{ name: 'UGAlien', url: 'http://192.168.2.199:11434' }],
      hostModelSnapshot: { hosts: [{ url: 'http://192.168.2.99:11434', error: 'connect ECONNREFUSED 192.168.2.99:11434' }] },
      leaderboard: [
        leaderboardRow('gemma4:31b-it-q8_0', 'http://192.168.2.199:11434', 82.9),
        leaderboardRow('qwen2.5:3b', 'http://192.168.2.99:11434', 41.3),
        leaderboardRow('qwen2.5:3b', 'http://192.168.2.199:11439', 40.1),
        leaderboardRow('agent-model:27b', 'harness:openclaw:openclaw-local', 70),
        leaderboardRow('gpt-x', 'https://api.example.com/v1', 90, { tier: 'cloud', provider: 'openrouter' }),
        leaderboardRow('odd-ip-name', 'http://10.0.0.7:11434', 50),
        leaderboardRow('unknown-host-model', 'http://172.16.4.4:11434', 49),
        leaderboardRow('evil 192.168.2.99:11434 model', 'http://192.168.2.99:11434', 99),
        leaderboardRow('<script>x</script>', 'http://192.168.2.99:11434', 98),
        leaderboardRow('huihui_ai/abliterated:27b', 'http://192.168.2.199:11434', 80),
        leaderboardRow('not-ranked', 'http://192.168.2.199:11434', null, { rankable: false }),
      ],
    },
    efficiency: {
      entries: [
        { model: 'gemma4:31b-it-q8_0', host: 'http://192.168.2.199:11434', avgQuality: 8.64, avgTokPerSec: 100.53, avgLatency: 8391.4, testCount: 54, efficiencyScore: 92.7, paretoOptimal: true, rankStatus: 'ranked', categoryScores: { math: 9.73 } },
        { model: 'medgemma:4b', host: 'http://192.168.2.99:11435', avgQuality: 7, avgTokPerSec: 20, testCount: 10, efficiencyScore: 15, paretoOptimal: false, rankStatus: 'ranked' },
        { model: 'held-back', host: 'http://192.168.2.99:11434', rankStatus: 'unranked', unrankedReason: 'too few tests' },
      ],
      frontier: ['gemma4:31b-it-q8_0@@http://192.168.2.199:11434'],
      meta: { totalModels: 3, generatedAt: '2026-10-25T14:46:28.811Z' },
    },
  };
}

const GENERATED_AT = '2026-10-25T14:50:00.000Z';

test('no address, URL or Ollama port can leave in any published file', () => {
  const { files } = buildPublication(fixture(), { generatedAt: GENERATED_AT });
  const text = JSON.stringify(files);
  for (const forbidden of ['192.168.', ':11434', ':11435', ':11439', '10.0.0.7', '172.16.', 'ollama-box.lan', '://', 'ECONNREFUSED', 'api.example.com']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} leaked`);
  }
  assert.deepEqual(findPrivateLocations(files), []);
});

test('only allow-listed fields are published', () => {
  const { files } = buildPublication(fixture(), { generatedAt: GENERATED_AT });
  const row = files['leaderboard.json'].leaderboard[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'categoryAverages', 'confidenceMargin', 'coverage', 'evidenceStatus', 'generalistScore', 'hostAlias',
    'latestResultAt', 'model', 'rank', 'residency', 'slug', 'testedCategories', 'tier', 'totalTests',
  ]);
  assert.deepEqual(row.categoryAverages, { coding: 100, reasoning: 79.07 });
  const text = JSON.stringify(files);
  for (const field of ['prompt', 'response', 'judgeTargets', 'executionTarget', 'promptCoverage', 'harnessEvidence', 'primaryHostUrl', 'hostModelSnapshot', 'configuredHosts']) {
    assert.equal(text.includes(`"${field}"`), false, `${field} leaked`);
  }
  assert.deepEqual(Object.keys(files['efficiency.json'].entries[0]).sort(), [
    'avgLatencyMs', 'avgQuality', 'avgTokPerSec', 'categoryScores', 'efficiencyScore', 'hostAlias', 'model', 'paretoOptimal', 'slug', 'testCount',
  ]);
});

test('hosts become registry machine names, never addresses', () => {
  const { resolve } = createHostResolver(HOST_NAMES);
  assert.equal(resolve('http://192.168.2.199:11434'), 'UGAlien');
  assert.equal(resolve('http://192.168.2.99:11435'), 'UGFrank CPU');
  assert.equal(resolve('192.168.2.99:11434'), 'UGFrank', 'a URL without scheme still matches');
  assert.equal(resolve('http://192.168.2.199:11439'), 'UGAlien (other instance)', 'unregistered port on a known machine');
  assert.equal(resolve('http://192.168.2.99:11999'), 'UGFrank (other instance)', 'prefers the default-port entry over the CPU one');
  assert.equal(resolve('http://172.16.4.4:11434'), UNLISTED_HOST);
  assert.equal(resolve('http://10.0.0.7:11434'), UNLISTED_HOST, 'a registry name that is an address is not used');
  assert.equal(resolve('harness:openclaw:openclaw-local'), 'openclaw agent');
  assert.equal(resolve('https://api.example.com/v1', { tier: 'cloud', provider: 'openrouter' }), 'openrouter');
  assert.equal(resolve(null), UNLISTED_HOST);
  assert.equal(resolve('not a url at all ::'), UNLISTED_HOST);
});

test('rows whose model name carries an address or markup are dropped, as are unranked rows', () => {
  const { files, dropped } = buildPublication(fixture(), { generatedAt: GENERATED_AT });
  const models = files['leaderboard.json'].leaderboard.map((row) => row.model);
  assert.equal(models.some((model) => model.includes('evil')), false);
  assert.equal(models.includes('not-ranked'), false);
  assert.ok(models.includes('scriptx/script'), 'markup characters are stripped');
  assert.equal(dropped.leaderboard.unsafeModel, 1);
  assert.equal(dropped.leaderboard.unrankable, 1);
  assert.equal(dropped.efficiency.unranked, 1);
});

test('leaderboard is ranked by score and model cards gather each model across hosts', () => {
  const { files } = buildPublication(fixture(), { generatedAt: GENERATED_AT });
  const board = files['leaderboard.json'].leaderboard;
  assert.deepEqual(board.map((row) => row.rank), board.map((_row, index) => index + 1));
  assert.equal(board[0].model, 'scriptx/script');
  const card = files['model-cards.json'].models.find((entry) => entry.slug === 'qwen2-5-3b');
  assert.equal(card.results.length, 2);
  assert.deepEqual(card.results.map((result) => result.hostAlias), ['UGFrank', 'UGAlien (other instance)']);
  assert.equal(card.generalistScore, 41.3);
  assert.equal(card.totalTests, 208);
  assert.match(card.summary, /UGFrank/);
  assert.deepEqual(files['efficiency.json'].frontier, [{ slug: 'gemma4-31b-it-q8-0', model: 'gemma4:31b-it-q8_0', hostAlias: 'UGAlien' }]);
  assert.equal(files['summary.json'].metrics.tests, 3192);
  assert.equal(files['summary.json'].topModel.model, 'scriptx/script');
});

test('excluded models stay off every file', () => {
  assert.equal(createModelFilter(['huihui_ai/*'])('HUIHUI_AI/abliterated:27b'), true);
  assert.equal(createModelFilter('*dolphin*, x')('hf.co/Dolphin-X1'), true);
  assert.equal(createModelFilter([])('anything'), false);
  const { files, dropped } = buildPublication(fixture(), { generatedAt: GENERATED_AT, excludeModels: ['huihui_ai/*', 'medgemma*'] });
  const text = JSON.stringify(files);
  assert.equal(text.includes('huihui'), false);
  assert.equal(text.includes('medgemma'), false);
  assert.equal(dropped.leaderboard.excluded, 1);
  assert.equal(dropped.efficiency.excluded, 1);
});

test('the final guard refuses a payload that still locates a machine', () => {
  for (const value of ['http://example.org', '192.168.2.12', 'host:11434', 'localhost', '[fe80::1]', 'fe80:0:0:0:1:2:3:4', '\\\\nas\\share', 'see /srv/agentx/x']) {
    assert.throws(() => assertPublicSafe({ 'x.json': { label: value } }), UnsafePublicationError, value);
  }
  assert.throws(() => assertPublicSafe({ 'x.json': { 'http://key': 1 } }), UnsafePublicationError);
  assert.throws(() => assertPublicSafe({ 'x.json': { label: 'box.lan' } }, ['box.lan']), UnsafePublicationError);
  for (const value of ['qwen3.8:27b-mtp-q8_0', 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_M', '2026-10-25T14:50:00.000Z', 'qwen2.5:3b', 'UGFrank CPU']) {
    assert.doesNotThrow(() => assertPublicSafe({ 'x.json': { label: value } }), value);
  }
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-scoreboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('outbox writes current files and one dated snapshot per changed day', (t) => {
  const outbox = tempDir(t);
  const first = buildPublication(fixture(), { generatedAt: '2026-10-25T03:00:00.000Z' });
  assert.equal(writeOutbox(outbox, first, { timeZone: 'UTC' }).status, 'changed');
  assert.equal(writeOutbox(outbox, buildPublication(fixture(), { generatedAt: '2026-10-26T03:00:00.000Z' }), { timeZone: 'UTC' }).status, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outbox, 'summary.json'))).generatedAt, '2026-10-25T03:00:00.000Z', 'unchanged content keeps its date');

  const changedSource = fixture();
  changedSource.leaderboard.leaderboard[0].generalistScore = 83.5;
  const result = writeOutbox(outbox, buildPublication(changedSource, { generatedAt: '2026-10-26T03:00:00.000Z' }), { timeZone: 'UTC' });
  assert.equal(result.snapshotId, '2026-10-26');
  const index = JSON.parse(fs.readFileSync(path.join(outbox, 'snapshots.json')));
  assert.deepEqual(index.snapshots.map((entry) => entry.snapshot_id), ['2026-10-26', '2026-10-25']);
  assert.equal(index.snapshots[0].file, 'snapshots/2026-10-26.json');
  assert.equal(index.snapshots[0].topModel, 'scriptx/script');
  assert.equal(JSON.parse(fs.readFileSync(path.join(outbox, 'summary.json'))).metrics.snapshots, 2);
  const snapshot = JSON.parse(fs.readFileSync(path.join(outbox, 'snapshots', '2026-10-26.json')));
  assert.equal(snapshot.leaderboard.leaderboard.length > 0, true);
  assert.equal(fs.readdirSync(outbox).some((name) => name.endsWith('.tmp')), false);
});

test('outbox retention removes the oldest dated snapshots', (t) => {
  const outbox = tempDir(t);
  for (let day = 20; day <= 24; day += 1) {
    const source = fixture();
    source.leaderboard.leaderboard[0].generalistScore = day;
    writeOutbox(outbox, buildPublication(source, { generatedAt: `2026-10-${day}T12:00:00.000Z` }), { timeZone: 'UTC', keepSnapshots: 3 });
  }
  assert.deepEqual(fs.readdirSync(path.join(outbox, 'snapshots')).sort(), ['2026-10-22.json', '2026-10-23.json', '2026-10-24.json']);
});

test('snapshot names follow the requested time zone', (t) => {
  const outbox = tempDir(t);
  const result = writeOutbox(outbox, buildPublication(fixture(), { generatedAt: '2026-10-26T02:00:00.000Z' }), { timeZone: 'America/Toronto' });
  assert.equal(result.snapshotId, '2026-10-25');
});

test('dry run reads Benchmark, writes the local tree and sends nothing', async (t) => {
  const outbox = tempDir(t);
  const data = fixture();
  const byRoute = {
    '/api/benchmark/summary': data.summary,
    '/api/benchmark/generalist-leaderboard': data.leaderboard,
    '/api/benchmark/efficiency-map': data.efficiency,
    '/api/benchmark/host-names': data.hostNames,
  };
  const fetchImpl = async (url) => {
    const route = new URL(url).pathname;
    return { ok: true, status: 200, json: async () => ({ status: 'success', data: byRoute[route] }) };
  };
  let delivered = false;
  const options = parseArgs(['--outbox', outbox, '--benchmark-url', 'http://127.0.0.1:9/', '--time-zone', 'UTC']);
  const report = await publish(options, { fetchImpl, deliver: async () => { delivered = true; }, now: () => new Date(GENERATED_AT) });
  assert.equal(report.dryRun, true);
  assert.equal(delivered, false);
  assert.equal(report.status, 'changed');
  for (const name of ['summary.json', 'leaderboard.json', 'efficiency.json', 'model-cards.json', 'snapshots.json', 'snapshots/2026-10-25.json']) {
    const text = fs.readFileSync(path.join(outbox, name), 'utf8');
    assert.equal(/192\.168\.|:11434/.test(text), false, `${name} carries an address`);
  }

  const sent = await publish({ ...options, send: true, target: 'pub@example.org:/srv/public' }, {
    fetchImpl, deliver: async (dir, target) => ({ status: 'delivered', dir, target: target.target }), now: () => new Date(GENERATED_AT),
  });
  assert.equal(sent.delivery.status, 'delivered');
  assert.equal(sent.status, 'unchanged');
});

test('a failing Benchmark route publishes nothing', async (t) => {
  const outbox = tempDir(t);
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(publish(parseArgs(['--outbox', outbox]), { fetchImpl }), /answered 503/);
  assert.deepEqual(fs.readdirSync(outbox), []);
});

test('arguments: --send needs a target, values are validated', () => {
  const saved = process.env.AGENTX_PUBLIC_SCOREBOARD_TARGET;
  delete process.env.AGENTX_PUBLIC_SCOREBOARD_TARGET;
  try {
    assert.throws(() => parseArgs([]), /--outbox is required/);
    assert.throws(() => parseArgs(['--outbox', '/tmp/x', '--send']), /needs --target/);
    assert.throws(() => parseArgs(['--outbox', '/tmp/x', '--keep-snapshots', '0']), /positive/);
    assert.throws(() => parseArgs(['--outbox', '/tmp/x', '--time-zone', 'Nowhere/City']));
    assert.deepEqual(parseArgs(['--outbox', '/tmp/x', '--exclude-model', 'a*', '--exclude-model', 'b']).excludeModels, ['a*', 'b']);
  } finally {
    if (saved !== undefined) process.env.AGENTX_PUBLIC_SCOREBOARD_TARGET = saved;
  }
});

test('delivery target must be user@host:/absolute/folder', () => {
  assert.equal(validateTarget('pub@example.org:/srv/public-agentx'), 'pub@example.org:/srv/public-agentx/');
  for (const bad of ['', 'example.org:/srv', 'pub@example.org:relative', 'pub@example.org:/', '-oProxyCommand=x@h:/a', 'pub@host:/srv/../etc', 'pub@host:/srv/a b', 'pub@host:/srv;rm']) {
    assert.throws(() => validateTarget(bad), /user@host/, bad);
  }
});

test('rsync sends only scoreboard files and deletes only expired dated snapshots', { skip: spawnSync('rsync', ['--version']).status !== 0 && 'rsync is not installed' }, (t) => {
  const outbox = tempDir(t);
  const destination = tempDir(t);
  writeOutbox(outbox, buildPublication(fixture(), { generatedAt: GENERATED_AT }), { timeZone: 'UTC' });
  fs.writeFileSync(path.join(outbox, 'stray.tmp'), 'x');
  fs.writeFileSync(path.join(outbox, 'snapshots', 'notes.txt'), 'x');
  // Files already on the server that are not ours, plus one expired snapshot.
  fs.mkdirSync(path.join(destination, 'snapshots'));
  fs.mkdirSync(path.join(destination, 'images'));
  fs.writeFileSync(path.join(destination, 'images', 'logo.png'), 'x');
  fs.writeFileSync(path.join(destination, 'index.html'), 'x');
  fs.writeFileSync(path.join(destination, 'latest.json'), '{}');
  fs.writeFileSync(path.join(destination, 'snapshots', '2020-01-01.json'), '{}');
  fs.writeFileSync(path.join(destination, 'snapshots', 'README'), 'x');

  const args = rsyncArgs(outbox, { target: 'pub@example.org:/srv/public' });
  const sshIndex = args.indexOf('-e');
  assert.match(args[sshIndex + 1], /StrictHostKeyChecking=yes/);
  args.splice(sshIndex, 2);
  args[args.length - 1] = `${destination}/`;
  const run = spawnSync('rsync', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const listing = (dir) => fs.readdirSync(dir).sort();
  assert.deepEqual(listing(destination), ['efficiency.json', 'images', 'index.html', 'latest.json', 'leaderboard.json', 'model-cards.json', 'snapshots', 'snapshots.json', 'summary.json']);
  assert.deepEqual(listing(path.join(destination, 'snapshots')), ['2026-10-25.json', 'README']);
  assert.deepEqual(listing(path.join(destination, 'images')), ['logo.png']);
});
