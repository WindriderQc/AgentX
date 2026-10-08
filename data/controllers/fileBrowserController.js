const path = require('path');
const { formatFileSize } = require('../utils/file-operations');
const { formatFilePath } = require('../utils/fileHelpers');
const { categoryToExts } = require('../utils/categories');
const dedupScanner = require('../services/dedupScanner');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathScope(root) {
  if (!root) return {};
  const normalized = String(root).replace(/[\\/]+$/, '');
  return { path: { $regex: `^${escapeRegex(normalized)}(?:[\\/]|$)` } };
}

function buildFileScope(query = {}) {
  const root = String(query.root || '').trim();
  const filter = pathScope(root);
  const ext = String(query.ext || '').trim().toLowerCase().replace(/^\./, '');
  const category = String(query.category || '').trim().toLowerCase();
  const dirname = String(query.dirname || '').trim();

  if (ext) {
    filter.ext = ext;
  } else if (category) {
    if (category !== 'unclassified' && !categoryToExts(category)) {
      return { root, filter, error: `Unknown file category: ${category}` };
    }
    filter.category = category;
  }
  if (dirname) filter.dirname = { $regex: `^${escapeRegex(dirname)}`, $options: 'i' };

  const exactFields = [
    ['storageRole', 'storage_role'],
    ['extensionStatus', 'extension_status'],
    ['timestampQuality', 'timestamp_quality'],
    ['topLevel', 'top_level']
  ];
  for (const [queryName, fieldName] of exactFields) {
    const value = String(query[queryName] || '').trim();
    if (value) filter[fieldName] = value;
  }

  return { root, filter, error: null };
}

function currentHashExpression() {
  return {
    $eq: [
      '$hash_fingerprint',
      { $concat: [{ $toString: '$size' }, ':', { $toString: '$mtime' }] }
    ]
  };
}

class FileBrowserController {
  static async browseFiles(req, res, next) {
    try {
      const db = req.app.locals.db;
      const files = db.collection('nas_files');

      const {
        search = '', includeDirname = 'false', scan_id = '', hasHash = '',
        minSize = 0, maxSize = Infinity,
        sortBy = 'mtime', sortOrder = 'desc', page = 1, limit = 100
      } = req.query;

      const allowedSortFields = ['mtime', 'size', 'filename', 'ext', 'dirname', 'created_at', 'updated_at'];
      const safeSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'mtime';
      const parsedPage = Math.max(1, parseInt(page) || 1);
      const parsedLimit = Math.min(500, Math.max(1, parseInt(limit) || 100));

      const scope = buildFileScope(req.query);
      if (scope.error) {
        return res.status(400).json({ status: 'error', message: scope.error });
      }
      const filter = scope.filter;
      if (search) {
        const pattern = { $regex: escapeRegex(search), $options: 'i' };
        if (includeDirname === 'true') {
          filter.$and = [...(filter.$and || []), { $or: [{ filename: pattern }, { dirname: pattern }] }];
        } else {
          filter.filename = pattern;
        }
      }
      if (scan_id) filter.scan_id = scan_id;
      if (hasHash === 'true') filter.sha256 = { $exists: true, $ne: null };
      else if (hasHash === 'false') filter.$or = [{ sha256: { $exists: false } }, { sha256: null }];
      if (minSize > 0 || maxSize < Infinity) {
        filter.size = {};
        if (minSize > 0) filter.size.$gte = parseInt(minSize);
        if (maxSize < Infinity) filter.size.$lte = parseInt(maxSize);
      }

      const skip = (parsedPage - 1) * parsedLimit;
      const sort = { [safeSortBy]: sortOrder === 'asc' ? 1 : -1 };

      const [totalCount, results] = await Promise.all([
        files.countDocuments(filter),
        files.find(filter).sort(sort).skip(skip).limit(parsedLimit).toArray()
      ]);

      const formattedResults = results.map(file => ({
        ...file,
        path: formatFilePath(file),
        sizeFormatted: formatFileSize(file.size),
        mtimeFormatted: new Date(file.mtime * 1000).toISOString()
      }));

      res.json({
        status: 'success',
        data: {
          files: formattedResults,
          pagination: {
            total: totalCount, page: parsedPage,
            limit: parsedLimit, pages: Math.ceil(totalCount / parsedLimit)
          }
        }
      });
    } catch (error) { next(error); }
  }

