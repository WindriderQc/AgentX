/**
 * BenchmarkBatch Model
 * Batch test execution tracking with progress monitoring
 */

const mongoose = require('mongoose');

function buildIdleCurrentTest() {
    return {
        model: null,
        prompt_id: null,
        prompt_name: null,
        prompt_level: null,
        stage: 'idle',
        started_at: null,
        test_number: null
    };
}

function buildJudgeableFilter(batchId) {
    return {
        batch_id: String(batchId),
        success: true,
        response: { $type: 'string', $nin: ['', null] }
    };
}

function deriveTerminalJudgeStatus(batch, counts, terminalStatus) {
    if (counts.judge_total > 0 && counts.judge_completed >= counts.judge_total) {
        return 'completed';
    }

    if (terminalStatus === 'stopped') {
        if (batch.judge_status === 'running' || batch.status === 'judging' || counts.judge_completed > 0) {
            return counts.judge_total > 0 ? 'stopped' : 'none';
        }
        return batch.judge_status === 'completed' ? 'completed' : 'none';
    }

    if (terminalStatus === 'interrupted') {
        if (batch.judge_status === 'running' || batch.status === 'judging' || counts.judge_total > 0 || counts.judge_completed > 0) {
            return 'failed';
        }
        return batch.judge_status === 'completed' ? 'completed' : 'none';
    }

    return batch.judge_status || 'none';
}

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
                return Array.isArray(v) && v.length > 0 && v.every(l => l >= 1 && l <= 10);
            },
            message: 'Levels must be between 1 and 10' // Enhanced judging system: expanded from 5 to 10 levels
        }
    },
    judge_config: {
        type: Object,
        default: {}
    },
    execution_config: {
        type: Object,
        default: {}
    },
    judge_same_host: {
        type: Boolean,
        default: false
    },
    execution_mode: {
        type: String,
        enum: ['latency', 'throughput'],
        default: 'latency'
    },
    depth_config: {
        type: Object,
        default: null
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
        execution_config: {
            type: Object,
            default: {}
        },
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
    // Singleton slot used to enforce one active benchmark batch at a time.
    // Combined with a partial unique index on active statuses to close race windows.
    active_slot: {
        type: String,
        default: null
    },
    judge_status: {
        type: String,
        enum: ['none', 'pending', 'running', 'completed', 'failed', 'stopped'],
        default: 'none',
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
    },
    last_activity_at: {
        type: Date,
        default: null,
        index: true
    },

    // Current test being executed (for real-time visibility)
    current_test: {
        model: { type: String, default: null },
        prompt_id: { type: String, default: null },
        prompt_name: { type: String, default: null },
        prompt_level: { type: Number, default: null },
        stage: { type: String, enum: ['executing', 'judging', 'idle', 'warmup'], default: 'idle' },
        started_at: { type: Date, default: null },
        test_number: { type: Number, default: null }  // Which test # out of total
    },

	    // Execution timeline (for detailed progress tracking)
	    timeline: [{
	        timestamp: { type: Date, default: Date.now },
	        event: { type: String, required: true },  // 'test_start', 'test_complete', 'judge_start', 'judge_complete', 'error'
	        model: String,
	        host: { type: String, default: null },
	        prompt_id: String,
	        prompt_level: Number,
	        duration_ms: Number,
	        tokens_per_sec: { type: mongoose.Schema.Types.Mixed, default: null },
	        success: Boolean,
	        error: String
	    }],

    // Detailed execution metrics
    execution_metrics: {
        total_duration_ms: { type: Number, default: null },
        generation_duration_ms: { type: Number, default: null },
        judging_duration_ms: { type: Number, default: null },
        avg_test_duration_ms: { type: Number, default: null },
        avg_judge_duration_ms: { type: Number, default: null },
        tests_per_minute: { type: Number, default: null },
        peak_memory_mb: { type: Number, default: null },
        total_tokens_generated: { type: Number, default: 0 },
        total_tokens_per_sec_avg: { type: Number, default: null }
    },

    // Per-model wall-clock timing (how long each model took to run all prompts)
    model_timings: {
        type: [{
            model: { type: String, required: true },
            started_at: { type: Date, default: null },
            completed_at: { type: Date, default: null },
            duration_ms: { type: Number, default: null }
        }],
        default: []
    },

    // Configuration snapshot (for reproducibility)
    config_snapshot: {
        ollama_version: String,
        agentx_version: String,
        node_version: String,
        os_platform: String,
        cpu_count: Number
    },

    // Tags for categorization
    tags: {
        type: [String],
        default: [],
        index: true
    },

    // Notes/description
    description: {
        type: String,
        default: ''
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes
BenchmarkBatchSchema.index({ status: 1, created_at: -1 });
BenchmarkBatchSchema.index({ execution_started_at: 1 });
BenchmarkBatchSchema.index({ 'models': 1 });
BenchmarkBatchSchema.index(
    { active_slot: 1 },
    {
        unique: true,
        partialFilterExpression: {
            active_slot: { $type: 'string' },
            $or: [
                { status: { $in: ['running', 'judging'] } },
                { judge_status: 'running' }
            ]
        }
    }
);

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
    return this.find({
        $or: [
            { status: { $in: ['running', 'judging'] } },
            { judge_status: 'running' }
        ]
    }).sort({ created_at: -1 });
};

BenchmarkBatchSchema.statics.getCompleted = function(limit = 20) {
    return this.find({ status: 'completed' })
        .sort({ completed_at: -1 })
        .limit(limit);
};

BenchmarkBatchSchema.statics.getAuthoritativeCounts = async function(batchId) {
    const BenchmarkResult = require('./BenchmarkResult');
    const judgeableFilter = buildJudgeableFilter(batchId);

    const [completed, failed, judge_total, judge_completed, judge_failed] = await Promise.all([
        BenchmarkResult.countDocuments({ batch_id: String(batchId) }),
        BenchmarkResult.countDocuments({ batch_id: String(batchId), success: false }),
        BenchmarkResult.countDocuments(judgeableFilter),
        BenchmarkResult.countDocuments({
            ...judgeableFilter,
            scoring_method: { $ne: 'pending' }
        }),
        BenchmarkResult.countDocuments({
            ...judgeableFilter,
            scoring_method: 'llm_failed'
        })
    ]);

    return {
        completed,
        failed,
        judge_total,
        judge_completed,
        judge_failed
    };
};

BenchmarkBatchSchema.statics.cleanupStale = async function(inactivityThresholdSeconds = 300) {
    // Only mark batches as stale if they've been inactive for the threshold period
    // This prevents killing active batches on server restart/reload
    const threshold = new Date(Date.now() - (inactivityThresholdSeconds * 1000));

    // Find stale batches first so we can fix them properly
    const staleBatches = await this.find({
        status: { $in: ['running', 'judging'] },
        $or: [
            { last_activity_at: { $lt: threshold } },
            { last_activity_at: null }
        ]
    });

    let fixedCount = 0;

    for (const batch of staleBatches) {
        try {
            const counts = await this.getAuthoritativeCounts(batch._id);
            const allTestsFinished = Number(batch.total_tests || 0) > 0
                && counts.completed >= Number(batch.total_tests || 0);
            const judgingFinished = counts.judge_total === 0 || counts.judge_completed >= counts.judge_total;
            const reconciledStatus = allTestsFinished && judgingFinished
                ? 'completed'
                : 'interrupted';

            await batch.reconcileFromResults({
                status: reconciledStatus,
                judgeStatus: deriveTerminalJudgeStatus(batch, counts, reconciledStatus),
                authoritativeCounts: counts,
                timelineEvent: 'stale_cleanup',
                timelineError: 'Batch reconciled after inactivity threshold was exceeded'
            });
            fixedCount++;
        } catch (err) {
            console.error('Failed to cleanup batch', batch._id, err.message);
        }
    }

    return fixedCount;
};

BenchmarkBatchSchema.statics.findStuck = async function(inactivityThresholdSeconds = 300) {
    const threshold = new Date(Date.now() - (inactivityThresholdSeconds * 1000));
    return this.find({
        $and: [
            {
                $or: [
                    { status: { $in: ['running', 'judging'] } },
                    { judge_status: 'running' }
                ]
            },
            {
                $or: [
                    { last_activity_at: { $lt: threshold } },
                    { last_activity_at: null }
                ]
            }
        ]
    }).sort({ last_activity_at: 1 });
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
    this.active_slot = null;
    return this.save();
};

BenchmarkBatchSchema.methods.markAsFailed = function(error) {
    this.status = 'failed';
    this.completed_at = new Date();
    this.active_slot = null;
    if (error && this.results) {
        this.results.push({
            error: error.message || error.toString(),
            success: false
        });
    }
    return this.save();
};

BenchmarkBatchSchema.methods.reconcileFromResults = async function(options = {}) {
    const BatchModel = mongoose.model('BenchmarkBatch');
    const terminalStatus = options.status || this.status || 'stopped';
    const counts = options.authoritativeCounts || await BatchModel.getAuthoritativeCounts(this._id);
    const priorState = {
        status: this.status,
        judge_status: this.judge_status
    };

    this.status = terminalStatus;
    this.completed = counts.completed;
    this.failed = counts.failed;
    this.judge_total = counts.judge_total;
    this.judge_completed = counts.judge_completed;
    this.judge_failed = counts.judge_failed;
    this.judge_status = options.judgeStatus || deriveTerminalJudgeStatus(priorState, counts, terminalStatus);
    this.completed_at = new Date();
    this.last_activity_at = new Date();
    this.current_test = buildIdleCurrentTest();
    this.active_slot = null;

    if (options.timelineEvent) {
        this.timeline.push({
            timestamp: new Date(),
            event: options.timelineEvent,
            success: terminalStatus === 'completed',
            error: options.timelineError || null
        });
        if (this.timeline.length > 2500) {
            this.timeline = this.timeline.slice(-2500);
        }
    }

    return this.save();
};

BenchmarkBatchSchema.methods.markAsStopped = function(options = {}) {
    return this.reconcileFromResults({
        ...options,
        status: 'stopped',
        timelineEvent: options.timelineEvent || 'stop_requested',
        timelineError: options.timelineError || null
    });
};

BenchmarkBatchSchema.methods.markAsInterrupted = function(options = {}) {
    return this.reconcileFromResults({
        ...options,
        status: 'interrupted',
        timelineEvent: options.timelineEvent || 'interrupted',
        timelineError: options.timelineError || null
    });
};

BenchmarkBatchSchema.methods.markJudgingComplete = function() {
    this.judge_status = 'completed';
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
    this.last_activity_at = new Date();
    return this.save();
};

BenchmarkBatchSchema.methods.updateCurrentTest = function(model, promptId, promptName, stage = 'executing', options = {}) {
    const testNumber = options.testNumber || this.completed + 1;
    const promptLevel = options.promptLevel || null;

    // Use direct MongoDB update to avoid loading entire document into memory
    return mongoose.model('BenchmarkBatch').updateOne(
        { _id: this._id },
        {
            $set: {
                current_test: {
                    model,
                    prompt_id: promptId,
                    prompt_name: promptName,
                    prompt_level: promptLevel,
                    stage,
                    started_at: new Date(),
                    test_number: testNumber
                },
                last_activity_at: new Date()
            },
            $push: {
                timeline: {
                    $each: [{
                        timestamp: new Date(),
                        event: stage === 'executing' ? 'test_start' : 'judge_start',
                        model,
                        prompt_id: promptId,
                        prompt_level: promptLevel,
                        success: null
                    }],
                    $slice: -2500  // Keep only last 2500 timeline events to cap memory
                }
            }
        }
    );
};

BenchmarkBatchSchema.methods.recordTestComplete = function(model, promptId, durationMs, success = true, error = null, promptLevel = null, host = null, tokensPerSec = null) {
    // Use direct MongoDB $push with $slice to avoid loading entire timeline into memory
    // This is much more memory efficient than this.timeline.push() + this.save()
    return mongoose.model('BenchmarkBatch').updateOne(
        { _id: this._id },
        {
            $push: {
                timeline: {
                    $each: [{
                        timestamp: new Date(),
                        event: success ? 'test_complete' : 'error',
                        model,
                        host,
                        prompt_id: promptId,
                        prompt_level: promptLevel,
                        duration_ms: durationMs,
                        tokens_per_sec: tokensPerSec,
                        success,
                        error: error ? error.message || error.toString() : null
                    }],
                    $slice: -2500  // Keep only last 2500 timeline events to cap memory
                }
            },
            $set: { last_activity_at: new Date() }
        }
    );
};

BenchmarkBatchSchema.methods.recordJudgeComplete = function(model, promptId, durationMs, success = true, promptLevel = null) {
    // Use direct MongoDB $push with $slice to avoid loading entire timeline into memory
    return mongoose.model('BenchmarkBatch').updateOne(
        { _id: this._id },
        {
            $push: {
                timeline: {
                    $each: [{
                        timestamp: new Date(),
                        event: 'judge_complete',
                        model,
                        prompt_id: promptId,
                        prompt_level: promptLevel,
                        duration_ms: durationMs,
                        success
                    }],
                    $slice: -2500  // Keep only last 2500 timeline events to cap memory
                }
            },
            $set: { last_activity_at: new Date() }
        }
    );
};

BenchmarkBatchSchema.methods.clearCurrentTest = function() {
    this.current_test = buildIdleCurrentTest();
    return this.save();
};

BenchmarkBatchSchema.methods.heartbeat = function() {
    this.last_activity_at = new Date();
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

BenchmarkBatchSchema.methods.calculateMetrics = async function() {
    const BenchmarkResult = require('./BenchmarkResult');

    const results = await BenchmarkResult.find({ batch_id: this._id.toString() });

    if (results.length === 0) return this;

    // Calculate durations
    if (this.started_at && this.completed_at) {
        this.execution_metrics.total_duration_ms = this.completed_at - this.started_at;
    }

    if (this.started_at && this.generated_at) {
        this.execution_metrics.generation_duration_ms = this.generated_at - this.started_at;
    }

    if (this.generated_at && this.completed_at) {
        this.execution_metrics.judging_duration_ms = this.completed_at - this.generated_at;
    }

    // Calculate test statistics
    const latencies = results.filter(r => r.latency).map(r => r.latency);
    if (latencies.length > 0) {
        this.execution_metrics.avg_test_duration_ms = Math.round(
            latencies.reduce((a, b) => a + b, 0) / latencies.length
        );
    }

    // Calculate judge statistics
    const judgeTimes = results.filter(r => r.scoring_time_ms).map(r => r.scoring_time_ms);
    if (judgeTimes.length > 0) {
        this.execution_metrics.avg_judge_duration_ms = Math.round(
            judgeTimes.reduce((a, b) => a + b, 0) / judgeTimes.length
        );
    }

    // Calculate throughput
    if (this.execution_metrics.generation_duration_ms > 0) {
        this.execution_metrics.tests_per_minute = Math.round(
            (this.completed * 60000) / this.execution_metrics.generation_duration_ms
        );
    }

    // Calculate token statistics
    const tokens = results.filter(r => r.tokens).map(r => r.tokens);
    if (tokens.length > 0) {
        this.execution_metrics.total_tokens_generated = tokens.reduce((a, b) => a + b, 0);
    }

    const tokensPerSec = results
        .filter(r => r.tokens_per_sec && !isNaN(parseFloat(r.tokens_per_sec)))
        .map(r => parseFloat(r.tokens_per_sec));

    if (tokensPerSec.length > 0) {
        this.execution_metrics.total_tokens_per_sec_avg =
            (tokensPerSec.reduce((a, b) => a + b, 0) / tokensPerSec.length).toFixed(2);
    }

    return this.save();
};

BenchmarkBatchSchema.methods.captureSystemSnapshot = function() {
    const os = require('os');
    const packageJson = require('../package.json');

    this.config_snapshot = {
        agentx_version: packageJson.version || '1.3.2',
        node_version: process.version,
        os_platform: os.platform(),
        cpu_count: os.cpus().length
    };

    return this;
};

module.exports = mongoose.model('BenchmarkBatch', BenchmarkBatchSchema);
