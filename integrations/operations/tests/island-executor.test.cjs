'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const island = require('../island-executor.cjs');
const { main } = require('../heavy-work-queue.cjs');

const ID = '00000000-0000-4000-8000-0000000000a1';
const DISPATCH = '00000000-0000-4000-8000-0000000000d1';
const HOST = 'http://192.168.0.50:11434';
const executor = { mode: 'island', receiptRef: 'island/synthetic.json', agent: 'Eko', minutes: 60, memory: 'continue', world: 'mesa-island' };
const job = { id: ID, revision: 3, kind: 'other', state: 'reserved', hosts: [HOST], executor };
const principal = { hostUrl: HOST, contextSize: 32768, ready: true, claimed: false };

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'island-exec-')); }

/** A fake Core queue that records every call in order. */
function fakeCore(state = { ...job }, { refuseFinish = 0 } = {}) {
  const calls = [];
  const client = async (endpoint = '', body) => {
    calls.push([endpoint, body]);
    if (endpoint.endsWith('/begin')) { Object.assign(state, { state: 'dispatching', dispatchId: DISPATCH, revision: state.revision + 1 }); return { ...state }; }
    if (endpoint.endsWith('/record')) { Object.assign(state, { state: body.state, revision: state.revision + 1 }); return { ...state }; }
    if (endpoint.endsWith('/recover')) { Object.assign(state, { state: 'failed' }); return { ...state }; }
    if (endpoint.endsWith('/operator-finish')) {
      if (refuseFinish-- > 0) throw new Error('Native runtime authority remains held');
      Object.assign(state, { state: body.state }); return { ...state, finishedWith: body };
    }
    if (endpoint.endsWith('/place')) { Object.assign(state, { state: 'reserved', revision: state.revision + 1, reservation: { start: new Date(0).toISOString() } }); return { ...state }; }
    return { ...state };
  };
  return { client, calls, state };
}

/** A fake runner: the run finishes after `polls` status reads. */
function fakeRunner({ polls = 2, start, outcome = 'completed', leftover = [] } = {}) {
  const calls = [];
  let reads = 0;
  const runner = async (action, args) => {
    calls.push([action, args]);
    if (action === 'check') return { ready: true, problems: [], activeRun: null };
    if (action === 'start') return start ? start(args) : { runId: ID, dispatchId: args['dispatch-id'], phase: 'starting' };
    if (action === 'status') {
      reads++;
      const done = reads > polls;
      return { runId: ID, dispatchId: DISPATCH, phase: done ? 'finished' : 'running', terminal: done, outcome: done ? outcome : null,
        resumeCount: 1, events: [{ event: 'resumed', reason: 'memory-reminder' }], leftover: done ? leftover : [], model: 'agentx-primary' };
    }
    if (action === 'memory') return { files: { 'SEMANTIC_MEMORY.md': { text: '[verified] blocks stay put' } } };
    if (action === 'stop') return { signalled: true };
    throw new Error(`unexpected ${action}`);
  };
  return { runner, calls };
}

function deps(dir, runner, extra = {}) {
  const reports = [];
  return { reports, runner, label: 'devx', principal: async () => principal, receiptsDir: dir, actor: 'fixture',
    sleep: async () => {}, pollMs: 0, report: async (id, body) => { reports.push([id, body]); }, ...extra };
}

test('runner arguments are typed and quoted for SSH; the request carries no command', () => {
  const config = island.runnerConfig({ AGENTX_ISLAND_RUNNER: 'ssh:devx', AGENTX_ISLAND_RUNNER_SCRIPT: '/opt/agentx/integrations/island/island_runner.py' });
  const argv = island.runnerArgv(config, 'start', { 'run-id': ID, agent: 'Eko', minutes: 60 });
  assert.equal(argv.command, 'ssh');
  assert.equal(argv.args.at(-1), `'python3' '/opt/agentx/integrations/island/island_runner.py' 'start' '--run-id' '${ID}' '--agent' 'Eko' '--minutes' '60'`);
  assert.throws(() => island.runnerArgv(config, 'start', { agent: 'Eko; rm -rf /' }), /Invalid runner argument/);
  assert.throws(() => island.runnerArgv(config, 'supervise', {}), /Unsupported/);
  assert.throws(() => island.runnerConfig({ AGENTX_ISLAND_RUNNER: 'ssh:host;id', AGENTX_ISLAND_RUNNER_SCRIPT: '/x.py' }), /AGENTX_ISLAND_RUNNER/);
  assert.equal(island.runnerArgv(island.runnerConfig({ AGENTX_ISLAND_RUNNER: 'local', AGENTX_ISLAND_RUNNER_SCRIPT: '/x.py' }), 'check').command, 'python3');
});

