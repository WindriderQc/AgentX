const fs = require('fs/promises');
const { createReadStream } = require('fs');
const { createHash } = require('crypto');
const path = require('path');
const EventEmitter = require('events');
const { classifyFileMetadata } = require('../utils/fileMetadata');
const candidateHasher = require('./candidateHasher');

/**
 * Compute SHA256 hash of a file using streaming (memory-efficient)
 */
async function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rootPathFilter(root) {
  const normalized = String(root).replace(/[\\/]+$/, '');
  return { path: { $regex: `^${escapeRegex(normalized)}(?:[\\/]|$)` } };
}

// Removes index rows a finished scan did not see, one root at a time. A root
// where the scan indexed nothing keeps its rows: an unmounted or emptied
// mountpoint walks as a clean, empty directory and must not erase the index
// and the hashes accumulated for it.
async function pruneStaleFiles(filesCol, roots, scanId) {
  let removed = 0;
  const skippedRoots = [];
  for (const root of roots || []) {
    const scope = rootPathFilter(root);
    const indexedByScan = await filesCol.countDocuments({ ...scope, scan_id: scanId }, { limit: 1 });
    if (indexedByScan === 0) {
      const retained = await filesCol.countDocuments(scope, { limit: 1 });
      if (retained > 0) skippedRoots.push(root);
      continue;
    }
    const stale = await filesCol.deleteMany({ ...scope, scan_id: { $ne: scanId } });
    removed += stale.deletedCount || 0;
  }
  return { removed, skippedRoots };
}

function pruneSkippedMessage(skippedRoots) {
  return `Scan indexed no file under ${skippedRoots.join(', ')}; existing index rows were kept`;
}

async function rebuildDirectoryRollups(filesCol, dirsCol, roots = []) {
  const now = new Date();
  const normalizedRoots = roots.map(root => String(root).replace(/[\\/]+$/, '')).filter(Boolean);
  const pipeline = [];
  if (normalizedRoots.length > 0) {
    pipeline.push({
      $match: normalizedRoots.length === 1
        ? { source_root: normalizedRoots[0] }
        : { source_root: { $in: normalizedRoots } }
    });
  }
  pipeline.push(
    { $sort: { dirname: 1, size: -1, path: 1 } },
    {
      $group: {
        _id: '$dirname',
        file_count: { $sum: 1 },
        total_size: { $sum: { $ifNull: ['$size', 0] } },
        largest_file: { $first: '$path' },
        largest_file_size: { $first: { $ifNull: ['$size', 0] } },
        latest_mtime: { $max: '$mtime' }
      }
    },
    {
      $project: {
        _id: 0,
        path: '$_id',
        file_count: 1,
        total_size: 1,
        largest_file: 1,
        largest_file_size: 1,
        latest_mtime: 1
      }
    }
  );
  const cursor = filesCol.aggregate(pipeline, { allowDiskUse: true });

  let count = 0;
  let batch = [];

  async function flushDirs() {
    if (!batch.length) return;
    await dirsCol.bulkWrite(batch, { ordered: false });
    batch = [];
  }

  for await (const dir of cursor) {
    const pathValue = dir.path || '/';
    count++;
    batch.push({
      updateOne: {
        filter: { path: pathValue },
        update: {
          $set: {
            ...dir,
            path: pathValue,
            rollup_at: now,
            updated_at: now
          },
          $setOnInsert: { created_at: now }
        },
        upsert: true
      }
    });

    if (batch.length >= 1000) await flushDirs();
  }

  await flushDirs();
  const staleRollups = { rollup_at: { $ne: now } };
  if (normalizedRoots.length > 0) {
    staleRollups.$or = normalizedRoots.map(root => rootPathFilter(root));
  }
  await dirsCol.deleteMany(staleRollups);
  return count;
}

class Scanner extends EventEmitter {
  constructor(db) {
    super();
    this.db = db;
    this.stopFlag = false;
  }

  stop() { this.stopFlag = true; }

