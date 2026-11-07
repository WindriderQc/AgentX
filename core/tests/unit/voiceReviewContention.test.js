'use strict';

const { configuredTargets, diagnose, readVoiceReviewContention, WINDOW_MS, HOST_MAX_AGE_MS } = require('../../src/services/voiceReviewContention');
const now = Date.parse('2026-10-01T12:00:00Z');
const at = offset => new Date(now + offset).toISOString();
const host = 'http://synthetic-voice:11434';
const model = 'synthetic:1b';
const configVersion = 'router-synthetic';
const contract = 'household-runtime-v1';
const target = { host, model };

function fixture(surface = 'nestor') {
  const receipt = (taskType, callerDetail) => ({ ...target, source: 'core-observed', status: 'success',
    consumerContract: contract, taskType, callerDetail, timestamp: at(-1000),
    routeDecision: { configVersion, attribution: { consumerContract: contract } } });
  return { surface, now, enabled: true, configVersion,
    targets: { voice: target, review: target, voiceTask: 'voice_persona_chat', reviewTask: 'household_review' },
    receipts: {
      voice: receipt('voice_persona_chat', `agentx-household/${surface === 'family' ? 'kidx_nestor' : 'personal_operator'}/default`),
      review: receipt('household_review', `agentx-household/brain/${surface === 'family' ? 'family' : 'private'}`)
    },
    hostObservations: [{ hostUrl: host, ollamaConcurrency: { numParallel: 1, source: 'startup-log', observedAt: at(-2000) },
      live: { online: true, observedAt: at(-1000), modelParallelism: [{ model, requestSlots: 1, reason: 'architecture' }] } }] };
}

test.each(['nestor', 'family'])('diagnoses only qualified, recently observed %s consumers and publishes bounded facts', surface => {
  const f = fixture(surface);
  expect(diagnose(f)).toEqual({ surface, status: 'warning', reason: 'shared_sequential_model', ...target,
    voiceObservedAt: at(-1000), reviewObservedAt: at(-1000), hostObservedAt: at(-1000),
    slotsObservedAt: at(-2000), slotsSource: 'startup-log' });
  // Request detail and arbitrary native data never cross the diagnostic boundary.
  f.receipts.voice.messages = ['private content'];
  expect(JSON.stringify(diagnose(f))).not.toContain('private content');
  f.hostObservations[0].live.modelParallelism[0] = { model, requestSlots: null, reason: 'server_setting' };
  expect(diagnose(f).status).toBe('warning');
});

test.each([
  ['disabled reviewer', f => { f.enabled = false; }, 'inactive'],
  ['missing preference', f => { delete f.enabled; }, 'unknown'],
  ['unknown voice target', f => { f.targets.voice = null; }, 'unknown'],
  ['different configured model', f => { f.targets.review = { ...target, model: 'another:1b' }; }, 'separate'],
  ['different configured host', f => { f.targets.review = { ...target, host: 'http://other:11434' }; }, 'separate'],
  ['no receipts', f => { f.receipts = {}; }, 'unknown'],
  ['old voice receipt', f => { f.receipts.voice.timestamp = at(-WINDOW_MS - 1); }, 'unknown'],
  ['future review receipt', f => { f.receipts.review.timestamp = at(1); }, 'unknown'],
  ['failed voice request', f => { f.receipts.voice.status = 'error'; }, 'unknown'],
  ['unscoped caller detail', f => { delete f.receipts.voice.consumerContract; }, 'unknown'],
  ['declared native usage', f => { f.receipts.voice.source = 'declared-receipt'; }, 'unknown'],
  ['receipt for another surface', f => { f.receipts.review.callerDetail = 'agentx-household/brain/family'; }, 'unknown'],
  ['receipt for another task', f => { f.receipts.voice.taskType = 'general_chat'; }, 'unknown'],
  ['receipt for another model', f => { f.receipts.voice.model = 'another:1b'; }, 'unknown'],
  ['receipt for another host', f => { f.receipts.review.host = 'http://other:11434'; }, 'unknown'],
  ['receipt before route edit', f => { f.receipts.voice.routeDecision.configVersion = 'old'; }, 'unknown'],
  ['legacy receipt', f => { delete f.receipts.voice.routeDecision; }, 'unknown'],
  ['unattested consumer', f => { f.receipts.voice.routeDecision.attribution.consumerContract = 'other'; }, 'unknown'],
  ['offline host', f => { f.hostObservations[0].live.online = false; }, 'unknown'],
  ['old host read', f => { f.hostObservations[0].live.observedAt = at(-HOST_MAX_AGE_MS - 1); }, 'unknown'],
  ['missing parallelism', f => { delete f.hostObservations[0].live.modelParallelism; }, 'unknown'],
  ['no_completion default', f => { f.hostObservations[0].live.modelParallelism[0].reason = 'no_completion'; }, 'unknown'],
  ['contradictory slot metadata', f => { f.hostObservations[0].live.modelParallelism[0].requestSlots = 2; }, 'unknown'],
  ['architecture assumption only', f => { delete f.hostObservations[0].ollamaConcurrency; }, 'unknown'],
  ['multiple recorded slots', f => { f.hostObservations[0].ollamaConcurrency.numParallel = 2; }, 'unknown'],
  ['stale slot observation', f => { f.hostObservations[0].ollamaConcurrency.observedAt = at(-WINDOW_MS - 1); }, 'unknown'],
  ['future slot observation', f => { f.hostObservations[0].ollamaConcurrency.observedAt = at(1); }, 'unknown'],
  ['unknown slot source', f => { f.hostObservations[0].ollamaConcurrency.source = 'guess'; }, 'unknown']
])('%s never produces a contention warning', (_label, mutate, status) => {
  const f = fixture(); mutate(f);
  expect(diagnose(f).status).toBe(status);
});

