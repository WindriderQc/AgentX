'use strict';

// Shapes of Data's /api/v1/exports, /api/v1/events and /api/v1/storage/trends
// answers. Roots, folders, hosts and figures are synthetic.

const DAY_MS = 86400000;
const GIB = 1024 ** 3;
const HOSTILE = '<script>alert(1)</script>';
const HOSTILE_ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

const TREND_LIMITS = { maxWindowDays: 800, defaultWindowDays: 90, retentionDays: 800, maxFolderSeries: 42, maxTopFolders: 40, secondLevelWhenTopFoldersAtMost: 5, maxSecondLevelPerFolder: 20 };
const TOP_FOLDERS = [['Videos', 0.56], ['Photos', 0.24], ['Backups', 0.12], ['Music', 0.05]];
const CHILD_FOLDERS = [['2024', 0.5], ['2025', 0.3], ['2026', 0.15]];

/** `count` days ending on `end`, oldest first, one every `every` days. */
function trendDays(count, end = '2026-10-08', every = 1) {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => dayOf(last - (count - 1 - index) * every * DAY_MS));
}

function entriesOf(parent, shares, withOther) {
  const prefix = parent ? `${parent}/` : '';
  const used = shares.reduce((sum, [, share]) => sum + share, 0);
  return [
    ...shares.map(([name, share]) => ({ key: `${prefix}${name}`, name, parent, depth: parent ? 2 : 1, kind: 'folder', share })),
    ...(withOther ? [{ key: `${prefix}/other`, name: null, parent, depth: parent ? 2 : 1, kind: 'other', share: (1 - used) * 0.6 }] : []),
    { key: `${prefix}/files`, name: null, parent, depth: parent ? 2 : 1, kind: 'files', share: (1 - used) * (withOther ? 0.4 : 1) }
  ];
}

/**
 * One answer of GET /storage/trends?root=. `count` snapshots; the root grows
 * by about 1.5 GiB and 40 files a day from 4 TiB and 220 000 files.
 */
function trendsData({ root = '/mnt/archive', count = 60, every = 1, end = '2026-10-08', folder = null, tops = TOP_FOLDERS, withOther = false, walked = 12, roots } = {}) {
  const days = trendDays(count, end, every);
  const span = (index) => index * every;
  const totals = days.map((day, index) => ({
    day, at: `${day}T07:03:09.280Z`, scanId: `scan${String(index).padStart(20, '0')}`,
    // A steady growth, one large arrival at 40% of the series and one cleanup at 70%.
    files: 220000 + span(index) * 40 + (index % 7 === 3 ? 25 : 0) + (index >= count * 0.4 ? 1800 : 0) - (index >= count * 0.7 ? 2600 : 0),
    bytes: Math.round(4096 * GIB + span(index) * 1.5 * GIB + (index % 5) * 0.2 * GIB + (index >= count * 0.4 ? 90 * GIB : 0) - (index >= count * 0.7 ? 60 * GIB : 0))
  }));
  const describe = ({ key, name, parent, depth, kind }) => ({ key, name, parent, depth, kind });
  const series = (entry, scale = 1) => ({ ...describe(entry), points: totals.map((point) => ({ day: point.day, files: Math.round(point.files * entry.share * scale), bytes: Math.round(point.bytes * entry.share * scale) })) });
  let folders = [];
  let whole = totals.map((point) => ({ files: point.files, bytes: point.bytes }));
  if (count > 0 && !folder) folders = entriesOf(null, tops, withOther).map((entry) => series(entry));
  if (count > 0 && folder) {
    const top = entriesOf(null, tops, withOther).find((entry) => entry.key === folder);
    if (top) {
      whole = totals.map((point) => ({ files: Math.round(point.files * top.share), bytes: Math.round(point.bytes * top.share) }));
      folders = [series(top), ...(tops.length <= 5 ? entriesOf(folder, CHILD_FOLDERS, true).map((entry) => series(entry, top.share)) : [])];
    }
  }
  const first = whole[0]; const last = whole.at(-1);
  const grown = folders.filter((entry) => entry.kind === 'folder' && entry.key !== folder && entry.points.length > 1).map((entry) => ({
    ...describe(entry), fromBytes: entry.points[0].bytes, toBytes: entry.points.at(-1).bytes,
    bytesAdded: entry.points.at(-1).bytes - entry.points[0].bytes, filesAdded: entry.points.at(-1).files - entry.points[0].files
  })).filter((entry) => entry.bytesAdded > 0).sort((a, b) => b.bytesAdded - a.bytesAdded).slice(0, 5);
  const growth = count > 1 && folders.length ? {
    from: { day: days[0], ...first }, to: { day: days.at(-1), ...last }, days: span(count - 1),
    filesAdded: last.files - first.files, bytesAdded: last.bytes - first.bytes, folders: grown
  } : count > 1 ? { from: { day: days[0], files: null, bytes: null }, to: { day: days.at(-1), files: null, bytes: null }, days: span(count - 1), filesAdded: null, bytesAdded: null, folders: [] } : null;
  return {
    root, folder, window: { from: dayOf(Date.parse(`${end}T00:00:00Z`) - 90 * DAY_MS), to: end, days: 91 },
    roots: roots || (count ? [{ root, snapshots: count, firstDay: days[0], lastDay: days.at(-1), lastAt: totals.at(-1).at, files: totals.at(-1).files, bytes: totals.at(-1).bytes }] : []),
    snapshots: count, totals, folders, growth,
    scanHistory: {
      measure: 'files_seen', comparableWithTotals: false,
      note: 'Files walked by completed collector scans, from nas_scans. Not index rows, and no byte total: never drawn on the totals line.',
      points: trendDays(walked, end).map((day, index) => ({ day, at: `${day}T07:00:54.836Z`, scanId: `walk${String(index).padStart(20, '0')}`, files: 219500 + index * 37 }))
    },
    limits: TREND_LIMITS
  };
}

