'use strict';

const assert = require('assert');
const { EventEmitter, once } = require('events');
const { PassThrough } = require('stream');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  buildRemoteAgentsConfigCommand,
  normalizeAgentsSection,
} = require('../openclaw/remoteConfigProjection');

const manifest = require('../index');
const {
  requestAbort, pipeRuntimeStream
} = require('../common');
const { OPENCLAW_CONSUMER_CONTRACT, registerOpenClawProtocol } = require('../openclaw/protocol');
const { createConversationHostResolver, parseConversationHosts, parseNoThinkModels } = require('../openclaw/conversationHosts');
const {
  PIPELINE_CONSUMER_CONTRACT,
  PIPELINE_MODEL_ALIAS
} = require('../pipeline-attribution');
const { buildInventoryFromState, buildSshArgs, isLocalModel } = require('../openclaw/agentInventory');
const { loadGuardedAgentPolicies } = require('../openclaw/modelPolicy');
const { cachedProvider, createAioOpsEvidenceService } = require('../evidence-service');
const {
  collectOpenClawCronEvidence,
  cronListArgs
} = require('../openclaw/runtimeEvidence');
const { hermesGatewayFreshness, registerOpenClawOperations } = require('../operations');
const {
  HERMES_CONSUMER_CONTRACT,
  OllamaToOpenAiSse,
  openAiCompletion,
  registerHermesProtocol
} = require('../hermes/protocol');
const {
  buildRuntimeConfigExport,
  isCloudAuthorityModel,
  resolveOpenClawProviderBaseUrl,
  validateRuntimeConfigs
} = require('../runtime-config');

function fakeExpress() {
  return {
    Router() {
      const routes = [];
      return {
        routes,
        use(...handlers) { routes.push({ method: 'use', path: null, handlers }); },
        get(path, ...handlers) { routes.push({ method: 'get', path, handlers }); },
        post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); },
        patch(path, ...handlers) { routes.push({ method: 'patch', path, handlers }); },
        all(path, ...handlers) { routes.push({ method: 'all', path, handlers }); }
      };
    }
  };
}

class Request extends EventEmitter {
  constructor({ body = {}, headers = {}, query = {}, params = {} } = {}) {
    super();
    this.body = body;
    this.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.query = query;
    this.params = params;
    this.protocol = 'http';
    this.ip = '127.0.0.1';
    this.socket = { remoteAddress: '127.0.0.1' };
  }
  get(name) { return this.headers[String(name).toLowerCase()] || ''; }
}

class Response extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = {};
    this.jsonBody = undefined;
  }
  status(code) { this.statusCode = code; return this; }
  set(name, value) {
    if (typeof name === 'object') Object.assign(this.headers, name);
    else this.headers[name] = value;
    return this;
  }
  type(value) { this.headers['Content-Type'] = value; return this; }
  json(value) { this.jsonBody = value; this.end(JSON.stringify(value)); return this; }
}

function route(router, method, path) {
  return router.routes.find((entry) => entry.method === method && entry.path === path);
}

function snapshot() {
  const task = {
    taskType: 'daily_operator',
    model: 'model-a',
    configuredModel: 'model-a',
    hostKey: 'primary',
    hostUrl: 'http://model-host.test:11434',
    contextSize: 32768,
    contextSource: 'host_preference_pin',
    keepAlive: -1,
    pinAligned: true,
    hostPreference: { loadedModel: 'model-a', loadedModels: ['model-a'], pinnedModels: [{ model: 'model-a', contextSize: 32768 }] },
    inferenceContract: {
      qualification: { qualified: true, state: 'qualified' },
      capabilities: {
        tools: { supported: true },
        thinking: { supported: true, source: 'benchmark_model_profile', visibleFinalAnswer: { qualified: true } }
      },
      contextBudget: { windowTokens: 32768 },
      artifact: { digest: 'sha256:test' }
    }
  };
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-18T00:00:00.000Z',
    tasks: {
      daily_operator: task,
      code_generation: { ...task, taskType: 'code_generation' },
      master_brain: { ...task, taskType: 'master_brain' }
    },
    catalog: [{ model: 'model-b:40b', hostUrl: task.hostUrl, parameterSize: '40B' }]
  };
}

function runtimeServices(execute) {
  return {
    contractVersion: 1,
    routing: { getEffectiveSnapshot: async () => snapshot() },
    inference: { execute }
  };
}

test('manifest owns the complete AIOps bridge surface and registers every route family', () => {
  assert.equal(manifest.id, 'aio-ops-runtime-bridges');
  assert.equal(manifest.version, '1.7.6');
  assert.deepEqual(manifest.capabilities, [
    'agent-runtime-config',
    'hermes-runtime-bridge',
    'openclaw-runtime-bridge',
    'dsh-studio-launcher',
    'runtime-operations-projection',
    'agent-ops-readonly-projection',
    'ecosystem-snapshot-mcp',
    'in-process-runtime-evidence',
    'pipeline-runtime-attribution',
    'coding-dispatch-one-shot-control',
    'coding-delivery-operator-inbox',
    'secretary-mail-host-control'
  ]);
  const mounts = [];
  let statusHandler;
  const app = {
    use(path) { mounts.push(path); },
    get(path, handler) { mounts.push(path); statusHandler = handler; }
  };
  manifest.register({
    contractVersion: 2,
    app,
    express: fakeExpress(),
    logger: {},
    runtimeServices: runtimeServices(async () => {}),
    standardJsonParser: { kind: 'standard-json-parser' }
  });
  assert.deepEqual(mounts, [
    ['/mcp', '/api/mcp'],
    '/api/openclaw-ollama',
    '/api/hermes-openai',
    '/api/openclaw',
    '/api/dsh',
    '/api/hermes',
    '/api/agent-ops',
    '/api/runtime-bridges/pipeline-attribution',
    '/api/runtime-bridges/coding-dispatch',
    '/api/runtime-bridges/coding-delivery',
    '/api/nerve-center/agent-runtime-config',
    '/api/runtime-bridges/status'
  ]);
  assert.equal(app.locals.aioOpsRuntimeEvidence.contractVersion, 1);
  assert.equal(typeof app.locals.aioOpsRuntimeEvidence.getOpenClawCronProjection, 'function');
  assert.deepEqual(app.locals.trustedRuntimeNavItems, []);
  const response = new Response();
  statusHandler({}, response);
  assert.equal(response.jsonBody.data.version, manifest.version);
});

test('a provider routed through the Core bridge is local whatever its id', async () => {
  const state = {
    openclawHome: os.tmpdir(),
    config: {
      models: { providers: {
        ollama: { baseUrl: 'http://127.0.0.1:3180/api/openclaw-ollama', api: 'ollama' },
        'agentx-conversation': { baseUrl: 'http://127.0.0.1:3180/api/openclaw-ollama/', api: 'ollama',
          headers: { 'x-agentx-busy-reply': 'conversation' } },
        'ollama-cloud': { baseUrl: 'https://ollama.example.test', api: 'ollama' }
      } },
      agents: { entries: {
        main: { model: { primary: 'agentx-conversation/model-a', fallbacks: [] } },
        remote: { model: { primary: 'ollama-cloud/model-a', fallbacks: [] } }
      } }
    },
    promptFilesSource: 'skipped',
    memoryStatus: []
  };
  const inventory = await buildInventoryFromState(state);
  const byId = Object.fromEntries(inventory.agents.map(agent => [agent.id, agent.model]));
  assert.equal(byId.main.cloudPrimary, false);
  assert.equal(byId.main.requiresLocalFallback, false);
  assert.equal(byId.remote.cloudPrimary, true);
});

