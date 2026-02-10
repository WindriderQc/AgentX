/**
 * Reference Scorer Service
 * Compares model responses against expert reference answers
 * Simpler for 7B judge: compare to known-good answer instead of open evaluation
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');

/**
 * Extract key points from a reference answer
 * Uses simple heuristics for splitting into comparable chunks
 * @param {string} text - Text to extract points from
 * @returns {Array<string>} List of key points
 */
function extractKeyPoints(text) {
    if (!text || typeof text !== 'string') return [];

    // Split by common delimiters
    const sentences = text
        .split(/[.!?\n]/)
        .map(s => s.trim())
        .filter(s => s.length > 10); // Filter out very short fragments

    // Also extract bullet points if present
    const bullets = text
        .split(/(?:^|\n)\s*[-*•]\s*/)
        .map(s => s.trim())
        .filter(s => s.length > 10);

    // Combine and deduplicate
    const combined = [...new Set([...sentences, ...bullets])];

    // Limit to reasonable number of points
    return combined.slice(0, 10);
}

/**
 * Check if a key point is present in the response
 * Uses the judge model for semantic comparison
 * @param {string} response - Model response
 * @param {string} keyPoint - Key point to check for
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} { found: boolean, confidence: string }
 */
async function checkKeyPoint(response, keyPoint, judgeConfig) {
    const prompt = `Does the following RESPONSE contain the same meaning or information as the KEY POINT?

KEY POINT: ${keyPoint}

RESPONSE:
${response.substring(0, 2000)}

Answer ONLY "YES" or "NO":`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout || 15000);

    try {
        const url = `${judgeConfig.host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                prompt,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 10
                }
            }),
            signal: controller.signal
        });

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`Judge HTTP ${res.status}`);
        }

        const data = await res.json();
        const text = (data.response || '').toLowerCase().trim();

        return {
            found: text.includes('yes'),
            confidence: text.includes('yes') ? 'present' : 'absent'
        };
    } catch (err) {
        clearTimeout(timeoutId);
        logger.error('Key point check failed', {
            error: err.message,
            keyPoint: keyPoint.substring(0, 50)
        });
        return { found: false, confidence: 'error' };
    }
}

/**
 * Check if response contains contradictions to the reference
 * @param {string} response - Model response
 * @param {string} reference - Reference answer
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} { hasContradictions: boolean, details: string }
 */
async function checkContradictions(response, reference, judgeConfig) {
    const prompt = `Compare the MODEL ANSWER to the REFERENCE ANSWER.
Does the MODEL ANSWER contain any statements that CONTRADICT the REFERENCE ANSWER?

REFERENCE ANSWER:
${reference.substring(0, 1500)}

MODEL ANSWER:
${response.substring(0, 1500)}

Answer ONLY "YES" if there are contradictions, or "NO" if there are no contradictions:`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout || 20000);

    try {
        const url = `${judgeConfig.host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                prompt,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 10
                }
            }),
            signal: controller.signal
        });

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`Judge HTTP ${res.status}`);
        }

        const data = await res.json();
        const text = (data.response || '').toLowerCase().trim();

        return {
            hasContradictions: text.includes('yes'),
            details: text.includes('yes')
                ? 'Contradictions detected'
                : 'No contradictions found'
        };
    } catch (err) {
        clearTimeout(timeoutId);
        logger.error('Contradiction check failed', { error: err.message });
        return { hasContradictions: false, details: 'Check failed' };
    }
}

/**
 * Get overall similarity rating
 * @param {string} response - Model response
 * @param {string} reference - Reference answer
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} { similarity: string, score: number }
 */
async function checkOverallSimilarity(response, reference, judgeConfig) {
    const prompt = `Compare the MODEL ANSWER to the REFERENCE ANSWER.
Rate the overall similarity on this scale:
- EXCELLENT: Model answer captures all key information correctly
- GOOD: Model answer captures most key information with minor gaps
- PARTIAL: Model answer captures some key information but has significant gaps
- POOR: Model answer misses most key information or is incorrect

REFERENCE ANSWER:
${reference.substring(0, 1500)}

MODEL ANSWER:
${response.substring(0, 1500)}

Answer with ONLY one word: EXCELLENT, GOOD, PARTIAL, or POOR:`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout || 20000);

    try {
        const url = `${judgeConfig.host}/api/generate`;
        const fetchOptions = getFetchOptions(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                prompt,
                stream: false,
                options: {
                    temperature: 0.1,
                    num_predict: 15
                }
            }),
            signal: controller.signal
        });

        const res = await fetch(url, fetchOptions);
        clearTimeout(timeoutId);

        if (!res.ok) {
            throw new Error(`Judge HTTP ${res.status}`);
        }

        const data = await res.json();
        const text = (data.response || '').toLowerCase().trim();

        const scoreMap = {
            excellent: 10,
            good: 7.5,
            partial: 5,
            poor: 2
        };

        for (const [rating, score] of Object.entries(scoreMap)) {
            if (text.includes(rating)) {
                return { similarity: rating, score };
            }
        }

        // Default to partial if unclear
        logger.warn('Unclear similarity rating', { response: text });
        return { similarity: 'partial', score: 5 };
    } catch (err) {
        clearTimeout(timeoutId);
        logger.error('Similarity check failed', { error: err.message });
        return { similarity: 'error', score: 5 };
    }
}

