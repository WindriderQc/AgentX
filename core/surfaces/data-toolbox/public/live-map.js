'use strict';

// The world map of the Toolbox Live Data tab (read-only). Loaded before
// app.js, whose helpers (state, api, e, heading, number, date, ageLabel…) it
// uses when called. Two views of the same reads:
//   - Live: ISS position and last orbit, earthquakes sized by magnitude,
//     stored locations and sensors that carry coordinates;
//   - By country: countries shaded by the number of earthquakes inside them.
// Everything is drawn here as inline SVG from geo/world-110m.json, a static
// file of this surface: no tile server, no library, no request outside the
// AgentX origin. Each layer keeps its own result, so one failed read shows a
// notice and the others still render. Only the ISS refreshes on a timer.
//
// Projection: equirectangular (plate carrée). x is proportional to longitude,
// y to latitude, the whole globe is shown and nothing is clipped. The SVG is
// drawn at the pixel width of its container, so radii and text are real
// pixels at every width; a resize redraws it.

const MAP_REFRESH_MS = 60000;
const MAP_TRACK_MS = 95 * 60000; // one ISS orbit is about 93 minutes
const MAP_TRACK_GAP_MS = 5 * 60000; // a longer hole between two points breaks the line
const MAP_ISS_STALE_MS = 5 * 60000;
const MAP_ISS_LIMIT = 100; // the relay's ceiling for /latest; one point per minute
const MAP_POINT_LIMIT = 100;
const MAP_QUAKE_LIMIT = 500; // the relay's ceiling for /history; the daily list holds about 200
const MAP_WORLD_URL = '/assets/data-toolbox/geo/world-110m.json';
// Lower bound of each shade of the country view, lightest count first.
const MAP_BINS = Object.freeze([1, 2, 5, 10, 50]);
const MAP_BIN_FILLS = Object.freeze(['#2a7482', '#2f93a3', '#3bb3c4', '#63d3e0', '#b4f4fa']);
const MAP_LAYERS = Object.freeze([
  { key: 'iss', feed: 'iss', name: 'ISS', route: `/live-data/iss/latest?limit=${MAP_ISS_LIMIT}` },
  { key: 'quakes', feed: 'quakes', name: 'Earthquakes', route: `/live-data/quakes/history?order=desc&limit=${MAP_QUAKE_LIMIT}` },
  { key: 'weather', feed: 'weather', name: 'Pressure', route: `/live-data/weather/latest?limit=${MAP_POINT_LIMIT}` },
  { key: 'air', feed: 'air_quality', name: 'Air quality', route: `/live-data/air_quality/latest?limit=${MAP_POINT_LIMIT}` },
  { key: 'sensors', feed: 'sensors', name: 'Sensors', route: `/live-data/sensors/latest?limit=${MAP_POINT_LIMIT}` }
]);

const mapState = { view: 'live', world: null, worldLoad: null, layers: {}, feeds: [], paused: false, loaded: false, busy: false, timer: null, width: 0, paths: null };

const mapSettled = (promise) => promise.then((data) => ({ data }), (error) => ({ error: error.message }));
const mapFixed = (value, digits = 1) => Number.isFinite(measurement(value)) ? measurement(value).toFixed(digits) : '—';
const mapMag = (value) => Number.isFinite(measurement(value)) ? `M ${measurement(value).toFixed(1)}` : 'M —';
const mapPlural = (count, word) => `${number(count)} ${word}${count === 1 ? '' : 's'}`;
const mapCoordinate = (lat, lon) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
const mapTime = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : '—';

// A coordinate pair is usable when both numbers are present and on the globe.
function mapPosition(lat, lon) {
  const latitude = measurement(lat); const longitude = measurement(lon);
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? { lat: latitude, lon: longitude } : null;
}

function mapProject(lon, lat, width) {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * (width / 2)];
}

// Cuts a chronological track into the lines to draw. Two things end a line:
// a hole in time, and the antimeridian. A step of more than 180° of longitude
// is the short way round through ±180°, never a line across the map: the
// crossing latitude is interpolated, one line ends on that edge and the next
// starts on the opposite one.
function mapSplitTrack(points, gapMs = MAP_TRACK_GAP_MS) {
  const lines = [];
  let line = [];
  const close = () => { if (line.length) lines.push(line); line = []; };
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && point.at - previous.at > gapMs) close();
    else if (previous && Math.abs(point.lon - previous.lon) > 180) {
      const edge = previous.lon > 0 ? 180 : -180;
      const toEdge = edge - previous.lon;
      const fromEdge = point.lon + edge;
      const total = toEdge + fromEdge;
      const lat = previous.lat + (total ? toEdge / total : 0.5) * (point.lat - previous.lat);
      line.push([edge, lat]);
      close();
      line.push([-edge, lat]);
    }
    line.push([point.lon, point.lat]);
  });
  close();
  return lines;
}

