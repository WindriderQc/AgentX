'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Layout = require('../public/nestor-sky-layout');
const Renderer = require('../public/nestor-sky-renderer');
const Choice = require('../public/nestor-ambient-choice');
const { describeSky } = require('../../../src/services/artxSkyDescription');
const { labSky, registerArtxLab } = require('../artx-lab');
const { allowedForFamilyDevice } = require('../family-device');

const sky = { sun: { altDeg: 20, azDeg: 110 }, moon: { altDeg: 40, azDeg: 180, illumination: 0.5, name: 'premier quartier' },
  planets: [{ id: 'saturn', name: 'Saturne', altDeg: 30, azDeg: 125, mag: 1, sunSeparationDeg: 100 }], stars: [], figures: [] };
const bg = { light: 'night', sky: 'full' };

test('projection and inverse agree through wraparound and across viewport shapes', () => {
  for (const center of [0, 45, 180, 350]) for (const span of [90, 220, 360]) {
    const frame = Layout.frame({ center, span });
    for (const azDeg of [0, 1, 90, 180, 359]) for (const altDeg of [0, 20, 89]) {
      const roundtrip = frame.unproject(frame.project({ azDeg, altDeg }));
      assert.ok(Math.abs(roundtrip.azDeg - azDeg) < 1e-9);
      assert.ok(Math.abs(roundtrip.altDeg - altDeg) < 1e-9);
    }
  }
});

test('the Moon keeps its true anchor and an external leader caption when behind the face', () => {
  const plan = Layout.plan(sky, bg);
  const moon = plan.objects.find(o => o.id === 'moon');
  assert.equal(plan.frame.centerAzDeg, 180);
  assert.equal(moon.screen.x, 0.5);
  assert.equal(moon.rendered, false);
  assert.equal(moon.hiddenBy, 'face');
  assert.match(moon.label.text, /agrandie.*derrière moi/);
  assert.ok(!Layout.ZONES.some(z => Layout.overlap(moon.label, z)));
});

test('captions never overlap reserved zones or one another, including portrait and high DPI sizes', () => {
  const full = { ...sky, planets: [...sky.planets, ...['venus', 'mars', 'jupiter'].map((id, i) =>
    ({ id, name: id, altDeg: 30 + i, azDeg: 124 + i, mag: 1, sunSeparationDeg: 50 }))] };
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844], [3840, 2160]]) {
    const plan = Layout.plan(full, bg, { width, height });
    for (const [i, label] of plan.labels.entries()) {
      assert.ok(!plan.zones.some(z => Layout.overlap(label, z)), label.text);
      assert.ok(!plan.labels.slice(0, i).some(z => Layout.overlap(label, z)), label.text);
      assert.ok(label.x >= 0 && label.y >= 0 && label.x + label.w <= 1 && label.y + label.h <= 1);
    }
  }
});

test('the full portrait keeps low and side captions clear across landscape and portrait screens', () => {
  const view = Layout.frame();
  const nearChin = { ...sky, moon: { ...sky.moon, ...view.unproject({ x: 0.625, y: 0.76 }) } };
  for (const [width, height, portrait] of [
    [1920, 1080, { x: 0.36, y: 0.1, w: 0.28, h: 0.78 }],
    [390, 844, { x: 0.08, y: 0.2, w: 0.84, h: 0.6 }]
  ]) {
    const plan = Layout.plan(nearChin, bg, { width, height });
    assert.ok(plan.labels.every(label => !Layout.overlap(label, portrait)), 'caption crosses the full portrait');
    const moon = plan.objects.find(o => o.id === 'moon');
    assert.equal(moon.rendered, false);
    assert.equal(moon.hiddenBy, 'face');
    assert.deepEqual(moon.screen, view.project(nearChin.moon));
    const read = describeSky({ sky: nearChin }, bg, { visible: true, skyViewport: { width, height } });
    assert.equal(read.moon.reason, 'face');
    assert.equal(read.moon.altitudeDeg, nearChin.moon.altDeg);
    if (width > height) {
      assert.ok(moon.label, 'landscape has room for a leader caption');
      assert.match(moon.label.text, /derrière moi/);
    }
  }
});

test('compass captions keep their azimuth instead of moving beside the portrait', () => {
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]]) {
    const plan = Layout.plan(sky, bg, { width, height });
    for (const label of plan.labels.filter(item => item.id.startsWith('compass-'))) {
      assert.ok(Math.abs(label.x + label.w / 2 - label.anchor.x) < 1e-12, label.text + ' moved horizontally');
    }
    assert.equal(plan.labels.some(label => label.id === 'compass-S'), false, 'South is covered by the portrait');
  }
});

