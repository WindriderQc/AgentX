'use strict';

// Pure interpretation of the stored assessment. No filesystem, collector, writer
// or backup registry: configured constraints are declarations, never receipts.
const MAX_PLACEMENT_PAIRS = 64;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const optional = (value, key, check) => value[key] === undefined || check(value[key]);

function readPolicy(raw = process.env.STORAGE_ADVICE_POLICY_JSON) {
  if (raw === undefined || raw === '') return { status: 'missing', value: {} };
  try {
    if (typeof raw !== 'string' || raw.length > 65536) throw new Error();
    const value = JSON.parse(raw);
    if (!fields(value, ['version', 'maxScanAgeMs', 'maxVolumeAgeMs', 'sources', 'volumes']) || value.version !== 1
      || !optional(value, 'maxScanAgeMs', integer) || !optional(value, 'maxVolumeAgeMs', integer)) throw new Error();
    for (const [kind, limit] of [['sources', 32], ['volumes', 64]]) {
      if (value[kind] === undefined) continue;
      if (!object(value[kind]) || Object.keys(value[kind]).length > limit) throw new Error();
      for (const [key, rule] of Object.entries(value[kind])) {
        const allowed = kind === 'sources'
          ? ['growthBytes', 'requiredIndependentCopies', 'retentionDays', 'allowedVolumeIds', 'failureDomain']
          : ['reserveBytes', 'failureDomain'];
        if (!text(key) || !fields(rule, allowed) || !optional(rule, 'failureDomain', text)) throw new Error();
        for (const name of ['growthBytes', 'requiredIndependentCopies', 'retentionDays', 'reserveBytes']) {
          if (!optional(rule, name, integer)) throw new Error();
        }
        if (!optional(rule, 'allowedVolumeIds', list => Array.isArray(list) && list.length <= 64
          && list.every(text) && new Set(list).size === list.length)) throw new Error();
      }
    }
    return { status: 'configured', value };
  } catch (_) { return { status: 'invalid', value: {} }; }
}

function freshness(observation, maximum) {
  if (!integer(maximum)) return 'unknown';
  if (!observation?.observedAt || !integer(observation.ageMs)) return 'unknown';
  return observation.ageMs <= maximum ? 'acceptable_by_policy' : 'stale_by_policy';
}

const unique = values => [...new Set(values)];
const normalize = root => String(root || '').replace(/\/+$/, '');
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

