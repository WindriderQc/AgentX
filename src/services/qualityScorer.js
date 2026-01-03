/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { HOSTS } = require('./modelRouter');

// Judge model configuration - use a capable model for evaluation
const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q4_0',  // Fast but capable judge
    fallback_model: 'llama3.2:1b',       // Fallback if primary unavailable
    host: HOSTS.primary,                  // Use primary host for judging
    timeout: 30000,                       // 30s timeout for judge calls
    temperature: 0.1                      // Low temp for consistent scoring
};

/**
 * Scoring type configurations
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
 * Quick scoring for simple factual answers
 * Uses pattern matching before calling LLM judge
 */
function quickScore(response, prompt) {
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
            return {
                quick: true,
                score: check.score,
                expected: check.answer,
                matched: check.score === 10
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
        const response = await fetch(`${judgeConfig.host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: judgeConfig.model,
                prompt: evalPrompt,
                stream: false,
                options: {
                    temperature: judgeConfig.temperature,
                    num_predict: 200
                }
            }),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`Judge HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const text = data.response || '';
        
        // Extract JSON from response
        const jsonMatch = text.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) {
            throw new Error('No JSON in judge response');
        }
        
        const scores = JSON.parse(jsonMatch[0]);
        return {
            success: true,
            scores,
            raw: text
        };
        
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
    
    // Try quick scoring first
    const quickResult = quickScore(response, prompt);
    if (quickResult && quickResult.quick) {
        return {
            quality_score: quickResult.score,
            scoring_method: 'quick',
            matched_expected: quickResult.matched,
            expected_answer: quickResult.expected,
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
    let config = SCORING_CONFIGS[scoringType] || SCORING_CONFIGS.reasoning;
    
    // Allow overriding prompt from judgeConfig
    if (judgeConfig.prompts && judgeConfig.prompts[scoringType]) {
        config = { ...config, prompt: judgeConfig.prompts[scoringType] };
    }
    
    const evalPrompt = config.prompt
        .replace('{{task}}', prompt.prompt || prompt)
        .replace('{{expected}}', prompt.expected_answer || 'See criteria')
        .replace('{{response}}', response.substring(0, 2000)); // Limit response length
    
    const judgeResult = await callJudge(evalPrompt, judgeConfig);
    
    if (!judgeResult.success) {
        return {
            quality_score: null,
            scoring_method: 'llm_failed',
            error: judgeResult.error,
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
    
    return {
        quality_score: overallScore,
        scoring_method: 'llm_judge',
        scoring_type: scoringType,
        breakdown: scores,
        explanation: scores.explanation || '',
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        scoring_time_ms: Date.now() - startTime,
        judge_prompt: evalPrompt
    };
}

/**
 * Calculate composite score combining speed and quality
 * @param {Object} metrics - Performance and quality metrics
 * @returns {Object} Composite scores
 */
function calculateCompositeScore(metrics) {
    const { latency, tokens_per_sec, quality_score } = metrics;
    
    // Normalize latency (lower is better, cap at 30s)
    // Score: 10 at 0ms, 0 at 30000ms
    const latencyScore = Math.max(0, 10 - (latency / 3000));
    
    // Normalize tokens/sec (higher is better, cap at 100 t/s)
    // Score: 0 at 0 t/s, 10 at 100 t/s
    const speedScore = Math.min(10, (parseFloat(tokens_per_sec) || 0) / 10);
    
    // Quality score is already 0-10
    const qualityScore = quality_score || 0;
    
    // Composite with configurable weights
    const weights = {
        quality: 0.5,    // Quality is most important
        latency: 0.3,    // Latency matters
        speed: 0.2       // Tokens/sec is nice-to-have
    };
    
    const composite = (
        qualityScore * weights.quality +
        latencyScore * weights.latency +
        speedScore * weights.speed
    );
    
    return {
        composite_score: Math.round(composite * 10) / 10,
        normalized: {
            quality: Math.round(qualityScore * 10) / 10,
            latency: Math.round(latencyScore * 10) / 10,
            speed: Math.round(speedScore * 10) / 10
        },
        weights
    };
}

/**
 * Batch score multiple responses
 * @param {Array} results - Array of benchmark results with responses
 * @returns {Promise<Array>} Results with quality scores added
 */
async function batchScore(results) {
    const scoredResults = [];
    
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
        });
        
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
    SCORING_CONFIGS,
    JUDGE_CONFIG
};
