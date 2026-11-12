'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Choice = require('../public/nestor-ambient-choice');
const { describeSky } = require('../../../src/services/artxSkyContext');
const { createArtxService } = require('../../../src/services/artxService');

const sky = () => ({ moon: { altDeg: 25, azDeg: 100, name: 'croissant', illumination: 0.2 }, planets: [],
  stars: [{ name: 'A', altDeg: 20, azDeg: 100, mag: 0.2 }, { name: 'B', altDeg: 30, azDeg: 120, mag: 2 }],
  figures: [{ name: 'Test figure', lines: [['A', 'B']] }] });
const full = { sky: 'full' };

test('projection exposes the exact renderer frame without claiming perspective', () => {
  const data = sky(), context = describeSky(data, full, true), frame = Choice.skyFrame(data);
  assert.deepEqual(context.projection, { type: 'azimuth_altitude_panorama', centerAzimuthDeg: frame.center,
    spanDeg: 220, horizonY: 0.84, zenithY: 0.1, altitudeAtHorizonDeg: 0, altitudeAtZenithDeg: 90,
    perspective: false, moonSizeExaggerated: true });
  assert.equal(frame.project({ altDeg: 0, azDeg: frame.center }).y, 0.84);
  assert.ok(Math.abs(frame.project({ altDeg: 90, azDeg: frame.center }).y - 0.1) < 1e-12);
});

test('Moon avoidance rotates shared projection and preserves outdoor direction', () => {
  const data = sky(); data.moon.azDeg = 180; data.moon.altDeg = 40;
  const context = describeSky(data, full, true);
  assert.equal(context.projection.centerAzimuthDeg, 145);
  assert.equal(context.moonPosition.direction, 'sud');
  assert.equal(context.moonPosition.rendered, true);
});

test('Moon position remains known when below horizon, out of frame, hidden or weather masked', () => {
  for (const [alt, az, bg, visible, reason] of [
    [-10, 100, full, true, 'below_horizon'], [30, 0, full, true, 'outside_panorama'],
    [30, 100, { sky: null }, true, 'sky_hidden'], [30, 100, full, false, 'display_hidden']
  ]) {
    const data = sky(); Object.assign(data.moon, { altDeg: alt, azDeg: az });
    const moon = describeSky(data, bg, visible).moonPosition;
    assert.equal(moon.rendered, false); assert.equal(moon.reason, reason);
    assert.equal(moon.altitudeDeg, alt); assert.equal(moon.azimuthDeg, az);
    assert.equal(moon.screen, undefined);
  }
});

test('figure screen bounds and altitude extent use its actual members, not invented center position', () => {
  const context = describeSky(sky(), full, true), figure = context.constellations[0];
  assert.equal(figure.rendered, true); assert.deepEqual(figure.members, ['A', 'B']);
  assert.deepEqual(figure.altitudeRangeDeg, [20, 30]);
  assert.deepEqual(figure.directions, ['est', 'sud-est']);
  assert.ok(figure.screenBounds.left < figure.screenBounds.right);
  assert.equal(figure.altitudeDeg, undefined);
});

test('bright sky and missing panorama members do not attest a constellation drawing', () => {
  const data = sky();
  assert.equal(describeSky(data, { sky: 'bright' }, true).constellations[0].reason, 'brightness_filtered');
  data.stars[1].azDeg = 0;
  assert.equal(describeSky(data, full, true).constellations[0].reason, 'members_outside_panorama');
  assert.equal(Choice.skyStars(data, full).figures.length, 0);
});

test('shared star selector preserves previous renderer rules across frames and light modes', () => {
  for (const moonAz of [0, 100, 180, 300]) for (const mode of ['full', 'bright']) {
    const data = sky(); data.moon.azDeg = moonAz;
    const frame = Choice.skyFrame(data);
    const expected = data.stars.filter(star => frame.visible(star) && (mode === 'full' || star.mag <= 0.6));
    assert.deepEqual(Choice.skyStars(data, { sky: mode }).stars, expected);
  }
});

test('reader derives source facts, keeps old moon semantics and expiry still fails closed', async () => {
  let now = Date.parse('2026-11-12T02:00:00Z');
  const service = createArtxService({ now: () => now, ambient: { snapshot: async () => ({
    at: new Date(now).toISOString(), sky: sky(), weather: { kind: 'clear' }, sun: { elevationDeg: -20 }
  }) } });
  const snapshot = await service.snapshot('synthetic-display');
  const value = { displayId: 'synthetic-display', current: { snapshotId: snapshot.snapshotId, visible: true,
    at: new Date(now).toISOString(), skyContext: { constellations: [{ name: 'Injected' }] } } };
  const read = service.observe(value);
  assert.equal(read.current.skyContext.constellations[0].name, 'Test figure');
  assert.doesNotMatch(JSON.stringify(read), /Injected/);
  assert.equal(read.current.moon.phase, 'croissant');
  value.current.visible = false;
  assert.equal(service.observe(value).current.moon, null);
  assert.equal(service.read({ displayId: value.displayId }).current.skyContext.moonPosition.rendered, false);
  now += 181000;
  assert.equal(service.read({ displayId: value.displayId }).status, 'expired');
});

test('missing sky does not invent source objects', () => {
  const context = describeSky(null, full, true);
  assert.equal(context.moonPosition, null); assert.deepEqual(context.constellations, []);
  assert.match(context.coverage, /omitted stars or constellations have no established position/);
});
