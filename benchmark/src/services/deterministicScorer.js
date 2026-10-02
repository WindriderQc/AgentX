/**
 * Deterministic Scorer Service
 * Handles scoring cases where LLM judgment is unnecessary
 * - Exact match: Normalize & compare strings
 * - Numeric eval: Parse and evaluate math expressions
 * - JSON compare: Already exists (jsonDeepEqual)
 * - Regex patterns: Must contain X, must not contain Y
 */

const logger = require('../../config/logger');
const { jsonDeepEqual, tryParseJson } = require('./scoring/jsonUtils');
const { validateSemanticOutput } = require('./scoring/semanticOutputValidators');

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
 * Extract candidate answer forms from an expected_answer string.
 *
 * Prompt authors follow a convention where `expected_answer` reads as
 * "ANSWER. EXPLANATION" or "ANSWER. (also acceptable: ALT1. ALT2.)". The
 * deterministic exact-match scorer only sees the raw string, so a model
 * that correctly outputs just "No solution" fails to match the longer
 * narrative form. This helper returns every plausible answer form so the
 * scorer can credit any of them.
 *
 * Returns an array with the full string first, then the leading sentence,
 * then any "(also acceptable: ...)" variants split on sentence boundaries.
 * De-duplicated; preserves insertion order.
 *
 * @param {string} expected
 * @returns {string[]}
 */
function extractExpectedCandidates(expected) {
    if (!expected || typeof expected !== 'string') return [];

    const out = [];
    const push = (s) => {
        if (!s) return;
        const trimmed = String(s).trim();
        if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    };

    push(expected);

    // Leading sentence: text before the first ". " (but only if there is
    // additional explanation after it — otherwise it's identical to full).
    const firstSentenceMatch = expected.match(/^([^.]*?[^.\s])\.\s+\S/);
    if (firstSentenceMatch) {
        push(firstSentenceMatch[1]);
    }

    // "(also acceptable: ALT1. ALT2.)" — strip the wrapper, split on ". ",
    // drop trailing punctuation.
    const acceptMatch = expected.match(/\(also acceptable:\s*([^)]*)\)/i);
    if (acceptMatch) {
        const inner = acceptMatch[1];
        for (const part of inner.split(/\.\s+/)) {
            push(part.replace(/[.\s]+$/, ''));
        }
    }

    return out;
}

/**
 * Exact match scoring
 * Normalizes both strings and compares.
 * Falls back to contains-match with partial credit when exact fails,
 * since models almost never respond with just the bare answer.
 * @param {string} response - Model response
 * @param {string} expected - Expected answer
 * @param {Object} options - { caseSensitive: boolean, trimOnly: boolean }
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function exactMatch(response, expected, options = {}) {
    const { caseSensitive = false, trimOnly = false } = options;

    const normalize = (s) => {
        if (trimOnly) {
            const trimmed = s?.trim() || '';
            return caseSensitive ? trimmed : trimmed.toLowerCase();
        }
        return caseSensitive ? (s?.trim() || '') : normalizeString(s);
    };

    const respNorm = normalize(response);

    // Try each candidate form of the expected answer (full, first sentence,
    // "also acceptable" variants). Best result wins.
    const candidates = extractExpectedCandidates(expected);

    let best = null;
    for (const cand of candidates) {
        const candNorm = normalize(cand);
        if (!candNorm) continue;

        // Exact match = perfect score
        if (respNorm === candNorm) {
            return {
                score: 10,
                matched: true,
                method: 'exact_match',
                details: cand === expected
                    ? 'Response exactly matches expected answer'
                    : `Response exactly matches expected answer form "${cand}"`
            };
        }

        // Contains match = high partial credit
        if (candNorm.length >= 2 && respNorm.includes(candNorm)) {
            const ratio = candNorm.length / Math.max(respNorm.length, 1);
            const score = ratio > 0.5 ? 9 : ratio > 0.1 ? 8 : 7;
            if (!best || score > best.score) {
                best = {
                    score,
                    matched: true,
                    method: 'exact_match_contains',
                    details: `Response contains expected answer "${cand}" (relevance ratio: ${(ratio * 100).toFixed(0)}%)`
                };
            }
        }
    }

    if (best) return best;

    return {
        score: 0,
        matched: false,
        method: 'exact_match',
        details: `Expected "${expected}", got "${response?.substring(0, 100)}..."`
    };
}

function parseNumericLiteral(token) {
    if (typeof token !== 'string') return null;

    const normalized = token
        .trim()
        .replace(/^[$(\[]+/, '')
        .replace(/[$)\].,:;!?]+$/, '')
        .replace(/,/g, '');

    if (!normalized) return null;

    const fractionMatch = normalized.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
    if (fractionMatch) {
        const numerator = Number(fractionMatch[1]);
        const denominator = Number(fractionMatch[2]);
        if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
            return numerator / denominator;
        }
    }

    const percentMatch = normalized.match(/^(-?\d+(?:\.\d+)?)%$/);
    if (percentMatch) {
        const percent = Number(percentMatch[1]);
        if (Number.isFinite(percent)) {
            return percent / 100;
        }
    }

    const numberMatch = normalized.match(/^-?\d+(?:\.\d+)?$/);
    if (numberMatch) {
        const value = Number(numberMatch[0]);
        if (Number.isFinite(value)) {
            return value;
        }
    }

    return null;
}

const NUMERIC_TOKEN = '[$]?-?\\d[\\d,]*(?:\\.\\d+)?(?:\\s*\\/\\s*-?\\d[\\d,]*(?:\\.\\d+)?)?%?';

function collectNumericCandidates(text, regex, priority, candidates) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const rawValue = match[1] || match[0];
        const value = parseNumericLiteral(rawValue);
        if (value !== null) {
            candidates.push({
                value,
                priority,
                index: match.index + match[0].lastIndexOf(rawValue),
                end: match.index + match[0].lastIndexOf(rawValue) + rawValue.length
            });
        }
    }
}

function chooseBestNumericCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    return candidates.reduce((best, candidate) => {
        if (!best) return candidate;
        if (candidate.priority !== best.priority) {
            return candidate.priority > best.priority ? candidate : best;
        }
        return candidate.index >= best.index ? candidate : best;
    }, null);
}

/**
 * Parse a numeric value from text
 * Handles various formats: "42", "x = 42", "The answer is 42", "42.5", "-3.14"
 * @param {string} text - Text containing a number
 * @returns {number|null} Parsed number or null if not found
 */