test('native memory sources remain healthy without a root MEMORY.md and retain real scan failures', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-memory-inventory-'));
  try {
    const workspace = path.join(root, 'workspace-deepcoding');
    fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'memory', 'notes.md'), 'A native memory source.');
    const state = {
      openclawHome: root,
      config: { agents: { entries: { deepcoding: { workspace, model: { primary: 'ollama/model-a' } } } } },
      memoryStatus: [{ agentId: 'deepcoding', status: {
        files: 1, chunks: 9, dirty: false, custom: { indexIdentity: { status: 'valid' } }
      }, scan: { issues: [], sources: [] } }]
    };
    const healthy = await buildInventoryFromState(state);
    assert.equal(healthy.agents[0].promptFiles['MEMORY.md'].missing, true);
    assert.equal(healthy.agents[0].memory.indexStatus, 'valid');
    assert.deepEqual(healthy.agents[0].memory.issues, []);
    assert.deepEqual(healthy.known_gaps, []);

    state.memoryStatus[0].status.dirty = true;
    const dirty = await buildInventoryFromState(state);
    assert.ok(dirty.known_gaps.some(gap => gap.id === 'deepcoding-memory-index-dirty'));
    assert.ok(!dirty.known_gaps.some(gap => gap.detail.includes('is valid')));
    state.memoryStatus[0].status.dirty = false;
    state.memoryStatus[0].status.custom.indexIdentity.status = 'mismatch';
    state.memoryStatus[0].scan.issues = ['native source cannot be read'];
    const unhealthy = await buildInventoryFromState(state);
    assert.deepEqual(unhealthy.agents[0].memory.issues, ['native source cannot be read']);
    assert.ok(unhealthy.known_gaps.some(gap => gap.id === 'deepcoding-memory-index-mismatch'));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test('Pipeline attribution requests exact artifact identity from Product routing', async () => {
  const mounts = new Map();
  const snapshotOptions = [];
  let taskProjection;
  const app = {
    use(path, ...handlers) { mounts.set(path, handlers.at(-1)); },
    get() {}
  };
  manifest.register({
    contractVersion: 2,
    app,
    express: fakeExpress(),
    logger: {},
    mongoose: {
      connection: {
        db: {
          collection(name) {
            assert.equal(name, 'pipelinetasks');
            return {
              async findOne(_query, options) {
                taskProjection = options?.projection;
                return {
                  pipelineId: 'exact-routing-identity',
                  status: 'in_progress',
                  assignee: 'clawdx-coder',
                  automationAttemptCount: 1,
                  automationLease: { attempt: 1 },
                  automationAttempts: [{ attempt: 1, finalState: 'active' }]
                };
              }
            };
          }
        }
      }
    },
    runtimeServices: {
      contractVersion: 1,
      routing: {
        async getEffectiveSnapshot(options) {
          snapshotOptions.push(options);
          return snapshot();
        }
      },
      inference: { async execute() {} }
    },
    standardJsonParser: { kind: 'standard-json-parser' }
  });

  const router = mounts.get('/api/runtime-bridges/pipeline-attribution');
  const response = new Response();
  await route(router, 'post', '/leases').handlers[0](new Request({
    body: {
      pipelineId: 'exact-routing-identity',
      assignee: 'clawdx-coder',
      requestId: 'dispatch-exact-routing-identity',
      taskType: 'code_generation',
      ttlSeconds: 60
    }
  }), response);

  assert.equal(response.statusCode, 201);
  assert.deepEqual(snapshotOptions, [{
    includeCatalog: false,
    includeArtifactIdentity: true
  }]);
  assert.deepEqual(taskProjection, {
    _id: 0,
    pipelineId: 1,
    status: 1,
    assignee: 1,
    automationAttemptCount: 1,
    codingCapacity: 1,
    'automationLease.leaseId': 1,
    'automationLease.attempt': 1,
    'automationLease.expiresAt': 1,
    'automationAttempts.attempt': 1,
    'automationAttempts.finalState': 1
  });
});

test('strict inventory SSH uses the trusted known-hosts file beside its key', () => {
  const args = buildSshArgs('operator@192.0.2.66', 'openclaw cron list --json', {
    sshStrictHostKeyChecking: 'yes',
    sshKeyPath: '/data/ssh/id_ed25519',
  });
  assert.deepEqual(args.slice(0, 6), [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=/data/ssh/known_hosts',
  ]);
  assert.deepEqual(args.slice(-4), [
    '-i', '/data/ssh/id_ed25519',
    'operator@192.0.2.66', 'openclaw cron list --json',
  ]);
});

test('explicit known-hosts path overrides the key sibling and permissive mode stays isolated', () => {
  const strictArgs = buildSshArgs('operator@example', 'true', {
    sshStrictHostKeyChecking: 'accept-new',
    sshKeyPath: '/data/ssh/id_ed25519',
    sshKnownHostsPath: '/run/agentx/known_hosts',
  });
  assert.equal(strictArgs.includes('UserKnownHostsFile=/run/agentx/known_hosts'), true);
  const permissiveArgs = buildSshArgs('operator@example', 'true', {
    sshStrictHostKeyChecking: 'no',
    sshKeyPath: '/data/ssh/id_ed25519',
  });
  assert.equal(permissiveArgs.includes('UserKnownHostsFile=/dev/null'), true);
  assert.equal(permissiveArgs.includes('UserKnownHostsFile=/data/ssh/known_hosts'), false);
});

test('in-process evidence service shares official collectors without Core HTTP loopbacks', async () => {
  const calls = [];
  const service = createAioOpsEvidenceService({
    openClawProvider: async () => ({
      authority: 'official-openclaw-cli', generatedAt: '2026-08-27T09:00:00Z',
      status: { online: true, agents: 9, sessions: { count: 2 }, gateway: { reachable: true } }
    }),
    cronProvider: async (options) => {
      calls.push(['cron', options]);
      return { authority: 'official-openclaw-cli', cron: { count: 1, jobs: [{ name: 'nestor-personal-morning', enabled: false }] } };
    },
    hermesProvider: async () => ({ ok: true, gateway: { running: true } }),
    agentOpsBuilder: async (options) => {
      calls.push(['agent-ops', options]);
      return { authority: 'aio-ops-runtime-bridges', readOnly: true };
    },
    productFetch: async (route) => {
      calls.push(['product-fetch', route]);
      return { ok: true, statusCode: 200, body: {} };
    }
  });

  const status = await service.getOpenClawStatusProjection();
  const cron = await service.getOpenClawCronProjection({ includeDisabled: true });
  await service.getOpenClawCronProjection({ includeDisabled: true });
  await service.getOpenClawCronProjection();
  await service.getOpenClawCronProjection();
  const hermes = await service.getHermesStatusEvidence();
  const agentOps = await service.getAgentOpsProjection();
  await service.getAgentOpsProjection();
  assert.equal(status.status, 'online');
  assert.equal(cron.data[0].enabled, false);
  assert.equal(hermes.gateway.running, true);
  assert.equal(agentOps.readOnly, true);
  assert.deepEqual(calls.filter(([kind]) => kind === 'cron').map(([, options]) => options.includeDisabledCron), [true, false]);
  assert.equal(calls.filter(([kind]) => kind === 'agent-ops').length, 1);
  assert.equal(calls.some(([kind]) => kind === 'product-fetch'), false);
});

test('an older in-flight evidence read cannot replace an explicit refresh', async () => {
  let callCount = 0;
  let resolveOlder;
  let resolveNewer;
  const provider = cachedProvider(() => new Promise((resolve) => {
    callCount += 1;
    if (callCount === 1) resolveOlder = resolve;
    else resolveNewer = resolve;
  }), 60_000);

  const older = provider();
  const newer = provider({ refresh: true });
  resolveNewer('newer');
  assert.equal(await newer, 'newer');
  resolveOlder('older');
  assert.equal(await older, 'older');
  assert.equal(await provider(), 'newer');
});