test('canonical model tags and trailing host slashes compare without pooling different endpoints', () => {
  const f = fixture();
  f.targets.voice = { model: 'synthetic', host: host + '/' };
  f.targets.review = { model: 'synthetic:latest', host };
  f.receipts.voice.model = f.receipts.review.model = f.hostObservations[0].live.modelParallelism[0].model = 'synthetic';
  expect(diagnose(f).status).toBe('warning');
});

function targets(env = {}, routes = {}, fixedTask = () => true) {
  return configuredTargets({ env, routes: { voice_persona_chat: { model, host: 'voice' }, household_review: { model, host: 'voice' }, ...routes },
    hosts: { voice: host }, fixedTask });
}

test('resolves only simple fixed routes or an explicit reviewer model/host pair', () => {
  expect(targets({ HOUSEHOLD_BRAIN_TASK: 'household_review' })).toMatchObject({ voice: target, review: target });
  expect(targets({ HOUSEHOLD_BRAIN_MODEL: 'ollama/' + model, HOUSEHOLD_BRAIN_HOST_URL: host })).toMatchObject({ review: target });
  expect(targets({ HOUSEHOLD_BRAIN_HOST_URL: host }).review).toBeNull();
  expect(targets({ HOUSEHOLD_BRAIN_MODEL: model }).review).toBeNull();
  expect(targets({ HOUSEHOLD_VOICE_TASK: 'general_chat' }).voice).toBeNull();
  expect(targets({}, { voice_persona_chat: { role: 'main' } }).voice).toBeNull();
  expect(targets({}, {}, () => false).voice).toBeNull();
  // Routed review explicitly ignores the legacy direct overrides, like brain.js.
  expect(targets({ HOUSEHOLD_BRAIN_TASK: 'household_review', HOUSEHOLD_BRAIN_MODEL: 'ignored', HOUSEHOLD_BRAIN_HOST_URL: 'ignored' }).review).toEqual(target);
});

function readerFixture() {
  const rows = [fixture().receipts.voice, fixture().receipts.review, fixture('family').receipts.voice, fixture('family').receipts.review];
  const chains = [];
  const Log = { findOne: jest.fn(() => {
    const row = rows.shift();
    const chain = { sort: jest.fn(() => chain), select: jest.fn(() => chain), maxTimeMS: jest.fn(() => chain), lean: jest.fn(async () => row) };
    chains.push(chain); return chain;
  }) };
  const preferences = { forOwner: jest.fn(() => ({ read: async () => ({ values: { backgroundReview: true } }) })) };
  const routing = { ensureTaskModelOverridesLoaded: jest.fn(async () => {}), getRoutingConfigVersion: jest.fn(() => configVersion), HOSTS: { voice: host },
    getEffectiveTaskModels: () => ({ voice_persona_chat: { model, host: 'voice' }, household_review: { model, host: 'voice' } }) };
  return { Log, chains, preferences, routing, now, env: { HOUSEHOLD_BRAIN_TASK: 'household_review' }, fixedTask: () => true };
}

test('reader bounds and scopes its content-free queries and uses effective preferences', async () => {
  const f = readerFixture();
  const result = await readVoiceReviewContention(fixture().hostObservations, f);
  expect(result).toMatchObject({ windowMs: WINDOW_MS, checkedAt: at(0), surfaces: [ { status: 'warning' }, { status: 'warning' } ] });
  expect(f.Log.findOne).toHaveBeenCalledTimes(4);
  expect(f.Log.findOne.mock.calls[0][0]).toMatchObject({ source: 'core-observed', consumerContract: contract,
    status: 'success', timestamp: { $gte: new Date(now - WINDOW_MS), $lte: new Date(now) } });
  for (const chain of f.chains) {
    expect(chain.maxTimeMS).toHaveBeenCalledWith(1000);
    expect(chain.select.mock.calls[0][0]).not.toMatch(/messages|prompt|error/);
  }
  f.preferences.forOwner.mockImplementation(() => ({ read: async () => ({ values: { backgroundReview: false } }) }));
  f.Log.findOne.mockClear();
  expect((await readVoiceReviewContention([], f)).surfaces.map(row => row.status)).toEqual(['inactive', 'inactive']);
  expect(f.Log.findOne).not.toHaveBeenCalled();
});

test('failed reads and concurrently changed routing stay unknown without affecting the host read', async () => {
  const f = readerFixture();
  f.routing.getRoutingConfigVersion.mockReturnValueOnce(configVersion).mockReturnValue('changed');
  expect((await readVoiceReviewContention(fixture().hostObservations, f)).surfaces.every(row => row.reason === 'configuration_changed')).toBe(true);
  f.preferences.forOwner.mockImplementation(() => { throw new Error('private failure detail'); });
  const result = await readVoiceReviewContention([], f);
  expect(result.surfaces.every(row => row.status === 'unknown')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private failure detail');
});
