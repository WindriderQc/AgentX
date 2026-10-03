#!/usr/bin/env node
/**
 * Offline check for the fast voice lane (#262): replay recent personal voice
 * requests against a light model that has only the `delegate` tool, and compare
 * its decision with whether the recorded turn used agent tools.
 *
 *   node scripts/voice-lane-replay.js --out <dir> [--limit 200] [--dry-run]
 *       [--model <name>] [--host-url <url>] [--task voice_persona_chat]
 *       [--pause-ms 500] [--retries 6] [--busy-wait-ms 20000]
 *
 * Runs in the Core container. Turns are read from MongoDB and every model call
 * goes through Core's admitted inference, never to a model host directly.
 * The report holds private request text: --out must be outside the checkout.
 * Stdout carries counts only.
 */
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const lane = require('../surfaces/household/voice-lane');
const { detectMemoryRequest } = require('../surfaces/household/persona-prompt');
const { forgetMemoryStatement } = require('../surfaces/household/voice-memory-turns');

const SCOPE_ID = 'personal';
const CALLER = 'voice-lane-replay';
const GATE = Object.freeze({ missedDelegation: 0.05, unnecessaryDelegation: 0.15 });
// The conversation before a request: the last exchanges, each side clipped.
const HISTORY_EXCHANGES = 4, HISTORY_CHARS = 600;
const VALUE_OPTIONS = Object.freeze({ '--out': 'out', '--limit': 'limit', '--model': 'model', '--host-url': 'hostUrl',
  '--task': 'task', '--pause-ms': 'pauseMs', '--retries': 'retries', '--busy-wait-ms': 'busyWaitMs' });
const NUMBER_OPTIONS = Object.freeze({ limit: [1, 1000], pauseMs: [0, 60000], retries: [0, 20], busyWaitMs: [1000, 300000] });

