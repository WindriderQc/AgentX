'use strict';

const assert = require('assert');
const test = require('node:test');
const {
  buildAgentOpsProjection,
  mergeAutomations,
  parseAgentRegistry,
  parseRuntimeStatus,
  parseOpenClawManifest,
  openClawManifestProvenance,
  parseScheduled,
  pipelineCounts,
  pipelineTasks,
  productAlertEvidence,
  requireEcosystemSnapshot,
} = require('../agent-ops/projection');
const { buildServiceHealth } = require('../agent-ops/health');
const { registerAgentOps } = require('../agent-ops/routes');

const registry = `
agents:
  main:
    type: openclaw_front_door
    persona: Nestor
    runtime: openclaw
    model:
      primary: ollama/qwen
      fallbacks:
        - openrouter/fallback
    boundary: "Front door and secretary owner."
  clawdx_coder:
    type: openclaw_worker_role
    runtime: openclaw
  overseer:
    type: pipeline_manager
    owns:
      - mongodb:pipelinetasks
`;

const manifest = `
schema_version: 2
generated_at: '2026-08-20T01:00:00.000Z'
generated_by: agentx-core/openclawAgentInventoryService
agents:
  - id: main
    active: true
    name: Main
    identity:
      name: Nestor
    model:
      primary: ollama/qwen
      fallbacks:
        - openrouter/fallback
  - id: clawdx-coder
    active: true
    name: ClawdX Coder
    model:
      primary: openrouter/glm
inactiveWorkspaces: []
`;

const schedules = `
## Active

| What | When | Owner | Trigger | Why | Source |
|---|---|---|---|---|---|
| Nestor Gmail backlog triage | every 5 minutes | OpenClaw \`main\` | OpenClaw cron \`gmail-triage\` | Triages one inspected thread. | official CLI evidence via Core |
| Host backup | daily | \`agentx-core\` | in-process | Protects data. | Core backup service |

## Pending
`;

const openclawEvidence = {
  authority: 'official-openclaw-cli', source: { degraded: false, issues: [] }, knownGaps: [],
  status: { online: true, sessions: { recent: [{ agentId: 'main', updatedAt: '2026-08-20T01:00:00.000Z', totalTokens: 1234, model: 'ollama/qwen' }] } },
  models: { default: 'ollama/qwen' },
  agents: [{ id: 'main', name: 'Nestor', identity: { name: 'Nestor' }, model: { primary: 'ollama/qwen', fallbacks: [] } }],
  cron: { jobs: [{ id: 'gmail-triage', name: 'gmail-triage', agentId: 'main', schedule: '*/5 * * * *', enabled: true, lastRunStatus: 'success', lastRunAtMs: Date.parse('2026-08-20T01:10:00.000Z'), nextRunAtMs: Date.parse('2026-08-20T01:15:00.000Z'), lastDurationMs: 4200, consecutiveErrors: 0, lastDiagnosticSummary: 'sender@example.test subject Private payroll', history: [{ atMs: Date.parse('2026-08-20T01:05:00.000Z'), status: 'success', durationMs: 3900, message: 'C:\\Users\\operator token=private' }] }] },
};

function fakeRead(file) {
  if (file.endsWith('agent-registry.yml')) return Promise.resolve(registry);
  if (file.endsWith('openclaw-agent-manifest.yml')) return Promise.resolve(manifest);
  if (file.endsWith('SCHEDULED.md')) return Promise.resolve(schedules);
  if (file.endsWith('LEAD.md')) return Promise.resolve('---\nheld_by: codex\nsince: 2026-08-20T01:00Z\nnotes: "Cockpit restore"\n---');
  throw new Error(`Unexpected file ${file}`);
}

function ecosystemSnapshot(schemaVersion = 1) {
  const snapshot = {
    schemaVersion,
    authority: 'agentx-product',
    readOnly: true,
    health: { status: 'ok', configuredHosts: 3, onlineHosts: 3, offlineHosts: 0, observedModels: 8 },
    cluster: [{ hostKey: 'primary', status: 'online', models: ['ollama/qwen'] }],
    routing: { authority: 'inference_log', currentHost: 'primary' },
    routingConfig: { taskModels: {}, hosts: {}, taskConfigState: {} },
    hostPreferences: [],
    alerts: [],
    recentRouting: [],
  };
  if (schemaVersion === 2) snapshot.evidenceTrust = {
    schemaVersion: 1,
    status: 'verified',
    operationalStatus: 'ok',
    contradictionBudget: { allowed: 0, observed: 0, withinBudget: true, contradictions: [] },
  };
  return snapshot;
}

