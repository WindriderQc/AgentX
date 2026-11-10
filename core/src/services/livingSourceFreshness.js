'use strict';

// Projection only: no history, scheduler or duplicated producer records.
const iso = (value, now) => {
  if (!(value instanceof Date) && typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.getTime() <= now.getTime() + 60000 ? at.toISOString() : null;
};
function latest(records, field, now) {
  return records.map(row => iso(row?.[field], now)).filter(Boolean).sort().at(-1) || null;
}
function producerEvidence(source, result, now) {
  const common = { lastSuccessfulRunAt: null, lastFailedRunAt: null,
    effectiveCadenceMs: null, history: 'unknown' };
  if (source === 'weather') return { ...common, authority: 'data.ec-weather', mode: 'on_demand',
    lastSuccessfulRetrievalAt: iso(result.data?.fetchedAt, now),
    observedAt: iso(result.data?.observedAt, now),
    observationAgeMs: result.freshness?.observationAgeMs ?? null,
    cadenceMeaning: 'Cache lifetime is not a periodic producer schedule.',
    missing: ['producer_run_history', 'last_failed_retrieval', 'effective_cadence'] };
  if (source === 'agentx') return { ...common, authority: 'core.reports', mode: 'request_probe',
    missing: ['producer_run_history', 'effective_cadence'],
    coverage: 'API reachability for this request, not producer completion or functional acceptance.' };
  if (source === 'secretary') {
    const entries = result.data?.sections?.mail?.entries || [];
    const actions = result.data?.sections?.flaggedForOwner?.actions || [];
    return { ...common, authority: 'core.mail-journal', mode: 'native_records',
      recordUpdatedAt: latest(entries, 'updatedAt', now),
      recordCreatedAt: latest([...entries, ...actions], 'createdAt', now),
      coverage: 'Only records returned on this page and query window. Not latest mailbox receipt or whole journal.',
      missing: ['source_bound_producer_run_history', 'effective_cadence'] };
  }
  const publication = result.data?.sections?.freshness?.publication;
  return { ...common, authority: 'core.finance', mode: 'native_records',
    lastAttestedImportAt: iso(publication?.lastAppliedAt, now),
    importEvidenceStatus: publication?.status === 'attested' && !iso(publication.lastAppliedAt, now)
      ? 'unknown' : publication?.status || 'not_read',
    latestTransactionDate: result.data?.sections?.freshness?.latestTransactionDate || null,
    coverage: 'Personal ledger journaled ingestion receipts only. Legacy imports and repairs are not covered. Transaction dates are separate.',
    missing: ['complete_producer_run_history', 'dated_failed_import', 'effective_cadence'] };
}

module.exports = { producerEvidence, validTimestamp: iso };
