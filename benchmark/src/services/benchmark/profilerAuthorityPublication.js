'use strict';

/**
 * Publishes verified profiler authority writes (evidence, snapshot, baseline,
 * context) by flipping their pending projections to authoritative under CAS.
 * Moved out of benchmarkAuthorityReconciliation.js.
 */

const HostPerformanceSnapshot = require('../../../models/HostPerformanceSnapshot');
const HostProfile = require('../../../models/HostProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const ModelContextProbeSnapshot = require('../../../models/ModelContextProbeSnapshot');
const { objectId, matchedExactlyOne } = require('./authorityReconciliationShared');

async function publishProfilerResource(record, options = {}) {
  const details = record.details || {};
  options.assertActive?.();
  if (record.kind === 'profiler_evidence_write') {
    const evidenceId = details.evidenceId || null;
    const evidence = await ModelPerformanceProfile.updateOne(
      {
        ...(evidenceId ? { _id: objectId(evidenceId) } : {
          modelName: details.modelName,
          hostId: details.hostId,
          'artifact.digest': details.artifactDigest,
          'artifact.runtimeFingerprint': details.runtimeFingerprint
        }),
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
      },
      { $set: { authorityState: 'authoritative', authorityReconciliationId: String(record._id) } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(evidence)) throw new Error('Profiler evidence publication CAS did not match its pending write');
    const readinessSet = {
      [`readiness.${details.hostId}.authorityState`]: 'authoritative'
    };
    if (details.thinking === true) {
      readinessSet[`thinkingProfiles.${details.hostId}.authorityState`] = 'authoritative';
    }
    const projection = await ModelProfile.updateOne(
      {
        name: details.modelName,
        [`readiness.${details.hostId}.evidenceId`]: objectId(evidenceId),
        [`readiness.${details.hostId}.authorityWriteId`]: details.authorityWriteId,
        rejectedAuthorityWriteIds: { $ne: details.authorityWriteId }
      },
      { $set: readinessSet },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(projection)) throw new Error('Profiler readiness publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: String(evidenceId),
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_snapshot_write') {
    const snapshot = await HostPerformanceSnapshot.updateOne(
      {
        _id: objectId(details.snapshotId || record.resultId),
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] }
      },
      { $set: { authorityState: 'authoritative', authorityReconciliationId: String(record._id) } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(snapshot)) throw new Error('Host snapshot publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: String(details.snapshotId || record.resultId),
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_baseline_write') {
    const baseline = await HostProfile.updateOne(
      {
        hostId: details.hostId,
        'baseline.persistenceReceipt': details.persistenceReceipt,
        'baseline.authorityWriteId': details.authorityWriteId,
        'baseline.authorityState': { $in: ['pending_reconciliation', 'authoritative'] },
        rejectedBaselineReceipts: { $ne: details.persistenceReceipt }
      },
      { $set: {
        'baseline.authorityState': 'authoritative',
        'baseline.authorityReconciliationId': String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(baseline)) throw new Error('Host baseline publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: details.hostId,
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  if (record.kind === 'profiler_context_write') {
    const snapshot = await ModelContextProbeSnapshot.updateOne(
      {
        _id: objectId(details.snapshotId),
        authorityWriteId: details.authorityWriteId,
        authorityStatus: { $in: ['pending', 'committed'] }
      },
      { $set: {
        authorityStatus: 'committed',
        authorityError: null,
        authorityReconciliationId: String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(snapshot)) throw new Error('Context probe snapshot publication CAS did not match its pending write');
    const profile = await ModelContextProfile.updateOne(
      {
        modelName: details.modelName,
        hostUrl: details.hostUrl,
        artifactDigest: details.artifactDigest,
        runtimeFingerprint: details.runtimeFingerprint,
        authorityWriteId: details.authorityWriteId,
        authorityState: { $in: ['pending_reconciliation', 'authoritative'] },
        rejectedEvidenceIds: { $ne: details.snapshotId }
      },
      { $set: {
        authorityState: 'authoritative',
        authorityReconciliationId: String(record._id)
      } },
      options.signal ? { signal: options.signal } : undefined
    );
    if (!matchedExactlyOne(profile)) throw new Error('Context profile publication CAS did not match its pending write');
    options.assertActive?.();
    return {
      contract: 'agentx.profiler-authority-publication/v1',
      resourceType: record.resourceType,
      resourceId: details.snapshotId,
      authorityWriteId: details.authorityWriteId,
      state: 'authoritative',
      publishedAt: new Date().toISOString()
    };
  }
  throw new Error(`Unsupported profiler authority publication kind: ${record.kind}`);
}

module.exports = { publishProfilerResource };
