'use strict';

// Host-test baseline helpers, extracted from routes/profiler/hosts.js.
const crypto = require('crypto');
const hostProfileService = require('./hostProfileService');
const authorityReconciliation = require('../benchmark/benchmarkAuthorityReconciliation');

function buildBaselineFromResults(results = [], preferredModel = '') {
  const passing = results.filter(r => r?.status === 'pass');
  if (!passing.length) return null;
  const normalizeModel = n => String(n || '').trim().replace(/:latest$/i, '').toLowerCase();
  const normalizedPreferred = normalizeModel(preferredModel);
  const preferred = normalizedPreferred
    ? passing.find(r => normalizeModel(r.modelName) === normalizedPreferred)
    : null;
  const avg = (arr, key) => Number((arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length).toFixed(2));
  if (preferred) {
    const hasStreamedTtft = preferred.ttftMeasurement === 'streamed_wall_clock'
      && Number.isFinite(Number(preferred.timeToFirstTokenMs));
    return {
      referenceModel: preferred.modelName,
      tokensPerSec: preferred.tokensPerSec ?? avg(passing, 'tokensPerSec'),
      latencyMs: preferred.latencyMs ?? avg(passing, 'latencyMs'),
      ttftMs: hasStreamedTtft ? Number(preferred.timeToFirstTokenMs) : null,
      ttftMeasurement: hasStreamedTtft ? 'streamed_wall_clock' : undefined,
      testedAt: preferred.testedAt || new Date()
    };
  }
  const newest = [...passing].sort((a, b) => new Date(b.testedAt || 0) - new Date(a.testedAt || 0))[0];
  const streamedTtft = passing.filter(item => item.ttftMeasurement === 'streamed_wall_clock'
    && Number.isFinite(Number(item.timeToFirstTokenMs)));
  return {
    referenceModel: newest?.modelName || 'aggregate',
    tokensPerSec: avg(passing, 'tokensPerSec'),
    latencyMs: avg(passing, 'latencyMs'),
    ttftMs: streamedTtft.length ? avg(streamedTtft, 'timeToFirstTokenMs') : null,
    ttftMeasurement: streamedTtft.length ? 'streamed_wall_clock' : undefined,
    testedAt: newest?.testedAt || new Date()
  };
}

async function updateBaselineUnderLease(hostId, baseline, lease) {
  lease.assertActive();
  const prior = await hostProfileService.getByIdForAuthority(hostId);
  lease.assertActive();
  const authorityProof = lease.authorityProof();
  const persistenceReceipt = crypto.randomUUID();
  const authorityWriteId = crypto.randomUUID();
  let journal = null;
  try {
    journal = await authorityReconciliation.prepareProfilerAuthorityWrite({
      kind: 'profiler_baseline_write',
      resultId: `profiler-baseline:${lease.operationId}:${hostId}:${authorityWriteId}`,
      workloadId: lease.operationId,
      phase: 'profiler host baseline publication',
      details: {
        hostId,
        persistenceReceipt,
        authorityWriteId,
        priorBaseline: prior?.baseline || null
      }
    });
    lease.assertActive();
    const updated = await hostProfileService.updateBaseline(hostId, {
      ...baseline,
      persistenceReceipt,
      authorityWriteId,
      authorityReconciliationId: String(journal._id),
      authorityState: 'pending_reconciliation'
    }, {
      authorityService: 'profiler-baseline',
      authorityProof,
      expectedAuthorityGeneration: prior?.baseline?.authorityGeneration || null,
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    lease.assertActive();
    await authorityReconciliation.completeProfilerAuthorityWrite(journal, {
      details: journal.details,
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    return updated;
  } catch (error) {
    if (journal) {
      error.retainAdmission = true;
      error.authorityInvalidationFailed = true;
      error.code = error.code || 'HOST_BASELINE_RECONCILIATION_PENDING';
      error.reconciliationId = String(journal._id);
      if (typeof lease.abandon === 'function') await lease.abandon(error);
    }
    throw error;
  }
}

module.exports = { buildBaselineFromResults, updateBaselineUnderLease };
