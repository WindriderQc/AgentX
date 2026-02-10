/**
 * Quick Scorer
 * Pattern-based fast scoring for simple factual answers
 */

const logger = require('../../../config/logger');
const { tryParseJson, jsonDeepEqual } = require('./jsonUtils');

/**
 * Quick scoring for simple factual answers
 * Uses pattern matching and JSON comparison before calling LLM judge
 * Only triggers when prompt has expected_answer defined
 */
function quickScore(response, prompt) {
    const expectedAnswer = prompt.expected_answer || prompt.expected;
    if (!expectedAnswer) {
        return null;
    }

    // Try JSON comparison first
    const expectedJson = tryParseJson(expectedAnswer);
    const responseJson = tryParseJson(response);

    if (expectedJson.success && responseJson.success) {
        const isEqual = jsonDeepEqual(expectedJson.value, responseJson.value);
        logger.info('Quick JSON scoring', {
            matched: isEqual,
            expectedType: Array.isArray(expectedJson.value) ? 'array' : typeof expectedJson.value,
            responseType: Array.isArray(responseJson.value) ? 'array' : typeof responseJson.value
        });
        return {
            quick: true,
            score: isEqual ? 10 : 0,
            expected: expectedAnswer,
            matched: isEqual,
            pattern: 'json_exact_match',
            comparison: {
                expected: expectedJson.value,
                received: responseJson.value
            }
        };
    }

    const resp = response.toLowerCase().trim();

    const quickPatterns = {
        'capital of france': { answer: 'paris', score: /\bparis\b/.test(resp) ? 10 : 0 },
        '15 + 27': { answer: '42', score: /\b42\b/.test(resp) ? 10 : 0 },
        '15+27': { answer: '42', score: /\b42\b/.test(resp) ? 10 : 0 },
        'world war ii end': { answer: '1945', score: /\b1945\b/.test(resp) ? 10 : 0 },
        'wwii end': { answer: '1945', score: /\b1945\b/.test(resp) ? 10 : 0 },
        '2, 4, 8, 16': { answer: '32', score: /\b32\b/.test(resp) ? 10 : 0 },
        '2x + 5 = 17': { answer: '6', score: /\bx\s*=\s*6\b|\b6\b/.test(resp) ? 10 : 0 }
    };

    const promptText = prompt.prompt || (typeof prompt === 'string' ? prompt : '');
    const promptLower = promptText.toLowerCase();

    for (const [pattern, check] of Object.entries(quickPatterns)) {
        if (promptLower.includes(pattern)) {
            logger.info('Quick scoring match', { pattern, score: check.score, expected: check.answer });
            return {
                quick: true,
                score: check.score,
                expected: check.answer,
                matched: check.score === 10,
                pattern
            };
        }
    }

    return null;
}

module.exports = { quickScore };
