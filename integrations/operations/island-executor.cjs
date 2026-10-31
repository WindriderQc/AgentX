'use strict';

// Island run executor for the heavy-work queue CLI (docs/ISLAND.md).
//
// A queued island request names an agent and a duration only. The operator
// environment names the runner host and its script; the request never carries
// a command, an address, a token or a model. The flow keeps the queue rules:
// every refusable check precedes the durable dispatch mark, a lost answer is
// resolved by reading the same run identity and never by starting again, and
// the request finishes with an attested receipt only after release is proven.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { hostUrlKey } = require('../../shared/ollamaHostConfig');
const { islandExecutor, isIslandExecutor, RECEIPT_CONTRACT, RUNNER_CONTRACT } = require('../../shared/islandRun.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NOT_STARTED = ['RUNNER_BUSY', 'INVALID', 'RUN_ID', 'RUNNER_CONFIG', 'RUNNER_STATE', 'RUNS_ROOT_TOO_LONG', 'RUNNER_START_FAILED', 'WORLD_UNAVAILABLE', 'WORLD_PREPARE'];
const WORLD = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RECORD_DIR = /^[\w./-]{1,300}$/;
const POLL_MS = 30000;
const RUNNER_SILENCE_MS = 15 * 60000;
const FINISH_ATTEMPTS = 20;

function stamp(date = new Date()) {
  return date.toISOString();
}
function log(message) {
  process.stderr.write(`${stamp()} island ${message}\n`);
}

// ── runner interface ────────────────────────────────────────────────────────

/** Where the runner lives: `local`, or `ssh:<target>` for another host. */
function runnerConfig(env = process.env) {
  const where = env.AGENTX_ISLAND_RUNNER || '';
  const script = env.AGENTX_ISLAND_RUNNER_SCRIPT || '';
  const python = env.AGENTX_ISLAND_RUNNER_PYTHON || 'python3';
  if (!/^(local|ssh:[A-Za-z0-9_.@-]{1,120})$/.test(where)) {
    throw new Error('AGENTX_ISLAND_RUNNER must be "local" or "ssh:<target>"; the instance names its runner host');
  }
  if (!script.startsWith('/') || /[\s'"`$\\]/.test(script) || /[\s'"`$\\]/.test(python)) {
    throw new Error('AGENTX_ISLAND_RUNNER_SCRIPT needs the absolute island_runner.py path on the runner host');
  }
  const target = where === 'local' ? null : where.slice(4);
  return { target, script, python, label: env.AGENTX_ISLAND_RUNNER_LABEL || target || 'local' };
}

const ARGUMENTS = {
  'run-id': value => UUID.test(value), 'dispatch-id': value => UUID.test(value), 'expected-instance': value => UUID.test(value),
  agent: value => /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(value), world: value => /^[a-z0-9][a-z0-9-]{0,63}$/.test(value),
  memory: value => ['continue', 'fresh'].includes(value), harness: value => ['codex', 'dsh', 'pi'].includes(value),
  minutes: value => /^\d{1,4}$/.test(value), 'context-window': value => /^\d{1,8}$/.test(value)
};

/** argv for one runner action; every value is typed, so quoting is a second guard. */
function runnerArgv(config, action, args = {}) {
  if (!['check', 'start', 'status', 'stop', 'memory'].includes(action)) throw new Error('Unsupported runner action');
  const argv = [config.python, config.script, action];
  for (const [key, raw] of Object.entries(args)) {
    const value = String(raw);
    if (!ARGUMENTS[key] || !ARGUMENTS[key](value)) throw new Error(`Invalid runner argument ${key}`);
    argv.push(`--${key}`, value);
  }
  if (!config.target) return { command: argv[0], args: argv.slice(1) };
  const quoted = argv.map(part => `'${part.replace(/'/g, `'\\''`)}'`).join(' ');
  return { command: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.target, quoted] };
}

function createRunner(config, { spawnImpl = spawn, timeoutMs = 120000 } = {}) {
  return (action, args) => new Promise((resolve, reject) => {
    const { command, args: argv } = runnerArgv(config, action, args);
    const child = spawnImpl(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n').pop() || '';
      let answer;
      try { answer = JSON.parse(line); } catch {
        return reject(new Error(`Runner gave no answer (${action}): ${(err || out).trim().slice(-300)}`));
      }
      if (answer.contract !== RUNNER_CONTRACT) return reject(new Error('Runner answered another contract'));
      if (!answer.ok) return reject(Object.assign(new Error(answer.message || 'Runner refused'), { code: answer.code, runnerRefused: true }));
      resolve(answer.data);
    });
  });
}

// ── shared world preparation (instance hook) ────────────────────────────────

/**
 * An optional instance command on the operator host that prepares a shared world before a
 * run (docs/ISLAND.md, "Choisir le monde"): for example it selects the GraphysX island and
 * starts it fresh, with the world service's operator token, which never leaves that host.
 *
 *   <hook> check <world>              read only, before the dispatch mark
 *   <hook> prepare <world> <request>  after the mark, just before the runner starts
 *
 * The last stdout line is JSON {ok, managed, world?, recordDir?, message?}; `managed: false`
 * means the hook does not own this world (a world the runner simulates itself).
 */
function worldPrepareConfig(env = process.env) {
  const hook = env.AGENTX_ISLAND_WORLD_PREPARE || '';
  if (!hook) return null;
  if (!hook.startsWith('/') || /[\s'"`$\\]/.test(hook)) {
    throw new Error('AGENTX_ISLAND_WORLD_PREPARE needs the absolute path of the instance hook');
  }
  return hook;
}

function cleanPrepared(answer, world) {
  const managed = answer.managed === true;
  return { ok: answer.ok === true, managed, world: WORLD.test(answer.world || '') ? answer.world : (managed ? null : world),
    recordDir: typeof answer.recordDir === 'string' && RECORD_DIR.test(answer.recordDir) && !answer.recordDir.includes('..') ? answer.recordDir : null,
    ...(UUID.test(answer.instanceId || '') ? { instanceId: answer.instanceId } : {}),
    ...(UUID.test(answer.recordingId || '') ? { recordingId: answer.recordingId } : {}),
    message: typeof answer.message === 'string' ? answer.message.slice(0, 300) : null };
}

function createWorldPrepare(hook, { spawnImpl = spawn, timeoutMs = 90000 } = {}) {
  return (action, world, requestId) => new Promise((resolve, reject) => {
    if (!['check', 'prepare'].includes(action) || !WORLD.test(world || '') || (action === 'prepare' && !UUID.test(requestId || ''))) {
      return reject(new Error('Invalid world preparation arguments'));
    }
    const argv = action === 'prepare' ? [action, world, requestId] : [action, world];
    const child = spawnImpl(hook, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      let answer;
      try { answer = JSON.parse(out.trim().split('\n').pop() || ''); } catch {
        return reject(new Error(`World hook gave no answer (${action}): ${(err || out).trim().slice(-300)}`));
      }
      const prepared = cleanPrepared(answer && typeof answer === 'object' ? answer : {}, world);
      if (code !== 0 || !prepared.ok) return reject(new Error(`World hook refused (${action}): ${prepared.message || `exit ${code}`}`));
      resolve(prepared);
    });
  });
}

