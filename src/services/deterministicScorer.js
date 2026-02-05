/**
 * Deterministic Scorer Service
 * Handles scoring cases where LLM judgment is unnecessary
 * - Exact match: Normalize & compare strings
 * - Numeric eval: Parse and evaluate math expressions
 * - JSON compare: Already exists (jsonDeepEqual)
 * - Regex patterns: Must contain X, must not contain Y
 */

const logger = require('../../config/logger');

/**
 * Normalize a string for comparison
 * - Lowercase
 * - Trim whitespace
 * - Collapse multiple spaces
 * - Remove common punctuation variations
 * @param {string} str - String to normalize
 * @returns {string} Normalized string
 */
function normalizeString(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .toLowerCase()
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[.,!?;:'"]/g, '');
}

/**
 * Exact match scoring
 * Normalizes both strings and compares
 * @param {string} response - Model response
 * @param {string} expected - Expected answer
 * @param {Object} options - { caseSensitive: boolean, trimOnly: boolean }
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function exactMatch(response, expected, options = {}) {
    const { caseSensitive = false, trimOnly = false } = options;

    let respNorm, expNorm;
    if (trimOnly) {
        respNorm = response?.trim() || '';
        expNorm = expected?.trim() || '';
        if (!caseSensitive) {
            respNorm = respNorm.toLowerCase();
            expNorm = expNorm.toLowerCase();
        }
    } else {
        respNorm = caseSensitive ? (response?.trim() || '') : normalizeString(response);
        expNorm = caseSensitive ? (expected?.trim() || '') : normalizeString(expected);
    }

    const matched = respNorm === expNorm;

    return {
        score: matched ? 10 : 0,
        matched,
        method: 'exact_match',
        details: matched
            ? 'Response exactly matches expected answer'
            : `Expected "${expected}", got "${response?.substring(0, 100)}..."`
    };
}

/**
 * Parse a numeric value from text
 * Handles various formats: "42", "x = 42", "The answer is 42", "42.5", "-3.14"
 * @param {string} text - Text containing a number
 * @returns {number|null} Parsed number or null if not found
 */
function parseNumericValue(text) {
    if (!text || typeof text !== 'string') return null;

    // Try direct parse first
    const direct = parseFloat(text.trim());
    if (!isNaN(direct) && isFinite(direct)) {
        return direct;
    }

    // Try to extract number from common patterns
    const patterns = [
        /(?:=|is|equals|:)\s*(-?\d+(?:\.\d+)?)/i,  // "x = 42", "answer is 42"
        /(-?\d+(?:\.\d+)?)\s*(?:$|[.,;])/,          // "42." or "42" at end
        /\*\*(-?\d+(?:\.\d+)?)\*\*/,                // **42** (markdown bold)
        /\\boxed\{(-?\d+(?:\.\d+)?)\}/,             // \boxed{42} (LaTeX)
        /(-?\d+(?:\.\d+)?)/                         // First number found
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
            const num = parseFloat(match[1]);
            if (!isNaN(num) && isFinite(num)) {
                return num;
            }
        }
    }

    return null;
}

