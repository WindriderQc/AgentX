'use strict';

const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 * 1024;
const DEFAULT_MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;
const DEFAULT_GROUP_LIMIT = 5000;
// The queue is deliberately value-oriented, but it is never a reclaimable-space
// estimate. A group must still receive current SHA-256 evidence before any
// explicit review action can be considered.
const CANDIDATE_QUEUE_ORDER = Object.freeze([
  'potential_duplicate_bytes_desc',
  'file_size_desc'
]);
const CANDIDATE_GROUP_SORT = Object.freeze({ potential_waste: -1, _id: -1 });

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rootMatch(roots) {
  const clauses = (roots || []).map(root => ({
    path: { $regex: `^${escapeRegex(String(root).replace(/[\\/]+$/, ''))}(?:[\\/]|$)` }
  }));
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

function hashFingerprint(file) {
  return `${Number(file.size || 0)}:${Number(file.mtime || 0)}`;
}

function hasCurrentHash(file) {
  return !!file.sha256 && file.hash_fingerprint === hashFingerprint(file);
}

function currentHashExpression() {
  return {
    $and: [
      { $ne: [{ $ifNull: ['$sha256', ''] }, ''] },
      {
        $eq: [
          '$hash_fingerprint',
          { $concat: [{ $toString: '$size' }, ':', { $toString: '$mtime' }] }
        ]
      }
    ]
  };
}

function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function findCandidateGroups(files, options = {}) {
  const minSize = Math.max(1, Number(options.minSize || 1));
  const maxFileSize = Math.max(minSize, Number(options.maxFileSize || DEFAULT_MAX_FILE_SIZE));
  const groupLimit = Math.max(1, Number(options.groupLimit || DEFAULT_GROUP_LIMIT));
  const match = {
    ...rootMatch(options.roots),
    size: { $gte: minSize, $lte: maxFileSize }
  };

  return files.aggregate([
    { $match: match },
    {
      $group: {
        _id: '$size',
        count: { $sum: 1 },
        current_hashed: { $sum: { $cond: [currentHashExpression(), 1, 0] } }
      }
    },
    { $match: { count: { $gt: 1 }, $expr: { $lt: ['$current_hashed', '$count'] } } },
    { $addFields: { potential_waste: { $multiply: ['$_id', { $subtract: ['$count', 1] }] } } },
    { $sort: CANDIDATE_GROUP_SORT },
    { $limit: groupLimit }
  ], { allowDiskUse: true }).toArray();
}

/**
 * Incrementally hash only files that can plausibly be duplicates: files sharing
 * an exact byte size. Large groups may progress over multiple runs. Every pair
 * of matching current SHA256 values is exact proof even while other members of
 * that size group remain candidates.
 */
async function hashDuplicateCandidates(db, options = {}) {
  const files = db.collection('nas_files');
  const maxFiles = Math.max(1, Number(options.maxFiles || DEFAULT_MAX_FILES));
  const maxBytes = Math.max(1, Number(options.maxBytes || DEFAULT_MAX_BYTES));
  const shouldStop = options.shouldStop || (() => false);
  const computeHash = options.computeHash || computeFileHash;
  const onProgress = options.onProgress || (async () => {});
  const groups = await findCandidateGroups(files, options);

  const result = {
    candidate_groups: groups.length,
    candidate_files: groups.reduce((sum, group) => sum + Number(group.count || 0), 0),
    candidate_bytes: groups.reduce((sum, group) => sum + Number(group._id || 0) * Number(group.count || 0), 0),
    selected_groups: 0,
    hashed: 0,
    hash_bytes: 0,
    already_hashed: 0,
    complete_groups: 0,
    partial_groups: 0,
    deferred_groups: 0,
    deferred_files: 0,
    deferred_bytes: 0,
    oversized_groups: 0,
    oversized_files: 0,
    oversized_bytes: 0,
    errors: 0,
    stopped: false
  };
  let budgetBytesRead = 0;
  let budgetFilesRead = 0;

  for (const group of groups) {
    if (shouldStop()) {
      result.stopped = true;
      break;
    }

    const count = Number(group.count || 0);
    const currentHashed = Number.isFinite(Number(group.current_hashed))
      ? Number(group.current_hashed)
      : (group.files || []).filter(hasCurrentHash).length;
    const missingCount = Math.max(0, count - currentHashed);
    result.already_hashed += currentHashed;
    if (missingCount === 0) {
      result.complete_groups++;
      continue;
    }

    const size = Number(group._id || 0);
    if (size > maxBytes) {
      result.oversized_groups++;
      result.oversized_files += missingCount;
      result.oversized_bytes += size * missingCount;
      result.deferred_groups++;
      result.deferred_files += missingCount;
      result.deferred_bytes += size * missingCount;
      if (currentHashed > 0) result.partial_groups++;
      continue;
    }

    const availableFiles = Math.max(0, maxFiles - budgetFilesRead);
    const availableBytes = Math.max(0, maxBytes - budgetBytesRead);
    const take = Math.min(missingCount, availableFiles, Math.floor(availableBytes / size));
    if (take <= 0) {
      result.deferred_groups++;
      result.deferred_files += missingCount;
      result.deferred_bytes += size * missingCount;
      if (currentHashed > 0) result.partial_groups++;
      continue;
    }

    // Query only the bounded missing slice. This avoids BSON-size and memory
    // hazards for huge same-size groups while allowing deterministic progress.
    const missing = group.files
      ? group.files.filter(file => !hasCurrentHash(file)).slice(0, take)
      : await files.find(
        {
          ...rootMatch(options.roots),
          size: group._id,
          $expr: { $not: [currentHashExpression()] }
        },
        { projection: { _id: 1, path: 1, size: 1, mtime: 1, sha256: 1, hash_fingerprint: 1 } }
      ).limit(take).toArray();

    result.selected_groups++;
    let completedThisRun = 0;
    for (const file of missing) {
      if (shouldStop()) {
        result.stopped = true;
        break;
      }
      try {
        budgetFilesRead++;
        budgetBytesRead += Number(file.size || 0);
        const sha256 = await computeHash(file.path);
        const update = await files.updateOne(
          { _id: file._id, size: file.size, mtime: file.mtime },
          {
            $set: {
              sha256,
              hash_fingerprint: hashFingerprint(file),
              hashed_at: new Date(),
              hash_strategy: 'duplicate-size-candidate'
            }
          }
        );
        if (update.matchedCount !== 1) {
          result.errors++;
          continue;
        }
        result.hashed++;
        result.hash_bytes += Number(file.size || 0);
        completedThisRun++;
      } catch (_) {
        result.errors++;
      }
      if ((result.hashed + result.errors) % 25 === 0) await onProgress({ ...result });
    }
    const remaining = Math.max(0, missingCount - completedThisRun);
    if (remaining === 0) result.complete_groups++;
    else {
      result.deferred_groups++;
      result.deferred_files += remaining;
      result.deferred_bytes += size * remaining;
      if (currentHashed + completedThisRun > 0) result.partial_groups++;
    }
    if (result.stopped) break;
  }

  await onProgress({ ...result });
  return result;
}

module.exports = {
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILE_SIZE,
  CANDIDATE_QUEUE_ORDER,
  CANDIDATE_GROUP_SORT,
  hashFingerprint,
  hasCurrentHash,
  currentHashExpression,
  findCandidateGroups,
  hashDuplicateCandidates,
  computeFileHash
};
