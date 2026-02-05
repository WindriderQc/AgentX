/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const fetch = (...args) => import('node-fetch').then(({ default: fn }) => fn(...args));
const logger = require('../../config/logger');
const { getFetchOptions } = require('../helpers/httpAgent');
const hardwareProfileService = require('./hardwareProfileService');
const deterministicScorer = require('./deterministicScorer');
const decomposedJudge = require('./decomposedJudge');
const referenceScorer = require('./referenceScorer');
const judgeConfidence = require('./judgeConfidence');

// Judge model configuration - use a capable model for evaluation
const JUDGE_CONFIG = {
    model: 'qwen2.5:7b-instruct-q5_K_M',  // Fast but capable judge
    fallback_model: 'llama3.2:1b',       // Fallback if primary unavailable
    host: null,                           // Will be set dynamically from env
    timeout: 30000,                       // 30s timeout for judge calls
    temperature: 0.3,                     // Low but not too low - allows some variation for nuanced scoring
    num_predict: 500,                     // Increased for multi-dimension responses with explanations
    max_retries: 2                        // Retry on transient failures
};

// Track judge failures (parse/timeout/format/etc.) for observability
let judgeFailureCount = 0;

// Initialize host from env
if (process.env.OLLAMA_HOST) {
    JUDGE_CONFIG.host = process.env.OLLAMA_HOST;
}

/**
 * Validate weight configuration at module load
 * Ensures all composite profiles have weights that sum to 1.0
 */
function validateWeights() {
    const errors = [];
    const warnings = [];
    
    // Check ENHANCED_SCORING_CONFIGS core_dimensions (judge evaluates these)
    for (const [category, config] of Object.entries(ENHANCED_SCORING_CONFIGS)) {
        if (config.core_dimensions) {
            const sum = config.core_dimensions.reduce((acc, dim) => acc + dim.weight, 0);
            const diff = Math.abs(sum - 1.0);
            
            if (diff > 0.001) { // Allow tiny floating point errors
                errors.push(`${category}: core_dimension weights sum to ${sum.toFixed(3)}, expected 1.0`);
            }
        }
    }
    
    // Note: derived_dimensions may not sum to 1.0 since they're calculated post-judge
    // Check CATEGORY_COMPOSITE_PROFILES (defined later in file)
    // We'll check this in a separate function after CATEGORY_COMPOSITE_PROFILES is defined
    
    if (errors.length > 0) {
        logger.error('Weight validation failed', { errors });
        throw new Error(`Invalid weight configuration: ${errors.join('; ')}`);
    }
    
    if (warnings.length > 0) {
        logger.warn('Weight configuration warnings', { warnings });
    }
}

/**
 * Enhanced scoring configurations with 8-12 dimensions per category
 * Used when prompt.scoring_dimensions is not defined
 * Follows the spec from docs/operations/ENHANCED_JUDGING_SYSTEM_PLAN.md
 */
// TEMPORARY: New hierarchical dimension config for permanent judge reliability
// This replaces lines 68-260 of qualityScorer.js