// ── principal and receipts ──────────────────────────────────────────────────

/** The principal lane's endpoint, context and claim; never its model name. */
async function readPrincipal(core, request) {
  const data = await request(`${core}/api/nerve-center/agent-runtime-config/export`);
  const lane = data?.lanes?.daily || {};
  const preference = lane.hostPreference || {};
  return { hostUrl: lane.hostUrl || null, contextSize: Number(lane.contextSize) || null,
    ready: preference.status === 'ready', claimed: typeof preference.benchmarkClaimed === 'boolean' ? preference.benchmarkClaimed : null };
}
function assertPrincipal(job, principal) {
  if (!principal.hostUrl || !principal.contextSize) throw new Error('The principal endpoint or its context is unresolved; nothing was started');
  let key;
  try { key = hostUrlKey(principal.hostUrl); } catch { key = null; }
  if (!key || !job.hosts.includes(key)) {
    throw new Error('The principal endpoint is not among this request\'s hosts; submit a new request for the current pin');
  }
  if (!principal.ready || principal.claimed !== false) throw new Error('The principal host is not free at the slot; the reservation is left for the owner');
}

function ledger(receiptsDir, id) {
  if (!receiptsDir) throw new Error('Island execution requires AGENTX_ACTION_RECEIPTS_DIR');
  const dir = path.join(receiptsDir, 'island');
  const file = path.join(dir, `${id}.state.json`);
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  return { dir, read, write: value => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const bytes = JSON.stringify({ ...(read() || {}), ...value, updatedAt: stamp() }, null, 2) + '\n';
    const temp = `${file}.tmp`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const parent = fs.openSync(dir, 'r');
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } };
}

function outcomeState(status) {
  if (status.phase === 'finished' && status.outcome === 'completed') return 'completed';
  if (status.phase === 'finished' && status.outcome === 'stopped') return 'cancelled';
  return 'failed';
}

