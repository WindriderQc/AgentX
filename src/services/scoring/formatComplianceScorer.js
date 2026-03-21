/**
 * Format Compliance Scorer
 * Evaluates raw response against an output_contract spec.
 * Returns { format_score, format_compliant } or nulls when no contract.
 */

const logger = require('../../../config/logger');

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
        case 'structured_text':
            return scoreStructuredText(trimmed, contract);
        default:
            logger.warn('Unknown output_contract type', { type: contract.type });
            return { format_score: null, format_compliant: null };
    }
}

function scoreNumberOnly(response, contract) {
    const allowLatex = contract.allow_latex !== false;

    const plainNumberPattern = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;
    if (plainNumberPattern.test(response)) {
        return { format_score: 10, format_compliant: true };
    }

    const latexBoxedPattern = /^\$?\\boxed\{[^}]+\}\$?$/;
    if (allowLatex && latexBoxedPattern.test(response)) {
        return { format_score: 8, format_compliant: true };
    }

    const latexWrapped = /^\$[^$]+\$$/;
    if (allowLatex && latexWrapped.test(response)) {
        return { format_score: 7, format_compliant: true };
    }

    const hasNumber = /-?\d+(\.\d+)?/.test(response);
    if (hasNumber) {
        return { format_score: 4, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

function scoreExact(response, contract) {
    const template = contract.template || '';
    if (!template) {
        return { format_score: null, format_compliant: null };
    }

    if (response === template) {
        return { format_score: 10, format_compliant: true };
    }

    const normalize = s => s.toLowerCase().trim().replace(/\s+/g, ' ');
    if (normalize(response) === normalize(template)) {
        return { format_score: 7, format_compliant: true };
    }

    if (normalize(response).includes(normalize(template))) {
        return { format_score: 3, format_compliant: false };
    }

    return { format_score: 0, format_compliant: false };
}

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

function scoreJsonSchema(response, contract) {
    const requiredKeys = contract.schema_keys || [];

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

function splitLines(text) {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function splitParagraphs(text) {
    return text
        .split(/\r?\n\s*\r?\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);
}

function normalizeForSentenceSplit(text) {
    return text
        .replace(/\b([ap])\.m\./gi, '$1m')
        .replace(/\be\.g\./gi, 'eg')
        .replace(/\bi\.e\./gi, 'ie');
}

function splitSentences(text) {
    const normalized = normalizeForSentenceSplit(text).trim();
    if (!normalized) return [];
    return normalized
        .split(/(?<=[.!?])\s+(?=[A-Z"'])/)
        .map(sentence => sentence.trim())
        .filter(Boolean);
}

function countWords(text) {
    return (text.match(/[A-Za-z0-9$]+(?:[.'-][A-Za-z0-9$]+)*/g) || []).length;
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsTerm(text, term) {
    const source = String(text || '');
    const needle = String(term || '');
    if (!needle) return false;

    if (/^[A-Za-z0-9 ]+$/.test(needle)) {
        return new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i').test(source);
    }

    return source.toLowerCase().includes(needle.toLowerCase());
}

function scoreStructuredText(response, contract) {
    const lines = splitLines(response);
    const paragraphs = splitParagraphs(response);
    const sentences = splitSentences(response);
    const checks = [];

    const addCheck = (passed) => {
        checks.push(!!passed);
    };

    if (Number.isInteger(contract.line_count)) {
        addCheck(lines.length === contract.line_count);
    }

    if (Number.isInteger(contract.paragraph_count)) {
        addCheck(paragraphs.length === contract.paragraph_count);
    }

    if (Number.isInteger(contract.sentence_count)) {
        addCheck(sentences.length === contract.sentence_count);
    }

    if (contract.word_count && (Number.isFinite(contract.word_count.min) || Number.isFinite(contract.word_count.max))) {
        const totalWords = countWords(response);
        const minOk = !Number.isFinite(contract.word_count.min) || totalWords >= contract.word_count.min;
        const maxOk = !Number.isFinite(contract.word_count.max) || totalWords <= contract.word_count.max;
        addCheck(minOk && maxOk);
    }

    if (Array.isArray(contract.required_terms) && contract.required_terms.length > 0) {
        addCheck(contract.required_terms.every(term => containsTerm(response, term)));
    }

    if (Array.isArray(contract.required_term_groups) && contract.required_term_groups.length > 0) {
        addCheck(contract.required_term_groups.every(group => group.some(term => containsTerm(response, term))));
    }

    if (Array.isArray(contract.forbidden_terms) && contract.forbidden_terms.length > 0) {
        addCheck(contract.forbidden_terms.every(term => !containsTerm(response, term)));
    }

    if (Array.isArray(contract.line_regexes) && contract.line_regexes.length > 0) {
        const sameLength = lines.length === contract.line_regexes.length;
        const allMatched = sameLength && contract.line_regexes.every((pattern, index) => new RegExp(pattern).test(lines[index] || ''));
        addCheck(allMatched);
    }

    if (Array.isArray(contract.line_starts_with) && contract.line_starts_with.length > 0) {
        const sameLength = lines.length === contract.line_starts_with.length;
        const allMatched = sameLength && contract.line_starts_with.every((prefix, index) => (lines[index] || '').startsWith(prefix));
        addCheck(allMatched);
    }

    if (Array.isArray(contract.line_initials) && contract.line_initials.length > 0) {
        const sameLength = lines.length === contract.line_initials.length;
        const allMatched = sameLength && contract.line_initials.every((initial, index) => {
            const line = (lines[index] || '').trim();
            return line.charAt(0).toUpperCase() === String(initial).toUpperCase();
        });
        addCheck(allMatched);
    }

    if (contract.line_word_count && (Number.isFinite(contract.line_word_count.min) || Number.isFinite(contract.line_word_count.max))) {
        addCheck(lines.every((line) => {
            const words = countWords(line);
            const minOk = !Number.isFinite(contract.line_word_count.min) || words >= contract.line_word_count.min;
            const maxOk = !Number.isFinite(contract.line_word_count.max) || words <= contract.line_word_count.max;
            return minOk && maxOk;
        }));
    }

    if (contract.each_line_ends_with) {
        addCheck(lines.every(line => line.endsWith(contract.each_line_ends_with)));
    }

    if (contract.second_sentence_starts_with) {
        addCheck(sentences.length >= 2 && sentences[1].startsWith(contract.second_sentence_starts_with));
    }

    if (Number.isInteger(contract.sentences_per_paragraph)) {
        addCheck(paragraphs.every(paragraph => splitSentences(paragraph).length === contract.sentences_per_paragraph));
    }

    if (Array.isArray(contract.paragraph_required_terms) && contract.paragraph_required_terms.length > 0) {
        const sameLength = paragraphs.length === contract.paragraph_required_terms.length;
        const allMatched = sameLength && contract.paragraph_required_terms.every((terms, index) => terms.every(term => containsTerm(paragraphs[index] || '', term)));
        addCheck(allMatched);
    }

    if (Array.isArray(contract.paragraph_required_any) && contract.paragraph_required_any.length > 0) {
        const sameLength = paragraphs.length === contract.paragraph_required_any.length;
        const allMatched = sameLength && contract.paragraph_required_any.every((terms, index) => terms.some(term => containsTerm(paragraphs[index] || '', term)));
        addCheck(allMatched);
    }

    if (contract.forbidden_line_pattern) {
        const linePattern = new RegExp(contract.forbidden_line_pattern, 'i');
        addCheck(lines.every(line => !linePattern.test(line)));
    }

    if (checks.length === 0) {
        return { format_score: null, format_compliant: null };
    }

    const passedCount = checks.filter(Boolean).length;
    const compliant = passedCount === checks.length;
    const formatScore = Math.round(((passedCount / checks.length) * 10) * 10) / 10;

    return {
        format_score: formatScore,
        format_compliant: compliant
    };
}

module.exports = { scoreFormatCompliance };
