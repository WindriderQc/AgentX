/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const logger = require('../../config/logger');
const hardwareProfileService = require('./hardwareProfileService');
const deterministicScorer = require('./deterministicScorer');
const decomposedJudge = require('./decomposedJudge');
const referenceScorer = require('./referenceScorer');
const judgeConfidence = require('./judgeConfidence');

// Import from extracted modules
const { ENHANCED_SCORING_CONFIGS, CATEGORY_COMPOSITE_PROFILES, CATEGORY_STRATEGIES, getScoringDimensions } = require('./scoring/scoringConfigs');
const { calculateCompositeScore } = require('./scoring/compositeScorer');
const { stripMarkdownCodeFences, jsonDeepEqual, tryParseJson } = require('./scoring/jsonUtils');
const { quickScore } = require('./scoring/quickScorer');
const { JUDGE_CONFIG, callJudge, buildDynamicJudgePrompt, incrementJudgeFailureCount } = require('./scoring/judgeCall');
const { scoreFormatCompliance } = require('./scoring/formatComplianceScorer');

/**
 * Score a model response for quality
 */
async function scoreResponse({ response, prompt, skipLLM = false, judgeConfig = {}, _batchHardwareSnapshot = null }) {
    const startTime = Date.now();
    const mergedJudgeConfig = { ...JUDGE_CONFIG, ...judgeConfig };

    // Helper: compute format compliance and semantic score, then merge into result
    const enrichWithDualScores = (result, opts = {}) => {
        const contract = prompt.output_contract;
        const formatResult = scoreFormatCompliance(response, contract);
        result.format_score = formatResult.format_score;
        result.format_compliant = formatResult.format_compliant;

        // Semantic score: correctness regardless of format
        if (opts.deterministicMatch !== undefined) {
            // Deterministic/quick: matched = high semantic, regardless of format
            result.semantic_score = opts.deterministicMatch ? Math.max(result.quality_score, 8) : result.quality_score;
        } else {
            // LLM judge: semantic_score equals quality_score (judge evaluates content)
            result.semantic_score = result.quality_score;
        }
        return result;
    };

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
            return enrichWithDualScores({
                quality_score: detResult.score,
                scoring_method: 'deterministic',
                deterministic_type: detResult.deterministic_type,
                matched_expected: detResult.matched,
                explanation: detResult.details,
                breakdown: { overall: detResult.score },
                scoring_time_ms: Date.now() - startTime,
                judge_confidence: 1.0,
                needs_review: false
            }, { deterministicMatch: detResult.matched });
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

        return enrichWithDualScores({
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
            judge_confidence: 1.0,
            needs_review: false
        }, { deterministicMatch: quickResult.matched });
    }

    if (skipLLM) {
        return enrichWithDualScores({
            quality_score: null,
            scoring_method: 'skipped',
            reason: 'LLM scoring disabled',
            scoring_time_ms: Date.now() - startTime
        });
    }

    // Validate that response is not empty before scoring
    if (!response || response.trim().length === 0) {
        logger.warn('Attempting to score empty response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            response_length: response ? response.length : 0,
            task: prompt.prompt ? prompt.prompt.substring(0, 100) : 'unknown'
        });
        return enrichWithDualScores({
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
        });
    }

    // Phase 3: Try routed scoring (reference, decomposed, etc.)
    const routedResult = await routeScoring(response, prompt, mergedJudgeConfig);
    if (routedResult) {
        const isDeterministicMatch = routedResult.matched_expected !== undefined ? routedResult.matched_expected : undefined;
        if (routedResult.judge_confidence !== undefined && routedResult.needs_review !== undefined) {
            return enrichWithDualScores({
                ...routedResult,
                scoring_time_ms: Date.now() - startTime
            }, { deterministicMatch: isDeterministicMatch });
        }

        const confidence = judgeConfidence.assess(routedResult, prompt);

        return enrichWithDualScores({
            ...routedResult,
            scoring_time_ms: Date.now() - startTime,
            judge_confidence: confidence.judge_confidence,
            prompt_complexity: confidence.prompt_complexity,
            needs_review: confidence.needs_review,
            review_reason: confidence.review_reason
        }, { deterministicMatch: isDeterministicMatch });
    }

    // Phase 4: Fall back to standard LLM-as-judge for complex evaluation
    const scoringType = prompt.scoring_type || 'general';
    const dimensionsInfo = getScoringDimensions(prompt);

    const cleanedResponse = stripMarkdownCodeFences(response);
    if (cleanedResponse !== response) {
        logger.debug('Stripped markdown code fences from response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            originalLength: response.length,
            cleanedLength: cleanedResponse.length
        });
    }

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
        incrementJudgeFailureCount();
        logger.warn('LLM judge failed', {
            error: judgeResult.error,
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
            scoring_type: scoringType
        });
        return enrichWithDualScores({
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
        });
    }

    const scores = judgeResult.scores;

    // Validate and normalize judge scores to 0-10 range
    const normalizedScores = {};
    for (const [key, value] of Object.entries(scores)) {
        if (typeof value === 'number' && key !== 'overall') {
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

        if (totalWeight > 0 && totalWeight !== 1.0) {
            logger.warn('Weights do not sum to 1.0, normalizing', {
                total_weight: totalWeight,
                scoring_type: scoringType,
                prompt: prompt.name || prompt.prompt_name || 'unknown'
            });
            overallScore = overallScore / totalWeight;
        }

        overallScore = Math.max(0, Math.min(10, overallScore));
        overallScore = Math.round(overallScore * 10) / 10;
    } else {
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

    const truncation = {
        judge_truncated: judgeResult.judge_truncated || false,
        judge_tokens: judgeResult.judge_tokens || 0
    };

    if (judgeResult.judge_truncated) {
        logger.warn('Judge output truncated', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_tokens: judgeResult.judge_tokens
        });
    }

    // Detect judge hardware
    let judgeHardwareSnapshot = null;
    if (_batchHardwareSnapshot) {
        judgeHardwareSnapshot = _batchHardwareSnapshot;
    } else {
        try {
            const judgeHost = mergedJudgeConfig.host || JUDGE_CONFIG.host;
            const judgeModel = mergedJudgeConfig.model || JUDGE_CONFIG.model;
            if (judgeHost && judgeModel) {
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

    const confidence = judgeConfidence.assess(baseResult, prompt);

    return enrichWithDualScores({
        ...baseResult,
        judge_confidence: confidence.judge_confidence,
        prompt_complexity: confidence.prompt_complexity,
        needs_review: confidence.needs_review,
        review_reason: confidence.review_reason
    });
}

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

/**
 * Route scoring to the appropriate strategy based on category and prompt
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
    const normalizeDeterministic = (detResult, methodLabel = 'deterministic') => {
        if (!detResult) return null;
        const score = Number(detResult.score);
        const quality = Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0;
        return {
            quality_score: quality,
            scoring_method: methodLabel,
            scoring_type: category,
            deterministic_type: detResult.deterministic_type || detResult.method || null,
            matched_expected: !!detResult.matched,
            explanation: detResult.details || 'Deterministic scoring',
            breakdown: { overall: quality },
            judge_confidence: 1.0,
            needs_review: false
        };
    };

    // Phase 1: Try deterministic scoring if configured
    if (strategy.primary === 'deterministic' || strategy.primary === 'hybrid' || strategy.primary === 'auto') {
        if (prompt.deterministic_scoring) {
            result = deterministicScorer.score(response, prompt);
            if (result && result.matched) {
                logger.info('Deterministic scoring succeeded', {
                    prompt: prompt.name || 'unknown',
                    type: result.deterministic_type,
                    score: result.score
                });
                return normalizeDeterministic(result);
            }
        }

        if (category === 'math' && prompt.expected_answer) {
            const numResult = deterministicScorer.numericEval(response, prompt.expected_answer);
            if (numResult.matched) {
                logger.info('Math deterministic scoring succeeded', {
                    prompt: prompt.name || 'unknown',
                    score: numResult.score
                });
                return normalizeDeterministic({
                    ...numResult,
                    deterministic_type: 'numeric'
                }, 'deterministic');
            }
        }
    }

    // Phase 1.5: Try criteria-based scoring (judge_criteria + expected_answer)
    if (prompt.judge_criteria?.length > 0 && prompt.expected_answer) {
        const criteriaResult = criteriaBasedScore(response, prompt);
        if (criteriaResult) {
            return normalizeDeterministic(criteriaResult, 'deterministic');
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
        const enhancedConfig = ENHANCED_SCORING_CONFIGS[category] || ENHANCED_SCORING_CONFIGS.general;
        const dimensionWeights = {};
        if (enhancedConfig && enhancedConfig.core_dimensions) {
            for (const dim of enhancedConfig.core_dimensions) {
                dimensionWeights[dim.name] = dim.weight;
            }
        }
        result = await decomposedJudge.score(response, { ...prompt, _dimensionWeights: dimensionWeights }, judgeConfig);
        if (result) {
            logger.info('Decomposed judging used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 4: Fall back to standard LLM judge
    return null;
}

/**
 * Batch score multiple responses
 */
async function batchScore(results, options = {}) {
    const profile = options.profile || 'interactive';
    const concurrency = options.concurrency || 5;

    // Detect judge hardware ONCE for entire batch
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

    const processResult = async (result) => {
        if (!result.response || !result.success) {
            return {
                ...result,
                quality_score: null,
                scoring_method: 'skipped',
                reason: result.success ? 'no_response' : 'test_failed'
            };
        }

        const promptInfo = {
            prompt: result.prompt,
            expected_answer: result.expected_answer || '',
            scoring_type: result.prompt_category || 'reasoning',
            judge_criteria: result.judge_criteria || []
        };

        const scores = await scoreResponse({
            response: result.response,
            prompt: promptInfo,
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
            judge_confidence: scores.judge_confidence,
            prompt_complexity: scores.prompt_complexity,
            needs_review: scores.needs_review,
            review_reason: scores.review_reason,
            ...composite
        };
    };

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
    criteriaBasedScore,
    extractCriterionPattern,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    JUDGE_CONFIG,
    deterministicScorer,
    decomposedJudge,
    referenceScorer,
    judgeConfidence
};
