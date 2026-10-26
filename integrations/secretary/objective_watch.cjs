#!/usr/bin/env node
'use strict';

// Durable controller observation, not a scheduler or model client. Every
// effect still goes through objective_campaign's existing Core queue step.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const campaign = require('./objective_campaign.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function durable(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`, fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function options(config, value) {
  campaign.configuration(config);
  if (typeof value.until !== 'string' || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value.until) ||
      !Number.isFinite(Date.parse(value.until)) || Date.parse(value.until) > Date.parse(config.startBefore)) {
    throw new Error('Watch needs an explicit admission deadline no later than campaign startBefore');
  }
  const pollSeconds = value.pollSeconds ?? 30;
  if (!Number.isInteger(pollSeconds) || pollSeconds < 15 || pollSeconds > 60) throw new Error('Poll every 15 to 60 seconds');
  return { until: new Date(value.until).toISOString(), pollSeconds };
}
function watchHome(config) {
  const objective = read(config.objectiveFile);
  const root = config.archiveRoot || path.join(os.homedir(), '.local/share/agentx/secretary-evidence');
  return path.join(root, 'objective-reviews', objective.id, objective.version, 'campaigns', config.id);
}
function lock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = read(file);
    if (prior.host !== os.hostname()) throw new Error('Another native host owns this watcher');
    try { process.kill(prior.pid, 0); throw new Error('Another native watcher is still active'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(file); // Dead observer only; never a queue or inference fence.
    return lock(file);
  }
  fs.writeFileSync(fd, JSON.stringify({ host: os.hostname(), pid: process.pid })); fs.fsyncSync(fd);
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}
async function watch(config, supplied, deps = {}) {
  const controls = options(config, supplied), home = watchHome(config);
  const unlock = lock(path.join(home, 'watcher.lock'));
  const now = deps.now || (() => new Date());
  const wait = deps.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const runStep = deps.step || ((value, flags) => campaign.step(value, undefined, flags));
  const stopRequested = deps.stopRequested || (() => false);
  const onProgress = deps.onProgress || (() => {});
  const startedAt = now().toISOString();
  const watchId = createHash('sha256').update(JSON.stringify({ config, ...controls })).digest('hex');
  let iterations = 0, state;
  const record = (phase, extra = {}) => {
    const status = { schema: 'secretary.objective-watch/v1', watchId, startedAt, at: now().toISOString(),
      phase, admissionDeadline: controls.until, pollSeconds: controls.pollSeconds, iterations,
      queueId: state?.current?.queueId || null, dispatchId: state?.current?.dispatchId || null,
      completedChunks: state?.completedChunks?.length || 0, userConfirmed: false, ...extra };
    durable(path.join(home, 'watch-status.json'), status); onProgress(status); return status;
  };
  try {
    for (;;) {
      const deadline = now().getTime() >= Date.parse(controls.until);
      const signalled = stopRequested();
      state = await runStep(config, { allowStart: !deadline && !signalled,
        stopReason: signalled ? 'Operator requested graceful controller stop' : 'Explicit controller admission deadline reached' });
      iterations++;
      if (['uncertain', 'needs-source-review', 'queue-submission-unconfirmed'].includes(state.phase)) {
        return record('stopped-for-review', { nativePhase: state.phase, exitCode: 2 });
      }
      if (['text-scope-complete', 'controller-drained'].includes(state.phase)) return record(state.phase, { exitCode: 0 });
      record(deadline || signalled ? 'draining' : state.phase);
      await wait(controls.pollSeconds * 1000);
    }
  } catch (error) {
    record('stopped-on-error', { errorType: error.name, message: String(error.message).slice(0, 2000), exitCode: 1 });
    throw error;
  } finally { unlock(); }
}
async function main(argv = process.argv.slice(2)) {
  const flags = {};
  while (argv.length) {
    const name = argv.shift();
    if (!['--config', '--until', '--poll-seconds'].includes(name) || !argv.length || Object.hasOwn(flags, name)) throw new Error('Use watch --config <private.json> --until <ISO deadline> [--poll-seconds 30]');
    flags[name] = argv.shift();
  }
  if (!flags['--config']) throw new Error('A private campaign config is required');
  let stopping = false;
  const signal = () => { stopping = true; };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  try {
    const result = await watch(read(flags['--config']), { until: flags['--until'],
      pollSeconds: flags['--poll-seconds'] === undefined ? 30 : Number(flags['--poll-seconds']) }, {
      stopRequested: () => stopping,
      onProgress: row => console.log(JSON.stringify({ phase: row.phase, at: row.at, queueId: row.queueId,
        completedChunks: row.completedChunks, exitCode: row.exitCode })) });
    process.exitCode = result.exitCode;
    return result;
  } finally { process.off('SIGTERM', signal); process.off('SIGINT', signal); }
}
module.exports = { options, watchHome, watch, main };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
