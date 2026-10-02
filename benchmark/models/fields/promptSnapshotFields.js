'use strict';

/**
 * The prompt, snapshotted onto a result row.
 *
 * A result keeps its own copy of the prompt's scoring contract so a row stays
 * readable and re-scorable after the catalog moves on: the prompt it was
 * scored against is the one stored here, not whatever the library holds today.
 *
 * Extracted from `BenchmarkResult` as one cohesive group; the schema spreads
 * these definitions, so field names, defaults and indexes are unchanged.
 */

const mongoose = require('mongoose');
const { BENCHMARK_CATEGORY_KEYS } = require('../../config/categories');

const promptSnapshotFields = {
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
        enum: [...BENCHMARK_CATEGORY_KEYS, 'factual'],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    scoring_dimensions: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    deterministic_scoring: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    scoring_plan: {
        type: String,
        enum: ['deterministic', 'criteria', 'reference', 'decomposed', 'llm_judge', 'hybrid', 'auto', null],
        default: null
    },
    evaluation_authority: {
        type: String,
        enum: ['judge', 'deterministic', 'executable'],
        default: 'judge',
        index: true
    },
    executable_fixture_id: {
        type: String,
        default: null
    },
    output_contract: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    // Executable reference tests carried from the prompt. Mixed for the same
    // reason as output_contract: three harness shapes with different fields.
    // `src/services/scoring/referenceTests.js` is the authority on that shape.
    reference_tests: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    reference_answer: {
        type: String,
        default: null
    },
    // Structured criteria for deterministic judging (carried from prompt)
    judge_criteria: {
        type: [String],
        default: undefined
    },
    prompt_snapshot_embedded: {
        type: Boolean,
        default: false
    }
};

module.exports = { promptSnapshotFields };