  async run(opts) {
    const filesCol = this.db.collection('nas_files');
    const scansCol = this.db.collection('nas_scans');
    const dirsCol = this.db.collection('nas_directories');

    const start = new Date();
    const includeExt = new Set((opts.includeExt || []).map(s => s.toLowerCase()));
    const excludeExt = new Set((opts.excludeExt || []).map(s => s.toLowerCase()));
    const batchSize = Number(opts.batchSize || 1000);
    const hashMode = ['none', 'all', 'candidates'].includes(opts.hashMode)
      ? opts.hashMode
      : (opts.computeHashes === true ? 'all' : 'none');
    const computeHashes = hashMode === 'all';
    const hashMaxSize = hashMode === 'all'
      ? Number(opts.hashMaxSize || 100 * 1024 * 1024)
      : (opts.hashMaxSize == null ? null : Number(opts.hashMaxSize));

    let counts = {
      files_seen: 0, upserts: 0, skipped: 0, errors: 0, batches: 0,
      hashed: 0, hash_bytes: 0, candidate_groups: 0, stale_removed: 0
    };
    let batch = [];
    const visitedDirs = new Set();

    const updateScan = async (patch) => {
      await scansCol.updateOne({ _id: opts.scanId }, { $set: patch }, { upsert: true });
    };

    await updateScan({
      status: 'running',
      started_at: start,
      counts,
      config: {
        roots: opts.roots,
        extensions: opts.includeExt || [],
        exclude_extensions: opts.excludeExt || [],
        batch_size: batchSize,
        compute_hashes: computeHashes,
        hash_mode: hashMode,
        hash_max_size: hashMaxSize,
        hash_max_files: opts.hashMaxFiles || null,
        hash_max_bytes: opts.hashMaxBytes || null
      }
    });

    async function flush() {
      if (!batch.length) return;
      counts.batches++;
      try {
        const res = await filesCol.bulkWrite(batch, { ordered: false });
        counts.upserts += (res.upsertedCount || 0) + (res.modifiedCount || 0);
      } catch (e) {
        counts.errors++;
        await updateScan({ counts, last_error: String(e && e.message || e) });
      }
      batch = [];
      await updateScan({ counts });
    }

    const stack = opts.roots.map(root => ({ dir: root, root }));
    while (stack.length && !this.stopFlag) {
      const { dir, root } = stack.pop();
      let realDir;
      try {
        realDir = await fs.realpath(dir);
      } catch (e) {
        counts.errors++;
        await updateScan({ counts, last_error: `realpath ${dir}: ${e}` });
        continue;
      }

      if (visitedDirs.has(realDir)) {
        counts.skipped++;
        continue;
      }
      visitedDirs.add(realDir);

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        counts.errors++;
        await updateScan({ counts, last_error: `readdir ${dir}: ${e}` });
        continue;
      }

      for (const ent of entries) {
        if (this.stopFlag) break;
        const p = path.join(dir, ent.name);
        if (ent.isSymbolicLink()) { counts.skipped++; continue; }
        if (ent.isDirectory()) { stack.push({ dir: p, root }); continue; }
        if (!ent.isFile()) continue;

        const ext = path.extname(ent.name).slice(1).toLowerCase();
        if (includeExt.size && !includeExt.has(ext)) { counts.skipped++; continue; }
        if (excludeExt.size && excludeExt.has(ext)) { counts.skipped++; continue; }

        let st;
        try { st = await fs.stat(p); }
        catch { counts.skipped++; continue; }

        counts.files_seen++;
        const relativePath = path.relative(root, p);
        const relativeParts = relativePath.split(path.sep).filter(Boolean);
        const mtime = Math.floor(st.mtimeMs / 1000);
        const classification = classifyFileMetadata({
          path: p,
          relativePath,
          extension: ext,
          size: st.size,
          mtime
        });
        const d = {
          path: p,
          dirname: path.dirname(p),
          filename: path.basename(p),
          ext,
          extension: ext,
          ...classification,
          size: st.size,
          mtime,
          modified: new Date(st.mtimeMs),
          ctime: Math.floor(st.ctimeMs / 1000),
          birthtime: Math.floor(st.birthtimeMs / 1000),
          source_root: root,
          relative_path: relativePath,
          top_level: relativeParts.length > 1 ? relativeParts[0] : '',
          depth: Math.max(0, relativeParts.length - 1),
          metadata_fingerprint: `${st.size}:${mtime}`,
          scan_id: opts.scanId,
          scan_seen_at: new Date(),
          updated_at: new Date()
        };

        if (computeHashes && st.size <= hashMaxSize) {
          try {
            d.sha256 = await computeFileHash(p);
            d.hash_fingerprint = d.metadata_fingerprint;
            d.hashed_at = new Date();
            d.hash_strategy = 'full-scan';
            counts.hashed++;
            counts.hash_bytes += st.size;
          } catch (hashErr) {
            d.hash_error = String(hashErr.message || hashErr);
          }
        }

        batch.push({
          updateOne: {
            filter: { path: p },
            update: { $set: d, $setOnInsert: { ingested_at: new Date() } },
            upsert: true
          }
        });

        if (batch.length >= batchSize) await flush();
        if (counts.files_seen % 5000 === 0) {
          await updateScan({ counts, last_path: p });
          this.emit('tick', counts);
        }
      }
    }

