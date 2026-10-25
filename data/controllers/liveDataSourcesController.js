/**
 * On-demand live sources: one upstream read per question, cached in memory.
 *
 *   GET /api/v1/livedata/tle?norad=25544[&format=tle]
 *   GET /api/v1/livedata/tides?lat=&lon=[&days=2]
 *   GET /api/v1/livedata/ec-weather?lat=&lon=[&lang=fr]
 *
 * Unlike registry feeds these run without the live-data master switch and store
 * nothing. Positions come from the caller and are neither logged nor stored.
 */
const tle = require('../services/livedata/tle');
const tides = require('../services/livedata/tides');
const ecCityPage = require('../services/livedata/ecCityPage');

function badRequest(res, message) {
  return res.status(400).json({ status: 'error', message });
}

function sourceFailure(res, err, next) {
  if (err && err.name === 'SourceError') {
    return res.status(err.status).json({ status: 'error', code: err.code, message: err.message });
  }
  return next(err);
}

// lat/lon from the query; null with a 400 already sent when invalid.
function readPosition(req, res) {
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  if (req.query.lat === undefined || req.query.lon === undefined || req.query.lat === '' || req.query.lon === ''
      || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    badRequest(res, 'lat and lon are required decimal degrees (lat -90..90, lon -180..180)');
    return null;
  }
  return { lat, lon };
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
  const pos = readPosition(req, res);
  if (!pos) return;
  const days = req.query.days === undefined ? 2 : Number(req.query.days);
  if (!Number.isInteger(days) || days < 1 || days > tides.MAX_DAYS) {
    return badRequest(res, `days must be a whole number from 1 to ${tides.MAX_DAYS}`);
  }
  try {
    const data = await tides.getTides({ ...pos, days });
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data });
  } catch (err) {
    return sourceFailure(res, err, next);
  }
};

exports.getEcWeather = async (req, res, next) => {
  const pos = readPosition(req, res);
  if (!pos) return;
  const lang = req.query.lang || 'fr';
  if (!['fr', 'en'].includes(lang)) return badRequest(res, 'lang must be fr or en');
  try {
    const data = await ecCityPage.getCityWeather({ ...pos, lang });
    res.set('Cache-Control', 'no-store');
    return res.json({ status: 'success', data });
  } catch (err) {
    return sourceFailure(res, err, next);
  }
};