function parseArgs(argv) {
  const options = { limit: 200, task: 'voice_persona_chat', pauseMs: 500, retries: 6, busyWaitMs: 20000, dryRun: false };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--dry-run') { options.dryRun = true; continue; }
    if (!Object.hasOwn(VALUE_OPTIONS, name)) throw new Error(`unknown option ${name}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    options[VALUE_OPTIONS[name]] = value;
  }
  for (const [key, [minimum, maximum]] of Object.entries(NUMBER_OPTIONS)) {
    const number = Number(options[key]);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
      throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
    }
    options[key] = number;
  }
  if (!options.out) throw new Error('--out <dir> is required; choose a directory outside the checkout');
  return options;
}

// Resolves links on the part of a path that exists, so a link cannot hide where it lands.
function realPath(target) {
  const missing = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current) && path.dirname(current) !== current) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync.native(current), ...missing);
}

// The report holds private text: never inside the application tree or a Git checkout.
function reportDirectory(out, { appRoot = path.resolve(__dirname, '..') } = {}) {
  const target = realPath(out);
  const relative = path.relative(realPath(appRoot), target);
  const refuse = () => new Error('--out must be outside the checkout and the application directory: the report holds private request text');
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw refuse();
  for (let directory = target; ; directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, '.git'))) throw refuse();
    if (path.dirname(directory) === directory) break;
  }
  if (fs.existsSync(path.join(target, 'summary.json'))) throw new Error('--out already holds a report; choose a new directory');
  return target;
}

const timeOf = value => new Date(value || 0).getTime();

// Why a recorded turn says nothing about the lane's decision.
function skipReason(turn, text) {
  if (turn.interrupted === true) return 'interrupted';
  if (turn.routeTier === 'deterministic' || (!turn.model && !turn.routeTier)) return 'deterministic';
  if (turn.modeId === 'open') return 'open_mode';
  if (turn.speakerAgentId) return 'team_member';
  if (turn.toolEvidence?.status !== 'observed') return 'no_tool_evidence';
  return text ? '' : 'empty_request';
}

// Each voice turn with the exchanges recorded before it in its conversation,
// as the lane would receive them: a follow-up such as "yes, go ahead" can only
// be judged with what came before.
function sessionTurns(row) {
  const requests = new Map();
  for (const message of row.messages || []) {
    if (message.role === 'user' && message.turnId) requests.set(message.turnId, message.content);
  }
  const clip = value => String(value || '').trim().slice(0, HISTORY_CHARS);
  const turns = [], exchanges = [];
  for (const message of row.messages || []) {
    if (!message.turn) continue;
    const text = String(requests.get(message.turnId) || '').trim();
    if (message.turn.channel === 'voice' && message.turn.packId === lane.LANE_PACK_ID && message.turn.scopeId === SCOPE_ID) {
      turns.push({ turn: message.turn, text, identity: row.surfaceSession?.persona?.identity || '',
        history: exchanges.slice(-HISTORY_EXCHANGES).flat() });
    }
    if (text && clip(message.content)) {
      exchanges.push([{ role: 'user', content: clip(text) }, { role: 'assistant', content: clip(message.content) }]);
    }
  }
  return turns;
}

// `sessions` yields conversations newest first. Returns the most recent usable turns.
async function collectTurns(sessions, limit) {
  const kept = [];
  const skipped = {};
  let scanned = 0;
  for await (const row of sessions) {
    if (!row) continue;
    // Once the sample is full, a conversation that ended before its oldest turn adds nothing.
    if (kept.length >= limit && timeOf(row.surfaceSession?.lastTurnAt) < kept[limit - 1].at) break;
    for (const { turn, text, identity, history } of sessionTurns(row)) {
      scanned += 1;
      const reason = skipReason(turn, text);
      if (reason) { skipped[reason] = (skipped[reason] || 0) + 1; continue; }
      const tools = [...new Set((turn.toolEvidence.receipts || []).map(receipt => receipt?.tool).filter(Boolean))];
      kept.push({ at: timeOf(turn.createdAt), text, modeId: turn.modeId || '', identity, tools, history,
        memoryCommand: detectMemoryRequest(text) || Boolean(forgetMemoryStatement(text)) });
    }
    kept.sort((left, right) => right.at - left.at);
  }
  return { turns: kept.slice(0, limit), scanned, skipped };
}

// `infer(messages)` resolves with a chat body or rejects; `error.replay` is
// 'busy' (refused before dispatch: wait and retry) or 'stop' (retrying cannot help).
// A request that may have reached the model is never sent twice.
async function replay({ turns, infer, pauseMs = 0, retries = 0, busyWaitMs = 0, wait = delay, stopRequested = () => false, onProgress = () => {} }) {
  const rows = [];
  let stop = null, busyWaits = 0, failuresInARow = 0;
  for (const [index, turn] of turns.entries()) {
    if (stopRequested()) { stop = { code: 'INTERRUPTED' }; break; }
    if (index && pauseMs) await wait(pauseMs);
    const messages = [
      { role: 'system', content: lane.fastLaneSystemPrompt({ modeId: turn.modeId, identity: turn.identity }) },
      ...(turn.history || []),
      { role: 'user', content: turn.text }
    ];
    let body = null, failure = null;
    for (let attempt = 0; ; attempt++) {
      try { body = await infer(messages); break; } catch (error) {
        if (error.replay === 'busy' && attempt < retries && !stopRequested()) { busyWaits += 1; await wait(busyWaitMs); continue; }
        failure = error;
        break;
      }
    }
    if (failure) {
      const code = String(failure.code || 'INFERENCE_FAILED');
      if (failure.replay) { stop = { code, detail: String(failure.message || '').slice(0, 300) }; break; }
      rows.push({ ...turn, decision: 'error', code });
      if (++failuresInARow >= 3) { stop = { code: 'REPEATED_FAILURES' }; break; }
      continue;
    }
    failuresInARow = 0;
    rows.push({ ...turn, ...lane.laneDecision(body) });
    onProgress(rows.length);
  }
  return { rows, stop, busyWaits };
}

const emptyCell = () => ({ delegated: 0, answered: 0, malformed: 0 });
const cellTotal = cell => cell.delegated + cell.answered + cell.malformed;
const tally = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };

function gateLine(count, of, max) {
  const rate = of ? count / of : null;
  return { count, of, rate, max, pass: rate === null ? null : rate <= max };
}

function summarize(rows, facts = {}) {
  const matrix = { recordedTools: emptyCell(), recordedNone: emptyCell() };
  const memoryCommands = { total: 0, ...emptyCell() };
  const delegateReasons = {}, problems = {}, errorCodes = {}, recordedTools = {}, missedByTool = {};
  for (const row of rows) {
    if (row.decision === 'error') { tally(errorCodes, row.code); continue; }
    matrix[row.tools.length ? 'recordedTools' : 'recordedNone'][row.decision] += 1;
    row.tools.forEach(tool => tally(recordedTools, tool));
    if (row.reason) tally(delegateReasons, row.reason);
    if (row.problem) tally(problems, row.problem);
    if (row.memoryCommand) { memoryCommands.total += 1; memoryCommands[row.decision] += 1; }
    if (row.tools.length && row.decision === 'answered') row.tools.forEach(tool => tally(missedByTool, tool));
  }
  // An unusable answer is handed to the agent, so it counts as a delegation.
  const missed = gateLine(matrix.recordedTools.answered, cellTotal(matrix.recordedTools), GATE.missedDelegation);
  const unnecessary = gateLine(matrix.recordedNone.delegated + matrix.recordedNone.malformed,
    cellTotal(matrix.recordedNone), GATE.unnecessaryDelegation);
  const verdict = missed.pass === null || unnecessary.pass === null ? 'insufficient_data'
    : missed.pass && unnecessary.pass ? 'pass' : 'fail';
  return { schema: 'agentx.voice-lane-replay/v1', ...facts,
    replayed: cellTotal(matrix.recordedTools) + cellTotal(matrix.recordedNone),
    errors: Object.values(errorCodes).reduce((sum, count) => sum + count, 0), errorCodes,
    matrix, gate: { missedDelegation: missed, unnecessaryDelegation: unnecessary, verdict },
    delegateReasons, problems, memoryCommands, recordedTools, missedByTool };
}

// Up to `max` rows for the owner to judge, alternating between the kinds.
function disagreements(rows, max = 25) {
  const cut = (value, length) => String(value || '').slice(0, length);
  const groups = [
    rows.filter(row => row.tools.length && row.decision === 'answered').map(row => ({ kind: 'missed_delegation', row })),
    rows.filter(row => !row.tools.length && row.decision === 'delegated').map(row => ({ kind: 'unnecessary_delegation', row })),
    rows.filter(row => row.decision === 'malformed').map(row => ({ kind: 'malformed', row }))
  ];
  const picked = [];
  for (let index = 0; picked.length < max && groups.some(group => index < group.length); index++) {
    for (const group of groups) if (index < group.length && picked.length < max) picked.push(group[index]);
  }
  return picked.map(({ kind, row }) => ({ kind, request: row.text, recordedTools: row.tools, decision: row.decision,
    ...(row.reason ? { reason: row.reason } : {}), ...(row.task ? { task: cut(row.task, 400) } : {}),
    ...(row.problem ? { problem: row.problem } : {}), ...(row.answer ? { answer: cut(row.answer, 400) } : {}) }));
}

const percent = rate => rate === null ? 'n/a' : `${(rate * 100).toFixed(1)} %`;
const gateText = line => `${line.count} / ${line.of} (${percent(line.rate)})`;
const passText = line => line.pass === null ? 'no data' : line.pass ? 'pass' : 'fail';

function renderMarkdown(summary) {
  const { matrix, gate } = summary;
  const row = (label, cell) => `| ${label} | ${cell.delegated} | ${cell.answered} | ${cell.malformed} | ${cellTotal(cell)} |`;
  const counts = values => Object.entries(values).map(([key, count]) => `${key} ${count}`).join(', ') || 'none';
  return [
    '# Fast voice lane replay', '',
    `- Model: \`${summary.target?.model || 'n/a'}\` on host \`${summary.target?.hostKey || summary.target?.hostUrl || 'n/a'}\` (${summary.target?.source || 'n/a'})`,
    `- Sample: ${summary.sampled} personal voice requests, ${summary.sampledWithTools} whose recorded turn used agent tools; ${summary.scanned} voice turns scanned; skipped: ${counts(summary.skipped || {})}`,
    `- Replayed: ${summary.replayed}; inference errors: ${summary.errors}${summary.dryRun ? '; dry run, no inference' : ''}${summary.stop ? `; stopped early (${summary.stop.code}): partial result` : ''}`,
    '', '## Decisions', '',
    '| Recorded turn | Delegated | Answered itself | Malformed | Total |', '|---|---|---|---|---|',
    row('Used agent tools', matrix.recordedTools), row('Used no tool', matrix.recordedNone),
    '', '## Gate', '',
    '| Measure | Result | Limit | Verdict |', '|---|---|---|---|',
    `| Missed delegations: tools were recorded, the model answered itself | ${gateText(gate.missedDelegation)} | at most ${percent(gate.missedDelegation.max)} | ${passText(gate.missedDelegation)} |`,
    `| Unnecessary delegations: no tool was recorded, the model delegated or gave a malformed answer | ${gateText(gate.unnecessaryDelegation)} | at most ${percent(gate.unnecessaryDelegation.max)} | ${passText(gate.unnecessaryDelegation)} |`,
    '', `Verdict: **${gate.verdict}**`,
    '', '## Details', '',
    `- Delegate reasons: ${counts(summary.delegateReasons)}`,
    `- Malformed or invalid answers: ${counts(summary.problems)}`,
    `- Requests Core's remember/forget detectors match: ${summary.memoryCommands.total} (delegated ${summary.memoryCommands.delegated}, answered ${summary.memoryCommands.answered}, malformed ${summary.memoryCommands.malformed})`,
    `- Recorded tools in the sample: ${counts(summary.recordedTools)}`,
    `- Recorded tools of missed delegations: ${counts(summary.missedByTool)}`,
    '', '## Reading this report', '',
    '- Recorded tool use is a weak label: the agent may have used a tool it did not need, or answered without one it should have used. The owner judges the sample in `disagreements.jsonl`.',
    '- Each request is replayed after the last exchanges of its conversation (clipped), without notes or knowledge, so a request that leaned on those can look like a wrong decision here.',
    '- A malformed answer (empty, another tool, a tool call written as text) counts as a delegation: the lane hands an unusable answer to the agent.',
    '- These files hold private request text. Keep them outside Git.', ''
  ].join('\n');
}

