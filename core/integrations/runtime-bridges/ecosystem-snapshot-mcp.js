'use strict';


const FULL_SNAPSHOT_CAPS = Object.freeze({
  agents: 40,
  automations: 30,
  pipelineActive: 40,
  pipelineRecent: 5,
  alerts: 40,
  drift: 40,
  recommendations: 40,
  activity: 5,
  responsibilityLanes: 60,
});

const ECOSYSTEM_SNAPSHOT_TOOL = Object.freeze({
  name: 'ecosystem_snapshot',
  title: 'Ecosystem Snapshot',
  description: 'Return the bounded, sanitized, read-only AIOps programme projection used by Overseer.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['full'], default: 'full' },
      maxChars: { type: 'integer', minimum: 5000, maximum: 60000, default: 60000 },
    },
    additionalProperties: false,
  }),
  annotations: Object.freeze({ readOnlyHint: true, idempotentHint: true, openWorldHint: false }),
  _meta: Object.freeze({
    'agentx/owner': 'aio-ops-runtime-bridges',
    'agentx/version': '1.2.0',
    'agentx/capability': 'ecosystem-snapshot-mcp',
  }),
});

const PRIVATE_PIPELINE_SERVICES = new Set(['personal', 'family', 'household']);
const PRIVATE_PIPELINE_SOURCES = new Set(['idea-drop']);
const SUMMARY_KEYS = Object.freeze([
  'registeredAgents', 'activeAgents', 'runtimeAgents', 'observedAgents',
  'automations', 'observedAutomations', 'openWork', 'blockedWork',
]);
const SOURCE_AUTHORITIES = Object.freeze({
  registry: 'repository-agent-registry',
  schedules: 'repository-active-schedule',
  pipeline: 'mongodb-pipeline-api',
  openclaw: 'official-openclaw-cli',
  hermes: 'hermes-status-api',
  ecosystem: 'agentx-product-ecosystem',
  alerts: 'agentx-product-alerts',
});

