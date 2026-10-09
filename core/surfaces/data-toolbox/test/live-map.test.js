'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const build = require('../geo/build-world');

const publicRoot = path.resolve(__dirname, '..', 'public');
const worldFile = path.join(publicRoot, 'geo', 'world-110m.json');
const worldRaw = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
const NOW = Date.parse('2026-10-08T23:40:00.000Z');
const minute = 60000;

// Shapes trimmed from a Data instance; places, values and positions are synthetic.
// ISS: newest first, one point per minute, heading east across the antimeridian.
const issBody = Array.from({ length: 100 }, (_, index) => {
  const longitude = 150 + (99 - index) * 3.8 - 99 * 3.8 + 40; // ends at 190°, stored as -170°
  return { _id: `iss${index}`, latitude: 20 - index * 0.4, longitude: longitude > 180 ? longitude - 360 : longitude, timeStamp: new Date(NOW - 30000 - index * minute).toISOString() };
});
const quake = (id, latitude, longitude, mag, place, extra = {}) => ({
  _id: id, time: new Date(NOW - 3600000).toISOString(), latitude: String(latitude), longitude: String(longitude), depth: '10.5', mag: String(mag),
  magType: 'ml', net: 'ex', id, updated: new Date(NOW - 1800000).toISOString(), place, type: 'earthquake', status: 'reviewed', ...extra
});
const HOSTILE = '5 km N of <img src=x onerror=alert(1)>"\'&';
const quakesBody = [
  quake('q1', 35.7, 139.7, 4.6, '3 km N of Example City, Japan'),
  quake('q2', 36.2, 138.2, 2.1, '9 km E of Sample Town, Japan'),
  quake('q3', -33.4, -70.6, 6.3, '12 km S of Example Valley, Chile'),
  quake('q4', 0, -140, 5.2, 'Example Fracture Zone'),
  quake('q5', -29.5, 28.2, 1.4, HOSTILE),
  quake('q6', 67, -175, -0.4, 'Example Peninsula, Russia', { type: 'quarry blast' }),
  quake('q7', '', '', 3, 'row without coordinates')
];
const weatherBody = [
  { _id: 'w1', pressure: 1007.4, timeStamp: new Date(NOW - 2 * minute).toISOString(), lat: 10.5, lon: 20.25 },
  { _id: 'w2', pressure: 1001.2, timeStamp: new Date(NOW - 17 * minute).toISOString(), lat: 10.5, lon: 20.25 }
];
const airBody = [
  { _id: 'a1', feedId: 'air_quality', ts: new Date(NOW - 40 * minute).toISOString(), payload: { pm2_5: 3.4, pm10: 3.6, us_aqi: 29, european_aqi: 24 }, geo: { lat: 10.5, lon: 20.25 } }
];
const sensorsBody = [
  { _id: 's1', feedId: 'sensors', ts: new Date(NOW - minute).toISOString(), payload: { topic: 'sensors/example/greenhouse', temperature: 21.5, lat: -20, lon: 60 }, geo: { lat: -20, lon: 60 } },
  { _id: 's2', feedId: 'sensors', ts: new Date(NOW - 3 * minute).toISOString(), payload: { topic: 'sensors/example/greenhouse', temperature: 19, lat: -20, lon: 60 }, geo: { lat: -20, lon: 60 } },
  { _id: 's3', feedId: 'sensors', ts: new Date(NOW - 2 * minute).toISOString(), payload: { topic: 'sensors/example/cellar', value: 12 } }
];
const feed = (id, overrides = {}) => ({ id, label: id, category: 'example', kind: 'http', enabled: true, intervalMs: 60000, geo: true, count: 10, lastFetchAt: new Date(NOW - minute).toISOString(), lastError: null, ...overrides });
const feedsBody = ['iss', 'quakes', 'weather', 'satellites', 'air_quality', 'sensors'].map((id) => feed(id));

