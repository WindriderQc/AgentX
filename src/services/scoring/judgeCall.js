/**
 * Judge Call
 * HTTP call to LLM judge model with retry/timeout and response parsing
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { benchmarkFetch: fetch } = require('../benchmark/http');

// Judge model configuration
// Default: 7B model — fits on most hosts without stealing context from the
// model being tested. Upgrade per-batch via judge_config or tier resolver.
const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q5_K_M',
    host: null,
    timeout: 30000,
    temperature: 0.1,
    num_predict: 800,
    max_retries: 2,
    tier: 'standard'
};

// Track judge failures for observability
let judgeFailureCount = 0;

/**
 * Normalize a raw host value to a full URL (adds http:// if missing).
 * Wildcard bind addresses (0.0.0.0, ::) are remapped to 127.0.0.1.
 */
function normalizeJudgeHost(rawValue) {
    if (!rawValue) return null;
    const trimmed = String(rawValue).trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    try {
        const u = new URL(withScheme);
        if (u.hostname === '0.0.0.0' || u.hostname === '::' || u.hostname === '[::]') {
            u.hostname = '127.0.0.1';
        }
        return u.toString().replace(/\/$/, '');
    } catch {
        return withScheme;
    }
}

// Initialize JUDGE_CONFIG.host from environment on module load
if (process.env.OLLAMA_HOST) {
    JUDGE_CONFIG.host = normalizeJudgeHost(process.env.OLLAMA_HOST);
}

function getJudgeFailureCount() {
    return judgeFailureCount;
}

function incrementJudgeFailureCount() {
    judgeFailureCount += 1;
    return judgeFailureCount;
}

/**
 * Build a dynamic judge prompt from scoring dimensions
 */
function buildDynamicJudgePrompt(dimensions, task, expected, response, options = {}) {
    const criteriaList = dimensions.map((dim, idx) => {
        return `${idx + 1}. ${dim.name.replace(/_/g, ' ')} (0-10): ${dim.desc}`;
    }).join('\n');

    const jsonFormat = dimensions.reduce((acc, dim) => {
        acc[dim.name] = 'X';
        return acc;
    }, {});
    jsonFormat.overall = 'X';
    jsonFormat.explanation = 'brief reason';

    const hintsSection = options.judgeHints
        ? `\n${options.judgeHints}\n`
        : '';

    return `You are a strict quality evaluator. Score each dimension INDEPENDENTLY - a wrong value does not mean the format is wrong. Analyze the given response and score it across multiple dimensions.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all dimensions - the model failed to produce output.
${hintsSection}
CRITERIA TO EVALUATE:
${criteriaList}

TASK: ${task}
EXPECTED: ${expected}
RESPONSE TO EVALUATE:
${response}

CRITICAL INSTRUCTIONS:
1. Score each criterion on a 0-10 scale (integers or decimals)
2. The 'overall' score must ALSO be 0-10 (weighted average, NOT a sum)
3. You MUST respond with a JSON object (not an array, not text)
4. Every dimension must have a numeric score

Respond ONLY with a JSON object in this EXACT format (replace X with actual numbers):
${JSON.stringify(jsonFormat, null, 2)}

Do NOT respond with just keys, do NOT respond with an array, do NOT add explanatory text outside the JSON.`;
}

/**
 * Extract the first balanced JSON object from text using brace counting.
 * Handles cases where judge preamble contains braces in explanatory text.
 * @param {string} text - Raw judge response text
 * @returns {string|null} Extracted JSON string or null
 */
function extractBalancedJson(text) {
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = firstBrace; i < text.length; i++) {
        const ch = text[i];

        if (escaped) {
            escaped = false;
            continue;
        }

        if (ch === '\\' && inString) {
            escaped = true;
            continue;
        }

        if (ch === '"') {
            inString = !inString;
            continue;
        }

        if (inString) continue;

        if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return text.substring(firstBrace, i + 1);
            }
        }
    }

    // No balanced object found from firstBrace — fall back to last brace
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > firstBrace) {
        return text.substring(firstBrace, lastBrace + 1);
    }

    return null;
}

/**
 * Check if a judge error message is retryable.
 * Retries on: network errors, HTTP 5xx, aborted requests (timeout-triggered),
 * and JSON parse/extraction failures.
 * @param {string} message - Error message
 * @returns {boolean}
 */
function isRetryableError(message) {
    return message.includes('timeout') ||
           message.includes('aborted') ||
           message.includes('AbortError') ||
           message.includes('ECONNRESET') ||
           message.includes('ECONNREFUSED') ||
           message.includes('ETIMEDOUT') ||
           message.startsWith('Judge HTTP 5') ||
           message.includes('No JSON found') ||
           message.includes('JSON parse failed') ||
           message.includes('returned non-object') ||
           message.includes('returned array');
}

/**
 * Call the judge model to evaluate a response
 */
