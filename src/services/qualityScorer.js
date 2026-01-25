/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { HOSTS } = require('./modelRouter');
const { getFetchOptions } = require('../helpers/httpAgent');

// Judge model configuration - use a capable model for evaluation
const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q4_0',  // Fast but capable judge
    fallback_model: 'llama3.2:1b',       // Fallback if primary unavailable
    host: null,                           // Will be set dynamically from env
    timeout: 30000,                       // 30s timeout for judge calls
    temperature: 0.1,                     // Low temp for consistent scoring
    num_predict: 200,                     // Max tokens to generate for judge output
    response_char_limit: 2000             // Max response chars sent to judge
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
    code: {
        dimensions: [
            { name: 'correctness', weight: 0.25, desc: 'Does code work & produce correct output?' },
            { name: 'clarity', weight: 0.15, desc: 'Is code readable & well-structured?' },
            { name: 'efficiency', weight: 0.15, desc: 'Reasonable performance for task?' },
            { name: 'maintainability', weight: 0.10, desc: 'Easy to modify & extend?' },
            { name: 'error_handling', weight: 0.10, desc: 'Robust error handling?' },
            { name: 'documentation', weight: 0.10, desc: 'Comments & explanations?' },
            { name: 'best_practices', weight: 0.08, desc: 'Follows language idioms?' },
            { name: 'testability', weight: 0.07, desc: 'Easy to test?' }
        ]
    },
    reasoning: {
        dimensions: [
            { name: 'accuracy', weight: 0.25, desc: 'Is conclusion correct?' },
            { name: 'logic_soundness', weight: 0.20, desc: 'Is reasoning valid?' },
            { name: 'depth', weight: 0.15, desc: 'Sufficient analysis depth?' },
            { name: 'clarity', weight: 0.12, desc: 'Clear explanation?' },
            { name: 'completeness', weight: 0.10, desc: 'Addresses all aspects?' },
            { name: 'coherence', weight: 0.08, desc: 'Internally consistent?' },
            { name: 'method_quality', weight: 0.10, desc: 'Appropriate approach?' }
        ]
    },
    factual: {
        dimensions: [
            { name: 'accuracy', weight: 0.35, desc: 'Factually correct?' },
            { name: 'completeness', weight: 0.20, desc: 'Answers question fully?' },
            { name: 'precision', weight: 0.15, desc: 'Specific & detailed?' },
            { name: 'clarity', weight: 0.10, desc: 'Clearly presented?' },
            { name: 'source_awareness', weight: 0.10, desc: 'Acknowledges sources?' },
            { name: 'context_appropriateness', weight: 0.10, desc: 'Right level of detail?' }
        ]
    },
    math: {
        dimensions: [
            { name: 'answer_correctness', weight: 0.35, desc: 'Final answer correct?' },
            { name: 'method', weight: 0.25, desc: 'Solution approach valid?' },
            { name: 'rigor', weight: 0.15, desc: 'Mathematically rigorous?' },
            { name: 'presentation', weight: 0.10, desc: 'Clearly shown?' },
            { name: 'notation', weight: 0.08, desc: 'Proper notation used?' },
            { name: 'edge_cases', weight: 0.07, desc: 'Handles special cases?' }
        ]
    },
    creative: {
        dimensions: [
            { name: 'creativity', weight: 0.25, desc: 'Original & imaginative?' },
            { name: 'coherence', weight: 0.20, desc: 'Well-structured & logical?' },
            { name: 'relevance', weight: 0.15, desc: 'Addresses task?' },
            { name: 'originality', weight: 0.15, desc: 'Unique approach?' },
            { name: 'emotional_impact', weight: 0.10, desc: 'Engaging?' },
            { name: 'style', weight: 0.08, desc: 'Appropriate voice?' },
            { name: 'audience_fit', weight: 0.07, desc: 'Right for audience?' }
        ]
    },
    // Enhanced judging system: 6 new categories for better model differentiation
    'instruction-following': {
        dimensions: [
            { name: 'instruction_adherence', weight: 0.30, desc: 'Follows instructions precisely?' },
            { name: 'constraint_compliance', weight: 0.25, desc: 'Respects all constraints?' },
            { name: 'format_accuracy', weight: 0.15, desc: 'Output format correct?' },
            { name: 'completeness', weight: 0.12, desc: 'All requirements met?' },
            { name: 'implicit_understanding', weight: 0.10, desc: 'Grasps implicit intent?' },
            { name: 'edge_case_handling', weight: 0.08, desc: 'Handles edge cases well?' }
        ]
    },
    summarization: {
        dimensions: [
            { name: 'accuracy', weight: 0.25, desc: 'Preserves key information?' },
            { name: 'conciseness', weight: 0.20, desc: 'Appropriately brief?' },
            { name: 'completeness', weight: 0.18, desc: 'Captures main points?' },
            { name: 'coherence', weight: 0.15, desc: 'Logically structured?' },
            { name: 'abstraction', weight: 0.12, desc: 'Right level of detail?' },
            { name: 'readability', weight: 0.10, desc: 'Easy to understand?' }
        ]
    },
    translation: {
        dimensions: [
            { name: 'accuracy', weight: 0.30, desc: 'Meaning preserved correctly?' },
            { name: 'fluency', weight: 0.25, desc: 'Natural in target language?' },
            { name: 'grammar', weight: 0.15, desc: 'Grammatically correct?' },
            { name: 'idiom_usage', weight: 0.12, desc: 'Idiomatic expressions appropriate?' },
            { name: 'cultural_sensitivity', weight: 0.10, desc: 'Culturally appropriate?' },
            { name: 'tone_preservation', weight: 0.08, desc: 'Original tone maintained?' }
        ]
    },
    'multi-turn-reasoning': {
        dimensions: [
            { name: 'context_retention', weight: 0.25, desc: 'Remembers previous context?' },
            { name: 'logical_progression', weight: 0.22, desc: 'Builds on prior steps?' },
            { name: 'accuracy', weight: 0.20, desc: 'Final conclusion correct?' },
            { name: 'coherence', weight: 0.15, desc: 'Consistent throughout?' },
            { name: 'depth', weight: 0.10, desc: 'Sufficient analysis depth?' },
            { name: 'synthesis', weight: 0.08, desc: 'Integrates information well?' }
        ]
    },
    'context-retention': {
        dimensions: [
            { name: 'recall_accuracy', weight: 0.30, desc: 'Recalls information correctly?' },
            { name: 'relevance_filtering', weight: 0.20, desc: 'Retrieves relevant context?' },
            { name: 'temporal_awareness', weight: 0.15, desc: 'Understands information order?' },
            { name: 'integration', weight: 0.15, desc: 'Integrates old & new context?' },
            { name: 'consistency', weight: 0.12, desc: 'Consistent with prior statements?' },
            { name: 'scope_management', weight: 0.08, desc: 'Appropriate context window?' }
        ]
    },
    'edge-cases': {
        dimensions: [
            { name: 'error_handling', weight: 0.28, desc: 'Handles errors gracefully?' },
            { name: 'boundary_awareness', weight: 0.22, desc: 'Recognizes edge conditions?' },
            { name: 'robustness', weight: 0.18, desc: 'Stable under unusual inputs?' },
            { name: 'graceful_degradation', weight: 0.15, desc: 'Fails gracefully?' },
            { name: 'validation', weight: 0.10, desc: 'Validates inputs properly?' },
            { name: 'recovery', weight: 0.07, desc: 'Recovers from errors?' }
        ]
    }
};

