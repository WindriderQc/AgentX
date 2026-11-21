'use strict';

const { BSON } = require('mongoose').mongo;
const { failure } = require('./personalHistorySourceReviewSources');
const unsupported = () => failure('The selected native document representation cannot be restored exactly.', 503, 'HISTORY_CORE_DOCUMENT_FORMAT');

function packet(buffer, options) {
  if (!(buffer instanceof Uint8Array)) throw unsupported();
  try { return BSON.deserialize(buffer, options); }
  catch { throw unsupported(); }
}

function document(buffer) {
  const row = packet(buffer, { promoteValues: false, bsonRegExp: true });
  // Unsupported/deprecated BSON or key orders must not be silently normalized.
  // This compares the driver's nested raw document representation, not disk
  // storage/compression or a JSON projection of the record.
  if (!BSON.serialize(row).equals(Buffer.from(buffer))) throw unsupported();
  return row;
}

function typedDocuments(buffers) {
  const history = [], souvenirs = [];
  for (const buffer of buffers) {
    const frame = packet(buffer, { raw: true });
    history.push(document(frame.row));
    for (const note of frame.souvenirEvidence || []) {
      souvenirs.push(document(packet(note, { raw: true }).row));
    }
  }
  return { history, souvenirs };
}

module.exports = { packet, document, typedDocuments };
