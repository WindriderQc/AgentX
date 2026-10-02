/**
 * File Export — generate optimized reports from indexed NAS files.
 * Supports: full, summary, media, large, stats report types.
 */
const path = require('path');
const { formatFileSize, ensureDir, listFilesWithMeta, validateFilename, exists } = require('../utils/file-operations');
const { formatFilePath } = require('../utils/fileHelpers');
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const { randomBytes } = require('crypto');

const EXPORT_DIR = path.join(__dirname, '../exports');
const REPORT_TYPES = new Set(['full', 'summary', 'media', 'large', 'stats']);
const REPORT_FORMATS = new Set(['json', 'csv']);

/**
 * Wait until a chunk is accepted by the write stream, honoring backpressure.
 */
function writeChunk(ws, chunk) {
  if (ws.write(chunk)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onDrain = () => { ws.off('error', onError); resolve(); };
    const onError = (err) => { ws.off('drain', onDrain); reject(err); };
    ws.once('drain', onDrain);
    ws.once('error', onError);
  });
}

/**
 * Stream a "full" report directly to a JSON file without loading all docs into memory.
 * The file is created exclusively, so an existing export is never overwritten.
 * Documents that cannot be serialized are skipped and counted separately.
 * On failure the cursor is closed and the partial file is removed.
 */
async function streamFullReport(db, filePath) {
  const cursor = db.collection('nas_files').find({}).sort({ dirname: 1, filename: 1 });
  const ws = createWriteStream(filePath, { flags: 'wx' });
  let streamError = null;
  let opened = false;
  ws.on('error', (err) => { streamError = err; });
  let totalFiles = 0;
  let skippedFiles = 0;

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', () => { opened = true; resolve(); });
      ws.once('error', reject);
    });
    await writeChunk(ws, `{"reportType":"full","generatedAt":"${new Date().toISOString()}","files":[\n`);
    for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
      if (streamError) throw streamError;
      let row;
      try {
        row = JSON.stringify({
          path: formatFilePath(doc), filename: doc.filename, dirname: doc.dirname,
          ext: doc.ext, size: doc.size, sizeFormatted: formatFileSize(doc.size), mtime: doc.mtime
        });
      } catch {
        skippedFiles++;
        continue;
      }
      await writeChunk(ws, (totalFiles > 0 ? ',\n' : '') + row);
      totalFiles++;
    }
    await writeChunk(ws, `\n],"totalFiles":${totalFiles},"skippedFiles":${skippedFiles}}`);
    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });
    if (streamError) throw streamError;
    return { totalFiles, skippedFiles };
  } catch (err) {
    ws.destroy();
    if (opened) await fs.unlink(filePath).catch(() => {});
    throw err;
  } finally {
    await Promise.resolve(cursor.close?.()).catch(() => {});
  }
}

async function generateOptimizedReport(db, reportType) {
  const nasFiles = db.collection('nas_files');
  const nasDirs = db.collection('nas_directories');

  if (reportType === 'summary') {
    let dirs = await nasDirs.find({}).sort({ total_size: -1 }).toArray();
    if (dirs.length === 0) {
      dirs = (await nasFiles.aggregate([
        { $group: { _id: '$dirname', file_count: { $sum: 1 }, total_size: { $sum: '$size' } } },
        { $sort: { total_size: -1 } }
      ]).toArray()).map(d => ({ path: d._id, file_count: d.file_count, total_size: d.total_size }));
    }
    return {
      reportType: 'summary', generatedAt: new Date().toISOString(),
      totalDirectories: dirs.length,
      totalFiles: dirs.reduce((s, d) => s + (d.file_count || 0), 0),
      totalSize: dirs.reduce((s, d) => s + (d.total_size || 0), 0),
      directories: dirs.map(d => ({ directory: d.path, fileCount: d.file_count, totalSize: d.total_size, totalSizeFormatted: formatFileSize(d.total_size) }))
    };
  }

  if (reportType === 'media') {
    const exts = ['jpg','jpeg','png','gif','bmp','webp','svg','mp4','avi','mkv','mov','wmv','flv','webm','mp3','wav','flac','aac','ogg','m4a'];
    const files = await nasFiles.find({ ext: { $in: exts } }).sort({ size: -1 }).toArray();
    return {
      reportType: 'media', generatedAt: new Date().toISOString(), totalMediaFiles: files.length,
      files: files.map(f => ({ path: formatFilePath(f), filename: f.filename, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size) }))
    };
  }

  if (reportType === 'large') {
    const files = await nasFiles.find({ size: { $gte: 100 * 1024 * 1024 } }).sort({ size: -1 }).toArray();
    return {
      reportType: 'large_files', generatedAt: new Date().toISOString(), totalLargeFiles: files.length,
      files: files.map(f => ({ path: formatFilePath(f), filename: f.filename, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size) }))
    };
  }

  if (reportType === 'stats') {
    const [statsByExt, totalFiles, totalSize] = await Promise.all([
      nasFiles.aggregate([
        { $group: { _id: '$ext', count: { $sum: 1 }, totalSize: { $sum: '$size' }, avgSize: { $avg: '$size' }, maxSize: { $max: '$size' } } },
        { $sort: { totalSize: -1 } }
      ]).toArray(),
      nasFiles.countDocuments(),
      nasFiles.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]).toArray()
    ]);
    const ts = totalSize[0]?.total || 0;
    return {
      reportType: 'statistics', generatedAt: new Date().toISOString(),
      overview: { totalFiles, totalSize: ts, totalSizeFormatted: formatFileSize(ts) },
      extensionStats: statsByExt.map(s => ({
        extension: s._id || 'none', fileCount: s.count,
        totalSize: s.totalSize, totalSizeFormatted: formatFileSize(s.totalSize),
        avgSize: Math.round(s.avgSize), maxSize: s.maxSize,
        pct: ts > 0 ? Math.round((s.totalSize / ts) * 10000) / 100 : 0
      }))
    };
  }

  throw new Error(`Unknown report type: ${reportType}. Use: full, summary, media, large, stats`);
}

