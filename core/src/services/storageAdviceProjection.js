'use strict';

const MAX_ITEMS = 8;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const choice = (value, allowed) => allowed.includes(value) ? value : 'unknown';
const codes = values => (Array.isArray(values) ? values : []).slice(0, 16)
  .filter(value => typeof value === 'string' && /^[a-z_]{1,80}$/.test(value));
const at = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const FRESHNESS = ['acceptable_by_policy', 'stale_by_policy'];
const ACTIONS = ['review_capacity_shortfall', 'no_capacity_change_indicated', 'verify_capacity_inputs',
  'no_independent_copy_required_by_policy', 'verify_independent_restorable_retained_copies',
  'review_additional_full_logical_copy', 'do_not_select_destination_under_policy', 'verify_placement_inputs'];

// Project only known fields; private volume ids, mount paths and configured
// failure-domain names stay in Data, just as for the inventory projection.
function projectAdvice(body) {
  const advice = body.advice;
  if (advice?.schemaVersion !== 1 || advice.status !== 'advisory_only') return null;
  const sources = body.sources.slice(0, MAX_ITEMS);
  const volumes = body.volumes.slice(0, MAX_ITEMS);
  const sourceLabel = value => sources.some(source => source.source === value) && typeof value === 'string' ? value.slice(0, 64) : null;
  const volumeNumber = value => { const index = volumes.findIndex(volume => volume.id === value); return index < 0 ? null : index + 1; };
  const rows = (key, filter, map, max) => (Array.isArray(advice[key]) ? advice[key] : []).filter(filter).slice(0, max).map(row => ({
    ...map(row), action: choice(row.action, ACTIONS), missingEvidence: codes(row.missingEvidence)
  }));
  const capacity = rows('capacity', row => volumeNumber(row.volumeId), row => ({
    volume: volumeNumber(row.volumeId), status: choice(row.status, ['below_reserve', 'reserve_met']),
    evidence: { freeBytes: count(row.evidence?.freeBytes), reserveBytes: count(row.evidence?.reserveBytes),
      deficitBytes: count(row.evidence?.deficitBytes), observedAt: at(row.evidence?.observedAt),
      ageMs: count(row.evidence?.ageMs), maxAgeMs: count(row.evidence?.maxAgeMs),
      freshness: choice(row.evidence?.freshness, FRESHNESS) }
  }), MAX_ITEMS);
  const copyCoverage = rows('copyCoverage', row => sourceLabel(row.source), row => ({
    source: sourceLabel(row.source), status: choice(row.status, ['not_required_by_policy']),
    evidence: { requiredIndependentCopies: count(row.evidence?.requiredIndependentCopies),
      retentionDays: count(row.evidence?.retentionDays), indexedFiles: count(row.evidence?.indexedFiles),
      observedHashedFiles: count(row.evidence?.observedHashedFiles),
      observedFilesWithOtherSource: count(row.evidence?.observedFilesWithOtherSource), independentBackupCoverage: 'unknown' }
  }), MAX_ITEMS);
  const placement = rows('placement', row => sourceLabel(row.source) && (row.volumeId === null || volumeNumber(row.volumeId)), row => ({
    source: sourceLabel(row.source), volume: volumeNumber(row.volumeId),
    status: choice(row.status, ['candidate_for_review', 'blocked']), reasons: codes(row.reasons),
    evidence: Object.fromEntries([
      ...['indexedBytes', 'growthBytes', 'reserveBytes', 'requiredFreeBytes', 'freeBytes'].map(key => [key, count(row.evidence?.[key])]),
      ...['scanAgeMs', 'maxScanAgeMs', 'volumeAgeMs', 'maxVolumeAgeMs'].map(key => [key, count(row.evidence?.[key])]),
      ...['scanObservedAt', 'volumeObservedAt'].map(key => [key, at(row.evidence?.[key])]),
      ...['scanFreshness', 'volumeFreshness'].map(key => [key, choice(row.evidence?.[key], FRESHNESS)]),
      ['failureDomains', choice(row.evidence?.failureDomains, ['declared_same', 'declared_distinct'])]
    ])
  }), MAX_ITEMS * MAX_ITEMS);
  return { status: 'advisory_only', policyStatus: choice(advice.policyStatus, ['missing', 'invalid', 'configured']),
    capacity, copyCoverage, placement,
    omittedPlacementPairs: Math.max(0, (Array.isArray(advice.placement) ? advice.placement.length : 0) - placement.length)
      + (count(advice.omittedPlacementPairs) || 0), executionAuthorized: false,
    summary: `${advice.policyStatus === 'configured' ? 'Conseils selon la politique déclarée' : advice.policyStatus === 'missing' ? 'Politique de conseils absente; renseigner les contraintes manquantes' : 'Politique de conseils invalide; vérifier sa configuration'} : ${capacity.filter(row => row.status === 'below_reserve').length} réserve(s) insuffisante(s), ${placement.filter(row => row.status === 'candidate_for_review').length} candidat(s) de copie à examiner. Les preuves de sauvegarde indépendante, restauration et rétention restent inconnues; aucune action autorisée.` };
}

module.exports = { projectAdvice };