class EcosystemSnapshotMcpError extends Error {
  constructor(message, code = 'ECOSYSTEM_SNAPSHOT_ERROR') {
    super(message);
    this.name = 'EcosystemSnapshotMcpError';
    this.code = code;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function capArray(value, limit) {
  return asArray(value).slice(0, limit);
}

function cleanString(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function safeIdentifier(value, maxLength = 120) {
  const text = cleanString(value, maxLength);
  return /^[a-z0-9][a-z0-9_.:-]*$/i.test(text) ? text : null;
}

function safeLabel(value, maxLength = 240) {
  return cleanString(value, maxLength)
    .replace(/\b(?:token|secret|password|authorization|api[_ -]?key)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b[A-Z]:\\[^\s]+/gi, '[redacted-path]')
    .replace(/(?:^|\s)\/(?:home|users|workspace)\/[^\s]+/gi, ' [redacted-path]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]');
}

function safeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonNegativeNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function safeMetricValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'boolean') return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeCounts(value) {
  const counts = {};
  for (const [key, raw] of Object.entries(value || {}).slice(0, 100)) {
    const safeKey = safeIdentifier(key, 80);
    const numeric = Number(raw);
    if (safeKey && Number.isFinite(numeric) && numeric >= 0) counts[safeKey] = numeric;
  }
  return counts;
}

function countBy(items, field, fallback = 'unknown') {
  return asArray(items).reduce((counts, item) => {
    const key = safeIdentifier(item?.[field], 80) || fallback;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function programmeTask(task) {
  const service = String(task?.service || '').trim().toLowerCase();
  const source = String(task?.source || '').trim().toLowerCase();
  if (PRIVATE_PIPELINE_SERVICES.has(service) || PRIVATE_PIPELINE_SOURCES.has(source)) return null;
  return {
    pipelineId: safeIdentifier(task?.pipelineId, 80),
    title: safeLabel(task?.title || '', 240),
    service: safeIdentifier(task?.service, 80),
    status: safeIdentifier(task?.status, 40),
    assignee: safeIdentifier(task?.assignee, 80),
    heartbeatAt: safeTimestamp(task?.heartbeatAt),
    epic: safeLabel(task?.epic || '', 160) || null,
    source: safeIdentifier(task?.source, 80),
    priority: Number.isFinite(Number(task?.priority)) ? Number(task.priority) : null,
    dependsOn: capArray(task?.dependsOn, 20).map((id) => safeIdentifier(id, 80)).filter(Boolean),
    notBefore: safeTimestamp(task?.notBefore),
    dueAt: safeTimestamp(task?.dueAt),
    risk: safeIdentifier(task?.risk, 40),
    scheduleEntryIds: capArray(task?.scheduleEntryIds, 20).map((id) => safeIdentifier(id, 120)).filter(Boolean),
    createdAt: safeTimestamp(task?.createdAt),
    updatedAt: safeTimestamp(task?.updatedAt),
  };
}

function programmeTasks(tasks) {
  return asArray(tasks).map(programmeTask).filter(Boolean);
}

function agentSummary(agent) {
  return {
    id: safeIdentifier(agent?.id, 100),
    name: safeLabel(agent?.name || '', 120),
    type: safeIdentifier(agent?.type, 80),
    runtime: safeIdentifier(agent?.runtime, 80),
    status: safeIdentifier(agent?.status, 40),
    automationCount: nonNegativeNumber(agent?.automationCount),
    workCount: nonNegativeNumber(agent?.workCount),
    blockedWorkCount: nonNegativeNumber(agent?.blockedWorkCount),
    confidence: safeIdentifier(agent?.confidence, 40),
  };
}

function automationSummary(item) {
  const failed = item?.health === 'error';
  return {
    id: safeIdentifier(item?.id, 120),
    name: safeLabel(item?.name || '', 160),
    ownerId: safeIdentifier(item?.ownerId, 100),
    cadence: safeLabel(item?.cadence || '', 120),
    source: safeIdentifier(item?.source, 80),
    confidence: safeIdentifier(item?.confidence, 40),
    health: safeIdentifier(item?.health, 40),
    enabled: item?.enabled !== false,
    lastRun: safeTimestamp(item?.lastRun),
    nextRunAt: safeTimestamp(item?.nextRunAt),
    lastStatus: safeIdentifier(item?.lastStatus, 40),
    failureCode: failed ? 'AUTOMATION_RUNTIME_FAILURE' : null,
    lastDurationMs: nonNegativeNumber(item?.lastDurationMs, null),
    consecutiveErrors: nonNegativeNumber(item?.consecutiveErrors),
    history: capArray(item?.history, 3).map((run) => ({
      at: safeTimestamp(run?.at),
      status: safeIdentifier(run?.status, 40),
      durationMs: nonNegativeNumber(run?.durationMs, null),
    })),
  };
}

function warningCode(warning) {
  if (warning?.type === 'source') return 'EVIDENCE_SOURCE_DEGRADED';
  if (warning?.type === 'automation-error') return 'AUTOMATION_RUNTIME_FAILURE';
  if (warning?.type === 'blocked-work') return 'PROGRAMME_WORK_BLOCKED';
  return 'OPERATOR_WARNING';
}

function warningSummary(warning) {
  return {
    id: safeIdentifier(warning?.id, 120),
    type: safeIdentifier(warning?.type, 60) || 'warning',
    severity: safeIdentifier(warning?.severity, 20) || 'warning',
    ownerId: safeIdentifier(warning?.ownerId, 100),
    code: warningCode(warning),
  };
}

function driftRecord(warning) {
  if (!['source', 'automation-error'].includes(warning?.type)) return null;
  return { ...warningSummary(warning), observed: true };
}

function recommendationFor(warning) {
  if (warning?.type === 'source') {
    return {
      id: warning?.id ? `recommend-${safeIdentifier(warning.id, 100)}` : null,
      sourceId: safeIdentifier(warning?.id, 100),
      code: 'TRACE_DEGRADED_SOURCE',
      recommendation: 'Inspect the owning authenticated evidence source before changing state.',
    };
  }
  if (warning?.type === 'automation-error') {
    return {
      id: warning?.id ? `recommend-${safeIdentifier(warning.id, 100)}` : null,
      sourceId: safeIdentifier(warning?.id, 100),
      code: 'INSPECT_FAILED_AUTOMATION',
      recommendation: 'Inspect the recurring automation receipt and owner before changing state.',
    };
  }
  if (warning?.type === 'blocked-work') {
    return {
      id: 'recommend-blocked-work',
      sourceId: safeIdentifier(warning?.id, 100),
      code: 'REVIEW_BLOCKED_PROGRAMME_WORK',
      recommendation: 'Inspect the authenticated Pipeline surface for blocked task detail.',
    };
  }
  return null;
}

function responsibilityLane(lane) {
  return {
    agentId: safeIdentifier(lane?.agentId, 100),
    status: safeIdentifier(lane?.status, 40),
    automationCount: asArray(lane?.automations).length,
    workCount: asArray(lane?.work).length,
    signalCount: nonNegativeNumber(lane?.signalCount),
    blockedCount: nonNegativeNumber(lane?.blockedCount),
    load: safeIdentifier(lane?.load, 20),
  };
}

function activityItem(item) {
  if (item?.kind === 'work') return null;
  return {
    id: safeIdentifier(item?.id, 160),
    kind: safeIdentifier(item?.kind, 40),
    targetId: safeIdentifier(item?.targetId, 120),
    ownerId: safeIdentifier(item?.ownerId, 100),
    status: safeIdentifier(item?.status, 40),
    timestamp: safeTimestamp(item?.timestamp),
  };
}

function alertSummary(alert) {
  return {
    id: safeIdentifier(alert?.id, 80),
    ruleId: safeIdentifier(alert?.ruleId, 120),
    severity: safeIdentifier(alert?.severity, 20) || 'unknown',
    status: safeIdentifier(alert?.status, 30) || 'active',
    source: safeIdentifier(alert?.source, 80),
    component: safeIdentifier(alert?.component, 120),
    metric: safeIdentifier(alert?.metric, 120),
    currentValue: safeMetricValue(alert?.currentValue),
    threshold: safeMetricValue(alert?.threshold),
    trend: safeIdentifier(alert?.trend, 40),
    occurrenceCount: Math.max(1, nonNegativeNumber(alert?.occurrenceCount, 1)),
    lastOccurrence: safeTimestamp(alert?.lastOccurrence),
    createdAt: safeTimestamp(alert?.createdAt),
    localLogRecorded: alert?.localLogRecorded === true,
    provenance: 'agentx-product-alerts',
  };
}

function snapshotStatus(projection) {
  const sourceDegraded = Object.values(projection.sources || {}).some((source) => source?.status !== 'ok');
  const criticalWarning = asArray(projection.warnings).some((warning) => warning?.severity === 'critical');
  const criticalAlert = asArray(projection.alertEvidence?.records).some((alert) => alert?.severity === 'critical');
  return sourceDegraded || criticalWarning || criticalAlert ? 'degraded' : 'ok';
}

function summaryProjection(source) {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, nonNegativeNumber(source?.[key])]));
}

function coverageProjection(coverage) {
  return {
    agents: {
      registered: nonNegativeNumber(coverage?.agents?.registered),
      observed: nonNegativeNumber(coverage?.agents?.observed),
      runtimeUnobserved: nonNegativeNumber(coverage?.agents?.runtimeUnobserved),
    },
    automations: {
      documented: nonNegativeNumber(coverage?.automations?.documented),
      observed: nonNegativeNumber(coverage?.automations?.observed),
      documentedOnly: nonNegativeNumber(coverage?.automations?.documentedOnly),
      observedOnly: nonNegativeNumber(coverage?.automations?.observedOnly),
    },
  };
}

function sourceProjection(sources) {
  return Object.fromEntries(Object.entries(sources || {}).slice(0, 20).map(([name, source]) => {
    const key = safeIdentifier(name, 80) || 'unknown';
    const status = safeIdentifier(source?.status, 30) || 'unknown';
    return [key, {
      status,
      authority: SOURCE_AUTHORITIES[key] || 'bounded-projection-source',
      issueCount: asArray(source?.issues).length,
      issueCode: status === 'ok' ? null : `${key.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_SOURCE_DEGRADED`,
    }];
  }));
}

function runtimeLayer(layer) {
  return {
    id: safeIdentifier(layer?.id, 80),
    name: safeLabel(layer?.name || '', 100),
    type: safeLabel(layer?.type || '', 100),
    status: safeIdentifier(layer?.status, 30),
  };
}

function capabilitySummary(capability) {
  return {
    id: safeIdentifier(capability?.id, 80),
    service: safeIdentifier(capability?.service, 80),
  };
}

function validateProjection(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)
    || projection.schemaVersion !== 5
    || projection.authority !== 'aio-ops-runtime-bridges'
    || projection.readOnly !== true
    || !projection.work
    || !projection.sources
    || !projection.alertEvidence
    || !Array.isArray(projection.alertEvidence.records)) {
    throw new EcosystemSnapshotMcpError(
      'Agent Ops schema-5 projection is unavailable or invalid',
      'ECOSYSTEM_SNAPSHOT_PROJECTION_INVALID'
    );
  }
  return projection;
}

