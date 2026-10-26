'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { options, watch, watchHome } = require('../../../../integrations/secretary/objective_watch.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'objective-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'objective.json'); fs.writeFileSync(file, JSON.stringify({ id: 'life', version: 'v1' }));
  const config = { id: 'watch-v1', actor: 'test', core: 'http://core.test', archiveRoot: root, objectiveFile: file,
    hosts: ['http://host.test:11434'], source: { ref: 'Synthetic coding session' }, maxPages: 10,
    maxSeconds: 600, estimatedMinutes: 30, publishBudget: 20, when: 'asap', startBefore: '2026-11-01T00:00:00Z' };
  let time = Date.parse('2026-10-26T18:00:00Z');
  const calls = [], deps = { now: () => new Date(time), wait: async ms => { time += ms; },
    step: async (_config, controls) => { calls.push(controls); return { phase: controls.allowStart ? 'waiting-for-native-placement' : 'controller-drained', completedChunks: [] }; } };
  return { config, deps, calls, until: '2026-10-26T18:01:00Z' };
}
test('watch advances native steps until its explicit deadline and records a clean drain', async t => {
  const f = fixture(t);
  const result = await watch(f.config, { until: f.until }, f.deps);
  assert.deepEqual(f.calls.map(c => c.allowStart), [true, true, false]);
  assert.equal(result.phase, 'controller-drained'); assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(path.join(watchHome(f.config), 'watcher.lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(watchHome(f.config), 'watch-status.json'))).userConfirmed, false);
});
test('watch continues observing admitted work after the deadline until release and publication', async t => {
  const f = fixture(t), phases = ['running', 'running', 'chunk-released', 'ready', 'controller-drained'];
  f.deps.step = async (_config, controls) => { f.calls.push(controls); return { phase: phases.shift(), completedChunks: [] }; };
  const result = await watch(f.config, { until: '2026-10-26T18:00:00Z' }, f.deps);
  assert.ok(f.calls.every(c => c.allowStart === false));
  assert.equal(f.calls.length, 5); assert.equal(result.phase, 'controller-drained');
});
test('an uncertain native phase stops observation without launching a replacement', async t => {
  const f = fixture(t); let count = 0;
  f.deps.step = async () => { count++; return { phase: 'uncertain', current: { queueId: 'same-native-id' } }; };
  const result = await watch(f.config, { until: f.until }, f.deps);
  assert.equal(count, 1); assert.equal(result.exitCode, 2); assert.equal(result.queueId, 'same-native-id');
  assert.equal(result.phase, 'stopped-for-review');
});
test('a transport error leaves an explicit failure receipt and never automatically retries', async t => {
  const f = fixture(t); let count = 0;
  f.deps.step = async () => { count++; throw new TypeError('lost response'); };
  await assert.rejects(watch(f.config, { until: f.until }, f.deps), /lost response/);
  const saved = JSON.parse(fs.readFileSync(path.join(watchHome(f.config), 'watch-status.json')));
  assert.equal(saved.phase, 'stopped-on-error'); assert.equal(count, 1);
  assert.equal(fs.existsSync(path.join(watchHome(f.config), 'watcher.lock')), false);
});
test('text scope completion terminates the watcher while retaining separate human acceptance', async t => {
  const f = fixture(t); f.deps.step = async () => ({ phase: 'text-scope-complete', completedChunks: [{ queueId: 'done' }] });
  const result = await watch(f.config, { until: f.until }, f.deps);
  assert.equal(result.phase, 'text-scope-complete'); assert.equal(result.completedChunks, 1); assert.equal(result.userConfirmed, false);
});
test('a live observer lock prevents a second watcher without clearing native fences', async t => {
  const f = fixture(t), home = watchHome(f.config); fs.mkdirSync(home, { recursive: true });
  const lock = path.join(home, 'watcher.lock'); fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: process.pid }));
  await assert.rejects(watch(f.config, { until: f.until }, f.deps), /still active/);
  assert.equal(fs.existsSync(lock), true); assert.equal(f.calls.length, 0);
});
test('invalid or unbounded watcher windows refuse before native work', t => {
  const f = fixture(t);
  assert.throws(() => options(f.config, {}), /explicit admission deadline/);
  assert.throws(() => options(f.config, { until: '2026-11-02T00:00:00Z' }), /explicit admission deadline/);
  assert.throws(() => options(f.config, { until: f.until, pollSeconds: 1 }), /15 to 60/);
});
