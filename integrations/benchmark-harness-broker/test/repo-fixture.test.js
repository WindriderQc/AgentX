'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadRepoTasks } = require('../../../benchmark/src/services/qualification/repoTaskFixtures');
const { fixtureForEnvelope, stageFixture, verifyFixture } = require('../repoFixture');
const tasks = loadRepoTasks();
const envelope = task => ({ selection: { model: { constraints: [`repo-fixture:${task.id}:${task.fixtureFingerprint}`] } } });

test('only an exact product fixture pin selects a repository cell', () => {
  assert.equal(fixtureForEnvelope({}), null);
  assert.equal(fixtureForEnvelope(envelope(tasks[0])).id, tasks[0].id);
  assert.throws(() => fixtureForEnvelope(envelope({ ...tasks[0], fixtureFingerprint: 'a'.repeat(64) })), /identity/);
  assert.throws(() => fixtureForEnvelope({ selection: { model: { constraints: ['repo-fixture:../../secret:bad'] } } }), /identity/);
});

test('all native repository fixtures withhold hidden tests and independently verify the golden edit', () => {
  for (const task of tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-fixture-'));
    try {
      const work = path.join(dir, 'work'), staged = stageFixture(task, work);
      assert.equal(fs.existsSync(path.join(work, 'test/hidden.js')), false);
      const applied = spawnSync('git', ['apply', '-'], { cwd: work, input: task.solutionDiff, encoding: 'utf8' });
      assert.equal(applied.status, 0, `${task.id}: ${applied.stderr}`);
      const result = verifyFixture(staged, { model: 'synthetic-candidate' });
      assert.equal(result.contractSatisfied, true, task.id);
      assert.equal(result.evidence.tests[0].status, 'passed');
      assert.equal(result.evidence.artifacts[0].digest, task.fixtureFingerprint);
      assert.match(result.evidence.patches[0].digest, /^[a-f0-9]{64}$/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a wrong edit and an edit outside declared scope cannot become verified successes', () => {
  for (const defect of ['wrong', 'scope']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-fixture-'));
    try {
      const task = tasks.find(item => item.id === 'sum-sign'), work = path.join(dir, 'work'), staged = stageFixture(task, work);
      if (defect === 'scope') {
        assert.equal(spawnSync('git', ['apply', '-'], { cwd: work, input: task.solutionDiff }).status, 0);
        fs.writeFileSync(path.join(work, 'extra.txt'), 'outside authority');
      } else fs.writeFileSync(path.join(work, 'src/sum.js'), 'module.exports = () => 0;');
      const result = verifyFixture(staged, { model: 'synthetic' });
      assert.equal(result.contractSatisfied, false);
      assert.equal(result.evidence.tests[0].status, 'failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('verification refuses a workspace symlink instead of reading outside the cell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-native-fixture-'));
  try {
    const work = path.join(dir, 'work'), staged = stageFixture(tasks[0], work);
    fs.symlinkSync('/etc/passwd', path.join(work, 'external'));
    assert.throws(() => verifyFixture(staged), /symlinks/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