  static async getDirectoryTree(req, res, next) {
    try {
      const db = req.app.locals.db;
      const { root = '/' } = req.query;
      // Bound the result set — an unbounded .find().toArray() on a deep NAS
      // tree can return tens of thousands of directories and exhaust memory.
      const parsedLimit = Math.min(2000, Math.max(1, parseInt(req.query.limit) || 500));
      const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const dirs = await db.collection('nas_directories')
        .find({ path: { $regex: `^${escRe(root)}` } })
        .sort({ total_size: -1 })
        .limit(parsedLimit)
        .toArray();

      res.json({
        status: 'success',
        data: {
          limit: parsedLimit,
          truncated: dirs.length === parsedLimit,
          tree: dirs.map(dir => ({
            path: dir.path, fileCount: dir.file_count,
            totalSize: dir.total_size,
            totalSizeFormatted: formatFileSize(dir.total_size),
            largestFile: dir.largest_file
          }))
        }
      });
    } catch (error) { next(error); }
  }

  static async getStats(req, res, next) {
    try {
      const db = req.app.locals.db;
      const files = db.collection('nas_files');
      const queryScope = buildFileScope(req.query);
      if (queryScope.error) {
        return res.status(400).json({ status: 'error', message: queryScope.error });
      }
      const { root, filter: scope } = queryScope;

      const stats = await files.aggregate([{ $match: scope }, {
        $facet: {
          byExtension: [
            { $group: { _id: '$ext', count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { size: -1 } }, { $limit: 25 }
          ],
          byCategory: [
            { $group: { _id: { $ifNull: ['$category', 'unclassified'] }, count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { size: -1 } }
          ],
          byStorageRole: [
            { $group: { _id: { $ifNull: ['$storage_role', 'not_assessed'] }, count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { size: -1 } }
          ],
          byExtensionStatus: [
            { $group: { _id: { $ifNull: ['$extension_status', 'not_assessed'] }, count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { count: -1 } }
          ],
          byTimestampQuality: [
            { $group: { _id: { $ifNull: ['$timestamp_quality', 'not_assessed'] }, count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { count: -1 } }
          ],
          byTopLevel: [
            { $group: { _id: { $ifNull: ['$top_level', ''] }, count: { $sum: 1 }, size: { $sum: '$size' } } },
            { $sort: { size: -1 } },
            { $limit: 25 }
          ],
          bySize: [{
            $bucket: {
              groupBy: '$size',
              boundaries: [0, 1024, 10240, 102400, 1048576, 10485760, 104857600, Infinity],
              default: 'other',
              output: { count: { $sum: 1 }, totalSize: { $sum: '$size' } }
            }
          }],
          total: [{
            $group: {
              _id: null,
              count: { $sum: 1 },
              totalSize: { $sum: '$size' },
              avgSize: { $avg: '$size' },
              hashedCount: {
                $sum: {
                  $cond: [
                    { $and: [{ $ne: [{ $ifNull: ['$sha256', null] }, null] }, currentHashExpression()] },
                    1,
                    0
                  ]
                }
              },
              hashedBytes: {
                $sum: {
                  $cond: [
                    { $and: [{ $ne: [{ $ifNull: ['$sha256', null] }, null] }, currentHashExpression()] },
                    '$size',
                    0
                  ]
                }
              },
              missingExtension: { $sum: { $cond: [{ $in: ['$ext', [null, '']] }, 1, 0] } },
              extensionlessByDesign: {
                $sum: { $cond: [{ $eq: ['$extension_status', 'extensionless_by_design'] }, 1, 0] }
              },
              missingExtensionUnresolved: {
                $sum: { $cond: [{ $eq: ['$extension_status', 'missing_unresolved'] }, 1, 0] }
              },
              invalidTimestamp: { $sum: { $cond: [{ $lt: ['$mtime', 631152000] }, 1, 0] } },
              legacyOrSuspectTimestamp: {
                $sum: { $cond: [{ $eq: ['$timestamp_quality', 'legacy_or_suspect'] }, 1, 0] }
              },
              futureSuspectTimestamp: {
                $sum: { $cond: [{ $eq: ['$timestamp_quality', 'future_suspect'] }, 1, 0] }
              }
            }
          }]
        }
      }], { allowDiskUse: true }).toArray();

      const result = stats[0];
      const sizeCategories = {
        '<1KB': 0, '1KB-10KB': 0, '10KB-100KB': 0, '100KB-1MB': 0,
        '1MB-10MB': 0, '10MB-100MB': 0, '>100MB': 0
      };
      (result.bySize || []).forEach(bucket => {
        sizeCategories[FileBrowserController._getSizeCategoryLabel(bucket._id)] = bucket.count;
      });

      res.json({
        status: 'success',
        data: {
          root: root || null,
          total: result.total?.[0] || { count: 0, totalSize: 0, avgSize: 0 },
          byExtension: (result.byExtension || []).map(ext => ({
            extension: ext._id || 'no extension', count: ext.count,
            size: ext.size, sizeFormatted: formatFileSize(ext.size)
          })),
          byCategory: (result.byCategory || []).map(category => ({
            category: category._id || 'unclassified',
            count: category.count,
            size: category.size,
            sizeFormatted: formatFileSize(category.size)
          })),
          byStorageRole: (result.byStorageRole || []).map(role => ({
            role: role._id || 'not_assessed',
            count: role.count,
            size: role.size,
            sizeFormatted: formatFileSize(role.size)
          })),
          byExtensionStatus: (result.byExtensionStatus || []).map(item => ({
            status: item._id || 'not_assessed',
            count: item.count,
            size: item.size,
            sizeFormatted: formatFileSize(item.size)
          })),
          byTimestampQuality: (result.byTimestampQuality || []).map(item => ({
            quality: item._id || 'not_assessed',
            count: item.count,
            size: item.size,
            sizeFormatted: formatFileSize(item.size)
          })),
          byTopLevel: (result.byTopLevel || []).map(item => ({
            name: item._id || '(root files)',
            count: item.count,
            size: item.size,
            sizeFormatted: formatFileSize(item.size)
          })),
          sizeCategories
        }
      });
    } catch (error) { next(error); }
  }

  static async findDuplicates(req, res, next) {
    try {
      const db = req.app.locals.db;
      const files = db.collection('nas_files');
      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
      const method = req.query.method || 'auto';
      const root = String(req.query.root || '').trim();
      const scope = pathScope(root);

      let useHashMethod = false;
      if (method === 'hash' || method === 'auto') {
        const hashCount = await files.countDocuments({
          ...scope,
          sha256: { $exists: true, $ne: null },
          $expr: currentHashExpression()
        });
        useHashMethod = hashCount > 0 && method !== 'fuzzy';
      }

      const coverageRows = await files.aggregate([
        { $match: scope },
        {
          $group: {
            _id: null,
            files: { $sum: 1 },
            bytes: { $sum: '$size' },
            hashedFiles: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: [{ $ifNull: ['$sha256', null] }, null] }, currentHashExpression()] },
                  1,
                  0
                ]
              }
            },
            hashedBytes: {
              $sum: {
                $cond: [
                  { $and: [{ $ne: [{ $ifNull: ['$sha256', null] }, null] }, currentHashExpression()] },
                  '$size',
                  0
                ]
              }
            }
          }
        }
      ]).toArray();
      const coverage = coverageRows[0] || { files: 0, bytes: 0, hashedFiles: 0, hashedBytes: 0 };

      let duplicates;
      if (useHashMethod) {
        // Delegate the SHA256-group aggregation to the single dedup engine.
        duplicates = await dedupScanner.aggregateDuplicateGroups(db, {
          rootPath: root || null,
          sizeField: 'totalSize',
          limit
        });

        const formatted = duplicates.map(dup => ({
          sha256: dup._id, size: dup.totalSize, sizeFormatted: formatFileSize(dup.totalSize),
          count: dup.count, wastedSpace: dup.totalSize * (dup.count - 1),
          wastedSpaceFormatted: formatFileSize(dup.totalSize * (dup.count - 1)),
          locations: dup.files
        }));
        const totalWasted = formatted.reduce((sum, dup) => sum + dup.wastedSpace, 0);

        return res.json({
          status: 'success',
          data: {
            root: root || null,
            method: 'sha256',
            verified: true,
            coverage: {
              files: coverage.files,
              bytes: coverage.bytes,
              hashedFiles: coverage.hashedFiles,
              hashedBytes: coverage.hashedBytes,
              fileRatio: coverage.files ? coverage.hashedFiles / coverage.files : 0,
              byteRatio: coverage.bytes ? coverage.hashedBytes / coverage.bytes : 0
            },
            duplicates: formatted,
            summary: { totalDuplicateGroups: formatted.length, totalWastedSpace: totalWasted, totalWastedSpaceFormatted: formatFileSize(totalWasted) }
          }
        });
      }

      // Fuzzy deduplication fallback
      duplicates = await files.aggregate([
        { $match: scope },
        { $group: { _id: { filename: '$filename', size: '$size' }, count: { $sum: 1 }, files: { $push: { dirname: '$dirname', mtime: '$mtime' } }, totalSize: { $first: '$size' } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { totalSize: -1 } }, { $limit: limit }
      ], { allowDiskUse: true }).toArray();

      const formatted = duplicates.map(dup => ({
        filename: dup._id.filename, size: dup._id.size, sizeFormatted: formatFileSize(dup._id.size),
        count: dup.count, wastedSpace: dup._id.size * (dup.count - 1),
        wastedSpaceFormatted: formatFileSize(dup._id.size * (dup.count - 1)),
        locations: dup.files
      }));
      const totalWasted = formatted.reduce((sum, dup) => sum + dup.wastedSpace, 0);

      res.json({
        status: 'success',
        data: {
          root: root || null,
          method: 'same-name-size-candidates',
          verified: false,
          coverage: {
            files: coverage.files,
            bytes: coverage.bytes,
            hashedFiles: coverage.hashedFiles,
            hashedBytes: coverage.hashedBytes,
            fileRatio: coverage.files ? coverage.hashedFiles / coverage.files : 0,
            byteRatio: coverage.bytes ? coverage.hashedBytes / coverage.bytes : 0
          },
          note: 'These are unverified candidates. Run a candidates hash-mode scan for exact SHA256 evidence.',
          duplicates: formatted,
          summary: { totalDuplicateGroups: formatted.length, totalWastedSpace: totalWasted, totalWastedSpaceFormatted: formatFileSize(totalWasted) }
        }
      });
    } catch (error) { next(error); }
  }

