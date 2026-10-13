'use strict';
jest.mock('../../src/services/runtimeMutationLeaseService', () => ({ runRuntimeMutation: jest.fn() }));
jest.mock('../../src/services/modelRouterConfig', () => {
  const tasks = { daily_operator: { model: 'standard', host: 'primary' }, general_chat: { model: 'standard', host: 'primary' },
    code_generation: { model: 'specialist', host: 'secondary' }, voice_persona_reader: { model: 'standard', host: 'primary' },
    embeddings: { model: 'embedding', host: 'primary' } };
  return { CLASSIFIABLE_TASKS: { general_chat: {}, code_generation: {} }, HOSTS: { primary: 'http://principal-host:11434' },
    ensureTaskModelOverridesLoaded: jest.fn(), getDefaultTaskModels: () => ({ daily_operator: { model: 'standard', host: 'primary' } }),
    getEffectiveTaskModels: () => tasks, tasks };
});
const HostPreference = require('../../models/HostPreference');
const RouterTaskConfig = require('../../models/RouterTaskConfig');
const prefs = require('../../src/services/hostPreferenceService');
const config = require('../../src/services/modelRouterConfig');
const { runRuntimeMutation } = require('../../src/services/runtimeMutationLeaseService');
const service = require('../../src/services/principalModelService');
const hostUrl = 'http://principal-host:11434';
let restore;

beforeEach(async () => {
  config.tasks.daily_operator.model = config.tasks.general_chat.model = 'standard';
  config.ensureTaskModelOverridesLoaded.mockImplementation(async () => {
    for (const doc of await RouterTaskConfig.find({}).lean()) config.tasks[doc.taskType] = { model: doc.model, host: doc.host };
  });
  runRuntimeMutation.mockImplementation(async (_options, operation) => operation({
    signal: new AbortController().signal, assertActive() {}
  }));
  await HostPreference.create({ hostUrl, hostKey: 'primary', maxConcurrentModels: 2, pinnedModels: [
    { model: 'standard', contextSize: 196608, keepAlive: -1, autoRestore: true },
    { model: 'embedding', contextSize: 8192, keepAlive: -1, autoRestore: true }
  ] });
  restore = jest.spyOn(prefs, 'restorePinnedModels').mockResolvedValue({ verified: true, status: 'ready' });
});
afterEach(async () => { jest.restoreAllMocks(); await Promise.all([HostPreference.deleteMany({}), RouterTaskConfig.deleteMany({})]); });
const select = () => service.selectPrincipalModel({ selected: 'abliterated', expectedModel: 'standard', principal: 'test-operator' });

test('switch preserves sibling pins/context and dedicated routes, and survives a fresh read', async () => {
  const result = await select();
  expect(result.selected).toBe('abliterated');
  expect(result.contextSize).toBe(196608);
  expect(result.pinnedModels[1]).toMatchObject({ model: 'embedding', contextSize: 8192 });
  expect(config.tasks.general_chat.model).toBe(result.model);
  expect(config.tasks.voice_persona_reader.model).toBe('standard');
  expect(config.tasks.code_generation.model).toBe('specialist');
  expect((await service.getPrincipalModel()).model).toBe(result.model);
  await service.selectPrincipalModel({ selected: 'standard', expectedModel: result.model, principal: 'test-operator' });
  expect((await service.getPrincipalModel()).selected).toBe('standard');
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
test('ambiguous persistence never launches a replacement or rollback', async () => {
  jest.spyOn(RouterTaskConfig, 'bulkWrite').mockRejectedValueOnce(new Error('lost acknowledgment'));
  await expect(select()).rejects.toThrow('lost acknowledgment');
  expect(restore).toHaveBeenCalledTimes(1);
  expect((await service.getPrincipalModel()).selected).toBe('abliterated');
});