// Circle area doubles with each magnitude unit; anything below M 1 (and an
// unknown magnitude) is drawn at the smallest size.
function mapQuakeRadius(mag, width) {
  const magnitude = Number.isFinite(mag) ? Math.max(1, mag) : 1;
  return (width < 600 ? 1.5 : 2.2) * 2 ** ((magnitude - 1) / 2);
}

// The vendored file stores rings as flat [lon, lat, …] integers in tenths of a
// degree; a ring is implicitly closed, the first ring of a polygon is its
// outline and the others are holes. Each polygon gets its bounding box.
function mapPrepareWorld(raw) {
  const scale = Number(raw?.scale);
  if (!Number.isFinite(scale) || scale <= 0 || !Array.isArray(raw?.countries) || !raw.countries.length) throw new Error('the country geometry file has an unexpected shape');
  const countries = raw.countries.map((country) => {
    let largest = null;
    const polygons = array(country.polygons).map((rings) => {
      const outline = rings[0];
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < outline.length; i += 2) {
        box[0] = Math.min(box[0], outline[i]); box[1] = Math.min(box[1], outline[i + 1]);
        box[2] = Math.max(box[2], outline[i]); box[3] = Math.max(box[3], outline[i + 1]);
      }
      const polygon = { rings, box };
      const size = (box[2] - box[0]) * (box[3] - box[1]);
      if (!largest || size > largest.size) largest = { size, box };
      return polygon;
    });
    if (!polygons.length || typeof country.name !== 'string') throw new Error('the country geometry file has an unexpected shape');
    // Where a count is written: the middle of the country's largest part.
    const anchor = [(largest.box[0] + largest.box[2]) / 2 / scale, (largest.box[1] + largest.box[3]) / 2 / scale];
    return { id: country.id ?? null, name: country.name, polygons, anchor };
  });
  return { scale, source: String(raw.source || ''), countries };
}

// Ray casting: a point is inside a ring when a ray towards +x crosses its
// edges an odd number of times.
function mapInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i]; const yi = ring[i + 1]; const xj = ring[j]; const yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The country whose outline holds the point, or null at sea. A point inside a
// hole of a polygon is not in that polygon (Lesotho is a hole of South Africa).
function mapCountryAt(world, lon, lat) {
  const x = lon * world.scale; const y = lat * world.scale;
  for (const country of world.countries) {
    for (const { rings, box } of country.polygons) {
      if (x < box[0] || x > box[2] || y < box[1] || y > box[3]) continue;
      if (mapInRing(rings[0], x, y) && !rings.slice(1).some((hole) => mapInRing(hole, x, y))) return country;
    }
  }
  return null;
}

// Counts points per country. A point outside every outline is counted in
// `offshore`, never dropped. `value` (a magnitude here) keeps its maximum.
// Any point feed with { lon, lat, value } can be counted this way.
function mapCountByCountry(world, points) {
  const byName = new Map();
  const offshore = { count: 0, strongest: null, points: [] };
  for (const point of points) {
    const country = mapCountryAt(world, point.lon, point.lat);
    let row = offshore;
    if (country) {
      if (!byName.has(country.name)) byName.set(country.name, { name: country.name, id: country.id, count: 0, strongest: null });
      row = byName.get(country.name);
    } else offshore.points.push(point);
    row.count += 1;
    if (Number.isFinite(point.value) && (row.strongest === null || point.value > row.strongest)) row.strongest = point.value;
  }
  const rows = [...byName.values()].sort((a, b) => b.count - a.count || (b.strongest ?? -Infinity) - (a.strongest ?? -Infinity) || a.name.localeCompare(b.name));
  return { rows, byName, offshore, total: points.length };
}

function mapBin(count) {
  let bin = -1;
  MAP_BINS.forEach((from, index) => { if (count >= from) bin = index; });
  return bin;
}

const mapBinLabel = (index) => index === MAP_BINS.length - 1 ? `${MAP_BINS[index]} or more`
  : MAP_BINS[index + 1] - 1 === MAP_BINS[index] ? String(MAP_BINS[index]) : `${MAP_BINS[index]}–${MAP_BINS[index + 1] - 1}`;

// ── what each layer's rows become ────────────────────────────────

