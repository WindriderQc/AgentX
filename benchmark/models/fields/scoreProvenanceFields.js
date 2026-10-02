'use strict';

/**
 * How a result row was scored: the quality score and its provenance, the
 * dual deterministic/judge signals, the scoring method and the evidence
 * behind them.
 *
 * Extracted from `BenchmarkResult` as one cohesive group; the schema spreads
 * these definitions, so field names, defaults and indexes are unchanged.
 */

const mongoose = require('mongoose');
const { BENCHMARK_CATEGORY_KEYS } = require('../../config/categories');

const scoreProvenanceFields = {
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
    // Set by qualityScorer when the reasoning/instruction format gate fires
    // (format_score below threshold for an instruction/creative prompt with
    // an output_contract). Side-effects (quality cap, confidence drop,
    // needs_review, review_reason) already persisted; this boolean didn't.
    format_gated: {
        type: Boolean,
        default: null,
        description: 'Whether the format gate fired on this result'
    },
    // Hybrid scoring sub-scores
    accuracy_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'Deterministic content accuracy score (0-10), hybrid scoring'
    },
    compliance_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: 'LLM compliance score (0-10), hybrid scoring'
    },
    // Quality scoring fields
    scorer_version: {
        type: String,
        default: null,
        index: true
    },
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
    // Decomposed-judge per-dimension binary question breakdown.
    // Populated only by the decomposed scoring path (see decomposedJudge.js).
    // Stored as a flexible object because shape varies by category's question bank.
    decomposed_breakdown: {
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
            'disabled', 'pending', 'skipped', 'empty_response', 'response_contract_failed',
            // New multi-strategy scoring methods
            'deterministic', 'deterministic_fallback', 'decomposed', 'reference', 'reference_quick', 'hybrid',
            'executable'
        ],
        default: 'disabled'
    },
    scoring_type: {
        type: String,
        enum: [...BENCHMARK_CATEGORY_KEYS, 'factual', 'custom', null],
        default: null
    },
    scoring_time_ms: {
        type: Number,
        default: null
    },
    deterministic_type: {
        type: String,
        default: null
    },
    matched_expected: {
        type: Boolean,
        default: null
    },
    deterministic_mismatch: {
        type: Boolean,
        default: null
    },
    deterministic_details: {
        type: String,
        default: null
    },
    judge_reported_overall: {
        type: Number,
        min: 0,
        max: 10,
        default: null
    },
    quick_pattern: {
        type: String,
        default: null
    },
    // Deterministic-first scoring. Independent signals so
    // operators can tell whether a score came from a regex/json/exact-match
    // check, the LLM judge, or a hybrid. quality_score remains the legacy
    // single-number aggregate; new fields below carry the decomposed view.
    deterministic_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: '0-10 score from a deterministic check (regex, json_exact_match, reference equality). Null when no deterministic check applied.'
    },
    deterministic_pass: {
        type: Boolean,
        default: null,
        description: 'Pass/fail when the deterministic check is binary. Null when the check produces a graded score (e.g. partial JSON match) or when no deterministic check applied.'
    },
    // Capability qualification tag. Optional + backward-compatible: unset on
    // every row that predates it and on non-qualification runs. Populated ONLY
    // from deterministic signals by capabilityGrader — the LLM judge is never an
    // input. `tier` is the highest contiguous C/K tier earned on `host`.
    qualification: {
        tier:   { type: String, enum: ['C0', 'C1', 'C2', 'C3', 'C4', 'K1', 'K2', 'K3', 'K4', null], default: null },
        passed: { type: Boolean, default: null },
        reason: { type: String,  default: null },
        host:   { type: String,  default: null }
    },
    subjective_score: {
        type: Number,
        min: 0,
        max: 10,
        default: null,
        description: '0-10 score from the LLM judge. Null when only deterministic scoring ran.'
    },
    composite_formula: {
        type: String,
        default: null,
        description: 'Short tag for which formula produced quality_score: "deterministic_only" | "judge_only" | "deterministic_gate_then_judge" | "50_50" | "legacy" (results scored before the deterministic split).'
    },
    // Executable correctness: what the code runner reported for a coding
    // response with reference tests, how the program was extracted from the
    // response, and which authority supplied the correctness dimension.
    execution_result: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    code_extraction: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    // Known-answer probe outcome of the judge on this answer (rubric 2.15+).
    // Null on deterministic rows and on rows judged before it was persisted.
    attention_check: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    correctness_source: {
        type: String,
        enum: ['judge', 'deterministic', 'executable', null],
        default: null,
        index: true
    }
};

module.exports = { scoreProvenanceFields };
