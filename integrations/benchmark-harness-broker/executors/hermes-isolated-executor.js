'use strict';

const crypto = require('node:crypto');

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return value === undefined ? 'null' : JSON.stringify(value);
}
const hash = (value) => crypto.createHash('sha256').update(stable(value)).digest('hex');

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main() {
  const input = await readInput();
  const target = input.target;
  if (target.mode !== 'isolated_model') throw new Error('Hermès isolated executor accepts only isolated_model targets');
  const baseUrl = String(process.env.HERMES_BENCHMARK_BASE_URL || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('HERMES_BENCHMARK_BASE_URL is required');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(input.parameters?.timeoutMs) || 600000);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.HERMES_BENCHMARK_TOKEN ? { Authorization: `Bearer ${process.env.HERMES_BENCHMARK_TOKEN}` } : {})
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: String(input.input?.prompt || '') }],
        stream: false,
        temperature: input.parameters?.temperature,
        top_p: input.parameters?.topP,
        seed: input.parameters?.seed,
        max_tokens: input.parameters?.maxTokens,
        response_format: input.parameters?.responseFormat === 'json' ? { type: 'json_object' } : undefined
      })
    });
  } finally { clearTimeout(timeout); }
  if (!response.ok) throw new Error(`Hermès isolated endpoint HTTP ${response.status}`);
  const fallbackHeader = response.headers.get('x-agentx-fallback-used');
  const resolvedModel = response.headers.get('x-resolved-model') || '';
  const resolvedModelVersion = response.headers.get('x-agentx-resolved-model-version') || '';
  const resolvedProvider = response.headers.get('x-agentx-resolved-provider') || '';
  const harnessVersion = response.headers.get('x-agentx-harness-version') || '';
  if (fallbackHeader !== 'false' || resolvedModel !== target.model || resolvedModelVersion !== target.modelVersion || resolvedProvider !== target.provider || harnessVersion !== target.harness.version) throw new Error('Hermès endpoint did not prove exact harness/provider/model no-fallback execution');
  const body = await response.json();
  if (body.model !== target.model) throw new Error('Hermès response model differs from target');
  const output = String(body.choices?.[0]?.message?.content || '');
  const usageRaw = body.usage || {};
  const inputTokens = Number(usageRaw.prompt_tokens || 0);
  const outputTokens = Number(usageRaw.completion_tokens || 0);
  const price = target.pricing || {};
  const costNanodollars = Number(price.callNanodollars || 0)
    + Math.ceil(inputTokens * Number(price.inputNanodollarsPerMillion || 0) / 1000000)
    + Math.ceil(outputTokens * Number(price.outputNanodollarsPerMillion || 0) / 1000000);
  process.stdout.write(JSON.stringify({
    requestFingerprint: hash({ targetFingerprint: target.fingerprint, envelopeFingerprint: input.envelope.fingerprint, promptFingerprint: input.envelope.prompt.fingerprint }),
    responseFingerprint: hash(output), output, thinking: null,
    finishReason: body.choices?.[0]?.finish_reason || null, fallbackUsed: false,
    actual: {
      provider: resolvedProvider, providerVersion: 'openai-compatible', model: body.model,
      modelVersion: resolvedModelVersion, harnessVersion, adapterVersion: '1.0.0',
      environmentId: target.profile.id, environmentVersion: target.profile.version,
      environmentFingerprint: process.env.AGENTX_OBSERVED_PROFILE_FINGERPRINT || null,
      runtimeFingerprint: process.env.AGENTX_OBSERVED_RUNTIME_FINGERPRINT || null, modelDigest: null
    },
    usage: { durationMs: Date.now() - started, inputTokens, outputTokens, costNanodollars, turns: 1, toolCalls: 0 }
  }));
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
