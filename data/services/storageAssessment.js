'use strict';

// A read projection of native records. No collector, filesystem or report writer.
const storageAgents = require('./storageAgentService');
const { aggregateVolumes } = require('./storageVolumes');
const { aggregateCopyCoverage } = require('./dedupScanner');

const MAX_SOURCES = 32;
const MAX_VOLUMES = 64;

function dated(value, now) {
  const ms = value == null ? NaN : new Date(value).getTime();
  const valid = Number.isFinite(ms) && ms > 0 && ms <= now.getTime();
  return { observedAt: valid ? new Date(ms).toISOString() : null,
    ageMs: valid ? now.getTime() - ms : null, acceptableFreshness: 'unknown' };
}

const normalize = root => String(root || '').replace(/[\\/]+$/, '');
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scanScope(root) {
  const ancestors = root.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/')).filter(Boolean);
  const roots = { $in: ['/', ...ancestors, new RegExp(`^${escaped(root)}(?:/|$)`)] };
  return { $or: [{ 'config.roots': roots }, { roots }] };
}

async function readStorageAssessment(db, { now = new Date() } = {}) {
  const registry = storageAgents.sourceRegistry();
  const declared = Object.entries(registry).sort(([a], [b]) => a.localeCompare(b));
  const selected = declared.slice(0, MAX_SOURCES);
  const scanners = await storageAgents.listScanners(db);
  const configuredScanners = scanners.map(scanner => ({ ...scanner,
    volumes: (Array.isArray(scanner.volumes) ? scanner.volumes : []).filter(report =>
      registry[report?.source]?.canonicalRoot && normalize(report.root) === normalize(registry[report.source].canonicalRoot))
  }));
  const allVolumes = aggregateVolumes(configuredScanners);
  const volumes = allVolumes.slice(0, MAX_VOLUMES).map(volume => ({ ...volume,
    observation: dated(volume.measuredAt, now),
    usedBytes: volume.capacityBytes - volume.freeBytes,
    freeRatio: volume.capacityBytes > 0 ? volume.freeBytes / volume.capacityBytes : null
  }));
  const sources = await Promise.all(selected.map(async ([source, config]) => {
    const root = normalize(config.canonicalRoot);
    const ambiguous = !root.startsWith('/') || root === '' || root === '/'
      || declared.some(([other, value]) => other !== source && overlaps(root, normalize(value.canonicalRoot)));
    if (ambiguous) return { source, root, coverage: 'unknown', reason: 'invalid_or_overlapping_configured_roots', scanId: null };
    const scope = scanScope(root);
    const [lastScan, activeScan] = await Promise.all([
      db.collection('nas_scans').findOne(scope, { sort: { started_at: -1, requested_at: -1 } }),
      db.collection('nas_scans').findOne({ ...scope, status: { $in: ['queued', 'running', 'hashing'] } })
    ]);
    const observation = dated(lastScan?.finished_at, now);
    const start = dated(lastScan?.started_at, now);
    const complete = lastScan?.status === 'complete' && !activeScan && observation.observedAt
      && start.observedAt && new Date(observation.observedAt) >= new Date(start.observedAt)
      && lastScan.config?.roots?.includes(root)
      && lastScan.config.roots.length === 1
      && !lastScan.config?.extensions?.length && !lastScan.config?.exclude_extensions?.length
      && !lastScan.counts?.errors && !lastScan.counts?.rejected && !lastScan.last_error;
    return { source, root, coverage: complete ? 'complete_at_scan' : 'unknown',
      reason: complete ? null : activeScan ? 'scan_in_progress' : 'no_complete_unfiltered_dated_scan',
      lastScan: lastScan ? { status: lastScan.status, ...observation } : null,
      collectorActive: scanners.some(scanner => scanner.active && scanner.sources?.includes(source)),
      capacityObservation: volumes.some(volume => volume.roots.includes(root)) ? 'dated_measurement' : 'unavailable',
      expectedFiles: complete && Number.isSafeInteger(lastScan.counts?.files_seen) ? lastScan.counts.files_seen : null,
      scanId: complete ? lastScan._id : null };
  }));

  const eligible = sources.filter(source => source.reason !== 'invalid_or_overlapping_configured_roots');
  const rows = await aggregateCopyCoverage(db, eligible);
  const projected = sources.map(({ scanId, expectedFiles, ...source }) => {
    const row = rows.find(row => row.source === source.source);
    const validBytes = row && row.invalidSizes === 0 && Number.isSafeInteger(row.bytes) && row.bytes >= 0;
    const complete = source.coverage === 'complete_at_scan' && validBytes && expectedFiles > 0
      && row.files === row.scanFiles && row.files === expectedFiles;
    return { ...source, coverage: complete ? 'complete_at_scan' : 'unknown',
      reason: source.reason || (complete ? null : 'index_count_or_scan_stamp_not_reconciled'),
      indexed: row ? { files: row.files, bytes: validBytes ? row.bytes : null } : null,
      copies: {
        evidence: 'sha256-current-indexed-metadata-and-latest-complete-scan',
        observedHashedFiles: row?.hashedFiles ?? null,
        observedHashedBytes: row?.hashedBytes ?? null,
        observedFilesWithOtherSource: row?.filesWithOtherSource ?? null,
        observedBytesWithOtherSource: row?.bytesWithOtherSource ?? null,
        unverifiedFiles: row ? row.files - row.hashedFiles : null,
        completeness: 'lower_bound_of_dated_observations',
        currentCoverage: 'unknown', independentBackupCoverage: 'unknown'
      }
    };
  });

  return {
    schemaVersion: 1, generatedAt: now.toISOString(), readFrom: 'stored_index_and_collector_reports',
    filesystemMutationAllowed: false, executionAuthorized: false,
    coverage: { scope: 'configured_storage_sources_only', declaredSources: declared.length,
      returnedSources: projected.length, omittedSources: declared.length - projected.length,
      returnedVolumes: volumes.length, omittedVolumes: allVolumes.length - volumes.length,
      wholeInstance: 'unknown', unregisteredDisks: 'unknown',
      vaultInventory: 'not_read_requires_filesystem_walk', backupReceipts: 'not_in_this_inventory' },
    sources: projected, volumes,
    placement: {
      hypothesis: 'Additional full logical copy of indexed source bytes; no reserve, growth, compression or deduplication assumed. Each pair is independent, not a combined allocation.',
      compatibility: projected.flatMap(source => volumes.map(volume => ({
        source: source.source, volumeId: volume.id, indexedBytes: source.indexed?.bytes ?? null,
        freeBytes: volume.freeBytes,
        observedCapacityFit: source.coverage !== 'complete_at_scan' || !volume.observation.observedAt
          || volume.roots.some(root => overlaps(source.root, normalize(root))) ? 'unknown'
          : source.indexed.bytes <= volume.freeBytes ? 'fits' : 'insufficient',
        suitability: 'unknown'
      }))),
      recommendation: null, status: 'withheld',
      missingEvidence: ['acceptable_freshness_policy', 'required_copies_and_retention_policy',
        'reserve_and_growth_policy', 'independent_failure_domains', 'destination_access_and_placement_policy']
    },
    limitations: [
      'Dates and ages are observations, not proof that an inventory or free-space measurement is current.',
      'A hash match in another source is a dated observation, not an independent, restorable or complete backup.',
      'Unhashed, outdated-fingerprint, unstamped and incomplete-scan rows remain unverified; absence of a match does not prove absence of another copy.',
      'Logical indexed bytes and statfs free space do not establish physical savings or a suitable destination.'
    ]
  };
}

module.exports = { MAX_SOURCES, MAX_VOLUMES, dated, readStorageAssessment };
