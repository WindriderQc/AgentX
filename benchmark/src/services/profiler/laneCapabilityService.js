'use strict';

/**
 * Reads lane capability profiles (#832). A lane is one model on one host, as
 * pinned there or named by the task routing table (the coverage scope). Each
 * lane's profile is built only from evidence for its exact installed artifact
 * and runtime; nothing here starts a model or a measurement.
 */

const { buildLaneCapability } = require('./laneCapability');
const { resolveScope } = require('../measurementCoverage/coverageScope');
const { resolveArtifactIdentity } = require('./artifactIdentityService');
const contextProfiles = require('../modelContextProfileService');
const performanceProfiles = require('./modelPerformanceProfileService');
const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { planNight, machineOf } = require('./laneCampaignPlan');

const CONCURRENCY = 4;
// A Full profile with quality and agent workload probes on a 27B Q8 model.
const FULL_PROFILE_MINUTES = 180;

function defaults(deps = {}) {
  return {
    scope: deps.scope || resolveScope,
    hosts: deps.hosts || getConfiguredHosts,
    identity: deps.identity || ((model, hostId, hostUrl) =>
      resolveArtifactIdentity(model, hostId, hostUrl, { requireRegistry: false, refresh: false })),
    contextProfile: deps.contextProfile || contextProfiles.findContextProfile,
    performanceProfile: deps.performanceProfile || performanceProfiles.getActiveProfile,
    submit: deps.submit || ((request) => require('../../clients/coreHeavyQueue').submitHeavyWork(request)),
    reserve: deps.reserve || ((id, body) => require('../../clients/coreHeavyQueue').reserveHeavyWork(id, body)),
    queue: deps.queue || (() => require('../../clients/coreHeavyQueue').listHeavyWork()),
    now: deps.now || (() => new Date())
  };
}

function hostIdFor(hosts, hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  return hosts.find(host => normalizeHostUrl(host.url) === normalized)?.id || null;
}

/** Other configured Profiler endpoints on the same machine (a GPU and a CPU-only service). */
function siblingEndpointsFor(hosts, hostUrl) {
  const own = normalizeHostUrl(hostUrl);
  return [...new Set(hosts.map(host => normalizeHostUrl(host.url))
    .filter(url => url && url !== own && machineOf(url) === machineOf(own)))].sort();
}

/**
 * Capability of one model on one host. `artifact` may be supplied by a caller
 * that already holds the exact identity (Core's routing snapshot); otherwise
 * it is resolved from the host without requiring the model to be resident.
 */
async function capabilityFor({ model, hostUrl, artifact = null }, deps = {}) {
  const d = defaults(deps);
  const host = normalizeHostUrl(hostUrl);
  const hostId = hostIdFor(d.hosts(), host);
  let identity = artifact?.digest && artifact?.runtimeFingerprint ? artifact : null;
  if (!identity && hostId) {
    identity = await d.identity(model, hostId, host).catch(() => null);
  }
  const [contextProfile, performanceProfile] = await Promise.all([
    identity ? d.contextProfile(model, host, { digest: identity.digest, runtimeFingerprint: identity.runtimeFingerprint }).catch(() => null) : null,
    hostId ? d.performanceProfile(model, hostId).catch(() => null) : null
  ]);
  return buildLaneCapability({
    model, hostUrl: host, hostId,
    artifact: identity ? { digest: identity.digest, runtimeFingerprint: identity.runtimeFingerprint } : null,
    contextProfile, performanceProfile, now: d.now()
  });
}

async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const OPEN_STATES = ['requested', 'reserved', 'dispatching', 'running', 'uncertain'];
const RECENT_MS = 7 * 24 * 3600000;

/**
 * The lane's latest measurement request in Core's queue: an open one first,
 * else one that finished in the last week. Null when there is none or the
 * queue cannot be read; the card then simply shows no request.
 */
function measurementFor(capability, jobs, now) {
  const model = normalizeModelTag(capability.model);
  const own = (jobs || []).filter(job => job.source?.ref === 'profiler-lane-capability-card'
    && job.executor?.hostId === capability.hostId && normalizeModelTag(job.executor?.modelNames?.[0] || '') === model);
  const latest = list => list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const job = latest(own.filter(item => OPEN_STATES.includes(item.state)))
    || latest(own.filter(item => now - Date.parse(item.finishedAt || item.updatedAt) < RECENT_MS));
  if (!job) return null;
  return { id: job.id, state: job.state, start: job.reservation?.start || null, end: job.reservation?.end || null,
    autoStart: job.reservation?.autoStart === true, notBefore: job.notBefore, startBefore: job.startBefore,
    reason: job.reason || null, finishedAt: job.finishedAt || null };
}

