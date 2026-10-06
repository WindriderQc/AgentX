'use strict';

/**
 * Pure helpers shared by the benchmark authority reconciliation modules:
 * kind-to-resource mapping, invalidation projections and CAS checks.
 * Moved out of benchmarkAuthorityReconciliation.js, which re-exports the public API.
 */

const mongoose = require('mongoose');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const JudgeAccuracyMatrix = require('../../../models/JudgeAccuracyMatrix');
const JudgeGovernanceRun = require('../../../models/JudgeGovernanceRun');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const HostPerformanceSnapshot = require('../../../models/HostPerformanceSnapshot');
const HostProfile = require('../../../models/HostProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');

function objectId(value) {
  const text = String(value || '');
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : value;
}

function resourceTypeForKind(kind) {
  return {
    workload_invalidation: 'BenchmarkWorkload',
    result_invalidation: 'BenchmarkResult',
    batch_invalidation: 'BenchmarkBatch',
    judge_matrix_invalidation: 'JudgeAccuracyMatrix',
    judge_governance_invalidation: 'JudgeGovernanceRun',
    ground_truth_invalidation: 'JudgeGroundTruth',
    profiler_evidence_write: 'ModelPerformanceProfile',
    profiler_baseline_write: 'HostProfileBaseline',
    profiler_snapshot_write: 'HostPerformanceSnapshot',
    profiler_context_write: 'ModelContextProfile'
  }[kind] || null;
}

function authorityInvalidationFields(record) {
  const reason = `Authority was lost during ${record.phase}; durable reconciliation invalidated this projection`;
  if (record.kind === 'result_invalidation') {
    return {
      excluded_from_leaderboard: true,
      needs_review: true,
      scoring_method: 'authority_invalidated',
      quality_score: null,
      composite_score: null,
      review_reason: reason,
      authority_state: 'authority_invalidated',
      authority_reconciliation_reason: reason
    };
  }
  if (record.kind === 'judge_governance_invalidation') {
    return { status: 'failed', authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
  }
  if (record.kind === 'ground_truth_invalidation') {
    return { active: false, authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
  }
  if (record.kind === 'workload_invalidation') {
    return {
      status: 'failed',
      authority_state: 'authority_invalidated',
      authority_reconciliation_reason: reason,
      failure_reason: 'workload_authority_reconciled_after_owner_loss',
      completed_at: new Date(),
      last_activity_at: new Date()
    };
  }
  return { authority_state: 'authority_invalidated', authority_reconciliation_reason: reason };
}

// A batch its own code already invalidated keeps the diagnosis it recorded
// (execution_crash, a lost lock acknowledgement); reconciliation gives a reason
// only to a batch without one. A pipeline makes the choice and the write one
// atomic step, upsert included.
function batchInvalidationUpdate(record) {
  const { authority_reconciliation_reason: reason, ...fields } = authorityInvalidationFields(record);
  const literals = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { $literal: value }]));
  return [{ $set: {
    ...literals,
    authority_reconciliation_reason: { $cond: [
      { $eq: ['$authority_state', 'authority_invalidated'] },
      { $ifNull: ['$authority_reconciliation_reason', { $literal: reason }] },
      { $literal: reason }
    ] },
    __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] }
  } }];
}

function resourceModel(record) {
  return {
    workload_invalidation: BenchmarkBatch,
    result_invalidation: BenchmarkResult,
    batch_invalidation: BenchmarkBatch,
    judge_matrix_invalidation: JudgeAccuracyMatrix,
    judge_governance_invalidation: JudgeGovernanceRun,
    ground_truth_invalidation: JudgeGroundTruth,
    profiler_evidence_write: ModelPerformanceProfile,
    profiler_baseline_write: HostProfile,
    profiler_snapshot_write: HostPerformanceSnapshot,
    profiler_context_write: ModelContextProfile
  }[record.kind] || null;
}

function isProfilerAuthorityKind(kind) {
  return new Set([
    'profiler_evidence_write',
    'profiler_baseline_write',
    'profiler_snapshot_write',
    'profiler_context_write'
  ]).has(kind);
}

function matchedExactlyOne(result) {
  const matched = Number(result?.matchedCount ?? result?.modifiedCount);
  return !Number.isFinite(matched) || matched === 1;
}

module.exports = {
  objectId,
  resourceTypeForKind,
  authorityInvalidationFields,
  batchInvalidationUpdate,
  resourceModel,
  isProfilerAuthorityKind,
  matchedExactlyOne
};
