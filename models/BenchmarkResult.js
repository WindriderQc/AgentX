/**
 * BenchmarkResult Model
 * Individual benchmark test results with quality scoring
 */

const mongoose = require('mongoose');

const BenchmarkResultSchema = new mongoose.Schema({
    batch_id: {
        type: String,
        required: true,
        index: true
    },
    model: {
        type: String,
        required: true,
        index: true
    },
    host: {
        type: String,
        required: true
    },
    judge_host: {
        type: String,
        default: null
    },
    prompt: {
        type: String,
        required: true
    },
    prompt_name: {
        type: String,
        index: true
    },
    prompt_level: {
        type: Number,
        min: 1,
        max: 5,
        index: true
    },
    prompt_category: {
        type: String,
        enum: ['coding', 'reasoning', 'factual', 'math', 'creative', 'general'],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    response: {
        type: String,
        default: ''
    },
    latency: {
        type: Number,
        default: 0
    },
    tokens: {
        type: Number,
        default: 0
    },
    tokens_per_sec: {
        type: mongoose.Schema.Types.Mixed, // Can be string or number
        default: 0
    },
    success: {
        type: Boolean,
        required: true,
        index: true
    },
    error: {
        type: String,
        default: null
    },
    // Quality scoring fields
    quality_score: {
        type: Number,
        min: 0,
        max: 100,
        default: null
    },
    quality_breakdown: {
        type: Object,
        default: null
    },
    quality_explanation: {
        type: String,
        default: null
    },
    judge_prompt: {
        type: String,
        default: null
    },
    judge_model: {
        type: String,
        default: null
    },
    scoring_method: {
        type: String,
        enum: ['reasoning', 'quick', 'pattern', 'llm_failed', 'exec_failed', 'disabled', 'pending'],
        default: 'disabled'
    },
    scoring_type: {
        type: String,
        enum: ['reasoning', 'quick', 'pattern'],
        default: null
    },
    scoring_time_ms: {
        type: Number,
        default: null
    },
    quick_pattern: {
        type: String,
        default: null
    },
    composite_score: {
        type: Number,
        min: 0,
        max: 100,
        default: null
    },
    normalized_scores: {
        type: Object,
        default: null
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: { createdAt: 'timestamp', updatedAt: 'updated_at' }
});

// Compound indexes for analytics queries
BenchmarkResultSchema.index({ model: 1, success: 1 });
BenchmarkResultSchema.index({ model: 1, prompt_level: 1 });
BenchmarkResultSchema.index({ model: 1, prompt_category: 1 });
BenchmarkResultSchema.index({ batch_id: 1, timestamp: -1 });
BenchmarkResultSchema.index({ quality_score: 1 });
BenchmarkResultSchema.index({ composite_score: 1 });

// Static helper methods
BenchmarkResultSchema.statics.getByBatch = function(batchId, options = {}) {
    const query = this.find({ batch_id: batchId });
    if (options.sort) {
        query.sort(options.sort);
    } else {
        query.sort({ timestamp: -1 });
    }
    if (options.limit) {
        query.limit(options.limit);
    }
    return query;
};

BenchmarkResultSchema.statics.getSuccessful = function(filters = {}) {
    return this.find({ success: true, ...filters });
};

BenchmarkResultSchema.statics.getByModel = function(model, options = {}) {
    return this.find({ model, success: true })
        .sort({ timestamp: -1 })
        .limit(options.limit || 100);
};

BenchmarkResultSchema.statics.getModelStats = async function(model) {
    const tests = await this.find({ model, success: true });

    if (tests.length === 0) {
        return { model, error: 'No successful tests found' };
    }

    const latencies = tests.map(t => t.latency);
    const tokensPerSec = tests.map(t => parseFloat(t.tokens_per_sec)).filter(t => t > 0);
    const qualityScores = tests.map(t => t.quality_score).filter(s => s !== null);

    return {
        model,
        tests: tests.length,
        avg_latency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        min_latency: Math.min(...latencies),
        max_latency: Math.max(...latencies),
        avg_tokens_per_sec: tokensPerSec.length > 0
            ? (tokensPerSec.reduce((a, b) => a + b, 0) / tokensPerSec.length).toFixed(2)
            : '0',
        avg_quality: qualityScores.length > 0
            ? (qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length).toFixed(1)
            : null,
        quality_tests: qualityScores.length
    };
};

BenchmarkResultSchema.statics.getQualityBreakdown = async function(model = null) {
    const matchStage = {
        success: true,
        quality_score: { $ne: null }
    };
    if (model) matchStage.model = model;

    const [byCategory, byLevel, byModel] = await Promise.all([
        this.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: { model: '$model', category: '$prompt_category' },
                    avg_quality: { $avg: '$quality_score' },
                    avg_latency: { $avg: '$latency' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.model': 1, avg_quality: -1 } }
        ]),
        this.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: { model: '$model', level: '$prompt_level' },
                    avg_quality: { $avg: '$quality_score' },
                    avg_latency: { $avg: '$latency' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.model': 1, '_id.level': 1 } }
        ]),
        this.aggregate([
            { $match: matchStage },
            {
                $group: {
                    _id: '$model',
                    avg_quality: { $avg: '$quality_score' },
                    avg_composite: { $avg: '$composite_score' },
                    avg_latency: { $avg: '$latency' },
                    best_category: { $max: '$quality_score' },
                    worst_category: { $min: '$quality_score' },
                    count: { $sum: 1 }
                }
            },
            { $sort: { avg_composite: -1 } }
        ])
    ]);

    return { byCategory, byLevel, byModel };
};

// Instance methods
BenchmarkResultSchema.methods.updateQualityScore = function(scoreData) {
    this.quality_score = scoreData.quality_score;
    this.quality_breakdown = scoreData.breakdown;
    this.quality_explanation = scoreData.explanation;
    this.judge_prompt = scoreData.judge_prompt;
    this.judge_model = scoreData.judge_model;
    this.scoring_method = scoreData.scoring_method;
    this.scoring_type = scoreData.scoring_type;
    this.scoring_time_ms = scoreData.scoring_time_ms;
    this.quick_pattern = scoreData.quick_pattern;
    return this.save();
};

module.exports = mongoose.model('BenchmarkResult', BenchmarkResultSchema);
