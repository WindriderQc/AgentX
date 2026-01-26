/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { HOSTS } = require('./modelRouter');
const { getFetchOptions } = require('../helpers/httpAgent');
const hardwareProfileService = require('./hardwareProfileService');

// Judge model configuration - use a capable model for evaluation
const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q4_0',  // Fast but capable judge
    fallback_model: 'llama3.2:1b',       // Fallback if primary unavailable
    host: null,                           // Will be set dynamically from env
    timeout: 30000,                       // 30s timeout for judge calls
    temperature: 0.3,                     // Adjusted for nuanced scoring variation (Audit Issue 6)
    num_predict: 500,                     // Increased to allow full explanations (Audit Issue 6)
    max_retries: 2                        // Added for resilience (Audit Issue 6)
};

// Initialize host from env
if (process.env.OLLAMA_HOST) {
    JUDGE_CONFIG.host = process.env.OLLAMA_HOST;
}

/**
 * Enhanced scoring configurations with 8-12 dimensions per category
 * Used when prompt.scoring_dimensions is not defined
 * Follows the spec from docs/operations/ENHANCED_JUDGING_SYSTEM_PLAN.md
 */
const ENHANCED_SCORING_CONFIGS = {
    coding: {
        dimensions: [
            { name: 'correctness', weight: 0.20, desc: 'Does code work & produce correct output?' },
            { name: 'clarity', weight: 0.12, desc: 'Is code readable & well-structured?' },
            { name: 'efficiency', weight: 0.12, desc: 'Reasonable performance for task?' },
            { name: 'maintainability', weight: 0.10, desc: 'Easy to modify & extend?' },
            { name: 'error_handling', weight: 0.10, desc: 'Robust error handling?' },
            { name: 'documentation', weight: 0.10, desc: 'Comments & explanations?' },
            { name: 'best_practices', weight: 0.08, desc: 'Follows language idioms?' },
            { name: 'testability', weight: 0.07, desc: 'Easy to test?' },
            { name: 'scalability', weight: 0.06, desc: 'Handles larger datasets/load?' },
            { name: 'security', weight: 0.05, desc: 'Avoids common vulnerabilities?' }
        ]
    },
    reasoning: {
        dimensions: [
            { name: 'accuracy', weight: 0.20, desc: 'Is conclusion correct?' },
            { name: 'logic_soundness', weight: 0.18, desc: 'Is reasoning valid?' },
            { name: 'depth', weight: 0.12, desc: 'Sufficient analysis depth?' },
            { name: 'clarity', weight: 0.10, desc: 'Clear explanation?' },
            { name: 'completeness', weight: 0.10, desc: 'Addresses all aspects?' },
            { name: 'coherence', weight: 0.08, desc: 'Internally consistent?' },
            { name: 'method_quality', weight: 0.08, desc: 'Appropriate approach?' },
            { name: 'premise_handling', weight: 0.07, desc: 'Correct use of given facts?' },
            { name: 'alternative_consideration', weight: 0.07, desc: 'Considers other possibilities?' }
        ]
    },
    factual: {
        dimensions: [
            { name: 'accuracy', weight: 0.30, desc: 'Factually correct?' },
            { name: 'completeness', weight: 0.15, desc: 'Answers question fully?' },
            { name: 'precision', weight: 0.15, desc: 'Specific & detailed?' },
            { name: 'clarity', weight: 0.10, desc: 'Clearly presented?' },
            { name: 'source_awareness', weight: 0.10, desc: 'Acknowledges sources?' },
            { name: 'context_appropriateness', weight: 0.10, desc: 'Right level of detail?' },
            { name: 'bias_neutrality', weight: 0.05, desc: 'Objective and balanced?' },
            { name: 'update_recency', weight: 0.05, desc: 'Reflects current knowledge?' }
        ]
    },
    math: {
        dimensions: [
            { name: 'answer_correctness', weight: 0.30, desc: 'Final answer correct?' },
            { name: 'method', weight: 0.20, desc: 'Solution approach valid?' },
            { name: 'rigor', weight: 0.15, desc: 'Mathematically rigorous?' },
            { name: 'presentation', weight: 0.10, desc: 'Clearly shown?' },
            { name: 'notation', weight: 0.05, desc: 'Proper notation used?' },
            { name: 'edge_cases', weight: 0.05, desc: 'Handles special cases?' },
            { name: 'proof_completeness', weight: 0.10, desc: 'All steps justified?' },
            { name: 'calculation_accuracy', weight: 0.05, desc: 'No arithmetic errors?' }
        ]
    },
    creative: {
        dimensions: [
            { name: 'creativity', weight: 0.20, desc: 'Original & imaginative?' },
            { name: 'coherence', weight: 0.15, desc: 'Well-structured & logical?' },
            { name: 'relevance', weight: 0.15, desc: 'Addresses task?' },
            { name: 'originality', weight: 0.15, desc: 'Unique approach?' },
            { name: 'emotional_impact', weight: 0.10, desc: 'Engaging?' },
            { name: 'style', weight: 0.05, desc: 'Appropriate voice?' },
            { name: 'audience_fit', weight: 0.05, desc: 'Right for audience?' },
            { name: 'engagement', weight: 0.05, desc: 'Captures attention?' },
            { name: 'narrative_flow', weight: 0.05, desc: 'Smooth progression?' },
            { name: 'sensory_detail', weight: 0.05, desc: 'Vivid descriptions?' }
        ]
    },
    general: {
        dimensions: [
            { name: 'helpfulness', weight: 0.25, desc: 'Achieves user goal?' },
            { name: 'relevance', weight: 0.20, desc: 'On-topic and focused?' },
            { name: 'clarity', weight: 0.15, desc: 'Easy to understand?' },
            { name: 'conciseness', weight: 0.10, desc: 'No unnecessary filler?' },
            { name: 'tone_appropriateness', weight: 0.10, desc: 'Right level of formality?' },
            { name: 'instruction_adherence', weight: 0.10, desc: 'Follows all constraints?' },
            { name: 'safety', weight: 0.10, desc: 'Content is safe and ethical?' }
        ]
    },
    // Enhanced judging system: 6 new categories for better model differentiation
    'instruction-following': {
        dimensions: [
            { name: 'instruction_adherence', weight: 0.25, desc: 'Follows instructions precisely?' },
            { name: 'constraint_compliance', weight: 0.20, desc: 'Respects all constraints?' },
            { name: 'format_accuracy', weight: 0.15, desc: 'Output format correct?' },
            { name: 'completeness', weight: 0.12, desc: 'All requirements met?' },
            { name: 'implicit_understanding', weight: 0.10, desc: 'Grasps implicit intent?' },
            { name: 'edge_case_handling', weight: 0.08, desc: 'Handles edge cases well?' },
            { name: 'negative_constraint_adherence', weight: 0.10, desc: 'Does NOT do forbidden things?' }
        ]
    },
    summarization: {
        dimensions: [
            { name: 'accuracy', weight: 0.20, desc: 'Preserves key information?' },
            { name: 'conciseness', weight: 0.18, desc: 'Appropriately brief?' },
            { name: 'completeness', weight: 0.18, desc: 'Captures main points?' },
            { name: 'coherence', weight: 0.15, desc: 'Logically structured?' },
            { name: 'abstraction', weight: 0.12, desc: 'Right level of detail?' },
            { name: 'readability', weight: 0.10, desc: 'Easy to understand?' },
            { name: 'objectivity', weight: 0.07, desc: 'Free from judge commentary?' }
        ]
    },
    translation: {
        dimensions: [
            { name: 'accuracy', weight: 0.25, desc: 'Meaning preserved correctly?' },
            { name: 'fluency', weight: 0.20, desc: 'Natural in target language?' },
            { name: 'grammar', weight: 0.15, desc: 'Grammatically correct?' },
            { name: 'idiom_usage', weight: 0.12, desc: 'Idiomatic expressions appropriate?' },
            { name: 'cultural_sensitivity', weight: 0.10, desc: 'Culturally appropriate?' },
            { name: 'tone_preservation', weight: 0.08, desc: 'Original tone maintained?' },
            { name: 'contextual_equivalence', weight: 0.10, desc: 'Fits the situational context?' }
        ]
    },
    'multi-turn-reasoning': {
        dimensions: [
            { name: 'context_retention', weight: 0.20, desc: 'Remembers previous context?' },
            { name: 'logical_progression', weight: 0.18, desc: 'Builds on prior steps?' },
            { name: 'accuracy', weight: 0.18, desc: 'Final conclusion correct?' },
            { name: 'coherence', weight: 0.15, desc: 'Consistent throughout?' },
            { name: 'depth', weight: 0.10, desc: 'Sufficient analysis depth?' },
            { name: 'synthesis', weight: 0.08, desc: 'Integrates information well?' },
            { name: 'state_tracking', weight: 0.11, desc: 'Keeps track of changes?' }
        ]
    },
    'context-retention': {
        dimensions: [
            { name: 'recall_accuracy', weight: 0.25, desc: 'Recalls information correctly?' },
            { name: 'relevance_filtering', weight: 0.18, desc: 'Retrieves relevant context?' },
            { name: 'temporal_awareness', weight: 0.15, desc: 'Understands information order?' },
            { name: 'integration', weight: 0.15, desc: 'Integrates old & new context?' },
            { name: 'consistency', weight: 0.12, desc: 'Consistent with prior statements?' },
            { name: 'scope_management', weight: 0.08, desc: 'Appropriate context window?' },
            { name: 'no_hallucination', weight: 0.07, desc: 'Does not invent context?' }
        ]
    },
    'edge-cases': {
        dimensions: [
            { name: 'error_handling', weight: 0.25, desc: 'Handles errors gracefully?' },
            { name: 'boundary_awareness', weight: 0.20, desc: 'Recognizes edge conditions?' },
            { name: 'robustness', weight: 0.18, desc: 'Stable under unusual inputs?' },
            { name: 'graceful_degradation', weight: 0.15, desc: 'Fails gracefully?' },
            { name: 'validation', weight: 0.10, desc: 'Validates inputs properly?' },
            { name: 'recovery', weight: 0.07, desc: 'Recovers from errors?' },
            { name: 'input_sanitization', weight: 0.05, desc: 'Handles malformed input?' }
        ]
    },
    refactoring: {
        dimensions: [
            { name: 'readability_improvement', weight: 0.25, desc: 'Is code clearer?' },
            { name: 'logic_preservation', weight: 0.25, desc: 'Behavior remains identical?' },
            { name: 'complexity_reduction', weight: 0.15, desc: 'Reduced cyclomatic complexity?' },
            { name: 'dry_principle', weight: 0.10, desc: 'Removed redundancy?' },
            { name: 'naming_quality', weight: 0.10, desc: 'Better variable/function names?' },
            { name: 'modularization', weight: 0.08, desc: 'Improved separation of concerns?' },
            { name: 'idiomatic_code', weight: 0.07, desc: 'Uses language-specific best patterns?' }
        ]
    },
    debugging: {
        dimensions: [
            { name: 'root_cause_identification', weight: 0.30, desc: 'Found the actual bug?' },
            { name: 'fix_correctness', weight: 0.25, desc: 'Does the fix work?' },
            { name: 'minimal_intervention', weight: 0.15, desc: 'Avoided unnecessary changes?' },
            { name: 'side_effect_avoidance', weight: 0.10, desc: 'No new bugs introduced?' },
            { name: 'explanation_clarity', weight: 0.10, desc: 'Clear reason for the bug?' },
            { name: 'prevention_strategy', weight: 0.10, desc: 'Suggested how to avoid it?' }
        ]
    },
    explanation: {
        dimensions: [
            { name: 'clarity', weight: 0.25, desc: 'Easy to follow?' },
            { name: 'accuracy', weight: 0.25, desc: 'Technically correct?' },
            { name: 'analogical_quality', weight: 0.15, desc: 'Good examples/metaphors?' },
            { name: 'structure', weight: 0.12, desc: 'Logical flow of information?' },
            { name: 'completeness', weight: 0.10, desc: 'No missing key details?' },
            { name: 'audience_fit', weight: 0.08, desc: 'Right level of technicality?' },
            { name: 'conciseness', weight: 0.05, desc: 'No unnecessary detail?' }
        ]
    },
    dialogue: {
        dimensions: [
            { name: 'naturalness', weight: 0.20, desc: 'Sounds human-like?' },
            { name: 'turn_relevance', weight: 0.20, desc: 'Addresses previous turn?' },
            { name: 'persona_consistency', weight: 0.15, desc: 'Maintains character/tone?' },
            { name: 'engagement', weight: 0.15, desc: 'Keeps conversation going?' },
            { name: 'helpfulness', weight: 0.12, desc: 'User goals achieved?' },
            { name: 'proactivity', weight: 0.10, desc: 'Suggests next steps?' },
            { name: 'politeness', weight: 0.08, desc: 'Appropriate etiquette?' }
        ]
    }
};

