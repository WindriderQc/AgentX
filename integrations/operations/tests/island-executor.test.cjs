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
    if (endpoint.includes('/operator-release?')) return { contract:'agentx.operator-release/v1', authority:'core.runtime-coordination', queueRequestId:ID, dispatchId:DISPATCH, runtimeReleased:true, observedAt:new Date().toISOString() };
    if (endpoint.endsWith('/begin')) { Object.assign(state, { state: 'dispatching', dispatchId: DISPATCH, revision: state.revision + 1 }); return { ...state }; }
    if (endpoint.endsWith('/record')) { Object.assign(state, { state: body.state, revision: state.revision + 1 }); return { ...state }; }
    if (endpoint.endsWith('/recover')) { Object.assign(state, { state: 'failed' }); return { ...state }; }
    if (endpoint.endsWith('/operator-finish')) {
      if (refuseFinish-- > 0) throw new Error('Native runtime authority remains held');
      Object.assign(state, { state: body.state, releaseReceipt:{operationId:DISPATCH} }); return { ...state, finishedWith: body };
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
        alive:!done, localStopped:done, processObservationOk:true, resumeCount: 1, events: [{ event: 'resumed', reason: 'memory-reminder' }], leftover: done ? leftover : [], model: 'agentx-primary' };
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

test('the harness reaches the runner only for dsh or pi; Codex keeps the historical argv', async () => {
  const config = island.runnerConfig({ AGENTX_ISLAND_RUNNER: 'local', AGENTX_ISLAND_RUNNER_SCRIPT: '/x.py' });
  assert.deepEqual(island.runnerArgv(config, 'start', { harness: 'pi' }).args.slice(-2), ['--harness', 'pi']);
  assert.throws(() => island.runnerArgv(config, 'start', { harness: 'claude' }), /Invalid runner argument/);
  for (const [harness, expected] of [[undefined, undefined], ['codex', undefined], ['dsh', 'dsh'], ['pi', 'pi']]) {
    const dir = tempDir();
    try {
      const withHarness = harness ? { ...executor, harness } : executor;
      const core = fakeCore({ ...job, executor: withHarness });
      const { runner, calls } = fakeRunner();
      await island.runIsland({ ...job, executor: withHarness }, core.client, deps(dir, runner));
      const start = calls.find(([a]) => a === 'start')[1];
      assert.equal(start.harness, expected, `harness ${harness}`);
      assert.deepEqual(calls.find(([a]) => a === 'check')[1], { agent: executor.agent, ...(expected ? { harness: expected } : {}), world: executor.world });
      assert.ok(!('harness' in start) || expected, 'Codex never sends --harness');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('selected harness and agent readiness refuse before any Core dispatch', async () => {
  for (const selected of [{ agent: 'LongAgentName', harness: 'codex' }, { agent: 'Agent', harness: 'pi' }]) {
    const dir = tempDir();
    const core = fakeCore();
    const runner = async (action, args) => {
      assert.equal(action, 'check');
      assert.equal(args.agent, selected.agent);
      assert.equal(args.harness || 'codex', selected.harness);
      return { ready: false, problems: ['selected runtime unavailable'] };
    };
    try {
      await assert.rejects(island.runIsland({ ...job, executor: { ...executor, ...selected } }, core.client, deps(dir, runner)), /not ready/);
      assert.equal(core.calls.length, 0);
      assert.equal(fs.existsSync(path.join(dir, 'island', `${ID}.state.json`)), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
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

test('lost begin is durably fenced locally before the remote answer and never starts twice', async () => {
  const dir=tempDir();
  const fake=fakeRunner();
  const core=fakeCore();
  const client=async (endpoint,body) => {
    if(endpoint.endsWith('/begin')) {
      const saved=JSON.parse(fs.readFileSync(path.join(dir,'island',`${ID}.state.json`)));
      assert.equal(saved.phase,'begin-unclear');
      throw new Error('synthetic lost begin');
    }
    return core.client(endpoint,body);
  };
  try {
    await assert.rejects(island.runIsland({...job},client,deps(dir,fake.runner)),/lost begin/);
    await assert.rejects(island.runIsland({...job},client,deps(dir,fake.runner)),/never relaunch/);
    assert.equal(fake.calls.some(([action])=>action==='start'),false);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('missing native release or incomplete local process evidence never attests release', async () => {
  for(const variation of ['empty','held','wrong-dispatch','stale','bad-process','unknown-cleanup']) {
    const dir=tempDir(),core=fakeCore(),fake=fakeRunner({polls:0});
    const client=async (endpoint,body) => {
      const result=await core.client(endpoint,body);
      if(endpoint.includes('/operator-release?')) {
        if(variation==='empty')return {};
        if(variation==='held')return {...result,runtimeReleased:false};
        if(variation==='wrong-dispatch')return {...result,dispatchId:'other'};
        if(variation==='stale')return {...result,observedAt:'2000-01-01T00:00:00Z'};
      }
      return result;
    };
    const runner=async (action,args) => {
      const result=await fake.runner(action,args);
      if(action==='status'&&variation==='bad-process')return {...result,processObservationOk:false,leftover:null};
      if(action==='status'&&variation==='unknown-cleanup')return {...result,localStopped:null};
      return result;
    };
    try {
      await assert.rejects(island.runIsland({...job},client,deps(dir,runner)),/Release not proven/);
      assert.equal(core.calls.some(([endpoint])=>endpoint.endsWith('/operator-finish')),false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'island',`${ID}-${DISPATCH}.receipt.json`))).runtimeReleased,false);
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  }
});

test('a lost finish reply resolves the same native terminal receipt without another dispatch', async () => {
  const dir=tempDir(),core=fakeCore(),fake=fakeRunner({polls:0});
  let lost=false;
  const client=async(endpoint,body)=>{
    const result=await core.client(endpoint,body);
    if(endpoint.endsWith('/operator-finish')&&!lost){lost=true;throw new Error('synthetic lost finish');}
    return result;
  };
  try {
    const done=await island.runIsland({...job},client,deps(dir,fake.runner));
    assert.equal(done.state,'completed');
    assert.equal(core.calls.filter(([e])=>e.endsWith('/begin')).length,1);
    assert.equal(core.calls.filter(([e])=>e.endsWith('/operator-finish')).length,1);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

// ── shared worlds: the instance hook and the remote world refusals ──────────

test('a world hook that is not ready refuses before the dispatch mark', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    const { runner, calls } = fakeRunner();
    const hook = [];
    const worldPrepare = async (action, world) => { hook.push([action, world]); throw new Error('World hook refused (check): world service down'); };
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir, runner, { worldPrepare })), /world service down/);
    assert.deepEqual(hook, [['check', 'mesa-island']]);
    assert.equal(core.calls.length, 0, 'no dispatch mark');
    assert.ok(!calls.some(([a]) => a === 'start'));
    assert.deepEqual(calls[0], ['check', { agent: 'Eko' }], 'the hook checks the terrain before switching; runner start validates it afterwards');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failed world preparation lifts the mark as not started and never starts the runner', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    const { runner, calls } = fakeRunner();
    const worldPrepare = async action => {
      if (action === 'check') return { ok: true, managed: true, world: 'living-island' };
      throw new Error('World hook refused (prepare): 409 agents on this island');
    };
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir, runner, { worldPrepare })), /did not start/);
    const recover = core.calls.find(([e]) => e.endsWith('/recover'));
    assert.match(recover[1].receiptRef, /^island:not-started: WORLD_PREPARE: /);
    assert.equal(recover[1].confirmation, 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED');
    assert.ok(!calls.some(([a]) => a === 'start'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a prepared world is recorded in the ledger, the reports and the receipt', async () => {
  const dir = tempDir();
  try {
    const living = { ...executor, world: 'graphysx-living' };
    const core = fakeCore({ ...job, executor: living });
    const order = [];
    const { runner } = fakeRunner();
    const tracked = async (action, args) => { order.push(action); if (action === 'start') assert.equal(args['expected-instance'], ID); return runner(action, args); };
    const prepared = { ok: true, managed: true, world: 'living-island', instanceId: ID, recordingId: ID, recordDir: '/data/recordings/20261030T040000Z-3-living-island', message: null };
    const worldPrepare = async (action, world, request) => {
      order.push(`hook:${action}`);
      assert.equal(world, 'graphysx-living');
      if (action === 'prepare') assert.equal(request, ID);
      return prepared;
    };
    const d = deps(dir, tracked, { worldPrepare });
    const done = await island.runIsland({ ...job, executor: living }, core.client, d);
    assert.deepEqual(order.slice(0, 4), ['check', 'hook:check', 'hook:prepare', 'start']);
    assert.equal(done.finishedWith.state, 'completed');
    assert.deepEqual(d.reports[0][1].worldPrepared, prepared);
    assert.ok(d.reports.every(([, body]) => body.worldPrepared?.recordDir === prepared.recordDir));
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'island', `${ID}-${DISPATCH}.receipt.json`)));
    assert.deepEqual(receipt.evidence.worldPrepared, prepared);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'island', `${ID}.state.json`))).worldPrepared.world, 'living-island');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a remote world the runner cannot reach is a not-started refusal', async () => {
  const dir = tempDir();
  try {
    const core = fakeCore();
    const { runner } = fakeRunner({ start: () => { throw Object.assign(new Error('remote world graphysx-living unavailable: /healthz answered 502'), { runnerRefused: true, code: 'WORLD_UNAVAILABLE' }); } });
    await assert.rejects(island.runIsland({ ...job }, core.client, deps(dir, runner, { worldPrepare: null })), /did not start/);
    const recover = core.calls.find(([e]) => e.endsWith('/recover'));
    assert.match(recover[1].receiptRef, /^island:not-started: WORLD_UNAVAILABLE: /);
    assert.ok(!core.calls.some(([e, body]) => e.endsWith('/record') && body?.state === 'uncertain'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the world hook command: typed argv, one JSON line, cleaned fields, refusals', async () => {
  const dir = tempDir();
  try {
    const script = path.join(dir, 'hook.cjs');
    fs.writeFileSync(script, [
      '#!/usr/bin/env node',
      'const [action, world, request] = process.argv.slice(2);',
      'if (world === "broken") { console.log("not json"); process.exit(0); }',
      'if (world === "refused") { console.log(JSON.stringify({ ok: false, managed: true, message: "409 agents on this island" })); process.exit(1); }',
      'console.log("noise first");',
      'console.log(JSON.stringify({ ok: true, managed: world !== "mesa-island", world: world === "mesa-island" ? undefined : "living-island",',
      '  recordDir: request ? "/data/recordings/x-1-living-island" : "../escape", token: "never-kept", action }));'
    ].join('\n'), { mode: 0o700 });
    assert.equal(island.worldPrepareConfig({}), null);
    assert.equal(island.worldPrepareConfig({ AGENTX_ISLAND_WORLD_PREPARE: script }), script);
    assert.throws(() => island.worldPrepareConfig({ AGENTX_ISLAND_WORLD_PREPARE: 'relative/hook' }), /absolute path/);
    assert.throws(() => island.worldPrepareConfig({ AGENTX_ISLAND_WORLD_PREPARE: '/x; rm -rf /' }), /absolute path/);
    const hook = island.createWorldPrepare(script);
    const checked = await hook('check', 'graphysx-living');
    assert.deepEqual(checked, { ok: true, managed: true, world: 'living-island', recordDir: null, message: null }, 'a path with .. is dropped, extra fields too');
    const prepared = await hook('prepare', 'graphysx-living', ID);
    assert.equal(prepared.recordDir, '/data/recordings/x-1-living-island');
    assert.deepEqual(await hook('check', 'mesa-island'), { ok: true, managed: false, world: 'mesa-island', recordDir: null, message: null });
    await assert.rejects(hook('check', 'refused'), /409 agents on this island/);
    await assert.rejects(hook('check', 'broken'), /gave no answer/);
    await assert.rejects(hook('prepare', 'graphysx-living'), /Invalid world preparation/);
    await assert.rejects(hook('check', 'Bad World'), /Invalid world preparation/);
    await assert.rejects(hook('select', 'graphysx-living'), /Invalid world preparation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
