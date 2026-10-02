#!/usr/bin/env node
'use strict';

// Bounded maintenance actions for a running AgentX instance (#8).
//
// A closed list of named actions, never a free shell. Each mutating action
// takes the instance's LEAD.md lease, refuses while it is held or while work
// is active, does one well-defined thing through the existing launcher and
// Core contracts, releases the lease with a note and prints a JSON receipt.
//
//   ./agentx action status
//   ./agentx action deploy --actor <who> --services core,benchmark [--revision origin/main]
//   ./agentx action recover-quarantine --actor <who> --host http://127.0.0.1:11434
//   ./agentx action recalibrate-judges --actor <who> [--host <url> --model <name>]
//
// Instance configuration (never in Git): AGENTX_ENV_FILE, AGENTX_PROJECT_NAME,
// AGENTX_COMPOSE_OVERRIDE, AGENTX_LEAD_FILE, optional AGENTX_ACTION_RECEIPTS_DIR
// and AGENTX_ACTION_OLLAMA_UNITS ({"<host url>": {"unit": "...", "scope": "system"|"user"}}).
// Exit codes: 0 completed, 1 failed, 2 usage, 4 refused (busy or held).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// The checkout the actions operate on; it defaults to the one holding this script.
const ROOT = path.resolve(process.env.AGENTX_CHECKOUT || path.join(__dirname, '..'));
const CONTRACT = 'agentx.maintenance-action/v1';
const DEPLOYABLE = Object.freeze(['core', 'benchmark', 'benchmark-runner', 'rag', 'data']);
const REVISION_PORTS = Object.freeze({ core: 3080, benchmark: 3081, rag: 3082 });
const ACTIONS = Object.freeze(['status', 'deploy', 'recover-quarantine', 'recalibrate-judges']);
const RESTART_CONFIRMATION = 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED';

class ActionError extends Error {
  constructor(message, { exitCode = 1, outcome = 'failed', details = {} } = {}) {
    super(message);
    Object.assign(this, { exitCode, outcome, details });
  }
}
const refuse = (message, details) => new ActionError(message, { exitCode: 4, outcome: 'refused', details });

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!/^--[a-z][a-z-]*$/.test(key)) throw new ActionError(`Unexpected argument: ${key}`, { exitCode: 2 });
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new ActionError(`${key} needs a value`, { exitCode: 2 });
    options[key.slice(2)] = value;
    i += 1;
  }
  if (!ACTIONS.includes(action)) throw new ActionError(`Unknown action. Use one of: ${ACTIONS.join(', ')}`, { exitCode: 2 });
  return { action, options };
}

function parseServices(value) {
  const services = String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!services.length) throw new ActionError('--services needs at least one service', { exitCode: 2 });
  const unknown = services.filter(s => !DEPLOYABLE.includes(s));
  if (unknown.length) throw new ActionError(`Not deployable: ${unknown.join(', ')} (allowed: ${DEPLOYABLE.join(', ')})`, { exitCode: 2 });
  return [...new Set(services)];
}

// --- LEAD.md: line 2 holder, line 3 since, line 4 notes (newest first) ---------------

function readLead(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const field = (index, name) => {
    const match = new RegExp(`^${name}:\\s?(.*)$`).exec(lines[index] || '');
    if (!match) throw new ActionError(`${file} line ${index + 1} is not "${name}:"`);
    return match[1];
  };
  return { lines, heldBy: field(1, 'held_by').trim(), since: field(2, 'since').trim(), notes: field(3, 'notes') };
}

function writeLead(file, lead, { heldBy, since, note }) {
  const lines = [...lead.lines];
  lines[1] = `held_by: ${heldBy}`;
  lines[2] = `since: ${since}`;
  lines[3] = `notes: ${note}${lead.notes ? ` || ${lead.notes}` : ''}`;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.join('\n'));
  fs.renameSync(temporary, file);
}

const minute = (now = new Date()) => now.toISOString().slice(0, 16) + 'Z';

function acquireLead(file, actor, purpose, now = new Date()) {
  const lead = readLead(file);
  if (lead.heldBy !== 'none') throw refuse(`LEAD.md is held by ${lead.heldBy} since ${lead.since}`, { heldBy: lead.heldBy });
  const holder = `agentx-action (${actor})`;
  writeLead(file, lead, { heldBy: holder, since: minute(now), note: `${minute(now)} ${holder}: ${purpose}` });
  return holder;
}

function releaseLead(file, holder, summary, now = new Date()) {
  const lead = readLead(file);
  if (lead.heldBy !== holder) return false;
  writeLead(file, lead, { heldBy: 'none', since: '', note: `${minute(now)} ${holder}: ${summary} Released.` });
  return true;
}

