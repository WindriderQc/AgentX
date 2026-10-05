jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  resolvePinnedRuntimeOptions: jest.fn()
}));

const hostPreferenceService = require('../../src/services/hostPreferenceService');
const {
  prepareInferenceRuntime,
  applyContractOutputLimit,
  resolveEmbeddingKeepAlive
} = require('../../src/services/inferenceRuntimePolicy');

describe('inferenceRuntimePolicy', () => {
  beforeEach(() => jest.clearAllMocks());

  test('enforces the contract output reserve on routed traffic', () => {
    const options = {};
    const inferenceContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };

    applyContractOutputLimit({ routed: true, options, inferenceContract });

    expect(options.num_predict).toBe(4096);
    expect(inferenceContract.contextBudget.enforcement).toBe('ollama_num_predict');
  });

  test('preserves explicit caller limits and direct-lane control', () => {
    const explicitOptions = { num_predict: 777 };
    const explicitContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };
    applyContractOutputLimit({ routed: true, options: explicitOptions, inferenceContract: explicitContract });
    expect(explicitOptions.num_predict).toBe(777);
    expect(explicitContract.contextBudget.enforcement).toBe('caller_num_predict');

    const directOptions = {};
    const directContract = {
      contextBudget: { output: { reservedTokens: 4096 }, enforcement: 'report_only' }
    };
    applyContractOutputLimit({ routed: false, options: directOptions, inferenceContract: directContract });
    expect(directOptions.num_predict).toBeUndefined();
    expect(directContract.contextBudget.enforcement).toBe('report_only');
  });

  test('reads embedding residency from the matching app-managed pin', async () => {
    const pref = { pinnedModels: [{ model: 'nomic-embed-text:v1.5', keepAlive: -1 }] };
    hostPreferenceService.getByHost.mockResolvedValue(pref);
    hostPreferenceService.resolvePinnedRuntimeOptions.mockReturnValue({ keepAlive: -1 });

    await expect(resolveEmbeddingKeepAlive('http://secondary:11434', 'nomic-embed-text:v1.5'))
      .resolves.toBe(-1);
  });

  test('fails open when app configuration cannot be read', async () => {
    hostPreferenceService.getByHost.mockRejectedValue(new Error('mongo unavailable'));

    await expect(resolveEmbeddingKeepAlive('http://secondary:11434', 'nomic-embed-text:v1.5'))
      .resolves.toBeUndefined();
  });
});

describe('caller runtime compatibility', () => {
  const primitives = require('../../src/services/hostPinPrimitives');
  const preference = { pinnedModels: [{ model: 'example:latest', contextSize: 8192, keepAlive: -1 }] };
  const makeDeps = () => ({
    hostPreferenceService: {
      ...primitives,
      getByHost: jest.fn(async () => preference),
    },
    resolveInferenceContract: jest.fn(async () => ({ contextBudget: { output: { reservedTokens: 512 } } })),
    resolveThinkingPolicy: jest.fn(() => ({ think: false, mode: 'off', source: 'test' })),
  });

  test.each([
    ['generate', 'example:latest', -1, 8192, 512, false],
    ['generate', 'example', 0, undefined, 512, false],
    ['direct', 'example:latest', 0, undefined, undefined, false],
    ['chat', 'example', 0, 8192, undefined, false],
    ['extension', 'example', -1, 8192, 512, true],
    ['embed', 'example', -1, 8192, undefined, true],
  ])('%s preserves pin matching, caller residency, output and thinking for %s', async (
    policy, model, keepAlive, numCtx, numPredict, think
  ) => {
    const deps = makeDeps();
    const input = { model, host: 'http://ollama.test:11434', options: {}, keepAlive: 0, think: true };
    const result = await prepareInferenceRuntime(input, policy, deps);
    expect(result.keepAlive).toBe(keepAlive);
    expect(result.options.num_ctx).toBe(numCtx);
    expect(result.options.num_predict).toBe(numPredict);
    expect(result.think).toBe(think);
    expect(input.options).toEqual({});
    if (policy === 'direct') expect(deps.hostPreferenceService.getByHost).not.toHaveBeenCalled();
  });

  test.each(['generate', 'direct', 'chat', 'extension', 'embed'])('%s keeps exact caller context and output limits', async policy => {
    const deps = makeDeps();
    const options = { num_ctx: 2048, num_predict: 13, temperature: 0 };
    const result = await prepareInferenceRuntime({ model: 'example:latest', options }, policy, deps);
    expect(result.options).toEqual(options);
    expect(result.numCtxSource).toBe('caller');
  });

  test.each(['generate', 'chat', 'extension', 'embed'])('%s runs a CPU pin at its pinned threads, so the runner is not reloaded', async policy => {
    const deps = makeDeps();
    deps.hostPreferenceService.getByHost = jest.fn(async () => ({
      pinnedModels: [{ model: 'example:latest', contextSize: 8192, keepAlive: -1, numThread: 6 }]
    }));
    const pinned = await prepareInferenceRuntime({ model: 'example:latest', host: 'http://ollama.test:11435', options: {} }, policy, deps);
    expect(pinned.options).toEqual(expect.objectContaining({ num_ctx: 8192, num_thread: 6 }));
    const caller = await prepareInferenceRuntime({ model: 'example:latest', host: 'http://ollama.test:11435', options: { num_thread: 2 } }, policy, deps);
    expect(caller.options.num_thread).toBe(2);
  });

  test.each(['chat', 'extension', 'direct'])('%s passes native tool schemas to context accounting', async policy => {
    const deps = makeDeps();
    const tools = [{ type: 'function', function: { name: 'read', description: 'Full schema' } }];
    await prepareInferenceRuntime({ model: 'example:latest', tools,
      messages: [{ role: 'user', content: 'hello' }], options: { num_ctx: 2048 } }, policy, deps);
    expect(deps.resolveInferenceContract).toHaveBeenCalledWith(expect.objectContaining({ tools }));
  });
});

describe('runner option parity across inference, probes and warm-up', () => {
  const primitives =
    require('../../src/services/hostPinPrimitives');
  const { probePayload } = require('../../src/services/watchdogRuntimePayload');
  const { withContextRefusal } = require('../../src/services/routing/contextIntegrityPolicy');

  const model = 'example:latest';
  const preference = {
    pinnedModels: [{ model, contextSize: 8192, keepAlive: -1, numThread: 6 }]
  };
  const runnerMode = payload => ({
    num_ctx: payload.options?.num_ctx,
    num_thread: payload.options?.num_thread,
    truncate: payload.truncate,
    shift: payload.shift
  });

  test('pinned CPU model keeps identical runner mode on every path', async () => {
    const prepared = await prepareInferenceRuntime({
      model, host: 'http://ollama.test:11435', options: { num_predict: 512 }
    }, 'generate', {
      hostPreferenceService: { ...primitives, getByHost: jest.fn(async () => preference) },
      resolveInferenceContract: jest.fn(async () => ({
        contextBudget: { output: { reservedTokens: 512 } }
      })),
      resolveThinkingPolicy: jest.fn(() => ({ think: false }))
    });
    const inference = withContextRefusal({ model, options: prepared.options });
    const probe = probePayload(model, prepared.options);
    const warmUp = primitives.buildWarmPayload(model, {
      keepAlive: -1,
      contextSize: 8192,
      numThread: 6
    });

    const expected = { num_ctx: 8192, num_thread: 6, truncate: false, shift: false };
    for (const payload of [inference, probe, warmUp]) {
      expect(runnerMode(payload)).toEqual(expected);
    }
  });
});
