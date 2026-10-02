'use strict';

// What a recreate of each service interrupts (#47). Core holds every workload
// and inference admission, so it alone can name the work a deploy would cut
// and how that work is cancelled cleanly. The launcher prints this verdict.

// Workload kinds whose writer is Benchmark and that survive a Core restart:
// they reach Ollama directly, their admission outlives the restart and
// Benchmark keeps heartbeating through it. Batches are not among them: they
// warm models and judge through Core inference.
const CORE_RESTART_TOLERANT_KINDS = Object.freeze(['profiler']);
// A tolerated workload must have at least this much admission left, so the
// restart cannot outlast it before Benchmark renews it.
const CORE_RESTART_MIN_REMAINING_MS = 2 * 60_000;
const RUNNING_RECOVERY_STATES = Object.freeze(['PREPARED', 'MUTATING']);
const CORE_RECREATE_SCOPE = 'core-recreate';
const DEPLOY_SERVICES = Object.freeze(['core', 'benchmark', 'all']);
const RECOVERY_DOC = 'follow "Profiler restoration and UNKNOWN recovery" in docs/OPERATIONS.md';

function iso(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

// Mongo-stored labels are printed by shell launchers: keep them to one safe token.
function label(value, max = 120) {
  const text = String(value ?? '').replace(/[^A-Za-z0-9._:/@+-]/g, '').slice(0, max);
  return text || 'unknown';
}

// The workload filter of the Core-recreate lease CAS: no workload that a Core
// restart would interrupt. Kept beside workloadBlockReason, its JS twin.
function coreRecreateWorkloadFilter(now = new Date()) {
  return { $not: { $elemMatch: { $or: [
    { kind: { $nin: CORE_RESTART_TOLERANT_KINDS } },
    { recoveryState: { $nin: RUNNING_RECOVERY_STATES } },
    { recoveryOwnerId: { $nin: [null] } },
    { expiresAt: { $lte: new Date(now.getTime() + CORE_RESTART_MIN_REMAINING_MS) } }
  ] } } };
}

function workloadBlockReason(item, service, now) {
  if (service !== 'core') return 'Benchmark owns its writer; recreating Benchmark cuts it';
  if (!CORE_RESTART_TOLERANT_KINDS.includes(item.kind)) {
    return `${label(item.kind)} work goes through Core inference; a Core recreate cuts it`;
  }
  if (!RUNNING_RECOVERY_STATES.includes(item.recoveryState)) {
    return `it is in recovery state ${label(item.recoveryState)}`;
  }
  if (item.recoveryOwnerId) return 'a recovery owner has adopted it';
  if (new Date(item.expiresAt).getTime() <= now.getTime() + CORE_RESTART_MIN_REMAINING_MS) {
    return 'its admission expires before a Core restart would complete';
  }
  return null;
}

function cancelRoute(item) {
  if (item.recoveryState === 'UNKNOWN' || item.recoveryOwnerId) return `recovery quarantine: ${RECOVERY_DOC}`;
  const id = String(item.workloadId || '');
  const routes = [
    [/^profile-(.+)$/, m => `Profiler panel, or Benchmark POST /api/profiler/pipeline/profile/${label(m[1])}/cancel`],
    [/^profiler-queue-(.+)$/, m => `Benchmark POST /api/profiler/pipeline/profile-host/${label(m[1])}/cancel`],
    [/^profiler-fleet-(.+)$/, m => `Benchmark POST /api/profiler/hosts/test/run-fleet/${label(m[1])}/cancel`]
  ];
  for (const [pattern, route] of routes) {
    const match = pattern.exec(id);
    if (match) return route(match);
  }
  if (item.kind === 'benchmark' && item.batchId) return `Benchmark POST /api/benchmark/batch/${label(item.batchId)}/stop`;
  return `no cancel route; it ends with its request (admission expires ${iso(item.expiresAt) || 'unknown'} unless renewed)`;
}

function blocker(fields) {
  const where = fields.hosts?.length ? ` on ${fields.hosts.map(host => label(host, 200)).join(',')}` : '';
  const summary = `${fields.type} ${label(fields.kind)} ${label(fields.id)}${where}`
    + ` (owner ${label(fields.owner)}, started ${fields.startedAt || 'unknown'}): ${fields.reason}. Cancel: ${fields.cancel}`;
  return { ...fields, summary: summary.replace(/["\\\r\n]/g, ' ') };
}

// service: core (Core alone), benchmark (Benchmark and its runner), all.
function deployBlockers(state, { service = 'all', now = new Date() } = {}) {
  if (!DEPLOY_SERVICES.includes(service)) service = 'all';
  const blockers = [];
  for (const item of state?.workloads || []) {
    const reason = workloadBlockReason(item, service, now);
    if (!reason) continue;
    blockers.push(blocker({ type: 'workload', kind: item.kind, id: item.workloadId, hosts: item.hosts || [],
      owner: item.principal, startedAt: iso(item.acquiredAt), expiresAt: iso(item.expiresAt),
      state: item.recoveryState || null, reason, cancel: cancelRoute(item) }));
  }
  if (service === 'benchmark') return { service, allowed: blockers.length === 0, blockers };
  for (const item of state?.inferences || []) {
    const unknown = item.state === 'UNKNOWN';
    blockers.push(blocker({ type: 'inference', kind: item.kind, id: item.model, hosts: [item.host],
      owner: item.principal, startedAt: iso(item.acquiredAt), expiresAt: iso(item.expiresAt),
      state: item.state || null,
      reason: unknown ? 'its outcome is UNKNOWN and the host stays quarantined' : 'Core serves it; a Core recreate cuts it',
      cancel: unknown ? `runtime recovery: ${RECOVERY_DOC}` : 'none; wait for it to finish' }));
  }
  const maintenance = state?.maintenance;
  if (maintenance) {
    const unknown = maintenance.state === 'UNKNOWN';
    blockers.push(blocker({ type: 'maintenance', kind: maintenance.scope, id: 'lease', hosts: [],
      owner: maintenance.principal, startedAt: iso(maintenance.acquiredAt), expiresAt: iso(maintenance.expiresAt),
      state: maintenance.state || 'ACTIVE',
      reason: unknown ? 'it expired without a terminal receipt' : 'another maintenance lease is held',
      cancel: unknown ? 'operator reconciliation, then POST /api/nerve-center/maintenance-leases/:leaseId/recover'
        : 'wait for its holder to release it' }));
  }
  return { service, allowed: blockers.length === 0, blockers };
}

module.exports = {
  CORE_RECREATE_SCOPE,
  CORE_RESTART_MIN_REMAINING_MS,
  CORE_RESTART_TOLERANT_KINDS,
  DEPLOY_SERVICES,
  coreRecreateWorkloadFilter,
  deployBlockers
};
