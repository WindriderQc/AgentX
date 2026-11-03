'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ambient = require('../family-ambient');
const choice = require('../public/nestor-ambient-choice');

const MIN = 60000;
const pass = (startIso, minutes = 5) => ({
  start: startIso, end: new Date(Date.parse(startIso) + minutes * MIN).toISOString(),
  startLocal: '19:42', endLocal: '19:47', from: 'NO', to: 'SE', maxElDeg: 62, durationSec: minutes * 60,
  fromAzDeg: 315, toAzDeg: 135, fromElDeg: 10, toElDeg: 12, maxAzDeg: 225
});

test('Environment Canada icons and words become a background kind, never a guess', () => {
  assert.equal(ambient.weatherKind({ iconCode: '16' }), 'snow');
  assert.equal(ambient.weatherKind({ iconCode: 30 }), 'clear', 'a clear night');
  assert.equal(ambient.weatherKind({ iconCode: null, condition: 'Pluie faible' }), 'rain');
  assert.equal(ambient.weatherKind({ condition: 'Brouillard' }), 'fog');
  assert.equal(ambient.weatherKind({ condition: 'Généralement nuageux' }), 'cloud');
  assert.equal(ambient.weatherKind({ condition: '' }), null);
  assert.equal(ambient.weatherStrength('Neige faible'), 'light');
  assert.equal(ambient.weatherStrength('Neige'), null);
});

test('the sun elevation tells day from night at the house', () => {
  // Québec, 21 June at local noon (16:00 UTC) and at local midnight.
  assert.ok(ambient.solarElevationDeg(46.8, -71.2, new Date('2026-06-21T16:30:00Z')) > 60);
  assert.ok(ambient.solarElevationDeg(46.8, -71.2, new Date('2026-06-21T04:30:00Z')) < -10);
  assert.ok(ambient.solarElevationDeg(46.8, -71.2, new Date('2026-12-21T17:00:00Z')) < 25);
});

test('the alert view keeps counts and machines to visit, never alert text', () => {
  const view = ambient.alertView({ at: 'x', fingerprint: 'f1', findings: [
    { key: 'issue:gpu-hot:ugalien', severity: 'critical', text: 'secret detail' },
    { key: 'alert:disk:192.168.2.99', severity: 'attention', text: 'other detail' },
    { key: 'alert:unknown:nowhere', severity: 'attention', text: 'x' }] });
  assert.deepEqual(view, { at: 'x', fingerprint: 'f1', count: 2, critical: 1, nodes: ['ugalien', 'ugfrank'] });
  assert.ok(!JSON.stringify(view).includes('detail'));
  // Failed queued jobs name no machine: they stay in Nerve Center, not on the kitchen screen.
  const routine = ambient.alertView({ findings: [
    { key: 'alert:heavy_work_queue:heavy-work:070de7a5-75b6-448e-8fd7-7ade635a371c:failed', severity: 'attention' },
    { key: 'alert:heavy_work_queue:heavy-work:1af79c3d-5aba-4084-8cb1-3885432fe0c2:failed', severity: 'attention' }] });
  assert.equal(routine.count, 0);
  assert.equal(ambient.alertView({ findings: [{ key: 'issue:backup-missed:', severity: 'critical' }] }).count, 1);
  assert.equal(ambient.alertView(null), null);
  assert.equal(ambient.nodeFor('issue:x:ugbrutal'), 'ugbrutal');
});

test('the pass view carries the drawn geometry of the next naked-eye pass', () => {
  const start = '2026-11-04T00:42:00.000Z', end = '2026-11-04T00:47:00.000Z';
  const view = ambient.passView({ computedAt: 'now', tle: { stale: false },
    nextVisible: { start, end, startLocal: '19:42', endLocal: '19:47', from: 'NO', to: 'SE', maxElDeg: 62, durationSec: 300 },
    passes: [{ visible: { start: { time: start, azDeg: 312.4, elDeg: 10.2 }, end: { time: end, azDeg: 128.1, elDeg: 11 } },
      max: { time: '2026-11-04T00:44:30.000Z', azDeg: 222, elDeg: 62 } }] });
  assert.equal(view.next.fromAzDeg, 312.4);
  assert.equal(view.next.maxAzDeg, 222);
  assert.equal(view.next.from, 'NO');
  assert.equal(ambient.passView({ nextVisible: null, tle: { stale: true } }).next, null);
});

