const mongoose = require('mongoose');

const BenchmarkResultSchema = new mongoose.Schema({
    batch_id: { type: mongoose.Schema.Types.ObjectId, ref: 'BenchmarkBatch' },
    model: { type: String, required: true },
    host: { type: String, required: true },
    judge_host: { type: String }, // Host where judge ran (if separate)

    // Prompt Metadata
    prompt: { type: String, required: true },
    prompt_name: { type: String },
    prompt_level: { type: Number },
    prompt_category: { type: String },
    expected_answer: { type: String },

    // Execution Metrics
    latency: { type: Number }, // ms
    tokens: { type: Number },
    tokens_per_sec: { type: Number }, // derived
    response: { type: String },

    // Status
    success: { type: Boolean, default: true },
    error: { type: String },

    // Quality / Judge Metrics
    quality_score: { type: Number }, // 0-10
    scoring_method: {
        type: String,
        enum: ['quick', 'llm_judge', 'llm_failed', 'pending', 'disabled', 'skipped', 'exec_failed'],
        default: 'disabled'
    },
    scoring_type: { type: String }, // reasoning, coding, etc.
    quality_explanation: { type: String },
    quality_breakdown: { type: mongoose.Schema.Types.Mixed }, // { accuracy: 8, logic: 9 ... }

    judge_model: { type: String },
    judge_prompt: { type: String },
    scoring_time_ms: { type: Number },
    quick_pattern: { type: String },

    // Composite Scores
    composite_score: { type: Number }, // 0-10 (Weighted)
    normalized_scores: {
        quality: Number,
        latency: Number,
        speed: Number
    },

    timestamp: { type: Date, default: Date.now }
});

BenchmarkResultSchema.index({ batch_id: 1 });
BenchmarkResultSchema.index({ model: 1 });
BenchmarkResultSchema.index({ timestamp: -1 });

module.exports = mongoose.model('BenchmarkResult', BenchmarkResultSchema);