const ENHANCED_SCORING_CONFIGS = {
    code: {
        description: 'Code generation and correctness',
        core_dimensions: [
            { name: 'correctness', weight: 0.35, desc: 'Does code work & produce correct output?' },
            { name: 'clarity', weight: 0.25, desc: 'Is code readable & well-structured?' },
            { name: 'efficiency', weight: 0.20, desc: 'Reasonable performance?' },
            { name: 'robustness', weight: 0.20, desc: 'Handles errors gracefully?' }
        ]
    },
    reasoning: {
        description: 'Logical reasoning and analysis',
        core_dimensions: [
            { name: 'accuracy', weight: 0.30, desc: 'Is conclusion correct?' },
            { name: 'logic_soundness', weight: 0.30, desc: 'Is reasoning valid?' },
            { name: 'clarity', weight: 0.20, desc: 'Clear explanation?' },
            { name: 'completeness', weight: 0.20, desc: 'Addresses all aspects?' }
        ]
    },
    factual: {
        description: 'Factual accuracy and completeness',
        core_dimensions: [
            { name: 'accuracy', weight: 0.40, desc: 'Factually correct?' },
            { name: 'completeness', weight: 0.30, desc: 'Answers question fully?' },
            { name: 'clarity', weight: 0.20, desc: 'Clearly presented?' },
            { name: 'objectivity', weight: 0.10, desc: 'Objective and balanced?' }
        ]
    },
    math: {
        description: 'Mathematical correctness and rigor',
        core_dimensions: [
            { name: 'answer_correctness', weight: 0.40, desc: 'Final answer correct?' },
            { name: 'method', weight: 0.35, desc: 'Solution approach valid?' },
            { name: 'rigor', weight: 0.15, desc: 'Mathematically rigorous?' },
            { name: 'clarity', weight: 0.10, desc: 'Steps clearly shown?' }
        ]
    },
    creative: {
        description: 'Creative content generation',
        core_dimensions: [
            { name: 'originality', weight: 0.35, desc: 'Original & imaginative?' },
            { name: 'coherence', weight: 0.30, desc: 'Well-structured & logical?' },
            { name: 'engagement', weight: 0.20, desc: 'Captures attention?' },
            { name: 'relevance', weight: 0.15, desc: 'Addresses task?' }
        ]
    },
    general: {
        description: 'General-purpose multi-task evaluation',
        core_dimensions: [
            { name: 'helpfulness', weight: 0.35, desc: 'Achieves user goal?' },
            { name: 'relevance', weight: 0.25, desc: 'On-topic and focused?' },
            { name: 'clarity', weight: 0.25, desc: 'Easy to understand?' },
            { name: 'accuracy', weight: 0.15, desc: 'Factually correct?' }
        ]
    },
    'instruction-following': {
        description: 'Constraint compliance and instruction adherence',
        core_dimensions: [
            { name: 'instruction_adherence', weight: 0.35, desc: 'Follows instructions precisely?' },
            { name: 'constraint_compliance', weight: 0.35, desc: 'Respects all constraints?' },
            { name: 'format_accuracy', weight: 0.20, desc: 'Output format correct?' },
            { name: 'completeness', weight: 0.10, desc: 'All requirements met?' }
        ],
        // Special instructions for JSON/structured output comparison
        judge_hints: `IMPORTANT FOR STRUCTURED OUTPUT:
- If expected output is JSON, parse and compare semantically (order of object keys doesn't matter, but array order does)
- For sorting tasks: verify the sorting criteria (e.g., "by length" means compare string lengths)
- Check EXACT values, not approximate matches
- Empty arrays [] or objects {} are valid outputs if that's what's expected`
    },
    summarization: {
        description: 'Content distillation and synthesis',
        core_dimensions: [
            { name: 'accuracy', weight: 0.35, desc: 'Preserves key information?' },
            { name: 'conciseness', weight: 0.30, desc: 'Appropriately brief?' },
            { name: 'completeness', weight: 0.20, desc: 'Captures main points?' },
            { name: 'coherence', weight: 0.15, desc: 'Logically structured?' }
        ]
    },
    translation: {
        description: 'Cross-language translation quality',
        core_dimensions: [
            { name: 'accuracy', weight: 0.35, desc: 'Meaning preserved correctly?' },
            { name: 'fluency', weight: 0.30, desc: 'Natural in target language?' },
            { name: 'grammar', weight: 0.20, desc: 'Grammatically correct?' },
            { name: 'cultural_fit', weight: 0.15, desc: 'Culturally appropriate?' }
        ]
    },
    'multi-turn-reasoning': {
        description: 'Multi-step reasoning across turns',
        core_dimensions: [
            { name: 'context_retention', weight: 0.35, desc: 'Remembers previous context?' },
            { name: 'logical_progression', weight: 0.30, desc: 'Builds on prior steps?' },
            { name: 'accuracy', weight: 0.25, desc: 'Final conclusion correct?' },
            { name: 'coherence', weight: 0.10, desc: 'Consistent throughout?' }
        ]
    },
    'context-retention': {
        description: 'Memory and context management',
        core_dimensions: [
            { name: 'recall_accuracy', weight: 0.40, desc: 'Recalls information correctly?' },
            { name: 'relevance_filtering', weight: 0.30, desc: 'Retrieves relevant context?' },
            { name: 'consistency', weight: 0.20, desc: 'Consistent with prior statements?' },
            { name: 'no_hallucination', weight: 0.10, desc: 'Does not invent context?' }
        ]
    },
    'edge-cases': {
        description: 'Robustness under unusual inputs',
        core_dimensions: [
            { name: 'error_handling', weight: 0.35, desc: 'Handles errors gracefully?' },
            { name: 'robustness', weight: 0.30, desc: 'Stable under unusual inputs?' },
            { name: 'validation', weight: 0.20, desc: 'Validates inputs properly?' },
            { name: 'recovery', weight: 0.15, desc: 'Recovers from errors?' }
        ]
    },
    refactoring: {
        description: 'Code restructuring and improvement',
        core_dimensions: [
            { name: 'readability_improvement', weight: 0.35, desc: 'Is code clearer?' },
            { name: 'logic_preservation', weight: 0.35, desc: 'Behavior remains identical?' },
            { name: 'simplicity', weight: 0.20, desc: 'Reduced complexity?' },
            { name: 'correctness', weight: 0.10, desc: 'No new bugs introduced?' }
        ]
    },
    debugging: {
        description: 'Problem identification and resolution',
        core_dimensions: [
            { name: 'root_cause', weight: 0.40, desc: 'Found the actual bug?' },
            { name: 'fix_correctness', weight: 0.35, desc: 'Does the fix work?' },
            { name: 'minimal_intervention', weight: 0.15, desc: 'Avoided unnecessary changes?' },
            { name: 'explanation', weight: 0.10, desc: 'Clear reason for the bug?' }
        ]
    },
    explanation: {
        description: 'Technical explanation clarity',
        core_dimensions: [
            { name: 'clarity', weight: 0.35, desc: 'Easy to follow?' },
            { name: 'accuracy', weight: 0.35, desc: 'Technically correct?' },
            { name: 'structure', weight: 0.20, desc: 'Logical flow of information?' },
            { name: 'completeness', weight: 0.10, desc: 'No missing key details?' }
        ]
    },
    dialogue: {
        description: 'Conversational interaction quality',
        core_dimensions: [
            { name: 'relevance', weight: 0.30, desc: 'Addresses previous turn?' },
            { name: 'naturalness', weight: 0.25, desc: 'Sounds human-like?' },
            { name: 'helpfulness', weight: 0.25, desc: 'User goals achieved?' },
            { name: 'engagement', weight: 0.20, desc: 'Keeps conversation going?' }
        ]
    }
};