const mapRows = (key) => array(mapState.layers[key]?.data);

// Chronological ISS points, the current one last, and its last orbit.
function mapIss() {
  const points = mapRows('iss').map((row) => ({ ...mapPosition(row?.latitude, row?.longitude), at: new Date(row?.timeStamp).getTime() }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.at)).sort((a, b) => a.at - b.at);
  const current = points.at(-1) || null;
  const track = current ? points.filter((point) => point.at >= current.at - MAP_TRACK_MS) : [];
  return { current, track, stale: current ? Date.now() - current.at > MAP_ISS_STALE_MS : false };
}

// Located events, weakest first so the strongest is drawn last, on top.
function mapQuakes() {
  const rows = mapRows('quakes');
  const events = rows.map((row) => {
    const position = mapPosition(row?.latitude, row?.longitude);
    const mag = measurement(row?.mag);
    return position && {
      ...position, mag, value: mag, at: new Date(row.time).getTime(), place: String(row.place || 'unknown place'),
      depth: measurement(row.depth), type: String(row.type || 'earthquake')
    };
  }).filter(Boolean).sort((a, b) => (Number.isFinite(a.mag) ? a.mag : -Infinity) - (Number.isFinite(b.mag) ? b.mag : -Infinity));
  return { events, unplaced: rows.length - events.length, truncated: rows.length >= MAP_QUAKE_LIMIT };
}

// One marker per stored location: the newest pressure and the newest air
// quality reading at the same coordinates share it. Rows arrive newest first.
function mapStations() {
  const stations = new Map();
  const at = (position) => {
    const key = `${position.lat.toFixed(2)},${position.lon.toFixed(2)}`;
    if (!stations.has(key)) stations.set(key, { ...position });
    return stations.get(key);
  };
  for (const row of mapRows('weather')) {
    const position = mapPosition(row?.lat, row?.lon);
    if (!position) continue;
    const station = at(position);
    if (station.pressureAt === undefined) Object.assign(station, { pressure: measurement(row.pressure), pressureAt: new Date(row.timeStamp).getTime() });
  }
  for (const row of mapRows('air')) {
    const position = mapPosition(row?.geo?.lat, row?.geo?.lon);
    if (!position) continue;
    const station = at(position);
    if (station.airAt === undefined) Object.assign(station, { aqi: measurement(row.payload?.us_aqi), pm25: measurement(row.payload?.pm2_5), airAt: new Date(row.ts).getTime() });
  }
  return [...stations.values()].map((station) => ({
    ...station,
    text: [Number.isFinite(station.pressure) ? `${mapFixed(station.pressure)} hPa` : '', Number.isFinite(station.aqi) ? `AQI ${mapFixed(station.aqi, 0)}` : '']
      .filter(Boolean).join(' · ') || 'no value'
  }));
}

// The newest point of each MQTT topic that carries coordinates.
function mapSensors() {
  const rows = mapRows('sensors');
  const sensors = new Map();
  let located = 0;
  for (const row of rows) {
    const position = mapPosition(row?.geo?.lat, row?.geo?.lon);
    if (!position) continue;
    located += 1;
    const topic = String(row.payload?.topic || 'sensor');
    if (sensors.has(topic)) continue;
    const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const field = Number.isFinite(measurement(payload.value)) ? 'value'
      : Object.keys(payload).find((key) => !['topic', 'lat', 'lon'].includes(key) && typeof payload[key] === 'number');
    const name = topic.split('/').filter(Boolean).at(-1) || topic;
    sensors.set(topic, {
      ...position, topic, at: new Date(row.ts).getTime(),
      text: `${name.slice(0, 24)}${field ? ` ${field === 'value' ? '' : `${field} `}${mapFixed(payload[field])}` : ''}`,
      value: field ? `${field === 'value' ? '' : `${field} `}${mapFixed(payload[field])}` : '—'
    });
  }
  return { sensors: [...sensors.values()], unplaced: rows.length - located };
}

// ── drawing ──────────────────────────────────────────────────────

function mapWidth() {
  const measured = Math.round(Number(document.querySelector('#liveMap')?.clientWidth));
  return Math.min(1400, Math.max(300, measured || 960));
}

