import test from 'node:test';
import assert from 'node:assert/strict';
import batchPlan from '../../../../shared/benchmarkBatchPlan.cjs';
import categories from '../../../../shared/benchmarkCategories.js';
import * as runner from '../action-runner.js';

const { actionArgs, allowedActions, operatorContext, runAction, startGate } = runner;
const leadx = { agentId: 'leadx', sessionKey: 'agent:leadx:telegram:direct:12345' };
const BATCH = ['status', 'benchmark-batch-prepare', 'benchmark-batch-start', 'benchmark-batch-status'];
const request = { host: 'http://192.0.2.10:11434', model: 'candidate:7b', categories: ['coding', 'agent'], levels: [1, 2], repeats: 3,
  judgeHost: 'http://192.0.2.11:11434', judgeModel: 'judge-model:7b' };
// What a preparation returns for the agent to copy: the plan reference names these exact values.
const prepared = (values = request) => ({ action: 'benchmark-batch-start', plan: batchPlan.newPlanRef(batchPlan.batchRequest(values)), ...values });

test('only a configured operator agent, unsandboxed, in its own session gets the tool', () => {
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:leadx:main' }), true);
  assert.equal(operatorContext({ agentId: 'overseer', sessionKey: 'agent:overseer:cron:x' }), false);
  assert.equal(operatorContext({ agentId: 'overseer', sessionKey: 'agent:overseer:cron:x' }, ['leadx', 'overseer']), true);
  assert.equal(operatorContext({ agentId: 'main', sessionKey: 'agent:main:main' }), false);
  assert.equal(operatorContext({ agentId: 'family', sessionKey: 'agent:family:main' }), false);
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:main:main' }), false);
  assert.equal(operatorContext({ agentId: 'leadx', sessionKey: 'agent:leadx:main', sandboxed: true }), false);
  assert.equal(operatorContext({ agentId: 'ops', sessionKey: 'agent:ops:main' }, ['ops']), true);
  assert.equal(operatorContext(null), false);
});

test('each agent holds a closed subset of actions; batches are an explicit grant', () => {
  const legacy = ['status', 'deploy', 'recover-quarantine', 'recalibrate-judges', 'benchmark-batch-status'];
  assert.deepEqual(allowedActions('leadx'), legacy);
  assert.deepEqual(allowedActions('ops', { agentIds: ['ops'] }), legacy);
  const grants = { agentIds: ['leadx', 'overseer'], agentActions: { leadx: BATCH, main: BATCH, family: BATCH } };
  assert.deepEqual(allowedActions('leadx', grants), BATCH);
  // The watcher only reads unless it is granted more, by name.
  assert.deepEqual(allowedActions('overseer', grants), ['status', 'benchmark-batch-status']);
  assert.deepEqual(allowedActions('overseer', { ...grants, agentActions: { overseer: ['status', 'deploy'] } }), ['status', 'deploy']);
  // An entry grants nothing to an agent that is not an operator, and unknown names grant nothing.
  for (const agent of ['main', 'family', 'overseer']) assert.deepEqual(allowedActions(agent, { agentActions: grants.agentActions }), []);
  assert.deepEqual(allowedActions('leadx', { agentActions: { leadx: ['status', 'shell', 'lease'] } }), ['status']);
  assert.deepEqual(allowedActions('leadx', { agentActions: { leadx: 'deploy' } }), []);
  assert.deepEqual(allowedActions('constructor', { agentIds: ['constructor'], agentActions: {} }), legacy);

  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'] }, 'leadx', allowedActions('leadx', grants)), /not granted/);
  assert.throws(() => actionArgs(prepared(), 'overseer', allowedActions('overseer', grants)), /not granted/);
  assert.throws(() => actionArgs({ action: 'status' }, 'main', allowedActions('main', grants)), /not granted/);
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
  assert.throws(() => actionArgs({ action: 'lease', claim: 'x' }, 'leadx'), /Unknown action/);
  assert.throws(() => actionArgs(null, 'leadx'), /object of parameters/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['mongo'] }, 'leadx'), /deploy needs services/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'], revision: 'main; rm -rf /' }, 'leadx'), /revision/);
  assert.throws(() => actionArgs({ action: 'recover-quarantine', host: 'http://x:1/$(id)' }, 'leadx'), /Ollama host URL/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'], waitMinutes: 90 }, 'leadx'), /waitMinutes/);
  // A field of another action, or one the tool never had, is refused inside execute's own validation.
  assert.throws(() => actionArgs({ action: 'status', host: 'http://192.0.2.10:11434' }, 'leadx'), /does not accept: host/);
  assert.throws(() => actionArgs({ action: 'deploy', services: ['core'], actor: 'openclaw:main' }, 'leadx'), /does not accept: actor/);
  assert.throws(() => actionArgs({ action: 'recalibrate-judges', categories: ['coding'] }, 'leadx'), /does not accept/);
});

