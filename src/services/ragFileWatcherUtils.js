'use strict';
/**
 * RAG File Watcher Utilities
 *
 * Pure helper functions extracted from ragFileWatcher.js.
 * All functions are stateless — no class dependencies.
 *
 * Consumed by: src/services/ragFileWatcher.js
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Normalise a file path to forward-slash separators.
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizeRelativePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

/**
 * Normalise a path for comparison (platform-normalize then forward-slash).
 *
 * @param {string} filePath
 * @returns {string}
 */
function normalizePathForComparison(filePath) {
  return normalizeRelativePath(path.normalize(String(filePath || '')));
}

/**
 * Build a deterministic document ID from source + relative path.
 * MUST produce the same hash as RagStore.generateDocumentId.
 *
 * @param {string} source
 * @param {string} relativePath
 * @returns {string} MD5 hex
 */
function buildDocumentId(source, relativePath) {
  return crypto.createHash('md5').update(`${source}:${normalizeRelativePath(relativePath)}`).digest('hex');
}

/**
 * Calculate the SHA-256 hash of a file on disk.
 *
 * @param {string} filePath  absolute path
 * @returns {Promise<string>} hex digest
 */
async function calculateSHA256(filePath) {
  const fileBuffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Extract a document title from markdown content.
 * Looks for a top-level heading in the first 10 lines; falls back to filename.
 *
 * @param {string} content   file contents
 * @param {string} filePath  used for fallback basename
 * @returns {string}
 */
function extractTitle(content, filePath) {
  const lines = content.split('\n');
  for (const line of lines.slice(0, 10)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ')) {
      return trimmed.substring(2).trim();
    }
  }
  return path.basename(filePath, '.md');
}

module.exports = {
  normalizeRelativePath,
  normalizePathForComparison,
  buildDocumentId,
  calculateSHA256,
  extractTitle
};