function writeReport(directory, summary, rows) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const write = (name, text) => fs.writeFileSync(path.join(directory, name), text, { mode: 0o600, flag: 'wx' });
  write('summary.json', JSON.stringify(summary, null, 2) + '\n');
  write('summary.md', renderMarkdown(summary));
  write('disagreements.jsonl', disagreements(rows).map(row => JSON.stringify(row) + '\n').join(''));
}

function printAggregates(summary, directory, log) {
  const { matrix, gate } = summary;
  const cell = value => `delegated ${value.delegated}, answered ${value.answered}, malformed ${value.malformed}`;
  log(`sample: ${summary.sampled} requests (${summary.sampledWithTools} with recorded tools), ${summary.scanned} voice turns scanned`);
  if (!summary.dryRun) {
    log(`replayed: ${summary.replayed}, inference errors: ${summary.errors}${summary.stop ? `, stopped early (${summary.stop.code})` : ''}`);
    log(`recorded tools -> ${cell(matrix.recordedTools)}`);
    log(`recorded none  -> ${cell(matrix.recordedNone)}`);
    log(`missed delegations: ${gateText(gate.missedDelegation)}, limit ${percent(gate.missedDelegation.max)}`);
    log(`unnecessary delegations: ${gateText(gate.unnecessaryDelegation)}, limit ${percent(gate.unnecessaryDelegation.max)}`);
    log(`verdict: ${gate.verdict}`);
  }
  log(`report: ${directory}`);
}

