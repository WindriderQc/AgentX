/**
 * BenchmarkBatch Model
 * Batch test execution tracking with progress monitoring
 */

const mongoose = require('mongoose');

const BenchmarkBatchSchema = new mongoose.Schema({
    // Configuration
    run_name: {
        type: String,
        required: true
    },
    host: {
        type: String,
        required: true
    },
    models: {
        type: [String],
        required: true,
        validate: {
            validator: function(v) {
                return Array.isArray(v) && v.length > 0;
            },
            message: 'At least one model is required'
        }
    },
    levels: {
        type: [Number],
        required: true,
        validate: {
            validator: function(v) {
                return Array.isArray(v) && v.length > 0 && v.every(l => l >= 1 && l <= 5);
            },
            message: 'Levels must be between 1 and 5'
        }
    },
    quality_scoring: {
        type: Boolean,
        default: true
    },
    judge_config: {
        type: Object,
        default: {}
    },
    judge_same_host: {
        type: Boolean,
        default: false
    },

    // Execution Plan
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
    status: {
        type: String,
        enum: ['pending', 'running', 'judging', 'completed', 'failed', 'stopped', 'interrupted'],
        default: 'pending',
        index: true
    },
    total_tests: {
        type: Number,
        required: true,
        min: 0
    },
    completed: {
        type: Number,
        default: 0,
        min: 0
    },
    failed: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_total: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_completed: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_failed: {
        type: Number,
        default: 0,
        min: 0
    },

    // Result Summaries (for quick access)
    results: [{
        model: String,
        host: String,
        judge_host: String,
        prompt_name: String,
        success: Boolean,
        latency: Number,
        error: String,
        response_preview: String
    }],

    // Timestamps
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    },
    started_at: {
        type: Date,
        default: null
    },
    execution_started_at: {
        type: Date,
        default: null
    },
    generated_at: {
        type: Date,
        default: null
    },
    completed_at: {
        type: Date,
        default: null
    },

    // Execution metadata
    execution_pid: {
        type: Number,
        default: null
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes
BenchmarkBatchSchema.index({ status: 1, created_at: -1 });
BenchmarkBatchSchema.index({ execution_started_at: 1 });
BenchmarkBatchSchema.index({ 'models': 1 });

// Virtual for progress percentage
BenchmarkBatchSchema.virtual('progress').get(function() {
    if (this.total_tests === 0) return 0;
    return Math.min(Math.round((this.completed / this.total_tests) * 100), 100);
});

BenchmarkBatchSchema.virtual('judge_progress').get(function() {
    if (this.judge_total === 0) return 0;
    return Math.min(Math.round((this.judge_completed / this.judge_total) * 100), 100);
});

BenchmarkBatchSchema.virtual('success_rate').get(function() {
    if (this.completed === 0) return '0%';
    const rate = ((this.completed - this.failed) / this.completed) * 100;
    return rate.toFixed(1) + '%';
});

// Ensure virtuals are included in JSON
BenchmarkBatchSchema.set('toJSON', { virtuals: true });
BenchmarkBatchSchema.set('toObject', { virtuals: true });

// Static helper methods
BenchmarkBatchSchema.statics.getRecent = function(limit = 20) {
    return this.find()
        .sort({ created_at: -1 })
        .limit(limit);
};

BenchmarkBatchSchema.statics.getActive = function() {
    return this.find({ status: { $in: ['running', 'judging'] } })
        .sort({ created_at: -1 });
};

BenchmarkBatchSchema.statics.getCompleted = function(limit = 20) {
    return this.find({ status: 'completed' })
        .sort({ completed_at: -1 })
        .limit(limit);
};

BenchmarkBatchSchema.statics.cleanupStale = async function() {
    const result = await this.updateMany(
        { status: { $in: ['running', 'judging'] } },
        {
            $set: {
                status: 'interrupted',
                completed_at: new Date()
            }
        }
    );
    return result.modifiedCount;
};

// Instance methods for state transitions
BenchmarkBatchSchema.methods.markAsRunning = function() {
    this.status = 'running';
    if (!this.started_at) {
        this.started_at = new Date();
    }
    return this.save();
};

BenchmarkBatchSchema.methods.markAsJudging = function() {
    this.status = 'judging';
    if (!this.generated_at) {
        this.generated_at = new Date();
    }
    return this.save();
};

BenchmarkBatchSchema.methods.markAsCompleted = function() {
    this.status = 'completed';
    this.completed_at = new Date();
    return this.save();
};

BenchmarkBatchSchema.methods.markAsFailed = function(error) {
    this.status = 'failed';
    this.completed_at = new Date();
    if (error && this.results) {
        this.results.push({
            error: error.message || error.toString(),
            success: false
        });
    }
    return this.save();
};

BenchmarkBatchSchema.methods.markAsStopped = function() {
    this.status = 'stopped';
    this.completed_at = new Date();
    return this.save();
};

BenchmarkBatchSchema.methods.incrementProgress = function(success = true) {
    this.completed += 1;
    if (!success) {
        this.failed += 1;
    }
    return this.save();
};

BenchmarkBatchSchema.methods.incrementJudgeProgress = function(success = true) {
    this.judge_completed += 1;
    if (!success) {
        this.judge_failed += 1;
    }
    return this.save();
};

BenchmarkBatchSchema.methods.addResult = function(resultSummary) {
    this.results.push(resultSummary);
    return this.save();
};

BenchmarkBatchSchema.methods.lockForExecution = function(pid) {
    this.execution_started_at = new Date();
    this.execution_pid = pid;
    return this.save();
};

module.exports = mongoose.model('BenchmarkBatch', BenchmarkBatchSchema);