/** Every pinned or routed lane with its capability profile and measurement request. */
async function listLaneCapabilities(deps = {}) {
  const d = defaults(deps);
  const [cells, queue] = await Promise.all([d.scope(), d.queue().catch(() => null)]);
  const now = d.now();
  const lanes = await mapLimited(cells, CONCURRENCY, async cell => {
    const capability = await capabilityFor({ model: cell.model, hostUrl: cell.hostUrl }, deps);
    return {
      hostName: cell.hostName,
      residency: cell.residency,
      pinned: cell.pinned === true,
      pinContext: Number(cell.pinContext) > 0 ? Number(cell.pinContext) : null,
      tasks: Array.isArray(cell.tasks) ? cell.tasks : [],
      capability,
      measurement: queue && capability.hostId ? measurementFor(capability, queue.jobs, now.getTime()) : null
    };
  });
  return { generatedAt: now.toISOString(), queueRead: Boolean(queue), lanes };
}

class LaneMeasureError extends Error {
  constructor(message) { super(message); this.statusCode = 400; }
}

function instant(value, label) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new LaneMeasureError(`${label} must be a valid time`);
  return date;
}

function coreMessage(error) {
  try { return JSON.parse(error.body).message || error.message; } catch { return error.message; }
}

/**
 * The request covers the machine's sibling endpoints too: a Full profile
 * already holds the whole machine's slot, and the concurrency probe pairs the
 * lane with the models resident there only when the reservation covers them.
 */
function laneRequest(lane, hostId, start, end, siblings = []) {
  const name = normalizeModelTag(lane.model);
  const day = start.toISOString().slice(0, 10);
  const slug = `${hostId}:${name}`.replace(/[^a-zA-Z0-9:._-]/g, '-').slice(0, 110);
  return {
    key: `lane-capability:${slug}:${day}`,
    title: `Full profile of ${name} on ${lane.hostName || hostId} (lane capability)`,
    kind: 'profiler',
    hosts: [normalizeHostUrl(lane.hostUrl), ...siblings],
    estimatedMinutes: FULL_PROFILE_MINUTES,
    notBefore: start.toISOString(),
    startBefore: end.toISOString(),
    source: { type: 'operator', ref: 'profiler-lane-capability-card' },
    // A recent standard profile must not skip the Full measurement.
    executor: { hostId, depth: 'full', skipRecentDays: 0, modelNames: [name] }
  };
}

function checkWindow(notBefore, startBefore, now) {
  const start = instant(notBefore, 'notBefore');
  const end = instant(startBefore, 'startBefore');
  const hours = (end - start) / 3600000;
  if (start <= now || start - now > 48 * 3600000) throw new LaneMeasureError('notBefore must be within the next 48 hours');
  if (hours < 1 || hours > 12) throw new LaneMeasureError('The window must last between 1 and 12 hours');
  return { start, end };
}

/** Lanes that would be measured, each resolved to its Profiler host. */
async function campaignTargets({ all = false } = {}, deps = {}) {
  const { lanes } = await listLaneCapabilities(deps);
  const targets = lanes.filter(lane => lane.capability?.hostId && (all === true || lane.capability.remeasure?.needed === true))
    .map(lane => ({ model: lane.capability.model, hostUrl: lane.capability.hostUrl, hostId: lane.capability.hostId, hostName: lane.hostName }));
  return { targets, skipped: lanes.length - targets.length };
}

/**
 * Slots for these lanes tonight: one machine at a time, machines in
 * parallel, after work already planned there. Reads only.
 */
async function planLaneSlots(targets, { notBefore, startBefore }, deps = {}) {
  const d = defaults(deps);
  const now = d.now();
  checkWindow(notBefore, startBefore, now);
  const queue = await d.queue().catch(() => null);
  const jobs = queue?.jobs || [];
  const own = jobs.filter(job => targets.some(target => job.key === laneRequest(target, target.hostId,
    new Date(notBefore), new Date(startBefore)).key)).map(job => job.id);
  return { ...planNight(targets, { notBefore, startBefore, minutes: FULL_PROFILE_MINUTES, jobs, exceptIds: own, now: now.getTime() }),
    queueRead: Boolean(queue) };
}

/**
 * Record each lane's Full-profile request and, when it fits tonight, plan
 * its slot. With `autoStart` (the owner's explicit choice) Core launches it
 * at that time; otherwise the owner runs it from Automations → Calendar.
 */