// Dependencies are injected so the whole run is testable without MongoDB or inference.
async function run(argv, { open, log = console.log, stopRequested = () => false, wait = delay } = {}) {
  const options = parseArgs(argv);
  const directory = reportDirectory(options.out);
  const runtime = await open(options);
  try {
    const target = await runtime.target();
    const { turns, scanned, skipped } = await collectTurns(runtime.sessions(), options.limit);
    const facts = { createdAt: new Date().toISOString(), dryRun: options.dryRun, target, limit: options.limit, scanned, skipped,
      sampled: turns.length, sampledWithTools: turns.filter(turn => turn.tools.length).length,
      newest: turns.length ? new Date(turns[0].at).toISOString() : null,
      oldest: turns.length ? new Date(turns.at(-1).at).toISOString() : null };
    const outcome = options.dryRun ? { rows: [], stop: null, busyWaits: 0 } : await replay({ turns, infer: runtime.infer,
      pauseMs: options.pauseMs, retries: options.retries, busyWaitMs: options.busyWaitMs, wait, stopRequested,
      onProgress: done => { if (done % 20 === 0) log(`replayed ${done}/${turns.length}`); } });
    const summary = summarize(outcome.rows, { ...facts, busyWaits: outcome.busyWaits, stop: outcome.stop });
    writeReport(directory, summary, outcome.rows);
    printAggregates(summary, directory, log);
    return summary;
  } finally {
    await runtime.close();
  }
}