function fakeFetch(route) {
  if (route === '/api/pipeline/tasks?view=summary&includeDone=true&limit=1000') return Promise.resolve({
    ok: true,
    body: { status: 'success', data: {
      count: 1,
      tasks: [{
        pipelineId: '0900', title: 'Restore Agent Ops', status: 'review', assignee: 'clawdx-coder',
        updatedAt: '2026-08-20T01:05:00.000Z', epic: 'Cockpit', spec: 'must stay private',
        feedback: [{ text: 'must also stay private' }]
      }]
    } },
    durationMs: 4
  });
  if (route === '/api/nerve-center/ecosystem') return Promise.resolve({
    ok: true,
    statusCode: 200,
    body: {
      status: 'success',
      data: ecosystemSnapshot(1),
    },
    durationMs: 2,
  });
  if (route === '/api/alerts?status=active&limit=100&skip=0') return Promise.resolve({
    ok: true,
    statusCode: 200,
    body: {
      status: 'success',
      data: {
        total: 1,
        limit: 100,
        skip: 0,
        alerts: [{
          _id: '68b0c0000000000000000001',
          ruleId: 'host-offline',
          ruleName: 'private free text must not cross',
          severity: 'critical',
          status: 'active',
          title: 'token=private-value',
          message: 'C:\\Users\\operator sender@example.test',
          source: 'agentx',
          context: { component: 'ollama-99', metric: 'reachable', currentValue: 0, threshold: 1 },
          occurrenceCount: 2,
          lastOccurrence: '2026-08-20T01:12:00.000Z',
          createdAt: '2026-08-20T01:00:00.000Z',
          delivery: { local_log: { sent: true }, telegram: { chatId: 'private-chat' } }
        }]
      }
    },
    durationMs: 2
  });
  if (route === '/api/hermes/status') return Promise.resolve({ ok: true, body: { gateway: { running: true, freshness: { fresh: true } } }, durationMs: 3 });
  if (route === '/api/budget/status') return Promise.resolve({
    ok: true,
    statusCode: 200,
    body: { period: '24h', local_requests: 120, local_tokens: 45000, budget_health: 'green', usage_ratio: 0.8, cloud_requests: 1, cloud_tokens: 200, cloud_health: 'green', cloud_spend_observability: 'attributed' },
    durationMs: 2
  });
  throw new Error(`Unexpected route ${route}`);
}

test('bounded parsers retain registry, manifest, and Active schedule contracts', () => {
  const declared = parseAgentRegistry(registry);
  assert.equal(declared.find((agent) => agent.id === 'main').model.primary, 'ollama/qwen');
  assert.deepEqual(declared.find((agent) => agent.id === 'main').model.fallbacks, ['openrouter/fallback']);
  assert.deepEqual(declared.find((agent) => agent.id === 'overseer').owns, ['mongodb:pipelinetasks']);
  assert.equal(parseOpenClawManifest(manifest)[0].name, 'Nestor');
  assert.equal(parseScheduled(schedules).length, 2);
  assert.equal(parseRuntimeStatus(`${registry}\nruntimes:\n  hermes:\n    status: retired_2026_09_03\n`, 'hermes'), 'retired_2026_09_03');
});

test('retired and stopped Hermes is omitted from live readiness', async () => {
  const routes = [];
  const retiredRegistry = `${registry}\nruntimes:\n  hermes:\n    status: retired_2026_09_03_openclaw_migration\n`;
  const data = await buildAgentOpsProjection({
    repoRoot: '/workspace/agentx',
    readText: (file) => file.endsWith('agent-registry.yml')
      ? Promise.resolve(retiredRegistry)
      : fakeRead(file),
    fetchJson: async (route) => {
      routes.push(route);
      if (route === '/api/hermes/status') return { ok: false, statusCode: 503, error: 'retired service unavailable', durationMs: 1 };
      return fakeFetch(route);
    },
    getOpenClawRuntimeEvidence: async () => openclawEvidence,
  });
  assert.equal(routes.includes('/api/hermes/status'), true);
  assert.equal(Object.hasOwn(data.sources, 'hermes'), false);
  assert.equal(data.runtimeLayers.some((runtime) => runtime.id === 'hermes'), false);
  assert.equal(data.warnings.some((warning) => warning.id === 'source-hermes'), false);
});

