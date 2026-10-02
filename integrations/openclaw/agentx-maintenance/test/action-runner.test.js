import test from 'node:test';
import assert from 'node:assert/strict';
import { actionArgs, operatorContext, runAction } from '../action-runner.js';

test('only a configured operator agent, unsandboxed, in its own session gets the tool', () => {
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:leadx:main' }), true);
  assert.equal(operatorContext({ agentId: 'overseer', sessionKey: 'agent:overseer:cron:x' }), true);
  assert.equal(operatorContext({ agentId: 'main', sessionKey: 'agent:main:main' }), false);
  assert.equal(operatorContext({ agentId: 'family', sessionKey: 'agent:family:main' }), false);
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:main:main' }), false);
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:leadx:main', sandboxed: true }), false);
  assert.equal(operatorContext({ agentId: 'ops', sessionKey: 'agent:ops:main' }, ['ops']), true);
  assert.equal(operatorContext(null), false);
});

test('arguments come only from the closed list, with the agent as actor', () => {
  assert.deepEqual(actionArgs({ action: 'status' }, 'leadx'), ['status']);
  assert.deepEqual(actionArgs({ action: 'deploy', services: ['core', 'benchmark', 'core'], revision: 'origin/main', waitMinutes: 5 }, 'leadx'),
    ['deploy', '--actor', 'openclaw:leadx', '--services', 'core,benchmark', '--revision', 'origin/main', '--wait-minutes', '5']);
  assert.deepEqual(actionArgs({ action: 'recover-quarantine', host: 'http://192.0.2.10:11434' }, 'overseer'),
    ['recover-quarantine', '--actor', 'openclaw:overseer', '--host', 'http://192.0.2.10:11434']);
  assert.deepEqual(actionArgs({ action: 'recalibrate-judges', model: 'judge-model:7b' }, 'leadx'),
    ['recalibrate-judges', '--actor', 'openclaw:leadx', '--model', 'judge-model:7b']);
  assert.throws(() => actionArgs({ action: 'shell' }, 'leadx'), /Unknown action/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['mongo'] }, 'leadx'), /deploy needs services/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'], revision: 'main; rm -rf /' }, 'leadx'), /revision/);
  assert.throws(() => actionArgs({ action: 'recover-quarantine', host: 'http://x:1/$(id)' }, 'leadx'), /Ollama host URL/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'], waitMinutes: 90 }, 'leadx'), /waitMinutes/);
});

test('the command runs without a shell and its receipt is returned whatever the outcome', async () => {
  let call;
  const refused = { contract: 'agentx.maintenance-action/v1', outcome: 'refused', reason: 'LEAD.md is held' };
  const execImpl = (command, args, options, done) => { call = { command, args, options }; done(Object.assign(new Error('exit 4'), { code: 4 }), JSON.stringify(refused)); };
  assert.deepEqual(await runAction('/srv/instance/bin/agentx-action', ['status'], { execImpl }), refused);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.args, ['status']);
  await assert.rejects(runAction('agentx-action', ['status'], { execImpl }), /absolute actionCommand/);
  await assert.rejects(runAction('/bin/x', ['status'], { execImpl: (c, a, o, done) => done(new Error('boom'), '') }), /no receipt \(boom\)/);
});

test('the plugin entry parses (the OpenClaw SDK import is stubbed)', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  assert.doesNotThrow(() => new Function('definePluginEntry', 'ACTIONS', 'SERVICES', 'actionArgs', 'operatorContext', 'runAction', body));
});
