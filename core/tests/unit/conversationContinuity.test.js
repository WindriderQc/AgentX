'use strict';

const { createConversationContinuity, parse } = require('../../src/services/routing/conversationContinuity');
const { describe: describeWork } = require('../../src/services/routing/conversationContinuityStatus');
const { reducedRequest } = require('../../src/services/routing/conversationContinuityContext');
const { boundedRead } = require('../../src/services/routing/conversationContinuityStatus');
const PRIMARY = 'http://127.0.0.1:11434';
const BACKUP = 'http://127.0.0.2:11434';
const CPU = 'http://127.0.0.3:11435';
const request = () => ({ model: 'agentx-primary', mode: 'chat', tools: [{ type: 'function' }],
  options: { num_ctx: 999999, num_predict: -1 }, messages: [{ role: 'system', content: 'Original full memory/tool envelope' },
    { role: 'assistant', content: 'Earlier reply' }, { role: 'user', content: 'Quel travail utilise le cerveau principal ?' }] });
const busy = () => Object.assign(new Error('busy'), { code: 'BENCHMARK_CLAIM_ACTIVE',
  failure: { safeToRetry: true, holder: { type: 'workload', kind: 'benchmark' } } });
const response = model => ({ ok: true, status: 200, body: { model, message: { content: 'Réponse limitée' }, done: true },
  metadata: { model, options: { num_ctx: model === 'primary' ? 196608 : 32768 } } });

function world({ role = false, raw, execute, readWork } = {}) {
  const snapshot = { hosts: { primary: PRIMARY, backup: BACKUP, cpu: CPU }, tasks: { daily_operator: {
    model: 'primary', hostUrl: PRIMARY, hostKey: 'primary', pinAligned: true, contextSize: 196608
  } } };
  if (role) snapshot.principalTopology = { ...snapshot.tasks.daily_operator,
    topology: { role: 'pooled', laneContext: 196608, mode: 'pooled', group: 'test' } };
  const deps = { hostPreferenceService: { getByHost: jest.fn(async () => ({
    pinnedModels: [{ model: 'small', contextSize: 32768, numThread: 6 }] })) },
    modelsMatch: (a, b) => a === b, assertHostAvailableForConsumer: jest.fn(async () => null),
    fetch: jest.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'small', context_length: 32768 }] }) })) };
  const run = execute || jest.fn(async input => { if (input.model === 'primary') throw busy(); return response(input.model); });
  const readSnapshot = jest.fn(async () => snapshot);
  const policy = raw === undefined ? JSON.stringify({ hosts: ['backup', 'cpu'], maxOutputTokens: 128 }) : raw;
  const service = createConversationContinuity({ execute: run, readSnapshot, deps, readWork: readWork || (async () => null),
    readPolicy: () => policy, log: { warn: jest.fn() } });
  return { service, deps, run, snapshot, readSnapshot };
}