test('body captions leave the enlarged Sun and Moon discs unobstructed', () => {
  const clearMoon = { ...sky, moon: { ...sky.moon, altDeg: 25, azDeg: 240 } };
  let checked = 0;
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]]) {
    for (const light of ['day', 'night']) {
      const plan = Layout.plan(clearMoon, { ...bg, light }, { width, height });
      for (const body of plan.objects.filter(o => o.rendered && o.label)) {
        const r = body.radiusPx;
        const disc = { x: body.screen.x - r / width, y: body.screen.y - r / height,
          w: r * 2 / width, h: r * 2 / height };
        assert.ok(!Layout.overlap(body.label, disc), body.id + ' caption covers its disc');
        if (body.id === 'sun' || body.id === 'moon') checked++;
      }
    }
  }
  assert.ok(checked >= 4, 'visible Sun and Moon captions were checked');
});

test('day sky uses computed Sun and Moon but does not claim daytime planets', () => {
  const snapshot = { sky, sun: { elevationDeg: 20 }, weather: { kind: 'clear' } };
  const background = Choice.background(snapshot);
  assert.equal(background.sky, 'day');
  const plan = Layout.plan(sky, background);
  const sun = plan.objects.find(o => o.id === 'sun');
  assert.equal(sun.screen.x, Layout.frame().project(sky.sun).x);
  assert.equal(sun.rendered, true);
  assert.ok(plan.objects.some(o => o.id === 'moon'));
  assert.equal(plan.objects.some(o => o.id === 'saturn'), false);
});

test('Core recomputes bodies and occlusions from the same plan, with independent outdoor positions', () => {
  const snapshot = { sky };
  const plan = Layout.plan(sky, bg, { width: 1280, height: 800 });
  const read = describeSky(snapshot, bg, { visible: true, skyViewport: { width: 1280, height: 800 } });
  for (const p of [read.moon, ...read.planets]) {
    const object = plan.objects.find(o => o.id === (p.id || 'moon'));
    assert.equal(p.rendered, object.rendered);
    assert.equal(p.screen.x, +object.screen.x.toFixed(3));
  }
  assert.equal(read.moon.aboveHorizon, true);
  assert.equal(read.moon.reason, 'face');
  assert.equal(read.moon.size, 'enlarged_for_readability');
  assert.equal(describeSky(snapshot, bg, { visible: false }).moon.reason, 'display_hidden');
});

test('a fresh fetch cannot rejuvenate an old observation and expired weather loses its effects', () => {
  const at = Date.parse('2026-06-21T20:00:00Z');
  const snapshot = { at: new Date(at).toISOString(), sky, sun: { elevationDeg: 20 }, weather: {
    kind: 'rain', condition: 'Pluie', fetchedAt: new Date(at).toISOString(), observedAt: new Date(at - 45 * 60000).toISOString() } };
  assert.equal(Choice.weatherFreshness(snapshot, at).state, 'stale');
  assert.match(Choice.weatherLine(snapshot, { at }).text, /45 min/);
  snapshot.weather.observedAt = new Date(at - 4 * 3600000).toISOString();
  const background = Choice.background(snapshot, { at });
  assert.equal(background.kind, 'unknown');
  assert.equal(background.intensity, 0);
  assert.equal(background.weatherFreshness.state, 'expired');
  assert.match(Choice.weatherLine(snapshot, { at }).text, /indisponible/);
});

test('palette varies with Sun height and agrees at adjacent half-degree cache bins', () => {
  assert.notDeepEqual(Renderer.palette(30), Renderer.palette(2));
  assert.notDeepEqual(Renderer.palette(2), Renderer.palette(-12));
  assert.deepEqual(Renderer.palette(10.01), Renderer.palette(10.1));
  for (const v of [-30, -18, -6, 0, 2, 10, 70]) for (const color of Renderer.palette(v)) assert.match(color, /^#[0-9a-f]{6}$/);
});

test('the lab computes an explicit synthetic observer without returning its coordinates', () => {
  const result = labSky({ at: '2026-06-21T12:00:00Z', lat: '45', lon: '0' });
  assert.equal(result.simulation, true);
  // At the June solstice and near solar noon: 90 − latitude + obliquity.
  assert.ok(Math.abs(result.sky.sun.altDeg - 68.44) < 0.5);
  assert.ok(!('lat' in result) && !('lon' in result));
  for (const query of [{}, { at: 'bad', lat: '45', lon: '0' }, { at: result.at, lat: '', lon: '0' },
    { at: result.at, lat: '91', lon: '0' }, { at: result.at, lat: '45', lon: '0', displayId: 'live-screen' }]) {
    assert.throws(() => labSky(query), { status: 400 });
  }
});

test('lab page and calculation route stay outside the family-pinned device scope', () => {
  for (const path of ['/artx-lab', '/api/artx/lab/sky']) assert.equal(allowedForFamilyDevice({ method: 'GET', path, query: {} }), false);
});

test('lab HTTP calculation validates inputs and is never cached', async () => {
  const express = require('express'), app = express();
  registerArtxLab(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/artx/lab/sky`;
    const bad = await fetch(url); assert.equal(bad.status, 400);
    const response = await fetch(url + '?at=2026-06-21T12%3A00%3A00Z&lat=45&lon=0');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).data.simulation, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