async function recordAndPlan(targets, { notBefore, startBefore, autoStart = false }, deps = {}) {
  const d = defaults(deps);
  const now = d.now();
  const { start, end } = checkWindow(notBefore, startBefore, now);
  const plan = await planLaneSlots(targets, { notBefore, startBefore }, deps);
  const results = [];
  for (const slot of plan.slots) {
    const row = { model: slot.model, hostId: slot.hostId, hostName: slot.hostName, machine: slot.machine,
      start: slot.start, end: slot.end, fits: slot.fits };
    let job;
    try {
      const request = laneRequest(slot, slot.hostId, start, end, siblingEndpointsFor(d.hosts(), slot.hostUrl));
      row.key = request.key;
      job = await d.submit(request);
      if (!job) throw new Error('Core returned no request');
    } catch (error) {
      results.push({ ...row, error: error instanceof LaneMeasureError ? error.message : 'not recorded' });
      continue;
    }
    row.job = { id: job.id, state: job.state, revision: job.revision };
    if (!['requested', 'reserved'].includes(job.state)) {
      row.planned = false; row.note = `Already ${job.state}; left as it is.`;
    } else if (!slot.fits) {
      row.planned = false; row.note = 'Does not fit before the window closes; plan it yourself in Automations → Calendar.';
    } else if (job.state === 'reserved' && job.reservation?.start === slot.start && job.reservation?.autoStart === autoStart) {
      row.planned = true; row.autoStart = autoStart;
    } else {
      try {
        const booked = await d.reserve(job.id, { expectedRevision: job.revision, start: slot.start, priority: 5, autoStart });
        row.job = { id: booked.id, state: booked.state, revision: booked.revision };
        row.planned = true; row.autoStart = autoStart;
      } catch (error) {
        row.planned = false; row.note = `Recorded but not planned: ${coreMessage(error)}`;
      }
    }
    results.push(row);
  }
  return { plan, results };
}

/**
 * Record a Full-profile request for one current lane in Core's heavy-work
 * queue and plan it in its night window. The browser supplies the window in
 * its own time zone. Without `autoStart` nothing starts on its own.
 */
async function requestLaneMeasurement({ model, hostUrl, notBefore, startBefore, autoStart = false } = {}, deps = {}) {
  const d = defaults(deps);
  const name = normalizeModelTag(model);
  const host = normalizeHostUrl(hostUrl);
  if (!name || !host) throw new LaneMeasureError('model and hostUrl are required');
  checkWindow(notBefore, startBefore, d.now());
  const lanes = await d.scope();
  const lane = lanes.find(cell => normalizeHostUrl(cell.hostUrl) === host && normalizeModelTag(cell.model) === name);
  if (!lane) throw new LaneMeasureError('Only a pinned or routed lane can be measured from this card');
  const hostId = hostIdFor(d.hosts(), host);
  if (!hostId) throw new LaneMeasureError('The lane host is not configured in the Profiler');
  const target = { model: name, hostUrl: host, hostId, hostName: lane.hostName || hostId };
  const { results } = await recordAndPlan([target], { notBefore, startBefore, autoStart: autoStart === true }, deps);
  const row = results[0];
  if (row.error) throw Object.assign(new Error(row.error), { status: 502 });
  const request = laneRequest(target, hostId, new Date(notBefore), new Date(startBefore), siblingEndpointsFor(d.hosts(), host));
  return { request, job: row.job, slot: row };
}

/** Preview of the night campaign: which lanes, when, and whether it fits. */
async function previewLaneCampaign({ notBefore, startBefore, all = false } = {}, deps = {}) {
  const { targets, skipped } = await campaignTargets({ all }, deps);
  const plan = await planLaneSlots(targets, { notBefore, startBefore }, deps);
  return { ...plan, skipped };
}

/**
 * Night campaign: one Full-profile request per current lane with a
 * re-measurement proposal (or every lane with `all`). Each keeps its own
 * stable key, so pressing again returns Core's existing request.
 */
async function requestLaneCampaign({ notBefore, startBefore, all = false, autoStart = false } = {}, deps = {}) {
  const d = defaults(deps);
  checkWindow(notBefore, startBefore, d.now());
  const { targets, skipped } = await campaignTargets({ all }, deps);
  const { plan, results } = await recordAndPlan(targets, { notBefore, startBefore, autoStart: autoStart === true }, deps);
  return { requested: results.filter(row => !row.error).length, planned: results.filter(row => row.planned).length,
    autoStart: autoStart === true, skipped, fits: plan.fits, machines: plan.machines, results, at: d.now().toISOString() };
}

module.exports = { siblingEndpointsFor, capabilityFor, listLaneCapabilities, requestLaneMeasurement, requestLaneCampaign, previewLaneCampaign, LaneMeasureError };