// One SVG path per country, all its polygons and holes together (even-odd
// fill leaves the holes empty). Kept until the width changes.
function mapCountryPaths(world, width) {
  if (mapState.paths?.width === width && mapState.paths.world === world) return mapState.paths.list;
  const k = width / 360 / world.scale;
  const list = world.countries.map((country) => country.polygons.map(({ rings }) => rings.map((ring) => {
    let d = '';
    for (let i = 0; i < ring.length; i += 2) d += `${i ? 'L' : 'M'}${((ring[i] + 180 * world.scale) * k).toFixed(1)} ${((90 * world.scale - ring[i + 1]) * k).toFixed(1)}`;
    return `${d}Z`;
  }).join('')).join(''));
  mapState.paths = { width, world, list };
  return list;
}

function mapGraticule(width) {
  const height = width / 2;
  const lines = [];
  for (let lon = -150; lon <= 150; lon += 30) { const x = mapProject(lon, 0, width)[0].toFixed(1); lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`); }
  for (let lat = -60; lat <= 60; lat += 30) { const y = mapProject(0, lat, width)[1].toFixed(1); lines.push(`<line${lat ? '' : ' class="equator"'} x1="0" y1="${y}" x2="${width}" y2="${y}"/>`); }
  // Degree labels need room: a phone-width map keeps the lines only.
  const ticks = width < 600 ? [] : [-60, -30, 0, 30, 60].map((lat) => `<text x="4" y="${(mapProject(0, lat, width)[1] - 3).toFixed(1)}">${lat ? `${Math.abs(lat)}°${lat < 0 ? 'S' : 'N'}` : '0°'}</text>`)
    .concat([-120, -60, 0, 60, 120].map((lon) => `<text x="${(mapProject(lon, 0, width)[0] + 3).toFixed(1)}" y="${height - 4}">${lon ? `${Math.abs(lon)}°${lon < 0 ? 'W' : 'E'}` : '0°'}</text>`));
  return `<g class="map-grid" aria-hidden="true">${lines.join('')}${ticks.join('')}</g>`;
}

// A label beside a marker; it flips to the left when it would leave the map.
function mapLabel(x, y, text, className, width) {
  const left = x + 12 + text.length * 6.6 > width;
  return `<text class="map-label ${className}" x="${(x + (left ? -10 : 10)).toFixed(1)}" y="${(Math.max(11, y + 4)).toFixed(1)}"${left ? ' text-anchor="end"' : ''}>${e(text)}</text>`;
}

function mapFrame(width, description, body) {
  const height = width / 2;
  return `<svg class="live-map" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${e(description)}"><title>${e(description)}</title>
    <rect class="map-ocean" width="${width}" height="${height}"/>${body}</svg>`;
}

const mapQuakeTitle = (quake) => `${mapMag(quake.mag)} · ${quake.place} · ${mapTime(quake.at)}${quake.type === 'earthquake' ? '' : ` · ${quake.type}`}`;

function mapLiveSvg(width) {
  const world = mapState.world?.data;
  const iss = mapIss();
  const { events } = mapQuakes();
  const stations = mapStations();
  const { sensors } = mapSensors();
  const land = world ? `<g class="map-land">${mapCountryPaths(world, width).map((d, index) => `<path d="${d}"><title>${e(world.countries[index].name)}</title></path>`).join('')}</g>` : '';
  const circles = events.map((quake) => {
    const [x, y] = mapProject(quake.lon, quake.lat, width);
    return `<circle class="map-quake" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${mapQuakeRadius(quake.mag, width).toFixed(1)}"><title>${e(mapQuakeTitle(quake))}</title></circle>`;
  }).join('');
  // The three strongest events carry their magnitude on the map.
  const strongest = events.filter((quake) => Number.isFinite(quake.mag)).slice(-3).map((quake) => {
    const [x, y] = mapProject(quake.lon, quake.lat, width);
    return mapLabel(x + mapQuakeRadius(quake.mag, width) - 6, y, mapMag(quake.mag), 'quake', width);
  }).join('');
  const squares = stations.map((station) => {
    const [x, y] = mapProject(station.lon, station.lat, width);
    return `<rect class="map-station" x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="8" height="8"><title>${e(`Location ${mapCoordinate(station.lat, station.lon)}: ${station.text}`)}</title></rect>${mapLabel(x, y, station.text, 'station', width)}`;
  }).join('');
  const triangles = sensors.map((sensor) => {
    const [x, y] = mapProject(sensor.lon, sensor.lat, width);
    return `<path class="map-sensor" d="M${x.toFixed(1)} ${(y - 5).toFixed(1)}l5 9h-10z"><title>${e(`Sensor ${sensor.topic}: ${sensor.value} at ${mapCoordinate(sensor.lat, sensor.lon)}`)}</title></path>${mapLabel(x, y, sensor.text, 'sensor', width)}`;
  }).join('');
  const track = mapSplitTrack(iss.track).filter((line) => line.length > 1)
    .map((line) => `<polyline class="map-track" points="${line.map(([lon, lat]) => mapProject(lon, lat, width).map((value) => value.toFixed(1)).join(',')).join(' ')}"/>`).join('');
  let marker = '';
  if (iss.current) {
    const [x, y] = mapProject(iss.current.lon, iss.current.lat, width);
    const at = `${x.toFixed(1)} ${y.toFixed(1)}`;
    marker = `<g class="map-iss${iss.stale ? ' stale' : ''}"><title>${e(`ISS at ${mapCoordinate(iss.current.lat, iss.current.lon)}, ${mapTime(iss.current.at)}`)}</title><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"/><path d="M${at}m0 -5l5 5l-5 5l-5 -5z"/></g>${mapLabel(x + 2, y, iss.stale ? 'ISS (last known)' : 'ISS', 'iss', width)}`;
  }
  const description = `World map, equirectangular. ${iss.current ? `ISS at ${mapCoordinate(iss.current.lat, iss.current.lon)}` : 'No ISS position'}; ${mapPlural(events.length, 'earthquake')}; ${mapPlural(stations.length, 'stored location')}; ${mapPlural(sensors.length, 'located sensor')}. The tables below list every point.`;
  return mapFrame(width, description, `${mapGraticule(width)}${land}${circles}${squares}${triangles}${track}${marker}${strongest}`);
}