test('OpenClaw non-streaming inference strips context authority and exposes actual Core routing metadata', async () => {
  let captured;
  let capturedOptions;
  const execute = async (request, options) => {
    captured = request;
    capturedOptions = options;
    return {
      ok: true,
      status: 200,
      body: { model: 'model-a', message: { role: 'assistant', content: 'hello' }, done: true },
      metadata: {
        model: 'model-a', hostUrl: 'http://model-host.test:11434', hostKey: 'primary',
        routingSource: 'model_router', options: { num_ctx: 32768 },
        inferenceContract: { contextBudget: { windowTokens: 32768 } }
      }
    };
  };
  const router = registerOpenClawProtocol({ express: fakeExpress(), runtimeServices: runtimeServices(execute), logger: {} });
  const req = new Request({
    body: {
      model: 'model-a',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
      options: { num_ctx: 32768, temperature: 0.2 }
    }
  });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(captured.options.num_ctx, undefined);
  assert.equal(captured.options.temperature, 0.2);
  assert.equal(capturedOptions.consumerContract, OPENCLAW_CONSUMER_CONTRACT);
  assert.equal(capturedOptions.attribution, undefined);
  assert.ok(capturedOptions.signal instanceof AbortSignal);
  assert.equal(res.headers['X-Routed-Host-Key'], 'primary');
  assert.equal(res.jsonBody.message.content, 'hello');
  const claims = [{ host: 'http://model-host.test:11434', claimBatchId: 'batch', claimGeneration: 'claim',
    workloadAdmissionId: 'admission', workloadGeneration: 'generation' }];
  const benchmarkRequest = new Request({ body: req.body,
    headers: { 'x-agentx-benchmark-claims': JSON.stringify(claims) } });
  await route(router, 'post', '/api/chat').handlers[0](benchmarkRequest, new Response());
  assert.deepEqual(capturedOptions.benchmarkClaims, claims);
  assert.equal(captured.claimBatchId, undefined);
  assert.equal(captured.options.num_ctx, undefined);
});

test('the active personal Open target uses the existing Core admission and native tool payload', async () => {
  let captured, opts, active = true;
  const router = registerOpenClawProtocol({ express: fakeExpress(), logger: {},
    resolveConversationTarget: async model => active && model === 'private-open' ? { model, hostUrl: 'http://private-host:11434', numCtx: 8192 } : null,
    runtimeServices: runtimeServices(async (request, options) => {
      captured = request; opts = options;
      return { ok: true, status: 200, body: { done: true }, metadata: {} };
    }) });
  const req = new Request({ body: { model: 'private-open', stream: false, messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'read' } }], options: { num_ctx: 99999 } } });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(captured.tools, req.body.tools);
  assert.equal(captured.options.num_ctx, 8192);
  assert.equal(captured.exclusiveHost, true);
  assert.equal(opts.hostUrl, 'http://private-host:11434');
  assert.equal(opts.consumerContract, OPENCLAW_CONSUMER_CONTRACT);
  active = false; captured = null;
  await route(router, 'post', '/api/chat').handlers[0](req, new Response());
  assert.equal(captured, null);
});

test('a declared conversation host keeps its pinned context and does not claim the host exclusively', async () => {
  let captured, opts;
  const resolve = createConversationHostResolver('companion:12b=http://second-host:11434/');
  const router = registerOpenClawProtocol({ express: fakeExpress(), logger: {},
    resolveConversationTarget: async model => resolve(model),
    runtimeServices: runtimeServices(async (request, options) => {
      captured = request; opts = options;
      return { ok: true, status: 200, body: { done: true }, metadata: {} };
    }) });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](new Request({ body: { model: 'companion:12b', stream: false,
    messages: [{ role: 'user', content: 'hello' }], options: { num_ctx: 99999, temperature: 0.7 } } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(opts.hostUrl, 'http://second-host:11434');
  assert.equal(captured.exclusiveHost, false);
  assert.equal(captured.options.num_ctx, undefined);
  assert.equal(captured.options.temperature, 0.7);
  assert.equal(resolve('model-a'), null);
});

test('conversation hosts reject malformed entries', () => {
  assert.equal(parseConversationHosts('').size, 0);
  assert.equal(parseConversationHosts(' a=http://h:1 , b:9b=https://h2:2 ').get('b:9b').hostUrl, 'https://h2:2');
  for (const value of ['no-host', '=http://h:1', 'a=ftp://h:1', 'a=http://user@h:1', 'a=http://h:1/path?x=1']) {
    assert.throws(() => parseConversationHosts(value), /OPENCLAW_CONVERSATION_HOSTS/);
  }
});

test('a conversation model on the no-reasoning list answers without thinking, others keep their level', async () => {
  let captured;
  const resolve = createConversationHostResolver('companion:12b=http://second-host:11434');
  const router = registerOpenClawProtocol({ express: fakeExpress(), logger: {},
    noThinkModels: parseNoThinkModels(' companion:12b , other:4b '),
    resolveConversationTarget: async model => resolve(model),
    runtimeServices: runtimeServices(async (request) => {
      captured = request;
      return { ok: true, status: 200, body: { done: true }, metadata: {} };
    }) });
  const turn = async (model, think) => {
    const res = new Response();
    await route(router, 'post', '/api/chat').handlers[0](new Request({ body: { model, stream: false,
      ...(think !== undefined && { think }), messages: [{ role: 'user', content: 'hello' }] } }), res);
    assert.equal(res.statusCode, 200);
    return captured.think;
  };
  assert.equal(await turn('companion:12b', 'high'), false);
  assert.equal(await turn('companion:12b', undefined), false);
  assert.equal(await turn('model-a', 'high'), 'high');
  assert.equal(await turn('model-a', undefined), undefined);
});

test('the no-reasoning list rejects malformed entries', () => {
  assert.equal(parseNoThinkModels('').size, 0);
  assert.deepEqual([...parseNoThinkModels('a:1b,, b ')], ['a:1b', 'b']);
  for (const value of ['a=http://h:1', 'two words']) {
    assert.throws(() => parseNoThinkModels(value), /OPENCLAW_CONVERSATION_NO_THINK_MODELS/);
  }
});

test('OpenClaw rejects model and context drift before invoking Core inference', async () => {
  let calls = 0;
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => { calls += 1; }),
    logger: {}
  });
  for (const body of [
    { model: 'not-approved', messages: [] },
    { model: 'model-a', messages: [], options: { num_ctx: 4096 } }
  ]) {
    const res = new Response();
    await route(router, 'post', '/api/chat').handlers[0](new Request({ body }), res);
    assert.equal(res.statusCode, 409);
  }
  assert.equal(calls, 0);
});

test('OpenClaw advertises the Pipeline alias only from exact artifact identity', async () => {
  const snapshotOptions = [];
  const services = {
    contractVersion: 1,
    routing: {
      async getEffectiveSnapshot(options) {
        snapshotOptions.push(options);
        const exact = options?.includeArtifactIdentity === true;
        const value = snapshot();
        value.tasks.code_generation.inferenceContract = {
          ...value.tasks.code_generation.inferenceContract,
          qualification: { qualified: exact, state: exact ? 'qualified' : 'unqualified' },
          artifact: exact ? { digest: 'sha256:exact-code-model' } : null
        };
        return value;
      }
    },
    inference: { async execute() {} }
  };
  const router = registerOpenClawProtocol({
    express: fakeExpress(), runtimeServices: services, logger: {}
  });

  const tagsResponse = new Response();
  await route(router, 'get', '/api/tags').handlers[0](new Request(), tagsResponse);
  const alias = tagsResponse.jsonBody.models.find((row) => row.name === PIPELINE_MODEL_ALIAS);
  assert.equal(tagsResponse.statusCode, 200);
  assert.equal(alias.digest, 'sha256:exact-code-model');

  const showResponse = new Response();
  await route(router, 'post', '/api/show').handlers[0](new Request({
    body: { model: PIPELINE_MODEL_ALIAS }
  }), showResponse);
  assert.equal(showResponse.statusCode, 200);
  assert.deepEqual(snapshotOptions, [
    { includeCatalog: false, includeArtifactIdentity: true },
    { includeCatalog: false, includeArtifactIdentity: true }
  ]);
});

