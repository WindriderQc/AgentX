'use strict';

const MAX_ITEMS = 8;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = value => typeof value === 'string' ? value.slice(0, 64) : null;

function observation(value) {
  return { observedAt: typeof value?.observedAt === 'string' ? value.observedAt.slice(0, 32) : null,
    ageMs: count(value?.ageMs), acceptableFreshness: 'unknown' };
}

// Keep this projection compact and exclude mount paths, hashes and scan ids.
function projectAssessment(body) {
  if (body?.schemaVersion !== 1 || !Array.isArray(body.sources) || !Array.isArray(body.volumes)) {
    return { status: 'unavailable', recommendation: null,
      summary: 'Évaluation du stockage indisponible; capacité, copies et placement inconnus.' };
  }
  const sources = body.sources.slice(0, MAX_ITEMS).map(source => ({
    source: label(source.source), coverage: source.coverage === 'complete_at_scan' ? 'complete_at_scan' : 'unknown',
    lastScan: source.lastScan ? { status: label(source.lastScan.status), ...observation(source.lastScan) } : null,
    indexedFiles: count(source.indexed?.files), indexedBytes: count(source.indexed?.bytes),
    observedHashedFiles: count(source.copies?.observedHashedFiles),
    observedFilesWithOtherSource: count(source.copies?.observedFilesWithOtherSource),
    unverifiedFiles: count(source.copies?.unverifiedFiles),
    currentCopyCoverage: 'unknown', independentBackupCoverage: 'unknown'
  }));
  const volumes = body.volumes.slice(0, MAX_ITEMS).map((volume, index) => ({
    volume: index + 1, host: label(volume.host), filesystem: label(volume.filesystem?.type),
    capacityBytes: count(volume.capacityBytes), freeBytes: count(volume.freeBytes),
    observation: observation(volume.observation)
  }));
  const compatibility = (Array.isArray(body.placement?.compatibility) ? body.placement.compatibility : []).filter(pair =>
    body.sources.slice(0, MAX_ITEMS).some(source => source.source === pair.source)
    && body.volumes.slice(0, MAX_ITEMS).some(volume => volume.id === pair.volumeId)
  ).slice(0, MAX_ITEMS * MAX_ITEMS).map(pair => ({
    source: label(pair.source), volume: body.volumes.findIndex(volume => volume.id === pair.volumeId) + 1,
    indexedBytes: count(pair.indexedBytes), freeBytes: count(pair.freeBytes),
    observedCapacityFit: ['fits', 'insufficient'].includes(pair.observedCapacityFit) ? pair.observedCapacityFit : 'unknown',
    suitability: 'unknown'
  }));
  return {
    status: 'observations_only', generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt.slice(0, 32) : null,
    summary: 'Observations datées des sources configurées seulement; fraîcheur acceptable et couverture de sauvegarde indépendante inconnues. Comparaison de capacité pour une copie logique entière, sans réserve: aucune destination recommandée.',
    scope: 'configured_storage_sources_only', sources, volumes,
    omittedSources: Math.max(0, body.sources.length - sources.length) + (count(body.coverage?.omittedSources) || 0),
    omittedVolumes: Math.max(0, body.volumes.length - volumes.length) + (count(body.coverage?.omittedVolumes) || 0),
    compatibility, hypothesis: 'additional_full_logical_copy_each_pair_independent_no_reserve_or_growth',
    recommendation: null, recommendationStatus: 'withheld',
    missingEvidence: Array.isArray(body.placement?.missingEvidence) ? body.placement.missingEvidence.slice(0, 8).map(label) : [],
    wholeInstanceCoverage: 'unknown', filesystemMutationAllowed: false
  };
}

module.exports = { projectAssessment };
