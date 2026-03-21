/**
 * Decomposed Judge Service
 * Breaks complex evaluations into simple yes/no questions
 * the 7B model can answer reliably
 *
 * Instead of asking "Rate the code clarity 0-10", we ask:
 * - "Are variable names descriptive? YES/NO"
 * - "Is the code structure easy to follow? YES/NO"
 * - "Is logic broken into reasonable steps? YES/NO"
 *
 * Question bank extracted to: decomposedJudgeQuestions.js
 */

const fetch = require('node-fetch');
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const { DECOMPOSED_QUESTIONS } = require('./decomposedJudgeQuestions');
const { resolveEffectiveJudgeContext } = require('./scoring/judgeRuntimeConfig');
const { DEFAULT_SCORING_CATEGORY, normalizeScoringCategory } = require('./scoring/scoringConfigs');

const DEFAULT_DECOMPOSED_CATEGORY = DEFAULT_SCORING_CATEGORY;

/**
 * Make a single binary YES/NO call to the judge model
 * @param {string} response - The model response to evaluate
 * @param {string} question - The yes/no question to ask
 * @param {Object} judgeConfig - Judge configuration (host, model, etc.)
 * @param {Object} taskContext - Optional { task, expected } for context
 * @returns {Promise<boolean>} True for YES, false for NO
 */