test('OpenClaw Pipeline alias is mapped and attributed only by the server lease', async () => {
  let capturedRequest;
  let capturedOptions;
  const pipelineAttribution = {
    async revalidate() { return 900000; },
    progress() {},
    async authorizeAlias(model) {
      assert.equal(model, PIPELINE_MODEL_ALIAS);
      return {
        effectiveModel: 'model-a',
        consumerContract: PIPELINE_CONSUMER_CONTRACT,
        attribution: {
          workItemId: '0377', correlationId: 'lease-0377', runtime: 'external', attempt: 2
        }
      };
    }
  };
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async (request, options) => {
      capturedRequest = request;
      capturedOptions = options;
      return {
        ok: true, status: 200,
        body: { model: 'model-a', message: { role: 'assistant', content: 'done' }, done: true },
        metadata: { model: 'model-a', hostKey: 'primary' }
      };
    }),
    pipelineAttribution,
    logger: {}
  });
  const req = new Request({
    body: {
      model: PIPELINE_MODEL_ALIAS,
      messages: [{ role: 'user', content: 'private task text' }],
      stream: false,
      options: {
        temperature: 0.1,
        attribution: { workItemId: 'forged', runtime: 'codex' }
      }
    }
  });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(capturedRequest.model, 'model-a');
  assert.equal(capturedRequest.options.attribution, undefined);
  assert.equal(capturedRequest.callerDetail, 'openclaw-pipeline-runtime-bridge');
  assert.equal(capturedOptions.consumerContract, PIPELINE_CONSUMER_CONTRACT);
  assert.deepEqual(capturedOptions.attribution, {
    workItemId: '0377', correlationId: 'lease-0377', runtime: 'external', attempt: 2
  });
});

for (const code of [
  'BENCHMARK_CLAIM_ACTIVE',
  'RUNTIME_INFERENCE_ADMISSION_DENIED',
  'RUNTIME_INFERENCE_RECOVERY_REQUIRED'
]) test(`OpenClaw exposes ${code} as a host conflict, then permits a recovered turn`, async () => {
  let calls = 0;
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Host is reserved by existing work.'), { code, statusCode: 503 });
      return { ok: true, status: 200, body: { done: true, message: { role: 'assistant', content: 'recovered' } } };
    }),
    logger: {}
  });
  const handler = route(router, 'post', '/api/chat').handlers[0];
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: false };
  const refused = new Response();
  await handler(new Request({ body }), refused);
  assert.equal(refused.statusCode, 409);
  assert.deepEqual(refused.jsonBody, { error: 'Host is reserved by existing work.', code });
  assert.equal(calls, 1);

  const recovered = new Response();
  await handler(new Request({ body }), recovered);
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.jsonBody.message.content, 'recovered');
});

test('an opted-in OpenClaw conversation hears why the local host is busy; automations keep the 409', async () => {
  const busy = Object.assign(new Error('Host is reserved by existing work.'), {
    code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503,
    failure: { cause: 'workload_reserved', holder: { type: 'workload', kind: 'benchmark', principal: 'benchmark-service', since: new Date().toISOString() } }
  });
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => { throw busy; }),
    logger: {}
  });
  const handler = route(router, 'post', '/api/chat').handlers[0];
  const headers = { 'x-agentx-busy-reply': 'conversation' };
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: false };

  const answered = new Response();
  await handler(new Request({ body, headers }), answered);
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.headers['x-agentx-inference-outcome'], 'host-busy');
  assert.equal(answered.jsonBody.done, true);
  assert.match(answered.jsonBody.message.content, /occupé par une campagne benchmark depuis \d\d h \d\d\. Rien n'est envoyé vers le cloud/);

  const streamed = new Response();
  const chunks = [];
  streamed.on('data', (chunk) => chunks.push(chunk));
  await handler(new Request({ body: { ...body, stream: true }, headers }), streamed);
  const frames = Buffer.concat(chunks).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(frames.length, 2);
  assert.match(frames[0].message.content, /campagne benchmark/);
  assert.deepEqual([frames[0].done, frames[1].done], [false, true]);

  const automation = new Response();
  await handler(new Request({ body }), automation);
  assert.equal(automation.statusCode, 409);
  assert.equal(automation.jsonBody.code, 'RUNTIME_INFERENCE_ADMISSION_DENIED');
});

test('an OpenClaw conversation asks Core for household priority; automations keep their own policy', async () => {
  const seen = [];
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async (_request, options) => {
      seen.push(options.retry);
      return { ok: true, status: 200, body: { message: { role: 'assistant', content: 'ok' }, done: true }, metadata: {} };
    }),
    logger: {}
  });
  const handler = route(router, 'post', '/api/chat').handlers[0];
  const body = { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: false };
  await handler(new Request({ body, headers: { 'x-agentx-busy-reply': 'conversation' } }), new Response());
  await handler(new Request({ body }), new Response());
  // The conversation waits for a yielding workload, under the gateway timeout.
  assert.deepEqual(seen[0], { interactive: true, interactiveWaitMs: 45000 });
  assert.equal(seen[1], undefined);
});

test('OpenClaw retains real upstream failures as 502 without exposing internal details', async () => {
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => {
      throw Object.assign(new Error('private upstream details'), { code: 'INFERENCE_UPSTREAM_UNAVAILABLE', statusCode: 502 });
    }),
    logger: {}
  });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](new Request({
    body: { model: 'model-a', messages: [], stream: false }
  }), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.jsonBody, {
    error: 'Runtime bridge upstream request failed.', code: 'INFERENCE_UPSTREAM_UNAVAILABLE'
  });
});

test('OpenClaw Pipeline alias fails closed without an attribution manager', async () => {
  let calls = 0;
  const router = registerOpenClawProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => { calls += 1; }),
    logger: {}
  });
  const res = new Response();
  await route(router, 'post', '/api/chat').handlers[0](
    new Request({ body: { model: PIPELINE_MODEL_ALIAS, messages: [], stream: false } }),
    res
  );
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
});

for (const [name, register, endpoint, expectedContract] of [
  ['OpenClaw', registerOpenClawProtocol, '/api/chat', OPENCLAW_CONSUMER_CONTRACT],
  ['Hermes', registerHermesProtocol, '/v1/chat/completions', HERMES_CONSUMER_CONTRACT]
]) test(`${name} delivers its first token and drains without further delivery after disconnect`, async () => {
  const upstream = new PassThrough();
  let coreSignal;
  let consumerContract;
  const router = register({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async (_request, options) => {
      coreSignal = options.signal;
      consumerContract = options.consumerContract;
      return {
        ok: true, status: 200, stream: upstream,
        metadata: { model: 'model-a', hostKey: 'primary', upstreamProtocol: 'ollama' }
      };
    }),
    logger: {}
  });
  const req = new Request({ body: { model: 'model-a', messages: [{ role: 'user', content: 'hello' }], stream: true } });
  const res = new Response();
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk.toString('utf8')));
  await route(router, 'post', endpoint).handlers[0](req, res);
  upstream.write('{"message":{"content":"first"},"done":false}\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(chunks.join(''), /first/);
  assert.equal(consumerContract, expectedContract);
  res.emit('close');
  assert.equal(coreSignal.aborted, true);
  const delivered = chunks.join('');
  const ended = once(upstream, 'end');
  upstream.end('{"message":{"content":"late"},"done":false}\n{"done":true}\n');
  await ended;
  assert.equal(chunks.join(''), delivered);
  assert.equal(upstream.readableEnded, true);
});

test('a client disconnected before headers drains the returned stream without piping to the response', async () => {
  const stream = new PassThrough(), res = new Response(), controller = new AbortController();
  const chunks = []; res.on('data', chunk => chunks.push(chunk));
  controller.abort();
  pipeRuntimeStream(stream, res, controller.signal);
  const ended = once(stream, 'end');
  stream.end('discarded'); await ended;
  assert.deepEqual(chunks, []);
});

