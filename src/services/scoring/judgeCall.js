/**
 * Judge Call
 * HTTP call to LLM judge model with retry/timeout and response parsing
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');

// Judge model configuration
const JUDGE_CONFIG = {
    model: 'qwen2.5:14b-instruct-q4_K_M',
    host: null,
    timeout: 120000,
    temperature: 0.3,
    num_predict: 800,
    max_retries: 2
};

// Track judge failures for observability
let judgeFailureCount = 0;

// Initialize host from env
if (process.env.OLLAMA_HOST) {
    JUDGE_CONFIG.host = process.env.OLLAMA_HOST;
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

    return `You are a quality evaluator. Analyze the given response and score it across multiple dimensions.

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
 * Call the judge model to evaluate a response
 */
async function callJudge(evalPrompt, config = {}, retryCount = 0) {
    const judgeConfig = { ...JUDGE_CONFIG, ...config };
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout);

    try {
        const url = `${judgeConfig.host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                prompt: evalPrompt,
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
        const text = data.response || '';

        const judgeTruncated = data.done_reason === 'length';
        const judgeTokens = data.eval_count || 0;

        let jsonStr = null;

        const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch) {
            jsonStr = codeBlockMatch[1];
        } else {
            const firstBrace = text.indexOf('{');
            const lastBrace = text.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                jsonStr = text.substring(firstBrace, lastBrace + 1);
            }
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
        const isRetryable = err.message.includes('timeout') ||
                           err.message.includes('ECONNRESET') ||
                           err.message.includes('ETIMEDOUT') ||
                           err.message.includes('500') ||
                           err.message.includes('503') ||
                           err.message.includes('502');

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
    getJudgeFailureCount,
    incrementJudgeFailureCount
};
