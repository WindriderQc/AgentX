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
    now: deps.now || (() => new Date())
  };
}

function hostIdFor(hosts, hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  return hosts.find(host => normalizeHostUrl(host.url) === normalized)?.id || null;
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

/** Every pinned or routed lane with its capability profile. */
async function listLaneCapabilities(deps = {}) {
  const d = defaults(deps);
  const cells = await d.scope();
  const lanes = await mapLimited(cells, CONCURRENCY, async cell => ({
    hostName: cell.hostName,
    residency: cell.residency,
    pinned: cell.pinned === true,
    pinContext: Number(cell.pinContext) > 0 ? Number(cell.pinContext) : null,
    tasks: Array.isArray(cell.tasks) ? cell.tasks : [],
    capability: await capabilityFor({ model: cell.model, hostUrl: cell.hostUrl }, deps)
  }));
  return { generatedAt: d.now().toISOString(), lanes };
}

class LaneMeasureError extends Error {
  constructor(message) { super(message); this.statusCode = 400; }
}

function instant(value, label) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new LaneMeasureError(`${label} must be a valid time`);
  return date;
}

/**
 * Record a Full-profile request for one current lane in Core's heavy-work
 * queue. The request names only that lane's model and host; the browser
 * supplies the night window in its own time zone. Recording starts nothing:
 * the owner reserves it, and Core admission applies at execution.
 */
async function requestLaneMeasurement({ model, hostUrl, notBefore, startBefore } = {}, deps = {}) {
  const d = defaults(deps);
  const name = normalizeModelTag(model);
  const host = normalizeHostUrl(hostUrl);
  if (!name || !host) throw new LaneMeasureError('model and hostUrl are required');
  const start = instant(notBefore, 'notBefore');
  const end = instant(startBefore, 'startBefore');
  const now = d.now();
  const hours = (end - start) / 3600000;
  if (start <= now || start - now > 48 * 3600000) throw new LaneMeasureError('notBefore must be within the next 48 hours');
  if (hours < 1 || hours > 12) throw new LaneMeasureError('The window must last between 1 and 12 hours');
  const lanes = await d.scope();
  const lane = lanes.find(cell => normalizeHostUrl(cell.hostUrl) === host && normalizeModelTag(cell.model) === name);
  if (!lane) throw new LaneMeasureError('Only a pinned or routed lane can be measured from this card');
  const hostId = hostIdFor(d.hosts(), host);
  if (!hostId) throw new LaneMeasureError('The lane host is not configured in the Profiler');
  const day = start.toISOString().slice(0, 10);
  const slug = `${hostId}:${name}`.replace(/[^a-zA-Z0-9:._-]/g, '-').slice(0, 110);
  const request = {
    key: `lane-capability:${slug}:${day}`,
    title: `Full profile of ${name} on ${lane.hostName || hostId} (lane capability)`,
    kind: 'profiler',
    hosts: [host],
    estimatedMinutes: FULL_PROFILE_MINUTES,
    notBefore: start.toISOString(),
    startBefore: end.toISOString(),
    source: { type: 'operator', ref: 'profiler-lane-capability-card' },
    // A recent standard profile must not skip the Full measurement.
    executor: { hostId, depth: 'full', skipRecentDays: 0, modelNames: [name] }
  };
  const job = await d.submit(request);
  return { request, job: job ? { id: job.id, state: job.state, revision: job.revision } : null };
}

/**
 * Night campaign: one Full-profile request per current lane that still lacks
 * verified quality or agent measurements (or every lane with `all`). Each is
 * an independent request with its own stable key; a lane already requested
 * for that night returns Core's existing request instead of a duplicate.
 */
async function requestLaneCampaign({ notBefore, startBefore, all = false } = {}, deps = {}) {
  const d = defaults(deps);
  const { lanes } = await listLaneCapabilities(deps);
  const targets = lanes.filter(lane => lane.capability?.hostId && (all === true
    || lane.capability.quality?.status !== 'verified' || lane.capability.agent?.status !== 'measured'));
  const results = [];
  for (const lane of targets) {
    try {
      const { request, job } = await requestLaneMeasurement({ model: lane.capability.model, hostUrl: lane.capability.hostUrl,
        notBefore, startBefore }, { ...deps, scope: async () => [{ hostUrl: lane.capability.hostUrl, hostName: lane.hostName, model: lane.capability.model }] });
      results.push({ model: request.executor.modelNames[0], hostId: request.executor.hostId, key: request.key, job });
    } catch (error) {
      if (error instanceof LaneMeasureError) throw error;
      results.push({ model: lane.capability.model, hostId: lane.capability.hostId, error: 'not recorded' });
    }
  }
  return { requested: results.filter(row => !row.error).length, skipped: lanes.length - targets.length, results, at: d.now().toISOString() };
}

module.exports = { capabilityFor, listLaneCapabilities, requestLaneMeasurement, requestLaneCampaign, LaneMeasureError };