/**
 * Legacy scoring configurations (3-5 dimensions)
 * DEPRECATED: Use ENHANCED_SCORING_CONFIGS exclusively. (Audit Step 3)
 */
const SCORING_CONFIGS = {
    code: {
        weight: { correctness: 0.5, clarity: 0.3, efficiency: 0.2 },
        prompt: `You are a code quality evaluator. Analyze the given code response and score it.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all scores - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
1. Correctness (0-10): Does the code work and produce correct output?
2. Clarity (0-10): Is the code readable and well-structured?
3. Efficiency (0-10): Is it reasonably efficient for the task?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"correctness": X, "clarity": X, "efficiency": X, "overall": X, "explanation": "brief reason"}`
    },
    
    reasoning: {
        weight: { accuracy: 0.4, logic: 0.4, clarity: 0.2 },
        prompt: `You are a reasoning quality evaluator. Analyze the logical reasoning in this response.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all scores - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
1. Accuracy (0-10): Is the conclusion/answer correct?
2. Logic (0-10): Is the reasoning process sound and valid?
3. Clarity (0-10): Is the explanation clear and understandable?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"accuracy": X, "logic": X, "clarity": X, "overall": X, "explanation": "brief reason"}`
    },
    
    factual: {
        weight: { accuracy: 0.7, completeness: 0.2, clarity: 0.1 },
        prompt: `You are a factual accuracy evaluator. Check if this response is factually correct.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all scores - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
1. Accuracy (0-10): Is the information factually correct?
2. Completeness (0-10): Does it answer the question fully?
3. Clarity (0-10): Is it presented clearly?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"accuracy": X, "completeness": X, "clarity": X, "overall": X, "explanation": "brief reason"}`
    },
    
    math: {
        weight: { answer: 0.6, method: 0.3, presentation: 0.1 },
        prompt: `You are a math evaluator. Check if the mathematical answer and work is correct.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all scores - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
1. Answer (0-10): Is the final answer correct?
2. Method (0-10): Is the solution method/work correct?
3. Presentation (0-10): Is it clearly presented?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"answer": X, "method": X, "presentation": X, "overall": X, "explanation": "brief reason"}`
    },
    
    creative: {
        weight: { creativity: 0.4, coherence: 0.3, relevance: 0.3 },
        prompt: `You are a creative writing evaluator. Assess the creativity and quality of this response.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all scores - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
1. Creativity (0-10): Is it original and imaginative?
2. Coherence (0-10): Is it well-structured and logical?
3. Relevance (0-10): Does it address the task appropriately?

TASK: {{task}}
EXPECTED: {{expected}}
RESPONSE TO EVALUATE:
{{response}}

Respond ONLY with JSON in this exact format:
{"creativity": X, "coherence": X, "relevance": X, "overall": X, "explanation": "brief reason"}`
    }
};