function csvCell(value) {
  if (value == null) return '';
  let text = Array.isArray(value) ? `${value.length} items`
    : typeof value === 'object' ? JSON.stringify(value) : String(value);
  // Text must remain inert when opened in a spreadsheet. Numeric values,
  // including negative numbers, keep their existing numeric representation.
  if (typeof value === 'string' && (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) {
    text = `'${text}`;
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function convertToCSV(data) {
  const list = data.files || data.directories || data.extensionStats || [];
  if (!Array.isArray(list) || list.length === 0) return 'No data\n';
  const headers = Object.keys(list[0]);
  const rows = list.map(item => headers.map(h => csvCell(item[h])).join(','));
  return [headers.map(csvCell).join(','), ...rows].join('\n');
}

exports.generateReport = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const type = req.body?.type !== undefined ? req.body.type
      : req.query.type !== undefined ? req.query.type : 'full';
    const format = req.body?.format !== undefined ? req.body.format
      : req.query.format !== undefined ? req.query.format : 'json';
    if (!REPORT_TYPES.has(type)) {
      return res.status(400).json({ status: 'error', message: 'Unknown report type. Use: full, summary, media, large, stats' });
    }
    if (!REPORT_FORMATS.has(format)) {
      return res.status(400).json({ status: 'error', message: 'Unknown report format. Use: json, csv' });
    }
    if (type === 'full' && format === 'csv') {
      return res.status(400).json({ status: 'error', message: 'Full reports support JSON only' });
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    // A random suffix keeps concurrent exports of the same type apart.
    const filename = `export_${type}_${ts}_${randomBytes(3).toString('hex')}.${format}`;
    const filePath = path.join(EXPORT_DIR, filename);
    await ensureDir(EXPORT_DIR);

    // "full" JSON exports stream directly to file (memory-safe for large collections)
    if (type === 'full' && format === 'json') {
      const { totalFiles, skippedFiles } = await streamFullReport(db, filePath);
      const stats = await fs.stat(filePath);
      return res.json({
        status: 'success',
        data: { filename, size: stats.size, sizeFormatted: formatFileSize(stats.size), recordCount: totalFiles, skippedCount: skippedFiles, generatedAt: now.toISOString() }
      });
    }

    const data = await generateOptimizedReport(db, type);

    const content = format === 'csv' ? convertToCSV(data) : JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content, { flag: 'wx' });
    const stats = await fs.stat(filePath);

    res.json({
      status: 'success',
      data: { filename, size: stats.size, sizeFormatted: formatFileSize(stats.size), recordCount: data.totalFiles || data.totalMediaFiles || data.totalLargeFiles || 0, generatedAt: data.generatedAt }
    });
  } catch (error) {
    if (error.message.startsWith('Unknown report type')) return res.status(400).json({ status: 'error', message: error.message });
    if (error.code === 'EEXIST') return res.status(409).json({ status: 'error', message: 'An export with this name already exists; retry' });
    next(error);
  }
};

exports.listExports = async (req, res, next) => {
  try {
    await ensureDir(EXPORT_DIR);
    const files = await listFilesWithMeta(EXPORT_DIR, { filesOnly: true, sortBy: 'modified', sortOrder: 'desc' });
    res.json({ status: 'success', data: files });
  } catch (error) { next(error); }
};

exports.deleteExport = async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!validateFilename(filename)) return res.status(400).json({ status: 'error', message: 'Invalid filename' });
    const filePath = path.join(EXPORT_DIR, filename);
    if (!exists(filePath)) return res.status(404).json({ status: 'error', message: 'File not found' });
    await fs.unlink(filePath);
    res.json({ status: 'success', message: 'Deleted' });
  } catch (error) { next(error); }
};

// Exposed for stream-integrity tests.
exports.streamFullReport = streamFullReport;
