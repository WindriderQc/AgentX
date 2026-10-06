import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const withoutSecrets = value => {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:apiKey|token|authorization|headers|env|secret|password|agentDir|workspace)$/i.test(key))
    .map(([key, child]) => [key, withoutSecrets(child)]));
};

export async function loadNativeSdk() {
  const llmUrl = import.meta.resolve('openclaw/plugin-sdk/llm');
  const root = resolve(dirname(fileURLToPath(llmUrl)), '../..');
  const [sessions, agents, llm, auth, modelInfo, harness] = await Promise.all([
    import('openclaw/plugin-sdk/agent-sessions'), import('openclaw/plugin-sdk/agent-runtime'),
    import('openclaw/plugin-sdk/llm'), import('openclaw/plugin-sdk/provider-auth-runtime'),
    import('openclaw/plugin-sdk/provider-model-shared'), import('openclaw/plugin-sdk/agent-harness-runtime')
  ]);
  // This generic native parameter seam is not yet a public SDK export.
  // Check its named function rather than relying on a minified export alias.
  const files = (await readdir(join(root, 'dist'))).filter(name => /^extra-params-.*\.m?js$/.test(name));
  if (files.length !== 1) throw new Error('OPENCLAW_PARAMETER_API_UNAVAILABLE');
  const helper = join(root, 'dist', files[0]);
  const module = await import(pathToFileURL(helper));
  const applyExtraParams = Object.values(module).find(value => typeof value === 'function' && value.name === 'applyExtraParamsToAgent');
  if (!applyExtraParams) throw new Error('OPENCLAW_PARAMETER_API_UNAVAILABLE');
  const resolveExtraParams = Object.values(module).find(value => typeof value === 'function' && value.name === 'resolveExtraParams');
  if (!resolveExtraParams) throw new Error('OPENCLAW_PARAMETER_API_UNAVAILABLE');
  const pluginFingerprint = createHash('sha256').update(Buffer.concat(await Promise.all(
    ['native.mjs', 'service.mjs', 'index.mjs', 'openclaw.plugin.json'].map(file => readFile(new URL(file, import.meta.url)))
  ))).digest('hex');
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  return { ...sessions, ...agents, ...llm, ...auth, ...modelInfo, attachModelProviderRequestTransport: harness.attachModelProviderRequestTransport, applyExtraParams, resolveExtraParams,
    version, pluginFingerprint, parameterApiFingerprint: createHash('sha256').update(await readFile(helper)).digest('hex') };
}

export function billingFor(model, configured) {
  const declared = configured?.params?.billingKind || model.params?.billingKind;
  if (declared === 'included') return { kind: 'included', source: 'native-declared-subscription', rates: null };
  if (model.api === 'openai-chatgpt-responses') return { kind: 'included', source: 'native-subscription-route', rates: null };
  const rates = model.cost;
  if (rates && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => Number.isFinite(rates[key]) && rates[key] >= 0)) {
    if (Object.values(rates).some(value => typeof value === 'number' && value > 0)) return { kind: 'paid', source: 'openclaw-native-catalog', rates };
    if (declared === 'free' || model.id.endsWith(':free')) return { kind: 'free', source: 'openclaw-native-catalog-declared-free', rates };
  }
  return { kind: 'unknown', source: 'not-observed', rates: null };
}

function localModel(model, sdk, configured) {
  if (sdk.isCloudModelRef(model.id)) return false;
  if ((configured?.params?.executionOrigin || model.params?.executionOrigin) === 'local') return true;
  if (model.api !== 'ollama') return false;
  const host = new URL(model.baseUrl).hostname;
  return ['localhost', '::1', '[::1]'].includes(host) || /^(?:127|10)\.\d+\.\d+\.\d+$/.test(host)
    || /^192\.168\.\d+\.\d+$/.test(host) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host);
}

