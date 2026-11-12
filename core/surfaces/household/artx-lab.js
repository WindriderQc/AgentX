'use strict';

const path = require('node:path');
const { skyView } = require('../../src/services/sky/nightSky');

// Calculation only: this lab never reads the home observer, weather, pictures,
// display registry or model. Explicit inputs are not written to any store.
function labSky(query = {}) {
  const at = typeof query.at === 'string' ? new Date(query.at) : new Date(NaN);
  const number = key => typeof query[key] === 'string' && query[key].trim() ? Number(query[key]) : NaN;
  const lat = number('lat'), lon = number('lon');
  if (!Number.isFinite(at.getTime()) || at.getUTCFullYear() < 1900 || at.getUTCFullYear() > 2050
    || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89 || Math.abs(lon) > 180
    || Object.keys(query).some(k => !['at', 'lat', 'lon'].includes(k))) {
    throw Object.assign(new Error('Use an ISO time (1900–2050), latitude −89…89 and longitude −180…180.'), { status: 400 });
  }
  const sky = skyView(lat, lon, at);
  return { at: at.toISOString(), simulation: true, sky, sun: { elevationDeg: sky.sun.altDeg } };
}

function registerArtxLab(app) {
  app.get('/artx-lab', require('../../src/ui/productShell').surfacePage(app,
    path.join(__dirname, 'public/artx-lab.html'), { activePage: 'artx-lab' }));
  app.get('/api/artx/lab/sky', (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ ok: true, data: labSky(req.query) }); }
    catch (error) { res.status(error.status || 500).json({ ok: false, code: 'ARTX_LAB_INVALID_INPUT' }); }
  });
}

module.exports = { registerArtxLab, labSky };