describe('local conversation continuity', () => {
  it.each(['', '{', '{}', '{"hosts":["https://cloud.test"]}', '{"hosts":["backup"],"models":["openrouter/free"]}',
    '{"hosts":["backup"],"maxOutputTokens":-1}', '{"hosts":["backup"],"typo":true}'])('retains strict routing for absent/invalid policy %s', async raw => {
    const w = world({ raw });
    expect(await w.service(request())).toBeNull();
    expect(w.run).not.toHaveBeenCalled();
    expect(w.readSnapshot).not.toHaveBeenCalled();
  });

  it('uses a healthy principal with its complete request and pin contract', async () => {
    const run = jest.fn(async () => response('primary'));
    const w = world({ role: true, execute: run });
    const input = request();
    expect((await w.service(input)).body.model).toBe('primary');
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ messages: input.messages, tools: input.tools,
      model: 'primary', options: { num_ctx: 196608, num_predict: -1 } }), expect.objectContaining({
      hostUrl: PRIMARY, topology: w.snapshot.principalTopology.topology, retry: { enabled: false }
    }));
    expect(w.deps.fetch).not.toHaveBeenCalled();
  });

  it('supplies an explicitly limited local reply and verified work state', async () => {
    const w = world({ readWork: async () => ({ jobs: [
      { state: 'running', title: 'Synthetic benchmark', hosts: [PRIMARY] },
      { state: 'requested', title: 'Only planned', hosts: [PRIMARY] },
      { state: 'running', title: 'Unrelated', hosts: [CPU] }
    ] }) });
    const input = request();
    const result = await w.service(input);
    expect(result.body.message.content).toContain('mode de secours local');
    expect(result.body.message.content).toContain('Synthetic benchmark');
    expect(result.body.message.content).not.toContain('Only planned');
    expect(result.body.message.content).not.toContain('Unrelated');
    const [backup, options] = w.run.mock.calls[1];
    expect(backup).not.toHaveProperty('tools');
    expect(backup).toMatchObject({ model: 'small', think: false, exclusiveHost: false,
      options: { num_ctx: 32768, num_predict: 128 } });
    expect(backup.messages[0].content).toContain('aucun outil');
    expect(JSON.stringify(backup)).not.toContain('Original full memory/tool envelope');
    expect(options).toMatchObject({ hostUrl: BACKUP, conversationContinuity: { state: 'backup', limited: true,
      lane: { laneContext: 32768 } } });
    expect(request()).toEqual(input);
  });

  it.each(['none_active', 'transitional', 'conflict'])('supports a topology principal with %s and returns automatically on the next turn', async reason => {
    const w = world({ role: true });
    const principal = w.snapshot.principalTopology;
    w.snapshot.principalTopology = { model: null, topology: { role: 'conversation', reason } };
    expect((await w.service(request())).metadata.conversationContinuity.reason).toBe('topology_' + reason);
    expect(w.run).toHaveBeenCalledTimes(1);
    w.snapshot.principalTopology = principal;
    w.run.mockResolvedValueOnce(response('primary'));
    expect((await w.service(request())).body.model).toBe('primary');
  });

  it('skips claimed, nonresident and context-mismatched backup pins without loading anything', async () => {
    const w = world();
    w.deps.assertHostAvailableForConsumer.mockRejectedValueOnce(busy());
    w.deps.fetch.mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'small', context_length: 8192 }] }) });
    const result = await w.service(request());
    expect(result.metadata.conversationContinuity.state).toBe('status_only');
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(w.deps.fetch).toHaveBeenCalledTimes(1);
    expect(w.deps.fetch.mock.calls[0][0]).toBe(CPU + '/api/ps');
  });

  it('rejects cloud/unknown backup endpoints and unpinned endpoints', async () => {
    const w = world();
    w.snapshot.hosts.backup = 'https://openrouter.ai';
    w.deps.hostPreferenceService.getByHost.mockResolvedValue({ pinnedModels: [] });
    expect((await w.service(request())).metadata.model).toBe('agentx-status');
    expect(w.deps.fetch).not.toHaveBeenCalled();
    expect(w.run).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate a host listed under several keys', async () => {
    const w = world();
    w.snapshot.hosts.cpu = BACKUP;
    w.deps.fetch.mockResolvedValue({ ok: false });
    await w.service(request());
    expect(w.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('tries the next resident backup only after a refusal proven before dispatch', async () => {
    const w = world();
    w.run.mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValueOnce(response('small'));
    expect((await w.service(request())).metadata.conversationContinuity.state).toBe('backup');
    expect(w.run.mock.calls[2][1].hostUrl).toBe(CPU);
  });

  it.each(['INFERENCE_TIMEOUT', 'INFERENCE_UPSTREAM_ERROR', 'LANE_CONTEXT_EXCEEDED', 'HOST_PIN_MISMATCH'])('never moves a primary call with %s', async code => {
    const run = jest.fn(async () => { throw Object.assign(new Error('uncertain or context refusal'), { code }); });
    const w = world({ execute: run });
    await expect(w.service(request())).rejects.toMatchObject({ code });
    expect(run).toHaveBeenCalledTimes(1);
    expect(w.deps.fetch).not.toHaveBeenCalled();
  });

  it('never replays an uncertain backup call', async () => {
    const w = world();
    w.run.mockRejectedValueOnce(busy()).mockRejectedValueOnce(Object.assign(new Error('unknown'), { code: 'INFERENCE_TIMEOUT' }));
    await expect(w.service(request())).rejects.toMatchObject({ code: 'INFERENCE_TIMEOUT' });
    expect(w.run).toHaveBeenCalledTimes(2);
    expect(w.deps.fetch).toHaveBeenCalledTimes(1);
  });

  it('treats a lost/invalid native result as uncertain rather than returning to strict routing for a duplicate call', async () => {
    const w = world({ execute: jest.fn(async () => null) });
    await expect(w.service(request())).rejects.toMatchObject({ code: 'INFERENCE_UPSTREAM_UNAVAILABLE' });
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(w.deps.fetch).not.toHaveBeenCalled();
  });

  it('keeps user cancellation terminal before any probe or dispatch', async () => {
    const w = world();
    const controller = new AbortController(); controller.abort();
    await expect(w.service(request(), { signal: controller.signal })).rejects.toBeDefined();
    expect(w.run).not.toHaveBeenCalled();
  });

  it('keeps a model-free response when routing or work evidence cannot be read', async () => {
    const w = world();
    w.readSnapshot.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await w.service(request());
    expect(result.metadata.conversationContinuity.state).toBe('status_only');
    expect(result.body.message.content).toContain('ne peut pas vérifier');
    expect(w.run).not.toHaveBeenCalled();
  });

  it('does not truncate the current user turn or continue a pending tool loop on the backup', async () => {
    for (const messages of [[{ role: 'user', content: 'x'.repeat(13000) }],
      [{ role: 'user', content: 'hello' }, { role: 'tool', content: 'an existing action result' }]]) {
      const w = world();
      const result = await w.service({ ...request(), messages });
      expect(result.metadata.conversationContinuity.reason).toBe('backup_context_unavailable');
      expect(w.run).toHaveBeenCalledTimes(1);
    }
  });

  it('does not opt cron, embeddings, arbitrary models or reserved coding/Benchmark requests into continuity', async () => {
    const w = world();
    for (const [input, options] of [[{ ...request(), mode: 'embed' }, {}], [{ ...request(), model: 'other' }, {}],
      [request(), { benchmarkClaims: [] }], [request(), { codingCapacity: {} }]]) expect(await w.service(input, options)).toBeNull();
    expect(w.run).not.toHaveBeenCalled();
  });
});

it('a Generate request keeps its full current prompt and drops the original action envelope', () => {
  const reduced = reducedRequest({ mode: 'generate', prompt: 'bonjour', system: 'old actions', tools: [{}] },
    { model: 'small', contextSize: 32768, maxOutputTokens: 128, maxInputChars: 2048, status: 'Synthetic status' });
  expect(reduced.prompt).toBe('bonjour');
  expect(reduced.system).toContain('Synthetic status');
  expect(reduced.system).not.toContain('old actions');
  expect(reduced).not.toHaveProperty('tools');
  expect(parse('{"hosts":["backup"]}').maxOutputTokens).toBe(384);
});

it('does not describe an old or planned reservation as running or invent an ETA', () => {
  const text = describeWork(busy(), [PRIMARY], { jobs: [{ title: 'planned', state: 'reserved', hosts: [PRIMARY] }] });
  expect(text).not.toContain('planned');
  expect(text).toContain('heure de disponibilité n’est pas connue');
});

it('bounds unavailable status evidence and releases its timer and abort listener', async () => {
  const controller = new AbortController();
  expect(await boundedRead(() => new Promise(() => {}), 10, controller.signal)).toBeNull();
  const pending = boundedRead(() => new Promise(() => {}), 1000, controller.signal);
  controller.abort(new Error('human cancelled'));
  await expect(pending).rejects.toThrow('human cancelled');
});