function mapBrowser(respond, { world = worldRaw } = {}) {
  const elements = {};
  const element = (selector) => (elements[selector] ||= { innerHTML: '', textContent: '', clientWidth: selector === '#liveMap' ? 1000 : 0 });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  class FixedDate extends Date {
    constructor(...args) { if (args.length) super(...args); else super(NOW); }
    static now() { return NOW; }
  }
  const document = {
    hidden: false,
    querySelector: element,
    querySelectorAll() { return []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, location: { hash: '#live-data' }, console, URLSearchParams, Date: FixedDate,
    window: { addEventListener(name, callback) { (listeners[`window:${name}`] ||= []).push(callback); } },
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url) => {
      const parsed = new URL(url, 'http://localhost');
      requests.push(parsed);
      if (parsed.pathname.startsWith('/assets/')) {
        if (world instanceof Error) return { ok: false, status: 404, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => world };
      }
      const answer = await respond(parsed.pathname.replace('/api/data-toolbox', ''), parsed.searchParams);
      if (answer instanceof Error) return { ok: false, status: 502, json: async () => ({ ok: false, status: 'error', code: 'DATA_UNAVAILABLE', message: answer.message }) };
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  // The four scripts in page order: a name declared twice would fail here as it would in the browser.
  const source = ['refresh.js', 'gpu.js', 'mqtt.js', 'live-map.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, `\nglobalThis.page = { state, mapState, mapRefresher, liveFeedsRefresher, render, liveMapOpen, refreshLiveMap, setLiveMapView, mapProject, mapSplitTrack, mapQuakeRadius,
      mapPrepareWorld, mapInRing, mapCountryAt, mapCountByCountry, mapBin, mapBinLabel, mapPosition };`);
  vm.runInNewContext(source, context);
  return { ...context.page, document, location: context.location, elements, element, listeners, requests, timers, cleared, content: element('#content'), map: element('#liveMap') };
}

const liveLike = (overrides = {}) => (route) => {
  const routes = {
    '/live-data/feeds': feedsBody,
    '/live-data/state': { liveDataEnabled: true },
    '/live-data/iss/latest': issBody,
    '/live-data/quakes/history': quakesBody,
    '/live-data/weather/latest': weatherBody,
    '/live-data/air_quality/latest': airBody,
    '/live-data/sensors/latest': sensorsBody,
    ...overrides
  };
  return routes[route] ?? new Error(`unexpected ${route}`);
};

async function openMap(respond = liveLike(), options) {
  const browser = mapBrowser(respond, options);
  await browser.render();
  return browser;
}

const svgOf = (html) => html.match(/<svg class="live-map"[\s\S]*?<\/svg>/)?.[0] || '';
const numbers = (text) => text.split(/[ ,]/).map(Number);
// Values built inside the page's context have that context's prototypes.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('the vendored country geometry loads, is small and holds the expected countries', () => {
  const size = fs.statSync(worldFile).size;
  assert.ok(size < 150 * 1024, `world-110m.json is ${size} bytes`);
  assert.equal(worldRaw.scale, 10);
  assert.equal(worldRaw.countries.length, 177);
  const names = worldRaw.countries.map((country) => country.name);
  for (const name of ['Japan', 'Chile', 'Canada', 'France', 'Russia', 'Fiji', 'Antarctica', 'Lesotho', 'South Africa', 'Indonesia']) assert.ok(names.includes(name), name);
  assert.equal(new Set(names).size, names.length);
  assert.match(worldRaw.source, /Natural Earth 1:110m.*world-atlas 2\.0\.2/);
  for (const country of worldRaw.countries) {
    for (const ring of country.polygons.flat()) {
      assert.ok(ring.length >= 6 && ring.length % 2 === 0, country.name);
      for (let i = 0; i < ring.length; i += 2) {
        assert.ok(Number.isInteger(ring[i]) && Math.abs(ring[i]) <= 1800 && Number.isInteger(ring[i + 1]) && Math.abs(ring[i + 1]) <= 900, country.name);
        // No edge streaks across the map; only Antarctica's closing edge runs along the pole.
        const j = (i + 2) % ring.length;
        if (Math.abs(ring[i] - ring[j]) > 1800) assert.ok(country.name === 'Antarctica' && ring[i + 1] === -900 && ring[j + 1] === -900, country.name);
      }
    }
  }
  // The cut left Russia and Fiji on both edges of the map.
  for (const name of ['Russia', 'Fiji']) {
    const lons = worldRaw.countries.find((country) => country.name === name).polygons.flat(2).filter((_, index) => index % 2 === 0);
    assert.equal(Math.min(...lons), -1800, name);
    assert.equal(Math.max(...lons), 1800, name);
  }
  assert.match(fs.readFileSync(path.join(publicRoot, 'geo', 'CREDITS.md'), 'utf8'), /Natural Earth[\s\S]*Public domain[\s\S]*world-atlas[\s\S]*2\.0\.2[\s\S]*ISC[\s\S]*build-world\.js[\s\S]*Copyright 2013-2019 Michael Bostock/);
});

test('the build stitches TopoJSON arcs and cuts rings at the antimeridian', () => {
  const topology = {
    transform: { scale: [0.5, 0.5], translate: [-10, -10] },
    arcs: [[[0, 0], [20, 0], [0, 20]], [[20, 20], [-20, 0], [0, -20]]],
    objects: { countries: { geometries: [{ type: 'Polygon', arcs: [[0, 1]], id: '001', properties: { name: 'Example' } }] } }
  };
  assert.deepEqual(build.decodeArcs(topology)[0], [[-10, -10], [0, -10], [0, 0]]);
  assert.deepEqual(build.stitchRing(build.decodeArcs(topology), [0, 1]), [[-10, -10], [0, -10], [0, 0], [-10, 0], [-10, -10]]);
  assert.deepEqual(build.stitchRing(build.decodeArcs(topology), [~1, ~0]), [[-10, -10], [-10, 0], [0, 0], [0, -10], [-10, -10]]);
  assert.deepEqual(build.buildWorld(topology).countries, [{ id: '001', name: 'Example', polygons: [[[-100, -100, 0, -100, 0, 0, -100, 0]]] }]);
  // A square from 178°E to 178°W becomes one piece on each edge of the map.
  const pieces = build.cutAtAntimeridian([[178, 0], [-178, 0], [-178, 4], [178, 4], [178, 0]]).map(build.compactRing);
  assert.deepEqual(pieces, [[1780, 0, 1800, 0, 1800, 40, 1780, 40], [-1800, 0, -1780, 0, -1780, 40, -1800, 40]]);
  // A ring around the south pole is closed along the pole.
  assert.deepEqual(build.cutAtAntimeridian([[-180, -80], [0, -70], [180, -80], [-180, -80]]), [[[-180, -80], [0, -70], [180, -80], [180, -90], [-180, -90]]]);
  assert.deepEqual(build.cutAtAntimeridian([[0, 0], [5, 0], [5, 5], [0, 0]]), [[[0, 0], [5, 0], [5, 5]]]);
});

test('the projection is equirectangular over the whole globe', () => {
  const { mapProject, mapPosition } = mapBrowser(liveLike());
  assert.deepEqual([...mapProject(-180, 90, 1000)], [0, 0]);
  assert.deepEqual([...mapProject(180, -90, 1000)], [1000, 500]);
  assert.deepEqual([...mapProject(0, 0, 1000)], [500, 250]);
  assert.deepEqual([...mapProject(90, 45, 720)], [540, 90]);
  assert.equal(mapPosition('', ''), null);
  assert.equal(mapPosition(91, 0), null);
  assert.equal(mapPosition(0, 181), null);
  assert.deepEqual({ ...mapPosition('-9.98', '78.47') }, { lat: -9.98, lon: 78.47 });
});

test('a track is cut at the antimeridian and at a hole in time, never drawn across the map', () => {
  const { mapSplitTrack } = mapBrowser(liveLike());
  const point = (lon, lat, at) => ({ lon, lat, at: at * minute });
  const east = plain(mapSplitTrack([point(170, 10, 0), point(176, 12, 1), point(-178, 14, 2), point(-172, 16, 3)]));
  assert.deepEqual(east, [[[170, 10], [176, 12], [180, 13.333333333333334]], [[-180, 13.333333333333334], [-178, 14], [-172, 16]]]);
  const west = plain(mapSplitTrack([point(-179, 0, 0), point(179, 2, 1)]));
  assert.deepEqual(west, [[[-179, 0], [-180, 1]], [[180, 1], [179, 2]]]);
  const hole = mapSplitTrack([point(0, 0, 0), point(4, 1, 1), point(40, 9, 10), point(44, 10, 11)]);
  assert.deepEqual(plain(hole).map((line) => line.length), [2, 2]);
  for (const line of [...east, ...west]) for (let i = 1; i < line.length; i += 1) assert.ok(Math.abs(line[i][0] - line[i - 1][0]) <= 180);
  assert.deepEqual(plain(mapSplitTrack([])), []);
});

test('circle area doubles with each magnitude unit and small or unknown magnitudes share the smallest size', () => {
  const { mapQuakeRadius } = mapBrowser(liveLike());
  const area = (mag) => mapQuakeRadius(mag, 1000) ** 2;
  assert.ok(Math.abs(area(5) / area(4) - 2) < 1e-9);
  assert.ok(Math.abs(area(7) / area(3) - 16) < 1e-9);
  assert.equal(mapQuakeRadius(-1, 1000), mapQuakeRadius(1, 1000));
  assert.equal(mapQuakeRadius(NaN, 1000), mapQuakeRadius(1, 1000));
  assert.ok(mapQuakeRadius(6, 390) < mapQuakeRadius(6, 1000));
});

test('a point is located in its country, with holes, the open sea and the antimeridian handled', () => {
  const { mapPrepareWorld, mapCountryAt, mapInRing } = mapBrowser(liveLike());
  const world = mapPrepareWorld(worldRaw);
  const at = (lon, lat) => mapCountryAt(world, lon, lat)?.name ?? null;
  assert.equal(at(139.7, 35.7), 'Japan');
  assert.equal(at(-70.6, -33.4), 'Chile');
  assert.equal(at(-140, 0), null, 'mid-Pacific');
  assert.equal(at(-30, 30), null, 'mid-Atlantic');
  // Lesotho is a hole in South Africa's outline.
  assert.equal(at(28.2, -29.5), 'Lesotho');
  assert.equal(at(28.0, -26.2), 'South Africa');
  // Both sides of the antimeridian.
  assert.equal(at(-175, 67), 'Russia');
  assert.equal(at(175, 67), 'Russia');
  assert.equal(at(178, -17.8), 'Fiji');
  assert.equal(at(179.5, -30), null);
  assert.equal(at(0, -89), 'Antarctica');
  const square = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(mapInRing(square, 5, 5), true);
  assert.equal(mapInRing(square, 15, 5), false);
  assert.equal(mapInRing(square, -1, 5), false);
  assert.throws(() => mapPrepareWorld({ scale: 10, countries: [] }), /unexpected shape/);
  assert.throws(() => mapPrepareWorld({ countries: worldRaw.countries }), /unexpected shape/);
});

test('counts per country keep the offshore points in their own row', () => {
  const { mapPrepareWorld, mapCountByCountry, mapBin, mapBinLabel } = mapBrowser(liveLike());
  const world = mapPrepareWorld(worldRaw);
  const counts = mapCountByCountry(world, [
    { lon: 139.7, lat: 35.7, value: 4.6 }, { lon: 138.2, lat: 36.2, value: 2.1 }, { lon: -70.6, lat: -33.4, value: 6.3 },
    { lon: -140, lat: 0, value: 5.2 }, { lon: -30, lat: 30, value: NaN }
  ]);
  assert.deepEqual(plain(counts.rows).map((row) => [row.name, row.count, row.strongest]), [['Japan', 2, 4.6], ['Chile', 1, 6.3]]);
  assert.equal(counts.offshore.count, 2);
  assert.equal(counts.offshore.strongest, 5.2);
  assert.equal(counts.total, 5);
  assert.equal(counts.rows.reduce((sum, row) => sum + row.count, 0) + counts.offshore.count, counts.total);
  assert.deepEqual([0, 1, 2, 4, 5, 9, 10, 49, 50, 500].map((count) => mapBin(count)), [-1, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  assert.deepEqual([0, 1, 2, 3, 4].map((index) => mapBinLabel(index)), ['1', '2–4', '5–9', '10–49', '50 or more']);
});

test('the page loads the map script before the page script and asks nothing outside its origin', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/assets/data-toolbox/live-map.js') > 0);
  assert.ok(html.indexOf('/assets/data-toolbox/live-map.js') < html.indexOf('/assets/data-toolbox/app.js'));
  const script = fs.readFileSync(path.join(publicRoot, 'live-map.js'), 'utf8');
  assert.doesNotMatch(script, /https?:\/\/|\/\/cdn|method:|payload:/);
  assert.doesNotMatch(fs.readFileSync(path.join(publicRoot, 'app.js'), 'utf8'), /Map rendering is intentionally omitted/);
});

test('the Live view draws the ISS, its track, the earthquakes and the stored points, with a table for each', async () => {
  const browser = await openMap();
  const paths = browser.requests.map((request) => `${request.pathname}${request.search}`);
  assert.deepEqual(paths.filter((entry) => !entry.startsWith('/api/')), ['/assets/data-toolbox/geo/world-110m.json']);
  for (const expected of ['/live-data/iss/latest?limit=100', '/live-data/quakes/history?order=desc&limit=500', '/live-data/weather/latest?limit=100',
    '/live-data/air_quality/latest?limit=100', '/live-data/sensors/latest?limit=100']) assert.ok(paths.includes(`/api/data-toolbox${expected}`), expected);
  assert.match(browser.content.innerHTML, /<section id="liveMap"><\/section>\s*<p class="refresh-stamp" id="liveFeedsStamp"[^>]*>[^<]*<\/p>\s*<div id="liveFeeds"><div class="grid">/, 'the map sits above the feed figures');

  const html = browser.map.innerHTML;
  assert.match(html, /<h2>World map<\/h2>/);
  assert.match(html, /data-map-view="live" aria-pressed="true">Live<\/button><button class="button" data-map-view="country" aria-pressed="false">By country/);
  const svg = svgOf(html);
  assert.match(svg, /viewBox="0 0 1000 500"/);
  assert.match(svg, /role="img" aria-label="World map, equirectangular\. ISS at 20\.00°N, 170\.00°W; 6 earthquakes; 1 stored location; 1 located sensor\./);
  assert.equal((svg.match(/<g class="map-land">/g) || []).length, 1);
  assert.equal((svg.match(/<g class="map-land">[\s\S]*?<\/g>/)[0].match(/<path d="M/g) || []).length, 177);
  assert.match(svg, /<title>Japan<\/title>/);

  // ISS: a labelled marker at the newest point, and a track in two lines cut on the map's edges.
  assert.match(svg, /<g class="map-iss"><title>ISS at 20\.00°N, 170\.00°W, [^<]+<\/title><circle cx="27\.8" cy="194\.4" r="9"\/>/);
  assert.match(svg, /<text class="map-label iss"[^>]*>ISS<\/text>/);
  const lines = [...svg.matchAll(/<polyline class="map-track" points="([^"]+)"/g)].map((match) => match[1].split(' ').map((pair) => numbers(pair)));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].at(-1)[0], 1000);
  assert.equal(lines[1][0][0], 0);
  assert.equal(lines[0].at(-1)[1], lines[1][0][1]);
  for (const line of lines) for (let i = 1; i < line.length; i += 1) assert.ok(Math.abs(line[i][0] - line[i - 1][0]) < 20, 'no streak across the map');
  // 95 minutes of the 100 loaded points.
  assert.equal(lines.flat().length, 96 + 2);

  // Earthquakes: weakest first, so the strongest is drawn last and on top.
  const circles = [...svg.matchAll(/<circle class="map-quake" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"><title>([^<]*)<\/title>/g)];
  assert.equal(circles.length, 6);
  const radii = circles.map((match) => Number(match[3]));
  assert.deepEqual(radii, [...radii].sort((a, b) => a - b));
  assert.match(circles.at(-1)[4], /^M 6\.3 · 12 km S of Example Valley, Chile · /);
  assert.match(circles[0][4], /^M -0\.4 · Example Peninsula, Russia · .* · quarry blast$/);
  assert.deepEqual(circles.at(-1).slice(1, 3), ['303.9', '342.8']);
  assert.match(svg, /<text class="map-label quake"[^>]*>M 6\.3<\/text>/);

  // Stored location: pressure and air quality at the same coordinates share one labelled marker.
  assert.equal((svg.match(/<rect class="map-station"/g) || []).length, 1);
  assert.match(svg, /<title>Location 10\.50°N, 20\.25°E: 1007\.4 hPa · AQI 29<\/title>/);
  assert.match(svg, /<text class="map-label station"[^>]*>1007\.4 hPa · AQI 29<\/text>/);
  // Sensors: the newest point of a topic with coordinates; the one without is said, not drawn.
  assert.equal((svg.match(/<path class="map-sensor"/g) || []).length, 1);
  assert.match(svg, /<text class="map-label sensor"[^>]*>greenhouse temperature 21\.5<\/text>/);

  // Legend and the non-visual equivalents.
  assert.match(html, /ISS track, last 95 min/);
  assert.match(html, /circle area doubles per magnitude unit; below M 1 the smallest size/);
  assert.match(html, /Equirectangular projection; country outlines from Natural Earth 1:110m, stored with this page\. The ISS position is read again every 60 s/);
  assert.match(html, /<caption>ISS: current position, and its track of 96 points from /);
  assert.match(html, /<td class="mono">20\.000<\/td><td class="mono">-170\.000<\/td>/);
  assert.match(html, /<caption>Locations and sensors on the map, latest value each · 1 recent sensor point without coordinates not drawn<\/caption>/);
  assert.match(html, /1007\.4 hPa <span class="muted">/);
  assert.match(html, /US AQI 29 · PM2\.5 3\.4 µg\/m³/);
  assert.match(html, /Sensor <span class="mono">sensors\/example\/greenhouse<\/span>/);
  assert.match(html, /<caption>6 events of the current list, strongest first · 1 are not earthquakes \(see Type\) · 1 row without usable coordinates left out<\/caption>/);
  const rows = html.slice(html.indexOf('aria-label="Earthquakes table"')).match(/<tr><td>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 6);
  assert.match(rows[0], /<td>M 6\.3<\/td><td>12 km S of Example Valley, Chile<\/td><td>10\.5 km<\/td><td class="mono">33\.40°S, 70\.60°W<\/td><td>earthquake<\/td>/);
  assert.match(rows.at(-1), /<td>M -0\.4<\/td>.*<td>quarry blast<\/td>/);
  assert.doesNotMatch(html, /class="notice warning"/);
  // Two 60 s timers on this tab: the feed cards and the ISS marker, each on its own refresher.
  assert.deepEqual(browser.timers.filter((timer) => timer.ms === 60000).map((timer) => timer.callback),
    [browser.liveFeedsRefresher.tick, browser.mapRefresher.tick]);
});

test('a hostile place string is escaped in the map and in the table', async () => {
  const browser = await openMap();
  const html = browser.map.innerHTML;
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /onerror=alert\(1\)>"/);
  const escaped = '5 km N of &lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
  assert.ok(svgOf(html).includes(`M 1.4 · ${escaped} · `));
  assert.ok(html.includes(`<td>${escaped}</td>`));
  browser.setLiveMapView('country');
  assert.doesNotMatch(browser.map.innerHTML, /<img/);
});

test('the By country view shades countries by their count and lists the offshore events', async () => {
  const browser = await openMap();
  browser.setLiveMapView('country');
  const html = browser.map.innerHTML;
  assert.match(html, /data-map-view="country" aria-pressed="true">By country/);
  assert.match(html, /This view counts earthquakes: the events of the feed's current daily list that fall inside each country outline \(1 of them are listed by the feed as another type/);
  assert.match(html, /counts as offshore\. Another point feed could be shaded the same way; only earthquakes are\./);
  const svg = svgOf(html);
  assert.match(svg, /class="counted" style="fill:#2f93a3"><title>Japan: 2 events, strongest M 4\.6<\/title>/);
  assert.match(svg, /class="counted" style="fill:#2a7482"><title>Chile: 1 event, strongest M 6\.3<\/title>/);
  assert.match(svg, /class="counted" style="fill:#2a7482"><title>Lesotho: 1 event, strongest M 1\.4<\/title>/);
  assert.match(svg, /<path d="[^"]+"><title>South Africa: no event<\/title>/);
  assert.equal((svg.match(/class="counted"/g) || []).length, 4);
  // The count is written on each counted country, and the offshore event is drawn.
  assert.deepEqual([...svg.matchAll(/<text class="map-label count"[^>]*>(\d+)<\/text>/g)].map((match) => match[1]), ['2', '1', '1', '1']);
  assert.equal((svg.match(/<circle class="map-offshore"/g) || []).length, 1);
  assert.match(svg, /<title>Offshore: M 5\.2 · Example Fracture Zone · /);
  assert.doesNotMatch(svg, /map-iss|map-track|map-quake/);
  for (const range of ['>0<', '>1<', '>2–4<', '>5–9<', '>10–49<', '>50 or more<', 'offshore event', 'the count is written on each country']) assert.ok(html.includes(range), range);
  assert.match(html, /<caption>6 events of the current list: 5 inside a country outline, 1 offshore<\/caption>/);
  const rows = html.slice(html.indexOf('aria-label="Earthquakes by country table"')).match(/<tr><td>[\s\S]*?<\/tr>/g);
  assert.deepEqual(rows.map((row) => row.replace(/<[^>]+>/g, '|').split('|').filter(Boolean)), [
    ['1', 'Japan', '2', 'M 4.6'], ['2', 'Chile', '1', 'M 6.3'], ['3', 'Lesotho', '1', 'M 1.4'], ['4', 'Russia', '1', 'M -0.4'],
    ['—', 'Offshore / no country', '1', 'M 5.2']
  ]);
  browser.setLiveMapView('nowhere');
  assert.match(browser.map.innerHTML, /data-map-view="country" aria-pressed="true"/);
  browser.setLiveMapView('live');
  assert.match(svgOf(browser.map.innerHTML), /map-iss/);
});

test('a layer that cannot be read shows its notice and the other layers still render', async () => {
  const browser = await openMap(liveLike({ '/live-data/quakes/history': new Error('Data service request timed out'), '/live-data/weather/latest': new Error('upstream <b>down</b>') }));
  const html = browser.map.innerHTML;
  assert.match(html, /<div class="notice warning"><strong>Earthquakes<\/strong> could not be read from Data: Data service request timed out\. The other layers do not depend on it\.<\/div>/);
  assert.match(html, /<strong>Pressure<\/strong> could not be read from Data: upstream &lt;b&gt;down&lt;\/b&gt;\./);
  const svg = svgOf(html);
  assert.match(svg, /map-iss/);
  assert.equal((svg.match(/<polyline class="map-track"/g) || []).length, 2);
  assert.doesNotMatch(svg, /map-quake/);
  // Air quality alone still places the stored location.
  assert.match(svg, /<text class="map-label station"[^>]*>AQI 29<\/text>/);
  assert.match(html, /No earthquake to list\./);
  browser.setLiveMapView('country');
  assert.match(browser.map.innerHTML, /The earthquake list could not be read, so there is nothing to count\./);
  assert.doesNotMatch(browser.map.innerHTML, /Offshore \/ no country/);
});

test('a feed that is off or empty is said per layer', async () => {
  const feeds = feedsBody.map((entry) => entry.id === 'iss' ? { ...entry, enabled: false }
    : entry.id === 'quakes' ? { ...entry, enabled: false, lastError: 'HTTP 503 <upstream>' } : entry);
  const stale = issBody.map((point) => ({ ...point, timeStamp: new Date(new Date(point.timeStamp).getTime() - 3 * 3600000).toISOString() }));
  const browser = await openMap(liveLike({ '/live-data/feeds': feeds, '/live-data/iss/latest': stale, '/live-data/quakes/history': [], '/live-data/sensors/latest': [sensorsBody[2]], '/live-data/air_quality/latest': [] }));
  const html = browser.map.innerHTML;
  assert.match(html, /<strong>ISS<\/strong>: the feed is off in Data: what is drawn is the last stored data\./);
  assert.match(html, /<strong>Earthquakes<\/strong>: no stored point, so nothing is drawn; the feed is off in Data; last fetch error: HTTP 503 &lt;upstream&gt;\./);
  assert.match(html, /<strong>Air quality<\/strong>: no stored point, so nothing is drawn\./);
  assert.match(html, /<strong>Sensors<\/strong>: none of the stored points carries coordinates, so nothing is drawn\./);
  assert.match(html, /<strong>ISS<\/strong>: the last position is 3h ago \([^)]+\); it is drawn as the last known position, not the current one\./);
  assert.match(svgOf(html), /<g class="map-iss stale">/);
  assert.match(svgOf(html), /<text class="map-label iss"[^>]*>ISS \(last known\)<\/text>/);
  assert.match(html, /<caption>ISS: last known position/);
  assert.doesNotMatch(html, /<strong>Pressure<\/strong>/);
  // The country view reports on the earthquake layer only.
  browser.setLiveMapView('country');
  assert.match(browser.map.innerHTML, /<strong>Earthquakes<\/strong>: no stored point/);
  assert.doesNotMatch(browser.map.innerHTML, /<strong>(ISS|Sensors|Air quality)<\/strong>/);

  const paused = await openMap(liveLike({ '/live-data/state': { liveDataEnabled: false } }));
  for (const layer of ['ISS', 'Earthquakes', 'Pressure', 'Air quality', 'Sensors']) assert.match(paused.map.innerHTML, new RegExp(`<strong>${layer}</strong>: the feed is off in Data: what is drawn is the last stored data\\.`));

  const empty = await openMap(liveLike({ '/live-data/iss/latest': [], '/live-data/quakes/history': [], '/live-data/weather/latest': [], '/live-data/air_quality/latest': [], '/live-data/sensors/latest': [] }));
  assert.match(empty.map.innerHTML, /<strong>ISS<\/strong>: no stored point, so nothing is drawn\./);
  assert.match(empty.map.innerHTML, /No ISS position to list\./);
  assert.match(svgOf(empty.map.innerHTML), /aria-label="World map, equirectangular\. No ISS position; 0 earthquakes; 0 stored locations; 0 located sensors\./);
  empty.setLiveMapView('country');
  assert.match(empty.map.innerHTML, /<caption>0 events of the current list: 0 inside a country outline, 0 offshore<\/caption>/);
  assert.match(empty.map.innerHTML, /Offshore \/ no country<\/th><td>0<\/td><td>—<\/td>/);
});

test('without the country geometry the Live view falls back to a plain grid with the points', async () => {
  for (const world of [new Error('missing'), { scale: 10, countries: 'broken' }]) {
    const browser = await openMap(liveLike(), { world });
    const html = browser.map.innerHTML;
    assert.match(html, /<div class="notice warning"><strong>Country outlines<\/strong> could not be loaded \((the geometry file returned 404|the country geometry file has an unexpected shape)\)\. The points are drawn on a plain grid and the country view is unavailable\.<\/div>/);
    const svg = svgOf(html);
    assert.doesNotMatch(svg, /map-land/);
    assert.match(svg, /<g class="map-grid" aria-hidden="true"><line /);
    assert.match(svg, /60°N/);
    assert.equal((svg.match(/<circle class="map-quake"/g) || []).length, 6);
    assert.match(svg, /map-iss/);
    browser.setLiveMapView('country');
    assert.match(browser.map.innerHTML, /The country view needs the country outlines, which could not be loaded\. The Live view still draws the points\./);
  }
});

test('a phone-width map is drawn at its own width with smaller circles', async () => {
  const browser = mapBrowser(liveLike());
  browser.document.querySelector('#liveMap').clientWidth = 362;
  await browser.render();
  const svg = svgOf(browser.map.innerHTML);
  assert.match(svg, /viewBox="0 0 362 181" width="362" height="181"/);
  assert.doesNotMatch(svg, /60°N/);
  // A resize to another width redraws the stage; the same width does not.
  const stage = browser.element('#liveMapStage');
  stage.innerHTML = '';
  browser.listeners['window:resize'][0]();
  assert.equal(stage.innerHTML, '');
  browser.document.querySelector('#liveMap').clientWidth = 800;
  browser.listeners['window:resize'][0]();
  assert.match(stage.innerHTML, /viewBox="0 0 800 400"/);
});

// The ISS marker and the feed cards both read every 60 s, each on its own refresher.
const issTimer = (browser) => browser.timers.find((entry) => entry.ms === 60000 && entry.callback === browser.mapRefresher.tick);

test('only the ISS is read again, every 60 seconds, while the tab is open and the page visible', async () => {
  let issReads = 0;
  const moved = [{ ...issBody[0], _id: 'new', latitude: 21.5, longitude: -166, timeStamp: new Date(NOW).toISOString() }, ...issBody];
  const browser = await openMap(liveLike({ get '/live-data/iss/latest'() { issReads += 1; return issReads > 1 ? moved : issBody; } }));
  const timer = issTimer(browser);
  const before = browser.requests.length;
  browser.document.hidden = true;
  await timer.callback();
  assert.equal(browser.requests.length, before, 'a hidden page asks nothing');
  browser.document.hidden = false;
  await timer.callback();
  assert.deepEqual(browser.requests.slice(before).map((request) => `${request.pathname}${request.search}`), ['/api/data-toolbox/live-data/iss/latest?limit=100']);
  assert.match(browser.element('#liveMapFigure').innerHTML, /ISS at 21\.50°N, 166\.00°W/);
  assert.match(browser.element('#liveMapIss').innerHTML, /<td class="mono">21\.500<\/td><td class="mono">-166\.000<\/td>/);
  assert.equal(browser.element('#liveMapNotes').innerHTML, '');
  assert.match(browser.element('#lastUpdated').textContent, /^last read /);

  // In the country view the read still happens but the map is left alone.
  browser.setLiveMapView('country');
  browser.element('#liveMapFigure').innerHTML = 'untouched';
  await timer.callback();
  assert.equal(browser.element('#liveMapFigure').innerHTML, 'untouched');

  // A failed refresh becomes the ISS layer's notice; the earthquakes stay.
  let down = false;
  const failing = await openMap(liveLike({ get '/live-data/iss/latest'() { return down ? new Error('Data service request timed out') : issBody; } }));
  down = true;
  await issTimer(failing).callback();
  assert.match(failing.element('#liveMapNotes').innerHTML, /<strong>ISS<\/strong> could not be read from Data: Data service request timed out\./);
  assert.match(failing.element('#liveMapFigure').innerHTML, /map-quake/);
  assert.doesNotMatch(failing.element('#liveMapFigure').innerHTML, /map-iss/);
});

test('the map timer stops on another tab and a late answer is dropped', async () => {
  const browser = await openMap();
  const timer = issTimer(browser);
  const id = browser.timers.indexOf(timer) + 1;
  browser.state.tab = 'overview';
  const before = browser.requests.length;
  await timer.callback();
  assert.equal(browser.requests.length, before);
  assert.deepEqual(browser.cleared, [id]);
  assert.equal(browser.mapRefresher.timer, null);
  browser.setLiveMapView('country');
  assert.equal(browser.mapState.view, 'live', 'no view change from another tab');

  // An answer that arrives after the operator left the tab writes nothing.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const late = mapBrowser(async (route) => { if (route === '/live-data/iss/latest' && late.mapState.loaded) await pending; return liveLike()(route); });
  await late.render();
  late.element('#liveMapFigure').innerHTML = 'before';
  const tick = issTimer(late).callback();
  late.state.tab = 'gpu';
  release();
  await tick;
  assert.equal(late.element('#liveMapFigure').innerHTML, 'before');
  assert.equal(late.mapRefresher.busy, false);
});