test('request abort helper does not cancel completed responses', () => {
  const req = new Request();
  const res = new Response();
  const abort = requestAbort(req, res);
  res.end();
  res.emit('close');
  assert.equal(abort.signal.aborted, false);
  abort.cleanup();
});

test('agent chat turns ask Core for prompt-prefix telemetry outside the model request', async () => {
  const calls = [];
  const services = runtimeServices(async (request, options) => {
    calls.push({ request, options });
    return { ok: true, status: 200, body: { model: 'model-a', message: { role: 'assistant', content: 'ok' }, done: true },
      metadata: { model: 'model-a', upstreamProtocol: 'ollama' } };
  });
  const openclaw = registerOpenClawProtocol({ express: fakeExpress(), runtimeServices: services, logger: {} });
  const hermes = registerHermesProtocol({ express: fakeExpress(), runtimeServices: services, logger: {} });
  const messages = [{ role: 'system', content: '## Tooling\nsynthetic' }, { role: 'user', content: 'hello' }];
  await route(openclaw, 'post', '/api/chat').handlers[0](
    new Request({ body: { model: 'model-a', stream: false, messages, options: { temperature: 0.2 } } }), new Response());
  await route(openclaw, 'post', '/api/generate').handlers[0](
    new Request({ body: { model: 'model-a', stream: false, prompt: 'hello' } }), new Response());
  await route(hermes, 'post', '/v1/chat/completions').handlers[0](
    new Request({ body: { model: 'model-a', messages } }), new Response());
  assert.deepEqual(calls.map(call => call.options.observePromptPrefix), [true, undefined, true]);
  for (const { request } of calls) {
    assert.equal(request.observePromptPrefix, undefined);
    assert.equal(request.promptPrefix, undefined);
    assert.equal(request.options?.observePromptPrefix, undefined);
  }
  assert.deepEqual(calls[0].request.messages, messages);
});

test('Hermes maps non-streaming content, tools, usage, and routing metadata', async () => {
  let inferenceRequest;
  let inferenceOptions;
  const router = registerHermesProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async (request, options) => {
      inferenceRequest = request;
      inferenceOptions = options;
      return ({
        ok: true,
        status: 200,
        body: {
          model: 'model-a',
          message: {
            role: 'assistant', content: '',
            tool_calls: [{ function: { name: 'weather', arguments: { city: 'Montreal' } } }]
          },
          done: true,
          prompt_eval_count: 10,
          eval_count: 4
        },
        metadata: { model: 'model-a', provider: 'openrouter', hostKey: 'primary', upstreamProtocol: 'ollama' }
      });
    }),
    logger: {}
  });
  const req = new Request({
    body: {
      model: 'model-a', messages: [{ role: 'user', content: 'weather?' }],
      tools: [{ type: 'function', function: { name: 'weather' } }],
      reasoning_effort: 'none'
    }
  });
  const res = new Response();
  await route(router, 'post', '/v1/chat/completions').handlers[0](req, res);
  const call = res.jsonBody.choices[0].message.tool_calls[0];
  assert.equal(call.type, 'function');
  assert.equal(call.function.name, 'weather');
  assert.equal(call.function.arguments, '{"city":"Montreal"}');
  assert.equal(res.jsonBody.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(res.jsonBody.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  assert.equal(res.headers['X-Routed-Host-Key'], 'primary');
  assert.equal(res.headers['X-AgentX-Fallback-Used'], 'false');
  assert.equal(res.headers['X-AgentX-Resolved-Provider'], 'openrouter');
  assert.equal(res.headers['X-AgentX-Resolved-Model-Version'], 'model-a');
  assert.equal(res.headers['X-AgentX-Harness-Version'], '1.2.0');
  assert.equal(inferenceRequest.reasoning_effort, 'none');
  assert.equal(inferenceOptions.consumerContract, HERMES_CONSUMER_CONTRACT);
  assert.ok(inferenceOptions.signal instanceof AbortSignal);
});

test('Hermes SSE translation sends the first delta, tool shape, usage, and DONE marker', async () => {
  const transform = new OllamaToOpenAiSse('model-a');
  const output = [];
  transform.on('data', (chunk) => output.push(chunk.toString('utf8')));
  transform.end([
    JSON.stringify({ model: 'model-a', message: { role: 'assistant', content: 'first' }, done: false }),
    JSON.stringify({
      model: 'model-a', message: { tool_calls: [{ function: { name: 'weather', arguments: { city: 'Montreal' } } }] },
      done: true, prompt_eval_count: 5, eval_count: 2
    }),
    ''
  ].join('\n'));
  await once(transform, 'end');
  const text = output.join('');
  assert.match(text, /"content":"first"/);
  assert.match(text, /"name":"weather"/);
  assert.match(text, /"prompt_tokens":5/);
  assert.match(text, /data: \[DONE\]/);
});

test('Hermes malformed and unapproved requests fail without touching inference', async () => {
  let calls = 0;
  const router = registerHermesProtocol({
    express: fakeExpress(),
    runtimeServices: runtimeServices(async () => { calls += 1; }),
    logger: {}
  });
  for (const body of [
    { model: 'model-a', messages: 'bad' },
    { model: 'unapproved', messages: [{ role: 'user', content: 'hello' }] }
  ]) {
    const res = new Response();
    await route(router, 'post', '/v1/chat/completions').handlers[0](new Request({ body }), res);
    assert.ok([400, 409].includes(res.statusCode));
  }
  assert.equal(calls, 0);
});

