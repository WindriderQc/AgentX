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
 */

const mongoose = require('mongoose');
const logger = require('../../config/logger');

/**
 * @param {string[]} documentIds
 * @param {{ db?: object }} [options]
 * @returns {Promise<number|null>} records reset, or null when MongoDB was unavailable
 */
async function resetIndexedFiles(documentIds, options = {}) {
  const ids = [...new Set((documentIds || []).filter((id) => typeof id === 'string' && id))];
  if (!ids.length) return 0;
  const db = options.db || (mongoose.connection.readyState === 1 ? mongoose.connection.db : null);
  if (!db) {
    logger.warn('Indexed file state not reset: MongoDB is not connected', { documentCount: ids.length });
    return null;
  }
  try {
    const result = await db.collection('nas_files').updateMany(
      { indexed_document_id: { $in: ids }, indexed_status: { $ne: 'skipped-note' } },
      { $unset: { indexed_at: '', indexed_status: '', indexed_document_id: '' } }
    );
    return result.modifiedCount || 0;
  } catch (error) {
    logger.warn('Indexed file state reset failed', { documentCount: ids.length, error: error.message });
    return null;
  }
}

module.exports = { resetIndexedFiles };
