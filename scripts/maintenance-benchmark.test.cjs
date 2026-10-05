'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const actions = require('./maintenance-actions.cjs');
const { ACTIONS, cliRequest } = require('./maintenance-benchmark.cjs');
const { planRef, planId, planTag } = require('../shared/benchmarkBatchPlan.cjs');

const HOST = 'http://127.0.0.1:11434';
const JUDGE_HOST = 'http://127.0.0.1:11435';
const oid = n => n.toString(16).padStart(24, '0');
const PROMPTS = [
  { _id: oid(1), category: 'coding', level: 1 }, { _id: oid(2), category: 'coding', level: 2 }, { _id: oid(3), category: 'coding', level: 4 },
  { _id: oid(4), category: 'agent', level: 2 }, { _id: oid(5), category: 'math', level: 1 }, { _id: oid(6), category: 'math', level: 2 },
];

// A loopback stand-in for Benchmark's routes. `launch` decides what POST /batch
// does: answer, or create the batch and drop the connection before answering.
async function fakeBenchmark() {
  const state = {
    hosts: [{ hostUrl: HOST }, { hostUrl: JUDGE_HOST }], preferred: { host: JUDGE_HOST, model: 'judge-model:7b' },
    prompts: [...PROMPTS], preflight: () => ({ ready: true, issues: [], warnings: ['pinned model unloads'], checks: {} }),
    launch: 'accept', batches: [], posts: [], preflights: [], listFails: false,
    inventory: [{ name: 'candidate:7b' }, { name: 'judge-model:7b' }],
  };
  const create = body => {
    const batch = { _id: oid(0xb000 + state.batches.length), run_name: body.run_name, status: 'running', tags: body.tags,
      total_tests: body.prompt_ids.length * body.execution_config.repeats };
    state.batches.push(batch);
    return batch;
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://fake');
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      const ok = data => send(200, { status: 'success', data });
      if (url.pathname === '/api/tags') return send(200, { models: state.inventory });
      if (url.pathname === '/api/benchmark/judge/readiness') return ok({ hosts: state.hosts, preferred_target: state.preferred, blockers: ['no judge selected'] });
      if (url.pathname === '/api/benchmark/prompts') return ok({ prompts: state.prompts });
      if (url.pathname === '/api/benchmark/preflight') { state.preflights.push(body); return ok(state.preflight(body)); }
      if (url.pathname === '/api/benchmark/batches') {
        if (state.listFails) return send(500, { status: 'error', error: 'database unavailable' });
        const batches = state.batches.filter(batch => batch.tags.includes(url.searchParams.get('tag')));
        return ok({ batches, total: batches.length });
      }
      if (url.pathname === '/api/benchmark/batch' && req.method === 'POST') {
        state.posts.push(body);
        if (state.launch === 'accept') { const batch = create(body); return ok({ batch_id: batch._id, total_tests: batch.total_tests, plan: { categories: [] }, preflight: { warnings: [] } }); }
        if (state.launch === 'created-then-dropped') { create(body); return req.socket.destroy(); }
        if (state.launch === 'dropped') return req.socket.destroy();
        return send(state.launch.status, state.launch.json);
      }
      const batch = state.batches.find(item => `/api/benchmark/batch/${item._id}` === url.pathname);
      return batch ? ok(batch) : send(404, { status: 'error', error: 'Batch not found' });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const receiptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-batch-'));
  const leases = [];
  const ctx = options => ({ benchmark: `http://127.0.0.1:${server.address().port}`,
    http: (url, options) => url.endsWith('/api/tags') ? Promise.resolve({ ok: true, status: 200, json: { models: state.inventory } }) : actions.http(url, options), receiptsDir,
    options: { actor: 'tester', ...options }, takeLead: purpose => leases.push(purpose), ActionError: actions.ActionError });
  return { state, ctx, leases, receiptsDir, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    prepare: options => ACTIONS['benchmark-batch-prepare'](ctx({ host: HOST, model: 'candidate:7b', categories: 'coding,agent', levels: '1,2', repeats: '3', ...options })),
    start: options => ACTIONS['benchmark-batch-start'](ctx(options)),
    status: options => ACTIONS['benchmark-batch-status'](ctx(options)) };
}

async function withBenchmark(run) {
  const fake = await fakeBenchmark();
  try { await run(fake); } finally { await fake.close(); }
}

test('only the closed, bounded batch options are accepted', () => {
  const ctx = options => ({ options, ActionError: actions.ActionError });
  const base = { actor: 'tester', host: HOST, model: 'candidate:7b', categories: 'agent,coding' };
  const request = cliRequest(ctx(base));
  assert.deepEqual({ ...request }, { host: HOST, model: 'candidate:7b', categories: ['coding', 'agent'], levels: [1, 2, 3, 4, 5], repeats: 1,
    judgeHost: null, judgeModel: null, name: null, tag: null });
  assert.equal(cliRequest(ctx({ actor: 'tester' })), null);
  for (const bad of [{ 'paid-approval': 'yes' }, { 'multi-judge': 'always' }, { body: '{}' }, { prompt: 'say hi' }, { targets: 'x' },
    { categories: 'coding,poetry' }, { categories: '' }, { repeats: '6' }, { repeats: '0' }, { repeats: '2.5' }, { levels: '0,1' }, { levels: '6' },
    { host: 'http://127.0.0.1:11434/api' }, { host: 'ftp://127.0.0.1' }, { model: 'bad model' }, { model: 'big-model:120b-cloud' },
    { 'judge-host': JUDGE_HOST }, { 'judge-model': 'judge-model:7b' }, { 'judge-host': JUDGE_HOST, 'judge-model': 'frontier:cloud' },
    { name: 'x'.repeat(61) }, { name: 'two\nlines' }, { tag: 'Upper' }, { tag: 'agentx-plan-0000000000000000' }]) {
    assert.throws(() => cliRequest(ctx({ ...base, ...bad })), { exitCode: 2 }, JSON.stringify(bad));
  }
  assert.throws(() => cliRequest(ctx(base), { judgeRequired: true }), { exitCode: 2 });
  for (const action of Object.keys(ACTIONS)) assert.ok(actions.ACTIONS.includes(action));
  assert.equal(actions.parseArgs(['benchmark-batch-status', '--id', oid(1)]).action, 'benchmark-batch-status');
});

test('preparing resolves categories to prompt ids, pins the judge and starts nothing', () => withBenchmark(async fake => {
  const result = await fake.prepare({ name: 'Nightly run', tag: 'campaign-1' });
  assert.equal(result.started, false);
  assert.deepEqual(result.launch.prompt_ids, [oid(1), oid(4), oid(2)]);
  assert.deepEqual(result.projection, { prompts: 3, repeats: 3, tests: 9, categories: { coding: 2, agent: 1 } });
  assert.deepEqual(result.launch.judge_config, { host: JUDGE_HOST, model: 'judge-model:7b' });
  assert.equal(result.judgeSource, 'default');
  assert.deepEqual([result.request.judgeHost, result.request.judgeModel], [JUDGE_HOST, 'judge-model:7b']);
  assert.deepEqual(Object.keys(result.launch).sort(), ['execution_config', 'host', 'judge_config', 'levels', 'models', 'multi_judge', 'prompt_ids', 'run_name', 'tags']);
  assert.equal(result.launch.multi_judge, 'off');
  assert.deepEqual(result.launch.execution_config, { repeats: 3 });
  assert.deepEqual(result.launch.tags, [planTag(planId(result.plan)), 'campaign-1']);
  // The reference names the request: the start object reproduces it, other values do not.
  const { action, plan, ...restated } = result.start;
  assert.equal(action, 'benchmark-batch-start');
  assert.equal(planRef(planId(plan), restated), result.plan);
  assert.notEqual(planRef(planId(plan), { ...restated, repeats: 5 }), result.plan);
  // Benchmark's own preflight saw the same target, judge and prompts.
  assert.deepEqual(fake.state.preflights[0].targets, [{ host: HOST, model: 'candidate:7b' }]);
  assert.deepEqual(fake.state.preflights[0].prompt_ids, result.launch.prompt_ids);
  assert.equal(fake.state.posts.length, 0);
  assert.equal(fake.state.batches.length, 0);
  assert.equal(fake.leases.length, 0);
  assert.equal((await fake.prepare()).plan === result.plan, false);
}));

test('preparing refuses what Benchmark would not run, and keeps no plan', () => withBenchmark(async fake => {
  const refused = async (options, code) => {
    await assert.rejects(fake.prepare(options), error => {
      assert.equal(error.outcome, 'refused');
      assert.equal(error.exitCode, 4);
      assert.equal(error.details.code, code);
      return true;
    });
  };
  await refused({ host: 'http://127.0.0.1:9999' }, 'HOST_NOT_REGISTERED');
  await refused({ 'judge-host': 'http://198.51.100.7:11434', 'judge-model': 'judge-model:7b' }, 'JUDGE_HOST_NOT_REGISTERED');
  await refused({ categories: 'coding,translation' }, 'CATEGORY_WITHOUT_PROMPTS');
  fake.state.preferred = null;
  await refused({}, 'JUDGE_NOT_READY');
  // A named judge still goes through Benchmark's readiness, inside its preflight.
  fake.state.preflight = body => ({ ready: false, issues: [`Judge: ${body.judge_config.model} is not installed`], checks: { judge: { ok: false } } });
  await refused({ 'judge-host': JUDGE_HOST, 'judge-model': 'absent:1b' }, 'LOCAL_MODEL_NOT_INSTALLED');
  fake.state.preflight = body => ({ ready: false, issues: ['1 host(s) unreachable or missing models'],
    checks: { judge: { ok: true }, hosts: [{ ...body.targets[0], ok: false, host_ok: false, error: 'not found on host' }] } });
  await assert.rejects(fake.prepare({ 'judge-host': JUDGE_HOST, 'judge-model': 'judge-model:7b' }), error => {
    assert.equal(error.details.code, 'EXECUTION_TARGET_NOT_READY');
    assert.deepEqual(error.details.hosts, [{ host: HOST, model: 'candidate:7b', ok: false, error: 'not found on host' }]);
    return true;
  });
  fake.state.preflight = () => ({ ready: false, issues: ['1 orphaned batch(es) detected'], checks: { judge: { ok: true }, hosts: [] } });
  await refused({ 'judge-host': JUDGE_HOST, 'judge-model': 'judge-model:7b' }, 'PREFLIGHT_NOT_READY');
  assert.equal(fake.state.posts.length, 0);
  assert.equal(fs.existsSync(path.join(fake.receiptsDir, 'benchmark-batch')), false);
  await assert.rejects(ACTIONS['benchmark-batch-prepare']({ ...fake.ctx({ host: HOST, model: 'm', categories: 'coding' }), receiptsDir: null }), { exitCode: 2 });
}));

test('a cloud default judge is refused before preflight can probe or spend', () => withBenchmark(async fake => {
  fake.state.preferred = { host: JUDGE_HOST, model: 'frontier:cloud' };
  await assert.rejects(fake.prepare(), error => error.outcome === 'refused' && error.details.code === 'JUDGE_NOT_LOCAL');
  assert.equal(fake.state.preflights.length, 0);
  assert.equal(fake.state.posts.length, 0);
}));

test('remote aliases and unverifiable inventories are refused before any model probe', () => withBenchmark(async fake => {
  for (const name of ['candidate:7b', 'judge-model:7b']) {
    fake.state.inventory = [{ name: 'candidate:7b' }, { name: 'judge-model:7b' }].map(entry =>
      entry.name === name ? { ...entry, remote_host: 'https://remote.invalid', remote_model: 'cloud-model' } : entry);
    await assert.rejects(fake.prepare(), error => error.details.code === 'REMOTE_MODEL_FORBIDDEN');
  }
  fake.state.inventory = null;
  await assert.rejects(fake.prepare(), error => error.details.code === 'LOCAL_INVENTORY_UNAVAILABLE');
  assert.equal(fake.state.preflights.length, 0);
  assert.equal(fake.state.posts.length, 0);
}));

test('a start needs the prepared plan, unchanged', () => withBenchmark(async fake => {
  const { plan, start: { action, plan: ref, ...restated } } = await fake.prepare();
  const cli = request => ({ host: request.host, model: request.model, categories: request.categories.join(','), levels: request.levels.join(','),
    repeats: String(request.repeats), 'judge-host': request.judgeHost, 'judge-model': request.judgeModel });
  await assert.rejects(fake.start({}), { exitCode: 2 });
  await assert.rejects(fake.start({ plan: 'latest' }), { exitCode: 2 });
  await assert.rejects(fake.start({ plan: 'bp-0123456789abcdef-0123456789abcdef' }), { exitCode: 2, message: /No prepared plan/ });
  // Same identity, another digest: not this plan.
  await assert.rejects(fake.start({ plan: `${plan.slice(0, -1)}${plan.endsWith('0') ? '1' : '0'}` }), { exitCode: 2 });
  await assert.rejects(fake.start({ plan, ...cli({ ...restated, repeats: 5 }) }), { exitCode: 2, message: /not the ones prepared/ });
  await assert.rejects(fake.start({ plan, ...cli({ ...restated, model: 'other:7b' }) }), { exitCode: 2 });
  await assert.rejects(fake.start({ plan, ...cli(restated), 'paid-approval': 'yes' }), { exitCode: 2 });
  // A plan file edited after preparation no longer answers to its reference.
  const file = path.join(fake.receiptsDir, 'benchmark-batch', `${planId(plan)}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...stored, request: { ...stored.request, repeats: 5 } }));
  await assert.rejects(fake.start({ plan }), { exitCode: 2 });
  assert.equal(fake.state.posts.length, 0);
  assert.equal(fake.leases.length, 0);
}));

test('a start posts the plan once and returns Benchmark\'s batch id; the same start replays it', () => withBenchmark(async fake => {
  const prepared = await fake.prepare();
  const result = await fake.start({ plan: prepared.plan });
  assert.equal(result.batchId, fake.state.batches[0]._id);
  assert.equal(result.totalTests, 9);
  assert.equal(result.recovered, false);
  assert.deepEqual(fake.state.posts, [prepared.launch]);
  assert.equal(fake.leases.length, 1);
  assert.match(fake.leases[0], new RegExp(prepared.plan));
  // Conditions were read again under the lease, before the post.
  assert.equal(fake.state.preflights.length, 2);

  const again = await fake.start({ plan: prepared.plan });
  assert.deepEqual([again.batchId, again.recovered], [result.batchId, true]);
  assert.equal(fake.state.posts.length, 1);
  assert.equal(fake.leases.length, 1);

  const status = await fake.status({ id: result.batchId });
  assert.deepEqual([status.batchId, status.status, status.tests.planned], [result.batchId, 'running', 9]);
}));

test('a start checks current conditions again and refuses a plan that no longer holds', () => withBenchmark(async fake => {
  const { plan } = await fake.prepare();
  fake.state.preflight = () => ({ ready: false, issues: ['Judge: host is unreachable'], checks: { judge: { ok: false } } });
  await assert.rejects(fake.start({ plan }), error => error.outcome === 'refused' && error.details.code === 'JUDGE_NOT_READY');
  fake.state.preflight = () => ({ ready: true, issues: [], warnings: [], checks: {} });
  fake.state.prompts.push({ _id: oid(7), category: 'coding', level: 1 });
  await assert.rejects(fake.start({ plan }), error => error.outcome === 'refused' && error.details.code === 'PLAN_STALE');
  assert.equal(fake.state.posts.length, 0);
  // Nothing was dispatched: once conditions return, the plan starts.
  fake.state.prompts.pop();
  assert.equal((await fake.start({ plan })).recovered, false);
}));

test('a conflict or a refused admission is Benchmark\'s refusal, distinct from an unknown launch', () => withBenchmark(async fake => {
  const { plan } = await fake.prepare();
  const refusal = async (launch, verdict) => {
    fake.state.launch = launch;
    await assert.rejects(fake.start({ plan }), error => {
      assert.deepEqual([error.outcome, error.exitCode, error.details.verdict, error.details.status], ['refused', 4, verdict, launch.status]);
      assert.deepEqual(error.details.response, launch.json);
      assert.equal(error.details.planStartable, true);
      return true;
    });
  };
  await refusal({ status: 409, json: { status: 'error', error: 'Another batch is already running', active_batch: { id: oid(99) } } }, 'conflict');
  await refusal({ status: 409, json: { status: 'error', code: 'EXECUTION_HOST_PROFILING', error: 'Execution host is currently profiling' } }, 'conflict');
  await refusal({ status: 423, json: { status: 'error', error: 'locked' } }, 'conflict');
  await refusal({ status: 422, json: { status: 'error', error: 'Benchmark preflight failed', issues: ['x'] } }, 'not-admitted');
  await refusal({ status: 503, json: { status: 'error', code: 'JUDGE_NOT_READY', error: 'judge unavailable' } }, 'not-admitted');
  await refusal({ status: 500, json: { status: 'error', code: 'WORKLOAD_ADMISSION_REJECTED', error: 'Core refused admission before insertion' } }, 'not-admitted');
  assert.equal(fake.state.batches.length, 0);

  // An answer that states no verdict leaves the launch unknown, and the plan is not posted again.
  fake.state.launch = { status: 500, json: { status: 'error', error: 'admission handoff failed' } };
  const posts = fake.state.posts.length;
  await assert.rejects(fake.start({ plan }), { outcome: 'unknown', exitCode: 3 });
  fake.state.launch = 'accept';
  await assert.rejects(fake.start({ plan }), { outcome: 'unknown', exitCode: 3 });
  assert.equal(fake.state.posts.length, posts + 1);
  assert.equal(fake.state.batches.length, 0);
}));

test('a refusal Benchmark cannot confirm keeps the plan dispatched', () => withBenchmark(async fake => {
  const { plan } = await fake.prepare();
  Object.assign(fake.state, { launch: { status: 409, json: { status: 'error', error: 'Another batch is already running' } }, listFails: true });
  await assert.rejects(fake.start({ plan }), error => error.outcome === 'refused' && error.details.planStartable === false);
  Object.assign(fake.state, { launch: 'accept', listFails: false });
  await assert.rejects(fake.start({ plan }), { outcome: 'unknown' });
  assert.equal(fake.state.posts.length, 1);
}));

test('a lost answer is reconciled from Benchmark\'s own batch, never by posting again', () => withBenchmark(async fake => {
  const created = await fake.prepare();
  fake.state.launch = 'created-then-dropped';
  const recovered = await fake.start({ plan: created.plan });
  assert.deepEqual([recovered.batchId, recovered.recovered, recovered.batchStatus], [fake.state.batches[0]._id, true, 'running']);
  assert.equal(fake.state.posts.length, 1);

  // Nothing visible yet: unknown now, unknown on every later look, and still one post.
  const lost = await fake.prepare({ repeats: '1' });
  fake.state.launch = 'dropped';
  await assert.rejects(fake.start({ plan: lost.plan }), error => {
    assert.deepEqual([error.outcome, error.exitCode, error.details.plan], ['unknown', 3, lost.plan]);
    assert.match(error.message, /Do not prepare a replacement launch/);
    return true;
  });
  fake.state.launch = 'accept';
  await assert.rejects(fake.start({ plan: lost.plan }), { outcome: 'unknown' });
  fake.state.listFails = true;
  await assert.rejects(fake.start({ plan: lost.plan }), { outcome: 'unknown' });
  fake.state.listFails = false;
  assert.equal(fake.state.posts.length, 2);
  assert.equal(fake.leases.length, 2);
  // The batch Benchmark created late carries the plan: the same start now returns it.
  fake.state.batches.push({ _id: oid(0xcafe), status: 'judging', tags: lost.launch.tags, total_tests: 3 });
  const late = await fake.start({ plan: lost.plan });
  assert.deepEqual([late.batchId, late.recovered, late.batchStatus, late.totalTests], [oid(0xcafe), true, 'judging', 3]);
  assert.equal(fake.state.posts.length, 2);
  // Another plan's batch is never taken for this one.
  assert.notEqual(late.batchId, recovered.batchId);
}));

test('an error after batch insertion never becomes a successful launch on reconciliation', () => withBenchmark(async fake => {
  const prepared = await fake.prepare();
  fake.state.batches.push({ _id: oid(0xf00), status: 'running', tags: prepared.launch.tags, total_tests: 9 });
  fake.state.launch = { status: 500, json: { status: 'error', error: 'admission handoff failed after insertion' } };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(fake.start({ plan: prepared.plan }), error => {
      assert.equal(error.outcome, 'unknown');
      assert.equal(error.details.batchId, oid(0xf00));
      assert.equal(error.details.response.response.error, fake.state.launch.json.error);
      return true;
    });
  }
  assert.equal(fake.state.posts.length, 1);
}));

test('batch status reads Benchmark\'s record and changes nothing', () => withBenchmark(async fake => {
  fake.state.batches.push({ _id: oid(0xabc), run_name: 'Nightly run', status: 'completed', judge_status: 'completed', authority_state: 'authoritative',
    host: HOST, models: ['candidate:7b'], tags: ['campaign-1'], total_tests: 4, completed: 4, failed: 1, progress: 100,
    judge_total: 3, judge_completed: 3, judge_failed: 0, results_meta: { truncated: false },
    results: [{ prompt_category: 'coding', quality_score: 8 }, { prompt_category: 'coding', quality_score: 5 },
      { prompt_category: 'agent', quality_score: 7 }, { prompt_category: 'agent', quality_score: null }] });
  const status = await fake.status({ id: oid(0xabc) });
  assert.deepEqual(status.tests, { planned: 4, completed: 4, failed: 1, progress: 100 });
  assert.deepEqual(status.judging, { total: 3, completed: 3, failed: 0 });
  assert.equal(status.scores, undefined, 'the adapter does not recompute Benchmark quality statistics');
  assert.deepEqual([status.status, status.judgeStatus, status.runName], ['completed', 'completed', 'Nightly run']);
  await assert.rejects(fake.status({ id: oid(0xdef) }), error => error.outcome === 'failed' && error.details.code === 'BATCH_NOT_FOUND');
  await assert.rejects(fake.status({ id: '../batches' }), { exitCode: 2 });
  await assert.rejects(fake.status({ id: oid(0xabc), stop: 'yes' }), { exitCode: 2 });
  assert.equal(fake.leases.length, 0);
  assert.equal(fake.state.posts.length, 0);
}));

test('a preparation without an actor is a usage error with the normal receipt', async () => {
  const env = { ...process.env };
  Object.assign(process.env, { AGENTX_ENV_FILE: 'instance.env', AGENTX_PROJECT_NAME: 'synthetic', AGENTX_LEAD_FILE: path.join(os.tmpdir(), 'absent-LEAD.md') });
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = chunk => { output += chunk; return true; };
  try {
    const code = await actions.main(['benchmark-batch-prepare', '--host', HOST, '--model', 'm', '--categories', 'coding']);
    const receipt = JSON.parse(output);
    assert.equal(code, 2);
    assert.deepEqual([receipt.contract, receipt.action, receipt.outcome], ['agentx.maintenance-action/v1', 'benchmark-batch-prepare', 'failed']);
    assert.match(receipt.reason, /--actor/);
  } finally { process.stdout.write = write; process.env = env; }
});

test('the real CLI returns persisted receipts and replays one launch across processes', () => withBenchmark(async fake => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const exec = promisify(execFile);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-batch-cli-'));
  const lead = path.join(directory, 'LEAD.md');
  fs.writeFileSync(lead, '# LEAD\nheld_by: none\nsince: \nnotes: synthetic test\n');
  // Only Compose port discovery is simulated. No real Docker or LAN service runs.
  fs.writeFileSync(path.join(directory, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$AGENTX_TEST_ADDRESS"\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    AGENTX_ENV_FILE: path.join(directory, 'instance.env'), AGENTX_PROJECT_NAME: 'synthetic',
    AGENTX_LEAD_FILE: lead, AGENTX_ACTION_RECEIPTS_DIR: fake.receiptsDir,
    AGENTX_TEST_ADDRESS: new URL(fake.ctx({}).benchmark).host };
  const loopbackHost = fake.ctx({}).benchmark;
  fake.state.hosts.push({ hostUrl: loopbackHost });
  fake.state.preferred = { host: loopbackHost, model: 'judge-model:7b' };
  const call = async args => JSON.parse((await exec(process.execPath,
    [path.join(__dirname, 'maintenance-actions.cjs'), ...args], { env })).stdout);
  try {
    const prepared = await call(['benchmark-batch-prepare', '--actor', 'openclaw:leadx',
      '--host', loopbackHost, '--model', 'candidate:7b', '--categories', 'coding', '--levels', '1', '--repeats', '1']);
    assert.equal(prepared.contract, 'agentx.maintenance-action/v1');
    assert.equal(prepared.result.started, false);
    assert.equal(prepared.actor, 'openclaw:leadx');
    assert.equal(fake.state.posts.length, 0);
    const startArgs = ['benchmark-batch-start', '--actor', 'openclaw:leadx', '--plan', prepared.result.plan];
    const launched = await call(startArgs);
    assert.equal(launched.outcome, 'completed');
    assert.equal(launched.result.batchId, fake.state.batches[0]._id);
    assert.equal(actions.readLead(lead).heldBy, 'none');
    const disk = JSON.parse(fs.readFileSync(launched.file, 'utf8'));
    assert.equal(disk.result.batchId, launched.result.batchId);
    assert.equal(disk.actor, 'openclaw:leadx');
    const replay = await call(startArgs);
    assert.equal(replay.result.batchId, launched.result.batchId);
    assert.equal(replay.result.recovered, true);
    const status = await call(['benchmark-batch-status', '--id', launched.result.batchId]);
    assert.equal(status.result.status, 'running');
    assert.equal(status.result.batchId, launched.result.batchId);
    assert.equal(status.file, undefined, 'read status does not create another execution receipt');
    assert.equal(fake.state.posts.length, 1, 'separate processes never duplicate this launch');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}));
