'use strict';
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({ runRuntimeMutation: jest.fn() }));
jest.mock('../../src/services/modelRouterConfig', () => {
  const tasks = { daily_operator: { model: 'standard', host: 'primary' }, general_chat: { model: 'standard', host: 'primary' },
    code_generation: { model: 'specialist', host: 'secondary' }, voice_persona_reader: { model: 'standard', host: 'primary' },
    embeddings: { model: 'embedding', host: 'primary' } };
  return { CLASSIFIABLE_TASKS: { general_chat: {}, code_generation: {} }, HOSTS: { primary: 'http://principal-host:11434' },
    ensureTaskModelOverridesLoaded: jest.fn(), getDefaultTaskModels: () => ({ daily_operator: { model: 'standard', host: 'primary' } }),
    getEffectiveTaskModels: () => tasks, getHostPinFollowers: jest.fn(() => []), refreshPinCacheNow: jest.fn(async () => {}), tasks };
});
const HostPreference = require('../../models/HostPreference');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const PrincipalModelChoices = require('../../models/PrincipalModelChoices');
const prefs = require('../../src/services/hostPreferenceService');
const config = require('../../src/services/modelRouterConfig');
const { runRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');
const service = require('../../src/services/principalModelService');
const hostUrl = 'http://principal-host:11434';
let restore;

beforeEach(async () => {
  config.tasks.daily_operator.model = config.tasks.general_chat.model = config.tasks.voice_persona_reader.model = 'standard';
  delete config.tasks.nestor_answer_light;
  config.ensureTaskModelOverridesLoaded.mockImplementation(async () => {
    for (const doc of await RouterTaskConfig.find({}).lean()) config.tasks[doc.taskType] = { model: doc.model, host: doc.host };
  });
  config.getHostPinFollowers.mockReturnValue([]);
  config.refreshPinCacheNow.mockImplementation(async () => {});
  runRuntimeMutation.mockImplementation(async (_options, operation) => operation({
    signal: new AbortController().signal, assertActive() {}
  }));
  await PrincipalModelChoices.create({ standard: 'standard', abliterated: 'permissive', revision: 3, source: 'operator' });
  await HostPreference.create({ hostUrl, hostKey: 'primary', maxConcurrentModels: 2, pinnedModels: [
    { model: 'standard', contextSize: 196608, keepAlive: -1, autoRestore: true },
    { model: 'embedding', contextSize: 8192, keepAlive: -1, autoRestore: true }
  ] });
  restore = jest.spyOn(prefs, 'restorePinnedModels').mockResolvedValue({ verified: true, status: 'ready' });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all([HostPreference.deleteMany({}), RouterTaskConfig.deleteMany({}), PrincipalModelChoices.deleteMany({})]);
});
const select = () => service.selectPrincipalModel({ selected: 'abliterated', expectedModel: 'standard', principal: 'test-operator' });

test('switch preserves sibling pins/context, moves every principal route on the host, and survives a fresh read', async () => {
  const result = await select();
  expect(result.selected).toBe('abliterated');
  expect(result.contextSize).toBe(196608);
  expect(result.pinnedModels[1]).toMatchObject({ model: 'embedding', contextSize: 8192 });
  expect(config.tasks.general_chat.model).toBe(result.model);
  expect(config.tasks.voice_persona_reader.model).toBe(result.model);
  expect(config.tasks.code_generation.model).toBe('specialist');
  expect((await service.getPrincipalModel()).model).toBe(result.model);
  await service.selectPrincipalModel({ selected: 'standard', expectedModel: result.model, principal: 'test-operator' });
  expect((await service.getPrincipalModel()).selected).toBe('standard');
});
test('a route that follows the host pin moves with it and gets no stored route', async () => {
  config.getHostPinFollowers.mockReturnValue(['voice_persona_reader']);
  config.refreshPinCacheNow.mockImplementation(async () => {
    const pref = await HostPreference.findOne({ hostUrl }).lean();
    config.tasks.voice_persona_reader.model = pref.pinnedModels[0].model;
  });
  const result = await select();
  expect(config.tasks.voice_persona_reader.model).toBe(result.model);
  expect(config.tasks.general_chat.model).toBe(result.model);
  expect(await RouterTaskConfig.findOne({ taskType: 'voice_persona_reader' })).toBeNull();
  expect(await RouterTaskConfig.findOne({ taskType: 'general_chat' })).not.toBeNull();
});
test('busy admission and stale UI selection perform no pin or route writes', async () => {
  runRuntimeMutation.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'RUNTIME_MUTATION_LEASE_DENIED' }));
  await expect(select()).rejects.toMatchObject({ code: 'RUNTIME_MUTATION_LEASE_DENIED' });
  await expect(service.selectPrincipalModel({ selected: 'abliterated', expectedModel: 'stale' })).rejects.toMatchObject({ code: 'HOST_PIN_CONFLICT' });
  expect((await service.getPrincipalModel()).model).toBe('standard');
  expect(await RouterTaskConfig.countDocuments()).toBe(0);
  expect(restore).not.toHaveBeenCalled();
});
test('known residency failure verifies the original pins before reporting the rejected switch', async () => {
  restore.mockResolvedValueOnce({ verified: false, error: 'does not fit' });
  await expect(select()).rejects.toMatchObject({ code: 'HOST_PIN_RESTORE_FAILED', rollback: 'verified' });
  expect(restore).toHaveBeenCalledTimes(2);
  expect((await service.getPrincipalModel()).model).toBe('standard');
  expect(config.tasks.general_chat.model).toBe('standard');
});
test('an active Open hold refuses before changing pins and does not attempt restoration', async () => {
  await HostPreference.updateOne({ hostUrl }, { $set: { sessionHold: {
    holdId: 'original-open', owner: 'household/open', model: 'standard',
    acquiredAt: new Date(), lastActivityAt: new Date(), expiresAt: new Date(Date.now() + 60000), idleTtlMs: 60000
  } } });
  await expect(select()).rejects.toMatchObject({ code: 'PRINCIPAL_HOST_BUSY' });
  expect((await service.getPrincipalModel()).model).toBe('standard');
  expect(restore).not.toHaveBeenCalled();
});
test('a Benchmark workload sharing the principal host refuses before changing pins', async () => {
  const RuntimeCoordination = require('../../models/RuntimeCoordination');
  await RuntimeCoordination.updateOne({ _id: 'runtime' }, { $set: { workloads: [{
    admissionId: 'judge-batch', generation: 'g1', principal: 'benchmark-service', requestId: 'benchmark:b1',
    workloadId: 'b1', kind: 'benchmark', hosts: [hostUrl], sharedHosts: [hostUrl], acquiredAt: new Date(),
    heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000)
  }] } }, { upsert: true });
  try {
    await expect(select()).rejects.toMatchObject({ code: 'PRINCIPAL_HOST_BUSY' });
    expect((await service.getPrincipalModel()).model).toBe('standard');
    expect(restore).not.toHaveBeenCalled();
  } finally {
    await RuntimeCoordination.deleteMany({});
  }
});
test('ambiguous persistence never launches a replacement or rollback', async () => {
  jest.spyOn(RouterTaskConfig, 'bulkWrite').mockRejectedValueOnce(new Error('lost acknowledgment'));
  await expect(select()).rejects.toThrow('lost acknowledgment');
  expect(restore).toHaveBeenCalledTimes(1);
  expect((await service.getPrincipalModel()).selected).toBe('abliterated');
});
test('a route on the principal host naming an unpinned model blocks the switch and is shown', async () => {
  config.tasks.nestor_answer_light = { model: 'stale', host: 'primary' };
  expect((await service.getPrincipalModel()).divergentRoutes).toEqual(['nestor_answer_light']);
  await expect(select()).rejects.toMatchObject({ code: 'PRINCIPAL_ROUTES_DIVERGE' });
  expect((await service.getPrincipalModel()).model).toBe('standard');
  expect(restore).not.toHaveBeenCalled();
});