test('retired but active Hermes is surfaced as runtime drift', async () => {
  const retiredRegistry = `${registry}\nruntimes:\n  hermes:\n    status: retired_2026_09_03_openclaw_migration\n`;
  const data = await buildAgentOpsProjection({
    repoRoot: '/workspace/agentx',
    readText: (file) => file.endsWith('agent-registry.yml') ? Promise.resolve(retiredRegistry) : fakeRead(file),
    fetchJson: fakeFetch,
    getOpenClawRuntimeEvidence: async () => openclawEvidence,
  });
  assert.equal(data.sources.hermes.status, 'degraded');
  assert.deepEqual(data.sources.hermes.issues, ['HERMES_RETIRED_RUNTIME_ACTIVE']);
  assert.equal(data.runtimeLayers.find((runtime) => runtime.id === 'hermes').type, 'retired runtime drift');
  assert.equal(data.warnings.some((warning) => warning.id === 'source-hermes'), true);
});

test('stale OpenClaw manifests expose provenance and cannot mask registry or runtime agents', async () => {
  const staleManifest = `
schema_version: 2
generated_at: '2026-08-01T00:00:00.000Z'
generated_by: agentx-core/openclawAgentInventoryService
agents:
  - id: overseer
    model:
      primary: openrouter/stale-model
  - id: manifest-only
    model:
      primary: openrouter/stale-model
`;
  const provenance = openClawManifestProvenance(staleManifest, {
    now: new Date('2026-08-20T01:20:00.000Z'),
    maxAgeMs: 7 * 24 * 60 * 60 * 1000
  });
  assert.equal(provenance.status, 'stale');
  assert.equal(provenance.usable, false);

  const data = await buildAgentOpsProjection({
    repoRoot: '/workspace/agentx',
    readText: (file) => file.endsWith('openclaw-agent-manifest.yml')
      ? Promise.resolve(staleManifest)
      : fakeRead(file),
    fetchJson: fakeFetch,
    getOpenClawRuntimeEvidence: async () => openclawEvidence,
    now: () => new Date('2026-08-20T01:20:00.000Z')
  });
  assert.equal(data.sources.manifest.status, 'degraded');
  assert.equal(data.sources.manifest.freshness.status, 'stale');
  assert.equal(data.sources.manifest.usedForAgentModels, false);
  assert.equal(data.agents.some((agent) => agent.id === 'manifest-only'), false);
  assert.equal(data.agents.find((agent) => agent.id === 'overseer').model.primary, null);
  assert.equal(data.agents.find((agent) => agent.id === 'main').model.source, 'openclaw-runtime');
});

test('unknown OpenClaw manifest schemas are visible but never used as model authority', () => {
  const provenance = openClawManifestProvenance(`
schema_version: 99
generated_at: '2026-08-20T01:00:00.000Z'
generated_by: agentx-core/openclawAgentInventoryService
`, { now: new Date('2026-08-20T01:20:00.000Z') });
  assert.equal(provenance.status, 'invalid');
  assert.equal(provenance.usable, false);
  assert.deepEqual(provenance.issues, ['OPENCLAW_MANIFEST_PROVENANCE_INVALID']);
});

test('OpenClaw manifest provenance requires the canonical Core generator', () => {
  const provenance = openClawManifestProvenance(`
schema_version: 2
generated_at: '2026-08-20T01:00:00.000Z'
generated_by: manual/export
`, { now: new Date('2026-08-20T01:20:00.000Z') });
  assert.equal(provenance.status, 'invalid');
  assert.equal(provenance.usable, false);
  assert.deepEqual(provenance.issues, ['OPENCLAW_MANIFEST_PROVENANCE_INVALID']);
});

