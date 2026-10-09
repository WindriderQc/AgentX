/**
 * File Export — generate optimized reports from indexed NAS files.
 * Supports: full, summary, media, large, stats report types.
 */
const { formatFileSize } = require('../utils/file-operations');
const { formatFilePath } = require('../utils/fileHelpers');
const fs = require('fs/promises');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream');
const { csvCell } = require('../../shared/csvCell');
const store = require('../services/exportStore');
const { createExportJobs } = require('../services/exportJobs');

const REPORT_TYPES = new Set(store.REPORT_TYPES);
const REPORT_FORMATS = new Set(store.REPORT_FORMATS);
const jobs = createExportJobs();

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

function csvValue(value) {
  if (value == null) return '';
  // Lists and objects become readable text; the cell rule then applies.
  return Array.isArray(value) ? `${value.length} items`
    : typeof value === 'object' ? JSON.stringify(value) : value;
}

function csvLine(values) {
  return values.map((value) => csvCell(csvValue(value))).join(',');
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

/** Write one report to `filePath` and say how many records it holds. */
async function produceReport(db, type, format, filePath, generatedAt) {
  const source = await reportSource(db, type);
  if (source) {
    const { rowCount, skippedFiles, totals } = await streamReport(filePath, source, format, generatedAt);
    return { recordCount: totals.totalFiles ?? rowCount, skippedCount: skippedFiles };
  }
  const data = await generateStatsReport(db);
  const content = format === 'csv' ? convertToCSV(data) : JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(filePath, content, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') await fs.unlink(filePath).catch(() => {});
    throw error;
  }
  return { recordCount: data.overview.totalFiles, skippedCount: 0 };
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function reportEntry(job, file) {
  const size = file ? file.size : job?.size ?? null;
  const name = store.parseReportName(file ? file.filename : job.filename);
  return {
    filename: file ? file.filename : job.filename,
    type: name.type,
    format: name.format,
    status: file ? 'ready' : job.status,
    size,
    sizeFormatted: size == null ? null : formatFileSize(size),
    createdAt: iso(file ? file.createdAt : job.finishedAt),
    requestedAt: iso(job?.requestedAt),
    recordCount: job?.recordCount ?? null,
    skippedCount: job?.skippedCount ?? null,
    error: file ? null : job.error
  };
}

/**
 * POST /generate starts a generation and answers 202 at once: a report of the
 * whole inventory takes too long to hold a request open. GET / says when the
 * report is `ready` (or `failed`, with the reason).
 */
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

    const started = jobs.start(type, format,
      (filePath, generatedAt) => produceReport(db, type, format, filePath, generatedAt));
    if (started.busy) {
      return res.status(429).json({
        status: 'error',
        message: 'Two reports are already being generated; retry when one has finished'
      });
    }
    res.status(202).json({
      status: 'success',
      message: 'Report generation started',
      data: reportEntry(started.job, null)
    });
  } catch (error) { next(error); }
};

exports.listExports = async (req, res, next) => {
  try {
    await store.removeStaleParts(jobs.runningNames());
    const files = await store.listReports();
    const onDisk = new Set(files.map(file => file.filename));
    const reports = [
      // Running and failed generations have no report file.
      ...jobs.list().filter(job => !onDisk.has(job.filename) && job.status !== 'ready')
        .sort((a, b) => b.requestedAt - a.requestedAt).map(job => reportEntry(job, null)),
      ...files.map(file => reportEntry(jobs.get(file.filename), file))
    ];
    res.json({
      status: 'success',
      data: {
        reports,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
        limits: store.limits()
      }
    });
  } catch (error) { next(error); }
};

exports.downloadExport = async (req, res, next) => {
  try {
    const { filename } = req.params;
    const name = store.parseReportName(filename);
    if (!name) return res.status(400).json({ status: 'error', message: 'Invalid filename' });
    const file = await store.statReport(filename);
    if (!file) return res.status(404).json({ status: 'error', message: 'File not found' });

    res.setHeader('Content-Type', store.CONTENT_TYPES[name.format]);
    res.setHeader('Content-Length', file.size);
    // The name matched the exporter's own pattern: no quote, slash or control character.
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    pipeline(createReadStream(file.path), res, (error) => {
      if (!error || error.code === 'ERR_STREAM_PREMATURE_CLOSE') return;
      if (!res.headersSent) next(error);
    });
  } catch (error) { next(error); }
};

exports.deleteExport = async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!store.parseReportName(filename)) return res.status(400).json({ status: 'error', message: 'Invalid filename' });
    const job = jobs.get(filename);
    if (job?.status === 'running') {
      return res.status(409).json({ status: 'error', message: 'This report is still being generated' });
    }
    const deleted = await store.deleteReport(filename);
    // A failed generation has no file: deleting it only clears it from the list.
    const forgotten = jobs.forget(filename);
    if (!deleted && !forgotten) return res.status(404).json({ status: 'error', message: 'File not found' });
    res.json({ status: 'success', message: 'Deleted' });
  } catch (error) { next(error); }
};

// Exposed for stream-integrity tests.
exports.streamReport = streamReport;
exports.reportSource = reportSource;
exports.produceReport = produceReport;
exports.jobs = jobs;
