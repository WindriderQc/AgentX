'use strict';

/**
 * Routing by topology role (#360, phase 2).
 *
 * A task route may name a role (`conversation`, `background`, `pooled`)
 * instead of a host. The role resolves through the runtime topology to the
 * endpoint serving it in its group's active mode, and the route uses that
 * endpoint's first pin: the host pin owns what its host loads (#829).
 *
 * - The topology description is cached for a few seconds and shared by
 *   concurrent callers, so a request never triggers its own `/api/ps` reads.
 * - A role that does not resolve is refused with a typed reason. Nothing
 *   falls back to another host or model.
 * - Before dispatch, a role-resolved request whose input estimate plus output
 *   budget exceeds the lane's pinned context is refused with
 *   `LANE_CONTEXT_EXCEEDED`. Nothing is truncated.
 *
 * Without a declared topology, or without a route naming a role, nothing here
 * runs and routing is unchanged.
 */

const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const topology = require('../runtimeTopologyService');

const ROLE_ROUTE_SOURCE = 'topology_role';
const ROLE_UNRESOLVED_SOURCE = 'topology_role_unresolved';
const ROLE_UNRESOLVED_CODE = 'TOPOLOGY_ROLE_UNRESOLVED';
const LANE_CONTEXT_EXCEEDED = 'LANE_CONTEXT_EXCEEDED';
const DESCRIPTION_TTL_MS = 5000;
const GROUP_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/;

// Reasons a role does not resolve. Stable strings: refusals and logs carry them.
const UNRESOLVED_REASONS = Object.freeze([
  'topology_not_declared', 'topology_invalid', 'topology_unavailable', 'unknown_role', 'unknown_group',
  'group_required', 'conflict', 'transitional', 'none_active', 'role_not_in_active_mode', 'endpoint_has_no_pin'
]);

