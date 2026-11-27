'use strict';

const { parsePosition, resolvePosition } = require('../../../shared/observerLocation');

async function readPosition(db, query = {}) {
  const explicit = parsePosition(query);
  let known = null;
  if (!explicit && db) {
    try { known = await db.collection('weatherLocations').findOne({}, { sort: { _id: 1 } }); }
    catch (_) { /* A configured default remains available without MongoDB. */ }
  }
  const position = resolvePosition({ explicit, known, defaultLocationJson: process.env.OBSERVER_DEFAULT_LOCATION_JSON });
  if (!position) throw Object.assign(new Error('No known location: supply lat and lon or configure a default'), { code: 'INVALID_POSITION', status: 400 });
  return position;
}

module.exports = { readPosition };
