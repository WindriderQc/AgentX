/**
 * On-demand live sources: one upstream read per question, cached in memory.
 *
 *   GET /api/v1/livedata/tle?norad=25544[&format=tle]
 *   GET /api/v1/livedata/tides?lat=&lon=[&days=2]
 *   GET /api/v1/livedata/ec-weather?lat=&lon=[&lang=fr]
 *
 * Unlike registry feeds these run without the live-data master switch and store
 * nothing persistently. Observer selection uses explicit coordinates, a known
 * weather location, then the configured default, with provenance in the answer.
 */
const tle = require('../services/livedata/tle');
const tides = require('../services/livedata/tides');
const ecCityPage = require('../services/livedata/ecCityPage');
const { parsePosition, resolvePosition, locationMetadata } = require('../../shared/observerLocation');

function badRequest(res, message) {
  return res.status(400).json({ status: 'error', message });
}

function sourceFailure(res, err, next) {
  if (err?.code === 'INVALID_POSITION') {
    return res.status(err.status).json({ status: 'error', code: err.code, message: err.message });
  }
  if (err && err.name === 'SourceError') {
    return res.status(err.status).json({ status: 'error', code: err.code, message: err.message });
  }
  return next(err);
}

async function readPosition(req) {
  const explicit = parsePosition(req.query);
  let known = null;
  if (!explicit && req.app.locals.db) {
    try { known = await req.app.locals.db.collection('weatherLocations').findOne({}, { sort: { _id: 1 } }); }
    catch (_) { /* A configured default remains available without MongoDB. */ }
  }
  const position = resolvePosition({ explicit, known, defaultLocationJson: process.env.OBSERVER_DEFAULT_LOCATION_JSON });
  if (!position) throw Object.assign(new Error('No known location: supply lat and lon or configure a default'), { code: 'INVALID_POSITION', status: 400 });
  return position;
}

exports.getTle = async (req, res, next) => {
  const noradId = tle.normalizeNoradId(req.query.norad);
  if (!noradId) return badRequest(res, 'norad must be a NORAD catalog number');
  const format = req.query.format || 'json';
  if (!['json', 'tle'].includes(format)) return badRequest(res, 'format must be json or tle');
  try {
    const data = await tle.getTle({ db: req.app.locals.db, noradId });
    res.set('Cache-Control', 'no-store');
    if (format === 'tle') {
      res.set('X-TLE-Epoch', data.epoch);
      res.set('X-TLE-Source', data.source);
      res.set('X-TLE-Stale', String(data.stale));
      return res.type('text/plain').send(`${data.name || data.noradId}\n${data.line1}\n${data.line2}\n`);
    }
    return res.json({ status: 'success', data });
  } catch (err) {
    return sourceFailure(res, err, next);
  }
};

exports.getTides = async (req, res, next) => {
  const days = req.query.days === undefined ? 2 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > tides.MAX_DAYS) {
    return badRequest(res, `days must be a whole number from 1 to ${tides.MAX_DAYS}`);
  }
  try {
    const pos = await readPosition(req);
    const data = await tides.getTides({ ...pos, days });
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data: { ...data, location: locationMetadata(pos) } });
  } catch (err) {
    return sourceFailure(res, err, next);
  }
};

exports.getEcWeather = async (req, res, next) => {
  const lang = req.query.lang || 'fr';
  if (!['fr', 'en'].includes(lang)) return badRequest(res, 'lang must be fr or en');
  try {
    const pos = await readPosition(req);
    const data = await ecCityPage.getCityWeather({ ...pos, lang });
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data: { ...data, location: locationMetadata(pos) } });
  } catch (err) {
    return sourceFailure(res, err, next);
  }
};
