/**
 * Scoring Configurations
 * Category-specific scoring dimensions, composite profiles, and strategies
 */

const logger = require('../../../config/logger');
const { normalizeBenchmarkCategory } = require('../../../config/categories');

const DEFAULT_SCORING_CATEGORY = 'knowledge';

// The overall score may exceed the primary dimension by at most this much.
// Without the cap, the weighted mean let a wrong answer collect up to 7.5
// points for clarity and style ("Berlin is the capital of France" scored 3.7
// in calibration). One point keeps secondary dimensions meaningful among
// correct answers while making correctness a precondition for a high score.
const PRIMARY_DIMENSION_CAP_MARGIN = 1;

function normalizeScoringCategory(rawCategory, fallback = null) {
    return normalizeBenchmarkCategory(rawCategory, fallback);
}

const ENHANCED_SCORING_CONFIGS = {
    coding: {
        description: 'Code generation, debugging, and refactoring',
        primary_dimension: 'correctness',
        core_dimensions: [
            { name: 'correctness', weight: 0.45, desc: 'Does the code work correctly?' },
            { name: 'clarity', weight: 0.15, desc: 'Is the code readable and well-structured?' },
            { name: 'efficiency', weight: 0.20, desc: 'Reasonable performance and complexity?' },
            { name: 'robustness', weight: 0.20, desc: 'Handles errors and edge cases?' }
        ]
    },
    reasoning: {
        description: 'Logical reasoning, analysis, and edge case handling',
        primary_dimension: 'accuracy',
        core_dimensions: [
            { name: 'accuracy', weight: 0.30, desc: 'Is the conclusion correct?' },
            { name: 'logic_soundness', weight: 0.30, desc: 'Is the reasoning valid and complete?' },
            { name: 'completeness', weight: 0.20, desc: 'Addresses all aspects including edge cases?' },
            { name: 'clarity', weight: 0.20, desc: 'Clear explanation of reasoning?' }
        ]
    },
    math: {
        description: 'Mathematical correctness and rigor',
        primary_dimension: 'answer_correctness',
        core_dimensions: [
            { name: 'answer_correctness', weight: 0.25, desc: 'Final answer correct?' },
            { name: 'method', weight: 0.35, desc: 'Solution approach valid?' },
            { name: 'rigor', weight: 0.25, desc: 'Mathematically rigorous?' },
            { name: 'clarity', weight: 0.15, desc: 'Steps clearly shown?' }
        ]
    },
    knowledge: {
        description: 'Factual accuracy, recall, and explanation',
        primary_dimension: 'accuracy',
        core_dimensions: [
            { name: 'accuracy', weight: 0.35, desc: 'Factually correct?' },
            { name: 'completeness', weight: 0.25, desc: 'Answers fully with key details?' },
            { name: 'clarity', weight: 0.25, desc: 'Clearly explained and structured?' },
            { name: 'objectivity', weight: 0.15, desc: 'Balanced and avoids hallucination?' }
        ]
    },
    instruction: {
        description: 'Constraint compliance, format adherence, and summarization',
        primary_dimension: 'constraint_compliance',
        core_dimensions: [
            { name: 'instruction_adherence', weight: 0.25, desc: 'Follows instructions precisely?' },
            { name: 'constraint_compliance', weight: 0.30, desc: 'Respects all constraints?' },
            { name: 'format_accuracy', weight: 0.30, desc: 'Output format correct?' },
            { name: 'completeness', weight: 0.15, desc: 'All requirements met?' }
        ],
        judge_hints: `IMPORTANT FOR STRUCTURED OUTPUT:
- If expected output is JSON, parse and compare semantically (order of object keys doesn't matter, but array order does)
- For sorting tasks: verify the sorting criteria (e.g., "by length" means compare string lengths)
- Check EXACT values, not approximate matches
- Empty arrays [] or objects {} are valid outputs if that's what's expected`
    },
    creative: {
        description: 'Creative writing, storytelling, and conversational quality',
        // Rubric 2.16: form is primary. A piece that is not in the requested form
        // (a "haiku" without 5-7-5, a dialog when a story was asked) is wrong,
        // not weak; poetic quality is judged among pieces that are in form.
        // The creative reweight kept relevance strong so dialog / clarifying-question
        // replies are not penalized for lacking narrative structure.
        primary_dimension: 'form',
        core_dimensions: [
            { name: 'form', weight: 0.30, desc: 'In the requested form and shape?' },
            { name: 'relevance', weight: 0.25, desc: 'Addresses the prompt and its scenario?' },
            { name: 'originality', weight: 0.15, desc: 'Original and imaginative?' },
            { name: 'coherence', weight: 0.15, desc: 'Well-structured and logical?' },
            { name: 'engagement', weight: 0.15, desc: 'Compelling and interesting?' }
        ]
    },
    translation: {
        description: 'Cross-language translation quality',
        primary_dimension: 'accuracy',
        core_dimensions: [
            { name: 'accuracy', weight: 0.35, desc: 'Meaning preserved correctly?' },
            { name: 'fluency', weight: 0.30, desc: 'Natural in target language?' },
            { name: 'grammar', weight: 0.20, desc: 'Grammatically correct?' },
            { name: 'cultural_fit', weight: 0.15, desc: 'Culturally appropriate?' }
        ]
    }
};