export function createNativeBackend(api, { loadSdk = loadNativeSdk } = {}) {
  let sdkPromise;
  const registries = new WeakMap();
  const sdkFor = () => sdkPromise ??= loadSdk();
  const configFor = () => api.runtime?.config?.current?.() || api.config;
  const idsFor = (cfg, sdk) => api.pluginConfig?.agentIds || sdk.listAgentIds(cfg);

  async function scopeFor(cfg, agentId, sdk) {
    let scopes = registries.get(cfg);
    if (!scopes) { scopes = new Map(); registries.set(cfg, scopes); }
    if (!scopes.has(agentId)) {
      const agentDir = sdk.resolveAgentDir(cfg, agentId);
      const workspaceDir = sdk.resolveAgentWorkspaceDir(cfg, agentId);
      // Native auth storage and native model registry: no provider SDK or key map here.
      const authStorage = sdk.AuthStorage.forAgent(agentDir, cfg);
      const registry = new sdk.ModelRegistry(authStorage, join(agentDir, 'models.json'), {
        config: cfg, workspaceDir, modelsJsonContents: JSON.stringify({ providers: cfg.models?.providers || {} })
      });
      if (registry.getError()) throw new Error('OPENCLAW_NATIVE_CATALOG_INVALID');
      scopes.set(agentId, { agentId, agentDir, workspaceDir, registry });
    }
    return scopes.get(agentId);
  }

  async function catalogue() {
    const sdk = await sdkFor(), cfg = configFor(), models = new Map(), agents = [];
    for (const agentId of idsFor(cfg, sdk)) {
      const scope = await scopeFor(cfg, agentId, sdk);
      const agentModel = sdk.resolveAgentEffectiveModelPrimary(cfg, agentId);
      agents.push({ agentId, model: agentModel || null, name: sdk.resolveAgentIdentity(cfg, agentId)?.name || agentId,
        fingerprint: fingerprint(withoutSecrets({ model: agentModel, agent: cfg.agents?.entries?.[agentId], defaults: cfg.agents?.defaults, tools: cfg.tools })) });
      for (const model of scope.registry.getAvailable()) {
        const ref = `${model.provider}/${model.id}`;
        const allowed = sdk.resolveAllowedModelRef({ cfg, agentId, raw: ref, catalog: scope.registry.getAll(),
          defaultProvider: model.provider, defaultModel: model.id });
        if (allowed.error || models.has(ref)) continue;
        const configured = cfg.models?.providers?.[model.provider]?.models?.find(entry => entry.id === model.id);
        const params = sdk.resolveExtraParams({ cfg, provider: model.provider, modelId: model.id, agentId }) || {};
        const providerParams = cfg.models?.providers?.[model.provider]?.params || {};
        const routing = params.provider || providerParams.provider || model.compat?.openRouterRouting || null;
        const local = localModel(model, sdk, configured);
        const billing = local ? { kind: 'local', source: 'native-local-model', rates: null } : billingFor(model, configured);
        models.set(ref, {
          model: ref, name: model.name || model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          input: model.input || ['text'], reasoning: Boolean(model.reasoning),
          parameterSupport: { jsonResponseFormat: model.api === 'openai-completions' ? true : null, thinking: Boolean(model.reasoning), temperature: model.api === 'openai-completions' ? true : null, seed: model.api === 'openai-completions' ? true : null, topP: model.api === 'openai-completions' ? true : null }, origin: local ? 'local' : 'cloud', billing,
          // The native catalogue describes an alias, not proof of a served revision.
          modelVersion: 'unknown', modelVersionSource: 'not-observed', authScope: agentId,
          isolation: { singleCallQualified: model.api === 'openai-completions', noMemory: true, noAgentPrompt: true, noTools: true, noRuntimeFallback: true,
            providerRouting: model.provider === 'openrouter' ? Boolean(routing?.allow_fallbacks === false && Array.isArray(routing?.only) && routing.only.length === 1 && typeof routing.only[0] === 'string' && routing.only[0].trim().length > 0) : true },
          fingerprint: fingerprint(withoutSecrets({ model, params, providerParams, runtimeVersion: sdk.version, parameterApi: sdk.parameterApiFingerprint, plugin: sdk.pluginFingerprint }))
        });
      }
    }
    for (const agent of agents) {
      const primary = models.get(agent.model);
      agent.origin = primary?.origin || 'unknown';
      agent.billing = { ...(primary?.billing || { kind: 'unknown' }), scope: 'primary-only' };
    }
    return { runtimeVersion: sdk.version, pluginFingerprint: sdk.pluginFingerprint, parameterApiFingerprint: sdk.parameterApiFingerprint, models: [...models.values()], agents };
  }

  async function prepare(ref, parameters = {}) {
    const sdk = await sdkFor(), cfg = configFor();
    const catalogueValue = await catalogue();
    const descriptor = catalogueValue.models.find(entry => entry.model === ref);
    if (!descriptor) throw new Error('OPENCLAW_MODEL_UNAVAILABLE');
    const scope = await scopeFor(cfg, descriptor.authScope, sdk);
    const slash = ref.indexOf('/');
    const model = scope.registry.find(ref.slice(0, slash), ref.slice(slash + 1));
    const auth = await sdk.getRuntimeAuthForModel({ model, cfg, workspaceDir: scope.workspaceDir });
    const keyAndHeaders = await scope.registry.getApiKeyAndHeaders(model);
    if (!keyAndHeaders.ok) throw new Error('OPENCLAW_AUTH_UNAVAILABLE');
    if (auth.baseUrl && auth.baseUrl !== model.baseUrl) throw new Error('OPENCLAW_AUTH_ROUTE_UNSUPPORTED');
    const selected = model;
    if (auth.request) sdk.attachModelProviderRequestTransport(selected, auth.request);
    const streamHost = { streamFn: sdk.streamSimple };
    const thinkingLevel = parameters.thinking === false ? 'off' : parameters.thinkingLevel || (parameters.thinking ? 'low' : undefined);
    const pureConfig = { ...cfg, tools: { ...cfg.tools, allow: [], deny: ['*'] } };
    // The native direct transport drops these SimpleStreamOptions. Its own
    // generic extra-body wrapper forwards this bounded API-level projection.
    const extraBody = model.api === 'openai-completions' ? {
      ...(parameters.seed != null ? { seed: parameters.seed } : {}),
      ...(parameters.topP != null ? { top_p: parameters.topP } : {}),
      ...(parameters.responseFormat === 'json' ? { response_format: { type: 'json_object' } } : {})
    } : {};
    const { effectiveExtraParams } = sdk.applyExtraParams(streamHost, pureConfig, model.provider, model.id,
      { ...parameters, ...(Object.keys(extraBody).length ? { extraBody } : {}), ...(parameters.responseFormat === 'json' ? { responseFormat: { type: 'json_object' } } : {}) },
      thinkingLevel, scope.agentId, scope.workspaceDir, selected, scope.agentDir, 'sse', { nativeWebSearchPolicyContext: {} });
    return { model: selected, descriptor, runtimeVersion: sdk.version, pluginFingerprint: sdk.pluginFingerprint, effectiveParameters: withoutSecrets(effectiveExtraParams || {}),
      stream: (context, options) => streamHost.streamFn(selected, context, { ...options, transport: 'sse',
        apiKey: auth.apiKey || keyAndHeaders.apiKey, headers: keyAndHeaders.headers,
        ...(thinkingLevel && thinkingLevel !== 'off' ? { reasoning: thinkingLevel } : {}) }) };
  }

  return { catalogue, prepare };
}