/**
 * Build a dynamic judge prompt from scoring dimensions
 * @param {Array} dimensions - Array of dimension objects {name, weight, desc}
 * @param {string} task - The task/prompt to evaluate
 * @param {string} expected - Expected answer or criteria
 * @param {string} response - The response to evaluate
 * @returns {string} Formatted judge prompt
 */
function buildDynamicJudgePrompt(dimensions, task, expected, response) {
    const criteriaList = dimensions.map((dim, idx) => {
        return `${idx + 1}. ${dim.name.replace(/_/g, ' ')} (0-10): ${dim.desc}`;
    }).join('\n');

    const jsonFormat = dimensions.reduce((acc, dim) => {
        acc[dim.name] = 'X';
        return acc;
    }, {});
    jsonFormat.overall = 'X';
    jsonFormat.explanation = 'brief reason';

    return `You are a quality evaluator. Analyze the given response and score it across multiple dimensions.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all dimensions - the model failed to produce output.
IMPORTANT: 'overall' score must be 0-10, NOT a sum of dimension scores. (Audit Issue 4)

CRITERIA TO EVALUATE:
${criteriaList}

TASK: ${task}
EXPECTED: ${expected}
RESPONSE TO EVALUATE:
${response}

Respond ONLY with JSON in this exact format:
${JSON.stringify(jsonFormat, null, 2)}`;
}