  static async getCleanupRecommendations(req, res, next) {
    try {
      const db = req.app.locals.db;
      const files = db.collection('nas_files');
      const root = String(req.query.root || '').trim();
      const scope = pathScope(root);

      const [largeFiles, oldFiles, exactDuplicateRows, duplicateCandidates, zeroByteFiles, rootClutter] = await Promise.all([
        files.find({ ...scope, size: { $gt: 104857600 } }).sort({ size: -1 }).limit(20).toArray(),
        files.find({ ...scope, mtime: { $lt: Math.floor(Date.now() / 1000) - (730 * 86400) } }).sort({ mtime: 1 }).limit(20).toArray(),
        files.aggregate([
          {
            $match: {
              ...scope,
              sha256: { $exists: true, $ne: null },
              $expr: currentHashExpression()
            }
          },
          { $group: { _id: '$sha256', count: { $sum: 1 }, size: { $first: '$size' } } },
          { $match: { count: { $gt: 1 } } },
          {
            $group: {
              _id: null,
              groups: { $sum: 1 },
              wasted: { $sum: { $multiply: ['$size', { $subtract: ['$count', 1] }] } }
            }
          }
        ], { allowDiskUse: true }).toArray(),
        files.aggregate([
          { $match: scope },
          { $group: { _id: { filename: '$filename', size: '$size' }, count: { $sum: 1 } } },
          { $match: { count: { $gt: 1 } } },
          { $count: 'total' }
        ], { allowDiskUse: true }).toArray(),
        files.find({ ...scope, size: 0 }).sort({ path: 1 }).limit(20).toArray(),
        root
          ? files.find({ dirname: root.replace(/[\\/]+$/, '') }).sort({ size: -1 }).limit(20).toArray()
          : Promise.resolve([])
      ]);

      const exactSummary = exactDuplicateRows[0] || { groups: 0, wasted: 0 };

      res.json({
        status: 'success',
        data: {
          root: root || null,
          recommendations: [
            {
              type: 'large_files_review', priority: 'review',
              message: `Sampled ${largeFiles.length} files over 100MB for retention review; their size is not reclaimable-space evidence`,
              reviewBytes: largeFiles.reduce((sum, f) => sum + f.size, 0),
              potentialSavings: null,
              files: largeFiles.map(f => ({ path: formatFilePath(f), size: f.size, sizeFormatted: formatFileSize(f.size) }))
            },
            {
              type: 'old_files_review', priority: 'review',
              message: `Sampled ${oldFiles.length} files older than 2 years; age alone is not a deletion reason`,
              files: oldFiles.map(f => ({ path: formatFilePath(f), age: Math.floor((Date.now() / 1000 - f.mtime) / 86400) + ' days', size: formatFileSize(f.size) }))
            },
            {
              type: 'verified_duplicates', priority: exactSummary.groups ? 'high' : 'info',
              message: `Found ${exactSummary.groups} current SHA256-verified duplicate groups`,
              potentialSavings: exactSummary.wasted,
              evidence: 'sha256-current-metadata'
            },
            {
              type: 'duplicate_candidates', priority: 'review',
              message: `Found ${duplicateCandidates[0]?.total || 0} same-name/same-size candidate groups; these are not verified duplicates`,
              potentialSavings: null,
              evidence: 'same-name-size-unverified'
            },
            {
              type: 'zero_byte_files', priority: 'review',
              message: `Sampled ${zeroByteFiles.length} zero-byte files`,
              potentialSavings: 0,
              files: zeroByteFiles.map(f => ({ path: formatFilePath(f), size: 0 }))
            },
            {
              type: 'root_clutter', priority: 'review',
              message: root ? `Sampled ${rootClutter.length} files stored directly at the assessed root` : 'Root clutter requires a scoped root query',
              potentialSavings: null,
              files: rootClutter.map(f => ({ path: formatFilePath(f), size: f.size, sizeFormatted: formatFileSize(f.size) }))
            }
          ]
        }
      });
    } catch (error) { next(error); }
  }