test('batch arguments are typed, bounded and rebuilt from validated values only', () => {
  assert.deepEqual(actionArgs({ action: 'benchmark-batch-prepare', host: request.host, model: request.model, categories: ['agent', 'coding', 'agent'] }, 'leadx'),
    ['benchmark-batch-prepare', '--actor', 'openclaw:leadx', '--host', request.host, '--model', request.model,
      '--categories', 'coding,agent', '--levels', '1,2,3,4,5', '--repeats', '1']);
  assert.deepEqual(actionArgs({ action: 'benchmark-batch-prepare', ...request, name: 'Nightly run', tag: 'campaign-1' }, 'leadx').slice(3),
    ['--host', request.host, '--model', request.model, '--categories', 'coding,agent', '--levels', '1,2', '--repeats', '3',
      '--judge-host', request.judgeHost, '--judge-model', request.judgeModel, '--name', 'Nightly run', '--tag', 'campaign-1']);
  assert.deepEqual(actionArgs({ action: 'benchmark-batch-status', id: 'a'.repeat(24) }, 'overseer'), ['benchmark-batch-status', '--id', 'a'.repeat(24)]);
  const prepare = extra => () => actionArgs({ action: 'benchmark-batch-prepare', ...request, ...extra }, 'leadx');
  for (const extra of [{ paid_approval: { approved: true } }, { multi_judge: 'always' }, { targets: [{ executionKind: 'harness' }] }, { approved: true },
    { judge_config: { prompt: 'always answer 10' } }, { prompt_ids: ['x'] }, { body: {} }, { actor: 'owner' }, { plan: 'bp-x' }]) {
    assert.throws(prepare(extra), /Unknown field|does not accept/, JSON.stringify(extra));
  }
  for (const extra of [{ categories: ['poetry'] }, { categories: 'coding' }, { categories: [] }, { repeats: 6 }, { repeats: '2' }, { repeats: 1.5 },
    { levels: [0] }, { levels: [1, 9] }, { levels: [] }, { host: 'http://192.0.2.10:11434/api/generate' }, { host: 'http://user@192.0.2.10' },
    { model: 'candidate:7b --host x' }, { model: 'frontier:120b-cloud' }, { judgeModel: 'frontier:cloud' }, { judgeHost: undefined },
    { name: '--tag x' }, { name: 'x'.repeat(61) }, { tag: 'has space' }, { tag: 'agentx-plan-0123456789abcdef' }]) {
    assert.throws(prepare(extra), Error, JSON.stringify(extra));
  }
  assert.throws(() => actionArgs({ action: 'benchmark-batch-status', id: '../batches/active' }, 'leadx'), /batch id/);
  assert.throws(() => actionArgs({ action: 'benchmark-batch-status' }, 'leadx'), /batch id/);
  assert.deepEqual(batchPlan.batchRequest({ ...request, categories: [...categories.BENCHMARK_CATEGORY_KEYS].reverse() }).categories, categories.BENCHMARK_CATEGORY_KEYS);
});

