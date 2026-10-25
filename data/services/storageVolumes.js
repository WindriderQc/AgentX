'use strict';

/**
 * Capacity and free space of the filesystems holding the storage sources, as
 * measured by the native collectors (statfs). Two sources on one filesystem of
 * one host yield a single volume.
 */

const MAX_REPORTS = 64;
const ZFS_NOTE = 'ZFS statfs reports this dataset\'s used plus available space, not the pool size.';

function boundedString(value, maximum) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maximum) : null;
}

function byteCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function measuredDate(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

// Keeps a bounded, typed copy of what a collector sent; a report without both
// byte counts carries its error instead and never becomes a volume.
function sanitizeVolumeReports(input, registry = {}, now = new Date()) {
  if (!Array.isArray(input)) return null;
  return input.slice(0, MAX_REPORTS).filter(item => item && typeof item === 'object').map(item => {
    const source = boundedString(item.source, 128);
    const report = {
      source,
      root: boundedString(item.root, 512) || boundedString(registry[source]?.canonicalRoot, 512),
      hostPath: boundedString(item.hostPath, 1024),
      measuredAt: measuredDate(item.measuredAt, now)
    };
    const capacityBytes = byteCount(item.capacityBytes);
    const freeBytes = byteCount(item.freeBytes);
    if (capacityBytes == null || freeBytes == null || freeBytes > capacityBytes) {
      return { ...report, error: boundedString(item.error, 500) || 'capacity not measured' };
    }
    return {
      ...report,
      capacityBytes,
      freeBytes,
      device: boundedString(item.device, 32),
      mountSource: boundedString(item.mountSource, 512),
      mountPoint: boundedString(item.mountPoint, 1024),
      fsType: boundedString(item.fsType, 64),
      method: boundedString(item.method, 32) || 'statfs'
    };
  });
}

function mountIdentity(report) {
  if (report.device || report.mountSource) return `${report.device || ''}|${report.mountSource || ''}`;
  return `path|${report.hostPath || report.root || report.source}`;
}

function volumeId(host, report) {
  const name = report.mountSource || report.mountPoint || report.hostPath || report.device || report.source;
  return `${host}:${name}`.toLowerCase().replace(/[^a-z0-9:/._-]+/g, '-');
}

// One volume per host and mount identity; the newest measurement wins.
function aggregateVolumes(scanners = [], options = {}) {
  const byKey = new Map();
  for (const scanner of scanners) {
    const host = String(scanner.hostname || scanner.scannerId || 'unknown');
    for (const report of Array.isArray(scanner.volumes) ? scanner.volumes : []) {
      if (report?.capacityBytes == null || report?.freeBytes == null) continue;
      const key = `${host}\u0000${mountIdentity(report)}`;
      const measuredAt = new Date(report.measuredAt || 0);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { host, report, measuredAt, roots: new Set(), scannerIds: new Set() });
      } else if (measuredAt > existing.measuredAt) {
        Object.assign(existing, { report, measuredAt });
      }
      const entry = byKey.get(key);
      if (report.root) entry.roots.add(report.root);
      if (scanner.scannerId) entry.scannerIds.add(scanner.scannerId);
    }
  }
  const root = String(options.root || '').replace(/[\\/]+$/, '');
  return [...byKey.values()]
    .map(({ host, report, measuredAt, roots, scannerIds }) => ({
      id: volumeId(host, report),
      label: report.mountSource || report.mountPoint || report.hostPath || report.source,
      host,
      roots: [...roots].sort(),
      capacityBytes: report.capacityBytes,
      freeBytes: report.freeBytes,
      source: 'measured',
      method: report.method || 'statfs',
      measuredAt: measuredAt.toISOString(),
      filesystem: {
        type: report.fsType || null,
        mountSource: report.mountSource || null,
        mountPoint: report.mountPoint || null,
        device: report.device || null
      },
      scannerIds: [...scannerIds].sort(),
      ...(report.fsType === 'zfs' ? { note: ZFS_NOTE } : {})
    }))
    .filter(volume => !root || volume.roots.includes(root))
    .sort((left, right) => left.id.localeCompare(right.id));
}

module.exports = { MAX_REPORTS, sanitizeVolumeReports, aggregateVolumes, mountIdentity };
