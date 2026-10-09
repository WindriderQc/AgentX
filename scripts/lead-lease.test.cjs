'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const actions = require('./maintenance-actions.cjs');
const actionScript = path.join(__dirname, 'maintenance-actions.cjs');

function instance(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-lease-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'LEAD.md');
  const original = '---\nheld_by: none\nsince: \nnotes: Existing private history\n---\n\n# Keep this body\n';
  fs.writeFileSync(file, original, { mode: 0o600 });
  return { file, original, env: { ...process.env, AGENTX_ENV_FILE: path.join(directory, 'instance.env'),
    AGENTX_PROJECT_NAME: 'synthetic-lease', AGENTX_LEAD_FILE: file,
    AGENTX_ACTION_RECEIPTS_DIR: path.join(directory, 'receipts') } };
}

function cli(instance, args, cwd = os.tmpdir()) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [actionScript, 'lease', ...args], { env: instance.env, cwd });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      try { resolve({ code, receipt: JSON.parse(stdout) }); }
      catch (error) { reject(new Error(`Invalid lease receipt: ${stderr}`, { cause: error })); }
    });
  });
}

test('claim persists across processes and release uses the configured instance path from any directory', async t => {
  const fixture = instance(t);
  const claimed = await cli(fixture, ['--actor', 'operator-one', '--claim', 'Synthetic maintenance']);
  assert.equal(claimed.code, 0);
  assert.equal(claimed.receipt.contract, 'agentx.maintenance-action/v1');
  assert.equal(claimed.receipt.result.operation, 'claim');
  assert.equal(actions.readLead(fixture.file).heldBy, 'agentx-action (operator-one)');
  assert.equal(JSON.parse(fs.readFileSync(claimed.receipt.file)).outcome, 'completed');
  const held = fs.readFileSync(fixture.file, 'utf8');
  const other = await cli(fixture, ['--actor', 'operator-two', '--release', 'Not my lease']);
  assert.equal(other.code, 4);
  assert.equal(fs.readFileSync(fixture.file, 'utf8'), held);
  const released = await cli(fixture, ['--actor', 'operator-one', '--release', 'Synthetic work verified'], __dirname);
  assert.equal(released.code, 0);
  assert.equal(released.receipt.result.lease.heldBy, 'none');
  assert.match(actions.readLead(fixture.file).notes, /Synthetic work verified Released\..*Synthetic maintenance.*Existing private history/);
  assert.equal(fs.readFileSync(fixture.file, 'utf8').split('\n').slice(4).join('\n'), fixture.original.split('\n').slice(4).join('\n'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(fixture.file).mode & 0o777, 0o600);
  const again = await cli(fixture, ['--actor', 'operator-one', '--release', 'Already released']);
  assert.equal(again.code, 4);
});

test('independent concurrent claimants produce exactly one holder and no lost history', async t => {
  const fixture = instance(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    cli(fixture, ['--actor', `operator-${index}`, '--claim', `Synthetic claim ${index}`])));
  const completed = results.filter(result => result.code === 0);
  assert.equal(completed.length, 1);
  assert.equal(results.filter(result => result.code === 4).length, 11);
  assert.equal(actions.readLead(fixture.file).heldBy, completed[0].receipt.result.holder);
  assert.match(actions.readLead(fixture.file).notes, /Existing private history$/);
  assert.equal(fs.existsSync(`${fixture.file}.writer-lock`), false);
});

test('a retained writer sidecar refuses claim and release without takeover', async t => {
  const fixture = instance(t);
  fs.writeFileSync(`${fixture.file}.writer-lock`, 'Synthetic unresolved writer');
  for (const operation of ['claim', 'release']) {
    const result = await cli(fixture, ['--actor', 'operator', `--${operation}`, 'Do not steal']);
    assert.equal(result.code, 4);
    assert.equal(result.receipt.outcome, 'refused');
    assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.original);
  }
  assert.equal(fs.readFileSync(`${fixture.file}.writer-lock`, 'utf8'), 'Synthetic unresolved writer');
});

test('invalid lease requests never mutate the configured file', async t => {
  const fixture = instance(t);
  for (const args of [[], ['--actor', 'operator'], ['--actor', 'operator', '--claim', 'one', '--release', 'two'],
    ['--actor', 'operator', '--claim', ''], ['--actor', 'operator', '--claim', 'one\ntwo'],
    ['--actor', 'fake\nheld_by: none', '--claim', 'one'], ['--actor', 'operator', '--claim', 'one', '--path', '/different/LEAD.md']]) {
    const result = await cli(fixture, args);
    assert.equal(result.code, 2);
    assert.equal(fs.readFileSync(fixture.file, 'utf8'), fixture.original);
  }
});
