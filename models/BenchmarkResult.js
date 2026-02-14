/**
 * BenchmarkResult Model
 * Individual benchmark test results with quality scoring
 */

const mongoose = require('mongoose');

const BenchmarkResultSchema = new mongoose.Schema({
    batch_id: {
        type: String,
        required: false,
        default: null,
        index: true
    },

    // Week 4: Multi-tenancy support
    workspaceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Workspace',
        required: false, // Optional for backward compatibility
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
        max: 10, // Enhanced judging system: expanded from 5 to 10 levels for finer differentiation
        index: true
    },
    prompt_category: {
        type: String,
        enum: [
            // Original categories
            'code', 'coding', 'reasoning', 'factual', 'math', 'creative', 'general',
            // Enhanced judging system categories
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases',
            // Additional deep evaluation categories
            'refactoring', 'debugging', 'explanation', 'dialogue'
        ],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    // Structured criteria for deterministic judging (carried from prompt)
    judge_criteria: {
        type: [String],
        default: undefined
    },
    response: {
        type: String,
        default: ''
    },
    // Extracted thinking/reasoning content from <think> blocks (e.g., DeepSeek-R1)
    thinking: {
        type: String,
        default: null
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
        type: Number,
        default: 0,
        set: (value) => {
            const n = Number(value);
            return Number.isFinite(n) ? n : 0;
        }
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

    // Error classification (infra vs model) to avoid skewing reliability stats
    infra_error: {
        type: Boolean,
        default: null,
        index: true
    },
    error_type: {
        type: String,
        enum: ['infra', 'model', 'unknown'],
        default: null,
        index: true
    },
    error_http_status: {
        type: Number,
        default: null
    },
    // Dual scoring: semantic correctness vs format compliance
    semantic_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'Correctness score ignoring format (0-10)'
    },
    format_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'Format compliance score (0-10, null = no contract)'
    },
    format_compliant: {
        type: Boolean,
        default: null,
        description: 'Whether output matches the output_contract format'
    },
    // Quality scoring fields
    quality_score: {
        type: Number,
        min: 0,
        max: 10,  // Changed from 100 to match actual 0-10 scale from qualityScorer
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
        enum: [
            'reasoning', 'quick', 'pattern', 'llm_judge', 'llm_failed', 'exec_failed',
            'disabled', 'pending', 'skipped', 'empty_response',
            // New multi-strategy scoring methods
            'deterministic', 'decomposed', 'reference', 'reference_quick'
        ],
        default: 'disabled'
    },
    scoring_type: {
        type: String,
        enum: [
            // Legacy values
            'reasoning', 'quick', 'pattern',
            // Category-based scoring types (matches ENHANCED_SCORING_CONFIGS)
            'code', 'coding', 'factual', 'math', 'creative', 'general',
            'instruction-following', 'summarization', 'translation',
            'multi-turn-reasoning', 'context-retention', 'edge-cases',
            'refactoring', 'debugging', 'explanation', 'dialogue',
            // Custom prompt-defined scoring
            'custom'
        ],
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
    composite_profile_used: {
        type: String,
        default: null,
        description: 'Tracks which composite profile was used (e.g., "category:coding", "profile:interactive")'
    },
    normalized_scores: {
        type: Object,
        default: null
    },
    // Phase 3 Week 10: Hardware profiling snapshot
    hardware_snapshot: {
        backend: { type: String, default: null },
        vram_usage_mb: { type: Number, default: null },
        quantization: { type: String, default: null },
        detection_metadata: { type: Object, default: null }
    },
    // Judge host hardware snapshot (captured during quality scoring)
    judge_hardware_snapshot: {
        backend: { type: String, default: null },
        vram_usage_mb: { type: Number, default: null },
        quantization: { type: String, default: null },
        detection_metadata: { type: Object, default: null }
    },
    // Truncation detection for model/judge responses
    truncation: {
        response_truncated: { type: Boolean, default: false },
        response_tokens: { type: Number, default: null },
        response_limit: { type: Number, default: null },
        done_reason: { type: String, default: null }, // Ollama's reason for stopping: 'stop', 'length', 'load', etc.
        input_to_judge_truncated: { type: Boolean, default: false },
        input_original_chars: { type: Number, default: null },
        input_sent_chars: { type: Number, default: null },
        judge_truncated: { type: Boolean, default: false },
        judge_tokens: { type: Number, default: null }
    },
    // Execution settings used for this test
    execution_settings: {
        num_predict: { type: Number, default: null },
        hint_applied: { type: Boolean, default: false },
        hint_text: { type: String, default: null }
    },
    // Model warmup capture for validation
    warmup: {
        prompt: { type: String, default: null },
        response: { type: String, default: null },
        latency_ms: { type: Number, default: null },
        already_loaded: { type: Boolean, default: null }
    },
    // Judge warmup capture (when judge is on separate host)
    judge_warmup: {
        prompt: { type: String, default: null },
        response: { type: String, default: null },
        latency_ms: { type: Number, default: null },
        already_loaded: { type: Boolean, default: null }
    },
    // Raw judge response before parsing (for debugging/validation)
    judge_raw_response: {
        type: String,
        default: null
    },
    // Judge confidence and review fields
    judge_confidence: {
        type: Number,
        min: 0,
        max: 1,
        default: null,
        description: 'Confidence in judge reliability (0-1)'
    },
    prompt_complexity: {
        type: Number,
        min: 1,
        max: 10,
        default: null,
        description: 'Estimated complexity of the prompt (1-10)'
    },
    needs_review: {
        type: Boolean,
        default: false,
        index: true,
        description: 'Flag for manual review when judge confidence is low'
    },
    review_reason: {
        type: String,
        default: null,
        description: 'Reason why review is needed'
    },
    human_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'Manual human override score'
    },
    human_reviewed_at: {
        type: Date,
        default: null,
        description: 'When human review was completed'
    },
    human_reviewer: {
        type: String,
        default: null,
        description: 'Who performed the human review'
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

    if (options.select) {
        query.select(options.select);
    }

    if (options.sort) {
        query.sort(options.sort);
    } else {
        query.sort({ timestamp: -1 });
    }
    if (options.limit) {
        query.limit(options.limit);
    }
    if (options.offset) {
        query.skip(options.offset);
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
    const agg = await this.aggregate([
        { $match: { model, success: true } },
        {
            $group: {
                _id: null,
                tests: { $sum: 1 },
                avg_latency: { $avg: '$latency' },
                min_latency: { $min: '$latency' },
                max_latency: { $max: '$latency' },
                avg_tokens_per_sec: { $avg: { $toDouble: '$tokens_per_sec' } },
                avg_quality: {
                    $avg: {
                        $cond: [
                            { $ne: ['$quality_score', null] },
                            '$quality_score',
                            null
                        ]
                    }
                },
                quality_tests: {
                    $sum: {
                        $cond: [
                            { $ne: ['$quality_score', null] },
                            1,
                            0
                        ]
                    }
                }
            }
        }
    ]);

    if (agg.length === 0) {
        return { model, error: 'No successful tests found' };
    }

    const stats = agg[0];

    return {
        model,
        tests: Number(stats.tests) || 0,
        avg_latency: Math.round(Number(stats.avg_latency) || 0),
        min_latency: Number(stats.min_latency) || 0,
        max_latency: Number(stats.max_latency) || 0,
        avg_tokens_per_sec: stats.avg_tokens_per_sec != null
            ? Number(stats.avg_tokens_per_sec).toFixed(2)
            : '0',
        avg_quality: stats.avg_quality != null
            ? Number(stats.avg_quality).toFixed(1)
            : null,
        quality_tests: Number(stats.quality_tests) || 0
    };
};

BenchmarkResultSchema.statics.getQualityBreakdown = async function(model = null, host = null) {
    const matchStage = {
        success: true,
        quality_score: { $ne: null }
    };
    if (model) {
        matchStage.model = model;
    } else {
        matchStage.model = { $not: /diagnostic/i };
    }
    if (host) {
        matchStage.host = host;
    }

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
                    max_quality_score: { $max: '$quality_score' },
                    min_quality_score: { $min: '$quality_score' },
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
    // Support thinking field update
    if (scoreData.thinking !== undefined) {
        this.thinking = scoreData.thinking;
    }
    return this.save();
};

module.exports = mongoose.model('BenchmarkResult', BenchmarkResultSchema);
