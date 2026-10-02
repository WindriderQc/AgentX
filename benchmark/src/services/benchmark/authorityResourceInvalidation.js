'use strict';

/**
 * Compensates projections whose authority was lost: invalidates workloads,
 * results and judge artefacts, and rolls back pending profiler writes.
 * Moved out of benchmarkAuthorityReconciliation.js.
 */

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const JudgeAccuracyMatrix = require('../../../models/JudgeAccuracyMatrix');
const JudgeGovernanceRun = require('../../../models/JudgeGovernanceRun');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const HostPerformanceSnapshot = require('../../../models/HostPerformanceSnapshot');
const HostProfile = require('../../../models/HostProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const ModelContextProbeSnapshot = require('../../../models/ModelContextProbeSnapshot');
const {
  objectId,
  authorityInvalidationFields,
  resourceModel,
  matchedExactlyOne
} = require('./authorityReconciliationShared');

async function invalidateResource(record, options = {}) {
  options.assertActive?.();
  if (record.kind === 'workload_invalidation') {
    const batchId = record.batchId || null;
    const fields = authorityInvalidationFields(record);
    const [batch, results, matrices, governance, groundTruth] = await Promise.all([
      batchId
        ? BenchmarkBatch.findOneAndUpdate(
          { _id: objectId(batchId) },
          { $set: fields, $inc: { __v: 1 } },
          { new: true, ...(options.signal ? { signal: options.signal } : {}) }
        ).lean()
        : null,
      batchId ? BenchmarkResult.updateMany(
        { $or: [{ batch_id: String(batchId) }, { batchId: String(batchId) }] },
        { $set: authorityInvalidationFields({ ...record, kind: 'result_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeAccuracyMatrix.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_matrix_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeGovernanceRun.updateMany(
        { batch_id: String(batchId) },
        { $set: authorityInvalidationFields({ ...record, kind: 'judge_governance_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null,
      batchId ? JudgeGroundTruth.updateMany(
        { tags: `batch:${String(batchId)}` },
        { $set: authorityInvalidationFields({ ...record, kind: 'ground_truth_invalidation' }), $inc: { __v: 1 } },
        options.signal ? { signal: options.signal } : undefined
      ) : null
    ]);
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: record.resultId,
      workloadId: record.workloadId,
      batchId,
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(batch?.__v)) ? Number(batch.__v) : null,
      affected: {
        batch: batch ? 1 : 0,
        results: Number(results?.modifiedCount || 0),
        matrices: Number(matrices?.modifiedCount || 0),
        governance: Number(governance?.modifiedCount || 0),
        groundTruth: Number(groundTruth?.modifiedCount || 0)
      },
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_evidence_write') {
    const details = record.details || {};
    let invalidated = await ModelPerformanceProfile.findOneAndUpdate(
      {
        modelName: details.modelName,
        hostId: details.hostId,
        authorityWriteId: details.authorityWriteId
      },
      {
        $set: {
          active: false,
          stale: true,
          staleReason: 'profiler_authority_write_reconciled',
          authorityState: 'authority_invalidated',
          authorityReconciliationId: String(record._id)
        }
      },
      { new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    const priorEvidence = details.priorEvidence || null;
    if (!invalidated && !priorEvidence) {
      invalidated = await ModelPerformanceProfile.findOneAndUpdate(
        {
          modelName: details.modelName,
          hostId: details.hostId,
          authorityWriteId: details.authorityWriteId
        },
        {
          $setOnInsert: {
            artifact: details.artifact,
            profile: details.profile
          },
          $set: {
            active: false,
            stale: true,
            staleReason: 'profiler_authority_write_reconciled',
            authorityState: 'authority_invalidated',
            authorityReconciliationId: String(record._id)
          }
        },
        { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
      ).lean();
    }
    if (invalidated && priorEvidence?._id
      && String(priorEvidence._id) === String(invalidated._id)) {
      const restored = await ModelPerformanceProfile.findOneAndUpdate(
        {
          _id: priorEvidence._id,
          authorityWriteId: details.authorityWriteId,
          authorityState: 'authority_invalidated'
        },
        { $set: {
          modelName: priorEvidence.modelName,
          hostId: priorEvidence.hostId,
          artifact: priorEvidence.artifact,
          profile: priorEvidence.profile,
          authorityWriteId: priorEvidence.authorityWriteId || null,
          authorityReconciliationId: priorEvidence.authorityReconciliationId || null,
          authorityState: priorEvidence.authorityState || 'authoritative',
          supersededByAuthorityWriteId: priorEvidence.supersededByAuthorityWriteId || null,
          active: priorEvidence.active !== false,
          stale: priorEvidence.stale === true,
          staleReason: priorEvidence.staleReason || null
        } },
        { new: true, ...(options.signal ? { signal: options.signal } : {}) }
      ).lean();
      if (!restored) {
        throw new Error(`Prior profiler evidence ${priorEvidence._id} could not be restored under the exact write fence`);
      }
      invalidated = restored;
    }
    await ModelProfile.updateOne(
      { name: details.modelName },
      {
        $addToSet: { rejectedAuthorityWriteIds: details.authorityWriteId },
        $set: {
          [`readiness.${details.hostId}`]: details.priorReadiness || null,
          ...(details.thinking === true
            ? { [`thinkingProfiles.${details.hostId}`]: details.priorThinking || null }
            : {})
        }
      },
      options.signal ? { signal: options.signal } : undefined
    );
    await ModelPerformanceProfile.updateMany(
      {
        modelName: details.modelName,
        hostId: details.hostId,
        supersededByAuthorityWriteId: details.authorityWriteId
      },
      { $set: {
        active: true,
        stale: false,
        staleReason: null,
        supersededByAuthorityWriteId: null
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.evidenceId || record.resultId,
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(invalidated?.__v)) ? Number(invalidated.__v) : null,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_snapshot_write') {
    const details = record.details || {};
    const payload = details.payload || {};
    const updated = await HostPerformanceSnapshot.findOneAndUpdate(
      { _id: objectId(details.snapshotId || record.resultId) },
      {
        $setOnInsert: payload,
        $set: {
          authorityState: 'authority_invalidated',
          authorityReconciliationReason: 'host snapshot persistence acknowledgement reconciled after owner loss',
          authorityWriteId: details.authorityWriteId,
          authorityReconciliationId: String(record._id)
        }
      },
      { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: String(details.snapshotId || record.resultId),
      state: 'authority_invalidated',
      afterVersion: Number.isFinite(Number(updated?.__v)) ? Number(updated.__v) : null,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_baseline_write') {
    const details = record.details || {};
    const receipt = String(details.persistenceReceipt || '');
    const fenced = await HostProfile.updateOne(
      { hostId: details.hostId },
      { $addToSet: { rejectedBaselineReceipts: receipt } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(fenced)) throw new Error('Host baseline receipt fence did not match its host');
    const replacement = details.priorBaseline
      ? { $set: { baseline: details.priorBaseline } }
      : { $unset: { baseline: '' } };
    await HostProfile.updateOne(
      { hostId: details.hostId, 'baseline.persistenceReceipt': receipt },
      replacement,
      options.signal ? { signal: options.signal } : undefined
    );
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.hostId,
      state: 'authority_invalidated',
      persistenceReceipt: receipt,
      compensatedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_context_write') {
    const details = record.details || {};
    await ModelContextProbeSnapshot.findOneAndUpdate(
      { _id: objectId(details.snapshotId) },
      {
        $setOnInsert: details.snapshotPayload || {},
        $set: {
          authorityStatus: 'rejected',
          authorityError: 'context authority write reconciled after owner loss',
          authorityWriteId: details.authorityWriteId,
          authorityReconciliationId: String(record._id)
        }
      },
      { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
    ).lean();
    const identity = {
      modelName: details.modelName,
      hostUrl: details.hostUrl,
      artifactDigest: details.artifactDigest,
      runtimeFingerprint: details.runtimeFingerprint
    };
    const rejected = [
      ...new Set([...(details.priorProfile?.rejectedEvidenceIds || []), String(details.snapshotId)])
    ];
    if (details.priorProfile) {
      const { _id, __v, createdAt, updatedAt, ...priorProfile } = details.priorProfile;
      await ModelContextProfile.updateOne(
        identity,
        { $set: { ...priorProfile, rejectedEvidenceIds: rejected } },
        { upsert: true, ...(options.signal ? { signal: options.signal } : {}) }
      );
    } else {
      await ModelContextProfile.updateOne(
        identity,
        {
          $setOnInsert: identity,
          $set: {
            authorityState: 'authority_invalidated',
            authorityWriteId: details.authorityWriteId,
            authorityReconciliationId: String(record._id),
            stale: true,
            staleReason: 'context_authority_write_reconciled',
            recommendationStatus: 'unknown',
            revalidationRequired: true,
            recommendedInteractiveContext: null,
            recommendedDocumentContext: null,
            performanceKneeContext: null,
            qualityVerifiedContext: null,
            qualityContextStatus: 'unknown',
            recommendedContext: null,
            rejectedEvidenceIds: rejected
          }
        },
        { upsert: true, ...(options.signal ? { signal: options.signal } : {}) }
      );
    }
    options.assertActive?.();
    return {
      contract: 'agentx.authority-compensation/v1',
      resourceType: record.resourceType,
      resourceId: details.snapshotId,
      state: 'authority_invalidated',
      compensatedAt: new Date().toISOString()
    };
  }
  const Model = resourceModel(record);
  if (!Model) throw new Error(`Unsupported authority reconciliation kind: ${record.kind}`);
  const id = objectId(record.resultId);
  const update = { $set: authorityInvalidationFields(record), $inc: { __v: 1 } };
  const query = Model.findOneAndUpdate(
    { _id: id },
    update,
    { upsert: true, new: true, ...(options.signal ? { signal: options.signal } : {}) }
  );
  const updated = typeof query?.lean === 'function' ? await query.lean() : await query;
  if (!updated) throw new Error(`Authority invalidation did not return ${record.resourceType} ${record.resultId}`);
  if (record.kind === 'result_invalidation' && record.batchId) {
    await BenchmarkBatch.updateOne(
      { _id: record.batchId },
      { $set: authorityInvalidationFields({ ...record, kind: 'batch_invalidation' }), $inc: { __v: 1 } },
      options.signal ? { signal: options.signal } : undefined
    );
  }
  options.assertActive?.();
  return {
    contract: 'agentx.authority-compensation/v1',
    resourceType: record.resourceType,
    resourceId: record.resultId,
    state: 'authority_invalidated',
    afterVersion: Number(updated.__v),
    compensatedAt: new Date().toISOString()
  };
}

module.exports = { invalidateResource };
