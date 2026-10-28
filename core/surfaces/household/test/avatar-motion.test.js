'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createDetector, WIDTH, HEIGHT, INTERVAL } = require('../public/avatar-motion');

function frame(box, light = 40) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const p = (y * WIDTH + x) * 4;
    const value = box && x >= box.x && x < box.x + 10 && y >= box.y && y < box.y + 10 ? 180 : light;
    data[p] = data[p + 1] = data[p + 2] = value; data[p + 3] = 255;
  }
  return data;
}
test('synthetic movement drives a mirrored, bounded, smooth gaze and settles calmly', () => {
  const detector = createDetector();
  let point = detector.sample(frame(), 0);
  assert.deepEqual(point, { x: 0, y: 0, moving: false });
  for (let i = 1; i < 25; i++) {
    const next = detector.sample(frame(i % 2 ? { x: 4, y: 4 } : null), i * INTERVAL);
    assert.ok(next.moving);
    assert.ok(Math.abs(next.x) <= 0.65 && Math.abs(next.y) <= 0.65);
    assert.ok(Math.abs(next.x - point.x) <= 0.120001);
    assert.ok(Math.abs(next.y - point.y) <= 0.120001); point = next;
  }
  assert.ok(point.x > 0.5 && point.y < -0.5);
  for (let i = 25; i < 70; i++) point = detector.sample(frame(), i * INTERVAL);
  assert.ok(Math.abs(point.x) < 0.001 && Math.abs(point.y) < 0.001);
  detector.reset();
  assert.deepEqual(detector.sample(frame({ x: 65, y: 45 }), 20000), { x: 0, y: 0, moving: false });
});
test('exposure changes, a static scene and isolated noise do not attract attention', () => {
  const detector = createDetector(); detector.sample(frame(), 0);
  assert.equal(detector.sample(frame(null, 100), 200).moving, false);
  assert.equal(detector.sample(frame(null, 100), 400).moving, false);
  const noise = frame(null, 100); noise[0] = noise[1] = noise[2] = 255;
  assert.equal(detector.sample(noise, 600).moving, false);
});
test('opposite movement changes direction gradually; whole-scene changes are ignored', () => {
  const detector = createDetector(); detector.sample(frame(), 0);
  let previous = { x: 0, y: 0 };
  for (let i = 1; i < 40; i++) {
    const point = detector.sample(frame(i % 2 ? { x: i < 20 ? 4 : 65, y: 24 } : null), i * INTERVAL);
    assert.ok(Math.abs(point.x - previous.x) <= 0.120001); previous = point;
  }
  assert.ok(previous.x < -0.5);
  const checker = frame();
  for (let p = 0; p < checker.length; p += 4) checker[p] = checker[p + 1] = checker[p + 2] = p % 8 ? 0 : 255;
  assert.equal(detector.sample(checker, 8000).moving, false);
});
test('tiny frame analysis leaves ample room in the 200ms CPU budget', t => {
  const detector = createDetector(), frames = [frame(), frame({ x: 4, y: 8 })];
  const before = performance.now();
  for (let i = 0; i < 1000; i++) detector.sample(frames[i % 2], i * INTERVAL);
  const perFrame = (performance.now() - before) / 1000;
  t.diagnostic(`synthetic analysis: ${perFrame.toFixed(3)} ms/frame, ${WIDTH}x${HEIGHT}, <= ${1000 / INTERVAL} Hz`);
  assert.ok(perFrame < 50);
});