test('marks dispatch before the start, follows the run and finishes with a hashed receipt after release', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    const { runner, calls } = fakeRunner();
    const d = deps(dir, runner);
    const done = await island.runIsland({ ...job }, core.client, d);
    const order = core.calls.map(([endpoint]) => endpoint.replace(`/${ID}`, ''));
    assert.deepEqual(order.slice(0, 3), ['/begin', '/assert-dispatch', '/record']);
    assert.ok(calls.findIndex(([a]) => a === 'start') > calls.findIndex(([a]) => a === 'check'));
    const start = calls.find(([a]) => a === 'start')[1];
    assert.equal(start['dispatch-id'], DISPATCH);
    assert.equal(start['context-window'], 32768);
    assert.equal(core.calls.find(([e]) => e.endsWith('/record'))[1].operationId, `island:${ID}`);
    const finish = done.finishedWith;
    assert.equal(finish.state, 'completed');
    assert.equal(finish.confirmation, 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED');
    const file = path.join(dir, 'island', `${ID}-${DISPATCH}.receipt.json`);
    const bytes = fs.readFileSync(file);
    assert.equal(finish.receiptSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.contract, 'agentx.operator-heavy-work/v1');
    assert.equal(receipt.runtimeReleased, true);
    assert.equal(receipt.evidence.run.resumeCount, 1);
    assert.ok(!JSON.stringify(receipt).match(/token/i));
    const final = d.reports.at(-1)[1];
    assert.equal(final.memory['SEMANTIC_MEMORY.md'].text, '[verified] blocks stay put');
    assert.equal(final.receipt.state, 'completed');
    // A second start of the same request refuses before any queue call.
    const again = fakeCore();
    await assert.rejects(island.runIsland({ ...job }, again.client, deps(dir, runner)), /never relaunch/);
    assert.equal(again.calls.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('refusable checks happen before the mark: busy runner, moved pin, claimed host', async () => {
  const dir = tempDir();
  try {
    const cases = [
      [{ runner: async a => (a === 'check' ? { ready: true, activeRun: 'other-run' } : null) }, /busy/],
      [{ principal: async () => ({ ...principal, hostUrl: 'http://192.168.0.99:11434' }) }, /not among this request/],
      [{ principal: async () => ({ ...principal, claimed: true }) }, /not free/],
      [{ principal: async () => ({ ...principal, contextSize: null }) }, /unresolved/]
    ];
    for (const [override, message] of cases) {
      const core = fakeCore();
      await assert.rejects(island.runIsland({ ...job }, core.client, { ...deps(dir, fakeRunner().runner), ...override }), message);
      assert.equal(core.calls.length, 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a runner refusal after the mark releases the fence with a not-started receipt', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    const { runner } = fakeRunner({ start: () => { throw Object.assign(new Error('run x is still active'), { code: 'RUNNER_BUSY', runnerRefused: true }); } });
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir, runner)), /did not start/);
    const recover = core.calls.find(([e]) => e.endsWith('/recover'))[1];
    assert.equal(recover.dispatchId, DISPATCH);
    assert.match(recover.receiptRef, /^island:not-started: RUNNER_BUSY/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a lost start answer is resolved by status, and an unknown one becomes uncertain without a second start', async () => {
  const dir = tempDir();
  try {
    const found = fakeRunner({ start: () => { throw new Error('ssh: connection reset'); } });
    const done = await island.runIsland({ ...job }, fakeCore().client, deps(dir, found.runner));
    assert.equal(done.state, 'completed');
    assert.equal(found.calls.filter(([a]) => a === 'start').length, 1);

    const dir2 = tempDir();
    const core = fakeCore();
    const lost = async action => {
      if (action === 'check') return { ready: true, activeRun: null };
      throw new Error('ssh: connection reset');
    };
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir2, lost)), err => err.outcome === 'uncertain');
    assert.equal(core.calls.find(([e]) => e.endsWith('/record'))[1].state, 'uncertain');
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('leftover processes keep the request open; Core refusals of the finish are retried', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir, fakeRunner({ leftover: [4242] }).runner)), /Release not proven/);
    assert.equal(core.calls.filter(([e]) => e.endsWith('/operator-finish')).length, 0);
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'island', `${ID}-${DISPATCH}.receipt.json`)));
    assert.equal(receipt.runtimeReleased, false);

    const dir2 = tempDir();
    const held = fakeCore({ ...job }, { refuseFinish: 2 });
    const done = await island.runIsland({ ...job }, held.client, deps(dir2, fakeRunner({ outcome: 'stopped' }).runner));
    assert.equal(done.state, 'cancelled');
    assert.equal(held.calls.filter(([e]) => e.endsWith('/operator-finish')).length, 3);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settle follows an existing run and never starts one', async () => {
  const dir = tempDir();
  try {
    const running = { ...job, state: 'running', dispatchId: DISPATCH };
    const { runner, calls } = fakeRunner({ polls: 1 });
    const done = await island.settleIsland(running, fakeCore({ ...running }).client, deps(dir, runner));
    assert.equal(done.state, 'completed');
    assert.equal(calls.some(([a]) => a === 'start'), false);
    const missing = async () => { throw Object.assign(new Error('no run'), { code: 'RUN_NOT_FOUND', runnerRefused: true }); };
    await assert.rejects(island.settleIsland(running, fakeCore({ ...running }).client, deps(dir, missing)), /recover/);
    await assert.rejects(island.settleIsland({ ...job, state: 'requested' }, fakeCore().client, deps(dir, runner)), /nothing to settle/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('watch places a waiting request, then starts it at its slot', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore({ ...job, state: 'requested' });
    const done = await island.watchIsland(ID, core.client, deps(dir, fakeRunner().runner), { when: 'tonight' });
    assert.equal(core.calls.find(([e]) => e.endsWith('/place'))[1].when, 'tonight');
    assert.equal(done.state, 'completed');
    await assert.rejects(island.watchIsland(ID, fakeCore().client, deps(dir, fakeRunner().runner), { when: 'now' }), /asap or tonight/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the queue CLI routes island requests and its new actions', async () => {
  await assert.rejects(main(['island-settle', '--core', 'http://127.0.0.1:3180', '--actor', 'fixture'], {}), /UUID/);
  const answers = { ...job, state: 'requested' };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ ok: true, data: answers }) });
  await assert.rejects(main(['island-settle', '--core', 'http://127.0.0.1:3180', '--actor', 'fixture', '--id', ID], { fetchImpl, island: { runner: async () => ({}) } }), /nothing to settle/);
});
