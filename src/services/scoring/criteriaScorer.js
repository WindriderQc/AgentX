/**
 * Criteria-based Scorer
 * Scores responses using judge_criteria + expected_answer via regex pattern matching.
 * Extracted from qualityScorer.js for file size discipline.
 */

const logger = require('../../../config/logger');
const deterministicScorer = require('../deterministicScorer');

/**
 * Extract key terms from a judge criterion string for regex matching.
 * Pulls out quoted values, numbers with units, and proper nouns/key phrases.
 * @param {string} criterion - e.g. "Names Pine Ridge as the closed trail"
 * @returns {string} Regex pattern string, case-insensitive
 */
function extractCriterionPattern(criterion) {
    // Try quoted values first: "Pine Ridge"
    const quoted = criterion.match(/"([^"]+)"/);
    if (quoted) return quoted[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Try comma-separated alphanumeric labels: "Q1, Q2, Q3" or "A1, B2"
    const labelMatch = criterion.match(/([A-Z]\d+(?:\s*,\s*[A-Z]\d+)+)/);
    if (labelMatch) {
        const labels = labelMatch[1].split(/\s*,\s*/);
        return labels.join('[\\s\\S]*');
    }

    // Try number+unit patterns: "1.2 million", "$500", "42%"
    const numUnit = criterion.match(/(?<![A-Za-z])(\$?\d[\d,.]*\s*(?:million|billion|thousand|percent|%|kg|lb|miles?|km|hours?|minutes?|seconds?|days?|years?)?)/i);
    if (numUnit) return numUnit[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');

    // Try verb-qualifier content extraction:
    // "Identifies rye sandwiches as the main lunch item" → "rye sandwiches"
    const criterionVerbs = new Set([
        'names', 'states', 'identifies', 'mentions', 'recalls',
        'lists', 'specifies', 'notes', 'includes', 'describes',
        'answers'
    ]);
    const verbQualifierMatch = criterion.match(
        /^\w+\s+(?:the\s+)?(.+?)\s+(?:as\s+(?:the|a|an)\s+|is\s+(?:the|a|an)\s+)/i
    );
    if (verbQualifierMatch) {
        const content = verbQualifierMatch[1].trim();
        // Only use if it's lowercase content (not a proper noun phrase we'd catch later)
        if (content.length > 2 && content[0] === content[0].toLowerCase()) {
            return content.replace(/\s+/g, '\\s+');
        }
    }

    // Extract capitalized proper nouns / key noun phrases
    const properNouns = criterion.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g);
    if (properNouns && properNouns.length > 0) {
        const cleaned = properNouns.map(pn => {
            const words = pn.split(/\s+/);
            if (words.length > 1 && criterionVerbs.has(words[0].toLowerCase())) {
                return words.slice(1).join(' ');
            }
            return pn;
        }).filter(pn => {
            if (pn.split(/\s+/).length === 1 && criterionVerbs.has(pn.toLowerCase())) {
                return false;
            }
            return pn.length > 1;
        });

        if (cleaned.length > 0) {
            const longest = cleaned.sort((a, b) => b.length - a.length)[0];
            return longest.replace(/\s+/g, '\\s+');
        }
    }

    // Fallback: extract significant words (skip common verbs/articles/prepositions)
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
        'does', 'do', 'did', 'has', 'have', 'had', 'that', 'this', 'it',
        'as', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from',
        'and', 'or', 'not', 'no', 'if', 'but', 'so', 'any', 'all',
        'names', 'states', 'identifies', 'mentions', 'recalls', 'correctly',
        'response', 'answer', 'total', 'main', 'closed', 'specific',
        'answers', 'labeled', 'lists', 'includes'
    ]);
    const words = criterion.toLowerCase().split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w.replace(/[,.:;]/g, '')));

    if (words.length >= 2) {
        return words.slice(0, 3).map(w => w.replace(/[,.:;]/g, '')).join('.*');
    }
    if (words.length === 1) {
        return words[0].replace(/[,.:;]/g, '');
    }

    return null;
}

/**
 * Score a response using judge_criteria + expected_answer via regex matching.
 * For Q&A prompts with clear expected answers, matches answers deterministically.
 * @param {string} response - Model response text
 * @param {Object} prompt - Prompt with judge_criteria and expected_answer
 * @returns {Object|null} Deterministic score result, or null if can't score
 */
function criteriaBasedScore(response, prompt) {
    const criteria = prompt.judge_criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) return null;

    const patterns = [];
    for (const criterion of criteria) {
        const pattern = extractCriterionPattern(criterion);
        if (pattern) {
            patterns.push({ pattern, weight: 1 });
        }
    }

    // Also extract patterns from expected_answer if available
    if (prompt.expected_answer) {
        // Split by newlines AND by sentence boundaries (". Q" pattern for Q&A format)
        let segments = prompt.expected_answer.split(/\n/).filter(l => l.trim());
        // If single line with multiple Q-prefixed answers, split by ". Q" boundaries
        if (segments.length === 1 && /Q\d+\s*:/.test(segments[0])) {
            segments = segments[0].split(/\.\s+(?=Q\d+\s*:)/).filter(s => s.trim());
        }
        for (const segment of segments) {
            // Strip numbered prefixes (1. 2.) and Q-prefixes (Q1: Q2:)
            const trimmed = segment
                .replace(/^\d+\.\s*/, '')
                .replace(/^Q\d+\s*:\s*/i, '')
                .replace(/\.\s*$/, '')
                .trim();
            if (trimmed.length > 2) {
                const alreadyCovered = patterns.some(p => {
                    try { return new RegExp(p.pattern, 'i').test(trimmed); } catch { return false; }
                });
                if (!alreadyCovered) {
                    patterns.push({ pattern: trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), weight: 1 });
                }
            }
        }
    }

    if (patterns.length === 0) return null;

    const result = deterministicScorer.regexPatterns(response, {
        must_contain: patterns,
        must_not_contain: []
    });

    logger.info('Criteria-based scoring', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        patterns: patterns.length,
        score: result.score,
        matched: result.matched
    });

    return result;
}

module.exports = {
    extractCriterionPattern,
    criteriaBasedScore
};