/**
 * Legacy scoring configurations (3-5 dimensions)
 * Maintained for backward compatibility with existing prompts
 * Each type has specific evaluation criteria and prompts
 */
const SCORING_CONFIGS = {
    code: {
        weight: { correctness: 0.5, clarity: 0.3, efficiency: 0.2 },
        prompt: `You are a code quality evaluator. Analyze the given code response and score it.

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
 * Priority: prompt.scoring_dimensions > ENHANCED_SCORING_CONFIGS > legacy SCORING_CONFIGS
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
    const scoringType = prompt.scoring_type || 'reasoning';
    const enhancedConfig = ENHANCED_SCORING_CONFIGS[scoringType];

    if (enhancedConfig && enhancedConfig.dimensions) {
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

    // Priority 3: Fall back to legacy scoring configs (backward compatibility)
    const legacyConfig = SCORING_CONFIGS[scoringType] || SCORING_CONFIGS.reasoning;

    logger.info('Using legacy scoring config (backward compatibility)', {
        prompt: prompt.name || 'unknown',
        scoringType
    });

    return { dimensions: null, weights: legacyConfig.weight, useLegacy: true, legacyConfig };
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
    
    // Direct answer patterns for common factual questions
    const quickPatterns = {
        'capital of france': { answer: 'paris', score: resp.includes('paris') ? 10 : 0 },
        '15 + 27': { answer: '42', score: resp.includes('42') ? 10 : 0 },
        '15+27': { answer: '42', score: resp.includes('42') ? 10 : 0 },
        'world war ii end': { answer: '1945', score: resp.includes('1945') ? 10 : 0 },
        'wwii end': { answer: '1945', score: resp.includes('1945') ? 10 : 0 },
        '2, 4, 8, 16': { answer: '32', score: resp.includes('32') ? 10 : 0 },
        '2x + 5 = 17': { answer: '6', score: resp.includes('6') || resp.includes('x = 6') ? 10 : 0 }
    };
    
    const promptLower = prompt.prompt ? prompt.prompt.toLowerCase() : prompt.toLowerCase();
    
    for (const [pattern, check] of Object.entries(quickPatterns)) {
        if (promptLower.includes(pattern)) {
            logger.info('Quick scoring match', { pattern, score: check.score, expected: check.answer });
            return {
                quick: true,
                score: check.score,
                expected: check.answer,
                matched: check.score === 10,
                pattern
            };
        }
    }
    
    return null; // Needs LLM evaluation
}

/**
 * Call the judge model to evaluate a response
 * @param {string} evalPrompt - The evaluation prompt
 * @param {Object} config - Optional configuration override
 * @returns {Promise<Object>} Parsed scores
 */
async function callJudge(evalPrompt, config = {}) {
    const judgeConfig = { ...JUDGE_CONFIG, ...config };
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
        logger.error('Judge call failed', { error: err.message });
        return {
            success: false,
            error: err.message,
            scores: null
        };
    }
}

/**
 * Score a model response for quality
 * @param {Object} params - Scoring parameters
 * @param {string} params.response - The model's response to evaluate
 * @param {Object} params.prompt - The prompt object with expected answer and criteria
 * @param {boolean} params.skipLLM - Skip LLM judge, use quick scoring only
 * @param {Object} params.judgeConfig - Optional configuration for the judge model
 * @returns {Promise<Object>} Quality scores
 */
async function scoreResponse({ response, prompt, skipLLM = false, judgeConfig = {} }) {
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
    
    // Use LLM-as-judge for complex evaluation
    const scoringType = prompt.scoring_type || 'reasoning';
    const dimensionsInfo = getScoringDimensions(prompt);
    const responseCharLimitRaw = (judgeConfig && judgeConfig.response_char_limit !== undefined)
        ? judgeConfig.response_char_limit
        : JUDGE_CONFIG.response_char_limit;
    const responseCharLimit = Math.max(200, Math.min(20000, Math.floor(Number(responseCharLimitRaw) || 2000)));
    const responseForJudge = response.substring(0, responseCharLimit);
    const inputTruncated = response.length > responseCharLimit;

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
            .replace('{{response}}', responseForJudge);
    } else {
        // Enhanced scoring: use dynamic dimensions
        evalPrompt = buildDynamicJudgePrompt(
            dimensionsInfo.dimensions,
            prompt.prompt || prompt,
            prompt.expected_answer || 'See criteria',
            responseForJudge
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
    
    const scores = judgeResult.scores;
    
    // Calculate weighted overall score if not provided
    let overallScore = scores.overall;
    if (overallScore === undefined) {
        overallScore = 0;
        for (const [key, weight] of Object.entries(config.weight)) {
            if (scores[key] !== undefined) {
                overallScore += scores[key] * weight;
            }
        }
        overallScore = Math.round(overallScore * 10) / 10;
    }
    
    logger.info('LLM judge scoring completed', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        score: overallScore,
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        scoring_type: scoringType,
        time_ms: Date.now() - startTime
    });

    // Build truncation info
    const truncation = {
        input_truncated: inputTruncated,
        input_original_chars: response.length,
        input_sent_chars: responseForJudge.length,
        judge_truncated: judgeResult.judge_truncated || false,
        judge_tokens: judgeResult.judge_tokens || 0
    };

    // Log warning if any truncation occurred
    if (inputTruncated || judgeResult.judge_truncated) {
        logger.warn('Truncation detected during scoring', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            input_truncated: inputTruncated,
            input_chars: `${responseForJudge.length}/${response.length}`,
            judge_truncated: judgeResult.judge_truncated,
            judge_tokens: judgeResult.judge_tokens
        });
    }

    return {
        quality_score: overallScore,
        scoring_method: 'llm_judge',
        scoring_type: scoringType,
        breakdown: scores,
        explanation: scores.explanation || '',
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        scoring_time_ms: Date.now() - startTime,
        judge_prompt: evalPrompt,
        judge_raw_response: judgeResult.raw || null,
        truncation
    };
}

/**
 * Category-specific composite profiles
 * Each category has custom weights for quality, latency, and speed
 * Based on Enhanced Judging System Plan Phase 1 Week 5
 */
const CATEGORY_COMPOSITE_PROFILES = {
    // Original 6 categories
    coding: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 45000, // 45s (users tolerate slower for correct code)
        description: "Correctness + efficiency critical"
    },
    reasoning: {
        weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
        latencyCap: 120000, // 120s (deep thinking takes time)
        description: "Reasoning depth matters most"
    },
    factual: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 30000, // 30s (quick lookups expected)
        description: "Accuracy critical, speed matters"
    },
    math: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 60000, // 60s (complex calculations take time)
        description: "Correctness paramount"
    },
    creative: {
        weights: { quality: 0.70, latency: 0.15, speed: 0.15 },
        latencyCap: 90000, // 90s (creative generation takes time)
        description: "Quality critical, tolerates slower generation"
    },
    general: {
        weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
        latencyCap: 30000, // 30s (general purpose)
        description: "Balanced general-purpose profile"
    },

    // Enhanced judging system: 6 new categories
    'instruction-following': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 30000, // 30s (following instructions precisely)
        description: "Instruction adherence is critical"
    },
    summarization: {
        weights: { quality: 0.65, latency: 0.20, speed: 0.15 },
        latencyCap: 45000, // 45s (distillation takes thought)
        description: "Accuracy + conciseness matter"
    },
    translation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 40000, // 40s (accuracy critical)
        description: "Accuracy and fluency critical"
    },
    'multi-turn-reasoning': {
        weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
        latencyCap: 150000, // 150s (context-heavy reasoning)
        description: "Context retention + reasoning depth"
    },
    'context-retention': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 60000, // 60s (memory integration)
        description: "Recall accuracy critical"
    },
    'edge-cases': {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 45000, // 45s (robustness testing)
        description: "Error handling + robustness"
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
    
    // Normalize tokens/sec (higher is better, cap at 100 t/s)
    // Score: 0 at 0 t/s, 100 at 100 t/s
    const speedScore = Math.min(100, (parseFloat(tokens_per_sec) || 0));
    
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
 * Batch score multiple responses
 * @param {Array} results - Array of benchmark results with responses
 * @param {Object} options - Scoring options { profile: 'interactive'|'reasoning' }
 * @returns {Promise<Array>} Results with quality scores added
 */
async function batchScore(results, options = {}) {
    const scoredResults = [];
    const profile = options.profile || 'interactive';
    
    for (const result of results) {
        if (!result.response || !result.success) {
            scoredResults.push({
                ...result,
                quality_score: null,
                scoring_method: 'skipped',
                reason: result.success ? 'no_response' : 'test_failed'
            });
            continue;
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
            prompt: promptInfo
        });
        
        const composite = calculateCompositeScore({
            latency: result.latency,
            tokens_per_sec: result.tokens_per_sec,
            quality_score: scores.quality_score
        }, profile);
        
        scoredResults.push({
            ...result,
            ...scores,
            ...composite
        });
    }
    
    return scoredResults;
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
    JUDGE_CONFIG
};
