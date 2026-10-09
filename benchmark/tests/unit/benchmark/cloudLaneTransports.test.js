'use strict';
const { normalizeCandidate } = require('../../../src/services/benchmark/cloudLaneAccounting');
const { createOllamaTransport, createOpenClawTransport } = require('../../../src/services/benchmark/cloudLaneTransports');
const DIGEST = 'b'.repeat(64);
function jsonResponse(body, { ok = true, status = 200 } = {}) { return { ok, status, statusText: ok ? 'OK' : 'Error', text: jest.fn(async () => JSON.stringify(body)) }; }
function localCandidate() { return normalizeCandidate({ id: 'local-ollama', tier: 'local', provider: 'ollama', model: 'qwen3:8b', modelVersion: 'qwen3-build-1', apiVersion: 'ollama-0.11.10', provenanceSource: 'local manifest', contextWindow: 32768, artifactDigest: DIGEST }, 'worker'); }
const contract = { maxOutputTokens: 64, temperature: 0, seed: 42, thinking: false, toolProtocol: 'openai-tools-v1' };
const fixture = { messages: [{ role: 'user', content: 'Call the room tool.' }], tools: [{ type: 'function', function: { name: 'room', parameters: { type: 'object' } } }], maxInputTokens: 128, maxCacheReadTokens: 0, maxCacheWriteTokens: 0 };
describe('local and OpenClaw campaign transports', () => {
    test('Ollama preflight verifies live digest, runtime version, and context before exact chat', async () => {
        const candidate = localCandidate();
        const fetchImpl = jest.fn(async (url, options) => {
            if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: candidate.model, digest: DIGEST }] });
            if (url.endsWith('/api/version')) return jsonResponse({ version: '0.11.10' });
            if (url.endsWith('/api/show')) {
                expect(JSON.parse(options.body)).toEqual({ model: candidate.model });
                return jsonResponse({ model_info: { 'qwen3.context_length': 32768 } });
            }
            const payload = JSON.parse(options.body);
            expect(payload).toMatchObject({
                model: candidate.model,
                stream: false,
                think: false,
                options: { num_predict: 64, num_ctx: 192, temperature: 0, seed: 42 }
            });
            return jsonResponse({
                done: true,
                message: { content: 'done', tool_calls: [{ function: { name: 'room', arguments: { name: 'kitchen' } } }] },
                prompt_eval_count: 9,
                eval_count: 2
            });
        });
        const transport = createOllamaTransport({ baseUrl: 'http://ollama.invalid:11434', fetchImpl });
        await expect(transport.execute({ candidate, fixture, contract })).rejects.toMatchObject({ code: 'PREFLIGHT_REQUIRED' });
        const identity = await transport.preflight({ candidate });
        const result = await transport.execute({ candidate, fixture, contract });

        expect(identity).toMatchObject({ artifactDigest: DIGEST, apiVersion: 'ollama-0.11.10', contextWindow: 32768 });
        expect(result).toMatchObject({
            ok: true,
            usage: { input: 9, output: 2, cacheRead: 0, cacheWrite: 0 },
            response: { text: 'done' }
        });
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    test('Ollama execution fails closed when HTTP 200 omits the exact terminal receipt', async () => {
        const candidate = localCandidate();
        const fetchImpl = jest.fn(async (url) => {
            if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: candidate.model, digest: DIGEST }] });
            if (url.endsWith('/api/version')) return jsonResponse({ version: '0.11.10' });
            if (url.endsWith('/api/show')) return jsonResponse({ model_info: { 'qwen3.context_length': 32768 } });
            return jsonResponse({ message: { content: 'plausible but incomplete' } });
        });
        const transport = createOllamaTransport({ baseUrl: 'http://ollama.invalid:11434', fetchImpl });
        await transport.preflight({ candidate });

        await expect(transport.execute({ candidate, fixture, contract })).resolves.toMatchObject({
            ok: false,
            error: { code: 'OLLAMA_RESPONSE_INCOMPLETE' }
        });
    });

});