/**
 * Get scoring dimensions for a prompt
 * Priority: prompt.scoring_dimensions > ENHANCED_SCORING_CONFIGS
 * DEPRECATED: legacy SCORING_CONFIGS fallback removed.
 * @param {Object} prompt - The benchmark prompt object
 * @returns {Object} { dimensions: Array, weights: Object, useLegacy: boolean }
 */
function getScoringDimensions(prompt) {
    // Priority 1: Use prompt's custom scoring_dimensions if defined
    if (prompt.scoring_dimensions && Array.isArray(prompt.scoring_dimensions) && prompt.scoring_dimensions.length > 0) {
        const dimensions = prompt.scoring_dimensions.map(dim => ({
            name: dim.name,
            weight: dim.weight,
            desc: dim.description || dim.desc || ''
        }));
        const weights = dimensions.reduce((acc, dim) => {
            acc[dim.name] = dim.weight;
            return acc;
        }, {});

        logger.info('Using custom scoring dimensions from prompt', {
            prompt: prompt.name || 'unknown',
            dimensionCount: dimensions.length
        });

        return { dimensions, weights, useLegacy: false };
    }

    // Priority 2: Use enhanced scoring configs based on scoring_type
    // Map 'code' to 'coding' for consistency if needed
    let scoringType = prompt.scoring_type || prompt.prompt_category || 'reasoning';
    if (scoringType === 'code') scoringType = 'coding';

    const enhancedConfig = ENHANCED_SCORING_CONFIGS[scoringType] || ENHANCED_SCORING_CONFIGS.reasoning;

    const dimensions = enhancedConfig.dimensions;
    const weights = dimensions.reduce((acc, dim) => {
        acc[dim.name] = dim.weight;
        return acc;
    }, {});

    logger.info('Using enhanced scoring dimensions', {
        prompt: prompt.name || 'unknown',
        scoringType,
        dimensionCount: dimensions.length
    });

    return { dimensions, weights, useLegacy: false };
}

/**
 * Quick scoring for simple factual answers
 * Uses pattern matching before calling LLM judge
 * Only triggers when prompt has expected_answer defined
 */
function quickScore(response, prompt) {
    // Only use quick scoring if we have an expected answer
    const expectedAnswer = prompt.expected_answer || prompt.expected;
    if (!expectedAnswer) {
        return null; // Fall back to LLM judge
    }
    
    const resp = response.toLowerCase().trim();
    
    // Audit Issue 10: Use regex with word boundaries to prevent false positives
    const checkPattern = (answer) => {
        const regex = new RegExp(`\\b${answer}\\b`, 'i');
        return regex.test(resp);
    };

    // Direct answer patterns for common factual questions
    const quickPatterns = {
        'capital of france': { answer: 'paris' },
        '15 + 27': { answer: '42' },
        '15+27': { answer: '42' },
        'world war ii end': { answer: '1945' },
        'wwii end': { answer: '1945' },
        '2, 4, 8, 16': { answer: '32' },
        '2x + 5 = 17': { answer: '6' }
    };
    
    const promptLower = prompt.prompt ? prompt.prompt.toLowerCase() : prompt.toLowerCase();
    
    for (const [pattern, check] of Object.entries(quickPatterns)) {
        if (promptLower.includes(pattern)) {
            const isMatch = checkPattern(check.answer);
            const score = isMatch ? 10 : 0;

            logger.info('Quick scoring match', { pattern, score, expected: check.answer });
            return {
                quick: true,
                score: score,
                expected: check.answer,
                matched: isMatch,
                pattern
            };
        }
    }
    
    return null; // Needs LLM evaluation
}