async function callJudge(evalPrompt, config = {}, retryCount = 0) {
    const judgeConfig = { ...JUDGE_CONFIG, ...config };
    judgeConfig.host = normalizeJudgeHost(judgeConfig.host);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout);

    try {
        if (!judgeConfig.host) {
            throw new Error('Judge host is not configured');
        }
        const url = `${judgeConfig.host}/api/chat`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                messages: [{ role: 'user', content: evalPrompt }],
                stream: false,
                options: {
                    temperature: judgeConfig.temperature,
                    num_predict: judgeConfig.num_predict,
                    num_ctx: 8192
                }
            }),
            signal: controller.signal
        });
        const response = await fetch(url, fetchOptions);

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Judge HTTP ${response.status}`);
        }

        const data = await response.json();
        const text = data.message?.content || data.response || '';

        const judgeTruncated = data.done_reason === 'length';
        const judgeTokens = data.eval_count || 0;

        // Retry with expanded num_predict on truncation before attempting parse
        if (judgeTruncated && retryCount < (judgeConfig.max_retries || 2)) {
            logger.warn('Judge output truncated, retrying with expanded num_predict', {
                judge_model: judgeConfig.model || JUDGE_CONFIG.model,
                original_num_predict: judgeConfig.num_predict || JUDGE_CONFIG.num_predict,
                expanded_num_predict: (judgeConfig.num_predict || JUDGE_CONFIG.num_predict) * 2,
                attempt: retryCount + 1
            });
            const expandedConfig = { ...config, num_predict: (judgeConfig.num_predict || JUDGE_CONFIG.num_predict) * 2 };
            return callJudge(evalPrompt, expandedConfig, retryCount + 1);
        }

        let jsonStr = null;

        const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1];
        } else {
            jsonStr = extractBalancedJson(text);
        }

        if (!jsonStr) {
            logger.error('Judge response format - no JSON found', {
                fullResponse: text,
                responseLength: text.length,
                containsBraces: text.includes('{') && text.includes('}'),
                containsCodeBlock: text.includes('```'),
                judge_model: judgeConfig.model || JUDGE_CONFIG.model
            });
            throw new Error('No JSON found in judge response');
        }

        logger.debug('Judge JSON extraction', {
            length: jsonStr.length,
            preview: jsonStr.substring(0, 200)
        });

        try {
            let sanitized = jsonStr.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
            sanitized = sanitized.replace(/\\([^"\\/bfnrtu])/g, "\\\\$1");

            let scores = JSON.parse(sanitized);

            if (typeof scores !== 'object' || scores === null) {
                throw new Error('Judge returned non-object response');
            }

            if (Array.isArray(scores)) {
                throw new Error(`Judge returned array instead of JSON object. Array content: ${JSON.stringify(scores).substring(0, 200)}`);
            }

            // Coerce string numbers to actual numbers
            const coercedScores = {};
            for (const [key, value] of Object.entries(scores)) {
                if (typeof value === 'number') {
                    coercedScores[key] = value;
                } else if (typeof value === 'string') {
                    const trimmed = value.trim();
                    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                        coercedScores[key] = parseFloat(trimmed);
                    } else {
                        coercedScores[key] = value;
                    }
                } else {
                    coercedScores[key] = value;
                }
            }
            scores = coercedScores;

            const numericFields = Object.keys(scores).filter(key =>
                typeof scores[key] === 'number' && key !== 'overall'
            );

            if (numericFields.length === 0 && typeof scores.overall !== 'number') {
                const receivedKeys = Object.keys(scores);
                const receivedTypes = receivedKeys.map(k => `${k}:${typeof scores[k]}`).join(', ');
                throw new Error(`Judge response missing numeric scores after coercion. Received ${receivedKeys.length} keys. Types: [${receivedTypes}]`);
            }

            return {
                success: true,
                scores,
                raw: text,
                judge_truncated: judgeTruncated,
                judge_tokens: judgeTokens
            };
        } catch (parseErr) {
            logger.error('JSON parse error details', {
                error: parseErr.message,
                jsonPreview: jsonStr.substring(0, 500),
                fullText: text.substring(0, 1000)
            });
            throw new Error(`JSON parse failed: ${parseErr.message}`);
        }

    } catch (err) {
        clearTimeout(timeoutId);

        const maxRetries = judgeConfig.max_retries || 2;
        const isRetryable = isRetryableError(err.message);

        if (isRetryable && retryCount < maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 5000);
            logger.warn(`Judge call failed, retrying in ${backoffMs}ms`, {
                error: err.message,
                attempt: retryCount + 1,
                maxRetries
            });
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return callJudge(evalPrompt, config, retryCount + 1);
        }

        logger.error('Judge call failed', { error: err.message, retries: retryCount });
        return {
            success: false,
            error: err.message,
            scores: null
        };
    }
}

module.exports = {
    JUDGE_CONFIG,
    callJudge,
    buildDynamicJudgePrompt,
    extractBalancedJson,
    isRetryableError,
    getJudgeFailureCount,
    incrementJudgeFailureCount,
    normalizeJudgeHost
};