/**
 * Numeric evaluation scoring
 * Compares numeric values with optional tolerance
 * @param {string} response - Model response containing a number
 * @param {string|number} expected - Expected numeric answer
 * @param {Object} options - { tolerance: number (default 0.001), relativeMatch: boolean }
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function numericEval(response, expected, options = {}) {
    const { tolerance = 0.001, relativeMatch = false } = options;

    const respNum = parseNumericValue(String(response));
    const expNum = typeof expected === 'number' ? expected : parseNumericValue(String(expected));

    if (respNum === null) {
        return {
            score: 0,
            matched: false,
            method: 'numeric_eval',
            details: `Could not parse numeric value from response: "${response?.substring(0, 100)}..."`
        };
    }

    if (expNum === null) {
        return {
            score: 0,
            matched: false,
            method: 'numeric_eval',
            details: `Could not parse expected numeric value: "${expected}"`
        };
    }

    let matched;
    let diff;

    if (relativeMatch && expNum !== 0) {
        // Relative tolerance (as percentage of expected)
        diff = Math.abs((respNum - expNum) / expNum);
        matched = diff <= tolerance;
    } else {
        // Absolute tolerance
        diff = Math.abs(respNum - expNum);
        matched = diff <= tolerance;
    }

    // Partial credit for close answers
    let score;
    if (matched) {
        score = 10;
    } else if (diff <= tolerance * 10) {
        score = 7; // Close but not exact
    } else if (diff <= tolerance * 100) {
        score = 3; // In the ballpark
    } else {
        score = 0;
    }

    return {
        score,
        matched: score === 10,
        method: 'numeric_eval',
        extracted: { response: respNum, expected: expNum },
        difference: diff,
        details: matched
            ? `Numeric match: ${respNum} = ${expNum} (within tolerance ${tolerance})`
            : `Numeric mismatch: expected ${expNum}, got ${respNum} (diff: ${diff.toFixed(6)})`
    };
}

/**
 * Compare two JSON values for equality
 * Arrays are compared with order sensitivity
 * Objects are compared with key-order insensitivity
 * @param {any} a - First value
 * @param {any} b - Second value
 * @returns {boolean} True if equal
 */
function jsonDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, idx) => jsonDeepEqual(val, b[idx]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        if (keysA.length !== keysB.length) return false;
        if (!keysA.every((k, i) => k === keysB[i])) return false;
        return keysA.every(k => jsonDeepEqual(a[k], b[k]));
    }

    return false;
}

/**
 * Try to parse JSON from a response string
 * Handles various formats: raw JSON, markdown code blocks, etc.
 * @param {string} text - Response text
 * @returns {Object} { success: boolean, value: any, error: string|null }
 */
function tryParseJson(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, value: null, error: 'Empty or non-string input' };
    }

    // Strip markdown code fences
    let cleaned = text.trim();
    const codeBlockRegex = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/;
    const match = cleaned.match(codeBlockRegex);
    if (match) {
        cleaned = match[1].trim();
    }

    try {
        const value = JSON.parse(cleaned);
        return { success: true, value, error: null };
    } catch (e) {
        // Try to extract JSON from surrounding text
        const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (jsonMatch) {
            try {
                const value = JSON.parse(jsonMatch[1]);
                return { success: true, value, error: null };
            } catch (e2) {
                return { success: false, value: null, error: e2.message };
            }
        }
        return { success: false, value: null, error: e.message };
    }
}