test('OpenClaw manifest provenance requires an explicit generator identity', () => {
  const provenance = openClawManifestProvenance(`
schema_version: 2
generated_at: '2026-08-20T01:00:00.000Z'
agents: []
`, { now: new Date('2026-08-20T01:20:00.000Z') });
  assert.equal(provenance.status, 'invalid');
  assert.equal(provenance.usable, false);
  assert.deepEqual(provenance.issues, ['OPENCLAW_MANIFEST_PROVENANCE_INVALID']);
});

test('pipeline status counts retain nonstandard terminal rows and fail closed with the source', () => {
  assert.deepEqual(pipelineCounts({ ok: false }, []), {
    counts: { queued: 0, in_progress: 0, review: 0, blocked: 0, done: 0 },
    complete: false,
    basis: 'pipeline source unavailable',
  });
  const valid = {
    ok: true,
    body: {
      status: 'success',
      data: { count: 2, tasks: [{ status: 'queued' }, { status: 'cancelled' }] }
    }
  };
  assert.deepEqual(pipelineCounts(valid, pipelineTasks(valid)), {
    counts: { queued: 1, in_progress: 0, review: 0, blocked: 0, done: 0, cancelled: 1 },
    complete: true,
    basis: 'validated complete pipeline page below the route ceiling',
    issueCode: null
  });
  const empty = { ok: true, body: { status: 'success', data: { count: 0, tasks: [] } } };
  assert.equal(pipelineCounts(empty, pipelineTasks(empty)).complete, true);
});

test('read-only projection retains live schedule receipts and requires the Product ecosystem contract', async () => {
  const data = await buildAgentOpsProjection({ repoRoot: '/workspace/agentx', readText: fakeRead, fetchJson: fakeFetch, getOpenClawRuntimeEvidence: async () => openclawEvidence, now: () => new Date('2026-08-20T01:20:00.000Z') });
  assert.equal(data.schemaVersion, 5);
  assert.equal(data.readOnly, true);
  assert.equal(data.sources.ecosystem.status, 'ok');
  assert.equal(data.sources.ecosystem.authority, '/api/nerve-center/ecosystem · agentx-product');
  assert.equal(data.sources.manifest.status, 'ok');
  assert.equal(data.sources.manifest.usedForAgentModels, true);
  assert.equal(data.sources.alerts.status, 'ok');
  assert.equal(data.alertEvidence.activeCount, 1);
  assert.equal(data.alertEvidence.countComplete, true);
  assert.equal(data.alertEvidence.records[0].ruleId, 'host-offline');
  assert.equal(data.alertEvidence.records[0].localLogRecorded, true);
  assert.equal(data.warnings.some((warning) => warning.id === 'source-ecosystem'), false);
  assert.equal(data.utilization.localUsageRatio, 0.8);
  assert.equal(data.utilization.cloudHealth, 'green');
  assert.equal(data.utilization.authority, '/api/budget/status');
  assert.deepEqual(data.runtimeLayers.find((runtime) => runtime.id === 'ecosystem'), {
    id: 'ecosystem',
    name: 'AgentX Core',
    host: '3/3 hosts online',
    type: 'product control plane',
    status: 'ok',
    model: '8 observed models',
    boundary: 'Product-owned machine, model, routing, alert, and inference evidence.',
  });
  assert.equal(data.agents.find((agent) => agent.id === 'main').name, 'Nestor');
  assert.ok(data.agents.some((agent) => agent.id === 'clawdx-coder'));
  assert.equal(
    data.capabilities.find((capability) => capability.id === 'pipeline').responsibility,
    'Mongo-owned work is canonical; the legacy Leantime board is currently disconnected.'
  );
  assert.doesNotMatch(JSON.stringify(data.capabilities), /mirrored bidirectionally/i);
  const automation = data.automations.find((item) => item.id === 'gmail-triage');
  assert.equal(automation.lastRun, '2026-08-20T01:10:00.000Z');
  assert.equal(automation.lastError, null, 'successful diagnostics are not reclassified as errors');
  assert.deepEqual(automation.history.map((run) => run.at), ['2026-08-20T01:10:00.000Z', '2026-08-20T01:05:00.000Z']);
  assert.equal(automation.history.every((run) => run.error === null), true);
  assert.ok(data.work.active.some((task) => task.pipelineId === '0900'));
  assert.deepEqual(data.work.counts, { queued: 0, in_progress: 0, review: 1, blocked: 0, done: 0 });
  assert.equal(data.work.countsComplete, true);
  assert.doesNotMatch(JSON.stringify(data.work), /must stay private|must also stay private|spec|feedback/);
  assert.doesNotMatch(JSON.stringify(data), /OPENCLAW_GATEWAY_TOKEN|password|private-value|private free text|private-chat|sender@example|C:\\Users|\/home\/yb\/\.openclaw|agent-ops\/actions/);
});

