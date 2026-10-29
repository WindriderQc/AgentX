'use strict';

/**
 * Île tab (docs/ISLAND.md): island runs of the Clawblox free-play experiment.
 *
 * Reads join two sources: Core's heavy-work queue (the authority for each
 * request's state, slot and release receipt) and the run records the queue
 * CLI reports here (runner phase, resumes, recording, memory). "Lancer" only
 * records a queue request, and optionally asks Core to place its slot; the
 * owner's approval and Core's admission still govern the start.
 */

const IslandRun = require('../../../models/IslandRun');
const { islandExecutor, islandEstimatedMinutes, PRINCIPAL_ALIAS } = require('../../../../shared/islandRun.cjs');
const { islandViews } = require('./islandViews');

const SOURCE_REF = 'benchmark-island-tab';
const UUID = /^[a-f0-9-]{36}$/;
const MEMORY_KEYS = Object.freeze({ 'SOUL.md': 'soul', 'EPISODIC_MEMORY.jsonl': 'episodic', 'SEMANTIC_MEMORY.md': 'semantic' });
const MAX_MEMORY_TEXT = 256 * 1024;
const START_WINDOW_HOURS = 48;
const AGENT_MESSAGES = 40;
const AGENT_KINDS = new Set(['thought', 'say', 'command']);

class IslandError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

function defaults(deps = {}) {
  const heavy = () => require('../../clients/coreHeavyQueue');
  return {
    queue: deps.queue || (() => heavy().listHeavyWork()),
    submit: deps.submit || (request => heavy().submitHeavyWork(request)),
    place: deps.place || ((id, body) => heavy().placeHeavyWork(id, body)),
    principalEndpoint: deps.principalEndpoint || (() => heavy().readPrincipalEndpoint()),
    fetchImpl: deps.fetchImpl || fetch,
    env: deps.env || process.env,
    now: deps.now || (() => new Date())
  };
}