// Validate ENHANCED_SCORING_CONFIGS weight sums at module load
validateWeights();

// Legacy SCORING_CONFIGS removed - all scoring now uses ENHANCED_SCORING_CONFIGS
// The enhanced system provides 16 categories with 4 core dimensions each

/**
 * Strip markdown code fences from a response
 * Handles ```json, ```javascript, ``` etc.
 * @param {string} text - The text to clean
 * @returns {string} Text with code fences removed
 */
function stripMarkdownCodeFences(text) {
    if (!text || typeof text !== 'string') return text;

    // Match code blocks: ```lang\n...\n``` or ```\n...\n```
    const codeBlockRegex = /^```(?:\w+)?\s*\n?([\s\S]*?)\n?```$/;
    const trimmed = text.trim();
    const match = trimmed.match(codeBlockRegex);

    if (match) {
        return match[1].trim();
    }

    // Also handle inline code blocks that might wrap the entire response
    // e.g., ``` ... ``` without language specifier on same line
    const inlineMatch = trimmed.match(/^```(?:\w+)?\s*([\s\S]*?)```$/);
    if (inlineMatch) {
        return inlineMatch[1].trim();
    }

    return text;
}

/**
 * Build a dynamic judge prompt from scoring dimensions
 * @param {Array} dimensions - Array of dimension objects {name, weight, desc}
 * @param {string} task - The task/prompt to evaluate
 * @param {string} expected - Expected answer or criteria
 * @param {string} response - The response to evaluate
 * @param {Object} options - Optional settings { judgeHints: string }
 * @returns {string} Formatted judge prompt
 */
function buildDynamicJudgePrompt(dimensions, task, expected, response, options = {}) {
    const criteriaList = dimensions.map((dim, idx) => {
        return `${idx + 1}. ${dim.name.replace(/_/g, ' ')} (0-10): ${dim.desc}`;
    }).join('\n');

    const jsonFormat = dimensions.reduce((acc, dim) => {
        acc[dim.name] = 'X';
        return acc;
    }, {});
    jsonFormat.overall = 'X';
    jsonFormat.explanation = 'brief reason';

    // Include category-specific judge hints if provided
    const hintsSection = options.judgeHints
        ? `\n${options.judgeHints}\n`
        : '';

    return `You are a quality evaluator. Analyze the given response and score it across multiple dimensions.

IMPORTANT: If the RESPONSE TO EVALUATE section is empty or blank, assign 0 to all dimensions - the model failed to produce output.
${hintsSection}
CRITERIA TO EVALUATE:
${criteriaList}

TASK: ${task}
EXPECTED: ${expected}
RESPONSE TO EVALUATE:
${response}

CRITICAL INSTRUCTIONS:
1. Score each criterion on a 0-10 scale (integers or decimals)
2. The 'overall' score must ALSO be 0-10 (weighted average, NOT a sum)
3. You MUST respond with a JSON object (not an array, not text)
4. Every dimension must have a numeric score

Respond ONLY with a JSON object in this EXACT format (replace X with actual numbers):
${JSON.stringify(jsonFormat, null, 2)}

Do NOT respond with just keys, do NOT respond with an array, do NOT add explanatory text outside the JSON.`;
}

/**
 * Get scoring dimensions for a prompt
 * Priority: prompt.scoring_dimensions > ENHANCED_SCORING_CONFIGS (with 'general' fallback)
 * @param {Object} prompt - The benchmark prompt object
 * @returns {Object} { dimensions: Array, weights: Object, category: string, judgeHints: string|null }
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

        return { dimensions, weights, category: 'custom', judgeHints: null };
    }

    // Priority 2: Use enhanced scoring configs based on scoring_type
    const scoringType = prompt.scoring_type || 'general';
    let enhancedConfig = ENHANCED_SCORING_CONFIGS[scoringType];

    // Fallback to 'general' if category not found
    if (!enhancedConfig || !enhancedConfig.core_dimensions) {
        logger.warn('Unknown scoring_type, falling back to general', {
            prompt: prompt.name || 'unknown',
            requestedType: scoringType
        });
        enhancedConfig = ENHANCED_SCORING_CONFIGS.general;
    }

    // Use CORE dimensions only for judge evaluation (exactly 4 fields = reliable JSON)
    // See DIMENSION_ARCHITECTURE.md for rationale
    const dimensions = enhancedConfig.core_dimensions;
    const weights = dimensions.reduce((acc, dim) => {
        acc[dim.name] = dim.weight;
        return acc;
    }, {});

    logger.debug('Using enhanced core dimensions for judge evaluation', {
        prompt: prompt.name || 'unknown',
        scoringType,
        coreDimensionCount: dimensions.length,
        hasJudgeHints: !!enhancedConfig.judge_hints
    });

    return {
        dimensions,
        weights,
        category: scoringType,
        judgeHints: enhancedConfig.judge_hints || null
    };
}

/**
 * Compare two JSON values for equality
 * Arrays are compared with order sensitivity
 * Objects are compared with key-order insensitivity
 * @param {any} a - First value
 * @param {any} b - Second value
 * @returns {boolean} True if equal
 */
function jsonDeepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((val, idx) => jsonDeepEqual(val, b[idx]));
    }

    if (typeof a === 'object' && typeof b === 'object') {
        const keysA = Object.keys(a).sort();
        const keysB = Object.keys(b).sort();
        if (keysA.length !== keysB.length) return false;
        if (!keysA.every((k, i) => k === keysB[i])) return false;
        return keysA.every(k => jsonDeepEqual(a[k], b[k]));
    }

    return false;
}

/**
 * Try to parse JSON from a response string
 * Handles various formats: raw JSON, markdown code blocks, etc.
 * @param {string} text - Response text
 * @returns {Object} { success: boolean, value: any, error: string|null }
 */
function tryParseJson(text) {
    if (!text || typeof text !== 'string') {
        return { success: false, value: null, error: 'Empty or non-string input' };
    }

    // Strip markdown code fences first
    let cleaned = stripMarkdownCodeFences(text).trim();

    try {
        const value = JSON.parse(cleaned);
        return { success: true, value, error: null };
    } catch (e) {
        // Try to extract JSON from surrounding text
        const jsonMatch = cleaned.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
        if (jsonMatch) {
            try {
                const value = JSON.parse(jsonMatch[1]);
                return { success: true, value, error: null };
            } catch (e2) {
                return { success: false, value: null, error: e2.message };
            }
        }
        return { success: false, value: null, error: e.message };
    }
}

/**
 * Quick scoring for simple factual answers
 * Uses pattern matching and JSON comparison before calling LLM judge
 * Only triggers when prompt has expected_answer defined
 */
function quickScore(response, prompt) {
    // Only use quick scoring if we have an expected answer
    const expectedAnswer = prompt.expected_answer || prompt.expected;
    if (!expectedAnswer) {
        return null; // Fall back to LLM judge
    }

    // Try JSON comparison first (for instruction-following, math, etc.)
    const expectedJson = tryParseJson(expectedAnswer);
    const responseJson = tryParseJson(response);

    if (expectedJson.success && responseJson.success) {
        const isEqual = jsonDeepEqual(expectedJson.value, responseJson.value);
        logger.info('Quick JSON scoring', {
            matched: isEqual,
            expectedType: Array.isArray(expectedJson.value) ? 'array' : typeof expectedJson.value,
            responseType: Array.isArray(responseJson.value) ? 'array' : typeof responseJson.value
        });
        return {
            quick: true,
            score: isEqual ? 10 : 0,
            expected: expectedAnswer,
            matched: isEqual,
            pattern: 'json_exact_match',
            comparison: {
                expected: expectedJson.value,
                received: responseJson.value
            }
        };
    }

    const resp = response.toLowerCase().trim();

    // Direct answer patterns for common factual questions
    // Use word boundaries to avoid false positives (e.g., "32" in "320")
    const quickPatterns = {
        'capital of france': { answer: 'paris', score: /\bparis\b/.test(resp) ? 10 : 0 },
        '15 + 27': { answer: '42', score: /\b42\b/.test(resp) ? 10 : 0 },
        '15+27': { answer: '42', score: /\b42\b/.test(resp) ? 10 : 0 },
        'world war ii end': { answer: '1945', score: /\b1945\b/.test(resp) ? 10 : 0 },
        'wwii end': { answer: '1945', score: /\b1945\b/.test(resp) ? 10 : 0 },
        '2, 4, 8, 16': { answer: '32', score: /\b32\b/.test(resp) ? 10 : 0 },
        '2x + 5 = 17': { answer: '6', score: /\bx\s*=\s*6\b|\b6\b/.test(resp) ? 10 : 0 }
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
 * @param {number} retryCount - Current retry attempt (for internal use)
 * @returns {Promise<Object>} Parsed scores
 */
async function callJudge(evalPrompt, config = {}, retryCount = 0) {
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
            // Log the full response for debugging when JSON is not found
            logger.error('Judge response format - no JSON found', { 
                fullResponse: text,
                responseLength: text.length,
                containsBraces: text.includes('{') && text.includes('}'),
                containsCodeBlock: text.includes('```'),
                judge_model: judgeConfig.model || JUDGE_CONFIG.model
            });
            throw new Error('No JSON found in judge response');
        }
        
        // Log raw JSON string for debugging format issues
        logger.debug('Judge JSON extraction', { 
            length: jsonStr.length, 
            preview: jsonStr.substring(0, 200) 
        });
        
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

            let scores = JSON.parse(sanitized);
            
            // Validate that scores object contains expected fields
            if (typeof scores !== 'object' || scores === null) {
                throw new Error('Judge returned non-object response');
            }
            
            // Check if judge returned an array instead of object (common hallucination)
            if (Array.isArray(scores)) {
                throw new Error(`Judge returned array instead of JSON object. Array content: ${JSON.stringify(scores).substring(0, 200)}`);
            }
            
            // CRITICAL FIX: Coerce string numbers to actual numbers
            // Judge model sometimes returns "8.5" instead of 8.5 in JSON
            const coercedScores = {};
            for (const [key, value] of Object.entries(scores)) {
                if (typeof value === 'number') {
                    coercedScores[key] = value;
                } else if (typeof value === 'string') {
                    const trimmed = value.trim();
                    // Check if string looks like a number (handles "8", "8.0", "8.5", etc.)
                    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                        coercedScores[key] = parseFloat(trimmed);
                    } else {
                        // Keep non-numeric strings (like explanations)
                        coercedScores[key] = value;
                    }
                } else {
                    coercedScores[key] = value;
                }
            }
            scores = coercedScores;
            
            // Check for at least some numeric scores (but don't require specific fields - dimensions vary)
            const numericFields = Object.keys(scores).filter(key => 
                typeof scores[key] === 'number' && key !== 'overall'
            );
            
            if (numericFields.length === 0 && typeof scores.overall !== 'number') {
                // More detailed error for debugging
                const receivedKeys = Object.keys(scores);
                const receivedTypes = receivedKeys.map(k => `${k}:${typeof scores[k]}`).join(', ');
                throw new Error(`Judge response missing numeric scores after coercion. Received ${receivedKeys.length} keys. Types: [${receivedTypes}]`);
            }
            
            return {
                success: true,
                scores,
                raw: text,
                judge_truncated: judgeTruncated,
                judge_tokens: judgeTokens
            };
        } catch (parseErr) {
            // Log the actual problematic JSON for debugging
            logger.error('JSON parse error details', { 
                error: parseErr.message,
                jsonPreview: jsonStr.substring(0, 500),
                fullText: text.substring(0, 1000)
            });
            throw new Error(`JSON parse failed: ${parseErr.message}`);
        }
        
    } catch (err) {
        clearTimeout(timeoutId);
        
        // Retry logic for transient failures
        const maxRetries = judgeConfig.max_retries || 2;
        const isRetryable = err.message.includes('timeout') || 
                           err.message.includes('ECONNRESET') ||
                           err.message.includes('ETIMEDOUT') ||
                           err.message.includes('503') ||
                           err.message.includes('502');
        
        if (isRetryable && retryCount < maxRetries) {
            const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 5000); // Max 5s
            logger.warn(`Judge call failed, retrying in ${backoffMs}ms`, { 
                error: err.message, 
                attempt: retryCount + 1, 
                maxRetries 
            });
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return callJudge(evalPrompt, config, retryCount + 1);
        }
        
        logger.error('Judge call failed', { error: err.message, retries: retryCount });
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
 * @param {Object} params._batchHardwareSnapshot - Optional cached hardware detection from batch
 * @returns {Promise<Object>} Quality scores
 */
