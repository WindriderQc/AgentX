'use strict';

const { createOpenClawExecutionClient } = require('../../../../shared/openclawExecutionClient');
const { fingerprint, nativeModelSpendBound } = require('./cloudLaneAccounting');

function reject(code) { throw Object.assign(new Error(code), { code, statusCode: 409 }); }

function createOpenClawTransport({ modelFingerprint, timeoutMs = 120000, environment = process.env,
    client = createOpenClawExecutionClient({ env: environment }) } = {}) {
    if (!/^[a-f0-9]{64}$/.test(modelFingerprint || '')) reject('OPENCLAW_MODEL_FINGERPRINT_REQUIRED');
    let verified, descriptor;
    return {
        async preflight({ candidate }) {
            const catalog = await client.catalog();
            descriptor = catalog.models.find(model => model.model === `${candidate.provider}/${candidate.model}`);
            const tier = descriptor?.origin === 'local' ? 'local' : descriptor?.billing?.kind === 'paid' ? 'paid_cloud' : 'free_cloud';
            if (!descriptor || descriptor.fingerprint !== modelFingerprint || candidate.tier !== tier
                || !['free', 'included', 'paid', 'local'].includes(descriptor.billing?.kind)
                || candidate.apiVersion !== `openclaw-model-sdk-${catalog.runtimeVersion}`
                || candidate.modelVersion !== descriptor.modelVersion || candidate.contextWindow !== descriptor.contextWindow
                || !descriptor.isolation?.providerRouting || !descriptor.isolation?.singleCallQualified) reject('OPENCLAW_TARGET_DRIFT');
            if (candidate.priceSnapshot) {
                const rates = descriptor.billing.rates || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                const nativeRates = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite'].map(key => [key, Math.ceil(rates[key] * 1e9)]));
                if (fingerprint(nativeRates) !== fingerprint(candidate.priceSnapshot.rates)
                    || candidate.priceSnapshot.source !== 'openclaw-native-catalog') reject('OPENCLAW_PRICE_DRIFT');
            }
            verified = { ready: true, checkedAt: catalog.observedAt, provider: candidate.provider, model: candidate.model,
                modelVersion: descriptor.modelVersion, apiVersion: candidate.apiVersion, contextWindow: descriptor.contextWindow,
                artifactDigest: null, priceSnapshot: candidate.priceSnapshot };
            return verified;
        },
        async execute({ fixture, contract }) {
            if (!verified) reject('PREFLIGHT_REQUIRED');
            const maxCostNanodollars = descriptor.billing.kind === 'paid'
                ? nativeModelSpendBound(verified, contract.maxOutputTokens) : 0;
            const result = await client.execute({ execution: { source: 'openclaw', mode: 'model', model: descriptor.model },
                messages: fixture.messages, tools: fixture.tools, expectedFingerprint: modelFingerprint,
                parameters: { maxTokens: contract.maxOutputTokens, temperature: contract.temperature, seed: contract.seed,
                    thinking: contract.thinking, timeoutMs }, budget: { maxCalls: 1, maxCostNanodollars } }, { timeoutMs });
            const receipt = result.receipt, isolation = receipt?.isolation;
            if (receipt.targetFingerprint !== modelFingerprint || receipt.observed?.provider !== verified.provider
                || receipt.observed?.model !== verified.model || !isolation?.noMemory || !isolation.noAgentPrompt
                || !isolation.noRuntimeFallback || isolation.modelCalls !== 1 || isolation.toolsExecuted !== 0
                || (!fixture.tools.length && !isolation.noTools)) reject('OPENCLAW_ISOLATION_UNVERIFIED');
            if (verified.provider === 'openrouter' && (isolation.providerRouting?.allow_fallbacks !== false
                || isolation.providerRouting.only?.length !== 1)) reject('OPENCLAW_PROVIDER_ROUTING_UNPINNED');
            if (fingerprint(receipt.billing) !== fingerprint(descriptor.billing)) reject('OPENCLAW_PRICE_DRIFT');
            const usage = receipt.usage;
            if (['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some(key => !Number.isSafeInteger(usage?.[key]) || usage[key] < 0)) reject('OPENCLAW_USAGE_UNVERIFIED');
            return { ok: ['stop', 'toolUse'].includes(result.finishReason), observedAt: new Date().toISOString(), latencyMs: receipt.durationMs,
                identity: verified, usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
                response: { text: result.text, toolCalls: result.toolCalls || [], raw: { receipt, finishReason: result.finishReason } },
                error: ['stop', 'toolUse'].includes(result.finishReason) ? null : { code: 'MODEL_TERMINATION_INCOMPLETE', message: 'Model termination was incomplete.' } };
        }
    };
}
module.exports = { createOpenClawTransport };
