'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { judgeControl } = require('./maintenance-judge-control.cjs');
const { ActionError } = require('./maintenance-actions.cjs');
const id = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'request.json');
  fs.writeFileSync(file, JSON.stringify({ contract: 'agentx.prepared-judge-cancellation/v1',
    scope: { admissionId: id, workloadId: 'judge-calibration:' + id },
    http: { body: { workloadId: 'judge-calibration:' + id, requestId: id, reason: 'Stop this fixture' } },
    execution: { noRestart: true } }));
  const calls = [];
  const deps = { ActionError, composeArgs: () => ['compose', '--project-name', 'fixture'], launcherEnv: () => ({}),
    run(command, args) {
      calls.push({ command, args });
      if (command === 'git') return { status: 0, output: args[0] === 'rev-parse' ? 'reviewed-main\n' : '' };
      return { status: 0, output: args.includes('run') ? JSON.stringify({ schema: 'agentx.judge-calibration-operator/v1',
        operation: 'cancel', result: { calibration: { admissionId: id } } }) + '\n' : 'built' };
    } };
  return { file, calls, deps };
}
test('named control builds reviewed Core and runs only a disposable command, never a recreate', async t => {
  const { file, calls, deps } = fixture(t);
  const result = await judgeControl({}, { file, actor: 'fixture-operator', operation: 'cancel' }, deps);
  assert.equal(result.noRestart, true);
  const commands = calls.filter(row => row.command === 'docker');
  assert.deepEqual(commands[0].args.slice(-2), ['build', 'core']);
  assert.ok(commands[1].args.includes('--no-deps')); assert.ok(commands[1].args.includes('--rm'));
  assert.ok(commands[1].args.includes('scripts/judge-calibration-operator.cjs'));
  assert.ok(!commands.some(row => row.args.some(arg => ['up', 'restart', '--force-runtime', 'down'].includes(arg))));
  const input = JSON.parse(Buffer.from(commands[1].args.at(-1), 'base64').toString('utf8'));
  assert.equal(input.id, id); assert.equal(input.reason, 'Stop this fixture');
});
test('refuses extra/restart options, changed scope and unreviewed or dirty source before Docker', async t => {
  const f = fixture(t), options = { file: f.file, actor: 'fixture', operation: 'cancel' };
  for (const extra of [{ restart: 'true' }, { operation: 'restart' }])
    await assert.rejects(judgeControl({}, { ...options, ...extra }, f.deps));
  const original = f.deps.run;
  f.deps.run = (command, args) => command === 'git' && args[0] === 'status'
    ? { status: 0, output: ' M foreign-file' } : original(command, args);
  await assert.rejects(judgeControl({}, options, f.deps), /clean reviewed checkout/);
  assert.equal(f.calls.some(row => row.command === 'docker'), false);
});
test('an uncertain command reply retains the original identity and is never retried', async t => {
  const f = fixture(t), original = f.deps.run;
  f.deps.run = (command, args, options) => {
    if (command === 'docker' && args.includes('run')) {
      f.calls.push({ command, args }); return { status: 1, output: 'connection ended after possible cancellation' };
    }
    return original(command, args, options);
  };
  await assert.rejects(judgeControl({}, { file: f.file, actor: 'fixture', operation: 'cancel' }, f.deps),
    error => error.outcome === 'unknown' && error.exitCode === 3 && error.details.requestId === id);
  assert.equal(f.calls.filter(row => row.command === 'docker' && row.args.includes('run')).length, 1);
});
