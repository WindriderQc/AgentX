'use strict';

/**
 * Storage growth trends.
 *
 * `nas_scans` keeps only the counters of each scan, so nothing says how the
 * inventory grew. When a scan ends `complete`, one snapshot per scanned root
 * is stored in `storage_trend_snapshots`: the files and bytes of the root and
 * of its folders, read from the directory rollups the scan just rebuilt.
 * One snapshot per root and UTC day (a later scan of the same day replaces
 * it), kept 800 days.
 *
 * Folder rule: every top-level folder, the 40 largest by bytes when there are
 * more (the rest is one `other` entry). When the root has at most 5 top-level
 * folders, the 20 largest children of each are stored too, the rest again as
 * `other`. Files that sit directly in the root or in a top-level folder are a
 * `files` entry, so the entries of a level always add up to its total.
 */

const SNAPSHOTS = 'storage_trend_snapshots';
const SCANS = 'nas_scans';
const DIRECTORIES = 'nas_directories';
const TTL_DAYS = 800;
const MAX_TOP_FOLDERS = 40;
const SECOND_LEVEL_MAX_TOPS = 5;
const MAX_SECOND_PER_TOP = 20;
const MAX_WINDOW_DAYS = TTL_DAYS;
const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_FOLDER_SERIES = 12;
const MAX_FOLDER_SERIES = MAX_TOP_FOLDERS + 2;
const MAX_GROWTH_FOLDERS = 5;
const MAX_ROOTS = 50;
const DAY_MS = 86_400_000;
// Real folder keys are `Name` or `Name/Child`: these can never be one.
const OTHER_KEY = '/other';
const FILES_KEY = '/files';

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function normalizeRoot(root) {
  return String(root || '').replace(/\/+$/, '');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dayOf(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/** Files and bytes per (top-level folder, second-level folder) under a root, from the rollups. */
async function aggregateFolders(db, root) {
  const normalized = normalizeRoot(root);
  return db.collection(DIRECTORIES).aggregate([
    { $match: { path: { $regex: `^${escapeRegex(normalized)}(?:/|$)` } } },
    {
      $project: {
        file_count: 1,
        total_size: 1,
        // '' for the root itself, '/Top/Second/...' below it.
        parts: { $split: [{ $substrBytes: ['$path', Buffer.byteLength(normalized, 'utf8'), -1] }, '/'] }
      }
    },
    {
      $group: {
        _id: {
          top: { $ifNull: [{ $arrayElemAt: ['$parts', 1] }, null] },
          second: { $ifNull: [{ $arrayElemAt: ['$parts', 2] }, null] }
        },
        files: { $sum: { $ifNull: ['$file_count', 0] } },
        bytes: { $sum: { $ifNull: ['$total_size', 0] } }
      }
    }
  ], { allowDiskUse: true }).toArray();
}

function bySizeThenName(a, b) {
  return b.bytes - a.bytes || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function entry(kind, key, name, parent, depth, { files, bytes }, extra = {}) {
  return { key, name, parent, depth, kind, files, bytes, ...extra };
}

/** One level of folders, bounded: the largest `max`, then `other`, then the level's own files. */
function boundedLevel(folders, direct, max, parent) {
  const depth = parent ? 2 : 1;
  const prefix = parent ? `${parent}/` : '';
  const sorted = [...folders].sort(bySizeThenName);
  const entries = sorted.slice(0, max).map(folder => entry('folder', `${prefix}${folder.name}`, folder.name, parent, depth, folder));
  const rest = sorted.slice(max);
  if (rest.length) {
    const sum = rest.reduce((acc, folder) => ({ files: acc.files + folder.files, bytes: acc.bytes + folder.bytes }), { files: 0, bytes: 0 });
    entries.push(entry('other', `${prefix}${OTHER_KEY}`, null, parent, depth, sum, { folders: rest.length }));
  }
  if (direct.files > 0) entries.push(entry('files', `${prefix}${FILES_KEY}`, null, parent, depth, direct));
  return entries;
}

/** Totals and bounded folder entries from the (top, second) groups. Pure. */
function buildFolders(groups) {
  const tops = new Map();
  const rootFiles = { files: 0, bytes: 0 };
  const totals = { files: 0, bytes: 0 };
  for (const group of groups) {
    const files = Number(group.files) || 0;
    const bytes = Number(group.bytes) || 0;
    const { top, second } = group._id || {};
    totals.files += files;
    totals.bytes += bytes;
    if (top === null || top === undefined || top === '') {
      rootFiles.files += files;
      rootFiles.bytes += bytes;
      continue;
    }
    if (!tops.has(top)) tops.set(top, { name: top, files: 0, bytes: 0, direct: { files: 0, bytes: 0 }, children: new Map() });
    const folder = tops.get(top);
    folder.files += files;
    folder.bytes += bytes;
    if (second === null || second === undefined || second === '') {
      folder.direct.files += files;
      folder.direct.bytes += bytes;
    } else {
      const child = folder.children.get(second) || { name: second, files: 0, bytes: 0 };
      child.files += files;
      child.bytes += bytes;
      folder.children.set(second, child);
    }
  }

  const folders = boundedLevel(tops.values(), rootFiles, MAX_TOP_FOLDERS, null);
  const secondLevel = tops.size > 0 && tops.size <= SECOND_LEVEL_MAX_TOPS;
  if (secondLevel) {
    for (const top of [...tops.values()].sort(bySizeThenName)) {
      // A folder without subfolders has nothing a second level would add.
      if (top.children.size === 0) continue;
      folders.push(...boundedLevel(top.children.values(), top.direct, MAX_SECOND_PER_TOP, top.name));
    }
  }
  return { ...totals, topLevelFolders: tops.size, secondLevel, folders };
}

/**
 * Whether a scan's end may be recorded: only a `complete` scan describes the
 * whole root. `partial` (rows kept by the prune guard, unreadable folders),
 * `failed` and `stopped` scans leave an index that mixes two states.
 */
function snapshotEligible(scan) {
  const status = scan?.status === 'completed' ? 'complete' : scan?.status;
  return status === 'complete' && Array.isArray(scan?.config?.roots) && scan.config.roots.length > 0;
}

/** Store one snapshot per root of a complete scan. Returns the snapshots written. */
async function recordSnapshots(db, scan, now = new Date()) {
  if (!snapshotEligible(scan)) return [];
  const at = scan.finished_at ? new Date(scan.finished_at) : now;
  const written = [];
  for (const rawRoot of scan.config.roots.slice(0, 16)) {
    const root = normalizeRoot(rawRoot);
    if (!root) continue;
    const built = buildFolders(await aggregateFolders(db, root));
    const snapshot = {
      root,
      day: dayOf(at),
      at,
      scan_id: String(scan._id),
      source: scan.config.source || null,
      files: built.files,
      bytes: built.bytes,
      top_level_folders: built.topLevelFolders,
      second_level: built.secondLevel,
      folders: built.folders,
      recorded_at: now
    };
    await db.collection(SNAPSHOTS).replaceOne({ root, day: snapshot.day }, snapshot, { upsert: true });
    written.push(snapshot);
  }
  return written;
}

// --- Reading ---

function parseDay(value, name) {
  if (value === undefined || value === '') return null;
  const text = Array.isArray(value) ? '' : String(value);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00.000Z`) : new Date(text);
  if (!text || text.length > 40 || !Number.isFinite(date.getTime())) throw validationError(`${name} must be a date such as 2026-10-08`);
  return dayOf(date);
}

function addDays(day, days) {
  return dayOf(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + days * DAY_MS));
}

/** Validated parameters of a trends read. Throws statusCode 400. */
function parseQuery(query = {}, now = new Date()) {
  let root = null;
  if (query.root !== undefined && query.root !== '') {
    if (typeof query.root !== 'string' || query.root.length > 1024 || !query.root.startsWith('/') || /[\u0000-\u001f]/.test(query.root)) {
      throw validationError('root must be an absolute path');
    }
    root = normalizeRoot(query.root) || '/';
  }
  let folder = null;
  if (query.folder !== undefined && query.folder !== '') {
    if (typeof query.folder !== 'string' || query.folder.length > 600 || /[\u0000-\u001f]/.test(query.folder)) {
      throw validationError('folder must be a folder key of at most 600 characters');
    }
    if (!root) throw validationError('folder requires root');
    folder = query.folder;
  }
  const to = parseDay(query.to, 'to') || dayOf(now);
  const from = parseDay(query.from, 'from') || addDays(to, -DEFAULT_WINDOW_DAYS);
  if (from > to) throw validationError('from must not be after to');
  const days = Math.round((new Date(to) - new Date(from)) / DAY_MS) + 1;
  if (days > MAX_WINDOW_DAYS) throw validationError(`the window must be at most ${MAX_WINDOW_DAYS} days`);
  let limit = DEFAULT_FOLDER_SERIES;
  if (query.limit !== undefined && query.limit !== '') {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FOLDER_SERIES) {
      throw validationError(`limit must be an integer from 1 to ${MAX_FOLDER_SERIES}`);
    }
  }
  return { root, folder, from, to, days, limit };
}

function point(snapshot) {
  return { day: snapshot.day, at: snapshot.at, scanId: snapshot.scan_id, files: snapshot.files, bytes: snapshot.bytes };
}

function describe(folder) {
  const { key, name, parent, depth, kind } = folder;
  return { key, name, parent, depth, kind };
}

/** The entries a series or a comparison is about: one folder, its children, or the top level. */
function scopeOf(folders, folderKey) {
  if (!folderKey) return (folders || []).filter(folder => folder.depth === 1);
  return (folders || []).filter(folder => folder.key === folderKey || folder.parent === folderKey);
}

/**
 * Files and bytes added between two snapshots, and the folders that grew the
 * most. A folder absent from the first snapshot counts from zero only when
 * that snapshot listed every folder of the level: otherwise it may have been
 * inside `other`, and its growth is unknown.
 */
function growthBetween(first, last, folderKey) {
  if (!first || !last || first.day === last.day) return null;
  const before = new Map(scopeOf(first.folders, folderKey).map(folder => [folder.key, folder]));
  const firstHadOther = [...before.values()].some(folder => folder.kind === 'other');
  // Children of a folder are stored only while the root has few top-level folders.
  const levelKnown = !folderKey || [...before.values()].some(folder => folder.parent === folderKey);
  const grown = [];
  for (const folder of scopeOf(last.folders, folderKey)) {
    if (folder.kind !== 'folder' || folder.key === folderKey) continue;
    const previous = before.get(folder.key);
    if (!previous && (firstHadOther || !levelKnown)) continue;
    const fromBytes = previous ? previous.bytes : 0;
    const fromFiles = previous ? previous.files : 0;
    if (folder.bytes - fromBytes <= 0) continue;
    grown.push({
      ...describe(folder), fromBytes, toBytes: folder.bytes,
      bytesAdded: folder.bytes - fromBytes, filesAdded: folder.files - fromFiles
    });
  }
  grown.sort((a, b) => b.bytesAdded - a.bytesAdded);
  const whole = (snapshot) => {
    if (!folderKey) return { files: snapshot.files, bytes: snapshot.bytes };
    const folder = (snapshot.folders || []).find(item => item.key === folderKey);
    return folder ? { files: folder.files, bytes: folder.bytes } : null;
  };
  const start = whole(first);
  const end = whole(last);
  return {
    from: { day: first.day, ...(start || { files: null, bytes: null }) },
    to: { day: last.day, ...(end || { files: null, bytes: null }) },
    days: Math.round((new Date(last.day) - new Date(first.day)) / DAY_MS),
    filesAdded: start && end ? end.files - start.files : null,
    bytesAdded: start && end ? end.bytes - start.bytes : null,
    folders: grown.slice(0, MAX_GROWTH_FOLDERS)
  };
}

async function listRoots(db) {
  const rows = await db.collection(SNAPSHOTS).aggregate([
    { $project: { root: 1, day: 1, at: 1, files: 1, bytes: 1 } },
    { $sort: { root: 1, day: 1 } },
    {
      $group: {
        _id: '$root', snapshots: { $sum: 1 }, firstDay: { $first: '$day' }, lastDay: { $last: '$day' },
        lastAt: { $last: '$at' }, files: { $last: '$files' }, bytes: { $last: '$bytes' }
      }
    },
    { $sort: { _id: 1 } },
    { $limit: MAX_ROOTS }
  ]).toArray();
  return rows.map(({ _id, ...row }) => ({ root: _id, ...row }));
}

/**
 * What completed external scans of this root counted, one point per day.
 * It is NOT part of the totals series: `files_seen` is what a collector
 * walked, the snapshots count index rows, and scans kept no byte total.
 */
async function scanHistory(db, root, from, to) {
  const scans = await db.collection(SCANS).find({
    status: 'complete',
    'config.external': true,
    'config.roots': root,
    finished_at: { $gte: new Date(`${from}T00:00:00.000Z`), $lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS) },
    'counts.files_seen': { $type: 'number' }
  }, { projection: { finished_at: 1, 'counts.files_seen': 1 } })
    .sort({ finished_at: -1 }).limit(MAX_WINDOW_DAYS * 4).toArray();
  const perDay = new Map();
  for (const scan of scans) {
    const day = dayOf(scan.finished_at);
    // Newest first: the first scan met for a day is its last one.
    if (!perDay.has(day)) perDay.set(day, { day, at: scan.finished_at, scanId: String(scan._id), files: scan.counts.files_seen });
  }
  return [...perDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-MAX_WINDOW_DAYS);
}

async function trends(db, query = {}, now = new Date()) {
  const { root, folder, from, to, days, limit } = parseQuery(query, now);
  const limits = {
    maxWindowDays: MAX_WINDOW_DAYS, defaultWindowDays: DEFAULT_WINDOW_DAYS, retentionDays: TTL_DAYS,
    maxFolderSeries: MAX_FOLDER_SERIES, maxTopFolders: MAX_TOP_FOLDERS,
    secondLevelWhenTopFoldersAtMost: SECOND_LEVEL_MAX_TOPS, maxSecondLevelPerFolder: MAX_SECOND_PER_TOP
  };
  const result = {
    root, folder, window: { from, to, days }, roots: await listRoots(db),
    snapshots: 0, totals: [], folders: [], growth: null, scanHistory: null, limits
  };
  if (!root) return result;

  const collection = db.collection(SNAPSHOTS);
  const inWindow = { root, day: { $gte: from, $lte: to } };
  const [first, last] = await Promise.all([
    collection.findOne(inWindow, { sort: { day: 1 } }),
    collection.findOne(inWindow, { sort: { day: -1 } })
  ]);
  if (last) {
    // The series are those of the newest snapshot, largest first.
    const wanted = scopeOf(last.folders, folder)
      .sort((a, b) => (a.key === folder ? -1 : b.key === folder ? 1 : b.bytes - a.bytes)).slice(0, limit);
    const keys = wanted.map(item => item.key);
    const snapshots = await collection.find(inWindow, {
      projection: {
        day: 1, at: 1, scan_id: 1, files: 1, bytes: 1,
        folders: { $filter: { input: '$folders', as: 'folder', cond: { $in: ['$$folder.key', keys] } } }
      }
    }).sort({ day: 1 }).limit(MAX_WINDOW_DAYS).toArray();
    result.snapshots = snapshots.length;
    result.totals = snapshots.map(point);
    result.folders = wanted.map(item => ({
      ...describe(item),
      points: snapshots.flatMap(snapshot => {
        const found = (snapshot.folders || []).find(candidate => candidate.key === item.key);
        return found ? [{ day: snapshot.day, files: found.files, bytes: found.bytes }] : [];
      })
    }));
    result.growth = growthBetween(first, last, folder);
  }
  result.scanHistory = {
    measure: 'files_seen',
    comparableWithTotals: false,
    note: 'Files walked by completed collector scans, from nas_scans. Not index rows, and no byte total: never drawn on the totals line.',
    points: await scanHistory(db, root, from, to)
  };
  return result;
}

module.exports = {
  SNAPSHOTS,
  TTL_DAYS,
  MAX_TOP_FOLDERS,
  SECOND_LEVEL_MAX_TOPS,
  MAX_SECOND_PER_TOP,
  MAX_WINDOW_DAYS,
  MAX_FOLDER_SERIES,
  OTHER_KEY,
  FILES_KEY,
  aggregateFolders,
  buildFolders,
  snapshotEligible,
  recordSnapshots,
  parseQuery,
  growthBetween,
  trends
};