function mapLiveLegend(width) {
  const sizes = [2, 4, 6].map((mag) => {
    const r = mapQuakeRadius(mag, width); const box = Math.ceil(r * 2 + 2);
    return `<span class="map-key"><svg width="${box}" height="${box}" aria-hidden="true"><circle class="map-quake" cx="${box / 2}" cy="${box / 2}" r="${r.toFixed(1)}"/></svg>M ${mag}</span>`;
  }).join('');
  return `<div class="map-legend">
    <span class="map-key"><svg width="22" height="22" aria-hidden="true"><g class="map-iss"><circle cx="11" cy="11" r="9"/><path d="M11 11m0 -5l5 5l-5 5l-5 -5z"/></g></svg>ISS, labelled</span>
    <span class="map-key"><svg width="26" height="10" aria-hidden="true"><line class="map-track" x1="1" y1="5" x2="25" y2="5"/></svg>ISS track, last ${MAP_TRACK_MS / 60000} min</span>
    <span class="map-key">Earthquakes:</span>${sizes}<span class="map-key muted">circle area doubles per magnitude unit; below M 1 the smallest size</span>
    <span class="map-key"><svg width="12" height="12" aria-hidden="true"><rect class="map-station" x="2" y="2" width="8" height="8"/></svg>Stored location (pressure, air quality)</span>
    <span class="map-key"><svg width="12" height="12" aria-hidden="true"><path class="map-sensor" d="M6 1l5 9h-10z"/></svg>Sensor with coordinates</span>
  </div>`;
}

// One line per layer that is failing, off or empty. The map is drawn with
// whatever the other layers returned. The country view draws the earthquakes
// only, so it reports on that layer only.
function mapNotices() {
  const shown = mapState.view === 'country' ? ['quakes'] : MAP_LAYERS.map((layer) => layer.key);
  const failed = []; const quiet = [];
  const world = mapState.world;
  if (world?.error) failed.push(`<strong>Country outlines</strong> could not be loaded (${e(world.error)}). The points are drawn on a plain grid and the country view is unavailable.`);
  const plotted = { iss: mapIss().track.length, quakes: mapQuakes().events.length, sensors: mapSensors().sensors.length };
  const stations = mapStations();
  plotted.weather = stations.filter((station) => station.pressureAt !== undefined).length;
  plotted.air = stations.filter((station) => station.airAt !== undefined).length;
  for (const layer of MAP_LAYERS.filter((entry) => shown.includes(entry.key))) {
    const result = mapState.layers[layer.key];
    const feed = mapState.feeds.find((entry) => entry?.id === layer.feed);
    const off = mapState.paused || (feed && feed.enabled === false);
    if (result?.error) { failed.push(`<strong>${e(layer.name)}</strong> could not be read from Data: ${e(result.error)}. The other layers do not depend on it.`); continue; }
    const notes = [];
    if (!plotted[layer.key]) {
      notes.push(layer.key === 'sensors' && mapRows('sensors').length ? 'none of the stored points carries coordinates, so nothing is drawn' : 'no stored point, so nothing is drawn');
    }
    if (off) notes.push(plotted[layer.key] ? 'the feed is off in Data: what is drawn is the last stored data' : 'the feed is off in Data');
    if (feed?.lastError) notes.push(`last fetch error: ${e(feed.lastError)}`);
    if (notes.length) quiet.push(`<strong>${e(layer.name)}</strong>: ${notes.join('; ')}.`);
  }
  const iss = mapIss();
  if (iss.stale && shown.includes('iss')) quiet.push(`<strong>ISS</strong>: the last position is ${e(ageLabel(iss.current.at))} (${e(mapTime(iss.current.at))}); it is drawn as the last known position, not the current one.`);
  return `${failed.map((line) => `<div class="notice warning">${line}</div>`).join('')}${quiet.length ? `<div class="notice map-notes">${quiet.map((line) => `<div>${line}</div>`).join('')}</div>` : ''}`;
}

