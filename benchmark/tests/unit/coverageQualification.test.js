'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const { validateIntent, assertFrozenBatch } = require('../../src/services/measurementCoverage/coverageQualification');
const { SCORER_VERSION } = require('../../src/services/scoring/scorerVersion');
const cell = { hostId: 'fixture-a', hostUrl: 'http://127.0.0.1:11434', model: 'fixture:model', next: 'benchmark',
  pinContext: 131072, residency: 'gpu', artifact: { digest: 'candidate-artifact', runtimeFingerprint: 'candidate-runtime' },
  missingPromptIds: ['p1', 'p2'] };
const judge = { host: 'http://127.0.0.1:11435', model: 'fixture:judge', execution_contract: {
  num_ctx: 32768, artifact: { digest: 'judge-artifact', runtimeFingerprint: 'judge-runtime' }
} };
const intent = { kind: 'benchmark', cell, scorerVersion: SCORER_VERSION, promptVersions: [['p1', 'version-1']],
  body: { prompt_ids: ['p1'], execution_config: { think: false }, judge_config: judge } };
const deps = overrides => ({
  buildCoverage: async () => ({ cells: [cell] }),
  loadCatalogPrompts: async () => new Map([['version-1', { id: 'p1' }], ['version-2', { id: 'p2' }]]),
  findContextProfile: async () => ({ maxVerifiedContext: 131072 }),
  resolveJudge: async () => ({ ready: true, target: judge }),
  freezeJudgeConfig: async config => config, ...overrides
});

it('keeps a valid original selection and its native judge settings', async () => {
  await expect(validateIntent(intent, deps())).resolves.toEqual(cell);
});

it.each([
  ['out of scope', { buildCoverage: async () => ({ cells: [] }) }],
  ['artifact', { buildCoverage: async () => ({ cells: [{ ...cell, artifact: { digest: 'new' } }] }) }],
  ['pin context', { buildCoverage: async () => ({ cells: [{ ...cell, pinContext: 32768 }] }) }],
  ['prompt version', { loadCatalogPrompts: async () => new Map([['edited-version', { id: 'p1' }]]) }],
  ['already graded prompt', { buildCoverage: async () => ({ cells: [{ ...cell, missingPromptIds: ['p2'] }] }) }],
  ['verified execution context', { findContextProfile: async () => ({ maxVerifiedContext: 65536 }) }],
  ['judge unavailable', { resolveJudge: async () => ({ ready: false }) }],
  ['foreign judge', { resolveJudge: async () => ({ ready: true, target: { ...judge, host: 'http://127.0.0.1:11436' } }) }],
  ['judge artifact/runtime', { freezeJudgeConfig: async config => ({ ...config, execution_contract: { ...config.execution_contract, artifact: { digest: 'changed' } } }) }]
])('proves refusal before effect for changed %s', async (_name, overrides) => {
  await expect(validateIntent(intent, deps(overrides))).rejects.toMatchObject({ code: 'COVERAGE_INTENT_CHANGED', notStarted: true });
});

it('a changed scorer cannot reuse an earlier frozen coverage intent', async () => {
  await expect(validateIntent({ ...intent, scorerVersion: 'previous' }, deps())).rejects.toMatchObject({ notStarted: true });
});

it('rechecks the actual frozen judge and sampled prompt proof after native preparation', async () => {
  const dependencies = { attempts: { get: async () => ({ nativeDispatchedAt: new Date(), intent }) }, fingerprint: () => 'version-1' };
  await expect(assertFrozenBatch('intent', judge, [{ _id: 'p1' }], dependencies)).resolves.toBeUndefined();
  await expect(assertFrozenBatch('intent', { execution_contract: { num_ctx: 1234 } }, [{ _id: 'p1' }], dependencies))
    .rejects.toMatchObject({ code: 'COVERAGE_PROOF_CHANGED' });
  await expect(assertFrozenBatch('intent', judge, [{ _id: 'p2' }], dependencies)).rejects.toMatchObject({ code: 'COVERAGE_PROOF_CHANGED' });
});
