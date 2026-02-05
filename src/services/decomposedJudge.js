/**
 * Decomposed Judge Service
 * Breaks complex evaluations into simple yes/no questions
 * the 7B model can answer reliably
 *
 * Instead of asking "Rate the code clarity 0-10", we ask:
 * - "Are variable names descriptive? YES/NO"
 * - "Is the code structure easy to follow? YES/NO"
 * - "Is logic broken into reasonable steps? YES/NO"
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');

/**
 * Decomposed questions for each category/dimension
 * Each question has a weight that contributes to the final score
 */
const DECOMPOSED_QUESTIONS = {
    code: {
        correctness: [
            { q: 'Does the code appear syntactically valid?', weight: 0.15 },
            { q: 'Does the code address the requested task?', weight: 0.25 },
            { q: 'Would it produce correct output for basic inputs?', weight: 0.35 },
            { q: 'Does it handle obvious edge cases?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Are variable and function names descriptive?', weight: 0.30 },
            { q: 'Is the code structure easy to follow?', weight: 0.30 },
            { q: 'Is the logic broken into reasonable steps?', weight: 0.25 },
            { q: 'Would a developer understand this quickly?', weight: 0.15 }
        ],
        efficiency: [
            { q: 'Does the code avoid obviously inefficient patterns?', weight: 0.35 },
            { q: 'Are loops and iterations reasonably optimized?', weight: 0.35 },
            { q: 'Is memory usage sensible for the task?', weight: 0.30 }
        ],
        robustness: [
            { q: 'Does the code handle null or empty inputs?', weight: 0.35 },
            { q: 'Are there appropriate error checks?', weight: 0.35 },
            { q: 'Would unexpected input cause a crash?', weight: 0.30, invert: true }
        ]
    },
    reasoning: {
        accuracy: [
            { q: 'Is the final conclusion or answer correct?', weight: 0.40 },
            { q: 'Are the intermediate steps accurate?', weight: 0.35 },
            { q: 'Does it avoid factual errors?', weight: 0.25 }
        ],
        logic_soundness: [
            { q: 'Does each step logically follow from the previous?', weight: 0.35 },
            { q: 'Are there any logical fallacies present?', weight: 0.30, invert: true },
            { q: 'Is the reasoning chain complete?', weight: 0.35 }
        ],
        clarity: [
            { q: 'Is the explanation easy to follow?', weight: 0.40 },
            { q: 'Are assumptions clearly stated?', weight: 0.30 },
            { q: 'Is the language precise and unambiguous?', weight: 0.30 }
        ],
        completeness: [
            { q: 'Does it address all parts of the question?', weight: 0.40 },
            { q: 'Are important edge cases considered?', weight: 0.30 },
            { q: 'Is the reasoning sufficiently detailed?', weight: 0.30 }
        ]
    },
    factual: {
        accuracy: [
            { q: 'Are the stated facts correct?', weight: 0.40 },
            { q: 'Are dates, numbers, and names accurate?', weight: 0.30 },
            { q: 'Does it avoid common misconceptions?', weight: 0.30 }
        ],
        completeness: [
            { q: 'Does it answer the question fully?', weight: 0.40 },
            { q: 'Are important related facts included?', weight: 0.35 },
            { q: 'Is sufficient context provided?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Is the information presented clearly?', weight: 0.40 },
            { q: 'Is it well-organized?', weight: 0.30 },
            { q: 'Is jargon explained when used?', weight: 0.30 }
        ],
        objectivity: [
            { q: 'Is the response balanced and unbiased?', weight: 0.50 },
            { q: 'Does it acknowledge limitations or uncertainty?', weight: 0.50 }
        ]
    },
    math: {
        answer_correctness: [
            { q: 'Is the final numeric answer correct?', weight: 0.50 },
            { q: 'Is the answer in the expected format?', weight: 0.25 },
            { q: 'Are units correct (if applicable)?', weight: 0.25 }
        ],
        method: [
            { q: 'Is the solution approach valid for this problem?', weight: 0.35 },
            { q: 'Are the right formulas or methods used?', weight: 0.35 },
            { q: 'Are calculation steps shown?', weight: 0.30 }
        ],
        rigor: [
            { q: 'Are all steps mathematically justified?', weight: 0.40 },
            { q: 'Are edge cases or constraints checked?', weight: 0.35 },
            { q: 'Is the solution complete?', weight: 0.25 }
        ],
        clarity: [
            { q: 'Are the steps easy to follow?', weight: 0.50 },
            { q: 'Is notation used correctly?', weight: 0.50 }
        ]
    },
    creative: {
        originality: [
            { q: 'Does the response show creative thinking?', weight: 0.35 },
            { q: 'Does it avoid cliches and generic responses?', weight: 0.35 },
            { q: 'Is there an unexpected or interesting element?', weight: 0.30 }
        ],
        coherence: [
            { q: 'Does the creative content make sense?', weight: 0.40 },
            { q: 'Is there a logical structure or flow?', weight: 0.35 },
            { q: 'Are ideas connected well?', weight: 0.25 }
        ],
        engagement: [
            { q: 'Is the content interesting or compelling?', weight: 0.40 },
            { q: 'Would someone want to read/see more?', weight: 0.35 },
            { q: 'Does it evoke emotion or thought?', weight: 0.25 }
        ],
        relevance: [
            { q: 'Does it address the creative prompt?', weight: 0.50 },
            { q: 'Does it stay on topic?', weight: 0.50 }
        ]
    },
    'instruction-following': {
        instruction_adherence: [
            { q: 'Does the response follow the main instruction?', weight: 0.40 },
            { q: 'Are all sub-instructions followed?', weight: 0.35 },
            { q: 'Is the intent of the instruction understood?', weight: 0.25 }
        ],
        constraint_compliance: [
            { q: 'Are all constraints respected?', weight: 0.40 },
            { q: 'Are there any rule violations?', weight: 0.35, invert: true },
            { q: 'Is forbidden content avoided?', weight: 0.25 }
        ],
        format_accuracy: [
            { q: 'Is the output format exactly as requested?', weight: 0.50 },
            { q: 'Are structure requirements met?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Are all required elements present?', weight: 0.50 },
            { q: 'Is nothing missing from the response?', weight: 0.50 }
        ]
    },
    general: {
        helpfulness: [
            { q: 'Does the response help achieve the user goal?', weight: 0.40 },
            { q: 'Is actionable information provided?', weight: 0.35 },
            { q: 'Would the user be satisfied?', weight: 0.25 }
        ],
        relevance: [
            { q: 'Does the response stay on topic?', weight: 0.50 },
            { q: 'Is irrelevant information avoided?', weight: 0.50 }
        ],
        clarity: [
            { q: 'Is the response easy to understand?', weight: 0.50 },
            { q: 'Is it well-organized?', weight: 0.50 }
        ],
        accuracy: [
            { q: 'Is the information factually correct?', weight: 0.60 },
            { q: 'Are claims supported or verifiable?', weight: 0.40 }
        ]
    }
};

