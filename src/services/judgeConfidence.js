/**
 * Judge Confidence Service
 * Detects when judge is unreliable and flags for review
 *
 * Unreliability signals:
 * - Score spread < 1.0 (all dimensions 7-8 = suspicious clustering)
 * - Vague explanation (< 50 chars or generic phrases)
 * - High-level prompt (7+) with very high score (judge may not understand)
 * - Prompt complexity >> judge capability
 */

const logger = require('../../config/logger');

/**
 * Generic phrases that indicate low-quality explanations
 */
const GENERIC_PHRASES = [
    'overall good',
    'generally correct',
    'satisfactory',
    'meets requirements',
    'acceptable response',
    'the response is',
    'well done',
    'good job',
    'nice work',
    'as expected'
];

/**
 * Calculate score spread (max - min) across dimensions
 * @param {Object} breakdown - Score breakdown object { dimension: score }
 * @returns {number} Score spread
 */
function calculateScoreSpread(breakdown) {
    if (!breakdown || typeof breakdown !== 'object') return 0;

    const scores = Object.values(breakdown)
        .filter(v => typeof v === 'number');

    if (scores.length < 2) return 0;

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    return max - min;
}

/**
 * Check if explanation is too vague
 * @param {string} explanation - Judge explanation
 * @returns {Object} { isVague: boolean, reason: string }
 */
function checkExplanationQuality(explanation) {
    if (!explanation || typeof explanation !== 'string') {
        return { isVague: true, reason: 'No explanation provided' };
    }

    const trimmed = explanation.trim();

    // Too short
    if (trimmed.length < 50) {
        return { isVague: true, reason: `Explanation too short (${trimmed.length} chars)` };
    }

    // Contains generic phrases
    const lower = trimmed.toLowerCase();
    for (const phrase of GENERIC_PHRASES) {
        if (lower.includes(phrase)) {
            return { isVague: true, reason: `Contains generic phrase: "${phrase}"` };
        }
    }

    // No specific feedback (lacks dimension names or numbers)
    const hasSpecifics = /\b\d+(\.\d+)?\/10\b|\b(correct|incorrect|missing|unclear)\b/i.test(trimmed);
    if (!hasSpecifics && trimmed.length < 150) {
        return { isVague: true, reason: 'Lacks specific feedback' };
    }

    return { isVague: false, reason: null };
}

/**
 * Check for level-score mismatch
 * High level prompts with very high scores are suspicious
 * @param {number} level - Prompt difficulty level (1-10)
 * @param {number} score - Quality score (0-10)
 * @returns {Object} { suspicious: boolean, reason: string }
 */
function checkLevelScoreMismatch(level, score) {
    // Levels 7+ are hard - consistent perfect scores are suspicious
    if (level >= 7 && score >= 9.5) {
        return {
            suspicious: true,
            reason: `Level ${level} prompt with near-perfect score (${score}) - judge may not understand complexity`
        };
    }

    // Level 8+ with score 9+ is even more suspicious
    if (level >= 8 && score >= 9.0) {
        return {
            suspicious: true,
            reason: `Level ${level} prompt with very high score (${score}) - review recommended`
        };
    }

    // Level 9-10 should almost never get perfect scores
    if (level >= 9 && score >= 8.5) {
        return {
            suspicious: true,
            reason: `Extreme difficulty (Level ${level}) with high score (${score}) - automatic review`
        };
    }

    return { suspicious: false, reason: null };
}

/**
 * Check if scores cluster suspiciously (low variance)
 * @param {Object} breakdown - Score breakdown
 * @returns {Object} { suspicious: boolean, reason: string }
 */
function checkScoreClustering(breakdown) {
    const spread = calculateScoreSpread(breakdown);

    // All scores within 1 point is suspicious (indicates judge giving same score to everything)
    if (spread < 1.0 && Object.keys(breakdown).length >= 3) {
        return {
            suspicious: true,
            reason: `Suspiciously low score spread (${spread.toFixed(1)}) - all dimensions scored similarly`
        };
    }

    // Check for all-same scores
    const scores = Object.values(breakdown).filter(v => typeof v === 'number');
    const unique = new Set(scores);
    if (scores.length >= 3 && unique.size === 1) {
        return {
            suspicious: true,
            reason: `All dimensions scored identically (${scores[0]}) - judge may not be differentiating`
        };
    }

    return { suspicious: false, reason: null };
}

/**
 * Estimate prompt complexity based on various factors
 * @param {Object} prompt - Prompt object
 * @returns {number} Complexity score 1-10
 */