async function singleBinaryCall(response, question, judgeConfig, taskContext = {}) {
    const taskSection = taskContext.task
        ? `TASK:\n${taskContext.task.substring(0, 2000)}\n\n${taskContext.expected ? `EXPECTED ANSWER:\n${taskContext.expected.substring(0, 1000)}\n\n` : ''}`
        : '';

    const prompt = `You are evaluating ONE specific aspect of a model's response.
IMPORTANT: Focus ONLY on the specific question below. A wrong computed value does NOT mean the format or structure is wrong. Evaluate each aspect independently.

${taskSection}MODEL RESPONSE:
${response.substring(0, 3000)}

Answer ONLY "YES" or "NO" for this specific question: ${question}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout || 15000);

    try {
        const judgeContext = await resolveEffectiveJudgeContext(judgeConfig, { fallbackNumCtx: 4096 });
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
                    num_predict: 20,
                    num_ctx: judgeContext.num_ctx
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

        if (text.includes('yes')) {
            return true;
        } else if (text.includes('no')) {
            return false;
        } else {
            logger.warn('Ambiguous binary response', {
                question,
                response: text,
                defaulting: false
            });
            return false;
        }
    } catch (err) {
        clearTimeout(timeoutId);
        throw err; // Let caller handle
    }
}

/**
 * Ask a binary (YES/NO) question with majority voting (best-of-3)
 * Fires 3 parallel calls and takes majority vote for stability
 * @param {string} response - The model response to evaluate
 * @param {string} question - The yes/no question to ask
 * @param {Object} judgeConfig - Judge configuration (host, model, etc.)
 * @param {Object} taskContext - Optional { task, expected } for context
 * @returns {Promise<boolean>} True for YES, false for NO
 */
async function askBinaryQuestion(response, question, judgeConfig, taskContext = {}) {
    const votingCount = judgeConfig.voting_count || 1;

    // Single call mode (default) — no voting overhead
    if (votingCount <= 1) {
        try {
            return await singleBinaryCall(response, question, judgeConfig, taskContext);
        } catch (err) {
            logger.error('Binary call failed', { question, error: err.message });
            return null; // null = error, distinct from false = judge said NO
        }
    }

    // Majority voting mode
    const calls = [];
    for (let i = 0; i < votingCount; i++) {
        calls.push(singleBinaryCall(response, question, judgeConfig, taskContext));
    }
    const votes = await Promise.allSettled(calls);

    const successes = votes
        .filter(v => v.status === 'fulfilled')
        .map(v => v.value);

    if (successes.length === 0) {
        logger.error(`All ${votingCount} binary votes failed`, {
            question,
            errors: votes.map(v => v.reason?.message || 'unknown')
        });
        return null; // null = error, distinct from false = judge said NO
    }

    if (successes.length === 1) {
        return successes[0];
    }

    const yesCount = successes.filter(v => v === true).length;
    const result = yesCount > successes.length / 2;

    if (yesCount > 0 && yesCount < successes.length) {
        logger.warn('Binary vote disagreement', {
            question: question.substring(0, 80),
            votes: successes.map(v => v ? 'YES' : 'NO'),
            result: result ? 'YES' : 'NO'
        });
    }

    return result;
}

/**
 * Score a dimension using decomposed binary questions
 * @param {string} response - Model response to evaluate
 * @param {Array} questions - Array of { q: string, weight: number, invert?: boolean }
 * @param {Object} judgeConfig - Judge configuration
 * @param {Object} taskContext - Optional { task, expected } for context
 * @returns {Promise<Object>} { score: number, breakdown: Array }
 */
async function scoreDimension(response, questions, judgeConfig, taskContext = {}) {
    const results = [];
    let totalWeight = 0;
    let earnedWeight = 0;

    let errorCount = 0;

    for (const item of questions) {
        const answer = await askBinaryQuestion(response, item.q, judgeConfig, taskContext);

        // null = judge error (timeout/failure), skip this question entirely
        if (answer === null) {
            errorCount++;
            results.push({
                question: item.q,
                answer: null,
                weight: item.weight,
                inverted: item.invert || false,
                contributed: false,
                error: true
            });
            continue;
        }

        const effectiveAnswer = item.invert ? !answer : answer;

        results.push({
            question: item.q,
            answer,
            weight: item.weight,
            inverted: item.invert || false,
            contributed: effectiveAnswer
        });

        totalWeight += item.weight;
        if (effectiveAnswer) {
            earnedWeight += item.weight;
        }
    }

    const score = totalWeight > 0
        ? Math.round((earnedWeight / totalWeight) * 10 * 10) / 10
        : 0;

    // If all questions errored, signal that this dimension is unreliable
    if (errorCount > 0) {
        logger.warn('Binary call errors in dimension', {
            errors: errorCount,
            total: questions.length,
            allFailed: errorCount === questions.length
        });
    }

    return {
        score,
        breakdown: results,
        earned: earnedWeight,
        total: totalWeight,
        errors: errorCount
    };
}

/**
 * Build a rich human-readable explanation from dimension scores
 */
function buildExplanation(overallScore, category, dimensionScores, dimensionBreakdowns) {
    const parts = [];
    for (const [dim, dimScore] of Object.entries(dimensionScores)) {
        const breakdown = dimensionBreakdowns[dim] || [];
        const total = breakdown.length;
        const passed = breakdown.filter(q => q.contributed).length;
        const dimLabel = dim.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        let dimStr = `${dimLabel}: ${dimScore} (${passed}/${total})`;
        if (dimScore < 8.0) {
            const firstFail = breakdown.find(q => !q.contributed);
            if (firstFail) {
                const qText = firstFail.question.length > 60
                    ? firstFail.question.substring(0, 57) + '...'
                    : firstFail.question;
                dimStr += ` -- "${qText}" failed`;
            }
        }
        parts.push(dimStr);
    }
    return `Score ${overallScore}/10 (${category}). ${parts.join('. ')}.`;
}

/**
 * Main decomposed scoring function
 * Evaluates a response using binary questions for each dimension
 * @param {string} response - Model response to evaluate
 * @param {Object} prompt - Prompt object with scoring_type/category
 * @param {Object} judgeConfig - Judge configuration { host, model, timeout }
 * @returns {Promise<Object>} Complete scoring result
 */
async function score(response, prompt, judgeConfig) {
    const category = normalizeScoringCategory(
        prompt.scoring_type || prompt.category,
        DEFAULT_DECOMPOSED_CATEGORY
    );
    const questions = DECOMPOSED_QUESTIONS[category];

    if (!questions) {
        if (category === DEFAULT_DECOMPOSED_CATEGORY) {
            logger.error('DECOMPOSED_QUESTIONS missing default fallback category - cannot score', {
                fallback: DEFAULT_DECOMPOSED_CATEGORY
            });
            return null;
        }
        logger.warn('No decomposed questions for category', {
            category,
            fallback: DEFAULT_DECOMPOSED_CATEGORY
        });
        return score(response, { ...prompt, scoring_type: DEFAULT_DECOMPOSED_CATEGORY }, judgeConfig);
    }

    logger.info('Starting decomposed judging', {
        prompt: prompt.name || 'unknown',
        category,
        dimensions: Object.keys(questions).length
    });

    const startTime = Date.now();
    const dimensionScores = {};
    const dimensionBreakdowns = {};
    let overallScore = 0;
    let dimensionCount = 0;

    // Build task context so judge can evaluate against the original task
    const taskContext = {
        task: prompt.prompt || '',
        expected: prompt.expected_answer || prompt.expected || ''
    };

    // Look up dimension weights from prompt (passed by qualityScorer routeScoring)
    const dimensionWeights = prompt._dimensionWeights || null;

    // Score all dimensions concurrently (questions within each dimension are still sequential)
    const dimensionEntries = Object.entries(questions);
    const dimensionResults = await Promise.all(
        dimensionEntries.map(([dimension, dimensionQuestions]) =>
            scoreDimension(response, dimensionQuestions, judgeConfig, taskContext)
                .then(result => ({ dimension, result }))
        )
    );

    let totalErrors = 0;
    for (const { dimension, result } of dimensionResults) {
        dimensionScores[dimension] = result.score;
        dimensionBreakdowns[dimension] = result.breakdown;
        totalErrors += result.errors || 0;
        dimensionCount++;
    }

    // Calculate overall using ENHANCED_SCORING_CONFIGS weights if available,
    // otherwise fall back to simple average
    if (dimensionWeights && Object.keys(dimensionWeights).length > 0) {
        let weightedSum = 0;
        let totalWeight = 0;
        for (const [dim, score] of Object.entries(dimensionScores)) {
            const w = dimensionWeights[dim] || 0;
            weightedSum += score * w;
            totalWeight += w;
        }
        overallScore = totalWeight > 0
            ? Math.round((weightedSum / totalWeight) * 10) / 10
            : 0;
    } else {
        overallScore = dimensionCount > 0
            ? Math.round((Object.values(dimensionScores).reduce((a, b) => a + b, 0) / dimensionCount) * 10) / 10
            : 0;
    }

    const totalQuestions = Object.values(questions)
        .reduce((sum, q) => sum + q.length, 0);
    const scoringTimeMs = Date.now() - startTime;

    logger.info('Decomposed judging complete', {
        prompt: prompt.name || 'unknown',
        category,
        overallScore,
        dimensions: dimensionCount,
        questionsAsked: totalQuestions,
        time_ms: scoringTimeMs
    });

    // Flag if judge had significant errors
    const judgeReliable = totalErrors === 0;
    if (!judgeReliable) {
        logger.warn('Decomposed judge had errors, result may be unreliable', {
            prompt: prompt.name || 'unknown',
            totalErrors,
            totalQuestions,
            errorRate: (totalErrors / totalQuestions * 100).toFixed(1) + '%'
        });
    }

    return {
        quality_score: overallScore,
        scoring_method: 'decomposed',
        scoring_type: category,
        breakdown: dimensionScores,
        decomposed_breakdown: dimensionBreakdowns,
        explanation: buildExplanation(overallScore, category, dimensionScores, dimensionBreakdowns),
        scoring_time_ms: scoringTimeMs,
        judge_model: judgeConfig.model,
        judge_host: judgeConfig.host,
        judge_reliable: judgeReliable,
        judge_errors: totalErrors
    };
}

/**
 * Get available dimensions for a category
 * @param {string} category - Category name
 * @returns {Array<string>} List of dimension names
 */
function getDimensions(category) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS[DEFAULT_DECOMPOSED_CATEGORY];
    return Object.keys(questions);
}

/**
 * Get questions for a specific category/dimension
 * @param {string} category - Category name
 * @param {string} dimension - Dimension name (optional)
 * @returns {Object|Array} Questions object or array
 */
function getQuestions(category, dimension = null) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS[DEFAULT_DECOMPOSED_CATEGORY];
    if (dimension) {
        return questions[dimension] || [];
    }
    return questions;
}

module.exports = {
    score,
    askBinaryQuestion,
    scoreDimension,
    getDimensions,
    getQuestions,
    DECOMPOSED_QUESTIONS
};