/**
 * Main reference-based scoring function
 * @param {string} response - Model response to evaluate
 * @param {Object} prompt - Prompt object with reference_answer
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} Complete scoring result
 */
async function score(response, prompt, judgeConfig) {
    const reference = prompt.reference_answer;

    if (!reference) {
        logger.warn('Reference scoring requires reference_answer', {
            prompt: prompt.name || 'unknown'
        });
        return null;
    }

    logger.info('Starting reference-based scoring', {
        prompt: prompt.name || 'unknown',
        referenceLength: reference.length,
        responseLength: response?.length || 0
    });

    const startTime = Date.now();

    // Extract key points from reference
    const keyPoints = extractKeyPoints(reference);

    // Check each key point (in parallel for speed)
    const keyPointResults = await Promise.all(
        keyPoints.map(point => checkKeyPoint(response, point, judgeConfig))
    );

    // Calculate key points coverage
    const matched = keyPointResults.filter(r => r.found).length;
    const total = keyPoints.length;
    const coveragePercent = total > 0 ? Math.round((matched / total) * 100) : 0;

    // Check for contradictions
    const contradictions = await checkContradictions(response, reference, judgeConfig);

    // Get overall similarity
    const similarity = await checkOverallSimilarity(response, reference, judgeConfig);

    // Calculate final score
    // 70% similarity rating, 30% coverage, penalty if contradictions
    let finalScore = similarity.score * 0.7 + (coveragePercent / 10) * 0.3;
    if (contradictions.hasContradictions) {
        finalScore = Math.max(0, finalScore - 2);
    }
    finalScore = Math.round(finalScore * 10) / 10;

    const scoringTimeMs = Date.now() - startTime;

    logger.info('Reference scoring complete', {
        prompt: prompt.name || 'unknown',
        finalScore,
        coverage: `${matched}/${total}`,
        similarity: similarity.similarity,
        hasContradictions: contradictions.hasContradictions,
        time_ms: scoringTimeMs
    });

    return {
        quality_score: finalScore,
        scoring_method: 'reference',
        scoring_type: prompt.scoring_type || 'general',
        breakdown: {
            similarity_rating: similarity.similarity,
            similarity_score: similarity.score,
            key_points_matched: matched,
            key_points_total: total,
            coverage_percent: coveragePercent,
            has_contradictions: contradictions.hasContradictions
        },
        key_points_detail: keyPoints.map((point, i) => ({
            point: point.substring(0, 100),
            found: keyPointResults[i].found
        })),
        explanation: `Reference comparison: ${similarity.similarity} overall similarity, ${matched}/${total} key points covered${contradictions.hasContradictions ? ', contradictions detected' : ''}`,
        scoring_time_ms: scoringTimeMs,
        judge_model: judgeConfig.model,
        judge_host: judgeConfig.host
    };
}

/**
 * Simple reference comparison without detailed breakdown
 * Faster but less granular
 * @param {string} response - Model response
 * @param {string} reference - Reference answer
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} Quick score result
 */
async function quickCompare(response, reference, judgeConfig) {
    const similarity = await checkOverallSimilarity(response, reference, judgeConfig);
    const contradictions = await checkContradictions(response, reference, judgeConfig);

    let score = similarity.score;
    if (contradictions.hasContradictions) {
        score = Math.max(0, score - 2);
    }

    return {
        quality_score: Math.round(score * 10) / 10,
        scoring_method: 'reference_quick',
        similarity: similarity.similarity,
        has_contradictions: contradictions.hasContradictions
    };
}

module.exports = {
    score,
    quickCompare,
    extractKeyPoints,
    checkKeyPoint,
    checkContradictions,
    checkOverallSimilarity
};