function runSummary(status) {
  const keep = ['phase', 'outcome', 'agent', 'harness', 'minutes', 'memory', 'world', 'model', 'requestedAt', 'startedAt', 'endedAt',
    'timeZone', 'resumeCount', 'recording', 'memorySource', 'memorySaved', 'liveView', 'worldKind', 'remoteWorld', 'worldHealth'];
  return { ...Object.fromEntries(keep.map(key => [key, status[key] ?? null])), events: (status.events || []).slice(-100) };
}

// ── the executor ────────────────────────────────────────────────────────────

function defaults(deps = {}) {
  const env = deps.env || process.env;
  const config = deps.runner ? null : runnerConfig(env);
  const hook = deps.worldPrepare === undefined ? worldPrepareConfig(env) : null;
  return {
    worldPrepare: deps.worldPrepare === undefined ? (hook ? createWorldPrepare(hook) : null) : deps.worldPrepare,
    runner: deps.runner || createRunner(config),
    label: deps.label || config?.label || 'runner',
    principal: deps.principal || (() => readPrincipal(deps.core, deps.request)),
    report: deps.report || (async () => {}),
    sleep: deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms))),
    now: deps.now || (() => Date.now()),
    receiptsDir: deps.receiptsDir || env.AGENTX_ACTION_RECEIPTS_DIR,
    actor: deps.actor || 'operator',
    pollMs: deps.pollMs ?? POLL_MS
  };
}

/** Benchmark's run record; a failed report never changes the run. */
async function reportSafely(d, id, body) {
  try { await d.report(id, { runner: d.label, ...body }); }
  catch (error) { log(`report to Benchmark failed for ${id}: ${error.message}`); }
}

/** Start a reserved island request inside its open window. */
async function runIsland(job, client, deps = {}) {
  if (job.kind !== 'other' || !isIslandExecutor(job.executor)) throw new Error('Not an island request');
  const executor = islandExecutor(job.executor);
  const d = defaults(deps);
  const book = ledger(d.receiptsDir, job.id);
  if (book.read()) throw new Error('This request already has a dispatch here; use island-settle, never relaunch');
  // Refusable checks, all before the durable dispatch mark.
  // Readiness depends on the selected agent's socket path and harness adapter.
  // Keep Codex implicit for runners that predate --harness.
  const harness = executor.harness !== 'codex' ? { harness: executor.harness } : {};
  // A managed world may still run another terrain before preparation. Its hook checks
  // availability here; start validates the selected terrain after the hook switches it.
  const check = await d.runner('check', { agent: executor.agent, ...harness,
    ...(d.worldPrepare ? {} : { world: executor.world }) });

  if (!check.ready) throw new Error(`Runner is not ready: ${(check.problems || []).join('; ')}`);
  if (check.activeRun) throw new Error(`Runner is busy with run ${check.activeRun}`);
  const principal = await d.principal();
  assertPrincipal(job, principal);
  if (d.worldPrepare) await d.worldPrepare('check', executor.world);

  book.write({ phase: 'begin-unclear', queueRequestId: job.id });
  const begun = await client(`/${job.id}/begin`, { expectedRevision: job.revision });
  const dispatchId = begun.dispatchId;
  book.write({ phase: 'dispatched', dispatchId, runner: d.label, dispatchedAt: stamp() });
  log(`dispatch fence crossed for ${job.id}: ${dispatchId}`);
  let started = null;
  let worldPrepared = null;
  try {
    await client(`/${job.id}/assert-dispatch`, { dispatchId });
    if (d.worldPrepare) {
      // A shared world starts fresh for this run; nothing has started on the runner yet.
      try { worldPrepared = await d.worldPrepare('prepare', executor.world, job.id); }
      catch (error) { throw Object.assign(error, { notStarted: true, code: 'WORLD_PREPARE' }); }
      book.write({ worldPrepared });
    }
    try {
      // Codex stays the runner's default: an older runner without --harness keeps working.
      const harness = executor.harness && executor.harness !== 'codex' ? { harness: executor.harness } : {};
      started = await d.runner('start', { 'run-id': job.id, 'dispatch-id': dispatchId, agent: executor.agent,
        minutes: executor.minutes, memory: executor.memory, world: executor.world, ...harness, ...(worldPrepared?.instanceId ? { 'expected-instance': worldPrepared.instanceId } : {}), 'context-window': principal.contextSize });
    } catch (error) {
      if (error.runnerRefused && NOT_STARTED.includes(error.code)) throw Object.assign(error, { notStarted: true });
      // A lost answer: read the same run identity. Never start it again.
      const seen = await d.runner('status', { 'run-id': job.id }).catch(() => null);
      if (!seen || seen.dispatchId !== dispatchId) throw error;
      started = seen;
    }
    book.write({ phase: 'running' });
    await client(`/${job.id}/record`, { dispatchId, state: 'running', operationId: `island:${job.id}` });
  } catch (error) {
    if (error.notStarted) {
      // The runner proved nothing started: release the fence with that receipt.
      try {
        const current = await client(`/${job.id}`);
        await client(`/${job.id}/recover`, { expectedRevision: current.revision, dispatchId,
          confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED',
          receiptRef: `island:not-started: ${error.code}: ${error.message}`.slice(0, 500) });
        book.write({ phase: 'not-started', reason: error.message });
        throw Object.assign(new Error(`Island run did not start: ${error.message}`), { queueId: job.id });
      } catch (recoverError) {
        if (recoverError.queueId) throw recoverError;
      }
    }
    if (!started) {
      try { await client(`/${job.id}/record`, { dispatchId, state: 'uncertain', reason: `Island start unknown: ${error.message}`.slice(0, 1000) }); }
      catch { /* The durable dispatch mark still fences the resources. */ }
      book.write({ phase: 'uncertain', reason: error.message });
      throw Object.assign(new Error(`Queue ${job.id} requires reconciliation: ${error.message}`), { queueId: job.id, outcome: 'uncertain' });
    }
    log(`run started but Core bookkeeping failed (${error.message}); following the run anyway`);
  }
  await reportSafely(d, job.id, { queueRequestId: job.id, dispatchId, executor, status: started, worldPrepared });
  return followAndFinish({ ...job, dispatchId }, executor, client, d, book);
}