function mapIssTable() {
  const iss = mapIss();
  if (!iss.current) return '<p class="muted">No ISS position to list.</p>';
  const first = iss.track[0];
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="ISS position table"><table><caption>ISS: ${iss.stale ? 'last known position' : 'current position'}, and its track of ${mapPlural(iss.track.length, 'point')} from ${e(mapTime(first.at))}</caption>
    <thead><tr><th scope="col">Observed</th><th scope="col">Age</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Track start</th></tr></thead><tbody>
    <tr><td>${e(mapTime(iss.current.at))}</td><td>${e(ageLabel(iss.current.at) || '—')}</td><td class="mono">${e(iss.current.lat.toFixed(3))}</td><td class="mono">${e(iss.current.lon.toFixed(3))}</td><td class="mono">${e(mapCoordinate(first.lat, first.lon))}</td></tr>
  </tbody></table></div>`;
}

function mapPointsTable() {
  const stations = mapStations();
  const { sensors, unplaced } = mapSensors();
  if (!stations.length && !sensors.length) return '';
  const rows = stations.map((station) => `<tr><th scope="row" class="row-head">Stored location</th><td class="mono">${e(mapCoordinate(station.lat, station.lon))}</td>
      <td>${Number.isFinite(station.pressure) ? `${e(mapFixed(station.pressure))} hPa <span class="muted">${e(mapTime(station.pressureAt))}</span>` : '—'}</td>
      <td>${Number.isFinite(station.aqi) ? `US AQI ${e(mapFixed(station.aqi, 0))}${Number.isFinite(station.pm25) ? ` · PM2.5 ${e(mapFixed(station.pm25))} µg/m³` : ''} <span class="muted">${e(mapTime(station.airAt))}</span>` : '—'}</td></tr>`)
    .concat(sensors.map((sensor) => `<tr><th scope="row" class="row-head">Sensor <span class="mono">${e(sensor.topic)}</span></th><td class="mono">${e(mapCoordinate(sensor.lat, sensor.lon))}</td>
      <td colspan="2">${e(sensor.value)} <span class="muted">${e(mapTime(sensor.at))}</span></td></tr>`));
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="Locations and sensors table"><table><caption>Locations and sensors on the map, latest value each${unplaced ? ` · ${mapPlural(unplaced, 'recent sensor point')} without coordinates not drawn` : ''}</caption>
    <thead><tr><th scope="col">Marker</th><th scope="col">Position</th><th scope="col">Pressure</th><th scope="col">Air quality</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function mapQuakeTable() {
  const { events, unplaced, truncated } = mapQuakes();
  if (!events.length) return '<p class="muted">No earthquake to list.</p>';
  const others = events.filter((quake) => quake.type !== 'earthquake').length;
  const caption = `${mapPlural(events.length, 'event')} of the current list, strongest first${others ? ` · ${number(others)} are not earthquakes (see Type)` : ''}${unplaced ? ` · ${mapPlural(unplaced, 'row')} without usable coordinates left out` : ''}${truncated ? ` · only the newest ${number(MAP_QUAKE_LIMIT)} rows were loaded` : ''}`;
  return `<div class="table-wrap map-table" tabindex="0" role="region" aria-label="Earthquakes table"><table><caption>${e(caption)}</caption>
    <thead><tr><th scope="col">Time</th><th scope="col">Magnitude</th><th scope="col">Place</th><th scope="col">Depth</th><th scope="col">Position</th><th scope="col">Type</th></tr></thead><tbody>
    ${[...events].reverse().map((quake) => `<tr><td>${e(mapTime(quake.at))}</td><td>${e(mapMag(quake.mag))}</td><td>${e(quake.place)}</td><td>${Number.isFinite(quake.depth) ? `${e(mapFixed(quake.depth))} km` : '—'}</td><td class="mono">${e(mapCoordinate(quake.lat, quake.lon))}</td><td>${e(quake.type)}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function mapCountrySvg(width, counts) {
  const world = mapState.world.data;
  const paths = mapCountryPaths(world, width);
  const land = world.countries.map((country, index) => {
    const row = counts.byName.get(country.name);
    const title = row ? `${country.name}: ${mapPlural(row.count, 'event')}, strongest ${mapMag(row.strongest)}` : `${country.name}: no event`;
    return `<path d="${paths[index]}"${row ? ` class="counted" style="fill:${MAP_BIN_FILLS[mapBin(row.count)]}"` : ''}><title>${e(title)}</title></path>`;
  }).join('');
  const dots = counts.offshore.points.map((point) => {
    const [x, y] = mapProject(point.lon, point.lat, width);
    return `<circle class="map-offshore" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.5"><title>${e(`Offshore: ${mapQuakeTitle(point)}`)}</title></circle>`;
  }).join('');
  // The count is written on each counted country: the shade is never the only carrier.
  const labels = counts.rows.map((row) => {
    const country = world.countries.find((entry) => entry.name === row.name);
    const [x, y] = mapProject(country.anchor[0], country.anchor[1], width);
    return `<text class="map-label count" x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle">${number(row.count)}</text>`;
  }).join('');
  const description = `World map, equirectangular, countries shaded by number of earthquakes. ${counts.rows.slice(0, 3).map((row) => `${row.name} ${row.count}`).join(', ') || 'No country has one'}; ${counts.offshore.count} offshore. The table below lists every count.`;
  return mapFrame(width, description, `${mapGraticule(width)}<g class="map-land choropleth">${land}</g>${dots}${labels}`);
}