// --- Instance, processes and HTTP -----------------------------------------------------

function instance(env = process.env, { mutating }) {
  const config = {
    envFile: env.AGENTX_ENV_FILE, project: env.AGENTX_PROJECT_NAME, override: env.AGENTX_COMPOSE_OVERRIDE || null,
    leadFile: env.AGENTX_LEAD_FILE, receiptsDir: env.AGENTX_ACTION_RECEIPTS_DIR || null,
    units: env.AGENTX_ACTION_OLLAMA_UNITS ? JSON.parse(env.AGENTX_ACTION_OLLAMA_UNITS) : {}
  };
  // A missing project name silently selected the default "agentx" project and
  // once recreated another project's database container: actions never guess.
  const missing = ['envFile', 'project', ...(mutating ? ['leadFile'] : [])].filter(k => !config[k]);
  if (missing.length) {
    throw new ActionError(`Instance configuration missing: ${missing.map(k => ({ envFile: 'AGENTX_ENV_FILE', project: 'AGENTX_PROJECT_NAME', leadFile: 'AGENTX_LEAD_FILE' })[k]).join(', ')}`, { exitCode: 2 });
  }
  return config;
}

function run(command, args, { env, allowFailure = false, timeoutMs = 30 * 60_000 } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) throw new ActionError(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    throw new ActionError(`${command} ${args.slice(0, 3).join(' ')} exited ${result.status}`, { details: { tail: output.slice(-2000) } });
  }
  return { status: result.status, output };
}

// The build revision is the commit the deploy fast-forwarded to: an
// AGENTX_BUILD_REVISION left in the caller's environment would otherwise label
// the images with another commit, and the served-revision check would fail.
function launcherEnv(config, revision) {
  return {
    AGENTX_ENV_FILE: config.envFile, AGENTX_PROJECT_NAME: config.project, ...(config.override && { AGENTX_COMPOSE_OVERRIDE: config.override }),
    ...(revision && { AGENTX_BUILD_REVISION: revision })
  };
}

function composeArgs(config) {
  return ['compose', '--project-name', config.project, '--env-file', config.envFile, '-f', 'docker-compose.yml', ...(config.override ? ['-f', config.override] : [])];
}

function publishedUrl(config, service, port) {
  const { status, output } = run('docker', [...composeArgs(config), 'port', service, String(port)], { allowFailure: true, timeoutMs: 20_000 });
  const address = output.trim().split('\n').pop();
  return status === 0 && /^[\d.]+:\d+$/.test(address) ? `http://${address}` : null;
}

async function http(url, { method = 'GET', body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs),
    ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: response.ok, status: response.status, json, text: json ? undefined : text.slice(0, 500) };
}

async function activeWork(coreUrl) {
  const { ok, json } = await http(`${coreUrl}/api/nerve-center/runtime-coordination/active`);
  if (!ok) throw new ActionError('Core runtime coordination is unavailable');
  const data = json?.data || {};
  return { maintenance: data.maintenance || null, workloads: data.workloads || [], inferences: data.inferences || [] };
}

function deployProcesses() {
  const { output } = run('pgrep', ['-af', 'agentx (up|rebuild)'], { allowFailure: true, timeoutMs: 5_000 });
  return output.split('\n').filter(line => line.trim() && !line.includes('pgrep') && !line.includes('maintenance-actions'));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Actions --------------------------------------------------------------------------

async function status(config) {
  const head = run('git', ['rev-parse', 'HEAD']).output.trim();
  const dirty = run('git', ['status', '--porcelain']).output.trim().length > 0;
  const services = {};
  for (const [service, port] of Object.entries(REVISION_PORTS)) {
    const base = publishedUrl(config, service, port);
    services[service] = base ? await http(`${base}/health`, { timeoutMs: 5_000 }).then(r => ({ ok: r.ok, revision: r.json?.revision || null }), e => ({ ok: false, error: e.message })) : { ok: false, error: 'not published' };
  }
  const core = publishedUrl(config, 'core', 3080);
  return {
    checkout: { head, dirty }, services,
    coordination: core ? await activeWork(core).catch(e => ({ error: e.message })) : { error: 'Core not published' },
    lease: config.leadFile ? (({ heldBy, since }) => ({ heldBy, since }))(readLead(config.leadFile)) : null,
    deploysRunning: deployProcesses()
  };
}

async function waitIdle(coreUrl, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const work = await activeWork(coreUrl);
    if (!work.maintenance && !work.workloads.length && !work.inferences.length) return;
    if (Date.now() >= deadline) throw refuse('Work stayed active on the instance', { work });
    await sleep(10_000);
  }
}