test('the snapshot reads each owner once per cache period and drops failures to null', async () => {
  let clock = Date.parse('2026-11-03T23:00:00Z'), weatherReads = 0, issReads = 0;
  const fetchData = async () => { weatherReads += 1; return { response: { ok: true, status: 200 },
    body: { status: 'success', data: { fetchedAt: 'f', current: { condition: 'Neige faible', iconCode: '16', temperatureC: -2, windKmh: 20, gustKmh: null } } } }; };
  const service = ambient.createFamilyAmbient({
    fetchData, now: () => new Date(clock),
    observer: async () => ({ lat: 46.81, lon: -71.21 }),
    issPasses: async () => { issReads += 1; throw new Error('Data down'); },
    getOpsWatch: () => ({ latest: () => ({ at: 'a', fingerprint: 'g', findings: [] }) })
  });
  const first = await service.snapshot();
  assert.equal(first.weather.kind, 'snow');
  assert.equal(first.weather.strength, 'light');
  assert.equal(first.weather.temperatureC, -2);
  assert.equal(first.iss, null, 'an unreadable pass is unknown, not "no pass"');
  assert.equal(first.alerts.count, 0);
  assert.equal(typeof first.sun.elevationDeg, 'number');
  assert.ok(!('lat' in first.sun) && !JSON.stringify(first).includes('46.81'), 'no coordinates reach the page');
  await service.snapshot();
  assert.equal(weatherReads, 1); assert.equal(issReads, 1);
  clock += 3 * MIN;
  await service.snapshot();
  assert.equal(issReads, 2, 'a failure is retried after two minutes');
  assert.equal(weatherReads, 1);
});

test('the background follows the weather, the light and the night calm', () => {
  const bg = choice.background({ weather: { kind: 'snow', strength: 'heavy', windKmh: 30 }, sun: { elevationDeg: -20 } }, { hour: 23 });
  assert.deepEqual(bg, { kind: 'snow', light: 'night', intensity: 0.84, wind: 0.5, calm: true, sky: null });
  assert.equal(choice.background({ weather: null }, { hour: 12 }).kind, 'unknown');
  assert.equal(choice.background({ weather: null }, { hour: 12 }).intensity, 0);
  assert.equal(choice.background({ sun: { elevationDeg: 0 } }).light, 'twilight');
});

test('a conversation keeps only the background', () => {
  const at = Date.parse('2026-11-04T00:40:00Z');
  const snapshot = { weather: { kind: 'clear', temperatureC: -1.6, condition: 'Dégagé' }, iss: { next: pass('2026-11-04T00:42:00Z') },
    alerts: { count: 2, critical: 1, nodes: ['ugalien'], fingerprint: 'f' } };
  const scene = choice.chooseScreen(snapshot, { at, hour: 19, standby: false });
  assert.deepEqual(scene.chips, []);
  assert.equal(scene.moment, null);
  assert.equal(scene.background.kind, 'clear');
});

test('the ISS gets a countdown, then the sky scene, then leaves', () => {
  const start = '2026-11-04T00:42:00.000Z', at0 = Date.parse(start);
  const snapshot = { weather: { kind: 'clear', temperatureC: -1.6, condition: 'Dégagé' }, iss: { next: pass(start) } };
  assert.equal(choice.chooseScreen(snapshot, { at: at0 - 30 * MIN, hour: 19 }).chips.some(c => c.id === 'iss'), false);
  const early = choice.chooseScreen(snapshot, { at: at0 - 12 * MIN, hour: 19 });
  assert.equal(early.chips[0].text, 'ISS dans 12 min · NO → SE · visible si le ciel est dégagé');
  assert.equal(early.moment, null);
  const near = choice.chooseScreen(snapshot, { at: at0 - 2 * MIN, hour: 19 });
  assert.equal(near.moment.kind, 'iss'); assert.equal(near.moment.phase, 'approach');
  const during = choice.chooseScreen(snapshot, { at: at0 + 2 * MIN, hour: 19 });
  assert.equal(during.moment.phase, 'passing');
  assert.match(during.chips[0].text, /^ISS au-dessus de nous/);
  assert.equal(choice.chooseScreen(snapshot, { at: at0 + 7 * MIN, hour: 19 }).moment, null);
  const cloudy = choice.chooseScreen({ ...snapshot, weather: { kind: 'cloud' } }, { at: at0 - 2 * MIN, hour: 19 });
  assert.match(cloudy.chips[0].text, /ciel couvert : peut-être caché$/);
  assert.equal(cloudy.moment.cloudy, true);
});

