'use strict';

const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = 120_000;

function transportError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function required(value, name) {
    const normalized = String(value == null ? '' : value).trim();
    if (!normalized) throw transportError('TRANSPORT_CONFIG_REQUIRED', `${name} is required`);
    return normalized;
}

function normalizedBaseUrl(value) {
    const url = new URL(required(value, 'baseUrl'));
    if (!['http:', 'https:'].includes(url.protocol)) throw transportError('INVALID_BASE_URL', 'baseUrl must use HTTP or HTTPS');
    return url.toString().replace(/\/$/, '');
}

async function fetchResponse(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function responseBody(response) {
    const rawText = await response.text();
    if (!rawText) return { parsed: {}, rawText: '' };
    try {
        return { parsed: JSON.parse(rawText), rawText };
    } catch (_) {
        return { parsed: null, rawText };
    }
}

function parseToolCalls(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((call) => {
        let args = call?.function?.arguments ?? call?.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = { _raw: args }; }
        }
        return {
            id: call?.id || null,
            name: String(call?.function?.name || call?.name || ''),
            arguments: args
        };
    });
}

function findOllamaModel(models, name) {
    return models.find((entry) => entry.name === name || entry.model === name);
}

function findContextWindow(modelInfo = {}) {
    const entry = Object.entries(modelInfo).find(([key, value]) => key.endsWith('.context_length') && Number.isFinite(Number(value)));
    return entry ? Number(entry[1]) : null;
}

function createOllamaTransport(config = {}) {
    const baseUrl = normalizedBaseUrl(config.baseUrl);
    const fetchImpl = config.fetchImpl || fetch;
    const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    let verifiedIdentity = null;
    return {
        async preflight({ candidate }) {
            if (candidate.provider !== 'ollama') throw transportError('PROVIDER_MISMATCH', `Ollama transport does not match ${candidate.id}`);
            const [tagsResponse, versionResponse, showResponse] = await Promise.all([
                fetchResponse(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET' }, timeoutMs),
                fetchResponse(fetchImpl, `${baseUrl}/api/version`, { method: 'GET' }, timeoutMs),
                fetchResponse(fetchImpl, `${baseUrl}/api/show`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: candidate.model })
                }, timeoutMs)
            ]);
            const [tags, version, show] = await Promise.all([
                responseBody(tagsResponse), responseBody(versionResponse), responseBody(showResponse)
            ]);
            if (!tagsResponse.ok || !versionResponse.ok || !showResponse.ok) {
                throw transportError('OLLAMA_PREFLIGHT_FAILED', `Ollama preflight failed for ${candidate.id}`, 502);
            }
            const installed = findOllamaModel(tags.parsed?.models || [], candidate.model);
            const digest = String(installed?.digest || '');
            const contextWindow = findContextWindow(show.parsed?.model_info);
            const apiVersion = `ollama-${String(version.parsed?.version || '')}`;
            if (!installed || digest !== candidate.artifactDigest || contextWindow !== candidate.contextWindow
                || apiVersion !== candidate.apiVersion) {
                throw transportError('OLLAMA_IDENTITY_DRIFT', `Ollama model, digest, context, or API version drifted for ${candidate.id}`, 409);
            }
            verifiedIdentity = {
                ready: true,
                checkedAt: new Date().toISOString(),
                provider: candidate.provider,
                model: candidate.model,
                modelVersion: candidate.modelVersion,
                apiVersion,
                contextWindow,
                artifactDigest: digest,
                priceSnapshot: null
            };
            return verifiedIdentity;
        },
        async execute({ candidate, fixture, contract }) {
            if (!verifiedIdentity) throw transportError('PREFLIGHT_REQUIRED', 'transport preflight must complete before execution');
            const payload = {
                model: candidate.model,
                messages: fixture.messages,
                stream: false,
                think: contract.thinking,
                options: {
                    num_predict: contract.maxOutputTokens,
                    num_ctx: Math.min(candidate.contextWindow, fixture.maxInputTokens + contract.maxOutputTokens),
                    temperature: contract.temperature,
                    ...(contract.seed != null ? { seed: contract.seed } : {})
                }
            };
            if (fixture.tools.length) payload.tools = fixture.tools;
            const started = Date.now();
            const response = await fetchResponse(fetchImpl, `${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            }, timeoutMs);
            const latencyMs = Date.now() - started;
            const { parsed, rawText } = await responseBody(response);
            const exactTerminal = response.ok
                && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && parsed.done === true && typeof parsed.error !== 'string';
            return {
                ok: exactTerminal,
                observedAt: new Date().toISOString(),
                latencyMs,
                identity: verifiedIdentity,
                usage: {
                    input: Number(parsed?.prompt_eval_count) || 0,
                    output: Number(parsed?.eval_count) || 0,
                    cacheRead: 0,
                    cacheWrite: 0
                },
                response: {
                    text: String(parsed?.message?.content || ''),
                    toolCalls: parseToolCalls(parsed?.message?.tool_calls),
                    raw: parsed || { body: rawText }
                },
                error: exactTerminal ? null : {
                    code: response.ok ? 'OLLAMA_RESPONSE_INCOMPLETE' : `HTTP_${response.status}`,
                    message: response.ok
                        ? 'Ollama chat ended without an exact terminal done object'
                        : String(parsed?.error || rawText || response.statusText)
                }
            };
        }
    };
}

module.exports = { createOllamaTransport, transportError, parseToolCalls,
    createOpenClawTransport: require('./openclawCloudLaneTransport').createOpenClawTransport };
