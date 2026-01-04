const mongoose = require('mongoose');

const BenchmarkBatchSchema = new mongoose.Schema({
    run_name: { type: String, default: () => `Batch ${new Date().toLocaleString()}` },
    status: {
        type: String,
        enum: ['running', 'judging', 'completed', 'stopped', 'failed', 'interrupted'],
        default: 'running'
    },

    // Configuration
    host: { type: String, required: true },
    models: [{ type: String }],
    levels: [{ type: Number }],
    quality_scoring: { type: Boolean, default: true },
    judge_config: {
        model: String,
        temperature: Number,
        timeout: Number,
        concurrency: Number,
        judge_same_host: Boolean
    },

    // Execution Plan (Snapshot for UI)
    plan: {
        exec_hosts: [{
            exec_host: String,
            judge_host: String,
            models: [String],
            tests: Number
        }],
        judge_model: String,
        judge_same_host: Boolean,
        total_models: Number,
        total_prompts: Number,
        categories: [{
            category: String,
            prompt_count: Number,
            tests: Number
        }]
    },

    // Progress Tracking
    total_tests: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },

    // Judge Progress
    judge_total: { type: Number, default: 0 },
    judge_completed: { type: Number, default: 0 },
    judge_failed: { type: Number, default: 0 },

    // Duplicate protection
    execution_started_at: Date,
    execution_pid: Number,

    results: [{
        model: String,
        host: String,
        judge_host: String,
        prompt_name: String,
        success: Boolean,
        latency: Number,
        response_preview: String,
        error: String
    }],

    created_at: { type: Date, default: Date.now },
    started_at: { type: Date, default: Date.now },
    generated_at: Date, // When all generations finished
    completed_at: Date
});

BenchmarkBatchSchema.index({ status: 1 });
BenchmarkBatchSchema.index({ created_at: -1 });

module.exports = mongoose.model('BenchmarkBatch', BenchmarkBatchSchema);