test('alerts rank by severity and a guided visit stays rare and by day', () => {
  const at = Date.parse('2026-11-04T15:00:00Z');
  const critical = { weather: { temperatureC: 2, condition: 'Nuageux' }, alerts: { count: 2, critical: 1, nodes: ['ugalien'], fingerprint: 'f' } };
  const scene = choice.chooseScreen(critical, { at, hour: 10 });
  assert.deepEqual(scene.chips.map(c => c.id), ['alert', 'weather']);
  assert.equal(scene.chips[0].text, 'Système : un problème important');
  assert.equal(scene.moment.kind, 'visit');
  assert.equal(scene.moment.play, 'overview,node-ugalien');
  const key = choice.visitKey(critical.alerts);
  assert.equal(choice.chooseScreen(critical, { at, hour: 10, visits: { [key]: at - 60 * MIN } }).moment, null, 'six hours between visits');
  assert.equal(choice.chooseScreen(critical, { at, hour: 10, visits: { [key]: at - 7 * 60 * MIN } }).moment.kind, 'visit');
  assert.equal(choice.chooseScreen(critical, { at, hour: 23 }).moment, null, 'no visit at night');
  const unknownMachine = { alerts: { count: 1, critical: 0, nodes: [] } };
  assert.equal(choice.chooseScreen(unknownMachine, { at, hour: 10 }).moment, null);
  assert.equal(choice.chooseScreen(unknownMachine, { at, hour: 10 }).chips[0].text, 'Système : un point à surveiller');
  // A pass in progress outranks an ordinary alert and its visit.
  const both = { iss: { next: pass(new Date(at - MIN).toISOString()) }, alerts: { count: 1, critical: 0, nodes: ['ugfrank'], fingerprint: 'g' } };
  const busy = choice.chooseScreen(both, { at, hour: 10 });
  assert.deepEqual(busy.chips.map(c => c.id), ['iss', 'alert']);
  assert.equal(busy.moment.kind, 'iss');
});

test('the pass is drawn from rise to set through its highest point', () => {
  const arc = choice.passArc(pass('2026-11-04T00:42:00Z'));
  assert.equal(arc[0].azDeg, 315);
  assert.equal(Math.round(arc.at(-1).azDeg), 135);
  assert.ok(arc.some(p => Math.abs(p.azDeg - 225) < 8), 'through the south-west, where it culminates');
  assert.equal(Math.round(Math.max(...arc.map(p => p.elDeg))), 62);
  assert.deepEqual(choice.passArc({ from: 'NO', to: 'SE', maxElDeg: 40 }).length, 49, 'compass words when azimuths are missing');
  assert.deepEqual(choice.passArc({}), []);
  const p = pass('2026-11-04T00:42:00Z');
  assert.equal(choice.passProgress(p, Date.parse(p.start) + 150000), 0.5);
  assert.equal(choice.passProgress(p, Date.parse(p.start) - 1), null);
});

test('Famille loads the living screen after the dock and its rules', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const rules = html.indexOf('/assets/household/nestor-ambient-choice.js'), runtime = html.indexOf('/assets/household/nestor-ambient.js');
  assert.ok(html.includes('/assets/household/nestor-ambient.css'));
  assert.ok(rules > 0 && runtime > rules && runtime > html.indexOf('/assets/household/avatar-dock.js'));
  const page = fs.readFileSync(path.join(__dirname, '../public/conversation-page.js'), 'utf8');
  assert.match(page, /NestorAmbient\?\.mount/);
  assert.match(page, /ambient\?\.busy\(\)/, 'photos wait while Nestor shows a moment');
});