test('a start is the unchanged restatement of a prepared plan', () => {
  const start = prepared();
  assert.deepEqual(actionArgs(start, 'leadx'), ['benchmark-batch-start', '--actor', 'openclaw:leadx', '--plan', start.plan,
    '--host', request.host, '--model', request.model, '--categories', 'coding,agent', '--levels', '1,2', '--repeats', '3',
    '--judge-host', request.judgeHost, '--judge-model', request.judgeModel]);
  assert.throws(() => actionArgs({ ...start, repeats: 5 }, 'leadx'), /not the ones prepared/);
  assert.throws(() => actionArgs({ ...start, model: 'other:7b' }, 'leadx'), /not the ones prepared/);
  assert.throws(() => actionArgs({ ...start, tag: 'extra' }, 'leadx'), /not the ones prepared/);
  assert.throws(() => actionArgs({ ...start, plan: 'latest' }, 'leadx'), /reference/);
  assert.throws(() => actionArgs({ ...start, plan: undefined }, 'leadx'), /reference/);
  assert.throws(() => actionArgs({ ...start, judgeHost: undefined, judgeModel: undefined }, 'leadx'), /restates the judge/);
  assert.throws(() => actionArgs({ ...start, approved: true }, 'leadx'), /does not accept: approved/);
});