/**
 * JSON comparison scoring
 * @param {string} response - Model response (should be JSON)
 * @param {string|Object} expected - Expected JSON (string or object)
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function jsonCompare(response, expected) {
    const respParsed = tryParseJson(response);
    const expParsed = typeof expected === 'object'
        ? { success: true, value: expected, error: null }
        : tryParseJson(expected);

    if (!respParsed.success) {
        return {
            score: 0,
            matched: false,
            method: 'json_compare',
            details: `Failed to parse response as JSON: ${respParsed.error}`
        };
    }

    if (!expParsed.success) {
        return {
            score: 0,
            matched: false,
            method: 'json_compare',
            details: `Failed to parse expected as JSON: ${expParsed.error}`
        };
    }

    const matched = jsonDeepEqual(respParsed.value, expParsed.value);

    return {
        score: matched ? 10 : 0,
        matched,
        method: 'json_compare',
        comparison: {
            expected: expParsed.value,
            received: respParsed.value
        },
        details: matched
            ? 'JSON structures match exactly'
            : 'JSON structures do not match'
    };
}

/**
 * Regex pattern scoring
 * Checks for required patterns and forbidden patterns
 * @param {string} response - Model response
 * @param {Object} config - Pattern configuration
 * @param {Array} config.must_contain - Array of { pattern: string|RegExp, weight: number }
 * @param {Array} config.must_not_contain - Array of patterns that should NOT be present
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function regexPatterns(response, config = {}) {
    const { must_contain = [], must_not_contain = [] } = config;
    const results = [];
    let totalWeight = 0;
    let earnedWeight = 0;

    // Check required patterns
    for (const item of must_contain) {
        const pattern = typeof item.pattern === 'string'
            ? new RegExp(item.pattern, 'i')
            : item.pattern;
        const weight = item.weight || 1;
        totalWeight += weight;

        const found = pattern.test(response);
        if (found) {
            earnedWeight += weight;
            results.push({ pattern: item.pattern.toString(), found: true, required: true });
        } else {
            results.push({ pattern: item.pattern.toString(), found: false, required: true });
        }
    }

    // Check forbidden patterns
    let hasForbidden = false;
    for (const pattern of must_not_contain) {
        const regex = typeof pattern === 'string' ? new RegExp(pattern, 'i') : pattern;
        const found = regex.test(response);
        if (found) {
            hasForbidden = true;
            results.push({ pattern: pattern.toString(), found: true, forbidden: true });
        }
    }

    // Calculate score
    let score;
    if (hasForbidden) {
        score = 0; // Automatic fail for forbidden content
    } else if (totalWeight === 0) {
        score = must_not_contain.length > 0 ? 10 : 0; // Only forbidden checks, passed
    } else {
        score = Math.round((earnedWeight / totalWeight) * 10);
    }

    const allRequired = results.filter(r => r.required).every(r => r.found);
    const noForbidden = !hasForbidden;
    const matched = allRequired && noForbidden;

    return {
        score,
        matched,
        method: 'regex_patterns',
        results,
        details: matched
            ? 'All required patterns found, no forbidden patterns'
            : `Pattern check failed: ${results.filter(r => (r.required && !r.found) || (r.forbidden && r.found)).map(r => r.pattern).join(', ')}`
    };
}

/**
 * Main deterministic scoring function
 * Routes to appropriate scoring method based on config
 * @param {string} response - Model response
 * @param {Object} prompt - Prompt object with deterministic_scoring config
 * @returns {Object|null} Score result or null if deterministic scoring not applicable
 */
function score(response, prompt) {
    const config = prompt.deterministic_scoring;
    if (!config || !config.type) {
        return null; // Not configured for deterministic scoring
    }

    const expected = prompt.expected_answer || prompt.expected;

    logger.debug('Deterministic scoring', {
        type: config.type,
        prompt: prompt.name || 'unknown',
        hasExpected: !!expected
    });

    let result;

    switch (config.type) {
        case 'exact':
            if (!expected) {
                logger.warn('Exact match scoring requires expected_answer', {
                    prompt: prompt.name || 'unknown'
                });
                return null;
            }
            result = exactMatch(response, expected, {
                caseSensitive: config.case_sensitive,
                trimOnly: config.trim_only
            });
            break;

        case 'numeric':
            if (!expected) {
                logger.warn('Numeric scoring requires expected_answer', {
                    prompt: prompt.name || 'unknown'
                });
                return null;
            }
            result = numericEval(response, expected, {
                tolerance: config.numeric_tolerance || 0.001,
                relativeMatch: config.relative_match
            });
            break;

        case 'json':
            if (!expected) {
                logger.warn('JSON scoring requires expected_answer', {
                    prompt: prompt.name || 'unknown'
                });
                return null;
            }
            result = jsonCompare(response, expected);
            break;

        case 'regex':
            result = regexPatterns(response, {
                must_contain: config.must_contain || [],
                must_not_contain: config.must_not_contain || []
            });
            break;

        default:
            logger.warn('Unknown deterministic scoring type', {
                type: config.type,
                prompt: prompt.name || 'unknown'
            });
            return null;
    }

    // Add metadata
    result.deterministic = true;
    result.scoring_method = 'deterministic';
    result.deterministic_type = config.type;

    logger.info('Deterministic score computed', {
        prompt: prompt.name || 'unknown',
        type: config.type,
        score: result.score,
        matched: result.matched
    });

    return result;
}

module.exports = {
    score,
    exactMatch,
    numericEval,
    jsonCompare,
    jsonDeepEqual,
    tryParseJson,
    regexPatterns,
    normalizeString,
    parseNumericValue
};