test('GET /api/family/ambient answers through the family routes', async () => {
  const express = require('express');
  const { registerFamilyRoutes } = require('../family-routes');
  const app = express();
  registerFamilyRoutes({ app, express, familyTasks: {}, standardJsonParser: express.json(),
    ambient: { snapshot: async () => ({ at: 'now', weather: null, sun: null, iss: null, alerts: null }) } });
  const server = app.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/family/ambient`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json()).data, { at: 'now', weather: null, sun: null, iss: null, alerts: null });
  } finally { server.close(); }
});

// ---- Nestor the painter -----------------------------------------------------------------
const paintings = require('../family-paintings');
const FAMILY = { surface: 'household', sessionId: 's1', packId: 'kidx_nestor', scopeId: 'family' };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('only word-made family drawings and finished, distinct Atelier renders may be painted', () => {
  const pool = paintings.paintingPool([
    { id: uuid(1), conversation: null, width: 2048, height: 2048, words: 'Un raton laveur avec une tête de T-Rex, dessin animé, lumière du matin.' },
    { id: uuid(2), conversation: FAMILY, width: 1024, height: 1024, words: 'Age-appropriate illustration for children. Un renard.' },
    { id: uuid(3), conversation: null, width: 2048, height: 2048, words: 'Un raton laveur avec une tête de T-Rex, dessin animé, lumière du soir.' },
    { id: uuid(4), conversation: null, width: 1024, height: 1024, words: 'Pictogramme de voix' },
    { id: uuid(5), conversation: null, width: 2016, height: 2016, words: 'Keep the same people, poses and canoe as in image 1.' },
    { id: uuid(6), conversation: { ...FAMILY, packId: 'personal_operator', scopeId: 'personal' }, width: 2048, height: 2048, words: 'Private' },
    { id: uuid(7), conversation: null, width: 2752, height: 1536, words: 'Une scène nue sur la plage' },
    { id: uuid(8), conversation: null, width: 0, height: 0, words: 'broken' },
    { id: uuid(9), conversation: null, width: 2752, height: 1536, words: 'Une affiche AgentX', text: true }
  ]);
  assert.deepEqual(pool, [{ id: uuid(2), source: 'family' }, { id: uuid(1), source: 'atelier' }]);
});

test('the painter lists once per half hour and serves a reduced copy of listed pictures only', async () => {
  let clock = 0, lists = 0, reads = 0, fits = 0;
  const service = paintings.createFamilyPaintings({
    now: () => clock,
    listFinished: async () => { lists += 1; return [{ id: uuid(1), conversation: null, width: 2048, height: 2048, words: 'Un hibou' }]; },
    readImage: async () => { reads += 1; return { bytes: Buffer.from('png'), mimeType: 'image/png' }; },
    fit: async () => { fits += 1; return { bytes: Buffer.from('jpeg'), width: 720, height: 720 }; }
  });
  assert.deepEqual(await service.list(), [{ id: uuid(1), source: 'atelier' }]);
  await service.list();
  assert.equal(lists, 1);
  assert.equal(await service.image(uuid(9)), null, 'an unlisted picture is unknown');
  const first = await service.image(uuid(1));
  assert.equal(first.mimeType, 'image/jpeg');
  assert.equal(String(first.bytes), 'jpeg');
  await service.image(uuid(1));
  assert.equal(reads, 1); assert.equal(fits, 1);
  clock += 31 * MIN;
  await service.list();
  assert.equal(lists, 2);
  const failing = paintings.createFamilyPaintings({ listFinished: async () => { throw new Error('Mongo down'); } });
  assert.equal(await failing.list(), null, 'an unreadable list is unknown, not empty');
});

test('the snapshot carries the painter pool without words', async () => {
  const service = ambient.createFamilyAmbient({
    fetchData: async () => { throw new Error('offline'); }, observer: async () => null,
    issPasses: async () => { throw new Error('offline'); }, getOpsWatch: () => ({ latest: () => null }),
    paintings: { list: async () => [{ id: uuid(2), source: 'family' }], image: async () => null }
  });
  const snapshot = await service.snapshot();
  assert.deepEqual(snapshot.paintings, [{ id: uuid(2), source: 'family' }]);
  const plain = ambient.createFamilyAmbient({ fetchData: async () => { throw new Error('offline'); }, observer: async () => null,
    issPasses: async () => { throw new Error('offline'); }, getOpsWatch: () => ({ latest: () => null }) });
  assert.equal((await plain.snapshot()).paintings, null);
});

test('Nestor paints by day after a quiet moment, the picture painted longest ago, once per quarter hour', () => {
  const at = Date.parse('2026-11-03T15:00:00Z');
  const snapshot = { weather: { kind: 'cloud', temperatureC: 4, condition: 'Nuageux' },
    paintings: [{ id: 'a', source: 'family' }, { id: 'b', source: 'atelier' }, { id: 'c', source: 'atelier' }] };
  const quiet = { at, hour: 10, idleMs: 3 * MIN };
  assert.equal(choice.chooseScreen(snapshot, { ...quiet, idleMs: MIN }).moment, null, 'not right after a conversation');
  assert.equal(choice.chooseScreen(snapshot, { ...quiet, hour: 23 }).moment, null, 'not at night');
  assert.equal(choice.chooseScreen(snapshot, { ...quiet, standby: false }).moment, null);
  assert.equal(choice.chooseScreen(snapshot, { ...quiet, lastPaint: at - 5 * MIN }).moment, null);
  const first = choice.chooseScreen(snapshot, quiet);
  assert.deepEqual(first.moment, { kind: 'paint', id: 'a', source: 'family', label: 'Nestor peint un de vos dessins' });
  assert.deepEqual(first.chips.map(chip => chip.id), ['paint', 'weather']);
  const later = choice.chooseScreen(snapshot, { ...quiet, painted: { a: at - 20 * MIN }, lastPaint: at - 20 * MIN });
  assert.equal(later.moment.id, 'b');
  assert.equal(later.moment.label, 'Nestor peint une création de l’atelier');
  assert.equal(choice.chooseScreen(snapshot, { ...quiet, painted: { a: 3, b: 1, c: 2 } }).moment.id, 'b');
  assert.equal(choice.chooseScreen({ ...snapshot, paintings: null }, quiet).moment, null);
});

test('a painting continues until it ends, but the ISS and alert visits come first', () => {
  const start = '2026-11-03T15:02:00.000Z', at = Date.parse(start) - 2 * MIN;
  const running = { kind: 'paint', id: 'b', source: 'atelier', label: 'Nestor peint une création de l’atelier' };
  const snapshot = { paintings: [{ id: 'a', source: 'family' }] };
  assert.equal(choice.chooseScreen(snapshot, { at, hour: 10, idleMs: 0, lastPaint: at, painting: running }).moment, running);
  const withIss = { ...snapshot, iss: { next: pass(start) } };
  assert.equal(choice.chooseScreen(withIss, { at, hour: 10, painting: running }).moment.kind, 'iss');
  const withAlert = { ...snapshot, alerts: { count: 1, critical: 0, nodes: ['ugalien'], fingerprint: 'f' } };
  assert.equal(choice.chooseScreen(withAlert, { at, hour: 10, painting: running }).moment.kind, 'visit');
  assert.equal(choice.chooseScreen(snapshot, { at, hour: 10, standby: false, painting: running }).moment, null);
});

test('the painting timeline: strokes, the finished picture, then a fade', () => {
  assert.deepEqual(choice.paintPhase(0), { phase: 'painting', progress: 0 });
  assert.equal(choice.paintPhase(choice.PAINT_MS * 0.25).progress, 0.5);
  assert.equal(choice.paintPhase(choice.PAINT_MS * 0.54).phase, 'revealing');
  assert.equal(choice.paintPhase(choice.PAINT_MS * 0.7).phase, 'showing');
  assert.equal(choice.paintPhase(choice.PAINT_MS * 0.95).phase, 'fading');
  assert.equal(choice.paintPhase(choice.PAINT_MS), null);
  assert.equal(choice.paintPhase(-1), null);
});

test('GET /api/family/ambient/paintings/:id serves listed pictures only', async () => {
  const express = require('express');
  const { registerFamilyRoutes } = require('../family-routes');
  const app = express();
  registerFamilyRoutes({ app, express, familyTasks: {}, standardJsonParser: express.json(),
    ambient: { snapshot: async () => ({}), painting: async id => (id === uuid(1) ? { bytes: Buffer.from('jpeg'), mimeType: 'image/jpeg' } : null) } });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/family/ambient/paintings/`;
    const found = await fetch(base + uuid(1));
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('content-type'), 'image/jpeg');
    assert.equal(found.headers.get('cache-control'), 'private, max-age=86400');
    assert.equal(await found.text(), 'jpeg');
    assert.equal((await fetch(base + uuid(2))).status, 404);
    assert.equal((await fetch(base + '..%2Fsecret')).status, 404);
  } finally { server.close(); }
});