const CATEGORY_COMPOSITE_PROFILES = {
    coding:      { weights: { quality: 0.60, latency: 0.25, speed: 0.15 }, latencyCap: 45000, ttftCap: 5000, description: 'Correctness + efficiency critical' },
    reasoning:   { weights: { quality: 0.80, latency: 0.10, speed: 0.10 }, latencyCap: 120000, ttftCap: 9000, description: 'Reasoning depth matters most' },
    math:        { weights: { quality: 0.75, latency: 0.15, speed: 0.10 }, latencyCap: 60000, ttftCap: 6000, description: 'Correctness paramount' },
    knowledge:   { weights: { quality: 0.70, latency: 0.20, speed: 0.10 }, latencyCap: 30000, ttftCap: 3000, description: 'Accuracy critical, speed matters' },
    instruction: { weights: { quality: 0.75, latency: 0.15, speed: 0.10 }, latencyCap: 30000, ttftCap: 3000, description: 'Instruction adherence critical' },
    creative:    { weights: { quality: 0.70, latency: 0.15, speed: 0.15 }, latencyCap: 90000, ttftCap: 7000, description: 'Quality critical, tolerates slower generation' },
    translation: { weights: { quality: 0.70, latency: 0.20, speed: 0.10 }, latencyCap: 40000, ttftCap: 4000, description: 'Accuracy and fluency critical' }
};

const CATEGORY_STRATEGIES = {
    coding:      { primary: 'decomposed', reference_fallback: true, confidence_threshold: 0.7 },
    reasoning:   { primary: 'decomposed', reference_fallback: true, confidence_threshold: 0.7 },
    math:        { primary: 'deterministic', deterministic_type: 'numeric', llm_fallback: true, llm_strategy: 'decomposed', confidence_threshold: 0.9 },
    knowledge:   { primary: 'decomposed', reference_fallback: true, confidence_threshold: 0.75 },
    instruction: { primary: 'decomposed', reference_fallback: false, confidence_threshold: 0.8 },
    creative:    { primary: 'decomposed', reference_fallback: false, confidence_threshold: 0.6 },
    translation: { primary: 'decomposed', reference_fallback: true, confidence_threshold: 0.75 }
};

/**
 * Validate weight configuration at module load
 */
function validateWeights() {
    const errors = [];

    for (const [category, config] of Object.entries(ENHANCED_SCORING_CONFIGS)) {
        if (config.core_dimensions) {
            const sum = config.core_dimensions.reduce((acc, dim) => acc + dim.weight, 0);
            const diff = Math.abs(sum - 1.0);
            if (diff > 0.001) {
                errors.push(`${category}: core_dimension weights sum to ${sum.toFixed(3)}, expected 1.0`);
            }
            if (!config.core_dimensions.some(dim => dim.name === config.primary_dimension)) {
                errors.push(`${category}: primary_dimension ${config.primary_dimension} is not a core dimension`);
            }
        }
    }

    if (errors.length > 0) {
        logger.error('Weight validation failed', { errors });
        throw new Error(`Invalid weight configuration: ${errors.join('; ')}`);
    }
}

function validateCompositeWeights() {
    const errors = [];

    for (const [category, config] of Object.entries(CATEGORY_COMPOSITE_PROFILES)) {
        const { quality, latency, speed } = config.weights;
        const sum = quality + latency + speed;
        const diff = Math.abs(sum - 1.0);
        if (diff > 0.001) {
            errors.push(`${category}: composite weights sum to ${sum.toFixed(3)}, expected 1.0`);
        }
    }

    if (errors.length > 0) {
        logger.error('Composite weight validation failed', { errors });
        throw new Error(`Invalid composite weight configuration: ${errors.join('; ')}`);
    }
}

// Validate at module load
validateWeights();
validateCompositeWeights();

/**
 * Get scoring dimensions for a prompt
 * Priority: prompt.scoring_dimensions > ENHANCED_SCORING_CONFIGS (with knowledge fallback)
 */
function getScoringDimensions(prompt) {
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

    const requestedType = prompt.scoring_type || prompt.category || DEFAULT_SCORING_CATEGORY;
    const scoringType = normalizeScoringCategory(requestedType, DEFAULT_SCORING_CATEGORY);
    let enhancedConfig = ENHANCED_SCORING_CONFIGS[scoringType];
    let effectiveCategory = scoringType;

    if (!enhancedConfig || !enhancedConfig.core_dimensions) {
        logger.warn('Unknown scoring_type, falling back to default category', {
            prompt: prompt.name || 'unknown',
            requestedType,
            normalizedType: scoringType,
            fallbackType: DEFAULT_SCORING_CATEGORY
        });
        enhancedConfig = ENHANCED_SCORING_CONFIGS[DEFAULT_SCORING_CATEGORY];
        effectiveCategory = DEFAULT_SCORING_CATEGORY;
    }

    const dimensions = enhancedConfig.core_dimensions;
    const weights = dimensions.reduce((acc, dim) => {
        acc[dim.name] = dim.weight;
        return acc;
    }, {});

    logger.debug('Using enhanced core dimensions for judge evaluation', {
        prompt: prompt.name || 'unknown',
        scoringType: effectiveCategory,
        coreDimensionCount: dimensions.length,
        hasJudgeHints: !!enhancedConfig.judge_hints
    });

    return {
        dimensions,
        weights,
        category: effectiveCategory,
        judgeHints: enhancedConfig.judge_hints || null
    };
}

module.exports = {
    PRIMARY_DIMENSION_CAP_MARGIN,
    DEFAULT_SCORING_CATEGORY,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    getScoringDimensions,
    normalizeScoringCategory
};