describe('choices named in the Nerve Center (#901)', () => {
  const installed = async () => ['standard', 'permissive', 'other-model:27b'];
  const save = (option, model, extra = {}) => service.saveChoice({ option, model, expectedRevision: 3,
    expectedModel: 'standard', principal: 'test-operator', ...extra }, { listInstalledModels: installed });

  test('the switch offers the stored models and reports their revision', async () => {
    const principal = await service.getPrincipalModel();
    expect(principal.options).toEqual([
      { value: 'standard', label: 'Standard', model: 'standard' },
      { value: 'abliterated', label: 'Abliterated', model: 'permissive' }
    ]);
    expect(principal).toMatchObject({ selected: 'standard', available: true, choicesRevision: 3 });
  });

  test('naming the option not in use stores it without touching the pin', async () => {
    const result = await save('abliterated', 'other-model:27b');
    expect(result.options[1].model).toBe('other-model:27b');
    expect(result).toMatchObject({ model: 'standard', choicesRevision: 4 });
    expect(restore).not.toHaveBeenCalled();
    expect(await RouterTaskConfig.countDocuments()).toBe(0);
  });

  test('renaming the option in use moves the pin and its routes, then stores the name', async () => {
    const result = await save('standard', 'other-model:27b');
    expect(result).toMatchObject({ selected: 'standard', model: 'other-model:27b', choicesRevision: 4 });
    expect(config.tasks.general_chat.model).toBe('other-model:27b');
    expect(restore).toHaveBeenCalledTimes(1);
  });

  test('a failed load keeps the old pin, routes and name', async () => {
    restore.mockResolvedValueOnce({ verified: false, error: 'does not fit' });
    await expect(save('standard', 'other-model:27b')).rejects.toMatchObject({ code: 'HOST_PIN_RESTORE_FAILED', rollback: 'verified' });
    const principal = await service.getPrincipalModel();
    expect(principal).toMatchObject({ model: 'standard', choicesRevision: 3 });
    expect(principal.options[0].model).toBe('standard');
  });

  test('refuses a stale revision, a duplicate, an uninstalled model and an unreachable host', async () => {
    await expect(save('abliterated', 'other-model:27b', { expectedRevision: 2 })).rejects.toMatchObject({ code: 'PRINCIPAL_CHOICES_CHANGED' });
    await expect(save('abliterated', 'standard')).rejects.toMatchObject({ code: 'PRINCIPAL_CHOICES_DUPLICATE' });
    await expect(save('abliterated', 'missing:7b')).rejects.toMatchObject({ code: 'PRINCIPAL_MODEL_NOT_INSTALLED' });
    await expect(service.saveChoice({ option: 'abliterated', model: 'other-model:27b', expectedRevision: 3 },
      { listInstalledModels: async () => [] })).rejects.toMatchObject({ code: 'PRINCIPAL_HOST_UNREACHABLE', statusCode: 503 });
    await expect(save('other', 'other-model:27b')).rejects.toMatchObject({ code: 'PRINCIPAL_MODEL_INVALID', statusCode: 400 });
    expect((await service.getPrincipalModel()).choicesRevision).toBe(3);
  });

  test('a fresh install shows both options unset and refuses the switch until one is named', async () => {
    await PrincipalModelChoices.deleteMany({});
    const saved = { ...process.env };
    for (const key of ['AGENTX_DAILY_OPERATOR_MODEL', 'AGENTX_DAILY_MODEL', 'AGENTX_DEFAULT_CHAT_MODEL', 'AGENTX_CHAT_MODEL',
      'OLLAMA_MODEL', 'HOUSEHOLD_PERMISSIVE_PRIMARY_MODEL']) delete process.env[key];
    try {
      const principal = await service.getPrincipalModel();
      expect(principal.options.map(option => option.model)).toEqual([null, null]);
      expect(principal).toMatchObject({ selected: null, available: false, choicesSource: 'migrated' });
      await expect(service.selectPrincipalModel({ selected: 'abliterated', expectedModel: 'standard' }))
        .rejects.toMatchObject({ code: 'PRINCIPAL_CHOICE_UNSET' });
      // The pin already loaded can be named as Standard, which turns the switch on.
      const named = await service.saveChoice({ option: 'standard', model: 'standard', expectedRevision: 0 },
        { listInstalledModels: installed });
      expect(named).toMatchObject({ selected: 'standard', choicesRevision: 1 });
      expect(restore).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });
});