// ---- the real night sky -----------------------------------------------------------------
const nightSky = require('../../../src/services/sky/nightSky');
const QUEBEC = [46.81, -71.21];
const separation = (a, b) => {
  const r = Math.PI / 180;
  return Math.acos(Math.sin(a.decDeg * r) * Math.sin(b.decDeg * r) + Math.cos(a.decDeg * r) * Math.cos(b.decDeg * r) * Math.cos((a.raDeg - b.raDeg) * r)) / r;
};
const day = iso => nightSky.daysSinceJ2000(new Date(iso));

test('the Moon\'s phase matches the January 2026 full moon, new moon and first quarter', () => {
  const phase = iso => nightSky.moonPhase(nightSky.sunPosition(day(iso)), nightSky.moonPosition(day(iso)));
  assert.equal(phase('2026-01-03T10:03:00Z').name, 'pleine lune');
  assert.ok(phase('2026-01-03T10:03:00Z').illumination > 0.98);
  assert.equal(phase('2026-01-18T19:52:00Z').name, 'nouvelle lune');
  const quarter = phase('2026-01-26T04:47:00Z');
  assert.equal(quarter.name, 'premier quartier');
  assert.equal(quarter.waxing, true);
});

test('planets stand where 2026 oppositions and conjunctions put them', () => {
  const elongation = (id, iso) => separation(nightSky.planetPosition(id, day(iso)), nightSky.sunPosition(day(iso)));
  assert.ok(elongation('jupiter', '2026-01-10T12:00:00Z') > 175, 'Jupiter at opposition');
  assert.ok(elongation('saturn', '2026-10-04T12:00:00Z') > 174, 'Saturn at opposition');
  assert.ok(elongation('mars', '2026-01-09T12:00:00Z') < 3, 'Mars behind the Sun');
  assert.ok(elongation('venus', '2026-01-06T12:00:00Z') < 3, 'Venus behind the Sun');
});