async function scoreResponse({ response, prompt, skipLLM = false, judgeConfig = {}, _batchHardwareSnapshot = null }) {
    const startTime = Date.now();
    const mergedJudgeConfig = { ...JUDGE_CONFIG, ...judgeConfig };

    // Phase 1: Try deterministic scoring first (highest priority)
    if (prompt.deterministic_scoring) {
        const detResult = deterministicScorer.score(response, prompt);
        if (detResult) {
            logger.info('Deterministic scoring used', {
                prompt: prompt.name || prompt.prompt_name || 'unknown',
                type: detResult.deterministic_type,
                score: detResult.score,
                matched: detResult.matched
            });
            return {
                quality_score: detResult.score,
                scoring_method: 'deterministic',
                deterministic_type: detResult.deterministic_type,
                matched_expected: detResult.matched,
                explanation: detResult.details,
                breakdown: { overall: detResult.score },
                scoring_time_ms: Date.now() - startTime,
                judge_confidence: 1.0, // Deterministic = 100% confident
                needs_review: false
            };
        }
    }

    // Phase 2: Try quick scoring (legacy pattern matching)
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
            },
            judge_confidence: 1.0, // Pattern match = 100% confident
            needs_review: false
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

    // Validate that response is not empty before scoring
    if (!response || response.trim().length === 0) {
        logger.warn('Attempting to score empty response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            response_length: response ? response.length : 0,
            task: prompt.prompt ? prompt.prompt.substring(0, 100) : 'unknown'
        });
        return {
            quality_score: 0,
            scoring_method: 'empty_response',
            scoring_type: prompt.scoring_type || 'general',
            explanation: 'CRITICAL: Model produced NO response. Unable to evaluate empty output. Automatic score: 0/10',
            breakdown: {
                accuracy: 0,
                correctness: 0,
                completeness: 0,
                clarity: 0,
                overall: 0
            },
            scoring_time_ms: Date.now() - startTime,
            judge_prompt: null,
            judge_model: null,
            judge_raw_response: 'Model failed to generate any response text',
            judge_confidence: 1.0,
            needs_review: false
        };
    }

    // Phase 3: Try routed scoring (reference, decomposed, etc.)
    const routedResult = await routeScoring(response, prompt, mergedJudgeConfig);
    if (routedResult) {
        // Add confidence assessment
        const confidence = judgeConfidence.assess(routedResult, prompt);

        return {
            ...routedResult,
            scoring_time_ms: Date.now() - startTime,
            judge_confidence: confidence.judge_confidence,
            needs_review: confidence.needs_review,
            review_reason: confidence.review_reason
        };
    }

    // Phase 4: Fall back to standard LLM-as-judge for complex evaluation
    const scoringType = prompt.scoring_type || 'general';
    const dimensionsInfo = getScoringDimensions(prompt);

    // Strip markdown code fences from response before judging
    // This prevents judge confusion from ```json ... ``` wrappers
    const cleanedResponse = stripMarkdownCodeFences(response);
    if (cleanedResponse !== response) {
        logger.debug('Stripped markdown code fences from response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            originalLength: response.length,
            cleanedLength: cleanedResponse.length
        });
    }

    // Build dynamic judge prompt from dimensions (with category-specific hints if available)
    const evalPrompt = buildDynamicJudgePrompt(
        dimensionsInfo.dimensions,
        prompt.prompt || prompt,
        prompt.expected_answer || 'See criteria',
        cleanedResponse,
        { judgeHints: dimensionsInfo.judgeHints }
    );
    const config = { weight: dimensionsInfo.weights };

    const judgeResult = await callJudge(evalPrompt, mergedJudgeConfig);
    
    if (!judgeResult.success) {
        judgeFailureCount += 1;
        logger.warn('LLM judge failed', { 
            error: judgeResult.error, 
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
            judge_failure_count: judgeFailureCount,
            scoring_type: scoringType
        });
        return {
            quality_score: 0,
            scoring_method: 'llm_failed',
            error: judgeResult.error,
            explanation: `Judge model failed: ${judgeResult.error}`,
            judge_prompt: evalPrompt,
            judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
            scoring_time_ms: Date.now() - startTime,
            breakdown: {
                accuracy: 0,
                correctness: 0,
                completeness: 0,
                clarity: 0,
                overall: 0
            }
        };
    }
    
    const scores = judgeResult.scores;
    
    // Validate and normalize judge scores to 0-10 range
    const normalizedScores = {};
    for (const [key, value] of Object.entries(scores)) {
        if (typeof value === 'number' && key !== 'overall') {
            // Clamp to 0-10 range in case judge goes out of bounds
            normalizedScores[key] = Math.max(0, Math.min(10, value));
            if (value < 0 || value > 10) {
                logger.warn('Judge returned out-of-range score', {
                    dimension: key,
                    value,
                    clamped_to: normalizedScores[key],
                    prompt: prompt.name || prompt.prompt_name || 'unknown'
                });
            }
        } else {
            normalizedScores[key] = value;
        }
    }
    
    // Calculate weighted overall score if not provided
    let overallScore = normalizedScores.overall;
    if (overallScore === undefined) {
        overallScore = 0;
        let totalWeight = 0;
        for (const [key, weight] of Object.entries(config.weight)) {
            if (normalizedScores[key] !== undefined) {
                overallScore += normalizedScores[key] * weight;
                totalWeight += weight;
            }
        }
        
        // Normalize by total weight to ensure score stays in 0-10 range
        if (totalWeight > 0 && totalWeight !== 1.0) {
            logger.warn('Weights do not sum to 1.0, normalizing', {
                total_weight: totalWeight,
                scoring_type: scoringType,
                prompt: prompt.name || prompt.prompt_name || 'unknown'
            });
            overallScore = overallScore / totalWeight;
        }
        
        // Final clamp and round
        overallScore = Math.max(0, Math.min(10, overallScore));
        overallScore = Math.round(overallScore * 10) / 10;
    } else {
        // Judge provided overall score - validate it
        overallScore = Math.max(0, Math.min(10, overallScore));
        if (normalizedScores.overall < 0 || normalizedScores.overall > 10) {
            logger.warn('Judge returned out-of-range overall score', {
                value: normalizedScores.overall,
                clamped_to: overallScore,
                prompt: prompt.name || prompt.prompt_name || 'unknown'
            });
        }
        overallScore = Math.round(overallScore * 10) / 10;
    }
    
    logger.info('LLM judge scoring completed', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        score: overallScore,
        judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
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

    // Detect judge hardware (non-blocking, won't fail scoring if detection fails)
    // Use cached detection from batch if available (prevents redundant detection)
    let judgeHardwareSnapshot = null;
    if (_batchHardwareSnapshot) {
        judgeHardwareSnapshot = _batchHardwareSnapshot;
    } else {
        try {
            const judgeHost = mergedJudgeConfig.host || JUDGE_CONFIG.host;
            const judgeModel = mergedJudgeConfig.model || JUDGE_CONFIG.model;
            if (judgeHost && judgeModel) {
                // Add timeout to prevent blocking
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

    // Build base result
    const baseResult = {
        quality_score: overallScore,
        scoring_method: 'llm_judge',
        scoring_type: scoringType,
        breakdown: normalizedScores,
        explanation: normalizedScores.explanation || scores.explanation || 'No explanation provided',
        judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
        judge_host: mergedJudgeConfig.host || JUDGE_CONFIG.host,
        judge_hardware_snapshot: judgeHardwareSnapshot,
        scoring_time_ms: Date.now() - startTime,
        judge_prompt: evalPrompt,
        judge_raw_response: judgeResult.raw || null,
        truncation
    };

    // Add confidence assessment for LLM judge results
    const confidence = judgeConfidence.assess(baseResult, prompt);

    return {
        ...baseResult,
        judge_confidence: confidence.judge_confidence,
        needs_review: confidence.needs_review,
        review_reason: confidence.review_reason
    };
}

/**
 * Category-specific composite profiles
 * Each category has custom weights for quality, latency, and speed
 * Based on Enhanced Judging System Plan Phase 1 Week 5
 */
const CATEGORY_COMPOSITE_PROFILES = {
    // Code category (matches ENHANCED_SCORING_CONFIGS)
    code: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 45000, // 45s (users tolerate slower for correct code)
        description: "Correctness + efficiency critical"
    },
    // Alias for backward compatibility
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
    },

    // PR #88: Additional categories for deeper evaluation
    refactoring: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 60000, // 60s (code restructuring takes analysis)
        description: "Code quality improvement evaluation"
    },
    debugging: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 45000, // 45s (finding root cause)
        description: "Bug identification and fixing"
    },
    explanation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 50000, // 50s (technical explanations)
        description: "Clarity and accuracy of explanations"
    },
    dialogue: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 30000, // 30s (conversational responsiveness)
        description: "Conversational quality and engagement"
    }
};

