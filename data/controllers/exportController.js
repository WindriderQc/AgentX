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

const MEDIA_EXTS = ['jpg','jpeg','png','gif','bmp','webp','svg','mp4','avi','mkv','mov','wmv','flv','webm','mp3','wav','flac','aac','ogg','m4a'];
const LARGE_FILE_BYTES = 100 * 1024 * 1024;

function fileRow(f) {
  return { path: formatFilePath(f), filename: f.filename, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size) };
}

/**
 * Describe a row-per-document report: its cursor, row mapping and totals.
 * Rows are streamed, so memory stays bounded however large the inventory is.
 * Returns null for "stats", which holds one row per extension and stays in memory.
 */
async function reportSource(db, reportType) {
  const nasFiles = db.collection('nas_files');

  if (reportType === 'full') {
    return {
      reportType: 'full', listKey: 'files',
      cursor: nasFiles.find({}).sort({ dirname: 1, filename: 1 }),
      toRow: f => ({
        path: formatFilePath(f), filename: f.filename, dirname: f.dirname,
        ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size), mtime: f.mtime
      }),
      totals: count => ({ totalFiles: count })
    };
  }

  if (reportType === 'media') {
    return {
      reportType: 'media', listKey: 'files',
      cursor: nasFiles.find({ ext: { $in: MEDIA_EXTS } }).sort({ size: -1 }),
      toRow: fileRow,
      totals: count => ({ totalMediaFiles: count })
    };
  }

  if (reportType === 'large') {
    return {
      reportType: 'large_files', listKey: 'files',
      cursor: nasFiles.find({ size: { $gte: LARGE_FILE_BYTES } }).sort({ size: -1 }),
      toRow: fileRow,
      totals: count => ({ totalLargeFiles: count })
    };
  }

  if (reportType === 'summary') {
    const nasDirs = db.collection('nas_directories');
    const hasDirs = await nasDirs.findOne({}, { projection: { _id: 1 } });
    const cursor = hasDirs
      ? nasDirs.find({}).sort({ total_size: -1 })
      : nasFiles.aggregate([
        { $group: { _id: '$dirname', file_count: { $sum: 1 }, total_size: { $sum: '$size' } } },
        { $sort: { total_size: -1 } },
        { $project: { _id: 0, path: '$_id', file_count: 1, total_size: 1 } }
      ], { allowDiskUse: true });
    let totalFiles = 0;
    let totalSize = 0;
    return {
      reportType: 'summary', listKey: 'directories', cursor,
      toRow: d => {
        const row = { directory: d.path, fileCount: d.file_count, totalSize: d.total_size, totalSizeFormatted: formatFileSize(d.total_size) };
        totalFiles += d.file_count || 0;
        totalSize += d.total_size || 0;
        return row;
      },
      totals: count => ({ totalDirectories: count, totalFiles, totalSize })
    };
  }

  return null;
}

async function generateStatsReport(db) {
  const nasFiles = db.collection('nas_files');
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

function csvLine(values) {
  return values.map(csvCell).join(',');
}

function convertToCSV(data) {
  const list = data.files || data.directories || data.extensionStats || [];
  if (!Array.isArray(list) || list.length === 0) return 'No data\n';
  const headers = Object.keys(list[0]);
  return [csvLine(headers), ...list.map(item => csvLine(headers.map(h => item[h])))].join('\n');
}

/**
 * Stream a report to a file, one row per cursor document, as JSON or CSV.
 * The file is created exclusively, so an existing export is never overwritten.
 * Documents that cannot be serialized are skipped and counted separately.
 * On failure the cursor is closed and the partial file is removed.
 */
async function streamReport(filePath, source, format, generatedAt = new Date().toISOString()) {
  const { cursor } = source;
  const ws = createWriteStream(filePath, { flags: 'wx' });
  let streamError = null;
  let opened = false;
  ws.on('error', (err) => { streamError = err; });
  let rowCount = 0;
  let skippedFiles = 0;
  let headers = null;

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', () => { opened = true; resolve(); });
      ws.once('error', reject);
    });
    if (format === 'json') {
      const head = JSON.stringify({ reportType: source.reportType, generatedAt });
      await writeChunk(ws, `${head.slice(0, -1)},"${source.listKey}":[\n`);
    }
    for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
      if (streamError) throw streamError;
      let line;
      try {
        const row = source.toRow(doc);
        if (format === 'json') {
          line = (rowCount > 0 ? ',\n' : '') + JSON.stringify(row);
        } else {
          const keys = headers || Object.keys(row);
          line = (headers ? '\n' : `${csvLine(keys)}\n`) + csvLine(keys.map(h => row[h]));
          headers = keys;
        }
      } catch {
        skippedFiles++;
        continue;
      }
      await writeChunk(ws, line);
      rowCount++;
    }
    const totals = source.totals(rowCount);
    if (format === 'json') {
      await writeChunk(ws, `\n],${JSON.stringify({ ...totals, skippedFiles }).slice(1)}`);
    } else if (rowCount === 0) {
      await writeChunk(ws, 'No data\n');
    }
    await new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.end(resolve);
    });
    if (streamError) throw streamError;
    return { rowCount, skippedFiles, totals };
  } catch (err) {
    ws.destroy();
    if (opened) await fs.unlink(filePath).catch(() => {});
    throw err;
  } finally {
    await Promise.resolve(cursor.close?.()).catch(() => {});
  }
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

    const source = await reportSource(db, type);
    if (source) {
      const generatedAt = now.toISOString();
      const { rowCount, skippedFiles, totals } = await streamReport(filePath, source, format, generatedAt);
      const stats = await fs.stat(filePath);
      return res.json({
        status: 'success',
        data: {
          filename, size: stats.size, sizeFormatted: formatFileSize(stats.size),
          recordCount: totals.totalFiles ?? rowCount, skippedCount: skippedFiles, generatedAt
        }
      });
    }

    const data = await generateStatsReport(db);
    const content = format === 'csv' ? convertToCSV(data) : JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content, { flag: 'wx' });
    const stats = await fs.stat(filePath);

    res.json({
      status: 'success',
      data: { filename, size: stats.size, sizeFormatted: formatFileSize(stats.size), recordCount: data.overview.totalFiles, generatedAt: data.generatedAt }
    });
  } catch (error) {
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
exports.streamReport = streamReport;
exports.reportSource = reportSource;
