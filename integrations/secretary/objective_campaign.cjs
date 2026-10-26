#!/usr/bin/env node
'use strict';

// One resumable control step over Core's existing operator queue. Core owns all
// scheduling; the private checkpoint records identities and receipts only.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const queue = require('../operations/heavy-work-queue.cjs');
const hash = value => createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function durable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function configuration(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value.id || '') || !value.actor || !value.core || !value.objectiveFile) throw new Error('Explicit campaign/actor/Core/objective are required');
  if (!Array.isArray(value.hosts) || !value.hosts.length || !value.source?.ref) throw new Error('Declare native hosts and session/issue provenance');
  for (const key of ['maxPages', 'maxSeconds', 'estimatedMinutes', 'publishBudget']) if (!Number.isInteger(value[key]) || value[key] <= 0) throw new Error(`Positive ${key} is required after pilot measurement`);
  if (!['asap', 'tonight'].includes(value.when)) throw new Error('Core placement must be asap or tonight');
  if (!value.startBefore || !Number.isFinite(Date.parse(value.startBefore))) throw new Error('An explicit campaign start limit is required');
  return value;
}
function serviceName(id) { return `secretary-objective-${id}.service`; }
function showUnit(unit, exec = spawnSync) {
  const result = exec('systemctl', ['--user', 'show', unit, '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode'], { encoding: 'utf8' });
  const state = Object.fromEntries(String(result.stdout || '').trim().split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  return { ...state, commandStatus: result.status };
}
function dependencies(config) {
  const flags = ['--core', config.core, '--actor', config.actor];
  return {
    now: () => new Date(),
    queue: (action, args = []) => queue.main([action, ...flags, ...args]),
    place: job => queue.json(`${config.core}/api/cluster/schedule/work-queue/${job.id}/place`,
      { actor: config.actor, body: { expectedRevision: job.revision, when: config.when, priority: config.priority || 5 } }),
    coordination: () => queue.json(`${config.core}/api/nerve-center/runtime-coordination/active`),
    unit: showUnit,
    launch(unit, job) {
      return spawnSync('systemd-run', ['--user', `--unit=${unit}`, '--service-type=exec', '--property=RemainAfterExit=yes',
        '--description=Native bounded Secretary objective review', '/usr/bin/python3', path.join(__dirname, 'objective_review.py'),
        'run', '--objective', config.objectiveFile, '--core', config.core, '--max-pages', String(config.maxPages),
        '--max-seconds', String(config.maxSeconds), '--queue-request-id', job.id, '--queue-dispatch-id', job.dispatchId,
        ...(config.priorityFile ? ['--priority-file', config.priorityFile] : [])], { encoding: 'utf8' });
    },
    publish(directory) {
      const result = spawnSync(process.execPath, [path.join(__dirname, 'objective_publish.cjs'), 'publish', '--directory', directory,
        '--core', config.core, '--max-entries', String(config.publishBudget)], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Native candidate publication needs reconciliation; preserve publication receipts');
      return JSON.parse(result.stdout.trim().split('\n').at(-1));
    }
  };
}
async function advance(config, deps) {
  configuration(config);
  const objectiveConfig = read(config.objectiveFile);
  const root = config.archiveRoot || path.join(require('node:os').homedir(), '.local/share/agentx/secretary-evidence');
  const directory = path.join(root, 'objective-reviews', objectiveConfig.id, objectiveConfig.version);
  const objective = read(path.join(directory, 'manifest.json'));
  const home = path.join(directory, 'campaigns', config.id), stateFile = path.join(home, 'state.json');
  const configHash = hash(JSON.stringify({ config, objectiveSha256: objective.objectiveSha256 }));
  let state = fs.existsSync(stateFile) ? read(stateFile) : { schema: 'secretary.objective-campaign/v1', configHash,
    objectiveSha256: objective.objectiveSha256, sequence: 0, current: null, completedChunks: [] };
  if (state.configHash !== configHash) throw new Error('Campaign configuration changed; retain original identities and use a new campaign ID');
  const report = (phase, extra = {}) => { state = { ...state, phase, at: deps.now().toISOString(), ...extra }; durable(stateFile, state); return state; };
  if (state.phase === 'needs-source-review') return state;
  if (state.phase === 'publication-pending') {
    const published = await deps.publish(directory);
    if (published.writes > 0) return report('publication-pending', { publication: published });
    state.phase = 'ready';
  }
  if (!state.current) {
    const coverage = read(path.join(directory, 'coverage.json'));
    if (coverage.allTargetTextCovered) {
      const published = await deps.publish(directory);
      return report(published.writes ? 'publication-pending' : 'text-scope-complete', { publication: published,
        remainingGaps: coverage.counts.sourcesWithGaps || 0, semanticAcceptance: 'not-established', userConfirmed: false });
    }
    const key = `secretary-objective:${config.id}:${objective.objectiveSha256.slice(0, 12)}:${state.sequence}`;
    const chunkHome = path.join(home, `chunk-${state.sequence}`);
    const requestFile = path.join(chunkHome, 'request.json');
    const request = { key, title: `Secretary objective ${objectiveConfig.id}: bounded continuation ${state.sequence}`,
      kind: 'other', hosts: config.hosts, estimatedMinutes: config.estimatedMinutes,
      notBefore: deps.now().toISOString(), startBefore: config.startBefore, source: config.source,
      executor: { mode: 'operator', receiptRef: path.join(chunkHome, 'terminal.json') } };
    // Save exact submission bytes before calling Core. A lost submit is resolved
    // by the same native key, never by allocating another chunk identity.
    if (!fs.existsSync(requestFile)) durable(requestFile, request);
    state.current = { key, chunkHome, requestFile, launchIntent: false };
    report('prepared');
  }
  let current = state.current, job;
  if (!current.queueId) {
    const listed = await deps.queue('list');
    job = listed.jobs.find(row => row.key === current.key);
    if (!job && current.submissionUncertain) return report('uncertain', { reason: 'Native queue submission has no reconciled identity' });
    if (!job) {
      try { job = await deps.queue('submit', ['--file', current.requestFile]); }
      catch (error) { current.submissionUncertain = true; report('queue-submission-unconfirmed'); throw error; }
    }
    current.queueId = job.id; report('queued');
  }
  job = await deps.queue('show', ['--id', current.queueId]);
  if (['failed', 'cancelled'].includes(job.state)) return report('needs-source-review', { reason: 'Current native chunk ended without completed review', queueState: job.state });
  if (job.state === 'completed') {
    if (!job.releaseReceipt) return report('uncertain', { reason: 'Native queue has no release receipt' });
    state.completedChunks.push({ queueId: job.id, dispatchId: job.dispatchId, releaseReceipt: job.releaseReceipt });
    state.current = null; state.sequence++;
    const published = await deps.publish(directory);
    return report(published.writes ? 'publication-pending' : 'ready', { publication: published });
  }
  if (job.state === 'uncertain') return report('uncertain', { reason: 'Native queue requires exact dispatch reconciliation' });
  if (job.state === 'requested') {
    try { job = await deps.place(job); }
    catch (error) { return report('waiting-for-native-placement', { reason: error.message }); }
  }
  if (job.state === 'reserved') {
    if (deps.now().getTime() < Date.parse(job.reservation.start)) return report('waiting-for-native-window', { nextAt: job.reservation.start });
    if (deps.now().getTime() >= Date.parse(job.reservation.end)) return report('waiting-for-native-placement', { reason: 'Reservation expired; retain this queue identity for replanning' });
    job = await deps.queue('begin-operator', ['--id', job.id, '--revision', String(job.revision)]);
    current.dispatchId = job.dispatchId; report('admitted');
  }
  if (job.state !== 'dispatching' || !job.dispatchId || current.dispatchId && current.dispatchId !== job.dispatchId) return report('uncertain', { reason: 'Unexpected native dispatch identity/state' });
  current.dispatchId = job.dispatchId;
  current.unit = serviceName(job.id);
  let unit = await deps.unit(current.unit);
  if (unit.LoadState === 'not-found') {
    if (current.launchIntent) return report('uncertain', { reason: 'Systemd launch outcome not reconciled; no replacement launched' });
    current.launchIntent = true; report('launching');
    const launched = await deps.launch(current.unit, job);
    durable(path.join(current.chunkHome, 'systemd-launch.json'), { unit: current.unit, status: launched.status,
      at: deps.now().toISOString(), stdout: launched.stdout || '', stderr: launched.stderr || '' });
    unit = await deps.unit(current.unit);
    if (unit.LoadState === 'not-found') return report('uncertain', { reason: 'Native systemd did not establish a retained worker identity' });
  }
  if (Number(unit.MainPID) > 0) return report('running');
  const statusFile = path.join(directory, 'status.json');
  const status = fs.existsSync(statusFile) ? read(statusFile) : {};
  if (status.queueRequestId !== job.id || status.dispatchId !== job.dispatchId || !['done', 'partial', 'stopped', 'validation-error', 'source-error'].includes(status.phase)) {
    return report('uncertain', { reason: 'No exact terminal worker status; retain native inference and queue fences' });
  }
  if (unit.ExecMainCode !== '1' || Number(unit.ExecMainStatus) !== 0) return report('uncertain', { reason: 'Native worker termination was not cleanly received' });
  const active = await deps.coordination();
  if (active.maintenance || active.drain || active.workloads?.length || active.inferences?.length) return report('waiting-for-native-release');
  const success = ['done', 'partial', 'stopped'].includes(status.phase);
  const receipt = { contract: 'agentx.operator-heavy-work/v1', queueRequestId: job.id, dispatchId: job.dispatchId,
    actor: config.actor, receiptRef: job.executor.receiptRef, state: success ? 'completed' : 'failed', runtimeReleased: true,
    observedAt: deps.now().toISOString(), workerUnit: current.unit, workerStatusSha256: hash(fs.readFileSync(statusFile)),
    workerPhase: status.phase, newlyReviewedPages: status.newlyReviewedPages, inferenceCalls: status.inferenceCalls,
    elapsedSeconds: status.elapsedSeconds, qualification: 'Exact bounded text review only; visual/OCR gaps remain explicit' };
  durable(job.executor.receiptRef, receipt);
  await deps.queue('finish-operator', ['--id', job.id, '--revision', String(job.revision), '--file', job.executor.receiptRef]);
  return report(success ? 'chunk-released' : 'needs-source-review');
}
async function step(config, deps = dependencies(config)) {
  configuration(config);
  const objective = read(config.objectiveFile);
  const root = config.archiveRoot || path.join(require('node:os').homedir(), '.local/share/agentx/secretary-evidence');
  const home = path.join(root, 'objective-reviews', objective.id, objective.version, 'campaigns', config.id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, 'controller.lock');
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = read(file);
    if (owner.host !== require('node:os').hostname()) throw new Error('Another native host owns this controller step');
    try { process.kill(owner.pid, 0); throw new Error('Another native controller step is still active'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    // Only a dead controller lock is released. Model/queue/unit dispatch fences
    // remain intact and are reconciled by advance before any effect.
    fs.unlinkSync(file);
    return step(config, deps);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: require('node:os').hostname() })); fs.fsyncSync(fd);
    return await advance(config, deps);
  } finally { fs.closeSync(fd); fs.unlinkSync(file); }
}
async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== 'step' || argv[1] !== '--config' || !argv[2] || argv.length !== 3) throw new Error('Use step --config <private campaign.json>');
  const config = configuration(read(argv[2]));
  const result = await step(config);
  console.log(JSON.stringify({ phase: result.phase, sequence: result.sequence, queueId: result.current?.queueId,
    dispatchId: result.current?.dispatchId, nextAt: result.nextAt || null, completedChunks: result.completedChunks.length }));
}
module.exports = { configuration, serviceName, showUnit, dependencies, step, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
