/**
 * BenchmarkResult Model
 * Individual benchmark test results with quality scoring
 */

const mongoose = require('mongoose');
const { promptSnapshotFields } = require('./fields/promptSnapshotFields');
const { scoreProvenanceFields } = require('./fields/scoreProvenanceFields');

const BenchmarkResultSchema = new mongoose.Schema({
    batch_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'BenchmarkBatch',
        required: false,
        default: null,
        index: true
    },

    model: {
        type: String,
        required: true,
        index: true
    },
    model_digest: {
        type: String,
        default: null,
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
    // Additive provider-neutral execution evidence. Legacy rows intentionally
    // leave these fields null; readers may project them as local Ollama but
    // must not invent a comparable cloud contract fingerprint.
    execution_target: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    judge_execution_contract: { type: mongoose.Schema.Types.Mixed, default: null },
    judge_qualification_contract: { type: mongoose.Schema.Types.Mixed, default: null },
    judge_target: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    execution_receipt: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    judge_receipt: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    provider_usage: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    provider_cost: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    failure_classification: {
        type: String,
        default: null,
        index: true
    },
    judge_provider_usage: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    judge_provider_cost: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    quality_cohort_fingerprint: {
        type: String,
        default: null,
        index: true
    },
    prompt: {
        type: String,
        required: true
    },
    ...promptSnapshotFields,
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
    time_to_first_token_ms: {
        type: Number,
        default: null
    },
    ttft_measurement: {
        type: String,
        enum: ['streamed_wall_clock', null],
        default: null
    },
    prompt_eval_duration_ms: {
        type: Number,
        default: null
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
        enum: ['infra', 'model', 'unknown', null],
        default: null,
        index: true
    },
    error_http_status: {
        type: Number,
        default: null
    },
    ...scoreProvenanceFields,
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
        hidden_response_cap: { type: Boolean, default: false, index: true },
        visible_response_budget: { type: Boolean, default: false },
        truncation_invalidates_score: { type: Boolean, default: false, index: true },
        // Silent input truncation: Ollama drops prompt tokens when num_ctx is
        // too small without raising an error. We compare prompt_eval_count
        // against the available input budget (num_ctx - num_predict) and flag
        // when usage exhausts the budget. The judge cannot detect this on its
        // own — a confident-wrong answer to a truncated prompt scores high.
        input_truncated: { type: Boolean, default: false, index: true },
        prompt_eval_count: { type: Number, default: null },
        input_budget: { type: Number, default: null },
        thinking_present: { type: Boolean, default: false },
        thinking_chars: { type: Number, default: null },
        visible_response_chars: { type: Number, default: null },
        thinking_only_response: { type: Boolean, default: false, index: true },
        thinking_budget_exhausted: { type: Boolean, default: false },
        // Historical flag: token-cap exhaustion alone no longer sets it.
        thinking_runaway: { type: Boolean, default: false, index: true },
        thinking_final_answer_policy: { type: String, default: null },
        input_to_judge_truncated: { type: Boolean, default: false },
        input_original_chars: { type: Number, default: null },
        input_sent_chars: { type: Number, default: null },
        judge_truncated: { type: Boolean, default: false },
        judge_tokens: { type: Number, default: null }
    },
    // Execution settings used for this test (for fairness audit + reproducibility)
    execution_settings: {
        sampling_profile: {
            type: String,
            enum: ['controlled', 'production'],
            default: 'controlled'
        },
        sampling_source: {
            type: String,
            enum: ['controlled_override', 'modelfile_default'],
            default: 'controlled_override'
        },
        num_predict: { type: Number, default: null },
        think: { type: Boolean, default: false },
        think_mode: { type: String, default: null },
        think_resolved_by: { type: String, default: null },
        thinking_profile_policy: { type: String, default: null },
        thinking_profile_host_id: { type: String, default: null },
        thinking_profile_model_name: { type: String, default: null },
        thinking_policy_reason: { type: String, default: null },
        thinking_final_answer_policy: { type: String, default: null },
        thinking_final_answer_text: { type: String, default: null },
        hint_applied: { type: Boolean, default: false },
        hint_text: { type: String, default: null },
        num_ctx: { type: Number, default: null },
        num_ctx_source: { type: String, default: null }, // 'force_override' | 'profile_resolver'
        answer_contract_applied: { type: Boolean, default: false },
        answer_contract_mode: { type: String, default: null },
        answer_contract_target_tokens: { type: Number, default: null },
        answer_contract_max_tokens: { type: Number, default: null },
        answer_contract_text: { type: String, default: null },
        temperature: { type: Number, default: null },
        top_p: { type: Number, default: null },
        top_k: { type: Number, default: null },
        repeat_penalty: { type: Number, default: null },
        seed: { type: Number, default: null },
        rankable_mode: { type: Boolean, default: false },
        inference_contract_fingerprint: { type: String, default: null, index: true },
        inference_contract_request_fingerprint: { type: String, default: null },
        artifact_digest: { type: String, default: null }
    },
    // Benchmark-owned calibrated performance baseline for this model/host pair.
    // Raw execution latency/tps are still stored separately on the result.
    performance_baseline: {
        status: { type: String, default: null },
        source: { type: String, default: 'benchmark_host_test' },
        tokensPerSec: { type: Number, default: null },
        promptEvalTokensPerSec: { type: Number, default: null },
        latencyMs: { type: Number, default: null },
        timeToFirstTokenMs: { type: Number, default: null },
        ttftMeasurement: { type: String, enum: ['streamed_wall_clock'], default: undefined },
        vramUsedMiB: { type: Number, default: null },
        vramTotalMiB: { type: Number, default: null },
        numCtx: { type: Number, default: null },
        numCtxSource: { type: String, default: null },
        testedAt: { type: Date, default: null },
        error: { type: String, default: null }
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
    // Multi-judge scores: when multiple judges evaluate the same result,
    // each judge's score is stored here. Final quality_score = median.
    judge_scores: [{
        judge_model: String,
        judge_host: String,
        execution_contract: { type: mongoose.Schema.Types.Mixed, default: null },
        qualification_contract: { type: mongoose.Schema.Types.Mixed, default: null },
        quality_score: Number,
        explanation: String,
        scoring_time_ms: Number,
        timestamp: { type: Date, default: Date.now }
    }],
    judge_consensus: {
        type: String,
        enum: ['agreement', 'single_judge', 'tiebreaker_resolved', 'divergent_unresolved', 'no_valid_scores', null],
        default: null
    },
    judge_divergence: {
        type: Number,
        min: 0,
        max: 10,
        default: null
    },
    judge_tiebreaker_used: {
        type: Boolean,
        default: false
    },
    judge_escalated: {
        type: Boolean,
        default: false
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
    // When the courthouse overrides a judged result, quality_score is replaced
    // with human_score so leaderboards (Generalist, Efficiency Map, Dashboard)
    // pick up the override automatically. The original judge score is preserved
    // here for drift detection (judgeFeedbackLoop) and for showing both numbers
    // side-by-side in the courthouse UI. Null on un-overridden results.
    judge_quality_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'Original judge quality_score, preserved when a human override replaces quality_score.'
    },
    human_review_status: {
        type: String,
        enum: ['approved', 'overridden', 'rejected', null],
        default: null,
        description: 'Outcome of manual courthouse review'
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
    human_notes: {
        type: String,
        default: null,
        description: 'Why the human disagrees with judge score (too harsh, too lenient, wrong criteria, etc.)'
    },
    excluded_from_leaderboard: {
        type: Boolean,
        default: false,
        index: true,
        description: 'Set when a human rejects a row so leaderboard math excludes it'
    },
    // Repeat-run grouping. When execution_config.repeats > 1, each (model, host,
    // prompt) tuple is run multiple times. All repeats of one tuple share a
    // repeat_group_id; repeat_index 0..N-1 distinguishes them. Variance across
    // a group = stability metric (with seed pinned, low variance = consistent
    // model+host; high variance with seed pinned = model ignores seed).
    repeat_group_id: {
        type: String,
        default: null,
        index: true
    },
    repeat_index: {
        type: Number,
        default: 0,
        min: 0
    },
    repeat_total: {
        type: Number,
        default: 1,
        min: 1
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    // `timestamp` is declared above with its own server default, so the
    // timestamps plugin only maintains updated_at.
    timestamps: { createdAt: false, updatedAt: 'updated_at' }
});

// Compound indexes for analytics queries
BenchmarkResultSchema.index({ model: 1, success: 1 });
BenchmarkResultSchema.index({ model: 1, prompt_level: 1 });
BenchmarkResultSchema.index({ model: 1, prompt_category: 1 });
BenchmarkResultSchema.index({ batch_id: 1, timestamp: -1 });
BenchmarkResultSchema.index({ 'execution_target.id': 1, quality_cohort_fingerprint: 1, success: 1 }, { sparse: true });
BenchmarkResultSchema.index({ 'execution_target.tier': 1, quality_cohort_fingerprint: 1, success: 1 }, { sparse: true });
BenchmarkResultSchema.index({ quality_score: 1 });
BenchmarkResultSchema.index({ composite_score: 1 });
BenchmarkResultSchema.index(
    { success: 1, infra_error: 1, excluded_from_leaderboard: 1, composite_score: 1, host: 1, prompt_level: 1, batch_id: 1, model: 1, prompt_category: 1 },
    { name: 'leaderboard_composite_filter_idx' }
);
BenchmarkResultSchema.index(
    { success: 1, infra_error: 1, excluded_from_leaderboard: 1, quality_score: 1, host: 1, prompt_level: 1, batch_id: 1, model: 1, prompt_category: 1 },
    { name: 'leaderboard_quality_filter_idx' }
);
BenchmarkResultSchema.index(
    { success: 1, infra_error: 1, excluded_from_leaderboard: 1, deterministic_score: 1, host: 1, prompt_level: 1, batch_id: 1, model: 1, prompt_category: 1 },
    { name: 'leaderboard_deterministic_filter_idx' }
);
BenchmarkResultSchema.index(
    { success: 1, infra_error: 1, excluded_from_leaderboard: 1, subjective_score: 1, host: 1, prompt_level: 1, batch_id: 1, model: 1, prompt_category: 1 },
    { name: 'leaderboard_subjective_filter_idx' }
);
// Capability qualification lookups: sparse — only tagged rows index.
BenchmarkResultSchema.index(
    { 'qualification.tier': 1, model: 1, 'qualification.host': 1, success: 1 },
    { name: 'qualification_tier_idx', sparse: true }
);

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
    const hasRankableQuality = {
        $and: [
            { $ne: ['$infra_error', true] },
            { $ne: ['$needs_review', true] },
            { $ne: ['$excluded_from_leaderboard', true] },
            { $ne: [{ $ifNull: ['$quality_score', null] }, null] }
        ]
    };
    const agg = await this.aggregate([
        { $match: { model, success: true } },
        {
            $group: {
                _id: null,
                tests: { $sum: 1 },
                avg_latency: { $avg: '$latency' },
                min_latency: { $min: '$latency' },
                max_latency: { $max: '$latency' },
                avg_tokens_per_sec: { $avg: '$tokens_per_sec' },
                avg_quality: {
                    $avg: {
                        $cond: [
                            hasRankableQuality,
                            '$quality_score',
                            null
                        ]
                    }
                },
                quality_tests: {
                    $sum: {
                        $cond: [
                            hasRankableQuality,
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
        infra_error: { $ne: true },
        needs_review: { $ne: true },
        excluded_from_leaderboard: { $ne: true },
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

/**
 * Per-repeat-group variance: aggregate latency/tokens_per_sec/quality_score
 * across all repeats of one (model, host, prompt). With seed pinned, low
 * variance = stable model+host pair; high variance with seed pinned = the
 * model ignores the seed (some quants do).
 */
BenchmarkResultSchema.statics.getRepeatVariance = async function(filter = {}) {
    return this.aggregate([
        { $match: { ...filter, repeat_group_id: { $ne: null }, success: true } },
        {
            $group: {
                _id: '$repeat_group_id',
                model: { $first: '$model' },
                host: { $first: '$host' },
                prompt_name: { $first: '$prompt_name' },
                runs: { $sum: 1 },
                latency_avg: { $avg: '$latency' },
                latency_stddev: { $stdDevPop: '$latency' },
                tps_avg: { $avg: '$tokens_per_sec' },
                tps_stddev: { $stdDevPop: '$tokens_per_sec' },
                quality_avg: { $avg: '$quality_score' },
                quality_stddev: { $stdDevPop: '$quality_score' },
                quality_min: { $min: '$quality_score' },
                quality_max: { $max: '$quality_score' }
            }
        },
        { $match: { runs: { $gt: 1 } } },
        { $sort: { quality_stddev: -1, latency_stddev: -1 } }
    ]);
};

// Instance methods
BenchmarkResultSchema.methods.updateQualityScore = function(scoreData) {
    this.scorer_version = scoreData.scorer_version || this.scorer_version;
    this.quality_score = scoreData.quality_score;
    this.quality_breakdown = scoreData.breakdown;
    this.quality_explanation = scoreData.explanation;
    this.judge_prompt = scoreData.judge_prompt;
    this.judge_model = scoreData.judge_model;
    this.scoring_method = scoreData.scoring_method;
    this.scoring_type = scoreData.scoring_type;
    this.scoring_time_ms = scoreData.scoring_time_ms;
    this.quick_pattern = scoreData.quick_pattern;
    if (scoreData.execution_result !== undefined) this.execution_result = scoreData.execution_result;
    if (scoreData.code_extraction !== undefined) this.code_extraction = scoreData.code_extraction;
    if (scoreData.correctness_source !== undefined) this.correctness_source = scoreData.correctness_source;
    // Support thinking field update
    if (scoreData.thinking !== undefined) {
        this.thinking = scoreData.thinking;
    }
    return this.save();
};

const BenchmarkResult = mongoose.models.BenchmarkResult
    || mongoose.model('BenchmarkResult', BenchmarkResultSchema);

module.exports = BenchmarkResult;
