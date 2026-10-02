'use strict';

const crypto = require('node:crypto');
const { verifyAgentXClaim } = require('../../../shared/agentxClaimAttestation');

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stable(value)).digest('hex');
}

async function readInput(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseRuntimeArgs(argv = process.argv.slice(2)) {
  const options = { baseUrlEnvironment: null, versionEnvironment: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    index += 1;
    if (index >= argv.length) throw new Error(`${flag} requires a value`);
    const value = String(argv[index]);
    if (flag === '--base-url-env') options.baseUrlEnvironment = value;
    else if (flag === '--version-env') options.versionEnvironment = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  for (const [label, value] of Object.entries(options)) {
    if (!/^[A-Z][A-Z0-9_]{0,79}$/.test(value || '')) {
      throw new Error(`${label} must name an allowlisted environment variable`);
    }
  }
  return options;
}

function exactInstalledModel(tagsBody, target) {
  const models = Array.isArray(tagsBody?.models) ? tagsBody.models : [];
  const matches = models.filter(model => model?.name === target.model);
  if (matches.length !== 1) throw new Error('Ollama catalog does not contain exactly one requested model');
  const digest = String(matches[0].digest || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('Ollama model digest is unavailable');
  const modelDigest = `sha256:${digest}`;
  if (target.modelVersion !== `manifest-${digest}`) {
    throw new Error('Ollama target modelVersion does not match its installed manifest digest');
  }
  return { digest, modelDigest };
}

async function fetchJson(url, options, fetchImplementation) {
  const response = await fetchImplementation(url, options);
  if (!response?.ok) throw new Error(`Ollama endpoint HTTP ${response?.status || 'unavailable'}`);
  return response.json();
}

async function execute(input, options = {}) {
  const target = input?.target;
  if (target?.executionKind !== 'harness'
      || target.mode !== 'isolated_model'
      || target.tier !== 'local'
      || target.provider !== 'ollama'
      || target.pricing !== null) {
    throw new Error('Ollama isolated executor accepts only unpriced local isolated harness targets');
  }
  const baseUrl = String(options.baseUrl || process.env.OLLAMA_BENCHMARK_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\/[a-zA-Z0-9._:[\]-]+(?::\d+)?$/.test(baseUrl)) {
    throw new Error('OLLAMA_BENCHMARK_BASE_URL is required and must contain only an origin');
  }
  const fetchImplementation = options.fetch || globalThis.fetch;
  if (typeof fetchImplementation !== 'function') throw new Error('fetch implementation is unavailable');
  const timeoutMs = Math.min(900_000, Math.max(30_000, Number(input.parameters?.timeoutMs) || 600_000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const before = exactInstalledModel(
      await fetchJson(`${baseUrl}/api/tags`, { signal: controller.signal }, fetchImplementation),
      target
    );
    if (!DIGEST_PATTERN.test(before.modelDigest)) throw new Error('Ollama model digest is invalid');
    const verifyClaim = options.verifyClaim || (() => verifyAgentXClaim(baseUrl, {
      fetchImpl: options.claimFetch || globalThis.fetch,
      coreUrl: process.env.AGENTX_CLAIM_CORE_URL || process.env.AGENTX_CORE_URL,
    }));
    await verifyClaim(baseUrl);
    const body = await fetchJson(`${baseUrl}/api/chat`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: String(input.input?.prompt || '') }],
        stream: false,
        think: false,
        format: input.parameters?.responseFormat === 'json' ? 'json' : undefined,
        options: {
          temperature: input.parameters?.temperature,
          top_p: input.parameters?.topP,
          seed: input.parameters?.seed,
          num_predict: input.parameters?.maxTokens,
          num_ctx: Number(target.contextWindow),
        },
      }),
    }, fetchImplementation);
    const after = exactInstalledModel(
      await fetchJson(`${baseUrl}/api/tags`, { signal: controller.signal }, fetchImplementation),
      target
    );
    if (before.modelDigest !== after.modelDigest) throw new Error('Ollama model digest changed during execution');
    if (body?.model !== target.model) throw new Error('Ollama response model differs from the exact target');
    const output = String(body?.message?.content || '');
    const inputTokens = Number(body?.prompt_eval_count || 0);
    const outputTokens = Number(body?.eval_count || 0);
    return {
      requestFingerprint: fingerprint({
        targetFingerprint: target.fingerprint,
        envelopeFingerprint: input.envelope.fingerprint,
        promptFingerprint: input.envelope.prompt.fingerprint,
      }),
      responseFingerprint: fingerprint(output),
      output,
      thinking: null,
      finishReason: body?.done_reason || null,
      fallbackUsed: false,
      actual: {
        provider: 'ollama',
        providerVersion: String(options.providerVersion || process.env.OLLAMA_BENCHMARK_VERSION || 'api-v1'),
        model: target.model,
        modelVersion: target.modelVersion,
        harnessVersion: target.harness.version,
        adapterVersion: target.adapter.version,
        environmentId: target.profile.id,
        environmentVersion: target.profile.version,
        environmentFingerprint: process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT || null,
        runtimeFingerprint: process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT || null,
        modelDigest: before.modelDigest,
      },
      usage: {
        durationMs: Date.now() - started,
        inputTokens,
        outputTokens,
        costNanodollars: 0,
        turns: 1,
        toolCalls: 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const runtime = parseRuntimeArgs();
  const result = await execute(await readInput(), {
    baseUrl: process.env[runtime.baseUrlEnvironment],
    providerVersion: process.env[runtime.versionEnvironment],
  });
  process.stdout.write(JSON.stringify(result));
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DIGEST_PATTERN,
  exactInstalledModel,
  execute,
  fingerprint,
  parseRuntimeArgs,
  readInput,
};
