/**
 * Scoring Configurations
 * Category-specific scoring dimensions, composite profiles, and strategies
 */

const logger = require('../../../config/logger');

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

const CATEGORY_COMPOSITE_PROFILES = {
    code: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 45000,
        description: "Correctness + efficiency critical"
    },
    coding: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 45000,
        description: "Correctness + efficiency critical"
    },
    reasoning: {
        weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
        latencyCap: 120000,
        description: "Reasoning depth matters most"
    },
    factual: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 30000,
        description: "Accuracy critical, speed matters"
    },
    math: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 60000,
        description: "Correctness paramount"
    },
    creative: {
        weights: { quality: 0.70, latency: 0.15, speed: 0.15 },
        latencyCap: 90000,
        description: "Quality critical, tolerates slower generation"
    },
    general: {
        weights: { quality: 0.50, latency: 0.30, speed: 0.20 },
        latencyCap: 30000,
        description: "Balanced general-purpose profile"
    },
    'instruction-following': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 30000,
        description: "Instruction adherence is critical"
    },
    summarization: {
        weights: { quality: 0.65, latency: 0.20, speed: 0.15 },
        latencyCap: 45000,
        description: "Accuracy + conciseness matter"
    },
    translation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 40000,
        description: "Accuracy and fluency critical"
    },
    'multi-turn-reasoning': {
        weights: { quality: 0.80, latency: 0.10, speed: 0.10 },
        latencyCap: 150000,
        description: "Context retention + reasoning depth"
    },
    'context-retention': {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 60000,
        description: "Recall accuracy critical"
    },
    'edge-cases': {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 45000,
        description: "Error handling + robustness"
    },
    refactoring: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 60000,
        description: "Code quality improvement evaluation"
    },
    debugging: {
        weights: { quality: 0.75, latency: 0.15, speed: 0.10 },
        latencyCap: 45000,
        description: "Bug identification and fixing"
    },
    explanation: {
        weights: { quality: 0.70, latency: 0.20, speed: 0.10 },
        latencyCap: 50000,
        description: "Clarity and accuracy of explanations"
    },
    dialogue: {
        weights: { quality: 0.60, latency: 0.25, speed: 0.15 },
        latencyCap: 30000,
        description: "Conversational quality and engagement"
    }
};

const CATEGORY_STRATEGIES = {
    math: {
        primary: 'deterministic',
        deterministic_type: 'numeric',
        llm_fallback: false,
        confidence_threshold: 0.9
    },
    'instruction-following': {
        primary: 'deterministic',
        deterministic_type: 'json',
        llm_fallback: true,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.8
    },
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
    reasoning: {
        primary: 'decomposed',
        reference_fallback: true,
        confidence_threshold: 0.7
    },
    factual: {
        primary: 'deterministic',
        deterministic_type: 'regex',
        llm_fallback: true,
        llm_strategy: 'standard',
        confidence_threshold: 0.8
    },
    creative: {
        primary: 'llm',
        llm_strategy: 'standard',
        confidence_threshold: 0.6,
        always_flag_review: true
    },
    general: {
        primary: 'auto',
        llm_fallback: true,
        llm_strategy: 'standard',
        confidence_threshold: 0.7
    },
    summarization: {
        primary: 'decomposed',
        reference_fallback: true,
        confidence_threshold: 0.75
    },
    translation: {
        primary: 'reference',
        llm_fallback: true,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.75
    },
    'multi-turn-reasoning': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    'context-retention': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    'edge-cases': {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    refactoring: {
        primary: 'hybrid',
        deterministic_weight: 0.3,
        llm_strategy: 'decomposed',
        confidence_threshold: 0.7
    },
    debugging: {
        primary: 'decomposed',
        confidence_threshold: 0.7
    },
    explanation: {
        primary: 'decomposed',
        confidence_threshold: 0.75
    },
    dialogue: {
        primary: 'llm',
        llm_strategy: 'standard',
        confidence_threshold: 0.7
    }
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
 * Priority: prompt.scoring_dimensions > ENHANCED_SCORING_CONFIGS (with 'general' fallback)
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

    const scoringType = prompt.scoring_type || 'general';
    let enhancedConfig = ENHANCED_SCORING_CONFIGS[scoringType];

    if (!enhancedConfig || !enhancedConfig.core_dimensions) {
        logger.warn('Unknown scoring_type, falling back to general', {
            prompt: prompt.name || 'unknown',
            requestedType: scoringType
        });
        enhancedConfig = ENHANCED_SCORING_CONFIGS.general;
    }

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

module.exports = {
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    getScoringDimensions
};
