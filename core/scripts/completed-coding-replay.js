#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { reportDirectory } = require('../src/helpers/offlineReportDirectory');
const corpus = require('../src/services/codingReplayCorpus');

function parseArgs(argv) {
  const options = { dryRun: false, timeoutMs: 600000, outputTokens: 8192, busyWaitMs: 20000, retries: 6 };
  const keys = { '--corpus': 'corpus', '--repo': 'repo', '--out': 'out', '--model': 'model', '--host-url': 'hostUrl',
    '--timeout-ms': 'timeoutMs', '--output-tokens': 'outputTokens', '--busy-wait-ms': 'busyWaitMs', '--retries': 'retries' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    const key = keys[argv[i]], value = argv[++i];
    if (!key || !value || value.startsWith('--')) throw new Error('unknown option or missing value');
    options[key] = value;
  }
  for (const key of ['corpus', 'repo', 'out', 'model', 'hostUrl']) if (!options[key]) throw new Error(`--${key} is required`);
  for (const [key, min, max] of [['timeoutMs', 1000, 900000], ['outputTokens', 1, 131072], ['busyWaitMs', 1000, 60000], ['retries', 0, 100]]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`invalid ${key}`);
  }
  return options;
}

const observed = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function usage(body, calls) {
  const inputTokens = observed(body?.prompt_eval_count), outputTokens = observed(body?.eval_count);
  return { effectiveModel: body?.model || null, modelCalls: calls, inputTokens, outputTokens,
    totalTokens: inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null };
}

function summarize(rows, facts) {
  const verified = rows.filter(row => row.verification?.pass === true).length;
  return { schema: 'agentx.completed-coding-replay/v1', ...facts, attempts: rows.length, verified,
    verifiedPassRate: rows.length ? verified / rows.length : null,
    gate: facts.dryRun ? 'not_run' : facts.stop || rows.length !== facts.tasks ? 'incomplete' : verified === rows.length ? 'pass' : 'fail',
    usage: Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'modelCalls'].map(key => {
      const known = rows.filter(row => row.usage[key] != null);
      return [key, { observedAttempts: known.length, observed: known.length ? known.reduce((n, row) => n + row.usage[key], 0) : null,
        total: rows.length && known.length === rows.length ? known.reduce((n, row) => n + row.usage[key], 0) : null }];
    })), rows };
}

async function run(argv, overrides = {}) {
  const options = parseArgs(argv), out = reportDirectory(options.out);
  const tasks = corpus.loadCorpus(options.corpus, options.repo);
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  save('corpus.json', { schema: corpus.SCHEMA, tasks });
  const rows = [], stopRequested = overrides.stopRequested || (() => false);
  let runtime = null, stop = null, busyWaits = 0;
  try {
    if (!options.dryRun) runtime = await (overrides.open || require('../src/services/offlineCodingInference').open)(options);
    for (const task of tasks) {
      if (options.dryRun || stopRequested()) break;
      const workspace = (overrides.createWorkspace || corpus.createWorkspace)(options.repo, task, path.join(out, 'worktrees', task.pipelineId));
      const started = Date.now();
      let body = null, calls = 0;
      try {
        for (let wait = 0; ; wait++) {
          try { body = await runtime.infer(corpus.messagesForTask(task)); calls = 1; break; }
          catch (error) {
            if (error.replay === 'busy' && wait < options.retries && !stopRequested()) {
              busyWaits++; await (overrides.wait || delay)(options.busyWaitMs); continue;
            }
            // An uncertain request is never resent, nor replaced by another model.
            body = error.body || null;
            calls = error.replay === 'busy' ? 0 : null;
            throw error;
          }
        }
        save(`${task.pipelineId}.response.json`, body);
        const verification = corpus.verifyPatch(workspace, task, body?.message?.content || body?.response,
          overrides.verify || corpus.sandboxVerify);
        rows.push({ pipelineId: task.pipelineId, baseRevision: task.baseRevision, taskFingerprint: task.fingerprint,
          durationMs: Date.now() - started, usage: usage(body, calls), verification });
      } catch (error) {
        stop = { code: error.code || 'REPLAY_STOPPED', detail: error.message };
        rows.push({ pipelineId: task.pipelineId, baseRevision: task.baseRevision, taskFingerprint: task.fingerprint,
          durationMs: Date.now() - started, usage: usage(body, calls), verification: { pass: false, code: stop.code } });
      } finally { workspace.close(); }
      save('attempts.json', rows);
      if (stop || stopRequested()) break;
    }
    if (stopRequested() && !stop) stop = { code: 'INTERRUPTED' };
  } catch (error) {
    stop = { code: error.code || 'REPLAY_SETUP_FAILED', detail: error.message };
    throw error;
  } finally {
    const report = summarize(rows, { generatedAt: new Date().toISOString(), tasks: tasks.length, dryRun: options.dryRun,
      target: runtime?.target || { model: options.model, hostUrl: options.hostUrl }, corpusFingerprint: corpus.digest(tasks.map(task => task.fingerprint)),
      busyWaits, stop });
    save('summary.json', report);
    if (runtime) await runtime.close();
  }
  return JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
}

if (require.main === module) {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopping = true; });
  run(process.argv.slice(2), { stopRequested: () => stopping }).then(report => {
    console.log(`completed=${report.attempts} verified=${report.verified} gate=${report.gate}`);
    if (!['pass', 'not_run'].includes(report.gate)) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => setTimeout(() => process.exit(), 1000).unref());
}

module.exports = { parseArgs, usage, summarize, run };