test('the sky above Quebec City: Polaris at the latitude, the June noon Sun, angles only', () => {
  const evening = nightSky.skyView(...QUEBEC, new Date('2026-11-20T01:00:00Z'));
  const polaris = evening.stars.find(star => star.name === 'Polaris');
  assert.ok(Math.abs(polaris.altDeg - 46.8) < 1.2 && (polaris.azDeg < 2 || polaris.azDeg > 358));
  assert.equal(evening.moon.name, 'gibbeuse croissante');
  assert.ok(evening.moon.altDeg > 30 && evening.planets.some(planet => planet.id === 'saturn'));
  assert.ok(evening.figures.some(figure => figure.name === 'Pégase'));
  assert.ok(evening.stars.every(star => star.altDeg >= -1), 'only what is above the horizon');
  assert.ok(!JSON.stringify(evening).includes('46.81') && !JSON.stringify(evening).includes('71.21'), 'no coordinates');
  const noon = nightSky.skyView(...QUEBEC, new Date('2026-06-21T16:45:00Z'));
  assert.ok(Math.abs(noon.sun.altDeg - 66.6) < 0.5);
  assert.equal(nightSky.skyView(NaN, 0), null);
});

test('after sunset the background shows the real sky, and a note says what is up', () => {
  const sky = nightSky.skyView(...QUEBEC, new Date('2026-11-20T01:00:00Z'));
  const night = { weather: { kind: 'clear', temperatureC: -3, condition: 'Dégagé' }, sun: { elevationDeg: -30 }, sky };
  const scene = choice.chooseScreen(night, { at: Date.parse('2026-11-20T01:00:00Z'), hour: 20 });
  assert.equal(scene.background.sky, 'full');
  assert.equal(scene.chips[0].text, 'Dans le ciel : la lune (gibbeuse croissante) et Saturne');
  const cloudy = choice.chooseScreen({ ...night, weather: { kind: 'cloud', condition: 'Nuageux' } }, { hour: 20 });
  assert.equal(cloudy.background.sky, 'bright');
  assert.match(cloudy.chips[0].text, /derrière les nuages$/);
  assert.equal(choice.chooseScreen({ ...night, weather: { kind: 'snow' } }, { hour: 20 }).background.sky, null, 'snow hides it');
  assert.equal(choice.chooseScreen({ ...night, sun: { elevationDeg: 20 } }, { hour: 13 }).background.sky, null, 'not by day');
  assert.equal(choice.chooseScreen({ ...night, sun: { elevationDeg: -3 } }, { hour: 17 }).background.sky, 'bright', 'dusk');
  assert.equal(choice.chooseScreen(night, { hour: 20, standby: false }).chips.length, 0, 'a conversation keeps only the sky');
});

test('the panorama turns so the Moon is never hidden behind Nestor', () => {
  const ahead = { moon: { altDeg: 40, azDeg: 185 } };
  const frame = choice.skyFrame(ahead);
  assert.notEqual(frame.center, 180);
  assert.ok(Math.abs(frame.project(ahead.moon).x - 0.5) > 0.15);
  const aside = { moon: { altDeg: 40, azDeg: 120 } };
  assert.equal(choice.skyFrame(aside).center, 180);
  assert.equal(choice.skyFrame(aside).project({ azDeg: 180, altDeg: 0 }).x, 0.5);
  assert.equal(choice.skyFrame(aside).visible({ azDeg: 0, altDeg: 40 }), false, 'the north is behind us');
});