function buildFullSnapshot(projection) {
  const source = validateProjection(projection);
  const warnings = asArray(source.warnings).map(warningSummary);
  const driftRecords = asArray(source.warnings).map(driftRecord).filter(Boolean);
  const recommendations = asArray(source.warnings).map(recommendationFor).filter(Boolean);
  const automations = asArray(source.automations);
  const failingAutomations = automations.filter((item) => item?.health === 'error');
  const activeWork = asArray(source.work?.active);
  const recentWork = asArray(source.work?.recent);
  const visibleActiveWork = programmeTasks(activeWork);
  const visibleRecentWork = programmeTasks(recentWork);
  const activityItems = asArray(source.activity?.items).map(activityItem).filter(Boolean);
  const alerts = asArray(source.alertEvidence?.records).map(alertSummary);
  const returnedAlerts = capArray(alerts, FULL_SNAPSHOT_CAPS.alerts);
  const activeAlertCount = nonNegativeNumber(source.alertEvidence?.activeCount, alerts.length);

  return {
    mode: 'full',
    schemaVersion: source.schemaVersion,
    generatedAt: safeTimestamp(source.generatedAt),
    readOnly: true,
    authority: source.authority,
    status: snapshotStatus(source),
    lead: {
      heldBy: safeIdentifier(source.lead?.heldBy, 80) || 'none',
      since: safeTimestamp(source.lead?.since),
    },
    summary: summaryProjection(source.summary),
    coverage: coverageProjection(source.coverage),
    sources: sourceProjection(source.sources),
    runtime: {
      layers: capArray(source.runtimeLayers, 10).map(runtimeLayer),
      agents: capArray(source.agents, FULL_SNAPSHOT_CAPS.agents).map(agentSummary),
      agentCount: asArray(source.agents).length,
    },
    schedules: {
      count: automations.length,
      observed: nonNegativeNumber(source.summary?.observedAutomations),
      failing: failingAutomations.length,
      entries: capArray(automations, FULL_SNAPSHOT_CAPS.automations).map(automationSummary),
    },
    pipeline: {
      sourceOfTruth: 'mongodb:pipelinetasks',
      contentScope: 'Non-private programme task summaries; specs, feedback, and personal/family rows are withheld.',
      counts: safeCounts(source.work?.counts),
      countsComplete: source.work?.countsComplete === true,
      countsBasis: source.work?.countsComplete === true ? 'exact-or-complete-schema-5-pipeline-counts' : 'incomplete-schema-5-pipeline-counts',
      countScope: 'all-pipeline-statuses',
      activeCount: activeWork.length,
      visibleActiveCount: visibleActiveWork.length,
      withheldActiveCount: activeWork.length - visibleActiveWork.length,
      active: capArray(visibleActiveWork, FULL_SNAPSHOT_CAPS.pipelineActive),
      recent: capArray(visibleRecentWork, FULL_SNAPSHOT_CAPS.pipelineRecent),
    },
    alerts: {
      authority: safeIdentifier(source.alertEvidence?.authority, 100) || 'agentx-product-alerts',
      basis: source.alertEvidence?.degraded === true ? 'bounded-product-ecosystem-fallback' : 'product-active-alert-list',
      available: source.alertEvidence?.available === true,
      countComplete: source.alertEvidence?.countComplete === true,
      activeCount: activeAlertCount,
      projectedCount: alerts.length,
      returnedCount: returnedAlerts.length,
      countsBySeverity: countBy(alerts, 'severity', 'unknown'),
      active: returnedAlerts,
    },
    operatorWarnings: {
      count: warnings.length,
      countsBySeverity: countBy(warnings, 'severity', 'warning'),
      records: capArray(warnings, FULL_SNAPSHOT_CAPS.drift),
    },
    drift: {
      available: true,
      complete: false,
      basis: 'explicit-source-and-automation-state-comparisons',
      count: driftRecords.length,
      bySeverity: countBy(driftRecords, 'severity', 'warning'),
      byType: countBy(driftRecords, 'type', 'warning'),
      records: capArray(driftRecords, FULL_SNAPSHOT_CAPS.drift),
    },
    recommendations: capArray(recommendations, FULL_SNAPSHOT_CAPS.recommendations),
    capabilities: capArray(source.capabilities, 20).map(capabilitySummary),
    responsibilities: {
      summary: safeCounts(source.responsibilities?.summary),
      lanes: capArray(source.responsibilities?.lanes, FULL_SNAPSHOT_CAPS.responsibilityLanes).map(responsibilityLane),
      unassignedCount: asArray(source.responsibilities?.unassigned).length,
      duplicateScopeCount: asArray(source.responsibilities?.duplicateScopes).length,
    },
    activity: {
      counts: safeCounts(source.activity?.counts),
      items: capArray(activityItems, FULL_SNAPSHOT_CAPS.activity),
    },
    _mcp: {
      owner: 'aio-ops-runtime-bridges',
      version: '1.2.0',
      caps: FULL_SNAPSHOT_CAPS,
      capped: {
        agents: asArray(source.agents).length > FULL_SNAPSHOT_CAPS.agents,
        automations: automations.length > FULL_SNAPSHOT_CAPS.automations,
        pipelineActive: visibleActiveWork.length > FULL_SNAPSHOT_CAPS.pipelineActive,
        pipelineRecent: visibleRecentWork.length > FULL_SNAPSHOT_CAPS.pipelineRecent,
        privatePipelineRecords: activeWork.length !== visibleActiveWork.length || recentWork.length !== visibleRecentWork.length,
        alerts: alerts.length > FULL_SNAPSHOT_CAPS.alerts,
        drift: driftRecords.length > FULL_SNAPSHOT_CAPS.drift,
        recommendations: recommendations.length > FULL_SNAPSHOT_CAPS.recommendations,
        summaryOnly: false,
      },
      note: 'Every MCP field is explicitly allowlisted; arrays and strings are bounded for transport.',
    },
  };
}