    await flush();
    let pruneWithheld = null;
    if (!this.stopFlag && includeExt.size === 0 && excludeExt.size === 0 && typeof filesCol.deleteMany === 'function') {
      if (counts.errors > 0) {
        // An unreadable directory or a failed batch leaves real files unstamped.
        pruneWithheld = `Scan had ${counts.errors} error(s); existing index rows were kept`;
      } else {
        const pruned = await pruneStaleFiles(filesCol, opts.roots, opts.scanId);
        counts.stale_removed += pruned.removed;
        if (pruned.skippedRoots.length) pruneWithheld = pruneSkippedMessage(pruned.skippedRoots);
      }
      if (pruneWithheld) await updateScan({ counts, last_error: pruneWithheld });
    }

    if (!this.stopFlag && hashMode === 'candidates') {
      await updateScan({ status: 'hashing', counts });
      const candidateCounts = await candidateHasher.hashDuplicateCandidates(this.db, {
        roots: opts.roots,
        maxFiles: opts.hashMaxFiles,
        maxBytes: opts.hashMaxBytes,
        minSize: opts.hashMinSize,
        maxFileSize: hashMaxSize || candidateHasher.DEFAULT_MAX_FILE_SIZE,
        shouldStop: () => this.stopFlag,
        onProgress: async progress => {
          counts = {
            ...counts,
            hashed: progress.hashed,
            hash_bytes: progress.hash_bytes,
            candidate_groups: progress.candidate_groups,
            candidate_files: progress.candidate_files,
            candidate_bytes: progress.candidate_bytes,
            candidate_groups_selected: progress.selected_groups,
            candidate_groups_complete: progress.complete_groups,
            candidate_groups_partial: progress.partial_groups,
            candidate_groups_deferred: progress.deferred_groups,
            candidate_files_deferred: progress.deferred_files,
            candidate_bytes_deferred: progress.deferred_bytes,
            candidate_groups_oversized: progress.oversized_groups,
            candidate_files_oversized: progress.oversized_files,
            candidate_bytes_oversized: progress.oversized_bytes,
            hash_errors: progress.errors
          };
          await updateScan({ counts });
        }
      });
      counts.hashed = candidateCounts.hashed;
      counts.hash_bytes = candidateCounts.hash_bytes;
      counts.candidate_groups = candidateCounts.candidate_groups;
      counts.candidate_files = candidateCounts.candidate_files;
      counts.candidate_bytes = candidateCounts.candidate_bytes;
      counts.candidate_groups_selected = candidateCounts.selected_groups;
      counts.candidate_groups_complete = candidateCounts.complete_groups;
      counts.candidate_groups_partial = candidateCounts.partial_groups;
      counts.candidate_groups_deferred = candidateCounts.deferred_groups;
      counts.candidate_files_deferred = candidateCounts.deferred_files;
      counts.candidate_bytes_deferred = candidateCounts.deferred_bytes;
      counts.candidate_groups_oversized = candidateCounts.oversized_groups;
      counts.candidate_files_oversized = candidateCounts.oversized_files;
      counts.candidate_bytes_oversized = candidateCounts.oversized_bytes;
      counts.hash_errors = candidateCounts.errors;
    }

    const end = new Date();
    const status = this.stopFlag ? 'stopped' : (pruneWithheld ? 'partial' : 'complete');
    let rollupsRebuilt = false;
    try {
      counts.directories = await rebuildDirectoryRollups(filesCol, dirsCol, opts.roots);
      rollupsRebuilt = true;
    } catch (e) {
      counts.errors++;
      await updateScan({ counts, last_error: `directory rollup: ${e && e.message || e}` });
    }
    await updateScan({ status, finished_at: end, counts });
    this.emit('done', {
      status, counts, started_at: start, finished_at: end, last_error: pruneWithheld,
      // What a growth snapshot needs to know: the rollups are current, and
      // the scan looked at every file (an extension filter never prunes).
      rollups_rebuilt: rollupsRebuilt, filtered: includeExt.size > 0 || excludeExt.size > 0
    });
  }
}

module.exports = { Scanner, computeFileHash, rebuildDirectoryRollups, pruneStaleFiles, pruneSkippedMessage };
