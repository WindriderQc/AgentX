/**
 * JudgeGroundTruth Model
 * Curated test dataset for validating judge model performance
 * Contains responses with expert-assigned reference scores
 */

const mongoose = require('mongoose');

const JudgeGroundTruthSchema = new mongoose.Schema({
    // Unique identifier for this ground truth entry
    name: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // The prompt/task that was given
    prompt: {
        type: String,
        required: true
    },

    // The response to evaluate
    response: {
        type: String,
        required: true
    },

    // Category for this evaluation
    category: {
        type: String,
        enum: [
            'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
        ],
        required: true,
        index: true
    },

    // Expected answer (if applicable)
    expected_answer: {
        type: String,
        default: null
    },

    // Human expert scores (reference truth) - 0-10 scale
    expert_scores: {
        overall: { type: Number, min: 0, max: 10, required: true },
        // Dimension scores vary by category, stored as object
        dimensions: {
            type: Map,
            of: Number,
            default: {}
        }
    },

    // Expert's rationale for the scores
    expert_rationale: {
        type: String,
        required: true
    },

    // Metadata about who created this ground truth
    created_by: {
        type: String,
        default: 'system'
    },

    // Difficulty level (1-5)
    difficulty: {
        type: Number,
        min: 1,
        max: 5,
        default: 3
    },

    // Tags for filtering
    tags: [{
        type: String,
        index: true
    }],

    // Whether this entry is active for validation
    active: {
        type: Boolean,
        default: true,
        index: true
    },

    // Validation run history (last N runs)
    validation_history: [{
        judge_model: String,
        judge_score: Number,
        dimension_scores: Object,
        deviation: Number,  // Absolute difference from expert_scores.overall
        timestamp: { type: Date, default: Date.now }
    }],

    // Aggregate stats from validation runs
    validation_stats: {
        total_runs: { type: Number, default: 0 },
        avg_deviation: { type: Number, default: null },
        max_deviation: { type: Number, default: null },
        min_deviation: { type: Number, default: null },
        last_validated: { type: Date, default: null }
    }
}, {
    timestamps: true
});

// Index for efficient validation queries
JudgeGroundTruthSchema.index({ category: 1, active: 1 });
JudgeGroundTruthSchema.index({ difficulty: 1, active: 1 });
JudgeGroundTruthSchema.index({ 'validation_stats.avg_deviation': 1 });

/**
 * Get active ground truth entries for validation
 */
JudgeGroundTruthSchema.statics.getForValidation = function(options = {}) {
    const query = { active: true };

    if (options.category) {
        query.category = options.category;
    }

    if (options.difficulty) {
        query.difficulty = options.difficulty;
    }

    if (options.tags && options.tags.length > 0) {
        query.tags = { $in: options.tags };
    }

    let q = this.find(query);

    if (options.limit) {
        q = q.limit(options.limit);
    }

    if (options.random) {
        // MongoDB random sampling
        return this.aggregate([
            { $match: query },
            { $sample: { size: options.limit || 10 } }
        ]);
    }

    return q.sort({ difficulty: 1, createdAt: -1 });
};

/**
 * Record a validation run result
 */
JudgeGroundTruthSchema.methods.recordValidation = async function(result) {
    const deviation = Math.abs(this.expert_scores.overall - result.judge_score);

    // Add to history (keep last 50 runs)
    this.validation_history.push({
        judge_model: result.judge_model,
        judge_score: result.judge_score,
        dimension_scores: result.dimension_scores || {},
        deviation,
        timestamp: new Date()
    });

    if (this.validation_history.length > 50) {
        this.validation_history = this.validation_history.slice(-50);
    }

    // Update aggregate stats
    const deviations = this.validation_history.map(h => h.deviation);
    this.validation_stats.total_runs = this.validation_history.length;
    this.validation_stats.avg_deviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    this.validation_stats.max_deviation = Math.max(...deviations);
    this.validation_stats.min_deviation = Math.min(...deviations);
    this.validation_stats.last_validated = new Date();

    return this.save();
};

/**
 * Get entries with highest deviation (problematic for judge)
 */
JudgeGroundTruthSchema.statics.getHighDeviation = function(threshold = 2.0, limit = 20) {
    return this.find({
        active: true,
        'validation_stats.avg_deviation': { $gte: threshold }
    })
    .sort({ 'validation_stats.avg_deviation': -1 })
    .limit(limit);
};

/**
 * Get validation accuracy summary
 */
JudgeGroundTruthSchema.statics.getAccuracySummary = async function() {
    const results = await this.aggregate([
        { $match: { active: true, 'validation_stats.total_runs': { $gt: 0 } } },
        {
            $group: {
                _id: '$category',
                count: { $sum: 1 },
                avg_deviation: { $avg: '$validation_stats.avg_deviation' },
                max_deviation: { $max: '$validation_stats.max_deviation' },
                min_deviation: { $min: '$validation_stats.min_deviation' },
                total_runs: { $sum: '$validation_stats.total_runs' }
            }
        },
        { $sort: { avg_deviation: -1 } }
    ]);

    const overall = await this.aggregate([
        { $match: { active: true, 'validation_stats.total_runs': { $gt: 0 } } },
        {
            $group: {
                _id: null,
                total_entries: { $sum: 1 },
                avg_deviation: { $avg: '$validation_stats.avg_deviation' },
                total_runs: { $sum: '$validation_stats.total_runs' }
            }
        }
    ]);

    return {
        by_category: results,
        overall: overall[0] || { total_entries: 0, avg_deviation: null, total_runs: 0 }
    };
};

module.exports = mongoose.model('JudgeGroundTruth', JudgeGroundTruthSchema);
