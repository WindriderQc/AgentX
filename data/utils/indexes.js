const { log } = require('./logger');
const hardwareTelemetry = require('../services/hardwareTelemetryService');

// Uniqueness on `mac` must NOT apply to MAC-less devices. nmap returns some hosts
// without a MAC (the scanning host itself, L3 devices), which the upsert stores as
// `mac: ''` keyed by IP (see networkAgentService.applyScanResults). A *non-sparse*
// unique index rejects the 2nd such device with E11000, and because the agent-ingest
// bulkWrite is ordered, that one collision drops the entire batch (HTTP 500). A
// PARTIAL unique index enforces uniqueness only on real, non-empty MAC strings, so
// any number of MAC-less devices coexist — each disambiguated by IP in the upsert.
const MAC_UNIQUE_PARTIAL = { mac: { $type: 'string', $gt: '' } };

const INDEX_SPECS = [
  { collection: 'nas_files', key: { path: 1 }, options: { name: 'path_unique', unique: true } },
  { collection: 'nas_files', key: { sha256: 1 }, options: { name: 'sha256_lookup' } },
  { collection: 'nas_files', key: { source_root: 1, size: -1 }, options: { name: 'source_size' } },
  { collection: 'nas_files', key: { source_root: 1, dirname: 1, size: -1, path: 1 }, options: { name: 'source_directory_rollup' } },
  { collection: 'nas_files', key: { size: -1 }, options: { name: 'size_candidates' } },
  { collection: 'network_devices', key: { mac: 1 }, options: { name: 'mac_unique', unique: true, partialFilterExpression: MAC_UNIQUE_PARTIAL } },
  { collection: 'network_devices', key: { lastSeen: -1 }, options: { name: 'last_seen_desc' } },
  { collection: 'network_devices', key: { scanSource: 1 }, options: { name: 'scan_source' } },
  { collection: 'network_scan_requests', key: { requestedAt: -1 }, options: { name: 'requested_at_desc' } },
  { collection: 'network_scan_requests', key: { status: 1, requestedAt: -1 }, options: { name: 'status_requested_at' } },
  { collection: 'network_scanners', key: { scannerId: 1 }, options: { name: 'scanner_id_unique', unique: true } },
  { collection: 'network_scanners', key: { lastSeen: -1 }, options: { name: 'scanner_last_seen_desc' } },
  { collection: 'storage_scanners', key: { scannerId: 1 }, options: { name: 'storage_scanner_id_unique', unique: true } },
  { collection: 'storage_scanners', key: { lastSeen: -1 }, options: { name: 'storage_scanner_last_seen' } },
  { collection: 'hardware_collectors', key: { collectorId: 1 }, options: { name: 'hardware_collector_id_unique', unique: true } },
  { collection: 'hardware_hosts', key: { hostId: 1 }, options: { name: 'hardware_host_id_unique', unique: true } },
  { collection: 'hardware_gpu_samples', key: { hostId: 1, index: 1, sampledAt: -1 }, options: { name: 'hardware_host_gpu_sampled' } },
  { collection: 'nas_scans', key: { started_at: -1 }, options: { name: 'started_at_desc' } },
  { collection: 'appevents', key: { timestamp: -1 }, options: { name: 'timestamp_desc' } },
  { collection: 'dedup_reports', key: { created_at: -1 }, options: { name: 'created_at_desc' } },
  { collection: 'janitor_profiles', key: { name: 1 }, options: { name: 'name_unique', unique: true } },
  { collection: 'janitor_profiles', key: { 'schedule.enabled': 1 }, options: { name: 'schedule_enabled' } },
  { collection: 'janitor_runs', key: { profile_id: 1, started_at: -1 }, options: { name: 'profile_started' } },
  { collection: 'janitor_runs', key: { status: 1 }, options: { name: 'status' } },
  { collection: 'janitor_strategy_reports', key: { generatedAt: -1 }, options: { name: 'generated_at_desc' } },
  { collection: 'janitor_strategy_report_details', key: { reportId: 1, ordinal: 1 }, options: { name: 'report_ordinal' } },

  // TTL indexes — automatic retention for high-growth collections
  { collection: 'appevents', key: { timestamp: 1 }, options: { name: 'ttl_30d', expireAfterSeconds: 2592000 } },
  { collection: 'pressures', key: { timeStamp: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 7776000 } },
  { collection: 'integration_events', key: { at: 1 }, options: { name: 'ttl_90d', expireAfterSeconds: 7776000 } }
];

/**
 * Migration — `network_devices.mac_unique` was historically a plain (non-partial)
 * unique index. `createIndex()` will NOT mutate an existing index's options (Mongo
 * throws IndexOptionsConflict), so the legacy index must be dropped before the spec
 * above can rebuild it as partial. Safe on a live collection: the old unique index
 * guaranteed at most one document per non-empty `mac`, so the partial rebuild can
 * never hit a duplicate-key during its build. Idempotent — if the index is already
 * partial (or absent) this is a no-op.
 */
async function migrateMacUniqueIndex(db) {
  const coll = db.collection('network_devices');
  let existing;
  try {
    existing = await coll.indexes();
  } catch (error) {
    // NamespaceNotFound — collection not created yet; createIndex below makes it fresh.
    return;
  }
  const mac = (existing || []).find((ix) => ix.name === 'mac_unique');
  if (mac && !mac.partialFilterExpression) {
    try {
      await coll.dropIndex('mac_unique');
      log('[indexes] Dropped legacy non-partial network_devices.mac_unique; rebuilding as partial', 'info');
    } catch (error) {
      log(`[indexes] Could not drop legacy mac_unique for partial migration: ${error.message}`, 'warn');
    }
  }
}

async function ensureIndexes(db) {
  // Run reshaping migrations before the create loop, since createIndex won't alter
  // an existing index in place.
  await migrateMacUniqueIndex(db);

  for (const spec of INDEX_SPECS) {
    try {
      await db.collection(spec.collection).createIndex(spec.key, spec.options);
    } catch (error) {
      log(
        `[indexes] Failed to create ${spec.collection}.${spec.options?.name || JSON.stringify(spec.key)}: ${error.message}`,
        'warn'
      );
    }
  }

  // GPU history retention is configurable (DATA_HARDWARE_HISTORY_TTL_DAYS).
  try {
    await hardwareTelemetry.ensureHistoryTtl(db);
  } catch (error) {
    log(`[indexes] Failed to apply hardware_gpu_samples TTL: ${error.message}`, 'warn');
  }
}

module.exports = { ensureIndexes };