test('runtime export and validation retain exact effective model/context without secrets', async () => {
  const previousModel = process.env.HERMES_AUTHORITY_MODEL;
  const previousContext = process.env.HERMES_AUTHORITY_CONTEXT;
  const previousProviderKey = process.env.OPENROUTER_API_KEY;
  const previousOpenClawProviderBaseUrl = process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL;
  const previousOpenClawBridgeToken = process.env.AGENTX_OPENCLAW_BRIDGE_TOKEN;
  process.env.HERMES_AUTHORITY_MODEL = 'openai/gpt-5.6-sol';
  process.env.HERMES_AUTHORITY_CONTEXT = '131072';
  process.env.OPENROUTER_API_KEY = 'must-never-appear-in-runtime-export';
  process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = 'http://machine.test:3080/api/openclaw-ollama';
  process.env.AGENTX_OPENCLAW_BRIDGE_TOKEN = 'must-never-appear-openclaw-token';
  try {
    const snapshotOptions = [];
    const services = runtimeServices(async () => {});
    services.routing.getEffectiveSnapshot = async (options) => {
      snapshotOptions.push(options);
      return snapshot();
    };
    const exported = await buildRuntimeConfigExport(services, {
      coreBaseUrl: 'https://browser.test'
    });
    assert.deepEqual(snapshotOptions, [{
      includeCatalog: true,
      includeArtifactIdentity: true
    }]);
    assert.equal(exported.sourceOfTruth.routing, '/api/router/config');
    assert.equal(exported.lanes.daily.model, 'model-a');
    assert.equal(exported.lanes.daily.contextSize, 32768);
    assert.equal(exported.openclaw.provider.models[0].params.num_ctx, 32768);
    assert.equal(exported.coreBaseUrl, 'https://browser.test');
    assert.equal(exported.hermes.proxyBaseUrl, 'https://browser.test/api/hermes-openai/v1');
    assert.equal(exported.openclaw.provider.apiBase, 'http://machine.test:3080/api/openclaw-ollama');
    assert.equal(exported.openclaw.provider.authHeader, false);
    assert.equal(exported.openclaw.provider.apiKey, 'ollama-local');
    assert.deepEqual(exported.openclaw.credential, {
      source: 'trusted-lan',
      required: false,
      profileId: null,
      routeScope: '/api/openclaw-ollama',
      valueExported: false
    });
    assert.equal('providerAliases' in exported.openclaw, false);
    assert.equal(isLocalModel('ollama/model-a'), true);
    assert.equal(isLocalModel('inference-host-ollama/model-a'), false);
    assert.equal(isLocalModel('unconfigured-label/model-a'), false);
    assert.equal(exported.hermes.defaultModelConfig.default, 'openai/gpt-5.6-sol');
    assert.equal(exported.hermes.defaultModelConfig.context_length, 131072);
    assert.doesNotMatch(JSON.stringify(exported), /must-never-appear-in-runtime-export/);
    assert.doesNotMatch(JSON.stringify(exported), /must-never-appear-openclaw-token/);

    const validation = validateRuntimeConfigs(exported, {
      hermesConfig: {
        model: exported.hermes.defaultModelConfig.default,
        provider: exported.hermes.defaultModelConfig.provider,
        base_url: exported.hermes.defaultModelConfig.base_url,
        context_length: exported.hermes.defaultModelConfig.context_length,
        ollama_num_ctx: exported.hermes.defaultModelConfig.ollama_num_ctx,
        api_key: 'must-not-be-returned'
      },
      openclawConfig: {
        models: { providers: { ollama: exported.openclaw.provider } },
        agents: {
          defaults: { model: { primary: 'ollama/model-a', fallbacks: [] } },
          list: [{ id: 'main', model: { primary: 'ollama/model-a', fallbacks: [] } }]
        }
      }
    });
    assert.equal(validation.hermes.status, 'ok');
    assert.equal(validation.openclaw.status, 'ok');
    assert.equal(validation.openclaw.agentModels.checked, 1);
    assert.doesNotMatch(JSON.stringify(validation), /must-not-be-returned/);

    for (const authHeader of [false, true, undefined]) {
      const provider = { ...exported.openclaw.provider, authHeader };
      const result = validateRuntimeConfigs(exported, {
        openclawConfig: {
          models: { providers: { ollama: provider } },
          agents: { entries: { main: { model: { primary: 'ollama/model-a', fallbacks: [] } } } }
        }
      });
      assert.equal(result.openclaw.status, 'ok');
      assert.equal(result.openclaw.agentModels.checked, 1);
      assert.equal(result.openclaw.agentModels.agents[0].paths.primary, 'agents.entries.main.model.primary');
    }
  } finally {
    if (previousModel === undefined) delete process.env.HERMES_AUTHORITY_MODEL;
    else process.env.HERMES_AUTHORITY_MODEL = previousModel;
    if (previousContext === undefined) delete process.env.HERMES_AUTHORITY_CONTEXT;
    else process.env.HERMES_AUTHORITY_CONTEXT = previousContext;
    if (previousProviderKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousProviderKey;
    if (previousOpenClawProviderBaseUrl === undefined) delete process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL;
    else process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = previousOpenClawProviderBaseUrl;
    if (previousOpenClawBridgeToken === undefined) delete process.env.AGENTX_OPENCLAW_BRIDGE_TOKEN;
    else process.env.AGENTX_OPENCLAW_BRIDGE_TOKEN = previousOpenClawBridgeToken;
  }
});

test('OpenClaw provider base URL is exact, credential-free, and independently configurable', () => {
  assert.equal(
    resolveOpenClawProviderBaseUrl('http://machine.test:3080/api/openclaw-ollama/'),
    'http://machine.test:3080/api/openclaw-ollama'
  );
  assert.equal(
    resolveOpenClawProviderBaseUrl('', 'https://browser.test/'),
    'https://browser.test/api/openclaw-ollama'
  );
  assert.throws(
    () => resolveOpenClawProviderBaseUrl('', 'https://user:password@browser.test'),
    /must not include credentials/
  );
  assert.throws(
    () => resolveOpenClawProviderBaseUrl('', 'https://browser.test?source=ui'),
    /must not include a query or fragment/
  );
  for (const value of [
    'relative/api/openclaw-ollama',
    'ftp://machine.test/api/openclaw-ollama',
    'http://user:pass@machine.test/api/openclaw-ollama',
    'http://machine.test/api/openclaw-ollama?token=no',
    'http://machine.test/api/openclaw-ollama#fragment',
    'http://machine.test/api/openclaw-ollama/other',
    'http://machine.test/api/hermes-openai/v1'
  ]) {
    assert.throws(() => resolveOpenClawProviderBaseUrl(value), /OPENCLAW_AGENTX_PROVIDER_BASE_URL/);
  }
});

test('OpenClaw validation distinguishes ordinary cloud agents from configured guarded dispatch', async () => {
  const services = runtimeServices(async () => {});
  services.routing.getEffectiveSnapshot = async () => snapshot();
  const exported = await buildRuntimeConfigExport(services, { coreBaseUrl: 'http://core.test:3080' });
  exported.openclaw.agentModelPolicy.guardedExecution = loadGuardedAgentPolicies({ dispatcherConfig: {
    schema: 'agentx.coding-dispatcher-config/v1', executionProfiles: {
      reviewed: { adapter: 'clawdx-guarded', agent: 'clawdx-worker', model: 'ollama/agentx-pipeline' }
    }
  } });
  exported.openclaw.provider.models.push({ id: 'agentx-pipeline' });
  const agents = ['main', 'clawdx-worker', 'deepsearch', 'cloudx', 'anthropicx'].map((id) => ({
    id,
    model: { primary: 'openrouter/z-ai/glm-5.2', fallbacks: [] }
  }));
  const validation = validateRuntimeConfigs(exported, {
    openclawConfig: {
      models: { providers: { ollama: exported.openclaw.provider } },
      agents: { defaults: { model: {} }, list: agents }
    }
  });

  assert.equal(validation.openclaw.status, 'degraded');
  assert.equal(validation.openclaw.agentModels.checked, 5);
  assert.equal(validation.openclaw.agentModels.degraded, 4);
  assert.deepEqual(
    validation.openclaw.agentModels.issues.map((issue) => issue.agentId),
    agents.filter(agent => agent.id !== 'clawdx-worker').map(agent => agent.id)
  );
  assert.ok(validation.openclaw.agentModels.issues.every(
    (issue) => issue.code === 'OPENCLAW_AGENT_LOCAL_FALLBACK_MISSING'
      && issue.path.endsWith('.model.fallbacks')
  ));
});

test('guarded policy comes from dispatcher profiles and preserves route/catalog drift diagnostics', async () => {
  const exported = await buildRuntimeConfigExport(runtimeServices(async () => {}), { coreBaseUrl: 'http://core.test:3080' });
  const dispatcherConfig = { schema: 'agentx.coding-dispatcher-config/v1', executionProfiles: {
    reviewed: { adapter: 'clawdx-guarded', agent: 'renamed-worker', model: 'ollama/agentx-pipeline' }
  } };
  exported.openclaw.agentModelPolicy.guardedExecution = loadGuardedAgentPolicies({ dispatcherConfig });
  const config = {
    models: { providers: { ollama: { ...exported.openclaw.provider,
      models: [...exported.openclaw.provider.models, { id: 'agentx-pipeline' }] } } },
    agents: { entries: { 'renamed-worker': { model: { primary: 'openrouter/cloud', fallbacks: [] } } } }
  };
  assert.equal(validateRuntimeConfigs(exported, { openclawConfig: config }).openclaw.status, 'ok');
  const inventoryOptions = { dispatcherConfig, includePromptFiles: false, includeMemoryStatus: false };
  const healthy = await buildInventoryFromState({ config }, inventoryOptions);
  assert.equal(healthy.agents[0].model.requiresLocalFallback, false);
  assert.ok(!healthy.known_gaps.some(gap => gap.id.includes('fallback')));

  config.agents.entries['renamed-worker'].model.fallbacks = ['ollama/model-a'];
  const fallback = validateRuntimeConfigs(exported, { openclawConfig: config }).openclaw;
  assert.ok(fallback.agentModels.issues.some(issue => issue.code === 'OPENCLAW_GUARDED_FALLBACK_CONFIGURED'));
  const drifted = await buildInventoryFromState({ config }, inventoryOptions);
  assert.ok(drifted.known_gaps.some(gap => gap.id === 'renamed-worker-guarded-fallback-configured'));

  config.agents.entries['renamed-worker'].model.fallbacks = [];
  config.models.providers.ollama.models.pop();
  const missing = validateRuntimeConfigs(exported, { openclawConfig: config }).openclaw;
  assert.ok(missing.agentModels.issues.some(issue => issue.code === 'OPENCLAW_DISPATCH_MODEL_NOT_IN_CATALOG'
    && issue.path === 'config/coding-dispatcher.json.executionProfiles.reviewed.model'));

  exported.openclaw.agentModelPolicy.guardedExecution = loadGuardedAgentPolicies({ dispatcherConfig: {} });
  const unknown = validateRuntimeConfigs(exported, { openclawConfig: config }).openclaw;
  assert.ok(unknown.agentModels.issues.some(issue => issue.code === 'OPENCLAW_AGENT_LOCAL_FALLBACK_MISSING'));
});

test('OpenClaw validation counts only exact provider-catalog entries as local fallbacks', async () => {
  const services = runtimeServices(async () => {});
  services.routing.getEffectiveSnapshot = async () => snapshot();
  const exported = await buildRuntimeConfigExport(services, { coreBaseUrl: 'http://core.test:3080' });
  const validation = validateRuntimeConfigs(exported, {
    openclawConfig: {
      models: { providers: { ollama: exported.openclaw.provider } },
      agents: { list: [{
        id: 'cloud-worker',
        model: { primary: 'openrouter/z-ai/glm-5.2', fallbacks: ['ollama/not-installed'] }
      }] }
    }
  });
  assert.equal(validation.openclaw.status, 'degraded');
  assert.deepEqual(validation.openclaw.agentModels.agents[0].localFallbacks, []);
  assert.deepEqual(validation.openclaw.agentModels.agents[0].missingCatalogModels, ['ollama/not-installed']);
  assert.deepEqual(validation.openclaw.agentModels.issues.map((issue) => issue.code), [
    'OPENCLAW_AGENT_LOCAL_FALLBACK_MISSING',
    'OPENCLAW_AGENT_LOCAL_MODEL_NOT_IN_CATALOG'
  ]);
});

test('OpenClaw validation checks keyed agents instead of a stale legacy list', async () => {
  const services = runtimeServices(async () => {});
  services.routing.getEffectiveSnapshot = async () => snapshot();
  const exported = await buildRuntimeConfigExport(services, { coreBaseUrl: 'http://core.test:3080' });
  const validation = validateRuntimeConfigs(exported, {
    openclawConfig: {
      models: { providers: { ollama: exported.openclaw.provider } },
      agents: {
        list: [{ id: 'stale', model: { primary: 'ollama/model-a', fallbacks: [] } }],
        entries: {
          current: { id: 'ignored-inner-id', model: { primary: 'openrouter/cloud', fallbacks: ['ollama/missing'] } }
        }
      }
    }
  });
  const result = validation.openclaw;
  assert.equal(result.agentModels.checked, 1);
  assert.equal(result.status, 'degraded');
  assert.equal(result.agentModels.agents[0].id, 'current');
  assert.ok(result.agentModels.issues.every(issue => issue.path === 'agents.entries.current.model.fallbacks'));
  assert.ok(result.agentModels.issues.some(issue => issue.code === 'OPENCLAW_AGENT_LOCAL_MODEL_NOT_IN_CATALOG'));
});

test('cloud authority detection never treats an arbitrary Ollama namespace as a provider', () => {
  assert.equal(isCloudAuthorityModel('openai/gpt-5.6-sol'), true);
  assert.equal(isCloudAuthorityModel('gpt-5.6-sol'), true);
  assert.equal(isCloudAuthorityModel('owner/custom-model:8b'), false);
  assert.equal(isCloudAuthorityModel('ax/custom-model:8b'), false);
  assert.equal(isCloudAuthorityModel('qllama/bge-m3:f16'), false);
});

test('invalid environment configuration fails extension startup', () => {
  const previous = process.env.OPENCLAW_INVENTORY_SSH_TARGET;
  const previousProviderBaseUrl = process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL;
  process.env.OPENCLAW_INVENTORY_SSH_TARGET = '-oProxyCommand=bad';
  try { assert.throws(() => manifest.validateEnvironment(), /SSH_TARGET is invalid/); }
  finally {
    if (previous === undefined) delete process.env.OPENCLAW_INVENTORY_SSH_TARGET;
    else process.env.OPENCLAW_INVENTORY_SSH_TARGET = previous;
  }
  process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = 'https://user:password@machine.test/api/openclaw-ollama';
  try { assert.throws(() => manifest.validateEnvironment(), /must not include credentials/); }
  finally {
    if (previousProviderBaseUrl === undefined) delete process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL;
    else process.env.OPENCLAW_AGENTX_PROVIDER_BASE_URL = previousProviderBaseUrl;
  }
});

test('OpenAI completion helper never reflects unrelated fields from the upstream body', () => {
  const completion = openAiCompletion({
    model: 'model-a',
    message: { content: 'ok' },
    done: true,
    api_key: 'do-not-copy'
  }, 'model-a');
  assert.doesNotMatch(JSON.stringify(completion), /do-not-copy|api_key/);
});

test('Hermès gateway freshness fails closed on missing or stale receipts', () => {
  const now = Date.parse('2026-08-27T02:00:00Z');
  assert.equal(hermesGatewayFreshness({}, now, 3600000).status, 'unknown');
  assert.equal(hermesGatewayFreshness({
    gateway_updated_at: '2026-08-27T01:30:00Z',
    gateway_platforms: { telegram: { updated_at: '2026-08-27T01:45:00Z' } }
  }, now, 3600000).status, 'fresh');
  const stale = hermesGatewayFreshness({ gateway_updated_at: '2026-08-22T01:00:00Z' }, now, 86400000);
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /older than 24 hours/);
});

