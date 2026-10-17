'use strict';

/**
 * Shared ordering for document listings. Offsets page through this order, so it
 * must not depend on point IDs or insertion order: source, then document ID.
 */
function sortDocuments(documents) {
  return documents.sort((a, b) =>
    String(a.source || '').localeCompare(String(b.source || ''))
      || String(a.documentId || '').localeCompare(String(b.documentId || '')));
}

/** Every source label among the matched documents, not only the returned page. */
function distinctSources(documents) {
  return [...new Set(documents.map((doc) => doc.source).filter(Boolean))].sort();
}

module.exports = { distinctSources, sortDocuments };