function fitSnapshotPayload(payload, _projection, maxChars) {
  const rendered = JSON.stringify(payload);
  if (rendered.length <= maxChars) return payload;
  const fallback = {
    mode: payload.mode,
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    readOnly: true,
    authority: payload.authority,
    status: payload.status,
    truncated: true,
    maxChars,
    originalChars: rendered.length,
    lead: payload.lead,
    summary: payload.summary,
    coverage: payload.coverage,
    sources: payload.sources,
    runtime: { layers: payload.runtime.layers, agentCount: payload.runtime.agentCount, agents: [] },
    schedules: { ...payload.schedules, entries: [] },
    pipeline: { ...payload.pipeline, active: [], recent: [] },
    alerts: { ...payload.alerts, returnedCount: 0, active: [] },
    operatorWarnings: { ...payload.operatorWarnings, records: [] },
    drift: { ...payload.drift, records: [] },
    recommendations: [],
    capabilities: payload.capabilities,
    responsibilities: { ...payload.responsibilities, lanes: [] },
    activity: { ...payload.activity, items: [] },
    _mcp: {
      ...payload._mcp,
      capped: { ...payload._mcp.capped, summaryOnly: true },
      note: 'The requested character ceiling required a summary-only response; complete counts remain available.',
    },
  };
  if (JSON.stringify(fallback).length <= maxChars) return fallback;
  throw new EcosystemSnapshotMcpError(
    `maxChars ${maxChars} cannot contain the bounded ecosystem snapshot summary`,
    'ECOSYSTEM_SNAPSHOT_MAX_CHARS_TOO_SMALL'
  );
}