test('the runtime hook asks the owner for every start, naming the plan and its exact values', () => {
  const grants = { agentIds: ['leadx', 'overseer'], agentActions: { leadx: BATCH } };
  const gate = startGate(grants);
  const start = prepared({ ...request, name: 'Nightly run', tag: 'campaign-1' });
  const call = (params, context = leadx) => gate.before({ toolName: 'agentx_maintenance_action', toolCallId: 'call-1', params }, context);

  const { requireApproval: approval } = call(start);
  assert.deepEqual(approval.allowedDecisions, ['allow-once', 'deny']);
  assert.equal(approval.timeoutBehavior, 'deny');
  assert.ok(approval.description.length <= 256);
  for (const value of [start.plan, request.host, request.model, 'coding,agent', request.judgeHost, request.judgeModel, 'Nightly run', 'campaign-1', 'leadx']) {
    assert.ok(approval.description.includes(value), `the approval names ${value}`);
  }
  assert.notEqual(call(prepared({ ...request, repeats: 5 })).requireApproval.description, approval.description);

  // Nothing the model writes stands in for the approval or changes what it shows.
  assert.equal(call({ ...start, approved: true }).block, true);
  assert.equal(call({ ...start, repeats: 5 }).block, true);
  assert.equal(call({ ...start, plan: 'latest' }).block, true);
  assert.equal(call(undefined).block, true);
  assert.equal(call('benchmark-batch-start').block, true);
  // Who asks comes from the runtime context: no grant, another session or a sandbox blocks.
  assert.equal(call(start, { agentId: 'overseer', sessionKey: 'agent:overseer:cron:watch' }).block, true);
  assert.equal(call(start, { agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' }).block, true);
  assert.equal(call(start, { agentId: 'family', sessionKey: 'agent:family:main' }).block, true);
  assert.equal(call(start, { agentId: 'leadx', sessionKey: 'agent:main:main' }).block, true);
  assert.equal(call(start, { ...leadx, sandboxed: true }).block, true);
  assert.equal(startGate({ agentIds: ['leadx'] }).before({ toolName: 'agentx_maintenance_action', params: start }, leadx).block, true);
  // A request too long to show whole is refused, never approved from a cut description.
  const long = prepared({ ...request, host: `http://${'h'.repeat(56)}:11434`, model: 'm'.repeat(80), judgeHost: `http://${'j'.repeat(56)}:11434`, judgeModel: 'j'.repeat(80) });
  assert.match(call(long).blockReason, /too long/);

  // Other actions and other tools pass the hook untouched.
  assert.equal(call({ action: 'status' }), undefined);
  assert.equal(call({ action: 'benchmark-batch-prepare', ...request }), undefined);
  assert.equal(gate.before({ toolName: 'message', params: start }, leadx), undefined);

  // A requested approval grants nothing. Only the runtime resolution can grant.
  assert.equal(gate.passed(start, leadx, 'call-1'), false);
  approval.onResolution('deny');
  assert.equal(gate.passed(start, leadx, 'call-1'), false);
  const allowed = call(start).requireApproval;
  allowed.onResolution('allow-once');
  assert.equal(gate.passed(start, { ...leadx, sessionKey: 'agent:leadx:other' }, 'call-1'), false);
  assert.equal(gate.passed(start, leadx, 'another-call'), false);
  assert.equal(gate.passed(start, leadx, 'call-1'), true);
  allowed.onResolution('allow-once');
  assert.equal(gate.passed(start, leadx, 'call-1'), false);
  assert.equal(startGate(grants).passed(start, leadx, 'call-1'), false);
});

test('timeout, cancellation, missing resolution and an expired approval cannot launch', () => {
  let time = 0;
  const gate = startGate({ agentActions: { leadx: BATCH } }, { now: () => time });
  const start = prepared();
  const ask = id => gate.before({ toolName: 'agentx_maintenance_action', toolCallId: id, params: start }, leadx).requireApproval;
  for (const decision of ['deny', 'timeout', 'cancelled', 'allow-always']) {
    ask(decision).onResolution(decision);
    assert.equal(gate.passed(start, leadx, decision), false);
  }
  ask('unresolved');
  assert.equal(gate.passed(start, leadx, 'unresolved'), false);
  ask('expired').onResolution('allow-once');
  time = 30001;
  assert.equal(gate.passed(start, leadx, 'expired'), false);
  const late = ask('late');
  time += 300001;
  late.onResolution('allow-once');
  assert.equal(gate.passed(start, leadx, 'late'), false);
  assert.equal(gate.before({ toolName: 'agentx_maintenance_action', params: start }, leadx).block, true);
});

test('the command runs without a shell and its receipt is returned whatever the outcome', async () => {
  let call;
  const refused = { contract: 'agentx.maintenance-action/v1', action: 'status', outcome: 'refused', reason: 'LEAD.md is held' };
  const execImpl = (command, args, options, done) => { call = { command, args, options }; done(Object.assign(new Error('exit 4'), { code: 4 }), JSON.stringify(refused)); };
  assert.deepEqual(await runAction('/srv/instance/bin/agentx-action', ['status'], { execImpl }), refused);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.args, ['status']);
  await assert.rejects(runAction('agentx-action', ['status'], { execImpl }), /absolute actionCommand/);
  await assert.rejects(runAction('/bin/x', ['status'], { execImpl: (c, a, o, done) => done(new Error('boom'), '') }), /no receipt \(boom\)/);
});

test('a JSON response is not success without the matching receipt and genuine batch ID', async () => {
  const plan = prepared().plan;
  const args = ['benchmark-batch-start', '--actor', 'openclaw:leadx', '--plan', plan];
  const valid = { contract: 'agentx.maintenance-action/v1', action: args[0], actor: 'openclaw:leadx',
    outcome: 'completed', result: { batchId: 'a'.repeat(24), plan } };
  const run = value => runAction('/srv/instance/bin/agentx-action', args,
    { execImpl: (_c, _a, _o, done) => done(null, JSON.stringify(value)) });
  assert.deepEqual(await run(valid), valid);
  for (const value of [{}, { ...valid, contract: 'other' }, { ...valid, action: 'deploy' },
    { ...valid, actor: 'openclaw:main' }, { ...valid, outcome: 'ok' }, { ...valid, result: {} },
    { ...valid, result: { batchId: 'made-up-batch' } }, { ...valid, result: { batchId: 'a'.repeat(24), plan: 'another-plan' } }]) {
    await assert.rejects(run(value), /unknown/);
  }
});

async function plugin() {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  const body = source.replace(/^import .*$/gm, '').replace('export default', 'return');
  const names = ['DEFAULT_AGENTS', 'SERVICES', 'TOOL', 'actionArgs', 'allowedActions', 'operatorContext', 'runAction', 'startGate'];
  return overrides => new Function('definePluginEntry', 'categories', ...names, body)(x => x, categories, ...names.map(name => overrides?.[name] ?? runner[name]));
}

// The entry registered against a stand-in for the OpenClaw plugin API (the SDK import is stubbed).
async function registered(pluginConfig, { hooks = true, overrides } = {}) {
  const calls = [], handlers = new Map();
  let factory;
  (await plugin())({ ...overrides, runAction: async (command, args) => { calls.push({ command, args }); return { contract: 'agentx.maintenance-action/v1', outcome: 'completed' }; } })
    .register({ pluginConfig: { actionCommand: '/srv/instance/bin/agentx-action', ...pluginConfig },
      registerTool: build => { factory = build; }, ...(hooks && { on: (name, handler) => handlers.set(name, handler) }) });
  return { calls, tool: context => factory(context), before: handlers.get('before_tool_call') };
}

test('the entry gives each agent its own actions and runs a start only behind the hook', async () => {
  const { calls, tool, before } = await registered({ agentIds: ['leadx', 'overseer'], agentActions: { leadx: BATCH } });
  assert.equal(tool({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:12345' }), null);
  assert.equal(tool({ agentId: 'family', sessionKey: 'agent:family:main' }), null);
  assert.deepEqual(tool(leadx).parameters.properties.action.enum, BATCH);
  assert.equal(tool(leadx).parameters.additionalProperties, false);
  const overseer = tool({ agentId: 'overseer', sessionKey: 'agent:overseer:cron:watch' });
  assert.deepEqual(overseer.parameters.properties.action.enum, ['status', 'benchmark-batch-status']);
  await assert.rejects(overseer.execute('call-0', { action: 'deploy', services: ['core'] }), /not granted/);
  await assert.rejects(overseer.execute('call-0', prepared()), /not granted/);

  const start = prepared();
  await assert.rejects(tool(leadx).execute('call-1', { ...start, approved: true }), /does not accept: approved/);
  await assert.rejects(tool(leadx).execute('call-1', start), /no resolved allow-once runtime approval/);
  assert.equal(calls.length, 0);
  const denied = before({ toolName: 'agentx_maintenance_action', toolCallId: 'call-1', params: start }, leadx).requireApproval;
  denied.onResolution('deny');
  await assert.rejects(tool(leadx).execute('call-1', start), /no resolved allow-once/);
  const approved = before({ toolName: 'agentx_maintenance_action', toolCallId: 'call-2', params: start }, leadx).requireApproval;
  approved.onResolution('allow-once');
  assert.equal((await tool(leadx).execute('call-2', start)).details.outcome, 'completed');
  assert.deepEqual(calls[0].args.slice(0, 5), ['benchmark-batch-start', '--actor', 'openclaw:leadx', '--plan', start.plan]);
  await assert.rejects(tool(leadx).execute('call-3', start), /no resolved allow-once runtime approval/);
  // The actor is the runtime's agent whatever the model sends.
  await assert.rejects(tool(leadx).execute('call-4', { action: 'benchmark-batch-prepare', ...request, actor: 'openclaw:main' }), /actor/);
  await tool(leadx).execute('call-5', { action: 'benchmark-batch-prepare', ...request });
  assert.deepEqual(calls[1].args.slice(0, 3), ['benchmark-batch-prepare', '--actor', 'openclaw:leadx']);
  assert.equal(calls.length, 2);
});

test('by default only leadx holds the tool, and a runtime without hooks holds no start', async () => {
  const defaults = await registered({});
  assert.deepEqual(defaults.tool(leadx).parameters.properties.action.enum, ['status', 'deploy', 'recover-quarantine', 'recalibrate-judges', 'benchmark-batch-status']);
  assert.equal(defaults.tool({ agentId: 'overseer', sessionKey: 'agent:overseer:main' }), null);
  assert.equal(defaults.tool({ agentId: 'main', sessionKey: 'agent:main:main' }), null);

  const hookless = await registered({ agentActions: { leadx: BATCH } }, { hooks: false });
  assert.deepEqual(hookless.tool(leadx).parameters.properties.action.enum, BATCH.filter(action => action !== 'benchmark-batch-start'));
  await assert.rejects(hookless.tool(leadx).execute('call-1', prepared()), /not granted/);
  assert.equal(hookless.calls.length, 0);
  assert.equal((await registered({ agentActions: { leadx: [] } })).tool(leadx), null);
});
