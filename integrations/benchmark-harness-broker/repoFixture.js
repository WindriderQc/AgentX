'use strict';

// Fixtures are product-owned synthetic projects. The native agent sees an
// editable copy without hidden tests; grading reconstructs an independent
// original fixture and never trusts test files from the agent workspace.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fingerprint: hash } = require('./contract');
const { loadRepoTasks } = require('../../benchmark/src/services/qualification/repoTaskFixtures');
const { gradeRun } = require('../../benchmark/src/services/qualification/executableRepoGrader');

function fixtureForEnvelope(envelope, tasks = null) {
  const pins = (envelope.selection?.model?.constraints || []).filter(value => value.startsWith('repo-fixture:'));
  if (!pins.length) return null;
  if (pins.length !== 1) throw new Error('Repository cell requires exactly one fixture pin');
  const pin = pins[0].match(/^repo-fixture:([a-zA-Z0-9_-]+):([a-f0-9]{64})$/);
  const task = pin && (tasks || loadRepoTasks()).find(item => item.id === pin[1] && item.fixtureFingerprint === pin[2]);
  if (!task) throw new Error('Repository fixture identity is unavailable or changed');
  return task;
}

function copyTree(source, target, { omit = new Set() } = {}) {
  fs.mkdirSync(target, { recursive: true });
  function visit(relative = '') {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      const rel = path.posix.join(relative, entry.name);
      if (rel === '.git' || rel.startsWith('.git/') || omit.has(rel)) continue;
      if (entry.isSymbolicLink()) throw new Error('Repository verification refuses symlinks');
      if (entry.isDirectory()) { fs.mkdirSync(path.join(target, rel), { recursive: true }); visit(rel); }
      else if (entry.isFile()) fs.copyFileSync(path.join(source, rel), path.join(target, rel));
      else throw new Error('Repository verification refuses special files');
    }
  }
  visit();
}

function stageFixture(task, workspace) {
  const hidden = new Set((task.fixture.hiddenTest?.args || []).filter(arg =>
    fs.existsSync(path.join(task.fixture.fixtureDir, arg))));
  const trustedFiles = {};
  function capture(relative = '') {
    for (const entry of fs.readdirSync(path.join(task.fixture.fixtureDir, relative), { withFileTypes: true })) {
      const rel = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) capture(rel);
      else if (entry.isFile()) trustedFiles[rel] = fs.readFileSync(path.join(task.fixture.fixtureDir, rel), 'utf8');
      else throw new Error('Product fixture contains an unsupported file');
    }
  }
  capture();
  copyTree(task.fixture.fixtureDir, workspace, { omit: hidden });
  const baseline = path.join(path.dirname(workspace), 'repo-baseline');
  copyTree(workspace, baseline);
  return { task, workspace, baseline, trustedFixture: { ...task.fixture, fixtureDir: null, files: trustedFiles } };
}

function verifyFixture(staged, { model, timeoutMs = 30_000 } = {}) {
  const { task, workspace, baseline } = staged;
  const after = path.join(path.dirname(workspace), 'repo-after');
  copyTree(workspace, after);
  const result = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--', 'repo-baseline', 'repo-after'], {
    cwd: path.dirname(workspace), encoding: 'utf8', timeout: 10_000, maxBuffer: 2_000_000
  });
  if (result.error || ![0, 1].includes(result.status)) throw new Error('Repository patch capture failed');
  const diff = result.stdout.split('\n').map(line => /^(diff --git |--- |\+\+\+ )/.test(line)
    ? line.replaceAll('a/repo-baseline/', 'a/').replaceAll('b/repo-after/', 'b/') : line).join('\n');
  const record = gradeRun({ fixture: staged.trustedFixture, diff, model, task: task.id, timeoutMs });
  const fixtureId = `repo-fixture.${task.id}`;
  return {
    contractSatisfied: record.grade.pass,
    evidence: {
      patches: [{ id: `repo-patch.${task.id}`, digest: hash(diff) }],
      artifacts: [{ id: fixtureId, digest: task.fixtureFingerprint }],
      tests: [{ id: fixtureId, status: record.grade.pass ? 'passed' : 'failed',
        digest: hash({ fixture: task.fixtureFingerprint, grade: record.grade, touched: record.touchedFiles }) }]
    }
  };
}

module.exports = { fixtureForEnvelope, stageFixture, verifyFixture };