function buildStorageAdvice(assessment, policy = readPolicy()) {
  const config = policy.value;
  const sourceRule = source => Object.hasOwn(config.sources || {}, source) ? config.sources[source] : {};
  const volumeRule = id => Object.hasOwn(config.volumes || {}, id) ? config.volumes[id] : {};
  const policyMissing = policy.status === 'configured' ? [] : [`${policy.status}_advice_policy`];
  const capacity = assessment.volumes.map(volume => {
    const rule = volumeRule(volume.id);
    const fresh = freshness(volume.observation, config.maxVolumeAgeMs);
    const missing = [...policyMissing];
    if (!integer(config.maxVolumeAgeMs)) missing.push('max_volume_age_ms');
    if (!integer(rule.reserveBytes)) missing.push('volume_reserve_bytes');
    if (fresh === 'unknown') missing.push('dated_volume_measurement');
    if (fresh === 'stale_by_policy') missing.push('fresh_volume_measurement');
    const known = !missing.length;
    const deficit = known ? Math.max(0, rule.reserveBytes - volume.freeBytes) : null;
    return { volumeId: volume.id, status: known ? deficit > 0 ? 'below_reserve' : 'reserve_met' : 'unknown',
      action: known ? deficit > 0 ? 'review_capacity_shortfall' : 'no_capacity_change_indicated' : 'verify_capacity_inputs',
      missingEvidence: unique(missing), evidence: { freeBytes: volume.freeBytes,
        reserveBytes: rule.reserveBytes ?? null, deficitBytes: deficit,
        observedAt: volume.observation.observedAt, ageMs: volume.observation.ageMs,
        maxAgeMs: config.maxVolumeAgeMs ?? null, freshness: fresh } };
  });
  const copyCoverage = assessment.sources.map(source => {
    const rule = sourceRule(source.source);
    const missing = [...policyMissing];
    if (!integer(rule.requiredIndependentCopies)) missing.push('required_independent_copies');
    if (rule.requiredIndependentCopies !== 0) {
      if (!integer(rule.retentionDays)) missing.push('retention_days');
      missing.push('independent_copy_receipts', 'restore_verification', 'retention_evidence');
    }
    return { source: source.source, status: rule.requiredIndependentCopies === 0 ? 'not_required_by_policy' : 'unknown',
      action: rule.requiredIndependentCopies === 0 ? 'no_independent_copy_required_by_policy' : 'verify_independent_restorable_retained_copies',
      missingEvidence: unique(missing), evidence: { requiredIndependentCopies: rule.requiredIndependentCopies ?? null,
        retentionDays: rule.retentionDays ?? null, observedFilesWithOtherSource: source.copies.observedFilesWithOtherSource,
        observedHashedFiles: source.copies.observedHashedFiles, indexedFiles: source.indexed?.files ?? null,
        independentBackupCoverage: 'unknown' } };
  });

  const placement = [];
  let totalPairs = 0;
  for (const source of assessment.sources) {
    const rule = sourceRule(source.source);
    // Missing destinations produce an explicit source-level request, not an
    // invented preference over all the measured disks.
    const destinations = !rule.allowedVolumeIds?.length ? [null] : rule.allowedVolumeIds;
    for (const volumeId of destinations) {
      totalPairs++;
      if (placement.length >= MAX_PLACEMENT_PAIRS) continue;
      const matches = assessment.volumes.filter(volume => volume.id === volumeId);
      const volume = matches.length === 1 ? matches[0] : null;
      const target = volumeRule(volumeId);
      const missing = [...policyMissing];
      const blocked = [];
      if (volumeId === null && rule.allowedVolumeIds?.length === 0) blocked.push('no_destinations_allowed_by_policy');
      else if (volumeId === null) missing.push('allowed_volume_ids');
      else if (!volume) missing.push(matches.length > 1 ? 'unambiguous_destination_volume' : 'configured_destination_measurement');
      if (source.coverage !== 'complete_at_scan') missing.push('complete_source_scan');
      if (!integer(config.maxScanAgeMs)) missing.push('max_scan_age_ms');
      if (!integer(config.maxVolumeAgeMs)) missing.push('max_volume_age_ms');
      const scanFreshness = freshness(source.lastScan, config.maxScanAgeMs);
      const volumeFreshness = freshness(volume?.observation, config.maxVolumeAgeMs);
      if (scanFreshness !== 'acceptable_by_policy') missing.push('fresh_complete_source_scan');
      if (volumeFreshness !== 'acceptable_by_policy') missing.push('fresh_volume_measurement');
      if (!integer(rule.growthBytes)) missing.push('source_growth_bytes');
      if (!integer(target.reserveBytes)) missing.push('volume_reserve_bytes');
      if (!rule.failureDomain || !target.failureDomain) missing.push('declared_failure_domains');
      else if (rule.failureDomain === target.failureDomain) blocked.push('same_declared_failure_domain');
      if (volume?.roots.some(root => overlaps(normalize(source.root), normalize(root)))) blocked.push('source_volume_or_overlapping_root');
      const indexedBytes = source.indexed?.bytes;
      if (!integer(indexedBytes)) missing.push('complete_indexed_bytes');
      const requiredBytes = integer(indexedBytes) && integer(rule.growthBytes) && integer(target.reserveBytes)
        ? indexedBytes + rule.growthBytes + target.reserveBytes : null;
      if (requiredBytes !== null && !integer(requiredBytes)) missing.push('safe_capacity_arithmetic');
      const safeRequired = integer(requiredBytes) ? requiredBytes : null;
      if (safeRequired !== null && volume && volume.freeBytes < safeRequired) blocked.push('insufficient_space_after_reserve_and_growth');
      const status = blocked.length ? 'blocked' : missing.length ? 'unknown' : 'candidate_for_review';
      placement.push({ source: source.source, volumeId, status,
        action: status === 'candidate_for_review' ? 'review_additional_full_logical_copy'
          : status === 'blocked' ? 'do_not_select_destination_under_policy' : 'verify_placement_inputs',
        missingEvidence: unique(missing), reasons: blocked,
        evidence: { indexedBytes: indexedBytes ?? null, growthBytes: rule.growthBytes ?? null,
          reserveBytes: target.reserveBytes ?? null, requiredFreeBytes: safeRequired, freeBytes: volume?.freeBytes ?? null,
          scanObservedAt: source.lastScan?.observedAt ?? null, volumeObservedAt: volume?.observation.observedAt ?? null,
          scanAgeMs: source.lastScan?.ageMs ?? null, maxScanAgeMs: config.maxScanAgeMs ?? null,
          volumeAgeMs: volume?.observation.ageMs ?? null, maxVolumeAgeMs: config.maxVolumeAgeMs ?? null,
          scanFreshness, volumeFreshness,
          failureDomains: rule.failureDomain && target.failureDomain
            ? rule.failureDomain === target.failureDomain ? 'declared_same' : 'declared_distinct' : 'unknown' } });
    }
  }
  return { schemaVersion: 1, status: 'advisory_only', policyStatus: policy.status, capacity, copyCoverage, placement,
    omittedPlacementPairs: totalPairs - placement.length, executionAuthorized: false,
    limitations: [
      'Candidates satisfy declared constraints only; destination access and independent, restorable backups remain unverified.',
      'Each candidate assumes one additional full logical copy, independently of every other candidate; no allocation or priority is inferred.',
      'No scan, copy, migration, deletion or policy change is authorized or performed.'
    ] };
}

module.exports = { MAX_PLACEMENT_PAIRS, readPolicy, freshness, buildStorageAdvice };