function validateArguments(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EcosystemSnapshotMcpError('arguments must be an object', 'INVALID_ARGUMENTS');
  }
  const unknown = Object.keys(value).filter((key) => !['mode', 'maxChars'].includes(key));
  if (unknown.length) {
    throw new EcosystemSnapshotMcpError(`unsupported argument: ${unknown[0]}`, 'INVALID_ARGUMENTS');
  }
  const mode = value.mode === undefined ? 'full' : value.mode;
  if (mode !== 'full') {
    throw new EcosystemSnapshotMcpError(`unsupported ecosystem snapshot mode: ${mode}`, 'INVALID_ARGUMENTS');
  }
  const maxChars = value.maxChars === undefined ? 60000 : value.maxChars;
  if (!Number.isInteger(maxChars) || maxChars < 5000 || maxChars > 60000) {
    throw new EcosystemSnapshotMcpError('maxChars must be an integer from 5000 through 60000', 'INVALID_ARGUMENTS');
  }
  return { mode, maxChars };
}

function resultPayload(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function errorPayload(error) {
  const expected = error instanceof EcosystemSnapshotMcpError;
  const structuredContent = {
    error: error.code || 'ECOSYSTEM_SNAPSHOT_ERROR',
    message: expected ? error.message : 'Agent Ops projection could not be collected.',
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

async function callEcosystemSnapshot(args, { projectionProvider }) {
  try {
    const { maxChars } = validateArguments(args);
    if (typeof projectionProvider !== 'function') {
      throw new EcosystemSnapshotMcpError('Agent Ops projection provider is unavailable', 'ECOSYSTEM_SNAPSHOT_UNAVAILABLE');
    }
    const projection = validateProjection(await projectionProvider());
    return resultPayload(fitSnapshotPayload(buildFullSnapshot(projection), projection, maxChars));
  } catch (error) {
    return errorPayload(error);
  }
}

function mergeTools(body, { enabled = true } = {}) {
  if (!enabled || !Array.isArray(body?.result?.tools)) return body;
  const collisions = body.result.tools.filter((tool) => tool?.name === ECOSYSTEM_SNAPSHOT_TOOL.name);
  const ownershipMatches = collisions.every((tool) =>
    tool?._meta?.['agentx/owner'] === ECOSYSTEM_SNAPSHOT_TOOL._meta['agentx/owner']
      && tool?._meta?.['agentx/version'] === ECOSYSTEM_SNAPSHOT_TOOL._meta['agentx/version']);
  if (!ownershipMatches) {
    return {
      jsonrpc: body.jsonrpc || '2.0',
      id: body.id ?? null,
      error: {
        code: -32009,
        message: 'MCP tool ownership collision',
        data: { code: 'MCP_TOOL_OWNERSHIP_COLLISION', tool: ECOSYSTEM_SNAPSHOT_TOOL.name }
      }
    };
  }
  let inserted = false;
  const tools = [];
  for (const tool of body.result.tools) {
    if (tool?.name !== ECOSYSTEM_SNAPSHOT_TOOL.name) {
      tools.push(tool);
    } else if (!inserted) {
      tools.push(ECOSYSTEM_SNAPSHOT_TOOL);
      inserted = true;
    }
  }
  if (!inserted) tools.push(ECOSYSTEM_SNAPSHOT_TOOL);
  return { ...body, result: { ...body.result, tools } };
}

function ecosystemSnapshotMcpMiddleware({ projectionProvider }) {
  return async (req, res, next) => {
    const message = req.body;
    if (req.method !== 'POST' || !message || message.jsonrpc !== '2.0') return next();
    if (message.method === 'tools/list') {
      const downstreamJson = res.json.bind(res);
      res.json = (body) => downstreamJson(mergeTools(body));
      return next();
    }
    const name = message.method === 'tools/call' ? message.params?.name : null;
    if (name !== ECOSYSTEM_SNAPSHOT_TOOL.name) return next();
    if (message.id === undefined || message.id === null) return res.status(204).end();
    const result = await callEcosystemSnapshot(message.params?.arguments, { projectionProvider });
    return res.json({ jsonrpc: '2.0', id: message.id, result });
  };
}

function registerEcosystemSnapshotMcp({ app, standardJsonParser, projectionProvider }) {
  const middleware = ecosystemSnapshotMcpMiddleware({ projectionProvider });
  app.use(['/mcp', '/api/mcp'], standardJsonParser, middleware);
  return middleware;
}

module.exports = {
  ECOSYSTEM_SNAPSHOT_TOOL,
  EcosystemSnapshotMcpError,
  FULL_SNAPSHOT_CAPS,
  buildFullSnapshot,
  callEcosystemSnapshot,
  ecosystemSnapshotMcpMiddleware,
  fitSnapshotPayload,
  mergeTools,
  registerEcosystemSnapshotMcp,
  validateArguments,
  validateProjection,
};