function isRoleRoute(entry) {
  return Boolean(entry && typeof entry.role === 'string' && entry.role);
}

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function present(entry, key) {
  const value = entry?.[key];
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/**
 * Validate the target part of a route: either `{model, host}` (returns null)
 * or `{role, group?}` (returns the normalized role part). `requireTopology`
 * also checks the role against the declared topology, as a save does.
 */
function normalizeRoleTarget(entry, { requireTopology = false, raw } = {}) {
  if (!present(entry, 'role')) {
    if (present(entry, 'group')) throw badRequest('group is only valid with role');
    return null;
  }
  if (present(entry, 'host')) throw badRequest('A route sets either host or role, never both');
  if (present(entry, 'model')) throw badRequest('A role route uses the pin of the endpoint serving the role; omit model');
  const role = typeof entry.role === 'string' ? entry.role.trim() : '';
  if (!topology.ROLES.includes(role)) throw badRequest(`Unknown role: ${String(entry.role).slice(0, 40)}`);
  let group = null;
  if (present(entry, 'group')) {
    group = typeof entry.group === 'string' ? entry.group.trim() : '';
    if (!GROUP_ID.test(group)) throw badRequest('Invalid topology group');
  }
  if (requireTopology) {
    let declared;
    try {
      declared = topology.parseTopology(raw === undefined ? process.env.AGENTX_RUNTIME_TOPOLOGY_JSON : raw);
    } catch {
      throw badRequest('The runtime topology declaration is invalid; role routes are unavailable');
    }
    if (!declared.configured) throw badRequest('Role routes need a declared runtime topology');
    if (group && !declared.groups.some(item => item.id === group)) throw badRequest(`Unknown topology group: ${group}`);
    if (!group && declared.groups.length > 1) {
      throw badRequest('group is required when more than one topology group is declared');
    }
  }
  return group ? { role, group } : { role };
}

function hostKeyFor(hosts, url) {
  const key = hostUrlKey(url);
  return Object.keys(hosts || {}).find(hostKey => hosts[hostKey] && hostUrlKey(hosts[hostKey]) === key) || null;
}

function routeKey(route) {
  return `${route?.group || ''}\u0000${route?.role || ''}`;
}

/**
 * A role resolver with a short cache of the topology description, shared by
 * concurrent callers. A changed declaration discards what is held.
 */
function createRoleResolver({
  describe = options => topology.describeTopology(options),
  now = Date.now,
  ttlMs = DESCRIPTION_TTL_MS,
  readRaw = () => process.env.AGENTX_RUNTIME_TOPOLOGY_JSON || ''
} = {}) {
  let held = null; // { raw, description, at }
  let pending = null; // { raw, promise }
  let last = new Map(); // route key -> last resolution, for synchronous readers

  async function description() {
    const raw = readRaw();
    if (held && held.raw === raw && now() - held.at < ttlMs) return held.description;
    if (pending && pending.raw === raw) return pending.promise;
    const entry = { raw, promise: null };
    entry.promise = Promise.resolve().then(() => describe({ raw })).then((result) => {
      if (pending === entry) { held = { raw, description: result, at: now() }; pending = null; }
      return result;
    }, (error) => {
      if (pending === entry) pending = null;
      throw error;
    });
    pending = entry;
    return entry.promise;
  }

  function remember(route, resolution) {
    last.set(routeKey(route), resolution);
    return resolution;
  }

  function refused(route, groupId, reason, mode = null) {
    return remember(route, { ok: false, role: route.role, group: groupId || null, mode, reason });
  }

  /**
   * @param {{role: string, group?: string}} route
   * @param {{hosts?: object}} [context] routing host keys, to name the endpoint
   */
  async function resolve(route, { hosts = {} } = {}) {
    const raw = readRaw();
    if (!raw) return refused(route, route.group, 'topology_not_declared');
    let declared;
    try { declared = topology.parseTopology(raw); } catch { return refused(route, route.group, 'topology_invalid'); }
    if (!declared.configured) return refused(route, route.group, 'topology_not_declared');
    let groupId = route.group || null;
    if (!groupId) {
      if (declared.groups.length !== 1) return refused(route, null, 'group_required');
      groupId = declared.groups[0].id;
    }
    let observed;
    try { observed = await description(); } catch { return refused(route, groupId, 'topology_unavailable'); }
    if (observed?.valid === false) return refused(route, groupId, 'topology_invalid');
    const found = topology.resolveRole(observed, groupId, route.role);
    if (!found.url) return refused(route, groupId, found.reason, found.mode);
    const group = observed.groups.find(entry => entry.id === groupId);
    const mode = group.modes.find(entry => entry.id === found.mode);
    const endpoint = mode.endpoints.find(entry => entry.url === found.url);
    const pin = endpoint?.pins?.[0];
    if (!pin?.model) return refused(route, groupId, 'endpoint_has_no_pin', found.mode);
    return remember(route, {
      ok: true, role: route.role, group: groupId, mode: found.mode, reason: null,
      url: found.url, host: hostKeyFor(hosts, found.url) || endpoint.hostKey || null,
      model: pin.model, laneContext: Number(pin.contextSize) > 0 ? Number(pin.contextSize) : null
    });
  }

  /** The last resolution of a route, without reading anything (sync callers). */
  function peek(route) {
    return last.get(routeKey(route)) || null;
  }

  function clear() {
    held = null; pending = null; last = new Map();
  }

  return Object.freeze({ resolve, peek, clear, description });
}

/** Typed refusal for a role that does not resolve. Never a silent reroute. */
function roleRefusal(resolution) {
  return {
    status: 503,
    code: ROLE_UNRESOLVED_CODE,
    reason: resolution.reason,
    message: `The ${resolution.role} role does not resolve (${resolution.reason}); the request was not dispatched.`,
    data: {
      role: resolution.role, group: resolution.group || null,
      mode: resolution.mode || null, reason: resolution.reason
    }
  };
}

/** Task recommendation for a role route, resolved or refused. */
function roleRecommendation(resolution) {
  const evidence = {
    role: resolution.role, group: resolution.group || null, mode: resolution.mode || null,
    laneContext: resolution.laneContext ?? null
  };
  const common = { claimId: null, claimExpiresAt: null, recommendation: null, readiness: null, topology: evidence };
  if (resolution.ok) {
    return {
      model: resolution.model, host: resolution.host, url: resolution.url,
      source: ROLE_ROUTE_SOURCE,
      reason: `Role ${resolution.role} resolved in mode ${resolution.mode} of group ${resolution.group}.`,
      ...common
    };
  }
  return {
    model: null, host: null, url: null,
    source: ROLE_UNRESOLVED_SOURCE,
    reason: `Role ${resolution.role} does not resolve: ${resolution.reason}.`,
    ...common,
    refusal: roleRefusal(resolution)
  };
}

/**
 * Compare a request with the lane's pinned context. Returns null when it fits
 * or cannot be judged, otherwise the typed refusal. Fitting exactly is
 * allowed: estimatedInputTokens + outputBudget <= laneContext.
 */
function checkLaneContext({ estimatedInputTokens, outputBudget, laneContext, role, mode = null, group = null }) {
  if ([estimatedInputTokens, outputBudget, laneContext].some(value => value === null || value === undefined)) return null;
  const input = Number(estimatedInputTokens);
  const output = Number(outputBudget);
  const context = Number(laneContext);
  if (![input, output, context].every(Number.isFinite) || context <= 0 || input < 0 || output < 0) return null;
  if (input + output <= context) return null;
  const suggestion = role === 'pooled' ? 'reduce_input' : 'queue_for_pooled';
  return {
    status: 413,
    code: LANE_CONTEXT_EXCEEDED,
    message: `The request needs ${input + output} tokens (input ${input} + output ${output}) `
      + `but the ${role} lane holds ${context}; it was not dispatched and nothing was truncated.`,
    data: { estimatedInputTokens: input, outputBudget: output, laneContext: context, role, mode, group, suggestion },
    suggestion
  };
}

/** The lane check over an inference contract's context budget (role routes only). */
function checkLaneContract(evidence, inferenceContract) {
  if (!evidence?.role) return null;
  const budget = inferenceContract?.contextBudget;
  return checkLaneContext({
    estimatedInputTokens: budget?.input?.estimatedTokens,
    outputBudget: budget?.output?.reservedTokens,
    laneContext: evidence.laneContext,
    role: evidence.role, mode: evidence.mode, group: evidence.group
  });
}

const defaultResolver = createRoleResolver();

module.exports = {
  ROLE_ROUTE_SOURCE,
  ROLE_UNRESOLVED_SOURCE,
  ROLE_UNRESOLVED_CODE,
  LANE_CONTEXT_EXCEEDED,
  UNRESOLVED_REASONS,
  DESCRIPTION_TTL_MS,
  isRoleRoute,
  normalizeRoleTarget,
  createRoleResolver,
  roleRecommendation,
  roleRefusal,
  checkLaneContext,
  checkLaneContract,
  resolveRoleRoute: (route, context) => defaultResolver.resolve(route, context),
  peekRoleRoute: route => defaultResolver.peek(route),
  clearRoleRouteCache: () => defaultResolver.clear()
};
