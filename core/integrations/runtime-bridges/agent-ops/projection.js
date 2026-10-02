'use strict';

const fs = require('fs/promises');
const path = require('path');

const DEFAULT_REPO_ROOT = '/etc/agentx';
const DEFAULT_TIMEOUT_MS = 5_000;
const PIPELINE_LIST_LIMIT = 1_000;
const PIPELINE_LIST_ROUTE = `/api/pipeline/tasks?view=summary&includeDone=true&limit=${PIPELINE_LIST_LIMIT}`;
const ALERT_LIST_LIMIT = 100;
const ALERT_LIST_ROUTE = `/api/alerts?status=active&limit=${ALERT_LIST_LIMIT}&skip=0`;
const PIPELINE_STATUSES = ['queued', 'in_progress', 'review', 'blocked', 'done'];
const PIPELINE_ACTIVE_STATUSES = new Set(['queued', 'in_progress', 'review', 'blocked']);
const DEFAULT_MANIFEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OPENCLAW_MANIFEST_SCHEMA_VERSION = 2;
const OPENCLAW_MANIFEST_GENERATOR = 'agentx-core/openclawAgentInventoryService';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/<br\s*\/?>/gi, ' · ')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function scalar(value) {
  const text = String(value || '').trim().replace(/\s+#.*$/, '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  return text;
}

function humanize(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function agentKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function isoFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number' || /^\d+$/.test(String(value))
    ? new Date(Number(value))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeDiagnostic(value, max = 500) {
  const text = cleanText(value)
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  return text ? text.slice(0, max) : null;
}

function failedStatus(value) {
  return ['error', 'failed', 'failure'].includes(String(value || '').trim().toLowerCase());
}

function automationHistory(job) {
  const history = asArray(job.history).map((run) => ({
    at: isoFrom(run.atMs ?? run.runAtMs ?? run.startedAtMs ?? run.timestamp ?? run.at),
    status: run.status || run.runStatus || run.result || null,
    durationMs: Number(run.durationMs || run.elapsedMs || 0) || null,
    error: failedStatus(run.status || run.runStatus || run.result)
      ? safeDiagnostic(run.error || run.message)
      : null,
  })).filter((run) => run.at);
  const latestStatus = job.lastRunStatus || job.lastStatus || null;
  const latest = {
    at: isoFrom(job.lastRunAtMs),
    status: latestStatus,
    durationMs: Number(job.lastDurationMs || 0) || null,
    error: failedStatus(latestStatus) || Number(job.consecutiveErrors || 0) > 0
      ? safeDiagnostic(job.lastError || 'Runtime reported an automation failure.')
      : null,
  };
  if (latest.at && !history.some((run) => run.at === latest.at)) history.unshift(latest);
  return history
    .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
    .slice(0, 10);
}

function parseAgentRegistry(source) {
  const agents = [];
  let inAgents = false;
  let current = null;
  let list = null;
  let inModel = false;

  for (const rawLine of String(source || '').split(/\r?\n/)) {
    if (/^agents:\s*$/.test(rawLine)) { inAgents = true; continue; }
    if (inAgents && /^\S/.test(rawLine) && !/^agents:/.test(rawLine)) break;
    if (!inAgents || /^\s*#/.test(rawLine)) continue;

    const start = rawLine.match(/^  ([a-z0-9_]+):\s*$/i);
    if (start) {
      current = { id: start[1], owns: [], defaultScope: [], model: { primary: null, fallbacks: [] } };
      agents.push(current);
      list = null;
      inModel = false;
      continue;
    }
    if (!current) continue;

    const property = rawLine.match(/^    ([a-z0-9_]+):(?:\s*(.*))?$/i);
    if (property) {
      const [, key, rawValue = ''] = property;
      list = ['owns', 'default_scope'].includes(key) ? key : null;
      inModel = key === 'model';
      if (rawValue) {
        if (key === 'default_scope') current.defaultScope = [scalar(rawValue)];
        else if (key !== 'model') current[key] = scalar(rawValue);
      }
      continue;
    }
    const modelProperty = inModel && rawLine.match(/^      (primary|current_primary|fallbacks):(?:\s*(.*))?$/);
    if (modelProperty) {
      const [, key, rawValue = ''] = modelProperty;
      if (key === 'fallbacks') list = 'model_fallbacks';
      else if (rawValue && !current.model.primary) current.model.primary = scalar(rawValue);
      continue;
    }
    const item = rawLine.match(/^      -\s+(.+)$/);
    const nestedItem = rawLine.match(/^        -\s+(.+)$/);
    if (item && list === 'owns') current.owns.push(scalar(item[1]));
    else if (item && list === 'default_scope') current.defaultScope.push(scalar(item[1]));
    else if (nestedItem && list === 'model_fallbacks') current.model.fallbacks.push(scalar(nestedItem[1]));
  }
  return agents;
}

function parseRuntimeStatus(source, runtimeId) {
  let inRuntimes = false;
  let inRuntime = false;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    if (/^runtimes:\s*$/.test(rawLine)) { inRuntimes = true; continue; }
    if (inRuntimes && /^\S/.test(rawLine)) break;
    if (!inRuntimes || /^\s*#/.test(rawLine)) continue;
    const runtime = rawLine.match(/^  ([a-z0-9_-]+):\s*$/i);
    if (runtime) {
      inRuntime = runtime[1] === runtimeId;
      continue;
    }
    if (!inRuntime) continue;
    const status = rawLine.match(/^    status:\s*(.+?)\s*$/i);
    if (status) return scalar(status[1]);
  }
  return null;
}

function parseOpenClawManifest(source) {
  const agents = [];
  let inAgents = false;
  let current = null;
  let section = null;
  let list = null;
  for (const rawLine of String(source || '').split(/\r?\n/)) {
    if (/^agents:\s*$/.test(rawLine)) { inAgents = true; continue; }
    if (inAgents && /^\S/.test(rawLine)) break;
    if (!inAgents) continue;
    const start = rawLine.match(/^  - id:\s*(.+)$/);
    if (start) {
      current = { id: scalar(start[1]), name: null, active: true, default: false, model: { primary: null, fallbacks: [] } };
      agents.push(current);
      section = null;
      list = null;
      continue;
    }
    if (!current) continue;
    const top = rawLine.match(/^    (name|active|default):\s*(.+)$/);
    if (top) { current[top[1]] = scalar(top[2]); continue; }
    const sectionStart = rawLine.match(/^    (identity|model):\s*$/);
    if (sectionStart) { section = sectionStart[1]; list = null; continue; }
    const item = rawLine.match(/^        -\s+(.+)$/);
    if (item && list === 'fallbacks') { current.model.fallbacks.push(scalar(item[1])); continue; }
    const nested = rawLine.match(/^      (name|primary|fallbacks):(?:\s*(.*))?$/);
    if (!nested) continue;
    const [, key, rawValue = ''] = nested;
    if (section === 'identity' && key === 'name' && rawValue) current.name = scalar(rawValue);
    if (section === 'model' && key === 'primary' && rawValue) current.model.primary = scalar(rawValue);
    if (section === 'model' && key === 'fallbacks') list = 'fallbacks';
  }
  return agents;
}

function openClawManifestProvenance(source, { now = new Date(), maxAgeMs = DEFAULT_MANIFEST_MAX_AGE_MS } = {}) {
  const generatedAt = isoFrom(scalar(String(source || '').match(/^generated_at:\s*(.+)$/m)?.[1] || ''));
  const generatedBy = scalar(String(source || '').match(/^generated_by:\s*(.+)$/m)?.[1] || '') || null;
  const schemaVersion = Number(String(source || '').match(/^schema_version:\s*(\d+)\s*$/m)?.[1] || 0) || null;
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const generatedMs = generatedAt ? new Date(generatedAt).getTime() : NaN;
  const ageMs = Number.isFinite(generatedMs) && Number.isFinite(nowMs) ? nowMs - generatedMs : null;
  let status = 'fresh';
  const issues = [];
  if (!generatedAt
      || generatedBy !== OPENCLAW_MANIFEST_GENERATOR
      || schemaVersion !== OPENCLAW_MANIFEST_SCHEMA_VERSION) {
    status = 'invalid';
    issues.push('OPENCLAW_MANIFEST_PROVENANCE_INVALID');
  } else if (ageMs < -5 * 60 * 1000) {
    status = 'invalid';
    issues.push('OPENCLAW_MANIFEST_TIMESTAMP_IN_FUTURE');
  } else if (ageMs > maxAgeMs) {
    status = 'stale';
    issues.push('OPENCLAW_MANIFEST_STALE');
  }
  return {
    status,
    usable: status === 'fresh',
    schemaVersion,
    generatedAt,
    generatedBy,
    ageMs,
    maxAgeMs,
    authority: 'config/openclaw-agent-manifest.yml',
    issues
  };
}

function parseLead(source) {
  const heldBy = String(source || '').match(/^held_by:\s*(\S*)/m)?.[1] || 'none';
  const since = String(source || '').match(/^since:\s*(\S*)/m)?.[1] || null;
  const notes = String(source || '').match(/^notes:\s*(.+)$/m)?.[1] || '';
  return { heldBy, since: isoFrom(since), notes: scalar(notes) };
}

function parseScheduled(source) {
  const lines = String(source || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Active\s*$/.test(line));
  if (start < 0) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/.test(line)) break;
    if (!/^\|/.test(line) || /^\|\s*(?:---|What\s*\|)/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map(cleanText);
    if (cells.length !== 6) continue;
    const [name, cadence, owner, trigger, purpose, sourceRef] = cells;
    rows.push({
      id: `documented-${agentKey(name)}`,
      name, cadence, owner, trigger, purpose, source: sourceRef,
      ownerId: inferOwnerId(owner, trigger),
      confidence: 'documented',
      health: 'documented',
      enabled: true,
      lastRun: null,
      nextRunAt: null,
      lastStatus: null,
      lastError: null,
    });
  }
  return rows;
}

function inferOwnerId(owner, trigger) {
  const text = `${owner} ${trigger}`.toLowerCase();
  for (const [needle, id] of [
    ['clawdx', 'clawdx-coder'], ['deepcoding', 'deepcoding'], ['overseer', 'overseer'],
    ['leadx', 'leadx'], ['openclaw `main`', 'main'], ['nestor', 'main'], ['secretary', 'main'],
    ['hermes', 'hermes'], ['codex', 'codex'], ['agentx-core', 'agentx-core']
  ]) if (text.includes(needle)) return id;
  return null;
}

async function readText(file) {
  return fs.readFile(file, 'utf8');
}

async function fetchJson(baseUrl, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await (options.fetchImpl || fetch)(`${baseUrl}${route}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      statusCode: response.status,
      body,
      durationMs: Date.now() - started,
      error: response.ok ? null : (body.message || body.error || `HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, statusCode: null, body: null, durationMs: Date.now() - started, error: error.message };
  } finally { clearTimeout(timer); }
}

async function settled(label, work) {
  const started = Date.now();
  try {
    const value = await work;
    return { label, ok: true, value, durationMs: Date.now() - started, error: null };
  } catch (error) {
    return { label, ok: false, value: null, durationMs: Date.now() - started, error: error.message };
  }
}

function pipelineContract(result) {
  if (!result?.ok) {
    return { valid: false, issueCode: null, tasks: [], count: null };
  }
  const body = result.body;
  const data = body?.data;
  const count = data?.count;
  if (body?.status !== 'success' || !data || typeof data !== 'object' || Array.isArray(data)
    || !Array.isArray(data.tasks) || !Number.isInteger(count) || count < 0
    || count !== data.tasks.length) {
    return {
      valid: false,
      issueCode: 'AGENT_OPS_PIPELINE_SCHEMA_INVALID',
      tasks: [],
      count: null
    };
  }
  return { valid: true, issueCode: null, tasks: data.tasks, count };
}

function pipelineTasks(result) {
  return pipelineContract(result).tasks.map((task) => ({
    pipelineId: task?.pipelineId || null,
    title: String(task?.title || '').slice(0, 240),
    service: task?.service || '',
    status: task?.status || null,
    assignee: task?.assignee || null,
    heartbeatAt: task?.heartbeatAt || null,
    epic: String(task?.epic || '').slice(0, 240),
    source: task?.source || null,
    priority: Number.isFinite(Number(task?.priority)) ? Number(task.priority) : null,
    dependsOn: asArray(task?.dependsOn).slice(0, 20),
    notBefore: task?.notBefore || null,
    dueAt: task?.dueAt || null,
    risk: task?.risk || null,
    planningItemIds: asArray(task?.planningItemIds).slice(0, 20),
    scheduleEntryIds: asArray(task?.scheduleEntryIds).slice(0, 20),
    createdAt: task?.createdAt || null,
    updatedAt: task?.updatedAt || null,
  }));
}

function pipelineCounts(result, tasks) {
  const counts = Object.fromEntries(PIPELINE_STATUSES.map((status) => [status, 0]));
  if (!result?.ok) return { counts, complete: false, basis: 'pipeline source unavailable' };
  const contract = pipelineContract(result);
  if (!contract.valid) {
    return {
      counts,
      complete: false,
      basis: 'pipeline response schema invalid',
      issueCode: contract.issueCode
    };
  }
  for (const task of tasks) {
    const status = String(task?.status || 'unknown');
    if (/^[a-z][a-z0-9_-]{0,39}$/i.test(status)) counts[status] = (counts[status] || 0) + 1;
  }
  return {
    counts,
    complete: contract.count < PIPELINE_LIST_LIMIT,
    basis: contract.count < PIPELINE_LIST_LIMIT
      ? 'validated complete pipeline page below the route ceiling'
      : `summary rows capped at ${PIPELINE_LIST_LIMIT}`,
    issueCode: null
  };
}

function mergeAutomations(runtimeJobs, documented) {
  const live = asArray(runtimeJobs).map((job) => {
    const lastStatus = String(job.lastRunStatus || job.lastStatus || '').toLowerCase();
    const lastRun = isoFrom(job.lastRunAtMs);
    const failed = Number(job.consecutiveErrors || 0) > 0 || ['error', 'failed'].includes(lastStatus);
    const health = job.enabled === false ? 'paused'
      : isoFrom(job.runningAtMs) ? 'running'
      : failed ? 'error'
      : !lastRun ? 'unknown'
      : ['ok', 'success'].includes(lastStatus) ? 'healthy'
      : lastStatus === 'skipped' ? 'skipped' : 'unknown';
    return {
      id: job.id || `live-${agentKey(job.name)}`,
      name: job.name || job.id || 'Unnamed automation',
      ownerId: job.agentId || null,
      owner: job.agentId || null,
      cadence: typeof job.schedule === 'string' ? job.schedule : JSON.stringify(job.schedule || {}),
      trigger: 'Official OpenClaw cron',
      purpose: job.description || '',
      source: 'official-openclaw-cli',
      confidence: 'live',
      health,
      enabled: job.enabled !== false,
      lastRun,
      runningSince: isoFrom(job.runningAtMs),
      nextRunAt: isoFrom(job.nextRunAtMs),
      lastStatus: job.lastRunStatus || job.lastStatus || null,
      lastError: failed
        ? safeDiagnostic(job.lastError || 'Runtime reported an automation failure.')
        : null,
      lastDurationMs: safeMetricValue(job.lastDurationMs),
      consecutiveErrors: Number(job.consecutiveErrors || 0),
      history: automationHistory(job),
    };
  });
  const liveEvidence = live.map((item) => `${item.id} ${item.name}`.toLowerCase()).join('\n');
  const unmatched = documented.filter((item) => {
    const source = `${item.source} ${item.trigger}`.toLowerCase();
    return !live.some((liveItem) => source.includes(String(liveItem.id).toLowerCase())
      || source.includes(String(liveItem.name).toLowerCase())
      || liveEvidence.includes(item.name.toLowerCase()));
  });
  return [...live, ...unmatched];
}

function safeIdentifier(value, max = 120) {
  const text = String(value || '').trim().slice(0, max);
  return /^[a-z0-9][a-z0-9_.:-]*$/i.test(text) ? text : null;
}

function safeMetricValue(value) {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function safeAlertRecord(alert) {
  return {
    id: safeIdentifier(alert?._id || alert?.id, 80),
    ruleId: safeIdentifier(alert?.ruleId, 120),
    severity: safeIdentifier(alert?.severity, 20) || 'unknown',
    status: safeIdentifier(alert?.status, 30) || 'active',
    source: safeIdentifier(alert?.source, 80),
    component: safeIdentifier(alert?.context?.component, 120),
    metric: safeIdentifier(alert?.context?.metric, 120),
    currentValue: safeMetricValue(alert?.context?.currentValue),
    threshold: safeMetricValue(alert?.context?.threshold),
    trend: safeIdentifier(alert?.context?.trend, 40),
    occurrenceCount: Math.max(1, Number(alert?.occurrenceCount) || 1),
    lastOccurrence: isoFrom(alert?.lastOccurrence || alert?.createdAt || alert?.timestamp),
    createdAt: isoFrom(alert?.createdAt),
    localLogRecorded: alert?.delivery?.local_log?.sent === true,
  };
}

function productAlertEvidence(result, ecosystemSnapshot) {
  const response = result?.ok ? result.value : null;
  const body = response?.body;
  const data = body?.data;
  if (response?.ok
    && body?.status === 'success'
    && Array.isArray(data?.alerts)
    && Number.isInteger(Number(data?.total))
    && Number(data.total) >= 0) {
    const total = Number(data.total);
    const records = data.alerts.slice(0, ALERT_LIST_LIMIT).map(safeAlertRecord);
    return {
      available: true,
      degraded: false,
      authority: 'agentx-product-alerts',
      basis: ALERT_LIST_ROUTE,
      activeCount: total,
      returnedCount: records.length,
      countComplete: records.length === total,
      records,
      issueCode: null,
    };
  }

  const records = asArray(ecosystemSnapshot?.alerts).map(safeAlertRecord);
  return {
    available: true,
    degraded: true,
    authority: 'agentx-product-ecosystem-alert-fallback',
    basis: '/api/nerve-center/ecosystem bounded active-alert fallback',
    activeCount: records.length,
    returnedCount: records.length,
    countComplete: false,
    records,
    issueCode: 'AGENT_OPS_ALERT_LIST_UNAVAILABLE',
  };
}

function mergeAgents(registryAgents, manifestAgents, runtimeAgents, sessions, automations, tasks, lead) {
  const declared = new Map();
  const add = (agent, source) => {
    const id = agentKey(agent.id);
    if (!id) return;
    const existing = declared.get(id) || { id, registryId: id, model: { primary: null, fallbacks: [] } };
    declared.set(id, {
      ...existing,
      ...agent,
      id,
      registryId: existing.registryId || id,
      model: { ...existing.model, ...(agent.model || {}) },
      modelAuthority: agent.model?.primary || asArray(agent.model?.fallbacks).length
        ? source
        : existing.modelAuthority,
      declaredFrom: [...new Set([...(existing.declaredFrom || []), source])],
    });
  };
  registryAgents.forEach((agent) => add(agent, 'agent-registry'));
  manifestAgents.forEach((agent) => add({ ...agent, runtime: 'openclaw' }, 'openclaw-manifest'));
  runtimeAgents.forEach((agent) => add({ ...agent, runtime: 'openclaw', observed: true }, 'openclaw-runtime'));

  return [...declared.values()].map((agent) => {
    const id = agentKey(agent.id);
    const ownedAutomations = automations.filter((item) => agentKey(item.ownerId || item.owner) === id);
    const ownedWork = tasks.filter((item) => agentKey(item.assignee) === id);
    const ownedSessions = sessions.filter((item) => agentKey(item.agentId) === id);
    const isLead = agentKey(lead.heldBy) === id;
    const status = isLead ? 'lead' : agent.observed ? 'observed' : agent.runtime === 'openclaw' ? 'unobserved' : 'registered';
    const displayName = agent.identity?.name || agent.name || agent.persona || (id === 'main' ? 'Nestor' : humanize(id));
    return {
      id,
      registryId: id,
      name: displayName,
      type: agent.type || (agent.runtime === 'openclaw' ? 'openclaw_agent' : 'agent'),
      runtime: agent.runtime || null,
      status,
      isLead,
      responsibility: agent.boundary || agent.responsibility || `${humanize(agent.type || 'agent')} operating role.`,
      owns: asArray(agent.owns),
      model: {
        primary: agent.model?.primary || agent.model?.current_primary || null,
        fallbacks: asArray(agent.model?.fallbacks),
        source: agent.modelAuthority || (agent.observed ? 'openclaw-runtime' : 'not declared'),
      },
      automationCount: ownedAutomations.length,
      workCount: ownedWork.length,
      blockedWorkCount: ownedWork.filter((item) => item.status === 'blocked').length,
      sessionCount: ownedSessions.length,
      lastSessionAt: ownedSessions.map((item) => isoFrom(item.updatedAt)).filter(Boolean).sort().reverse()[0] || null,
      observedFrom: agent.observed ? 'official OpenClaw evidence' : agent.declaredFrom?.join(', '),
      confidence: agent.observed ? 'live' : 'configured',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function buildResponsibilities(agents, automations, tasks, capabilities) {
  const lanes = agents.map((agent) => {
    const ownedAutomations = automations.filter((item) => agentKey(item.ownerId || item.owner) === agentKey(agent.id));
    const ownedWork = tasks.filter((item) => agentKey(item.assignee) === agentKey(agent.id));
    const signalCount = ownedAutomations.length + ownedWork.length;
    return {
      agentId: agent.registryId,
      name: agent.name,
      status: agent.status,
      responsibility: agent.responsibility,
      scopes: agent.owns,
      automations: ownedAutomations.map((item) => ({ id: item.id, name: item.name, status: item.health })),
      work: ownedWork.map((item) => ({ id: item.pipelineId, name: item.title, status: item.status })),
      signalCount,
      blockedCount: ownedWork.filter((item) => item.status === 'blocked').length,
      load: signalCount > 6 ? 'high' : signalCount > 2 ? 'medium' : 'low',
    };
  });
  const unassigned = [
    ...automations.filter((item) => !item.ownerId && !item.owner).map((item) => ({ kind: 'automation', name: item.name, owner: 'none' })),
    ...tasks.filter((item) => !item.assignee).map((item) => ({ kind: 'work', name: `#${item.pipelineId} ${item.title}`, owner: 'none' })),
  ];
  const totalSignals = automations.length + tasks.length;
  const attributedSignals = totalSignals - unassigned.length;
  return {
    summary: {
      totalSignals,
      attributedSignals,
      coveragePct: totalSignals ? Math.round((attributedSignals / totalSignals) * 100) : 100,
      unassignedSignals: unassigned.length,
      duplicateScopes: 0,
      agentsWithoutSignals: lanes.filter((lane) => lane.signalCount === 0).length,
    },
    lanes,
    unassigned: unassigned.slice(0, 40),
    duplicateScopes: [],
    capabilities,
  };
}

function buildActivity(automations, tasks, sessions, sources) {
  const items = [];
  for (const item of automations) if (item.lastRun) items.push({
    id: `automation-${item.id}-${item.lastRun}`,
    kind: 'automation', targetId: item.id, ownerId: item.ownerId,
    title: `${item.name} · ${item.lastStatus || item.health}`,
    detail: item.lastError || (item.lastDurationMs ? `Completed in ${item.lastDurationMs} ms.` : 'Runtime receipt recorded.'),
    evidence: item.source, status: item.health, timestamp: item.lastRun,
  });
  for (const task of tasks) if (task.updatedAt) items.push({
    id: `work-${task.pipelineId}-${task.updatedAt}`,
    kind: 'work', targetId: task.pipelineId, ownerId: task.assignee,
    title: `#${task.pipelineId} ${task.title}`,
    detail: `${humanize(task.status)}${task.epic ? ` · ${task.epic}` : ''}`,
    evidence: 'Mongo pipeline', status: task.status, timestamp: task.updatedAt,
  });
  for (const [index, session] of sessions.entries()) if (session.updatedAt) items.push({
    id: `session-${index}-${session.updatedAt}`,
    kind: 'session', targetId: session.agentId, ownerId: session.agentId,
    title: `${humanize(session.agentId || 'OpenClaw')} session`,
    detail: `${session.model || session.configuredModel || 'model unknown'} · ${Number(session.totalTokens || 0).toLocaleString()} tokens`,
    evidence: 'official OpenClaw CLI', status: session.abortedLastRun ? 'error' : 'observed', timestamp: session.updatedAt,
  });
  for (const [id, source] of Object.entries(sources)) if (source.status !== 'ok') items.push({
    id: `source-${id}`, kind: 'source', targetId: id, ownerId: null,
    title: `${humanize(id)} source is ${source.status}`,
    detail: asArray(source.issues)[0] || 'Source evidence is incomplete.',
    evidence: source.authority || 'projection', status: source.status, timestamp: new Date().toISOString(),
  });
  items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return { items: items.slice(0, 150), counts: items.reduce((out, item) => ({ ...out, [item.kind]: (out[item.kind] || 0) + 1 }), {}) };
}

function sourceState(status, authority, durationMs, issues = []) {
  return { status, authority, durationMs, issues: asArray(issues).filter(Boolean) };
}

const SUPPORTED_ECOSYSTEM_SNAPSHOT_SCHEMAS = new Set([1, 2]);

function requireEcosystemSnapshot(result) {
  const response = result?.ok ? result.value : null;
  const body = response?.body;
  const snapshot = body?.data;
  if (!response?.ok) {
    const reason = safeDiagnostic(result?.error || response?.error || `HTTP ${response?.statusCode || 'unavailable'}`);
    const error = new Error(`Required AgentX ecosystem snapshot is unavailable: ${reason || 'request failed'}`);
    error.code = 'AGENT_OPS_ECOSYSTEM_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const schemaVersion = snapshot?.schemaVersion;
  const v2EvidenceTrust = snapshot?.evidenceTrust;
  if (body?.status !== 'success'
    || !SUPPORTED_ECOSYSTEM_SNAPSHOT_SCHEMAS.has(schemaVersion)
    || snapshot?.authority !== 'agentx-product'
    || snapshot?.readOnly !== true
    || !snapshot?.health
    || !['ok', 'degraded'].includes(snapshot.health.status)
    || !Number.isInteger(snapshot.health.configuredHosts)
    || !Number.isInteger(snapshot.health.onlineHosts)
    || !Number.isInteger(snapshot.health.observedModels)
    || !Array.isArray(snapshot?.cluster)
    || !Array.isArray(snapshot?.alerts)
    || !snapshot?.routing
    || !snapshot?.routingConfig
    || (schemaVersion === 2 && (
      v2EvidenceTrust?.schemaVersion !== 1
      || !['verified', 'inconsistent', 'stale', 'partial', 'contradictory'].includes(v2EvidenceTrust?.status)
      || v2EvidenceTrust?.operationalStatus !== snapshot.health.status
      || v2EvidenceTrust?.contradictionBudget?.allowed !== 0
      || typeof v2EvidenceTrust?.contradictionBudget?.withinBudget !== 'boolean'
    ))) {
    const error = new Error('Required AgentX ecosystem snapshot failed contract validation');
    error.code = 'AGENT_OPS_ECOSYSTEM_INVALID';
    error.statusCode = 503;
    throw error;
  }
  return snapshot;
}

async function buildAgentOpsProjection(options = {}) {
  const repoRoot = options.repoRoot || process.env.AGENTX_INSTANCE_ROOT || process.env.AGENTX_REPO_ROOT || DEFAULT_REPO_ROOT;
  const coreBaseUrl = String(options.coreBaseUrl || `http://127.0.0.1:${process.env.PORT || 3080}`).replace(/\/$/, '');
  const read = options.readText || readText;
  const get = options.fetchJson || ((route) => fetchJson(coreBaseUrl, route, options));
  const now = options.now || (() => new Date());

  const registryInput = await settled('registry', read(path.join(repoRoot, 'config/agent-registry.yml')));
  const hermesRuntimeStatus = registryInput.ok ? parseRuntimeStatus(registryInput.value, 'hermes') : null;
  const hermesExpected = !String(hermesRuntimeStatus || '').startsWith('retired');
  const [manifestInput, scheduledInput, leadInput, pipeline, ecosystem, alerts, budget, hermes, openclaw] = await Promise.all([
    settled('manifest', read(path.join(repoRoot, 'config/openclaw-agent-manifest.yml'))),
    settled('schedules', read(path.join(repoRoot, 'SCHEDULED.md'))),
    settled('lead', read(path.join(repoRoot, 'LEAD.md'))),
    settled('pipeline', get(PIPELINE_LIST_ROUTE)),
    settled('ecosystem', get('/api/nerve-center/ecosystem')),
    settled('alerts', get(ALERT_LIST_ROUTE)),
    settled('budget', get('/api/budget/status')),
    settled('hermes', get('/api/hermes/status')),
    settled('openclaw', options.getOpenClawRuntimeEvidence ? options.getOpenClawRuntimeEvidence() : Promise.resolve(options.openclawEvidence || null)),
  ]);

  const registryAgents = registryInput.ok ? parseAgentRegistry(registryInput.value) : [];
  const manifestProvenance = manifestInput.ok
    ? openClawManifestProvenance(manifestInput.value, {
      now: now(),
      maxAgeMs: Number(options.manifestMaxAgeMs || process.env.AGENTX_OPENCLAW_MANIFEST_MAX_AGE_MS)
        || DEFAULT_MANIFEST_MAX_AGE_MS
    })
    : {
      status: 'unavailable', usable: false, schemaVersion: null, generatedAt: null,
      generatedBy: null, ageMs: null, maxAgeMs: DEFAULT_MANIFEST_MAX_AGE_MS,
      authority: 'config/openclaw-agent-manifest.yml', issues: [manifestInput.error]
    };
  const manifestAgents = manifestProvenance.usable ? parseOpenClawManifest(manifestInput.value) : [];
  const documented = scheduledInput.ok ? parseScheduled(scheduledInput.value) : [];
  const lead = leadInput.ok ? parseLead(leadInput.value) : { heldBy: 'none', since: null, notes: '' };
  const runtimeEvidence = openclaw.value || { source: { degraded: true, issues: [openclaw.error || 'OpenClaw evidence unavailable'] }, agents: [], cron: { jobs: [] }, status: { sessions: { recent: [] }, online: false } };
  const runtimeJobs = asArray(runtimeEvidence.cron?.jobs);
  const sessions = asArray(runtimeEvidence.status?.sessions?.recent);
  const ecosystemSnapshot = requireEcosystemSnapshot(ecosystem);
  const alertEvidence = productAlertEvidence(alerts, ecosystemSnapshot);
  const budgetStatus = budget.value?.body?.data || budget.value?.body || {};
  const cloudRequests = Math.max(0, Number(budgetStatus.cloud_requests) || 0);
  const cloudHealth = cleanText(budgetStatus.cloud_health).slice(0, 24) || 'unknown';
  const cloudObservability = cleanText(budgetStatus.cloud_spend_observability).slice(0, 40) || 'unknown';
  const pipelineEvidence = pipelineContract(pipeline.value);
  const tasks = pipeline.ok && pipelineEvidence.valid ? pipelineTasks(pipeline.value) : [];
  const pipelineCountEvidence = pipelineCounts(pipeline.value, tasks);
  const automations = mergeAutomations(runtimeJobs, documented);
  const agents = mergeAgents(registryAgents, manifestAgents, asArray(runtimeEvidence.agents), sessions, automations, tasks, lead);

  const pipelineOk = pipeline.ok && pipelineEvidence.valid;
  const hermesOk = hermes.ok && hermes.value?.ok;
  const hermesGateway = hermes.value?.body?.gateway || {};
  const hermesReady = hermesOk && hermesGateway.running === true && hermesGateway.freshness?.fresh !== false;
  const hermesUnexpectedActive = !hermesExpected && hermesReady;
  const hermesIssues = [
    hermes.error,
    hermes.value?.error,
    hermesGateway.freshness?.fresh === false ? hermesGateway.freshness.reason : null
  ];
  const openclawIssues = [...asArray(runtimeEvidence.source?.issues), ...asArray(runtimeEvidence.knownGaps).map((gap) => gap.detail)];
  const sources = {
    registry: sourceState(registryInput.ok ? 'ok' : 'degraded', 'config/agent-registry.yml', registryInput.durationMs, [registryInput.error]),
    manifest: {
      ...sourceState(
        manifestProvenance.usable ? 'ok' : 'degraded',
        manifestProvenance.authority,
        manifestInput.durationMs,
        manifestProvenance.issues
      ),
      provenance: {
        schemaVersion: manifestProvenance.schemaVersion,
        generatedAt: manifestProvenance.generatedAt,
        generatedBy: manifestProvenance.generatedBy
      },
      freshness: {
        status: manifestProvenance.status,
        ageMs: manifestProvenance.ageMs,
        maxAgeMs: manifestProvenance.maxAgeMs
      },
      usedForAgentModels: manifestProvenance.usable
    },
    schedules: sourceState(scheduledInput.ok ? 'ok' : 'degraded', 'SCHEDULED.md Active table', scheduledInput.durationMs, [scheduledInput.error]),
    pipeline: sourceState(pipelineOk ? 'ok' : 'degraded', PIPELINE_LIST_ROUTE, pipeline.durationMs, [
      pipeline.error,
      pipeline.value?.error,
      pipelineEvidence.issueCode
    ]),
    openclaw: sourceState(runtimeEvidence.source?.degraded ? 'degraded' : 'ok', runtimeEvidence.authority || 'official-openclaw-cli', openclaw.durationMs, openclawIssues),
    ecosystem: sourceState('ok', '/api/nerve-center/ecosystem · agentx-product', ecosystem.durationMs),
    alerts: sourceState(
      alertEvidence.degraded ? 'degraded' : 'ok',
      alertEvidence.authority,
      alerts.durationMs,
      [alertEvidence.issueCode]
    ),
  };
  if (hermesExpected) {
    sources.hermes = sourceState(hermesReady ? 'ok' : 'degraded', '/api/hermes/status', hermes.durationMs, hermesIssues);
  } else if (hermesUnexpectedActive) {
    sources.hermes = sourceState('degraded', '/api/hermes/status', hermes.durationMs, ['HERMES_RETIRED_RUNTIME_ACTIVE']);
  }

  const counts = pipelineCountEvidence.counts;
  const activeTasks = tasks.filter((task) => PIPELINE_ACTIVE_STATUSES.has(task.status));
  const capabilities = [
    { id: 'nerve-center', name: 'Nerve Center', responsibility: 'Host, model, routing, inference, alert, and RAG posture.', service: 'core', ui: '/nerve-center' },
    { id: 'pipeline', name: 'AgentX Pipeline', responsibility: 'Mongo-owned work is canonical; the legacy Leantime board is currently disconnected.', service: 'core', ui: '/pipeline' },
    { id: 'memory-review', name: 'Memory Review', responsibility: 'Approval-first ecosystem memory governance.', service: 'core', ui: '/memory-review' },
  ];
  const responsibilities = buildResponsibilities(agents, automations, activeTasks, capabilities);
  const warnings = [];
  for (const [id, source] of Object.entries(sources)) if (source.status !== 'ok') warnings.push({
    id: `source-${id}`, type: 'source', severity: source.status === 'error' ? 'critical' : 'warning',
    title: `${humanize(id)} evidence is ${source.status}`,
    detail: source.issues[0] || 'The projection is using partial evidence.',
    impact: 'The cockpit remains available, but this slice may be incomplete.',
    source: source.authority, action: { kind: 'trace-sources' },
  });
  for (const item of automations.filter((entry) => ['error', 'unknown'].includes(entry.health))) warnings.push({
    id: `automation-${item.id}`, type: 'automation-error', severity: item.health === 'error' ? 'critical' : 'warning', ownerId: item.ownerId,
    title: item.health === 'error' ? `${item.name} is failing` : `${item.name} has no verified run result`,
    detail: item.lastError || item.lastStatus || 'No completed run result is available from the runtime.',
    impact: 'Scheduled delivery may be delayed.', source: item.source,
    action: { kind: 'inspect-automation', targetId: item.id },
  });
  const blocked = activeTasks.filter((task) => task.status === 'blocked');
  if (blocked.length) warnings.push({
    id: 'blocked-work', type: 'blocked-work', severity: 'warning', title: `${blocked.length} pipeline item${blocked.length === 1 ? '' : 's'} blocked`,
    detail: blocked.slice(0, 3).map((task) => `#${task.pipelineId} ${task.title}`).join(' · '),
    impact: 'Delivery is waiting on evidence, authority, or an external condition.', source: 'Mongo pipeline',
    action: { kind: 'open-preset', tab: 'work', preset: 'work:blocked' },
  });
  if (!budget.ok || budget.value?.ok === false) warnings.push({
    id: 'budget-evidence', type: 'budget-evidence', severity: 'warning',
    title: 'LLM budget evidence is unavailable',
    detail: safeDiagnostic(budget.error || budget.value?.error || `HTTP ${budget.value?.statusCode || 'unavailable'}`),
    impact: 'Cloud spend and attribution cannot be assessed from current evidence.', source: '/api/budget/status',
    action: { kind: 'open-link', href: '/analytics' },
  });
  else if (cloudRequests > 0 && ['none-recorded', 'unknown'].includes(cloudObservability)) warnings.push({
    id: 'cloud-attribution', type: 'cloud-attribution', severity: 'warning',
    title: 'Cloud LLM attribution is incomplete',
    detail: `${cloudRequests} cloud call${cloudRequests === 1 ? '' : 's'} lack per-call spend attribution.`,
    impact: 'Recorded zero spend must not be interpreted as proof of zero cost.', source: '/api/budget/status',
    action: { kind: 'open-link', href: '/analytics' },
  });
  if (['yellow', 'red'].includes(cloudHealth)) warnings.push({
    id: 'cloud-budget', type: 'cloud-budget', severity: 'warning',
    title: cloudHealth === 'red' ? 'Cloud LLM budget needs attention' : 'Cloud LLM budget is approaching its policy line',
    detail: `${cloudRequests} attributed cloud call${cloudRequests === 1 ? '' : 's'} in ${cleanText(budgetStatus.period).slice(0, 24) || '24h'}.`,
    impact: 'Review attributed cloud calls before approving further escalation.', source: '/api/budget/status',
    action: { kind: 'open-link', href: '/analytics' },
  });

  const observedAgents = agents.filter((agent) => ['lead', 'observed'].includes(agent.status)).length;
  const observedAutomations = automations.filter((item) => item.confidence === 'live').length;
  const runtimeLayers = [
    {
      id: 'ecosystem', name: 'AgentX Core',
      host: `${Number(ecosystemSnapshot.health?.onlineHosts || 0)}/${Number(ecosystemSnapshot.health?.configuredHosts || 0)} hosts online`,
      type: 'product control plane', status: ecosystemSnapshot.health?.status || 'degraded',
      model: `${Number(ecosystemSnapshot.health?.observedModels || 0)} observed models`,
      boundary: 'Product-owned machine, model, routing, alert, and inference evidence.',
    },
    {
      id: 'openclaw', name: 'OpenClaw', host: process.env.OPENCLAW_INVENTORY_SSH_TARGET || 'external runtime', type: 'managed worker runtime',
      status: runtimeEvidence.source?.degraded ? 'degraded' : runtimeEvidence.status?.online ? 'ok' : 'unknown',
      model: runtimeEvidence.models?.default || null,
    },
  ];
  if (hermesExpected) {
    runtimeLayers.push({
      id: 'hermes', name: 'Hermes', host: process.env.HERMES_PUBLIC_URL || process.env.HERMES_DASHBOARD_URL || 'external runtime', type: 'compatibility runtime',
      status: hermesReady ? 'ok' : 'degraded',
      model: null,
    });
  } else if (hermesUnexpectedActive) {
    runtimeLayers.push({
      id: 'hermes', name: 'Hermes', host: process.env.HERMES_PUBLIC_URL || process.env.HERMES_DASHBOARD_URL || 'external runtime', type: 'retired runtime drift',
      status: 'degraded',
      model: null,
    });
  }
  if (process.env.DSH_STUDIO_PUBLIC_URL) {
    let dshHost = 'configured external runtime';
    try { dshHost = new URL(process.env.DSH_STUDIO_PUBLIC_URL).host; } catch {}
    const isolation = String(process.env.DSH_STUDIO_ISOLATION || 'bubblewrap').trim().toLowerCase();
    runtimeLayers.push({
      id: 'dsh', name: 'DSH Studio', host: dshHost, type: 'interactive coding harness',
      status: 'unknown',
      model: String(process.env.DSH_STUDIO_MODEL || '').trim(),
      boundary: `Human-operated DSH workspace. Configured service isolation: ${isolation}; live state unverified.`,
      launchUrl: '/api/dsh/control-launch',
    });
  }

  const generatedAt = now().toISOString();
  return {
    schemaVersion: 5,
    generatedAt,
    readOnly: true,
    authority: 'aio-ops-runtime-bridges',
    lead,
    summary: {
      registeredAgents: agents.length,
      activeAgents: agents.filter((agent) => agent.status !== 'superseded').length,
      runtimeAgents: agents.filter((agent) => agent.runtime).length,
      observedAgents,
      automations: automations.length,
      observedAutomations,
      openWork: activeTasks.length,
      blockedWork: blocked.length,
    },
    coverage: {
      agents: { registered: agents.length, observed: observedAgents, runtimeUnobserved: agents.filter((agent) => agent.status === 'unobserved').length },
      automations: { documented: documented.length, observed: observedAutomations, documentedOnly: automations.filter((item) => item.confidence === 'documented').length, observedOnly: Math.max(0, observedAutomations - documented.length) },
    },
    sources,
    runtimeLayers,
    handoffs: {
      openclaw: {
        status: sources.openclaw.status,
        requiresTunnel: false,
        capabilities: [
          { label: 'Overview', path: '/overview', icon: 'fa-gauge-high' },
          { label: 'Agents', path: '/agents', icon: 'fa-users-gear' },
          { label: 'Sessions', path: '/sessions', icon: 'fa-clock-rotate-left' },
          { label: 'Automations', path: '/cron', icon: 'fa-calendar-days' },
        ],
      },
      agentx: {
        complements: [
          { label: 'Nerve Center', href: '/nerve-center', icon: 'fa-brain', reason: 'Machine, model, and routing health.' },
          { label: 'AgentX Pipeline', href: '/pipeline', icon: 'fa-list-check', reason: 'Coding work, ownership, progress, and feedback.' },
          { label: 'Memory Review', href: '/memory-review', icon: 'fa-book-open', reason: 'Approval-first memory evidence.' },
        ],
      },
    },
    warnings,
    utilization: {
      period: cleanText(budgetStatus.period).slice(0, 24) || '24h',
      localRequests: Math.max(0, Number(budgetStatus.local_requests) || 0),
      localTokens: Math.max(0, Number(budgetStatus.local_tokens) || 0),
      localHealth: cleanText(budgetStatus.budget_health).slice(0, 24) || 'unknown',
      localUsageRatio: Math.max(0, Number(budgetStatus.usage_ratio) || 0),
      cloudRequests,
      cloudTokens: Math.max(0, Number(budgetStatus.cloud_tokens) || 0),
      cloudHealth,
      cloudObservability,
      authority: '/api/budget/status'
    },
    alertEvidence,
    agents,
    automations,
    work: {
      counts,
      countsComplete: pipelineCountEvidence.complete,
      countsBasis: pipelineCountEvidence.basis,
      countScope: 'all pipeline statuses',
      active: activeTasks,
      recent: tasks.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 50)
    },
    capabilities,
    responsibilities,
    activity: buildActivity(automations, tasks, sessions, sources),
    links: {
      nerveCenter: '/nerve-center',
      pipeline: '/pipeline',
      leantime: String(process.env.LEANTIME_BASE_URL || '').replace(/\/$/, '') || null,
      openclaw: '/api/openclaw/control-launch/overview',
      dsh: process.env.DSH_STUDIO_PUBLIC_URL ? '/api/dsh/control-launch' : null,
    },
  };
}

module.exports = {
  ALERT_LIST_LIMIT,
  ALERT_LIST_ROUTE,
  DEFAULT_MANIFEST_MAX_AGE_MS,
  OPENCLAW_MANIFEST_GENERATOR,
  OPENCLAW_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_ECOSYSTEM_SNAPSHOT_SCHEMAS,
  agentKey,
  buildAgentOpsProjection,
  fetchJson,
  mergeAutomations,
  parseAgentRegistry,
  parseRuntimeStatus,
  parseLead,
  parseOpenClawManifest,
  openClawManifestProvenance,
  parseScheduled,
  pipelineCounts,
  pipelineContract,
  pipelineTasks,
  productAlertEvidence,
  requireEcosystemSnapshot,
};