function mapCountryLegend() {
  return `<div class="map-legend"><span class="map-key">Earthquakes in the country:</span>
    <span class="map-key"><span class="map-swatch neutral" aria-hidden="true"></span>0</span>
    ${MAP_BINS.map((_, index) => `<span class="map-key"><span class="map-swatch" style="background:${MAP_BIN_FILLS[index]}" aria-hidden="true"></span>${e(mapBinLabel(index))}</span>`).join('')}
    <span class="map-key"><svg width="10" height="10" aria-hidden="true"><circle class="map-offshore" cx="5" cy="5" r="2.5"/></svg>offshore event</span>
    <span class="map-key muted">the count is written on each country</span></div>`;
}

function mapCountryTable(counts) {
  const strongest = (value) => value === null ? '—' : e(mapMag(value));
  return `<div class="table-wrap map-table" tabindex="0" role="region" aria-label="Earthquakes by country table"><table><caption>${e(`${mapPlural(counts.total, 'event')} of the current list: ${number(counts.total - counts.offshore.count)} inside a country outline, ${number(counts.offshore.count)} offshore`)}</caption>
    <thead><tr><th scope="col">Rank</th><th scope="col">Country</th><th scope="col">Events</th><th scope="col">Strongest magnitude</th></tr></thead><tbody>
    ${counts.rows.map((row, index) => `<tr><td>${index + 1}</td><th scope="row" class="row-head">${e(row.name)}</th><td>${number(row.count)}</td><td>${strongest(row.strongest)}</td></tr>`).join('')}
    <tr><td>—</td><th scope="row" class="row-head">Offshore / no country</th><td>${number(counts.offshore.count)}</td><td>${strongest(counts.offshore.strongest)}</td></tr>
  </tbody></table></div>`;
}