test('configured DSH Studio appears as a human runtime with a generic launch URL', async () => {
  const previousUrl = process.env.DSH_STUDIO_PUBLIC_URL;
  const previousIsolation = process.env.DSH_STUDIO_ISOLATION;
  const previousModel = process.env.DSH_STUDIO_MODEL;
  process.env.DSH_STUDIO_PUBLIC_URL = 'https://192.0.2.99:18791';
  process.env.DSH_STUDIO_ISOLATION = 'host';
  process.env.DSH_STUDIO_MODEL = 'local-code-model';
  try {
    const data = await buildAgentOpsProjection({
      repoRoot: '/workspace/agentx',
      readText: fakeRead,
      fetchJson: fakeFetch,
      getOpenClawRuntimeEvidence: async () => openclawEvidence,
    });
    assert.deepEqual(data.runtimeLayers.find((runtime) => runtime.id === 'dsh'), {
      id: 'dsh',
      name: 'DSH Studio',
      host: '192.0.2.99:18791',
      type: 'interactive coding harness',
      status: 'unknown',
      model: 'local-code-model',
      boundary: 'Human-operated DSH workspace. Configured service isolation: host; live state unverified.',
      launchUrl: '/api/dsh/control-launch',
    });
    assert.equal(data.links.dsh, '/api/dsh/control-launch');
  } finally {
    if (previousUrl === undefined) delete process.env.DSH_STUDIO_PUBLIC_URL;
    else process.env.DSH_STUDIO_PUBLIC_URL = previousUrl;
    if (previousIsolation === undefined) delete process.env.DSH_STUDIO_ISOLATION;
    else process.env.DSH_STUDIO_ISOLATION = previousIsolation;
    if (previousModel === undefined) delete process.env.DSH_STUDIO_MODEL;
    else process.env.DSH_STUDIO_MODEL = previousModel;
  }
});

test('malformed HTTP-200 pipeline envelopes degrade counts instead of becoming exact zero', async () => {
  const invalidBodies = [
    {},
    { status: 'error', data: { count: 0, tasks: [] } },
    { status: 'success', data: { count: 0, tasks: {} } },
    { status: 'success', data: { count: 1, tasks: [] } },
    { status: 'success', data: { count: '0', tasks: [] } },
    { status: 'success', data: { count: false, tasks: [] } },
    { status: 'success', data: { count: null, tasks: [] } }
  ];

  for (const body of invalidBodies) {
    const data = await buildAgentOpsProjection({
      repoRoot: '/workspace/agentx',
      readText: fakeRead,
      fetchJson: async (route) => route === '/api/pipeline/tasks?view=summary&includeDone=true&limit=1000'
        ? { ok: true, statusCode: 200, body, durationMs: 1 }
        : fakeFetch(route),
      getOpenClawRuntimeEvidence: async () => openclawEvidence
    });
    assert.equal(data.sources.pipeline.status, 'degraded');
    assert.deepEqual(data.sources.pipeline.issues, ['AGENT_OPS_PIPELINE_SCHEMA_INVALID']);
    assert.equal(data.work.countsComplete, false);
    assert.equal(data.work.countsBasis, 'pipeline response schema invalid');
    assert.deepEqual(data.work.active, []);
  }
});