/**
 * Validate composite profile weights
 * Ensures all profiles have weights that sum to 1.0
 */
function validateCompositeWeights() {
    const errors = [];
    
    // Check CATEGORY_COMPOSITE_PROFILES
    for (const [category, config] of Object.entries(CATEGORY_COMPOSITE_PROFILES)) {
        const { quality, latency, speed } = config.weights;
        const sum = quality + latency + speed;
        const diff = Math.abs(sum - 1.0);
        
        if (diff > 0.001) { // Allow tiny floating point errors
            errors.push(`${category}: composite weights sum to ${sum.toFixed(3)}, expected 1.0`);
        }
    }
    
    if (errors.length > 0) {
        logger.error('Composite weight validation failed', { errors });
        throw new Error(`Invalid composite weight configuration: ${errors.join('; ')}`);
    }
}

// Validate composite weights immediately after definition
validateCompositeWeights();

/**
 * Category-specific scoring strategies
 * Routes scoring through the most appropriate method per category
 */
const CATEGORY_STRATEGIES = {
    // Math: deterministic first (numeric), no LLM fallback needed if correct
    math: {
        primary: 'deterministic',
        deterministic_type: 'numeric',
        llm_fallback: false,
        confidence_threshold: 0.9
    },
    // Instruction-following: deterministic (json/regex), then decomposed
    'instruction-following': {
        primary: 'deterministic',
        deterministic_type: 'json',
        llm_fallback: true,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.8
    },
    // Code: hybrid (deterministic for syntax, decomposed for quality)
    code: {
        primary: 'hybrid',
        deterministic_weight: 0.4,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.7
    },
    coding: {
        primary: 'hybrid',
        deterministic_weight: 0.4,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.7
    },
    // Reasoning: decomposed first, reference fallback for high levels
    reasoning: {
        primary: 'decomposed',
        reference_fallback: true,
        confidence_threshold: 0.7
    },
    // Factual: deterministic (regex) for known facts, LLM for open questions
    factual: {
        primary: 'deterministic',
        deterministic_type: 'regex',
        llm_fallback: true,
        llm_strategy: 'standard',
        confidence_threshold: 0.8
    },
    // Creative: standard LLM only (can't be deterministic)
    creative: {
        primary: 'llm',
        llm_strategy: 'standard',
        confidence_threshold: 0.6,
        always_flag_review: true // Creative is subjective
    },
    // General: balanced approach
    general: {
        primary: 'auto', // Auto-detect based on prompt
        llm_fallback: true,
        llm_strategy: 'standard',
        confidence_threshold: 0.7
    },
    // Summarization: decomposed
    summarization: {
        primary: 'decomposed',
        reference_fallback: true,
        confidence_threshold: 0.75
    },
    // Translation: reference-based when available
    translation: {
        primary: 'reference',
        llm_fallback: true,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.75
    },
    // Multi-turn reasoning: decomposed
    'multi-turn-reasoning': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    // Context retention: decomposed
    'context-retention': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    // Edge cases: decomposed
    'edge-cases': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    // Refactoring: hybrid
    refactoring: {
        primary: 'hybrid',
        deterministic_weight: 0.3,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.7
    },
    // Debugging: decomposed
    debugging: {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    // Explanation: decomposed
    explanation: {
        primary: 'decomposed',
        confidence_threshold: 0.75
    },
    // Dialogue: standard LLM
    dialogue: {
        primary: 'llm',
        llm_strategy: 'standard',
        confidence_threshold: 0.7
    }
};

/**
 * Route scoring to the appropriate strategy based on category and prompt
 * @param {string} response - Model response
 * @param {Object} prompt - Prompt object
 * @param {Object} judgeConfig - Judge configuration
 * @returns {Promise<Object>} Scoring result with method used
 */
async function routeScoring(response, prompt, judgeConfig) {
    const category = prompt.scoring_type || prompt.category || 'general';
    const strategy = CATEGORY_STRATEGIES[category] || CATEGORY_STRATEGIES.general;
    const level = prompt.level || 5;

    logger.debug('Routing scoring', {
        prompt: prompt.name || 'unknown',
        category,
        strategy: strategy.primary,
        level
    });

    let result = null;

    // Phase 1: Try deterministic scoring if configured
    if (strategy.primary === 'deterministic' || strategy.primary === 'hybrid' || strategy.primary === 'auto') {
        // Check if prompt has deterministic config
        if (prompt.deterministic_scoring) {
            result = deterministicScorer.score(response, prompt);
            if (result && result.matched) {
                logger.info('Deterministic scoring succeeded', {
                    prompt: prompt.name || 'unknown',
                    type: result.deterministic_type,
                    score: result.score
                });
                return result;
            }
        }

        // For math, try numeric eval even without explicit config
        if (category === 'math' && prompt.expected_answer) {
            const numResult = deterministicScorer.numericEval(response, prompt.expected_answer);
            if (numResult.matched) {
                logger.info('Math deterministic scoring succeeded', {
                    prompt: prompt.name || 'unknown',
                    score: numResult.score
                });
                return {
                    ...numResult,
                    deterministic: true,
                    scoring_method: 'deterministic'
                };
            }
        }
    }

    // Phase 2: Try reference-based scoring for high-level prompts
    if ((strategy.primary === 'reference' || strategy.reference_fallback) && prompt.reference_answer) {
        result = await referenceScorer.score(response, prompt, judgeConfig);
        if (result) {
            logger.info('Reference scoring used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 3: Use decomposed judging for complex evaluations
    if (strategy.primary === 'decomposed' || strategy.llm_strategy === 'decomposed') {
        result = await decomposedJudge.score(response, prompt, judgeConfig);
        if (result) {
            logger.info('Decomposed judging used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 4: Fall back to standard LLM judge
    return null; // Signal to use standard LLM judge
}

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
    // Score: 100 at 0ms, 0 at cap, explicit handling for exceeds cap
    let latencyScore;
    if (latency <= 0) {
        latencyScore = 100; // Instant response
    } else if (latency >= config.latencyCap) {
        latencyScore = 0; // Exceeds acceptable latency
        logger.debug('Latency exceeds cap', { latency, cap: config.latencyCap });
    } else {
        latencyScore = 100 - ((latency / config.latencyCap) * 100);
    }
    latencyScore = Math.max(0, latencyScore); // Safety clamp
    
    // Normalize tokens/sec (higher is better)
    // Cap at 100 t/s as reference point (very fast = 100 score)
    // Linear scaling: 0 t/s = 0, 100 t/s = 100
    let speedScore;
    if (tokens_per_sec <= 0) {
        speedScore = 0;
    } else if (tokens_per_sec >= 100) {
        speedScore = 100; // Capped at reference max
    } else {
        speedScore = tokens_per_sec; // 1:1 scaling (25 t/s = 25 score)
    }
    
    // Quality score is 0-10, scale to 0-100
    const qualityScore = Math.max(0, Math.min(100, (quality_score || 0) * 10));
    
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
 * NOTE: This is for POST-TEST judging only. Model testing remains sequential 
 * to ensure fair latency comparison. Judge concurrency is safe because:
 * - Judge latency doesn't affect model scores
 * - Judge time is informative only, not part of benchmark
 * - Multiple judge calls don't interfere with each other
 * 
 * @param {Array} results - Array of benchmark results with responses
 * @param {Object} options - Scoring options { profile: 'interactive'|'reasoning', concurrency: 5 }
 * @returns {Promise<Array>} Results with quality scores added
 */
async function batchScore(results, options = {}) {
    const profile = options.profile || 'interactive';
    const concurrency = options.concurrency || 5; // Default 5 concurrent judge calls
    
    // Detect judge hardware ONCE for entire batch (not per-result)
    let judgeHardwareSnapshot = null;
    try {
        const judgeHost = JUDGE_CONFIG.host;
        const judgeModel = JUDGE_CONFIG.model;
        if (judgeHost && judgeModel) {
            const hwPromise = hardwareProfileService.detectHardware(judgeHost, judgeModel);
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Hardware detection timeout')), 5000)
            );
            judgeHardwareSnapshot = await Promise.race([hwPromise, timeoutPromise]);
            logger.debug('Batch hardware detection complete', { 
                gpu: judgeHardwareSnapshot?.gpu_layers,
                vram: judgeHardwareSnapshot?.total_vram_gb 
            });
        }
    } catch (hwErr) {
        logger.debug('Batch hardware detection failed (non-critical)', { error: hwErr.message });
    }
    
    // Helper to process a single result
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
            _batchHardwareSnapshot: judgeHardwareSnapshot // Pass cached hardware detection
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
    
    // Process results with controlled concurrency
    // NOTE: This parallelization is safe because it only affects judge calls,
    // not the model tests themselves (which were already completed sequentially)
    const scoredResults = [];
    for (let i = 0; i < results.length; i += concurrency) {
        const batch = results.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processResult));
        scoredResults.push(...batchResults);
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
    stripMarkdownCodeFences,
    jsonDeepEqual,
    tryParseJson,
    routeScoring,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    JUDGE_CONFIG,
    // Re-export sub-scorers for direct access
    deterministicScorer,
    decomposedJudge,
    referenceScorer,
    judgeConfidence
};