function estimatePromptComplexity(prompt) {
    let complexity = prompt.level || 5;

    // Adjust based on prompt length
    const promptLength = (prompt.prompt || '').length;
    if (promptLength > 2000) complexity += 1;
    if (promptLength > 5000) complexity += 1;

    // Adjust based on expected answer complexity
    const expectedLength = (prompt.expected_answer || '').length;
    if (expectedLength > 1000) complexity += 0.5;

    // Certain categories are inherently harder
    const hardCategories = ['multi-turn-reasoning', 'edge-cases', 'reasoning'];
    if (hardCategories.includes(prompt.category || prompt.scoring_type)) {
        complexity += 0.5;
    }

    return Math.min(10, Math.max(1, complexity));
}

/**
 * Main confidence assessment function
 * @param {Object} scoreResult - Result from scoring (has breakdown, explanation, etc.)
 * @param {Object} prompt - The prompt that was scored
 * @returns {Object} Confidence assessment
 */
function assess(scoreResult, prompt) {
    const issues = [];
    let confidence = 1.0;

    // Check score spread
    if (scoreResult.breakdown) {
        const clustering = checkScoreClustering(scoreResult.breakdown);
        if (clustering.suspicious) {
            issues.push(clustering.reason);
            confidence -= 0.2;
        }
    }

    // Check explanation quality
    const explanationCheck = checkExplanationQuality(scoreResult.explanation);
    if (explanationCheck.isVague) {
        issues.push(explanationCheck.reason);
        confidence -= 0.15;
    }

    // Check level-score mismatch
    const level = prompt.level || 5;
    const levelCheck = checkLevelScoreMismatch(level, scoreResult.quality_score);
    if (levelCheck.suspicious) {
        issues.push(levelCheck.reason);
        confidence -= 0.25;
    }

    // Check if judge truncated (indicates it struggled)
    if (scoreResult.truncation?.judge_truncated) {
        issues.push('Judge output was truncated - may be incomplete');
        confidence -= 0.1;
    }

    // Check if scoring method was fallback
    if (scoreResult.scoring_method === 'llm_failed') {
        issues.push('LLM judge failed - using fallback scoring');
        confidence = 0.1;
    }

    // Check complexity vs judge capability
    const complexity = estimatePromptComplexity(prompt);
    if (complexity >= 8 && scoreResult.scoring_method === 'llm_judge') {
        issues.push(`High complexity prompt (${complexity.toFixed(1)}) - 7B judge may struggle`);
        confidence -= 0.15;
    }

    // Clamp confidence to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    // Determine if review is needed
    const needsReview = confidence < 0.7 || issues.length >= 2;

    return {
        judge_confidence: Math.round(confidence * 100) / 100,
        needs_review: needsReview,
        review_reason: issues.length > 0 ? issues.join('; ') : null,
        issues,
        prompt_complexity: complexity,
        score_spread: scoreResult.breakdown ? calculateScoreSpread(scoreResult.breakdown) : null
    };
}

/**
 * Quick confidence check without full analysis
 * @param {number} score - Quality score
 * @param {number} level - Prompt level
 * @returns {Object} { confidence: number, needsReview: boolean }
 */
function quickCheck(score, level) {
    let confidence = 1.0;

    // Level 7+ with high scores is suspicious
    if (level >= 7 && score >= 9.0) {
        confidence = 0.5;
    } else if (level >= 8 && score >= 8.0) {
        confidence = 0.6;
    } else if (level >= 9) {
        confidence = 0.7; // Always lower confidence for extreme levels
    }

    return {
        confidence,
        needsReview: confidence < 0.7
    };
}

/**
 * Aggregate confidence across multiple results
 * @param {Array} results - Array of results with confidence assessments
 * @returns {Object} Aggregate statistics
 */
function aggregateConfidence(results) {
    if (!results || results.length === 0) {
        return { avgConfidence: 0, reviewNeeded: 0, total: 0 };
    }

    const confidences = results
        .map(r => r.judge_confidence)
        .filter(c => typeof c === 'number');

    const reviewNeeded = results.filter(r => r.needs_review).length;

    return {
        avgConfidence: confidences.length > 0
            ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
            : 0,
        minConfidence: confidences.length > 0 ? Math.min(...confidences) : 0,
        maxConfidence: confidences.length > 0 ? Math.max(...confidences) : 0,
        reviewNeeded,
        reviewPercent: Math.round((reviewNeeded / results.length) * 100),
        total: results.length
    };
}

module.exports = {
    assess,
    quickCheck,
    aggregateConfidence,
    calculateScoreSpread,
    checkExplanationQuality,
    checkLevelScoreMismatch,
    checkScoreClustering,
    estimatePromptComplexity,
    GENERIC_PHRASES
};