test('alert-list failure is explicit and falls back only to bounded Product alert evidence', async () => {
  const data = await buildAgentOpsProjection({
    repoRoot: '/workspace/agentx',
    readText: fakeRead,
    fetchJson: async (route) => {
      if (route === '/api/alerts?status=active&limit=100&skip=0') {
        return { ok: false, statusCode: 503, error: 'private upstream detail', durationMs: 2 };
      }
      if (route === '/api/nerve-center/ecosystem') {
        const response = await fakeFetch(route);
        response.body.data.alerts = [{
          _id: '68b0c0000000000000000002', ruleId: 'fallback-rule', severity: 'warning',
          status: 'active', title: 'private title', message: 'sender@example.test'
        }];
        return response;
      }
      return fakeFetch(route);
    },
    getOpenClawRuntimeEvidence: async () => openclawEvidence,
  });
  assert.equal(data.sources.alerts.status, 'degraded');
  assert.deepEqual(data.sources.alerts.issues, ['AGENT_OPS_ALERT_LIST_UNAVAILABLE']);
  assert.equal(data.alertEvidence.authority, 'agentx-product-ecosystem-alert-fallback');
  assert.equal(data.alertEvidence.countComplete, false);
  assert.equal(data.alertEvidence.records[0].ruleId, 'fallback-rule');
  assert.doesNotMatch(JSON.stringify(data.alertEvidence), /private title|sender@example/);
  assert.equal(data.warnings.some((warning) => warning.id === 'source-alerts'), true);
});

test('alert metrics preserve real zeroes without turning missing values into zero', () => {
  const evidence = productAlertEvidence({
    ok: true,
    value: {
      ok: true,
      body: {
        status: 'success',
        data: {
          total: 2,
          alerts: [
            { id: 'zero', context: { currentValue: 0, threshold: false } },
            { id: 'missing', context: { currentValue: null, threshold: '' } }
          ]
        }
      }
    }
  }, { alerts: [] });

  assert.equal(evidence.records[0].currentValue, 0);
  assert.equal(evidence.records[0].threshold, false);
  assert.equal(evidence.records[1].currentValue, null);
  assert.equal(evidence.records[1].threshold, null);
});

