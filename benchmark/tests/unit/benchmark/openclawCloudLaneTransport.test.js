'use strict';
const { createOpenClawTransport } = require('../../../src/services/benchmark/cloudLaneTransports');
const { normalizeCandidate } = require('../../../src/services/benchmark/cloudLaneAccounting');
const modelFingerprint = 'a'.repeat(64);
const rates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const model = { model: 'openrouter/vendor/model:free', modelVersion: 'unknown', contextWindow: 8192, origin: 'cloud',
    billing: { kind: 'free', source: 'native', rates }, fingerprint: modelFingerprint, isolation: { singleCallQualified: true, providerRouting: true } };
const candidate = normalizeCandidate({ id: 'cloud', tier: 'free_cloud', provider: 'openrouter', model: 'vendor/model:free', modelVersion: 'unknown',
    contextWindow: 8192, apiVersion: 'openclaw-model-sdk-2026.9.4', provenanceSource: 'OpenClaw',
    priceSnapshot: { provider: 'openrouter', model: 'vendor/model:free', modelVersion: 'unknown', effectiveAt: '2026-10-01T00:00:00Z', source: 'openclaw-native-catalog', rates } }, 'worker');
const fixture = { messages: [{ role: 'user', content: 'Call room.' }], tools: [{ type: 'function', function: { name: 'room', parameters: { type: 'object' } } }] };
const contract = { maxOutputTokens: 64, temperature: 0, seed: null, thinking: false };

function setup() {
    const result = { text: '', toolCalls: [{ name: 'room', arguments: { room: 'kitchen' } }], finishReason: 'toolUse',
        receipt: { targetFingerprint: modelFingerprint, observed: { provider: 'openrouter', model: 'vendor/model:free' }, billing: model.billing,
            durationMs: 2, usage: { input: 7, output: 2, cacheRead: 3, cacheWrite: 0, total: 12 },
            isolation: { noMemory: true, noAgentPrompt: true, noRuntimeFallback: true, noTools: false, toolsExecuted: 0, modelCalls: 1,
                providerRouting: { only: ['fixture'], allow_fallbacks: false } } } };
    const client = { catalog: jest.fn(async () => ({ runtimeVersion: '2026.9.4', observedAt: '2026-10-01T00:00:00Z', models: [model] })), execute: jest.fn(async () => result) };
    return { client, result, transport: createOpenClawTransport({ modelFingerprint, client }) };
}
test('native source preserves protocol tool fixtures without executing tools or claiming an agent benchmark', async () => {
    const { transport, client } = setup();
    await transport.preflight({ candidate }); const result = await transport.execute({ candidate, fixture, contract });
    expect(client.execute.mock.calls[0][0]).toMatchObject({ messages: fixture.messages, tools: fixture.tools,
        execution: { source: 'openclaw', mode: 'model', model: model.model } });
    expect(result).toMatchObject({ ok: true, usage: { cacheRead: 3 }, response: { toolCalls: [{ name: 'room' }] } });
    expect(result.response.raw.receipt.isolation.noTools).toBe(false);
});
test('catalogue identity or price drift blocks dispatch', async () => {
    const { transport, client } = setup();
    await expect(transport.preflight({ candidate: { ...candidate, modelVersion: 'fabricated-revision' } })).rejects.toMatchObject({ code: 'OPENCLAW_TARGET_DRIFT' });
    expect(client.execute).not.toHaveBeenCalled();
});
test('native tool execution or fallback cannot be passed off as a protocol model result', async () => {
    const { transport, result } = setup(); await transport.preflight({ candidate }); result.receipt.isolation.toolsExecuted = 1;
    await expect(transport.execute({ candidate, fixture, contract })).rejects.toMatchObject({ code: 'OPENCLAW_ISOLATION_UNVERIFIED' });
});