/**
 * Ask a single binary (YES/NO) question to the judge
 * @param {string} response - The model response to evaluate
 * @param {string} question - The yes/no question to ask
 * @param {Object} judgeConfig - Judge configuration (host, model, etc.)
 * @returns {Promise<boolean>} True for YES, false for NO
 */
async function askBinaryQuestion(response, question, judgeConfig) {
    const prompt = `Given this response:
---
${response.substring(0, 2000)}
---

Answer ONLY "YES" or "NO": ${question}`;

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
                    temperature: 0.1, // Very low for consistent binary answers
                    num_predict: 10   // Only need YES or NO
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

        // Interpret response
        if (text.includes('yes')) {
            return true;
        } else if (text.includes('no')) {
            return false;
        } else {
            // Ambiguous - log and default to false (conservative)
            logger.warn('Ambiguous binary response', {
                question,
                response: text,
                defaulting: false
            });
            return false;
        }
    } catch (err) {
        clearTimeout(timeoutId);
        logger.error('Binary question failed', {
            error: err.message,
            question
        });
        return false; // Conservative default
    }
}

/**
 * Score a dimension using decomposed binary questions
 * @param {string} response - Model response to evaluate
 * @param {Array} questions - Array of { q: string, weight: number, invert?: boolean }
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} { score: number, breakdown: Array }
 */
async function scoreDimension(response, questions, judgeConfig) {
    const results = [];
    let totalWeight = 0;
    let earnedWeight = 0;

    for (const item of questions) {
        const answer = await askBinaryQuestion(response, item.q, judgeConfig);
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

    return {
        score,
        breakdown: results,
        earned: earnedWeight,
        total: totalWeight
    };
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
    const category = prompt.scoring_type || prompt.category || 'general';
    const questions = DECOMPOSED_QUESTIONS[category];

    if (!questions) {
        logger.warn('No decomposed questions for category', {
            category,
            fallback: 'general'
        });
        return score(response, { ...prompt, scoring_type: 'general' }, judgeConfig);
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

    // Score each dimension
    for (const [dimension, dimensionQuestions] of Object.entries(questions)) {
        const result = await scoreDimension(response, dimensionQuestions, judgeConfig);
        dimensionScores[dimension] = result.score;
        dimensionBreakdowns[dimension] = result.breakdown;
        overallScore += result.score;
        dimensionCount++;
    }

    // Calculate overall as average of dimension scores
    overallScore = dimensionCount > 0
        ? Math.round((overallScore / dimensionCount) * 10) / 10
        : 0;

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

    return {
        quality_score: overallScore,
        scoring_method: 'decomposed',
        scoring_type: category,
        breakdown: dimensionScores,
        decomposed_breakdown: dimensionBreakdowns,
        explanation: `Evaluated ${totalQuestions} binary questions across ${dimensionCount} dimensions`,
        scoring_time_ms: scoringTimeMs,
        judge_model: judgeConfig.model,
        judge_host: judgeConfig.host
    };
}

/**
 * Get available dimensions for a category
 * @param {string} category - Category name
 * @returns {Array<string>} List of dimension names
 */
function getDimensions(category) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS.general;
    return Object.keys(questions);
}

/**
 * Get questions for a specific category/dimension
 * @param {string} category - Category name
 * @param {string} dimension - Dimension name (optional)
 * @returns {Object|Array} Questions object or array
 */
function getQuestions(category, dimension = null) {
    const questions = DECOMPOSED_QUESTIONS[category] || DECOMPOSED_QUESTIONS.general;
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