async function deploy(config, options) {
  const services = parseServices(options.services);
  const target = options.revision || 'origin/main';
  if (deployProcesses().length) throw refuse('Another deploy is running', { processes: deployProcesses() });
  if (run('git', ['status', '--porcelain']).output.trim()) throw refuse('The instance checkout has local changes');
  run('git', ['fetch', '--quiet', 'origin']);
  const revision = run('git', ['rev-parse', '--verify', `${target}^{commit}`]).output.trim();
  // Only a revision already on the public main branch, reachable by fast-forward.
  if (run('git', ['merge-base', '--is-ancestor', revision, 'origin/main'], { allowFailure: true }).status !== 0) {
    throw refuse(`${target} is not on origin/main`);
  }
  const before = run('git', ['rev-parse', 'HEAD']).output.trim();
  if (run('git', ['merge-base', '--is-ancestor', before, revision], { allowFailure: true }).status !== 0) {
    throw refuse(`${revision.slice(0, 9)} does not descend from the deployed checkout ${before.slice(0, 9)}`);
  }
  const core = publishedUrl(config, 'core', 3080);
  if (core) await waitIdle(core, Number(options['wait-minutes'] || 10) * 60_000);
  run('git', ['merge', '--ff-only', '--quiet', revision]);
  const launched = run('./agentx', ['up', '--build', '--no-deps', ...services], { env: launcherEnv(config, revision), allowFailure: true });
  if (launched.status !== 0) {
    throw new ActionError(`The launcher did not recreate ${services.join(', ')} (exit ${launched.status})`,
      { exitCode: launched.status === 4 ? 4 : 1, outcome: launched.status === 4 ? 'refused' : 'failed', details: { revision, before, tail: launched.output.slice(-2000) } });
  }
  const served = {};
  for (const service of services.filter(s => REVISION_PORTS[s])) {
    const base = publishedUrl(config, service, REVISION_PORTS[service]);
    const health = base ? await http(`${base}/health`).catch(() => null) : null;
    served[service] = health?.json?.revision || null;
  }
  const mismatched = Object.entries(served).filter(([, value]) => value !== revision).map(([service]) => service);
  if (mismatched.length) throw new ActionError(`Not serving ${revision.slice(0, 9)}: ${mismatched.join(', ')}`, { details: { served } });
  return { revision, before, services, served };
}

function unitState(unit) {
  const scopeArgs = unit.scope === 'user' ? ['--user'] : [];
  const { output } = run('systemctl', [...scopeArgs, 'show', unit.unit, '-p', 'MainPID', '-p', 'ActiveState', '-p', 'ActiveEnterTimestampMonotonic'], { timeoutMs: 10_000 });
  return Object.fromEntries(output.trim().split('\n').map(line => line.split('=')));
}

async function quarantinedOn(config, host) {
  const mongo = run('docker', [...composeArgs(config), 'ps', '-q', 'mongo'], { timeoutMs: 20_000 }).output.trim();
  if (!mongo) throw new ActionError('The instance database container is not running');
  const script = 'const d=db.runtime_coordination.findOne({_id:"runtime"},{inferences:1,workloads:1});'
    + 'print(JSON.stringify({inferences:(d&&d.inferences||[]).map(i=>({id:i.admissionId,generation:i.generation,host:i.host,state:i.state,model:i.model,unknownAt:i.unknownAt})),workloads:(d&&d.workloads||[]).map(w=>({id:w.admissionId,hosts:w.hosts}))}))';
  const { output } = run('docker', ['exec', mongo, 'mongosh', '--quiet', 'agentx_product', '--eval', script], { timeoutMs: 30_000 });
  const state = JSON.parse(output.trim().split('\n').pop());
  const onHost = state.inferences.filter(item => item.host === host);
  return { unknown: onHost.filter(item => item.state === 'UNKNOWN'), active: onHost.filter(item => item.state !== 'UNKNOWN'),
    workloads: state.workloads.filter(w => (w.hosts || []).includes(host)) };
}