/** The answer without `root`: only the roots that have snapshots. */
const trendsIndex = (roots) => ({ root: null, folder: null, window: { from: '2026-07-10', to: '2026-10-08', days: 91 }, roots, snapshots: 0, totals: [], folders: [], growth: null, scanHistory: null, limits: TREND_LIMITS });

const sourcesBody = (roots = { archive: '/mnt/archive', photos: '/mnt/photos' }) => ({
  scanners: [{ scannerId: 'nas-storage', hostname: 'nas', platform: 'linux', sources: Object.keys(roots), lastSeen: '2026-10-08T22:00:00.000Z', active: true }],
  sources: Object.fromEntries(Object.entries(roots).map(([name, canonicalRoot]) => [name, { canonicalRoot, executionCapable: false }]))
});

const REPORT_LIMITS = { maxReports: 20, maxTotalBytes: 1073741824, maxTotalBytesFormatted: '1 GB' };
const reportName = (type, format, suffix = 'a1b2c3', stamp = '2026-10-08_21-17-19') => `export_${type}_${stamp}_${suffix}.${format}`;
const report = (overrides = {}) => {
  const base = { type: 'summary', format: 'csv', status: 'ready', size: 2552005, createdAt: '2026-10-08T21:17:20.402Z', requestedAt: '2026-10-08T21:17:19.963Z', recordCount: 271830, skippedCount: 0, error: null, ...overrides };
  if (base.status !== 'ready') Object.assign(base, { size: null, recordCount: null, skippedCount: null, createdAt: base.status === 'failed' ? base.createdAt : null, ...overrides });
  return { filename: reportName(base.type, base.format), sizeFormatted: base.size == null ? null : `${(base.size / 1048576).toFixed(2)} MB`, ...base };
};
const reportsBody = (reports = [report()]) => ({ reports, totalSize: reports.reduce((sum, item) => sum + (item.status === 'ready' ? item.size : 0), 0), limits: REPORT_LIMITS });

let eventSeq = 0;
const event = (type, severity, message, meta = {}, at = '2026-10-08T21:00:00.000Z') => ({ id: `e${String(++eventSeq).padStart(23, '0')}`, type, severity, message, meta, at });

/** `count` events ending at `end`, newest first, twenty minutes apart. */
function eventLog(count = 8, end = Date.parse('2026-10-08T21:00:00.000Z')) {
  const kinds = [
    ['storage.scan_finished', 'info', 'Storage scan of archive finished: complete.', { outcome: 'complete', source: 'archive', counts: { files_seen: 221299, errors: 0 }, roots: ['/mnt/archive'] }],
    ['collector.silent', 'warning', 'Collector nas-storage has not reported for 5 minutes.', { kind: 'storage', collectorId: 'nas-storage' }],
    ['network.device_first_seen', 'info', 'New network device 192.168.50.23 (printer-hall).', { ip: '192.168.50.23', mac: 'AA:BB:CC:00:00:23', vendor: 'Example Devices', hostname: 'printer-hall' }],
    ['storage.scan_expired', 'error', 'Storage scan of photos expired: no collector heartbeat for 10 minutes.', { source: 'photos', reason: 'heartbeat' }],
    ['gpu.host_stale', 'warning', 'GPU host bench-a has had no sample for 5 minutes.', { hostId: 'bench-a', lastError: 'connect ETIMEDOUT' }],
    ['mqtt.monitor_connected', 'info', 'MQTT monitor connected again.', {}],
    ['livedata.feed_failing', 'warning', 'Live feed quakes is failing.', { feed: 'quakes', failures: 3 }],
    ['janitor.run_finished', 'info', 'Janitor run of shared-drive finished: complete.', { status: 'complete', profile: 'shared-drive' }]
  ];
  return Array.from({ length: count }, (_, index) => {
    const [type, severity, message, meta] = kinds[index % kinds.length];
    return event(type, severity, message, meta, new Date(end - index * 20 * 60000).toISOString());
  });
}

/** What GET /events answers for `query` (a URLSearchParams) over `events`, as Data filters and pages. */
function eventsAnswer(events, query) {
  const get = (name) => query.get?.(name) ?? null;
  const since = get('since') ? new Date(/^\d+$/.test(get('since')) ? Number(get('since')) : get('since')).getTime() : null;
  const matching = events.filter((item) => (!get('type') || item.type.startsWith(get('type'))) && (!get('severity') || item.severity === get('severity'))
    && (since === null || new Date(item.at).getTime() >= since)).sort((a, b) => new Date(b.at) - new Date(a.at));
  const limit = Math.min(200, Number(get('limit')) || 50); const page = Math.min(500, Number(get('page')) || 1);
  const filters = Object.fromEntries(['type', 'severity'].filter((name) => get(name)).map((name) => [name, get(name)]));
  return { events: matching.slice((page - 1) * limit, page * limit), pagination: { total: matching.length, page, limit, pages: Math.ceil(matching.length / limit) }, filters };
}

module.exports = {
  DAY_MS, GIB, HOSTILE, HOSTILE_ESCAPED, TREND_LIMITS, TOP_FOLDERS, trendDays, trendsData, trendsIndex, sourcesBody,
  REPORT_LIMITS, reportName, report, reportsBody, event, eventLog, eventsAnswer
};
