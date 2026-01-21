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
            // Original 6 categories
            'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
            // Enhanced judging system: 6 new categories for better model differentiation
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases'
        ],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    scoring_type: {
        type: String,
        enum: [
            'reasoning', 'quick', 'pattern', 'code', 'factual', 'math', 'creative',
            // Enhanced judging system: additional scoring types for new categories
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases'
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
