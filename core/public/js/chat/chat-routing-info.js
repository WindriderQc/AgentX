/**
 * Build a routingInfo object from server response data.
 * Used for both status-bar updates and per-message routing badges.
 */
export function buildRoutingInfo(serverData) {
  if (!serverData) return null;
  const routing = serverData.routing || {};
  const model = routing.routedModel || serverData.model || null;
  const host = routing.routedHostUrl || serverData.target || null;
  const stats = serverData.stats || {};
  const usage = stats.usage || {};
  const perf = stats.performance || {};

  // Derive a short host name from the explicitly configured URL.
  let hostName = null;
  if (host) {
    try { hostName = new URL(host).hostname; } catch { hostName = host; }
  }

  const durationMs = perf.totalDuration ? Math.round(perf.totalDuration / 1e6) : 0;
  const durationStr = durationMs > 0 ? (durationMs / 1000).toFixed(2) + 's' : null;

  return {
    model: routing.routedModel || model,
    host: routing.routedHostUrl || host,
    hostName,
    hostHealth: host ? 'online' : '',
    taskType: routing.taskType || null,
    routedHost: routing.routedHost || null,
    autoRouted: routing.autoRouted === true,
    prompt: serverData.prompt || null,
    numCtx: serverData.numCtx || null,
    tokensIn: usage.promptTokens || 0,
    tokensOut: usage.completionTokens || 0,
    durationMs,
    duration: durationStr,
    cost: serverData.cost || null,
    fallbackUsed: routing.routed || false,
    fallbackReason: routing.taskType || null,
    // Set when a task fallback ladder rung answered instead of the primary.
    degraded: routing.degraded === true
      ? { fallbackFrom: routing.fallbackFrom || null, fallbackTo: routing.fallbackTo || null, reason: routing.reason || null }
      : null,
    status: 'success'
  };
}
