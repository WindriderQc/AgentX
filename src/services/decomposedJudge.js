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
    },
    summarization: {
        accuracy: [
            { q: 'Does the summary preserve the key information from the original?', weight: 0.40 },
            { q: 'Are any facts in the summary incorrect or distorted?', weight: 0.35, invert: true },
            { q: 'Does it capture the main point or conclusion?', weight: 0.25 }
        ],
        conciseness: [
            { q: 'Is the summary appropriately brief for the task?', weight: 0.40 },
            { q: 'Does it meet any specified length or word count constraints?', weight: 0.35 },
            { q: 'Is unnecessary detail avoided?', weight: 0.25 }
        ],
        completeness: [
            { q: 'Are all major points from the source included?', weight: 0.50 },
            { q: 'Is any critical information missing?', weight: 0.50, invert: true }
        ],
        coherence: [
            { q: 'Does the summary read as a coherent standalone text?', weight: 0.50 },
            { q: 'Is the summary logically structured?', weight: 0.50 }
        ]
    },
    translation: {
        accuracy: [
            { q: 'Is the meaning of the original text preserved?', weight: 0.40 },
            { q: 'Are there any mistranslated words or phrases?', weight: 0.35, invert: true },
            { q: 'Are numbers, names, and technical terms correctly handled?', weight: 0.25 }
        ],
        fluency: [
            { q: 'Does the translation read naturally in the target language?', weight: 0.50 },
            { q: 'Is the sentence structure appropriate for the target language?', weight: 0.50 }
        ],
        grammar: [
            { q: 'Is the grammar correct in the target language?', weight: 0.50 },
            { q: 'Is punctuation and capitalization appropriate?', weight: 0.50 }
        ],
        cultural_fit: [
            { q: 'Are idioms and expressions adapted appropriately?', weight: 0.50 },
            { q: 'Is the tone suitable for the target audience?', weight: 0.50 }
        ]
    },
    explanation: {
        clarity: [
            { q: 'Is the explanation easy to follow?', weight: 0.40 },
            { q: 'Are technical terms defined or explained?', weight: 0.30 },
            { q: 'Are examples or analogies used effectively?', weight: 0.30 }
        ],
        accuracy: [
            { q: 'Is the explanation technically correct?', weight: 0.50 },
            { q: 'Are there any misleading statements?', weight: 0.50, invert: true }
        ],
        structure: [
            { q: 'Is the explanation logically ordered?', weight: 0.50 },
            { q: 'Does it build from simple to complex concepts?', weight: 0.50 }
        ],
        completeness: [
            { q: 'Are the key aspects of the topic covered?', weight: 0.60 },
            { q: 'Is important context provided?', weight: 0.40 }
        ]
    },
    debugging: {
        root_cause: [
            { q: 'Is the actual bug or issue correctly identified?', weight: 0.50 },
            { q: 'Is the root cause explained, not just symptoms?', weight: 0.50 }
        ],
        fix_correctness: [
            { q: 'Does the proposed fix address the root cause?', weight: 0.50 },
            { q: 'Would the fix work without introducing new bugs?', weight: 0.50 }
        ],
        minimal_intervention: [
            { q: 'Is the fix minimal and focused?', weight: 0.50 },
            { q: 'Are unrelated changes avoided?', weight: 0.50 }
        ],
        explanation: [
            { q: 'Is the reason for the bug clearly explained?', weight: 0.50 },
            { q: 'Would a developer understand the fix from the explanation?', weight: 0.50 }
        ]
    },
    refactoring: {
        readability_improvement: [
            { q: 'Is the refactored code more readable?', weight: 0.40 },
            { q: 'Are naming conventions improved?', weight: 0.30 },
            { q: 'Is the code structure cleaner?', weight: 0.30 }
        ],
        logic_preservation: [
            { q: 'Does the refactored code preserve original behavior?', weight: 0.50 },
            { q: 'Are there any functional regressions?', weight: 0.50, invert: true }
        ],
        simplicity: [
            { q: 'Is complexity reduced?', weight: 0.50 },
            { q: 'Are abstractions appropriate and not over-engineered?', weight: 0.50 }
        ],
        correctness: [
            { q: 'Is the refactored code syntactically valid?', weight: 0.50 },
            { q: 'Are edge cases still handled?', weight: 0.50 }
        ]
    },
    dialogue: {
        relevance: [
            { q: 'Does the response address the previous turn?', weight: 0.50 },
            { q: 'Is irrelevant tangent avoided?', weight: 0.50 }
        ],
        naturalness: [
            { q: 'Does the response sound natural and conversational?', weight: 0.50 },
            { q: 'Is the tone appropriate for the context?', weight: 0.50 }
        ],
        helpfulness: [
            { q: 'Does the response move the conversation toward the user goal?', weight: 0.50 },
            { q: 'Is useful information or action provided?', weight: 0.50 }
        ],
        engagement: [
            { q: 'Does the response encourage further interaction?', weight: 0.50 },
            { q: 'Is the response interesting or thoughtful?', weight: 0.50 }
        ]
    },
    'multi-turn-reasoning': {
        context_retention: [
            { q: 'Does the response correctly reference information from previous turns?', weight: 0.40 },
            { q: 'Is context from earlier steps used accurately?', weight: 0.35 },
            { q: 'Does it avoid contradicting earlier established facts?', weight: 0.25 }
        ],
        logical_progression: [
            { q: 'Does the reasoning build logically on previous steps?', weight: 0.40 },
            { q: 'Are new conclusions consistent with prior reasoning?', weight: 0.35 },
            { q: 'Is the chain of thought traceable?', weight: 0.25 }
        ],
        accuracy: [
            { q: 'Is the final conclusion correct?', weight: 0.50 },
            { q: 'Are intermediate results accurate?', weight: 0.50 }
        ],
        coherence: [
            { q: 'Is the overall response coherent across turns?', weight: 0.50 },
            { q: 'Does the response maintain a consistent position?', weight: 0.50 }
        ]
    },
    'context-retention': {
        recall_accuracy: [
            { q: 'Does the response correctly recall previously stated information?', weight: 0.40 },
            { q: 'Are specific details (names, numbers, facts) accurately recalled?', weight: 0.35 },
            { q: 'Is the recalled information attributed correctly?', weight: 0.25 }
        ],
        relevance_filtering: [
            { q: 'Does the response retrieve the most relevant context?', weight: 0.50 },
            { q: 'Is irrelevant context filtered out?', weight: 0.50 }
        ],
        consistency: [
            { q: 'Is the response consistent with earlier statements?', weight: 0.50 },
            { q: 'Are there any contradictions with prior context?', weight: 0.50, invert: true }
        ],
        no_hallucination: [
            { q: 'Does the response avoid inventing information not in the context?', weight: 0.60 },
            { q: 'Are claims grounded in the provided information?', weight: 0.40 }
        ]
    },
    'edge-cases': {
        error_handling: [
            { q: 'Does the response handle the unusual input gracefully?', weight: 0.40 },
            { q: 'Is an appropriate error or clarification provided?', weight: 0.35 },
            { q: 'Does it avoid crashing or producing garbage output?', weight: 0.25 }
        ],
        robustness: [
            { q: 'Does the response remain sensible under unusual conditions?', weight: 0.50 },
            { q: 'Does it degrade gracefully rather than fail completely?', weight: 0.50 }
        ],
        validation: [
            { q: 'Does the response identify invalid or problematic input?', weight: 0.50 },
            { q: 'Is the validation response appropriate and helpful?', weight: 0.50 }
        ],
        recovery: [
            { q: 'Does the response suggest a way forward despite the edge case?', weight: 0.50 },
            { q: 'Is helpful fallback behavior demonstrated?', weight: 0.50 }
        ]
    }
};

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
        ? `TASK:\n${taskContext.task.substring(0, 2000)}\n\n${taskContext.expected ? `EXPECTED ANSWER:\n${taskContext.expected.substring(0, 500)}\n\n` : ''}`
        : '';

    const prompt = `You are evaluating a model's response. Compare it against the expected answer.

${taskSection}MODEL RESPONSE:
${response.substring(0, 3000)}

Based on the above, answer ONLY "YES" or "NO": ${question}`;

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
                    num_predict: 20,
                    num_ctx: 8192
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
    const votes = await Promise.allSettled([
        singleBinaryCall(response, question, judgeConfig, taskContext),
        singleBinaryCall(response, question, judgeConfig, taskContext),
        singleBinaryCall(response, question, judgeConfig, taskContext)
    ]);

    const successes = votes
        .filter(v => v.status === 'fulfilled')
        .map(v => v.value);

    if (successes.length === 0) {
        logger.error('All 3 binary votes failed', {
            question,
            errors: votes.map(v => v.reason?.message || 'unknown')
        });
        return false;
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

    for (const item of questions) {
        const answer = await askBinaryQuestion(response, item.q, judgeConfig, taskContext);
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
    const category = prompt.scoring_type || prompt.category || 'general';
    const questions = DECOMPOSED_QUESTIONS[category];

    if (!questions) {
        if (category === 'general') {
            logger.error('DECOMPOSED_QUESTIONS missing "general" category - cannot score');
            return null;
        }
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

    // Build task context so judge can evaluate against the original task
    const taskContext = {
        task: prompt.prompt || '',
        expected: prompt.expected_answer || prompt.expected || ''
    };

    // Look up dimension weights from prompt (passed by qualityScorer routeScoring)
    const dimensionWeights = prompt._dimensionWeights || null;

    // Score each dimension
    for (const [dimension, dimensionQuestions] of Object.entries(questions)) {
        const result = await scoreDimension(response, dimensionQuestions, judgeConfig, taskContext);
        dimensionScores[dimension] = result.score;
        dimensionBreakdowns[dimension] = result.breakdown;
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

    return {
        quality_score: overallScore,
        scoring_method: 'decomposed',
        scoring_type: category,
        breakdown: dimensionScores,
        decomposed_breakdown: dimensionBreakdowns,
        explanation: buildExplanation(overallScore, category, dimensionScores, dimensionBreakdowns),
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