  static async updateFile(req, res, next) {
    try {
      const { id } = req.params;
      const updates = req.body;
      const db = req.app.locals.db;
      if (!id) return res.status(400).json({ status: 'error', message: 'Missing file ID' });

      const allowedFields = ['tags', 'notes', 'category', 'starred', 'reviewed'];
      const safeUpdates = {};
      for (const key of Object.keys(updates)) {
        if (allowedFields.includes(key)) safeUpdates[key] = updates[key];
      }

      let result = await db.collection('nas_files').findOneAndUpdate(
        { _id: id }, { $set: { ...safeUpdates, updated_at: new Date() } }, { returnDocument: 'after' }
      );

      if (!result) {
        result = await db.collection('nas_files').findOneAndUpdate(
          { path: id }, { $set: { ...safeUpdates, updated_at: new Date() } }, { returnDocument: 'after' }
        );
        if (!result) return res.status(404).json({ status: 'error', message: `File not found: ${id}` });
      }

      res.json({ status: 'success', message: 'File updated successfully', data: result });
    } catch (error) { next(error); }
  }

  // Helpers
  static _getSizeCategoryLabel(boundary) {
    const labels = ['<1KB', '1KB-10KB', '10KB-100KB', '100KB-1MB', '1MB-10MB', '10MB-100MB', '>100MB'];
    const boundaries = [0, 1024, 10240, 102400, 1048576, 10485760, 104857600];
    return labels[boundaries.indexOf(boundary)] || 'other';
  }

}

module.exports = FileBrowserController;
