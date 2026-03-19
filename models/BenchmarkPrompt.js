/**
 * BenchmarkPrompt Model
 * Stores benchmark test prompts with level classification
 */

const mongoose = require('mongoose');

const BenchmarkPromptSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    prompt: {
        type: String,
        required: true
    },
    level: {
        type: Number,
        required: true,
        min: 1,
        max: 10, // Enhanced judging system: expanded from 5 to 10 levels for finer differentiation
        index: true
    },
    category: {
        type: String,
        required: true,
        enum: [
            // Original categories
            'code', 'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
            // Enhanced judging system categories
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases',
            // Additional deep-evaluation categories
            'refactoring', 'debugging', 'explanation', 'dialogue'
        ],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    // Expected response length in tokens - used to calculate num_predict limit
    // Simple factual: 50-100, reasoning: 200-500, complex/creative: 500-1000
    expected_tokens: {
        type: Number,
        default: null,  // If null, uses level-based defaults
        min: 10,
        max: 10000
    },
    scoring_type: {
        type: String,
        enum: [
            'reasoning', 'quick', 'pattern', 'code', 'factual', 'math', 'creative',
            // Enhanced judging system scoring types
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases',
            // Additional deep-evaluation categories
            'coding', 'general', 'refactoring', 'debugging', 'explanation', 'dialogue',
            // Custom prompt-defined scoring
            'custom'
        ],
        default: 'reasoning'
    },
    scoring_dimensions: {
        type: [{
            name: {
                type: String,
                required: true,
                trim: true
            },
            weight: {
                type: Number,
                required: true,
                min: 0,
                max: 1
            },
            description: {
                type: String,
                required: true,
                trim: true
            },
            scale: {
                type: String,
                default: '0-10',
                trim: true
            },
            rubric: {
                type: String,
                default: '',
                trim: true
            }
        }],
        default: undefined
    },
    // Deterministic scoring configuration (bypasses LLM judge)
    deterministic_scoring: {
        type: {
            type: String,
            enum: ['exact', 'numeric', 'json', 'regex'],
            required: false
        },
        // For regex type: patterns that must be present
        must_contain: [{
            pattern: { type: String },
            weight: { type: Number, default: 1 }
        }],
        // For regex type: patterns that must NOT be present
        must_not_contain: [String],
        // For numeric type: tolerance for matching (default 0.001)
        numeric_tolerance: { type: Number, default: 0.001 },
        // For numeric type: use relative tolerance (as percentage of expected)
        relative_match: { type: Boolean, default: false },
        // For exact type: case-sensitive comparison
        case_sensitive: { type: Boolean, default: false },
        // For exact type: only trim whitespace, don't normalize
        trim_only: { type: Boolean, default: false }
    },
    // Output format contract for dual scoring (semantic vs format)
    output_contract: {
        type: {
            type: String,
            enum: ['number_only', 'exact', 'regex', 'json_schema', 'none'],
            default: undefined
        },
        pattern: { type: String, default: undefined },        // for regex type
        template: { type: String, default: undefined },       // for exact type
        schema_keys: [String],                                // for json_schema type
        allow_latex: { type: Boolean, default: true },        // for number_only
        description: { type: String, default: undefined }     // human-readable
    },
    // Expert reference answer for reference-based scoring (levels 6+)
    reference_answer: {
        type: String,
        default: null
    },
    // Structured criteria for deterministic judging (e.g. ["Names Pine Ridge as the closed trail"])
    judge_criteria: {
        type: [String],
        default: undefined
    },
    // Override: minimum judge tier required for this prompt.
    // If null, derived from prompt level via LEVEL_TIER_MAP.
    required_judge_tier: {
        type: String,
        enum: ['basic', 'standard', 'advanced', 'premium', null],
        default: null
    },
    representative: {
        type: Boolean,
        default: false
    },
    custom: {
        type: Boolean,
        default: false,
        index: true
    },
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Compound indexes for common queries
BenchmarkPromptSchema.index({ level: 1, category: 1 });
BenchmarkPromptSchema.index({ custom: 1, created_at: -1 });

// Static helper methods
BenchmarkPromptSchema.statics.getByLevel = function(level) {
    return this.find({ level }).sort({ category: 1, name: 1 });
};

BenchmarkPromptSchema.statics.getByLevels = function(levels) {
    return this.find({ level: { $in: levels } }).sort({ level: 1, category: 1 });
};

BenchmarkPromptSchema.statics.getByCategory = function(category) {
    return this.find({ category }).sort({ level: 1, name: 1 });
};

BenchmarkPromptSchema.statics.getAllGroupedByLevel = async function() {
    const prompts = await this.find().sort({ level: 1, category: 1 });
    const byLevel = {};
    prompts.forEach(p => {
        if (!byLevel[p.level]) {
            byLevel[p.level] = [];
        }
        byLevel[p.level].push(p);
    });
    return { prompts, byLevel };
};

BenchmarkPromptSchema.statics.getCustomPrompts = function() {
    return this.find({ custom: true }).sort({ created_at: -1 });
};

BenchmarkPromptSchema.statics.seedFromArray = async function(prompts) {
    const count = await this.countDocuments();
    if (count === 0) {
        const docs = prompts.map(p => ({
            ...p,
            custom: false,
            created_at: new Date()
        }));
        await this.insertMany(docs);
        return docs.length;
    }
    return 0;
};

module.exports = mongoose.model('BenchmarkPrompt', BenchmarkPromptSchema);