test('projection fails closed when the Product ecosystem contract is unavailable', async () => {
  const routes = [];
  await assert.rejects(buildAgentOpsProjection({
    repoRoot: '/workspace/agentx',
    readText: fakeRead,
    fetchJson: async (route) => {
      routes.push(route);
      if (route === '/api/nerve-center/ecosystem') {
        return { ok: false, statusCode: 503, error: 'snapshot unavailable', durationMs: 2 };
      }
      return fakeFetch(route);
    },
    getOpenClawRuntimeEvidence: async () => openclawEvidence,
  }), (error) => {
    assert.equal(error.code, 'AGENT_OPS_ECOSYSTEM_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.match(error.message, /snapshot unavailable/);
    return true;
  });
  assert.equal(routes.includes('/api/nerve-center/status'), false);
});

test('projection accepts only supported Product ecosystem schemas 1 and 2', () => {
  for (const schemaVersion of [1, 2]) {
    const snapshot = ecosystemSnapshot(schemaVersion);
    assert.equal(requireEcosystemSnapshot({
      ok: true,
      value: { ok: true, body: { status: 'success', data: snapshot } },
    }), snapshot);
  }

  for (const schemaVersion of [0, 3]) {
    assert.throws(() => requireEcosystemSnapshot({
      ok: true,
      value: { ok: true, body: { status: 'success', data: ecosystemSnapshot(schemaVersion) } },
    }), (error) => error.code === 'AGENT_OPS_ECOSYSTEM_INVALID' && error.statusCode === 503);
  }
});

test('projection requires Product v2 evidence trust without applying it to v1', () => {
  const v2 = ecosystemSnapshot(2);
  delete v2.evidenceTrust;
  assert.throws(() => requireEcosystemSnapshot({
    ok: true,
    value: { ok: true, body: { status: 'success', data: v2 } },
  }), (error) => error.code === 'AGENT_OPS_ECOSYSTEM_INVALID');

  const v1 = ecosystemSnapshot(1);
  assert.equal(requireEcosystemSnapshot({
    ok: true,
    value: { ok: true, body: { status: 'success', data: v1 } },
  }), v1);
});

test('projection rejects an incomplete ecosystem schema instead of filling missing health', () => {
  assert.throws(() => requireEcosystemSnapshot({
    ok: true,
    value: {
      ok: true,
      body: {
        status: 'success',
        data: {
          schemaVersion: 1,
          authority: 'agentx-product',
          readOnly: true,
          cluster: [],
          routing: {},
          routingConfig: {},
        },
      },
    },
  }), (error) => {
    assert.equal(error.code, 'AGENT_OPS_ECOSYSTEM_INVALID');
    assert.equal(error.statusCode, 503);
    return true;
  });
});

test('Agent Ops API router exposes GET only', () => {
  const routes = [];
  const express = { Router: () => ({ get(routePath) { routes.push(['get', routePath]); }, post(routePath) { routes.push(['post', routePath]); } }) };
  registerAgentOps({ express, logger: {} });
  assert.deepEqual(routes, [['get', '/service-health'], ['get', '/']]);
});

test('service health combines three Product services with optional Data', async () => {
  const data = await buildServiceHealth({
    getProduct: async () => ({ ok: true, body: { services: [{ id: 'core', label: 'AgentX Core', port: 3080, status: 'ok' }, { id: 'benchmark', label: 'Benchmark', port: 3081, status: 'ok', latency_ms: 2 }, { id: 'rag', label: 'RAG', port: 3082, status: 'ok', latency_ms: 7 }] } }),
    getData: async () => ({ ok: true, durationMs: 3, body: { ok: true, status: 'success' } }),
    publicLinks: { benchmark: 'https://agentx.example:3081', rag: 'https://agentx.example:3082' },
  });
  assert.equal(data.summary.total, 4);
  assert.equal(data.summary.healthy, 4);
  assert.equal(data.services.find((service) => service.id === 'core').href, '/playground');
  assert.equal(data.services.find((service) => service.id === 'data').status, 'ok');
  assert.equal(data.summary.status, 'ok');
  assert.equal(data.summary.optionalDown, 0);
});

test('optional Data down degrades the service summary; a required service down keeps it down', async () => {
  const product = (ragStatus) => async () => ({ ok: true, body: { services: [{ id: 'core', status: 'ok' }, { id: 'benchmark', status: 'ok' }, { id: 'rag', status: ragStatus }] } });
  const getData = async () => ({ ok: false, error: 'fetch failed' });
  const degraded = await buildServiceHealth({ getProduct: product('ok'), getData });
  assert.deepEqual(degraded.services.find((service) => service.id === 'data'), {
    id: 'data', name: 'Data', owner: 'AgentX Product', port: 3083, optional: true,
    status: 'down', latencyMs: 0, issues: ['fetch failed'], href: null,
  });
  assert.deepEqual(degraded.summary, { status: 'degraded', total: 4, healthy: 3, degraded: 0, down: 1, optionalDown: 1 });
  assert.equal(degraded.services.filter((service) => service.id !== 'data').every((service) => service.status === 'ok' && !service.optional), true);

  const down = await buildServiceHealth({ getProduct: product('down'), getData });
  assert.deepEqual(down.summary, { status: 'down', total: 4, healthy: 2, degraded: 0, down: 2, optionalDown: 1 });
});

test('automation health requires an observed terminal result and retains a running job', () => {
  const jobs = [
    { id: 'never-run', enabled: true },
    { id: 'unknown-result', enabled: true, lastRunAtMs: 1000, lastRunStatus: 'mystery' },
    { id: 'missing-time', enabled: true, lastRunStatus: 'ok' },
    { id: 'succeeded', enabled: true, lastRunAtMs: 1000, lastRunStatus: 'ok', lastDurationMs: 0 },
    { id: 'skipped', enabled: true, lastRunAtMs: 1000, lastRunStatus: 'skipped' },
    { id: 'running', enabled: true, runningAtMs: 2000, lastRunAtMs: 1000, lastRunStatus: 'error' },
    { id: 'failed', enabled: true, lastRunAtMs: 1000, lastRunStatus: 'error' },
    { id: 'paused', enabled: false, lastRunStatus: 'error' },
  ];
  const result = mergeAutomations(jobs, []);
  assert.deepEqual(result.map(job => job.health), ['unknown', 'unknown', 'unknown', 'healthy', 'skipped', 'running', 'error', 'paused']);
  assert.equal(result.find(job => job.id === 'succeeded').lastDurationMs, 0);
});
