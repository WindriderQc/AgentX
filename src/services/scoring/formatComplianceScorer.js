/**
 * Format Compliance Scorer
 * Evaluates raw response against an output_contract spec.
 * Returns { format_score, format_compliant } or nulls when no contract.
 */

const logger = require('../../../config/logger');

/**
 * Score format compliance of a response against an output contract.
 *
 * @param {string} response - Raw model response text
 * @param {Object} contract - output_contract from BenchmarkPrompt
 * @returns {{ format_score: number|null, format_compliant: boolean|null }}
 */
function scoreFormatCompliance(response, contract) {
    if (!contract || !contract.type || contract.type === 'none') {
        return { format_score: null, format_compliant: null };
    }

    const trimmed = (response || '').trim();
    if (!trimmed) {
        return { format_score: 0, format_compliant: false };
    }

    switch (contract.type) {
        case 'number_only':
            return scoreNumberOnly(trimmed, contract);
        case 'exact':
            return scoreExact(trimmed, contract);
        case 'regex':
            return scoreRegex(trimmed, contract);
        case 'json_schema':
            return scoreJsonSchema(trimmed, contract);
        default:
            logger.warn('Unknown output_contract type', { type: contract.type });
            return { format_score: null, format_compliant: null };
    }
}

/**
 * number_only: plain number = 10, LaTeX boxed = 8 (if allowed), number buried in text = 4, no number = 0
 */
function scoreNumberOnly(response, contract) {
    const allowLatex = contract.allow_latex !== false;

    // Plain number (possibly with sign, decimal, scientific notation)
    const plainNumberPattern = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
    if (plainNumberPattern.test(response)) {
        return { format_score: 10, format_compliant: true };
    }

    // LaTeX boxed: \boxed{...} or $\boxed{...}$
    const latexBoxedPattern = /^\$?\\boxed\{[^}]+\}\$?$/;
    if (allowLatex && latexBoxedPattern.test(response)) {
        return { format_score: 8, format_compliant: true };
    }

    // Any LaTeX wrapper: $...$
    const latexWrapped = /^\$[^$]+\$$/;
    if (allowLatex && latexWrapped.test(response)) {
        return { format_score: 7, format_compliant: true };
    }

    // Number buried somewhere in text
    const hasNumber = /-?\d+(\.\d+)?/.test(response);
    if (hasNumber) {
        return { format_score: 4, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

/**
 * exact: exact match = 10, normalized match = 7, partial = 3
 */
function scoreExact(response, contract) {
    const template = contract.template || '';
    if (!template) {
        return { format_score: null, format_compliant: null };
    }

    // Exact match
    if (response === template) {
        return { format_score: 10, format_compliant: true };
    }

    // Normalized match (case-insensitive, trimmed, collapsed whitespace)
    const normalize = s => s.toLowerCase().trim().replace(/\s+/g, ' ');
    if (normalize(response) === normalize(template)) {
        return { format_score: 7, format_compliant: true };
    }

    // Partial match (contains the template)
    if (normalize(response).includes(normalize(template))) {
        return { format_score: 3, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

/**
 * regex: pattern match = 10, no match = 0
 */
function scoreRegex(response, contract) {
    const pattern = contract.pattern;
    if (!pattern) {
        return { format_score: null, format_compliant: null };
    }

    try {
        const re = new RegExp(pattern, 'i');
        if (re.test(response)) {
            return { format_score: 10, format_compliant: true };
        }
        return { format_score: 0, format_compliant: false };
    } catch (err) {
        logger.warn('Invalid regex pattern in output_contract', { pattern, error: err.message });
        return { format_score: null, format_compliant: null };
    }
}

/**
 * json_schema: valid JSON with required keys = 10, valid JSON wrong keys = 5, not JSON = 0
 */
function scoreJsonSchema(response, contract) {
    const requiredKeys = contract.schema_keys || [];

    // Try to extract JSON from response
    const firstBrace = response.indexOf('{');
    const lastBrace = response.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        return { format_score: 0, format_compliant: false };
    }

    try {
        const parsed = JSON.parse(response.substring(firstBrace, lastBrace + 1));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            return { format_score: 2, format_compliant: false };
        }

        if (requiredKeys.length === 0) {
            return { format_score: 10, format_compliant: true };
        }

        const presentKeys = Object.keys(parsed);
        const hasAllRequired = requiredKeys.every(k => presentKeys.includes(k));
        if (hasAllRequired) {
            return { format_score: 10, format_compliant: true };
        }

        return { format_score: 5, format_compliant: false };
    } catch {
        return { format_score: 0, format_compliant: false };
    }
}

module.exports = { scoreFormatCompliance };
