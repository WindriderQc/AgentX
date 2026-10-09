'use strict';

/**
 * Where generated reports live, and what may be kept there.
 *
 * Only files the exporter names (`export_<type>_<date>_<time>_<suffix>.<format>`)
 * are listed, downloaded, deleted or pruned: anything else in the directory is
 * left alone. A report is written under `<name>.part` and takes its final name
 * only once it is complete, so a listed report is never a partial file, even
 * after a crash. The store is bounded: the oldest reports are removed when a
 * new one brings it over its count or its total size.
 */

const path = require('path');
const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const { randomBytes } = require('crypto');
const { formatFileSize } = require('../utils/file-operations');

const DEFAULT_DIR = path.join(__dirname, '../exports');
const MAX_REPORTS = 20;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const PART_SUFFIX = '.part';
const REPORT_TYPES = Object.freeze(['full', 'summary', 'media', 'large', 'stats']);
const REPORT_FORMATS = Object.freeze(['json', 'csv']);
const REPORT_NAME = new RegExp(
  `^export_(${REPORT_TYPES.join('|')})_\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}_[0-9a-f]{6}\\.(${REPORT_FORMATS.join('|')})$`
);
const CONTENT_TYPES = Object.freeze({
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8'
});

/** The report directory: DATA_EXPORT_DIR, or `exports` beside the service code. */
function exportDir() {
  const configured = String(process.env.DATA_EXPORT_DIR || '').trim();
  return configured ? path.resolve(configured) : DEFAULT_DIR;
}

/** `{ type, format }` of a name the exporter created, else null. */
function parseReportName(filename) {
  if (typeof filename !== 'string' || filename.length > 80) return null;
  const match = REPORT_NAME.exec(filename);
  return match ? { type: match[1], format: match[2] } : null;
}

function newReportName(type, format, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  // A random suffix keeps concurrent exports of the same type apart.
  return `export_${type}_${stamp}_${randomBytes(3).toString('hex')}.${format}`;
}

function reportPath(filename) {
  return path.join(exportDir(), filename);
}

function partPath(filename) {
  return `${reportPath(filename)}${PART_SUFFIX}`;
}

async function ensureDir() {
  await fs.mkdir(exportDir(), { recursive: true });
}

/** A regular file with a report name, or null. A symbolic link is never followed. */
async function statReport(filename) {
  if (!parseReportName(filename)) return null;
  try {
    const stats = await fs.lstat(reportPath(filename));
    return stats.isFile() ? { filename, path: reportPath(filename), size: stats.size, createdAt: stats.mtime } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Complete reports, newest first. */
async function listReports() {
  let names;
  try {
    names = await fs.readdir(exportDir());
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const reports = (await Promise.all(names.map(name => statReport(name).catch(() => null)))).filter(Boolean);
  return reports.sort((a, b) => b.createdAt - a.createdAt || (a.filename < b.filename ? 1 : -1));
}

/**
 * Give a finished `.part` file its final name without ever replacing a report:
 * a hard link fails when the name exists. Filesystems without hard links get an
 * exclusive copy instead.
 */
async function commitPart(filename) {
  const from = partPath(filename);
  const to = reportPath(filename);
  try {
    await fs.link(from, to);
  } catch (error) {
    if (error.code === 'EEXIST') throw error;
    await fs.copyFile(from, to, fsConstants.COPYFILE_EXCL);
  }
  await fs.unlink(from).catch(() => {});
  return statReport(filename);
}

async function discardPart(filename) {
  await fs.unlink(partPath(filename)).catch(() => {});
}

/** Remove `.part` files no running generation owns (left by a crash or a restart). */
async function removeStaleParts(runningNames = new Set()) {
  let names;
  try { names = await fs.readdir(exportDir()); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(PART_SUFFIX)) continue;
    const report = name.slice(0, -PART_SUFFIX.length);
    if (!parseReportName(report) || runningNames.has(report)) continue;
    await fs.unlink(path.join(exportDir(), name)).then(() => { removed += 1; }, () => {});
  }
  return removed;
}

async function deleteReport(filename) {
  if (!parseReportName(filename)) return false;
  try {
    await fs.unlink(reportPath(filename));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Bring the store back under its bounds, oldest report first. `keep` (the
 * report just generated) is never removed, even when it alone is over the size
 * bound. Returns the names removed.
 */
async function pruneReports(keep, limits = {}) {
  const maxReports = limits.maxReports || MAX_REPORTS;
  const maxTotalBytes = limits.maxTotalBytes || MAX_TOTAL_BYTES;
  const reports = await listReports();
  let count = reports.length;
  let total = reports.reduce((sum, report) => sum + report.size, 0);
  const removed = [];
  for (const report of [...reports].reverse()) {
    if (count <= maxReports && total <= maxTotalBytes) break;
    if (report.filename === keep) continue;
    if (await deleteReport(report.filename)) removed.push(report.filename);
    count -= 1;
    total -= report.size;
  }
  return removed;
}

function limits() {
  return {
    maxReports: MAX_REPORTS,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxTotalBytesFormatted: formatFileSize(MAX_TOTAL_BYTES)
  };
}

module.exports = {
  MAX_REPORTS,
  MAX_TOTAL_BYTES,
  PART_SUFFIX,
  REPORT_TYPES,
  REPORT_FORMATS,
  CONTENT_TYPES,
  exportDir,
  parseReportName,
  newReportName,
  reportPath,
  partPath,
  ensureDir,
  statReport,
  listReports,
  commitPart,
  discardPart,
  removeStaleParts,
  deleteReport,
  pruneReports,
  limits
};