function parseNumericValue(text, { answerOnly = false, referenceAnswer = false } = {}) {
    if (!text || typeof text !== 'string') return null;

    const direct = parseNumericLiteral(text);
    if (direct !== null) {
        return direct;
    }

    // Authored references use "ANSWER. EXPLANATION". Read a numeric first
    // sentence before list-marker cleanup can discard it (e.g. "5050. ...").
    // Candidate responses must still select their answer independently.
    if (referenceAnswer && !answerOnly) {
        const firstSentence = text.split(/\.\s/)[0];
        if (firstSentence !== text) {
            const leadingAnswer = parseNumericLiteral(firstSentence);
            if (leadingAnswer !== null) return leadingAnswer;
        }
    }

    const sanitized = text
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '');

    const candidates = [];
    collectNumericCandidates(sanitized, /\\boxed\{([^}]+)\}/g, 100, candidates);

    // Priority 97: First sentence number — for expected_answers like "$60. Discount = ..."
    // the answer is stated first, work follows after the period
    const firstSentence = sanitized.split(/\.\s/)[0];
    if (!answerOnly && firstSentence && firstSentence !== sanitized) {
        collectNumericCandidates(
            firstSentence,
            new RegExp(`(${NUMERIC_TOKEN})`, 'g'),
            97,
            candidates
        );
    }

    collectNumericCandidates(
        sanitized,
        new RegExp(`\\bfinal (?:answer|result)\\s*(?:is|equals|:|=)?\\s*(?:[a-z]\\s*=\\s*)?(${NUMERIC_TOKEN})`, 'gi'),
        110,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`\\b(?:answer|result|therefore|thus|so|probability|sale price|maximum area|max area|sum|total|product|difference|quotient)\\b[^\\d\\n]{0,80}?(?:=|is|equals|:)\\s*(${NUMERIC_TOKEN})`, 'gi'),
        95,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(?:=|equals|:)\\s*(${NUMERIC_TOKEN})`, 'gi'),
        85,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(${NUMERIC_TOKEN})\\s*(?=$|[)\\].,;!?]|\\n)`, 'gm'),
        70,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(${NUMERIC_TOKEN})`, 'g'),
        10,
        candidates
    );

    const selected = chooseBestNumericCandidate(candidates);
    if (!selected) return null;
    if (answerOnly) {
        // Presentation wrappers must not hide a rejection of the chosen value.
        const before = sanitized.slice(0, selected.index).split(/[.!?\n]/).pop()
            .replace(/\\boxed\{\s*$/, '');
        const after = sanitized.slice(selected.end).split(/[.!?\n]/)[0]
            .replace(/^[}\])$\s]+/, '');
        const negated = /\b(?:not|isn't|isnt|incorrect|wrong|less than|greater than|at most|at least)\s*$/i.test(before)
            || /^\s*(?:is|was)?\s*(?:not\b|incorrect\b|wrong\b|rejected\b)/i.test(after);
        const alternatives = new RegExp(`^\\s*(?:or|and|to|–|-)\\s*${NUMERIC_TOKEN}`, 'i').test(after);
        const unlabelledAlternatives = selected.priority === 10
            && new Set(candidates.map(candidate => candidate.value)).size > 1;
        if (negated || alternatives || unlabelledAlternatives) return null;
    }
    return selected.value;
}

/**
 * Numeric evaluation scoring
 * Compares numeric values with optional tolerance.
 * Selects the stated answer without consulting the expected value. Incidental
 * occurrences and ambiguous/rejected answers must not certify correctness.
 * @param {string} response - Model response containing a number
 * @param {string|number} expected - Expected numeric answer
 * @param {Object} options - { tolerance: number (default 0.001), relativeMatch: boolean }
 * @returns {Object} { score: number, matched: boolean, details: string }
 */
function numericEval(response, expected, options = {}) {
    const { tolerance = 0.001, relativeMatch = false } = options;

    const expNum = typeof expected === 'number' ? expected : parseNumericValue(String(expected), { referenceAnswer: true });

    if (expNum === null) {
        return {
            score: 0,
            matched: false,
            method: 'numeric_eval',
            details: `Could not parse expected numeric value: "${expected}"`
        };
    }

    const respNum = parseNumericValue(String(response), { answerOnly: true });

    if (respNum === null) {
        return {
            score: 0,
            matched: false,
            method: 'numeric_eval',
            details: 'No unambiguous affirmative numeric answer could be extracted from the response'
        };
    }

    // Only compare the selected answer; never search for the expected value.
    const absoluteDiff = Math.abs(respNum - expNum);
    const magnitude = Math.max(Math.abs(expNum), 1);
    const relativeDiff = absoluteDiff / magnitude;
    const difference = relativeMatch && expNum !== 0
        ? Math.abs((respNum - expNum) / expNum) : absoluteDiff;
    const matched = difference <= tolerance;

    // Parsed-but-wrong final numeric answers should not become pass-level
    // deterministic scores. The caller decides whether a mismatch is terminal
    // or requires judge review; it must not be reported as a deterministic pass.
    let score;
    if (matched) {
        score = 10;
    } else if (relativeMatch && expNum !== 0) {
        if (difference <= 0.05) score = 2;
        else score = 1;
    } else {
        if (relativeDiff <= 0.05) score = 2;
        else score = 1;
    }

    return {
        score,
        matched: score === 10,
        method: 'numeric_eval',
        extracted: { response: respNum, expected: expNum, candidates_checked: 1 },
        difference,
        details: matched
            ? `Numeric match: ${respNum} = ${expNum} (within ${relativeMatch ? 'relative' : 'absolute'} tolerance ${tolerance})`
            : `Numeric mismatch: expected ${expNum}, selected answer ${respNum} (diff: ${difference.toFixed(6)})`
    };
}

/**
 * Extract ALL numeric candidates from text (not just the "best" one).
 * Diagnostic extraction only; candidate presence is not a correctness check.
 */
function extractAllNumericCandidates(text) {
    if (!text || typeof text !== 'string') return [];

    const sanitized = text
        .replace(/^\s*\d+[.)]\s+/gm, '')
        .replace(/\*\*/g, '')
        .replace(/`/g, '');

    const candidates = [];
    collectNumericCandidates(sanitized, /\\boxed\{([^}]+)\}/g, 100, candidates);
    collectNumericCandidates(
        sanitized,
        new RegExp(`\\b(?:final answer|answer|result|therefore|thus|so|probability|sale price)\\b[^\\d\\n]{0,80}?(?:=|is|equals|:)\\s*(${NUMERIC_TOKEN})`, 'gi'),
        95,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(?:=|equals|:)\\s*(${NUMERIC_TOKEN})`, 'gi'),
        85,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(${NUMERIC_TOKEN})\\s*(?=$|[)\\].,;!?]|\\n)`, 'gm'),
        70,
        candidates
    );
    collectNumericCandidates(
        sanitized,
        new RegExp(`(${NUMERIC_TOKEN})`, 'g'),
        10,
        candidates
    );

    // Deduplicate by value
    const seen = new Set();
    return candidates.filter(c => {
        if (seen.has(c.value)) return false;
        seen.add(c.value);
        return true;
    });
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

function semanticCompare(response, expected, config = {}, prompt = {}) {
    return validateSemanticOutput(response, expected, config, prompt);
}

function semanticJsonCompare(response, expected, config = {}, prompt = {}) {
    return semanticCompare(response, expected, config, prompt) || jsonCompare(response, expected);
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
            result = semanticCompare(response, expected, config, prompt) || exactMatch(response, expected, {
                caseSensitive: config.case_sensitive,
                trimOnly: config.trim_only
            });
            break;

        case 'numeric':
            if (expected === null || expected === undefined || expected === '') {
                logger.warn('Numeric scoring requires expected_answer', {
                    prompt: prompt.name || 'unknown'
                });
                return null;
            }
            result = semanticCompare(response, expected, config, prompt) || numericEval(response, expected, {
                tolerance: config.numeric_tolerance ?? 0.001,
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
            result = semanticJsonCompare(response, expected, config, prompt);
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
    semanticCompare,
    semanticJsonCompare,
    jsonDeepEqual,
    tryParseJson,
    regexPatterns,
    normalizeString,
    parseNumericValue,
    extractAllNumericCandidates
};