function mapStage() {
  const width = mapWidth();
  mapState.width = width;
  if (mapState.view === 'country') {
    if (!mapState.world?.data) return `${mapNotices()}<div class="empty">The country view needs the country outlines, which could not be loaded. The Live view still draws the points.</div>`;
    if (mapState.layers.quakes?.error) return `${mapNotices()}<div class="empty">The earthquake list could not be read, so there is nothing to count.</div>`;
    const { events } = mapQuakes();
    const counts = mapCountByCountry(mapState.world.data, events);
    const others = events.filter((quake) => quake.type !== 'earthquake').length;
    return `${mapNotices()}<p class="muted map-help">This view counts earthquakes: the events of the feed's current daily list that fall inside each country outline${others ? ` (${number(others)} of them are listed by the feed as another type, such as a quarry blast; the Live view's table gives the type)` : ''}. Events are located with coarse 1:110m outlines: one just off a coast, or on an island too small to be drawn at that scale, counts as offshore. Another point feed could be shaded the same way; only earthquakes are.</p>
      ${mapCountrySvg(width, counts)}${mapCountryLegend()}${mapCountryTable(counts)}`;
  }
  return `<div id="liveMapNotes">${mapNotices()}</div><div id="liveMapFigure">${mapLiveSvg(width)}</div>${mapLiveLegend(width)}
    <p class="muted map-help">Equirectangular projection; country outlines from Natural Earth 1:110m, stored with this page. The ISS position is read again every ${MAP_REFRESH_MS / 1000} s while this tab is open and visible.</p>
    <section id="liveMapIss">${mapIssTable()}</section>${mapPointsTable()}${mapQuakeTable()}`;
}

function mapPaint(selector, html) {
  const target = document.querySelector(selector);
  if (target && state.tab === 'live-data') target.innerHTML = html;
}

function mapSwitch() {
  return `<div class="map-switch" role="group" aria-label="Map view">${[['live', 'Live'], ['country', 'By country']].map(([view, name]) => `<button class="button${mapState.view === view ? ' active' : ''}" data-map-view="${view}" aria-pressed="${mapState.view === view}">${name}</button>`).join('')}</div>`;
}

function mapSection(body) {
  return `${heading('World map', 'ISS, earthquakes, stored locations and sensors with coordinates. Drawn from data and outlines held by AgentX; nothing is fetched from the internet.', mapSwitch())}
    <div id="liveMapStage">${body}</div>`;
}

async function mapLoadWorld() {
  if (mapState.world?.data) return mapState.world;
  const response = await fetch(MAP_WORLD_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`the geometry file returned ${response.status}`);
  return { data: mapPrepareWorld(await response.json()) };
}

// Called by the Live Data tab once it has written its page. It never throws:
// every read settles into its own layer.
async function liveMapOpen(feeds, liveState) {
  const seq = state.renderSeq;
  Object.assign(mapState, { feeds: array(feeds), paused: liveState?.liveDataEnabled === false, loaded: false });
  mapPaint('#liveMap', mapSection('<div class="loading"><span></span>Loading the map…</div>'));
  const [world, ...layers] = await Promise.all([
    mapLoadWorld().catch((error) => ({ error: error.message })),
    ...MAP_LAYERS.map((layer) => mapSettled(api(layer.route)))
  ]);
  if (seq !== state.renderSeq || state.tab !== 'live-data') return;
  mapState.world = world;
  MAP_LAYERS.forEach((layer, index) => { mapState.layers[layer.key] = layers[index]; });
  mapState.loaded = true;
  mapPaint('#liveMap', mapSection(mapStage()));
  if (!mapState.timer) mapState.timer = setInterval(refreshLiveMap, MAP_REFRESH_MS);
}

// Same guards as the GPU tab: the timer stops at its first tick on another
// tab, asks nothing while the page is hidden, and its answer is dropped when a
// tab change or a newer render made it stale. Only the ISS is read again.
async function refreshLiveMap() {
  if (state.tab !== 'live-data') {
    clearInterval(mapState.timer);
    mapState.timer = null;
    return;
  }
  if (!mapState.loaded || mapState.busy || document.hidden === true) return;
  const seq = state.renderSeq;
  mapState.busy = true;
  try {
    const iss = await mapSettled(api(MAP_LAYERS[0].route));
    if (seq !== state.renderSeq || state.tab !== 'live-data') return;
    mapState.layers.iss = iss;
    // The map, the notices and the ISS table only: the other tables keep their scroll position.
    if (mapState.view === 'live') {
      mapPaint('#liveMapNotes', mapNotices());
      mapPaint('#liveMapFigure', mapLiveSvg(mapWidth()));
      mapPaint('#liveMapIss', mapIssTable());
    }
    updated.textContent = `updated ${new Date().toLocaleTimeString()}`;
  } finally { mapState.busy = false; }
}

function setLiveMapView(view) {
  if (!['live', 'country'].includes(view) || state.tab !== 'live-data' || !mapState.loaded) return;
  mapState.view = view;
  mapPaint('#liveMap', mapSection(mapStage()));
}

document.addEventListener('click', (event) => {
  const view = event.target.closest?.('[data-map-view]')?.dataset.mapView;
  if (view) setLiveMapView(view);
});

document.addEventListener('visibilitychange', () => { refreshLiveMap(); });

// The map is drawn at its container's pixel width: a new width redraws it.
window.addEventListener('resize', () => {
  if (state.tab === 'live-data' && mapState.loaded && mapWidth() !== mapState.width) mapPaint('#liveMapStage', mapStage());
});