test('disabled OpenClaw cron declarations require an explicit evidence view', () => {
  assert.deepEqual(cronListArgs({}), ['cron', 'list']);
  assert.deepEqual(cronListArgs({ includeDisabledCron: true }), ['cron', 'list', '--all']);
});

test('the dedicated OpenClaw cron collector runs only the official cron command', async () => {
  const calls = [];
  const evidence = await collectOpenClawCronEvidence({
    includeDisabledCron: true,
    generatedAt: '2026-08-27T05:00:00.000Z',
    nativeJson: async (args, options) => {
      calls.push({ args, timeout: options.commandTimeoutMs });
      return { jobs: [{ id: 'reminder', name: 'nestor-personal-morning', enabled: false, state: { runningAtMs: 1780000000000 } }] };
    }
  });
  assert.deepEqual(calls.map((call) => call.args), [['cron', 'list', '--all']]);
  assert.ok(calls[0].timeout > 0);
  assert.equal(evidence.generatedAt, '2026-08-27T05:00:00.000Z');
  assert.equal(evidence.authority, 'official-openclaw-cli');
  assert.equal(evidence.source, 'openclaw cron list --all --json');
  assert.equal(evidence.cron.count, 1);
  assert.equal(evidence.cron.jobs[0].enabled, false);
  assert.equal(evidence.cron.jobs[0].runningAtMs, 1780000000000);
});

