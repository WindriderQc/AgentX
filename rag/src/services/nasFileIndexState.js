'use strict';

/**
 * Index state of scanned files (`nas_files`) after a document leaves the index.
 *
 * The ingest worker skips a file while its record carries `indexed_at` newer
 * than its mtime. Deleting a document's vectors without clearing that state
 * would leave the file out of the index until it changes on disk, so callers
 * that delete documents reset the matching records and the next scan
 * re-ingests them. Records the worker excluded on purpose (`skipped-note`)
 * keep their state; that exclusion is decided by the ingestion policy.
 *
 * An operator can instead exclude the files behind a deleted document: their
 * records are marked `excluded` and the worker skips them even when they
 * change on disk, until the exclusion is lifted with `restoreExcludedFile`.
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');

const EXCLUDED_STATUS = 'excluded';
const EXCLUDED_LIST_LIMIT = 200;

function resolveDb(options) {
  return options.db || (mongoose.connection.readyState === 1 ? mongoose.connection.db : null);
}

function uniqueIds(documentIds) {
  return [...new Set((documentIds || []).filter((id) => typeof id === 'string' && id))];
}

/** Run one updateMany on nas_files; null when MongoDB is unavailable or fails. */
async function updateFiles(action, filter, update, options, context) {
  const db = resolveDb(options);
  if (!db) {
    logger.warn(`Indexed file state not ${action}: MongoDB is not connected`, context);
    return null;
  }
  try {
    const result = await db.collection('nas_files').updateMany(filter, update);
    return result.modifiedCount || 0;
  } catch (error) {
    logger.warn(`Indexed file state ${action} failed`, { ...context, error: error.message });
    return null;
  }
}

/**
 * @param {string[]} documentIds
 * @param {{ db?: object }} [options]
 * @returns {Promise<number|null>} records reset, or null when MongoDB was unavailable
 */
async function resetIndexedFiles(documentIds, options = {}) {
  const ids = uniqueIds(documentIds);
  if (!ids.length) return 0;
  return updateFiles('reset',
    { indexed_document_id: { $in: ids }, indexed_status: { $nin: ['skipped-note', EXCLUDED_STATUS] } },
    { $unset: { indexed_at: '', indexed_status: '', indexed_document_id: '' } },
    options, { documentCount: ids.length });
}

/**
 * Keep the files behind deleted documents out of the index.
 * @returns {Promise<number|null>} records excluded, or null when MongoDB was unavailable
 */
async function excludeIndexedFiles(documentIds, options = {}) {
  const ids = uniqueIds(documentIds);
  if (!ids.length) return 0;
  return updateFiles('excluded',
    { indexed_document_id: { $in: ids } },
    { $set: { indexed_status: EXCLUDED_STATUS, excluded_at: new Date() } },
    options, { documentCount: ids.length });
}

/**
 * Lift an exclusion: the record is reset so the next scan ingests the file.
 * @returns {Promise<number|null>} records restored, or null when MongoDB was unavailable
 */
async function restoreExcludedFile(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) return 0;
  return updateFiles('restored',
    { path: filePath, indexed_status: EXCLUDED_STATUS },
    { $unset: { indexed_at: '', indexed_status: '', indexed_document_id: '', excluded_at: '' } },
    options, { documentCount: 1 });
}

/** @returns {Promise<Array<{path: string, excludedAt: Date}>|null>} newest first, null without MongoDB */
async function listExcludedFiles(options = {}) {
  const db = resolveDb(options);
  if (!db) return null;
  const records = await db.collection('nas_files')
    .find({ indexed_status: EXCLUDED_STATUS }, { projection: { path: 1, excluded_at: 1 } })
    .sort({ excluded_at: -1 })
    .limit(EXCLUDED_LIST_LIMIT)
    .toArray();
  return records.map((record) => ({ path: record.path, excludedAt: record.excluded_at || null }));
}

module.exports = {
  EXCLUDED_STATUS,
  resetIndexedFiles,
  excludeIndexedFiles,
  restoreExcludedFile,
  listExcludedFiles
};