/**
 * Normalize and clamp scores to 0-10 range (Audit Issue 2)
 * @param {number} score - The raw score to normalize
 * @param {string} dimensionName - Name of dimension for logging
 * @returns {number} Normalized score
 */
function normalizeScore(score, dimensionName = 'unknown') {
    let normalized = parseFloat(score);
    if (isNaN(normalized)) {
        logger.warn(`Invalid score for ${dimensionName}`, { raw: score });
        normalized = 0;
    }
    // Clamp to 0-10 range
    const clamped = Math.max(0, Math.min(10, normalized));
    if (clamped !== normalized) {
        logger.warn('Score clamped', { dimension: dimensionName, original: normalized, clamped });
    }
    return clamped;
}

/**
 * Call the judge model to evaluate a response with retry logic (Audit Issue 7)
 * @param {string} evalPrompt - The evaluation prompt
 * @param {Object} config - Optional configuration override
 * @returns {Promise<Object>} Parsed scores
 */
async function callJudge(evalPrompt, config = {}) {
    const judgeConfig = { ...JUDGE_CONFIG, ...config };
    let retries = 0;
    const maxRetries = judgeConfig.max_retries !== undefined ? judgeConfig.max_retries : 2;

    while (retries <= maxRetries) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), judgeConfig.timeout);
        
        try {
            // Use HTTP agent for connection pooling
            const url = `${judgeConfig.host}/api/generate`;
            const fetchOptions = getFetchOptions(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: judgeConfig.model,
                    prompt: evalPrompt,
                    stream: false,
                    options: {
                        temperature: judgeConfig.temperature,
                        num_predict: judgeConfig.num_predict,
                        num_ctx: 8192
                    }
                }),
                signal: controller.signal
            });
            const response = await fetch(url, fetchOptions);

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Judge HTTP ${response.status}`);
            }

            const data = await response.json();
            const text = data.response || '';

            // Detect if judge output was truncated (hit token limit)
            const judgeTruncated = data.done_reason === 'length';
            const judgeTokens = data.eval_count || 0;

            // Extract JSON from response
            let jsonStr = null;

            // 1. Try Markdown code block
            const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (codeBlockMatch) {
                jsonStr = codeBlockMatch[1];
            } else {
                // 2. Try finding outermost braces
                const firstBrace = text.indexOf('{');
                const lastBrace = text.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                    jsonStr = text.substring(firstBrace, lastBrace + 1);
                }
            }

            if (!jsonStr) {
                throw new Error('No JSON found in judge response');
            }
            
            try {
                // 3. Clean and parse
                // Fix common LLM JSON issues:
                // - Control characters
                // - Invalid escape sequences (like LaTeX \( or \))
                let sanitized = jsonStr.replace(/[\x00-\x1F\x7F-\x9F]/g, "");

                // Escape backslashes that are not part of a valid JSON escape sequence
                // Valid escapes: \" \\ \/ \b \f \n \r \t \uXXXX
                // We conservatively escape \ followed by anything else
                sanitized = sanitized.replace(/\\([^"\\/bfnrtu])/g, "\\\\$1");

                const scores = JSON.parse(sanitized);

                // Audit Issue 5: JSON Response Validation
                // Ensure overall exists and is numeric
                if (scores.overall === undefined || typeof scores.overall !== 'number') {
                    throw new Error('Invalid judge response: overall score missing or not numeric');
                }

                return {
                    success: true,
                    scores,
                    raw: text,
                    judge_truncated: judgeTruncated,
                    judge_tokens: judgeTokens
                };
            } catch (parseErr) {
                throw new Error(`JSON parse failed: ${parseErr.message}`);
            }

        } catch (err) {
            clearTimeout(timeoutId);
            retries++;

            if (retries > maxRetries) {
                logger.error('Judge call failed after retries', {
                    error: err.message,
                    retries,
                    judge_model: judgeConfig.model
                });
                return {
                    success: false,
                    error: err.message,
                    scores: null
                };
            }

            const delay = Math.min(1000 * Math.pow(2, retries - 1), 5000);
            logger.warn(`Judge call failed, retrying in ${delay}ms...`, { error: err.message, retry: retries });
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Score a model response for quality
 * @param {Object} params - Scoring parameters
 * @param {string} params.response - The model's response to evaluate
 * @param {Object} params.prompt - The prompt object with expected answer and criteria
 * @param {boolean} params.skipLLM - Skip LLM judge, use quick scoring only
 * @param {Object} params.judgeConfig - Optional configuration for the judge model
 * @param {Object} params._batchHardwareSnapshot - Cached hardware snapshot for batch runs (Audit Issue 11)
 * @returns {Promise<Object>} Quality scores
 */
async function scoreResponse({ response, prompt, skipLLM = false, judgeConfig = {}, _batchHardwareSnapshot = null }) {
    const startTime = Date.now();
    
    // Try quick scoring first (only if expected answer exists)
    const quickResult = quickScore(response, prompt);
    if (quickResult && quickResult.quick) {
        const explanation = quickResult.matched
            ? `Quick scoring matched expected answer "${quickResult.expected}" (pattern: ${quickResult.pattern}).`
            : `Quick scoring did not match expected answer "${quickResult.expected}" (pattern: ${quickResult.pattern}).`;

        logger.info('Quick scoring used', { 
            pattern: quickResult.pattern, 
            matched: quickResult.matched, 
            score: quickResult.score,
            prompt: prompt.name || prompt.prompt_name || 'unknown'
        });

        return {
            quality_score: quickResult.score,
            scoring_method: 'quick',
            matched_expected: quickResult.matched,
            expected_answer: quickResult.expected,
            quick_pattern: quickResult.pattern,
            explanation,
            judge_prompt: 'Quick scoring used (no judge model invoked).',
            scoring_time_ms: Date.now() - startTime,
            breakdown: {
                accuracy: quickResult.score,
                overall: quickResult.score
            }
        };
    }
    
    if (skipLLM) {
        return {
            quality_score: null,
            scoring_method: 'skipped',
            reason: 'LLM scoring disabled',
            scoring_time_ms: Date.now() - startTime
        };
    }
    
    // Validate that response is not empty before scoring (Audit Issue 1)
    if (!response || response.trim().length === 0) {
        logger.warn('Attempting to score empty response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            response_length: response ? response.length : 0,
            task: prompt.prompt ? prompt.prompt.substring(0, 100) : 'unknown'
        });
        return {
            quality_score: 0,
            scoring_method: 'validator',
            scoring_type: prompt.scoring_type || 'reasoning',
            explanation: 'CRITICAL: Model produced NO response. Unable to evaluate empty output. Automatic score: 0/10',
            breakdown: { 
                accuracy: 0, 
                correctness: 0, 
                completeness: 0,
                clarity: 0,
                overall: 0 
            },
            scoring_time_ms: Date.now() - startTime,
            judge_prompt: 'EMPTY_RESPONSE_DETECTION',
            judge_model: 'empty_response_validator',
            judge_raw_response: 'Model failed to generate any response text'
        };
    }
    
    // Use LLM-as-judge for complex evaluation
    const scoringType = prompt.scoring_type || 'reasoning';
    const dimensionsInfo = getScoringDimensions(prompt);

    let evalPrompt;
    let config;

    if (dimensionsInfo.useLegacy) {
        // Backward compatibility: use legacy prompt template
        config = dimensionsInfo.legacyConfig;

        // Allow overriding prompt from judgeConfig
        if (judgeConfig.prompts && judgeConfig.prompts[scoringType]) {
            config = { ...config, prompt: judgeConfig.prompts[scoringType] };
        }

        evalPrompt = config.prompt
            .replace('{{task}}', prompt.prompt || prompt)
            .replace('{{expected}}', prompt.expected_answer || 'See criteria')
            .replace('{{response}}', response);
    } else {
        // Enhanced scoring: use dynamic dimensions
        evalPrompt = buildDynamicJudgePrompt(
            dimensionsInfo.dimensions,
            prompt.prompt || prompt,
            prompt.expected_answer || 'See criteria',
            response
        );
        config = { weight: dimensionsInfo.weights };
    }

    const judgeResult = await callJudge(evalPrompt, judgeConfig);
    
    if (!judgeResult.success) {
        logger.warn('LLM judge failed', { 
            error: judgeResult.error, 
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_model: judgeConfig.model || JUDGE_CONFIG.model
        });
        return {
            quality_score: null,
            scoring_method: 'llm_failed',
            error: judgeResult.error,
            explanation: `Judge model failed: ${judgeResult.error}`,
            judge_prompt: evalPrompt,
            judge_model: judgeConfig.model || JUDGE_CONFIG.model,
            scoring_time_ms: Date.now() - startTime
        };
    }
    
    const rawScores = judgeResult.scores;
    const scores = {};

    // Normalize and clamp all provided dimension scores (Audit Issue 2)
    for (const [key, val] of Object.entries(rawScores)) {
        if (typeof val === 'number') {
            scores[key] = normalizeScore(val, key);
        } else if (key === 'explanation') {
            scores[key] = val;
        }
    }
    
    // Ensure overall score exists and is clamped (JSON structure validated in callJudge)
    const overallScore = normalizeScore(rawScores.overall, 'overall');

    logger.info('LLM judge scoring completed', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        score: overallScore,
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        scoring_type: scoringType,
        time_ms: Date.now() - startTime
    });

    // Build truncation info (only judge output truncation is tracked now)
    const truncation = {
        judge_truncated: judgeResult.judge_truncated || false,
        judge_tokens: judgeResult.judge_tokens || 0
    };

    // Log warning if judge output was truncated
    if (judgeResult.judge_truncated) {
        logger.warn('Judge output truncated', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_tokens: judgeResult.judge_tokens
        });
    }

    // Detect judge hardware with timeout (Audit Issue 11)
    let judgeHardwareSnapshot = _batchHardwareSnapshot;
    if (!judgeHardwareSnapshot) {
        try {
            const judgeHost = judgeConfig.host || JUDGE_CONFIG.host;
            const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;
            if (judgeHost && judgeModel) {
                // Use Promise.race for 5s timeout
                const hwPromise = hardwareProfileService.detectHardware(judgeHost, judgeModel);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Hardware detection timeout')), 5000)
                );
                judgeHardwareSnapshot = await Promise.race([hwPromise, timeoutPromise]);
            }
        } catch (hwErr) {
            logger.debug('Judge hardware detection failed (non-critical)', { error: hwErr.message });
        }
    }

    return {
        quality_score: overallScore,
        scoring_method: 'llm_judge',
        scoring_type: scoringType,
        breakdown: scores,
        explanation: scores.explanation || 'No explanation provided', // Audit Issue 8
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        judge_host: judgeConfig.host || JUDGE_CONFIG.host,
        judge_hardware_snapshot: judgeHardwareSnapshot,
        scoring_time_ms: Date.now() - startTime,
        judge_prompt: evalPrompt,
        judge_raw_response: judgeResult.raw || null,
        truncation
    };
}

/**
 * Category-specific composite profiles
 * Each category has custom weights for quality, latency, and speed
 * Aligned with Enhanced Judging System Plan Phase 1 Week 5
 */
const CATEGORY_COMPOSITE_PROFILES = {
    // Original 6 categories
    coding: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 45000, // 45s (users tolerate slower for correct code)
        description: "Code quality > speed"
    },
    reasoning: {
        weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
        latencyCap: 120000, // 120s (deep thinking takes time)
        description: "Reasoning depth matters most"
    },
    factual: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 20000, // 20s (Facts should be quick)
        description: "Accuracy + responsiveness"
    },
    math: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 30000, // 30s
        description: "Correctness critical"
    },
    creative: {
        weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
        latencyCap: 60000, // 60s
        description: "Balance quality and flow"
    },
    general: {
        weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
        latencyCap: 30000, // 30s (general purpose)
        description: "Balanced general-purpose profile"
    },

    // Enhanced judging system: 6 new categories
    'instruction-following': {
        weights: { quality: 0.85, latency: 0.10, speed: 0.05 },
        latencyCap: 30000,
        description: "Precision matters most"
    },
    summarization: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 25000,
        description: "Concise and fast"
    },
    translation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 40000,
        description: "Accuracy and fluency critical"
    },
    'multi-turn-reasoning': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 90000,
        description: "Context retention critical"
    },
    'context-retention': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 60000,
        description: "Recall accuracy critical"
    },
    'edge-cases': {
        weights: { quality: 0.80, latency: 0.12, speed: 0.08 },
        latencyCap: 35000,
        description: "Robustness over speed"
    },
    refactoring: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 50000,
        description: "Code improvement quality"
    },
    debugging: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 45000,
        description: "Diagnosis accuracy critical"
    },
    explanation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 30000,
        description: "Clarity and accuracy focused"
    },
    dialogue: {
        weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
        latencyCap: 30000,
        description: "Natural flow balanced with speed"
    }
};

/**
 * Calculate composite score combining speed and quality
 * @param {Object} metrics - Performance and quality metrics
 * @param {String} profileOrCategory - Scoring profile ('interactive' | 'reasoning' | 'coding') or category name
 * @returns {Object} Composite scores
 */
function calculateCompositeScore(metrics, profileOrCategory = 'interactive') {
    let { latency, tokens_per_sec, quality_score } = metrics;

    // Ensure inputs are valid numbers
    latency = Number(latency);
    if (isNaN(latency)) latency = 0;

    tokens_per_sec = parseFloat(tokens_per_sec);
    if (isNaN(tokens_per_sec)) tokens_per_sec = 0;

    quality_score = Number(quality_score);
    if (isNaN(quality_score)) quality_score = 0;

    // Legacy profiles for backward compatibility
    const LEGACY_PROFILES = {
        interactive: {
            weights: { quality: 0.4, latency: 0.4, speed: 0.2 },
            latencyCap: 30000, // 30s
            description: "Optimized for user-facing chat"
        },
        reasoning: {
            weights: { quality: 0.8, latency: 0.1, speed: 0.1 },
            latencyCap: 120000, // 120s
            description: "Optimized for complex problem solving"
        },
        coding: {
            weights: { quality: 0.7, latency: 0.2, speed: 0.1 },
            latencyCap: 60000, // 60s
            description: "Optimized for code generation accuracy"
        }
    };

    // Determine which profile to use
    let config;
    let profileUsed;

    // Priority 1: Check if it's a category-specific profile
    if (CATEGORY_COMPOSITE_PROFILES[profileOrCategory]) {
        config = CATEGORY_COMPOSITE_PROFILES[profileOrCategory];
        profileUsed = `category:${profileOrCategory}`;
    }
    // Priority 2: Check if it's a legacy profile
    else if (LEGACY_PROFILES[profileOrCategory]) {
        config = LEGACY_PROFILES[profileOrCategory];
        profileUsed = `profile:${profileOrCategory}`;
    }
    // Priority 3: Default to interactive legacy profile
    else {
        config = LEGACY_PROFILES.interactive;
        profileUsed = 'profile:interactive';
    }

    const weights = config.weights;

    // Normalize latency (lower is better)
    // Score: 100 at 0ms, 0 at cap
    const latencyScore = Math.max(0, 100 - ((latency / config.latencyCap) * 100));
    
    // Normalize tokens/sec (higher is better, cap at 100 t/s) (Audit Issue 9)
    // Linear normalization: 0 t/s = 0, 100 t/s = 100
    const speedScore = Math.max(0, Math.min(100, (parseFloat(tokens_per_sec) || 0)));
    
    // Quality score is 0-10, scale to 0-100
    const qualityScore = (quality_score || 0) * 10;
    
    const composite = (
        qualityScore * weights.quality +
        latencyScore * weights.latency +
        speedScore * weights.speed
    );

    return {
        composite_score: Math.round(composite * 10) / 10, // Round to 1 decimal (already 0-100 scale)
        normalized: {
            quality: Math.round(qualityScore * 10) / 10,
            latency: Math.round(latencyScore * 10) / 10,
            speed: Math.round(speedScore * 10) / 10
        },
        weights,
        profile: profileOrCategory, // Keep original parameter for backward compatibility
        composite_profile_used: profileUsed // Track which profile was actually used
    };
}

/**
 * Batch score multiple responses with concurrency (Audit Issue 12)
 * @param {Array} results - Array of benchmark results with responses
 * @param {Object} options - Scoring options { profile: 'interactive'|'reasoning', concurrency: 5 }
 * @returns {Promise<Array>} Results with quality scores added
 */
async function batchScore(results, options = {}) {
    const concurrency = options.concurrency || 5;
    const profile = options.profile || 'interactive';
    const scoredResults = [];

    // Audit Issue 11: Detect hardware ONCE for entire batch
    let judgeHardwareSnapshot = null;
    try {
        const judgeHost = options.judgeConfig?.host || JUDGE_CONFIG.host;
        const judgeModel = options.judgeConfig?.model || JUDGE_CONFIG.model;
        if (judgeHost && judgeModel) {
            const hwPromise = hardwareProfileService.detectHardware(judgeHost, judgeModel);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Hardware detection timeout')), 5000)
            );
            judgeHardwareSnapshot = await Promise.race([hwPromise, timeoutPromise]);
        }
    } catch (hwErr) {
        logger.debug('Batch hardware detection failed (non-critical)', { error: hwErr.message });
    }

    const processResult = async (result) => {
        if (!result.response || !result.success) {
            return {
                ...result,
                quality_score: null,
                scoring_method: 'skipped',
                reason: result.success ? 'no_response' : 'test_failed'
            };
        }
        
        // Get prompt details for scoring
        const promptInfo = {
            prompt: result.prompt,
            expected_answer: result.expected_answer || '',
            scoring_type: result.prompt_category || 'reasoning',
            judge_criteria: result.judge_criteria || []
        };
        
        const scores = await scoreResponse({
            response: result.response,
            prompt: promptInfo,
            judgeConfig: options.judgeConfig,
            _batchHardwareSnapshot: judgeHardwareSnapshot
        });
        
        const composite = calculateCompositeScore({
            latency: result.latency,
            tokens_per_sec: result.tokens_per_sec,
            quality_score: scores.quality_score
        }, profile);
        
        return {
            ...result,
            ...scores,
            ...composite
        };
    };

    // Process in parallel batches (controlled concurrency)
    for (let i = 0; i < results.length; i += concurrency) {
        const chunk = results.slice(i, i + concurrency);
        const chunkResults = await Promise.all(chunk.map(r => processResult(r)));
        scoredResults.push(...chunkResults);
    }
    
    return scoredResults;
}

/**
 * Validate that all enhanced scoring weights sum to 1.0 (Audit Issue 3)
 */
function validateWeights() {
    for (const [category, config] of Object.entries(ENHANCED_SCORING_CONFIGS)) {
        if (!config.dimensions) continue;

        const sum = config.dimensions.reduce((acc, dim) => acc + dim.weight, 0);
        if (Math.abs(sum - 1.0) > 0.001) {
            const msg = `Invalid weight configuration: ${category}: dimension weights sum to ${sum.toFixed(3)}, expected 1.0`;
            logger.error(msg);
            throw new Error(msg);
        }
    }
    logger.info('Enhanced scoring weights validated successfully');
}

/**
 * Validate that all category composite weights sum to 1.0
 */
function validateCompositeWeights() {
    for (const [category, config] of Object.entries(CATEGORY_COMPOSITE_PROFILES)) {
        const weights = config.weights;
        const sum = Object.values(weights).reduce((acc, w) => acc + w, 0);
        if (Math.abs(sum - 1.0) > 0.001) {
            const msg = `Invalid composite weight configuration: ${category}: weights sum to ${sum.toFixed(3)}, expected 1.0`;
            logger.error(msg);
            throw new Error(msg);
        }
    }
    logger.info('Category composite weights validated successfully');
}

// Run validations on module load
try {
    validateWeights();
    validateCompositeWeights();
} catch (err) {
    logger.error('Weight validation failed at load time', { error: err.message });
    // In production, we might want to proceed but log heavily.
    // For now, following audit recommendation to prevent runtime surprises.
}

module.exports = {
    scoreResponse,
    calculateCompositeScore,
    batchScore,
    quickScore,
    buildDynamicJudgePrompt,
    getScoringDimensions,
    SCORING_CONFIGS,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    JUDGE_CONFIG,
    validateWeights,
    validateCompositeWeights
};