async function recoverQuarantine(config, options) {
  const host = String(options.host || '').replace(/\/+$/, '');
  const unit = config.units[host];
  if (!unit?.unit) throw new ActionError(`No Ollama unit is configured for ${host || 'the --host value'} in AGENTX_ACTION_OLLAMA_UNITS`, { exitCode: 2 });
  const state = await quarantinedOn(config, host);
  if (!state.unknown.length) return { host, recovered: [], note: 'No UNKNOWN inference on this host; nothing restarted.' };
  // A restart cuts every in-flight request: an active one would become a new UNKNOWN.
  if (state.active.length) throw refuse('An active inference is running on this host', { active: state.active });
  if (state.workloads.length) throw refuse('A workload covers this host; follow the profiler recovery procedure', { workloads: state.workloads });
  const before = unitState(unit);
  run(unit.scope === 'user' ? 'systemctl' : 'sudo', unit.scope === 'user' ? ['--user', 'restart', unit.unit] : ['-n', 'systemctl', 'restart', unit.unit], { timeoutMs: 120_000 });
  const restartedAt = new Date().toISOString();
  let after = unitState(unit), ready = false;
  for (let i = 0; i < 30 && !ready; i += 1) {
    after = unitState(unit);
    ready = after.ActiveState === 'active' && after.MainPID !== '0' && after.MainPID !== before.MainPID
      && await http(`${host}/api/version`, { timeoutMs: 3_000 }).then(r => r.ok, () => false);
    if (!ready) await sleep(2_000);
  }
  if (!ready) throw new ActionError(`${unit.unit} did not come back as a new process`, { details: { before, after } });
  const core = publishedUrl(config, 'core', 3080);
  const recovered = [];
  for (const item of state.unknown) {
    const result = await http(`${core}/api/runtime/inference-admissions/${encodeURIComponent(item.id)}/recover-runtime-restart`, { method: 'POST', body: {
      generation: item.generation, contract: 'agentx.ollama-runtime-restart/v1', runtimeRestarted: true, confirmation: RESTART_CONFIRMATION, restartedAt } });
    recovered.push({ id: item.id, model: item.model, recovered: result.json?.data?.recovered === true, reason: result.json?.data?.reason || null });
  }
  if (recovered.some(r => !r.recovered)) throw new ActionError('Core did not accept every recovery receipt', { details: { recovered } });
  return { host, unit: unit.unit, restartedAt, pid: { before: before.MainPID, after: after.MainPID }, recovered };
}

async function recalibrateJudges(config, options) {
  const benchmark = publishedUrl(config, 'benchmark', 3081);
  if (!benchmark) throw new ActionError('Benchmark is not published on this instance');
  const body = { ...(options.host && { host: options.host }), ...(options.model && { model: options.model }) };
  const result = await http(`${benchmark}/api/benchmark/judge/calibrate`, { method: 'POST', body, timeoutMs: 10 * 60_000 });
  if (result.status === 409 || result.status === 423) throw refuse('Benchmark refused the calibration workload', { response: result.json || result.text });
  if (!result.ok) throw new ActionError(`Judge calibration failed (HTTP ${result.status})`, { details: { response: result.json || result.text } });
  return { judge: body, report: result.json?.data ?? result.json };
}

// --- Receipt and entry point ----------------------------------------------------------

function writeReceipt(config, receipt) {
  if (!config?.receiptsDir) return null;
  fs.mkdirSync(config.receiptsDir, { recursive: true });
  const file = path.join(config.receiptsDir, `${receipt.startedAt.replace(/[:.]/g, '-')}-${receipt.action}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  let action = argv[0] || '', config = null, holder = null, receipt;
  try {
    const parsed = parseArgs(argv);
    action = parsed.action;
    const mutating = action !== 'status';
    config = instance(process.env, { mutating });
    if (mutating && !parsed.options.actor) throw new ActionError('--actor names who requested the action', { exitCode: 2 });
    if (mutating) holder = acquireLead(config.leadFile, parsed.options.actor, `${action} ${JSON.stringify(parsed.options)}`);
    const handler = { status, deploy, 'recover-quarantine': recoverQuarantine, 'recalibrate-judges': recalibrateJudges }[action];
    const result = await handler(config, parsed.options);
    receipt = { contract: CONTRACT, action, actor: parsed.options.actor || null, outcome: 'completed', startedAt, finishedAt: new Date().toISOString(), result };
  } catch (error) {
    const known = error instanceof ActionError ? error : new ActionError(error.message);
    receipt = { contract: CONTRACT, action, outcome: known.outcome, startedAt, finishedAt: new Date().toISOString(), reason: known.message, details: known.details, exitCode: known.exitCode };
  } finally {
    if (holder) {
      try { releaseLead(config.leadFile, holder, receipt?.outcome === 'completed' ? `${action} completed.` : `${action} ${receipt?.outcome}: ${receipt?.reason}`); }
      catch (error) { receipt.leaseReleaseError = error.message; }
    }
  }
  if (action !== 'status') receipt.file = writeReceipt(config, receipt);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return receipt.outcome === 'completed' ? 0 : receipt.exitCode || 1;
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { main, parseArgs, parseServices, readLead, acquireLead, releaseLead, instance, launcherEnv, ActionError, DEPLOYABLE };
