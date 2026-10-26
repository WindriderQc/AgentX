'use strict';

const { createHash } = require('crypto');
const { memoryFactProjection, memoryValidityProjection } = require('../../../shared/memoryFactMetadata');

// What a reviewer saw: content, labels, fact dates, provenance and validity.
function revisionFingerprint(doc) {
  if (!doc) return null;
  return createHash('sha256').update(JSON.stringify({ documentId: doc.documentId, contentHash: doc.contentHash || null,
    source: doc.source || null, scope: doc.scope || null, sensitivity: doc.sensitivity || null,
    ...memoryFactProjection(doc), ...memoryValidityProjection(doc) })).digest('hex');
}

module.exports = { revisionFingerprint };