// The live wiring: MongoDB for the recorded turns, Core's trusted runtime
// services (admission, claims, runtime coordination, telemetry) for inference.
async function openCore(options) {
  require('dotenv').config({ quiet: true });
  // Core services keep writing to their log files; stdout stays this script's counts.
  for (const transport of require('../config/logger').transports) if (transport.name === 'console') transport.silent = true;
  const mongoose = require('mongoose');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx');
  const conversations = mongoose.connection.db.collection('conversations');
  let target = null, inference = null;
  async function resolveTarget() {
    if (target) return target;
    // Same order as Core's start: registered hosts, then routing overrides and pins.
    await require('../src/services/inferenceHostRegistry').load();
    const router = require('../src/services/modelRouterConfig');
    await router.ensureTaskModelOverridesLoaded({ force: true });
    await router.refreshPinCache();
    let { model, hostUrl } = options, source = 'arguments';
    if (!model) {
      if (!Object.hasOwn(router.TASK_MODELS, options.task)) throw new Error(`unknown router task ${options.task}`);
      const routed = router.getModelForTask(options.task);
      model = routed.model; hostUrl = hostUrl || routed.url; source = `task:${options.task}`;
    }
    hostUrl = hostUrl || router.lookupPinnedHost(String(model || '').trim());
    if (!model || !hostUrl) throw new Error('no host has this model pinned; pass --host-url');
    const check = require('../src/helpers/ollamaHostConfig').validateHostUrl(hostUrl);
    if (!check.valid) throw new Error(check.message || 'the inference host is not configured');
    // Only a model that host keeps resident: loading another one would displace its pins.
    const hostPreferences = require('../src/services/hostPreferenceService');
    const { modelsMatch } = require('../src/helpers/modelNameNormalization');
    const pins = hostPreferences.getPinnedModelNames(await hostPreferences.getByHost(check.host));
    if (!pins.some(pin => modelsMatch(pin, model))) throw new Error('the model is not pinned on that host; pin it or choose a pinned model');
    target ={ model, hostUrl: check.host, hostKey: require('../src/services/modelRouter').resolveHostKey(check.host), source };
    return target;
  }
  return {
    async *sessions() {
      const filter = { surface: 'household', 'surfaceSession.deletedAt': { $exists: false },
        'surfaceSession.packId': lane.LANE_PACK_ID, 'surfaceSession.scopeId': SCOPE_ID,
        messages: { $elemMatch: { 'turn.channel': 'voice' } } };
      const index = await conversations.find(filter, { projection: { 'surfaceSession.lastTurnAt': 1 } }).toArray();
      index.sort((left, right) => timeOf(right.surfaceSession?.lastTurnAt) - timeOf(left.surfaceSession?.lastTurnAt));
      const fields = ['channel', 'packId', 'scopeId', 'modeId', 'interrupted', 'routeTier', 'model', 'createdAt',
        'speakerAgentId', 'toolEvidence.status', 'toolEvidence.receipts.tool'];
      const projection = { 'surfaceSession.lastTurnAt': 1, 'surfaceSession.persona.identity': 1,
        'messages.role': 1, 'messages.content': 1, 'messages.turnId': 1,
        ...Object.fromEntries(fields.map(field => [`messages.turn.${field}`, 1])) };
      // One conversation at a time: the caller stops reading once its sample is full.
      for (const { _id } of index) yield await conversations.findOne({ _id }, { projection });
    },
    target: resolveTarget,
    async infer(messages) {
      const { model, hostUrl } = await resolveTarget();
      inference = inference || require('../src/extensions/trustedRuntimeServices').createTrustedRuntimeServices().inference;
      const { refusedBeforeDispatch } = require('../src/services/routing/taskFallbackLadder');
      let result;
      try {
        result = await inference.execute({ mode: 'chat', model, messages, tools: [lane.delegateTool()], stream: false,
          think: false, temperature: 0, max_tokens: 400, callerDetail: CALLER, timeoutMs: 300000 },
        { hostUrl, consumerContract: CALLER });
      } catch (error) {
        const code = error.code || 'INFERENCE_FAILED';
        const replayState = code === 'RUNTIME_INFERENCE_RECOVERY_REQUIRED' || error.statusCode === 400 ? 'stop'
          : refusedBeforeDispatch(error) ? 'busy' : undefined;
        throw Object.assign(new Error(error.message), { code, replay: replayState });
      }
      if (result?.ok) return result.body;
      // A rejected request (unknown model, no tool support) fails the same way for every row.
      const status = Number(result?.status) || 502;
      throw Object.assign(new Error(String(result?.body?.error?.message || result?.body?.error || 'inference failed')),
        { code: `UPSTREAM_HTTP_${status}`, replay: status >= 400 && status < 500 ? 'stop' : undefined });
    },
    async close() {
      // Core records each inference after answering; let the last record land.
      if (inference) await delay(500);
      await mongoose.disconnect();
    }
  };
}

async function main() {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      // The request in flight is left to finish: cutting it would fence its host.
      console.log(stopping ? 'still waiting for the request in flight' : 'stopping after the request in flight; the partial report will be written');
      stopping = true;
    });
  }
  const summary = await run(process.argv.slice(2), { open: openCore, stopRequested: () => stopping });
  if (summary.stop) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; })
    // Core services keep timers; leave once the report is written.
    .finally(() => setTimeout(() => process.exit(), 1000).unref());
}

module.exports = { GATE, parseArgs, reportDirectory, skipReason, collectTurns, replay, summarize, disagreements, renderMarkdown, run };
