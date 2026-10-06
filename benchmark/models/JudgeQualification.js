/**
 * JudgeQualification Model
 *
 * One record per completed `POST /judge/calibrate-accuracy` run. A record
 * qualifies exactly one judge identity: the judge model on one host, one
 * scorer version and one reference set (fingerprinted). Records are append
 * only; the newest record of an identity is the one readers use, so a later
 * failing run withdraws an earlier qualification.
 *
 * The per-case grades stay with the record so the causes of a failure remain
 * inspectable without re-running inference.
 */

const mongoose = require('mongoose');

const CaseSchema = new mongoose.Schema({
    id: { type: String, default: null },
    category: { type: String, default: null },
    tier: { type: String, default: null },
    gold_score: { type: Number, default: null },
    judge_score: { type: Number, default: null },
    abs_diff: { type: Number, default: null },
    scoring_method: { type: String, default: null },
    identity_case: { type: Boolean, default: null },
    identity_full_marks: { type: Boolean, default: null },
    attention_passed: { type: Boolean, default: null },
    error: { type: String, default: null }
}, { _id: false });

const JudgeQualificationSchema = new mongoose.Schema({
    judge_model: { type: String, required: true },
    judge_host: { type: String, required: true },
    // Normalized keys readers match on (host URL key, model without :latest).
    judge_model_key: { type: String, required: true },
    judge_host_key: { type: String, required: true },
    judge_digest: { type: String, default: null },
    scorer_version: { type: String, required: true },
    reference_source: { type: String, default: 'authored_calibration_set' },
    reference_fingerprint: { type: String, required: true },
    reference_count: { type: Number, default: 0 },
    requested_num_ctx: { type: Number, default: null },
    judge_config: { type: mongoose.Schema.Types.Mixed, default: null },
    qualified: { type: Boolean, required: true },
    failed: { type: [String], default: [] },
    criteria: { type: mongoose.Schema.Types.Mixed, default: null },
    metrics: { type: mongoose.Schema.Types.Mixed, default: null },
    cases: { type: [CaseSchema], default: [] },
    recorded_at: { type: Date, default: Date.now }
}, { timestamps: false });

JudgeQualificationSchema.index({ judge_host_key: 1, judge_model_key: 1, scorer_version: 1, recorded_at: -1 });
JudgeQualificationSchema.index({ recorded_at: -1 });

module.exports = mongoose.models.JudgeQualification
    || mongoose.model('JudgeQualification', JudgeQualificationSchema);