/** Follow a dispatched island run to its end, then finish the request. Never starts. */
async function settleIsland(job, client, deps = {}) {
  if (job.kind !== 'other' || !isIslandExecutor(job.executor)) throw new Error('Not an island request');
  if (!['dispatching', 'running', 'uncertain'].includes(job.state)) throw new Error(`Request is ${job.state}; nothing to settle`);
  const executor = islandExecutor(job.executor);
  const d = defaults(deps);
  const book = ledger(d.receiptsDir, job.id);
  let status;
  try { status = await d.runner('status', { 'run-id': job.id }); }
  catch (error) {
    if (error.code === 'RUN_NOT_FOUND') {
      throw new Error('The runner has no run for this request. Check the configured runner host; once you have verified that nothing ran, record it with `recover`.');
    }
    throw error;
  }
  if (status.dispatchId !== job.dispatchId) throw new Error('The runner\'s run belongs to another dispatch');
  if (job.state === 'dispatching') await client(`/${job.id}/record`, { dispatchId: job.dispatchId, state: 'running', operationId: `island:${job.id}` });
  book.write({ phase: 'running', dispatchId: job.dispatchId, settledBy: d.actor });
  return followAndFinish(job, executor, client, d, book);
}

async function followAndFinish(job, executor, client, d, book) {
  const { id, dispatchId } = job;
  const worldPrepared = book.read()?.worldPrepared || null;
  const watchUntil = d.now() + (executor.minutes + 30) * 60000;
  let lastSeen = d.now();
  let stopAsked = false;
  let status;
  for (;;) {
    try {
      status = await d.runner('status', { 'run-id': id });
      lastSeen = d.now();
    } catch (error) {
      if (d.now() - lastSeen > RUNNER_SILENCE_MS) {
        book.write({ phase: 'runner-silent', reason: error.message });
        throw Object.assign(new Error(`Runner silent for 15 minutes; the request stays running. Use island-settle later: ${error.message}`),
          { queueId: id, outcome: 'uncertain' });
      }
      await d.sleep(d.pollMs);
      continue;
    }
    if (status.dispatchId !== dispatchId) throw new Error('The runner\'s run belongs to another dispatch');
    await reportSafely(d, id, { queueRequestId: id, dispatchId, executor, status, worldPrepared });
    if (status.terminal === true && status.alive === false) break;
    if (!stopAsked && d.now() > watchUntil) {
      stopAsked = true;
      log(`run ${id} passed its time; asking the runner to stop it`);
      await d.runner('stop', { 'run-id': id }).catch(error => log(`stop failed: ${error.message}`));
    }
    await d.sleep(d.pollMs);
  }
  return finish(job, executor, status, client, d, book);
}