test('the OpenClaw cron route does not collect inventory or session evidence', async () => {
  let runtimeCalls = 0;
  let cronCalls = 0;
  const router = registerOpenClawOperations({
    express: fakeExpress(),
    logger: {},
    runtimeEvidenceProvider: async () => {
      runtimeCalls += 1;
      throw new Error('full runtime evidence must not be collected');
    },
    cronEvidenceProvider: async (options) => {
      cronCalls += 1;
      assert.equal(options.includeDisabledCron, true);
      return {
        authority: 'official-openclaw-cli',
        cron: { count: 1, jobs: [{ id: 'reminder', name: 'nestor-personal-morning', enabled: false }] }
      };
    }
  });
  const response = new Response();
  await route(router, 'get', '/cron').handlers[0](new Request({ query: { includeDisabled: 'true' } }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(runtimeCalls, 0);
  assert.equal(cronCalls, 1);
  assert.equal(response.jsonBody.count, 1);
  assert.equal(response.jsonBody.data[0].enabled, false);
});

test('trusted runtime launchers are two distinct provider-tagged doors without private locations', () => {
  const previous = {
    OPENCLAW_CONTROL_UI_PUBLIC_URL: process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
    DSH_STUDIO_PUBLIC_URL: process.env.DSH_STUDIO_PUBLIC_URL,
    DSH_STUDIO_ACCESS_SECRET: process.env.DSH_STUDIO_ACCESS_SECRET
  };
  process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL = 'https://openclaw-private.example:18789';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'secret-gateway-token-value';
  process.env.DSH_STUDIO_PUBLIC_URL = 'https://dsh-private.example';
  process.env.DSH_STUDIO_ACCESS_SECRET = 'test-access-secret-with-at-least-32-characters';
  try {
    const app = { use() {}, get() {} };
    manifest.register({
      contractVersion: 2,
      app,
      express: fakeExpress(),
      logger: {},
      runtimeServices: runtimeServices(async () => {}),
      standardJsonParser: { kind: 'standard-json-parser' }
    });
    const items = app.locals.trustedRuntimeNavItems;
    assert.deepEqual(items.map((item) => [item.id, item.label, item.href, item.owner]), [
      ['openclaw-runtime', 'OpenClaw', '/api/openclaw/control-launch/overview', 'AIOps'],
      ['dsh-studio', 'DSH Studio', '/api/dsh/control-launch', 'AIOps']
    ]);
    for (const item of items) {
      assert.ok(item.description && item.description.length <= 160);
      assert.doesNotMatch(JSON.stringify(item), /openclaw-private|dsh-private|secret-gateway-token-value|https?:\/\//);
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the OpenClaw launch preflight classifies server-side causes and never leaks the launch token', async () => {
  const previous = {
    OPENCLAW_CONTROL_UI_PUBLIC_URL: process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL,
    OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN
  };
  process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL = 'https://openclaw-private.example:18789';
  process.env.OPENCLAW_GATEWAY_TOKEN = 'secret-gateway-token-value';
  const build = (online) => registerOpenClawOperations({
    express: fakeExpress(),
    logger: {},
    runtimeEvidenceProvider: async () => {
      if (online === 'throw') throw new Error('evidence unavailable');
      return { status: { online } };
    },
    cronEvidenceProvider: async () => ({})
  });
  const run = async (router, target) => {
    const response = new Response();
    await route(router, 'get', '/control-launch-preflight/:target').handlers.at(-1)(new Request({ params: { target } }), response);
    return response;
  };
  try {
    const ok = await run(build(true), 'chat');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.jsonBody.status, 'ok');
    assert.equal(ok.jsonBody.launch.href, '/api/openclaw/control-launch/chat');
    assert.equal(ok.jsonBody.launch.host, 'openclaw-private.example');
    assert.deepEqual(ok.jsonBody.checks.map((check) => [check.id, check.state]), [['target', 'ok'], ['https', 'ok'], ['token', 'ok'], ['gateway', 'ok']]);
    assert.match(ok.jsonBody.browserHint, /ERR_BLOCKED_BY_CLIENT/);
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.doesNotMatch(JSON.stringify(ok.jsonBody), /secret-gateway-token-value|#token=|18789/);

    const badTarget = await run(build(true), 'not-a-capability');
    assert.equal(badTarget.jsonBody.status, 'blocked');
    assert.equal(badTarget.jsonBody.code, 'OPENCLAW_CONTROL_TARGET_INVALID');
    assert.equal(badTarget.jsonBody.launch.href, null);
    assert.equal(badTarget.jsonBody.browserHint, null);

    const offline = await run(build(false), 'chat');
    assert.equal(offline.jsonBody.status, 'blocked');
    assert.equal(offline.jsonBody.code, 'OPENCLAW_GATEWAY_OFFLINE');

    const unknown = await run(build('throw'), 'chat');
    assert.equal(unknown.jsonBody.status, 'ok', 'unavailable evidence is unknown, not a blocker');
    assert.deepEqual(unknown.jsonBody.checks.at(-1), { id: 'gateway', state: 'unknown', code: 'OPENCLAW_EVIDENCE_UNAVAILABLE' });

    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const noToken = await run(build(true), 'chat');
    assert.equal(noToken.jsonBody.status, 'blocked');
    assert.equal(noToken.jsonBody.code, 'OPENCLAW_CONTROL_TOKEN_UNAVAILABLE');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('current keyed agents retain their model and tools in the remote sanitized projection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-openclaw-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const agent = {
    model: { primary: 'ollama/local', fallbacks: ['ollama/backup'] },
    tools: { profile: 'minimal', alsoAllow: ['read', 'agentx__ecosystem_snapshot'] },
    identity: { name: 'Overseer', emoji: 'O' },
    apiKey: 'PRIVATE_FIXTURE_KEY',
  };
  fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify({
    auth: { token: 'PRIVATE_FIXTURE_TOKEN' },
    agents: { defaults: { model: { primary: 'ollama/default' } }, entries: { overseer: agent } },
  }));
  const command = buildRemoteAgentsConfigCommand(root);
  const python = command.slice(command.indexOf('\n') + 1, command.lastIndexOf('\nPY'));
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', python], {
    encoding: 'utf8',
    env: { ...process.env, AGENTX_OPENCLAW_HOME: root },
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const projected = JSON.parse(result.stdout);
  assert.equal(projected.list.length, 1);
  assert.equal(projected.list[0].id, 'overseer');
  assert.deepEqual(projected.list[0].model, agent.model);
  assert.deepEqual(projected.list[0].tools, agent.tools);
  assert.equal(result.stdout.includes('PRIVATE_FIXTURE'), false);
});

test('inventory normalizes current entries and preserves legacy lists', () => {
  const agent = { model: { primary: 'ollama/local' }, tools: { profile: 'minimal' } };
  assert.deepEqual(normalizeAgentsSection({ agents: { entries: { main: agent } } }).list,
    [{ ...agent, id: 'main' }]);
  const legacy = { defaults: {}, list: [{ ...agent, id: 'main' }] };
  assert.deepEqual(normalizeAgentsSection(legacy), legacy);
  assert.deepEqual(normalizeAgentsSection({ entries: { invalid: null, main: agent } }).list,
    [{ ...agent, id: 'main' }]);
});

test('ordinary OpenClaw tool loops receive done only after Core releases the previous admission', async () => {
  const upstream = new PassThrough();
  let release;
  const completion = new Promise(resolve => { release = resolve; });
  const router = registerOpenClawProtocol({ express: fakeExpress(), logger: {},
    runtimeServices: runtimeServices(async () => ({ ok: true, status: 200, stream: upstream, completion, metadata: {} })) });
  const res = new Response(), chunks = [];
  res.on('data', chunk => chunks.push(chunk.toString()));
  await route(router, 'post', '/api/chat').handlers[0](new Request({ body: { model: 'model-a', messages: [], stream: true } }), res);
  upstream.write('{"message":{"content":"Working"},"done":false}\n');
  upstream.end('{"message":{"tool_calls":[]},"done":true}\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.match(chunks.join(''), /Working/);
  assert.doesNotMatch(chunks.join(''), /"done":true/);
  assert.equal(res.writableEnded, false);
  const ended = once(res, 'end');
  release();
  await ended;
  assert.match(chunks.join(''), /"done":true/);
});