function text(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function isIsland(job) {
  return job?.kind === 'other' && job.executor?.mode === 'island';
}

function queueView(job) {
  if (!job) return null;
  return {
    state: job.state, revision: job.revision, title: job.title, estimatedMinutes: job.estimatedMinutes,
    reservation: job.reservation ? { start: job.reservation.start, end: job.reservation.end } : null,
    dispatchedAt: job.dispatchedAt || null, finishedAt: job.finishedAt || null, reason: job.reason || null,
    releaseReceipt: job.releaseReceipt || null, presentation: job.presentation || null,
    createdAt: job.createdAt || null
  };
}

function runRow(doc, job, view) {
  const executor = job?.executor || {};
  const liveView = doc ? view.liveUrl(doc) : null;
  return {
    id: doc?._id || job.id,
    title: doc?.title || job?.title || null,
    agent: doc?.agent || executor.agent || null,
    minutes: doc?.minutes ?? executor.minutes ?? null,
    memoryMode: doc?.memoryMode || executor.memory || null,
    world: doc?.world || executor.world || null,
    model: doc?.model || PRINCIPAL_ALIAS,
    runner: doc?.runner || null,
    phase: doc?.phase || null,
    outcome: doc?.outcome || null,
    requestedAt: doc?.requestedAt || job?.createdAt || null,
    startedAt: doc?.startedAt || null,
    endedAt: doc?.endedAt || null,
    timeZone: doc?.timeZone || null,
    resumeCount: doc?.resumeCount || 0,
    liveView,
    replayable: Boolean(doc?.recording && view.available().replay),
    hasMemory: Boolean(doc?.memory),
    receipt: doc?.receipt || null,
    queue: queueView(job),
    updatedAt: doc?.updatedAt || job?.updatedAt || null
  };
}

async function readQueue(d) {
  try {
    const current = await d.queue();
    return { read: true, jobs: (current?.jobs || []).filter(isIsland) };
  } catch {
    return { read: false, jobs: [] };
  }
}

/** Every island run: recorded runs and island requests still in Core's queue. */
async function listRuns(deps = {}) {
  const d = defaults(deps);
  const view = islandViews(d.env);
  const [docs, queue] = await Promise.all([
    // Memory sizes stay so the row knows a memory exists; the texts do not.
    IslandRun.find({}).select('-events -agentMessages -memory.soul.text -memory.episodic.text -memory.semantic.text')
      .sort({ createdAt: -1 }).limit(200).lean(),
    readQueue(d)
  ]);
  const jobs = new Map(queue.jobs.map(job => [job.id, job]));
  const rows = docs.map(doc => runRow(doc, jobs.get(doc._id), view));
  for (const job of queue.jobs) if (!docs.some(doc => doc._id === job.id)) rows.push(runRow(null, job, view));
  rows.sort((a, b) => String(b.startedAt || b.requestedAt || '').localeCompare(String(a.startedAt || a.requestedAt || '')));
  return { queueRead: queue.read, view: view.available(), runs: rows };
}

async function getRun(id, deps = {}) {
  if (!UUID.test(id || '')) throw new IslandError('Run id needs a queue request id');
  const d = defaults(deps);
  const [doc, queue] = await Promise.all([
    IslandRun.findById(id).select('-memory.soul.text -memory.episodic.text -memory.semantic.text').lean(), readQueue(d)]);
  const job = queue.jobs.find(item => item.id === id);
  if (!doc && !job) throw new IslandError('No island run with this id', 404);
  return { ...runRow(doc, job, islandViews(d.env)), events: doc?.events || [], agentMessages: doc?.agentMessages || [],
    queueRead: queue.read };
}

/** The memory files a run left, and the agent's other runs that have some. */
async function getMemory(id) {
  if (!UUID.test(id || '')) throw new IslandError('Run id needs a queue request id');
  const doc = await IslandRun.findById(id).select('agent memory endedAt timeZone').lean();
  if (!doc) throw new IslandError('No island run with this id', 404);
  const runs = await IslandRun.find({ agent: doc.agent, memory: { $ne: null } })
    .select('_id startedAt endedAt timeZone memoryMode').sort({ createdAt: 1 }).lean();
  const files = Object.fromEntries(Object.entries(MEMORY_KEYS).map(([name, key]) => [name, doc.memory?.[key] || null]));
  return { id, agent: doc.agent, files, runs: runs.map(run => ({ id: run._id, startedAt: run.startedAt || null,
    endedAt: run.endedAt || null, timeZone: run.timeZone || null, memoryMode: run.memoryMode || null })) };
}

function cleanMemory(files) {
  if (!files || typeof files !== 'object') return undefined;
  const memory = {};
  for (const [name, key] of Object.entries(MEMORY_KEYS)) {
    const file = files[name];
    if (!file || typeof file.text !== 'string') continue;
    memory[key] = { bytes: Number(file.bytes) || file.text.length, truncated: file.truncated === true || file.text.length > MAX_MEMORY_TEXT,
      text: file.text.slice(-MAX_MEMORY_TEXT) };
  }
  return memory;
}

/**
 * A report from the queue CLI that runs this request. Only typed fields are
 * kept; a report for another dispatch of the same request is refused.
 */
async function recordReport(id, body = {}) {
  if (!UUID.test(id || '') || body.queueRequestId !== id) throw new IslandError('Report needs its queue request id');
  if (!UUID.test(body.dispatchId || '')) throw new IslandError('Report needs its dispatch id');
  let executor;
  try { executor = islandExecutor(body.executor); } catch (error) { throw new IslandError(error.message); }
  const existing = await IslandRun.findById(id).select('dispatchId').lean();
  if (existing?.dispatchId && existing.dispatchId !== body.dispatchId) throw new IslandError('This run already belongs to another dispatch', 409);
  const status = body.status && typeof body.status === 'object' ? body.status : {};
  const set = {
    dispatchId: body.dispatchId, agent: executor.agent, minutes: executor.minutes, memoryMode: executor.memory, world: executor.world,
    model: status.model === 'netcheck' ? 'netcheck' : PRINCIPAL_ALIAS,
    runner: text(body.runner, 120), reportedAt: new Date()
  };
  for (const key of ['phase', 'outcome', 'requestedAt', 'startedAt', 'endedAt', 'timeZone', 'memorySource']) {
    const value = text(status[key]);
    if (value !== undefined) set[key] = value;
  }
  if (typeof status.recording === 'string' && /^[a-f0-9-]{36}\/recordings\/[\w.-]+\.clawrec$/.test(status.recording)) set.recording = status.recording;
  if (Number.isInteger(status.resumeCount)) set.resumeCount = status.resumeCount;
  if (Array.isArray(status.events)) {
    set.events = status.events.slice(-200).map(event => ({ at: text(event?.at, 40), event: text(event?.event, 60),
      reason: text(event?.reason), error: text(event?.error) }));
  }
  if (Array.isArray(status.agentMessages)) {
    set.agentMessages = status.agentMessages.slice(-AGENT_MESSAGES)
      .map(entry => ({ at: text(entry?.at, 40) || '', kind: entry?.kind, text: text(entry?.text, 600) }))
      .filter(entry => AGENT_KINDS.has(entry.kind) && entry.text);
  }
  const live = status.liveView;
  set.liveView = live && Number.isInteger(live.port) && live.port > 0 && live.port < 65536 && typeof live.path === 'string' && live.path.startsWith('/')
    ? { port: live.port, path: live.path.slice(0, 500) } : null;
  const memory = cleanMemory(body.memory);
  if (memory) set.memory = memory;
  const receipt = body.receipt;
  if (receipt && /^[a-f0-9]{64}$/.test(receipt.sha256 || '')) {
    set.receipt = { file: text(receipt.file), sha256: receipt.sha256, state: text(receipt.state, 20), runtimeReleased: receipt.runtimeReleased === true };
  }
  await IslandRun.updateOne({ _id: id }, { $set: set, $setOnInsert: { title: `Île — ${executor.agent}, ${executor.minutes} min` } }, { upsert: true });
  return { id, saved: true };
}

/**
 * "Lancer": record one island request in Core's queue (its hosts are the
 * principal endpoint) and, if asked, let Core place its slot. Nothing starts.
 */
async function launch(input = {}, deps = {}) {
  const d = defaults(deps);
  if (!UUID.test(input.clientKey || '')) throw new IslandError('clientKey needs a UUID (one per click)');
  const when = input.when === undefined ? 'tonight' : input.when;
  if (!['tonight', 'asap', 'none'].includes(when)) throw new IslandError('when needs tonight, asap or none');
  const key = `island:${input.clientKey}`;
  let executor;
  try {
    executor = islandExecutor({ mode: 'island', receiptRef: `island/${input.clientKey}.json`, agent: input.agent,
      minutes: Number(input.minutes), memory: input.memory, world: input.world });
  } catch (error) { throw new IslandError(error.message); }
  const principal = await d.principalEndpoint();
  if (!principal) throw new IslandError('Core does not name a principal endpoint; nothing was recorded', 409);
  const now = d.now();
  const request = {
    key, title: `Île — ${executor.agent}, ${executor.minutes} min (${executor.memory === 'fresh' ? 'mémoire neuve' : 'mémoire continue'})`,
    kind: 'other', hosts: [principal], estimatedMinutes: islandEstimatedMinutes(executor.minutes),
    startBefore: new Date(now.getTime() + START_WINDOW_HOURS * 3600000).toISOString(),
    source: { type: 'operator', ref: SOURCE_REF }, executor
  };
  const job = await d.submit(request);
  if (!job?.id) throw new IslandError('Core returned no request', 502);
  await IslandRun.updateOne({ _id: job.id }, { $setOnInsert: { title: request.title, agent: executor.agent, minutes: executor.minutes,
    memoryMode: executor.memory, world: executor.world, model: PRINCIPAL_ALIAS, phase: 'queued', requestedAt: now.toISOString() } }, { upsert: true });
  let placed = null;
  let note = when === 'none' ? 'Recorded without a slot; plan it in Automations → Calendar.' : null;
  if (when !== 'none' && job.state === 'requested') {
    try {
      const reserved = await d.place(job.id, { expectedRevision: job.revision, when });
      placed = reserved?.reservation ? { start: reserved.reservation.start, end: reserved.reservation.end } : null;
    } catch (error) {
      note = `Recorded; Core did not place a slot yet: ${error.message}`;
    }
  }
  return { id: job.id, state: placed ? 'reserved' : job.state, placed, note,
    next: 'The start still waits for the owner (island-watch or run on the operator host) and Core admission.' };
}

/** Open a run's recording through the configured renderer (islandViews.js). */
async function openReplay(id, deps = {}) {
  const d = defaults(deps);
  if (!UUID.test(id || '')) throw new IslandError('Run id needs a queue request id');
  const doc = await IslandRun.findById(id).select('recording phase agent').lean();
  return islandViews(d.env).replayUrl(doc, { fetchImpl: d.fetchImpl });
}

module.exports = { IslandError, SOURCE_REF, listRuns, getRun, getMemory, recordReport, launch, openReplay };