async function finish(job, executor, status, client, d, book) {
  const { id, dispatchId } = job;
  const localReleased = status.terminal === true && status.alive === false && status.localStopped === true
    && status.processObservationOk === true && Array.isArray(status.leftover) && status.leftover.length === 0;
  const state = outcomeState(status);
  const worldPrepared = book.read()?.worldPrepared || null;
  const file = path.join(book.dir, `${id}-${dispatchId}.receipt.json`);
  fs.mkdirSync(book.dir, { recursive: true, mode: 0o700 });
  let lastError;
  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++) {
    const current = await client(`/${id}`);
    if (['completed', 'failed', 'cancelled'].includes(current.state)) {
      if (current.releaseReceipt?.operationId !== dispatchId) throw new Error('Terminal dispatch identity differs');
      book.write({ phase: 'finished' }); return current;
    }
    if (current.dispatchId !== dispatchId) throw new Error('Active dispatch identity differs');
    let native = null;
    try { native = await client(`/${id}/operator-release?dispatchId=${encodeURIComponent(dispatchId)}`); }
    catch (error) { lastError = error; }
    const fresh = native && Number.isFinite(Date.parse(native.observedAt))
      && Math.abs(Date.now() - Date.parse(native.observedAt)) <= 30000;
    const released = localReleased && fresh && native.contract === 'agentx.operator-release/v1'
      && native.authority === 'core.runtime-coordination' && native.queueRequestId === id
      && native.dispatchId === dispatchId && native.runtimeReleased === true;
    const receipt = { contract: RECEIPT_CONTRACT, queueRequestId: id, dispatchId, actor: d.actor,
      receiptRef: executor.receiptRef, state, runtimeReleased: Boolean(released),
      evidence: { executor: 'island', runner: d.label, run: runSummary(status), worldPrepared,
        leftoverProcesses: status.leftover ?? null, processObservationOk: status.processObservationOk === true,
        nativeRelease: native, recordedAt: stamp() } };
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const receiptSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    book.write({ phase: 'finishing', receiptFile: file, receiptSha256, state, released: Boolean(released) });
    if (!released) {
      // Missing/invalid evidence is not absence of native authority. Never attest it.
      if (localReleased && native?.runtimeReleased === false && attempt < FINISH_ATTEMPTS) {
        await d.sleep(d.pollMs); continue;
      }
      book.write({ phase: 'needs-operator' });
      throw Object.assign(new Error(`Release not proven; receipt kept at ${file}`), { queueId: id });
    }
    const memory = await d.runner('memory', { 'run-id': id }).catch(() => ({}));
    await reportSafely(d, id, { queueRequestId: id, dispatchId, executor, status, worldPrepared, memory: memory.files || null,
      receipt: { file, sha256: receiptSha256, state, runtimeReleased: true } });
    try {
      const done = await client(`/${id}/operator-finish`, { expectedRevision: current.revision, dispatchId, state,
        receiptRef: executor.receiptRef, receiptSha256, confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED' });
      book.write({ phase: 'finished' }); return done;
    } catch (error) {
      lastError = error;
      await d.sleep(d.pollMs);
    }
  }
  book.write({ phase: 'finish-refused', reason: lastError?.message });
  throw Object.assign(new Error(`Core kept refusing the finish: ${lastError?.message}. Receipt: ${file}`), { queueId: id });
}

/** Wait for Core to place the request, then start it at its slot. */
async function watchIsland(id, client, deps = {}, { when = 'tonight' } = {}) {
  if (!['asap', 'tonight'].includes(when)) throw new Error('--when needs asap or tonight');
  const d = defaults(deps);
  let lastReason = null;
  for (;;) {
    const job = await client(`/${id}`);
    if (job.kind !== 'other' || !isIslandExecutor(job.executor)) throw new Error('Not an island request');
    if (job.startBefore && d.now() >= Date.parse(job.startBefore)) throw new Error('The start window expired without a slot');
    if (job.state === 'requested') {
      try {
        await client(`/${id}/place`, { expectedRevision: job.revision, when });
        log(`placed ${id} (${when})`);
      } catch (error) {
        if (error.message !== lastReason) log(`waiting for a slot: ${error.message}`);
        lastReason = error.message;
        await d.sleep(Math.max(d.pollMs, 1000) * 4);
      }
      continue;
    }
    if (job.state !== 'reserved') throw new Error(`Request is ${job.state}; island-watch only starts a waiting request`);
    const start = Date.parse(job.reservation.start);
    if (d.now() < start) {
      await d.sleep(Math.min(d.pollMs, start - d.now()));
      continue;
    }
    return runIsland(job, client, deps);
  }
}

module.exports = { runnerConfig, runnerArgv, createRunner, readPrincipal, assertPrincipal, runIsland, settleIsland, watchIsland, outcomeState,
  worldPrepareConfig, createWorldPrepare };
