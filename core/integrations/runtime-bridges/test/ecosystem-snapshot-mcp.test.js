'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  ECOSYSTEM_SNAPSHOT_TOOL,
  FULL_SNAPSHOT_CAPS,
  buildFullSnapshot,
  callEcosystemSnapshot,
  ecosystemSnapshotMcpMiddleware,
  mergeTools,
  registerEcosystemSnapshotMcp,
  validateArguments,
} = require('../ecosystem-snapshot-mcp');

function projection(overrides = {}) {
  const warnings = [
    {
      id: 'source-openclaw', type: 'source', severity: 'warning', title: 'OpenClaw evidence is degraded',
      detail: 'One bounded collector is unavailable.', impact: 'This slice may be incomplete.',
      source: 'official-openclaw-cli', action: { kind: 'trace-sources' },
    },
    {
      id: 'automation-nightly', type: 'automation-error', severity: 'critical', ownerId: 'overseer',
      title: 'Nightly audit is failing', detail: 'Runtime reported an error.',
      impact: 'Scheduled delivery may be delayed.', source: 'official-openclaw-cli',
      action: { kind: 'inspect-automation', targetId: 'nightly' },
    },
  ];
  return {
    schemaVersion: 5,
    generatedAt: '2026-08-28T20:00:00.000Z',
    readOnly: true,
    authority: 'aio-ops-runtime-bridges',
    lead: { heldBy: 'codex', since: '2026-08-28T19:00:00.000Z', notes: 'secret=lead-private C:\\Users\\operator' },
    summary: { observedAutomations: 1, openWork: 2, blockedWork: 1 },
    coverage: { agents: { registered: 2, observed: 1 } },
    sources: {
      registry: { status: 'ok', authority: 'config/agent-registry.yml', issues: [] },
      openclaw: { status: 'degraded', authority: 'C:\\private\\source', issues: ['token=private-value sender@example.test'] },
    },
    runtimeLayers: [{ id: 'ecosystem', status: 'ok', host: 'C:\\private\\host' }, { id: 'openclaw', status: 'degraded' }],
    handoffs: { agentx: { complements: [] } },
    agents: [{ id: 'overseer', name: 'Overseer', status: 'observed' }],
    automations: [
      {
        id: 'nightly', name: 'Nightly audit', health: 'error', confidence: 'live',
        lastError: 'Gmail sender@example.test subject Private payroll',
        history: [{ at: '2026-08-28T18:00:00.000Z', status: 'error', error: 'password=private C:\\Users\\operator' }]
      },
      { id: 'documented', name: 'Documented job', health: 'documented', confidence: 'documented' },
    ],
    work: {
      counts: { queued: 2, review: 1, done: 3 },
      countsComplete: true,
      countsBasis: 'exact Mongo status aggregation',
      countScope: 'all pipeline statuses',
      active: [
        { pipelineId: '1001', title: 'Queued task', status: 'queued', spec: 'private implementation prompt', feedback: [{ text: 'private worker feedback' }] },
        { pipelineId: '1002', title: 'Review task', status: 'review' },
        { pipelineId: '1004', title: 'Private household task', service: 'personal', status: 'queued', note: 'private note' },
      ],
      recent: [{ pipelineId: '1003', title: 'Done task', status: 'done' }],
    },
    alertEvidence: {
      available: true,
      degraded: false,
      authority: 'agentx-product-alerts',
      activeCount: 1,
      returnedCount: 1,
      countComplete: true,
      records: [{
        id: '68b0c0000000000000000001', ruleId: 'host-offline', severity: 'critical', status: 'active',
        source: 'agentx', component: 'ollama-99', metric: 'reachable', currentValue: 0, threshold: 1,
        occurrenceCount: 2, lastOccurrence: '2026-08-28T19:30:00.000Z', localLogRecorded: true,
        title: 'password=private', message: 'sender@example.test C:\\Users\\operator'
      }]
    },
    warnings,
    capabilities: [{ id: 'pipeline', ui: '/pipeline' }],
    responsibilities: {
      summary: { totalSignals: 4 },
      lanes: [{ agentId: 'overseer', work: [{ id: '1004', name: 'Private household task', status: 'queued' }] }],
      unassigned: [{ kind: 'work', name: '#1004 Private household task', owner: 'none' }],
      duplicateScopes: []
    },
    activity: {
      counts: { work: 2 },
      items: [
        { id: 'work-1001', kind: 'work', title: '#1001 Queued task' },
        { id: 'work-1004', kind: 'work', title: '#1004 Private household task', detail: 'private work activity detail' },
        { id: 'automation-nightly', kind: 'automation', title: 'Nightly audit' }
      ]
    },
    ...overrides,
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { this.ended = true; return this; },
  };
}

function request(body, headers = {}) {
  return {
    method: 'POST',
    body,
    get(name) { return headers[String(name).toLowerCase()] || ''; },
  };
}

test('full projection preserves the current Overseer compatibility fields and complete counts', () => {
  const result = buildFullSnapshot(projection());
  assert.equal(result.mode, 'full');
  assert.equal(result.schemaVersion, 5);
  assert.equal(result.readOnly, true);
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.pipeline.counts, { queued: 2, review: 1, done: 3 });
  assert.equal(result.pipeline.countsComplete, true);
  assert.equal(result.pipeline.countsBasis, 'exact-or-complete-schema-5-pipeline-counts');
  assert.equal(result.pipeline.active[0].pipelineId, '1001');
  assert.equal(result.pipeline.activeCount, 3);
  assert.equal(result.pipeline.visibleActiveCount, 2);
  assert.equal(result.pipeline.withheldActiveCount, 1);
  assert.equal(result.alerts.activeCount, 1);
  assert.equal(result.alerts.projectedCount, 1);
  assert.equal(result.alerts.returnedCount, result.alerts.active.length);
  assert.equal(result.alerts.authority, 'agentx-product-alerts');
  assert.equal(result.alerts.active[0].ruleId, 'host-offline');
  assert.equal(result.alerts.active[0].provenance, 'agentx-product-alerts');
  assert.equal(result.operatorWarnings.count, 2);
  assert.equal(result.drift.count, 2);
  assert.equal(result.drift.records[1].ownerId, 'overseer');
  assert.equal(result.recommendations[1].code, 'INSPECT_FAILED_AUTOMATION');
  assert.equal(result.schedules.failing, 1);
  assert.equal(result.runtime.layers[0].id, 'ecosystem');
  assert.equal('host' in result.runtime.layers[0], false);
  assert.equal(result.activity.counts.work, 2, 'aggregate work activity counts remain truthful');
  assert.equal(result.activity.items.some((item) => item.kind === 'work'), false);
  assert.equal(result.responsibilities.lanes[0].workCount, 1);
  assert.equal(result.responsibilities.unassignedCount, 1);
  assert.doesNotMatch(JSON.stringify(result), /private implementation prompt|private worker feedback|Private household task|private note|private work activity detail|lead-private|private-value|Private payroll|sender@example|password=private|C:\\Users|private\\source/);
});

test('full projection caps evidence arrays while retaining uncapped counts', () => {
  const source = projection({
    agents: Array.from({ length: 70 }, (_, id) => ({ id: `agent-${id}` })),
    automations: Array.from({ length: 90 }, (_, id) => ({ id: `job-${id}`, health: 'healthy' })),
    work: {
      counts: { queued: 55 },
      active: Array.from({ length: 55 }, (_, id) => ({ pipelineId: `${id}`, status: 'queued' })),
      recent: Array.from({ length: 55 }, (_, id) => ({ pipelineId: `${id}`, status: 'done' })),
    },
    warnings: Array.from({ length: 50 }, (_, id) => ({ id: `warning-${id}`, severity: 'warning', title: `Warning ${id}` })),
    alertEvidence: {
      available: true,
      degraded: false,
      authority: 'agentx-product-alerts',
      activeCount: 50,
      returnedCount: 50,
      countComplete: true,
      records: Array.from({ length: 50 }, (_, id) => ({ id: `alert-${id}`, ruleId: `rule-${id}`, severity: 'warning', status: 'active' }))
    },
  });
  const result = buildFullSnapshot(source);
  assert.equal(result.runtime.agentCount, 70);
  assert.equal(result.runtime.agents.length, FULL_SNAPSHOT_CAPS.agents);
  assert.equal(result.schedules.count, 90);
  assert.equal(result.schedules.entries.length, FULL_SNAPSHOT_CAPS.automations);
  assert.equal(result.pipeline.activeCount, 55);
  assert.equal(result.pipeline.active.length, FULL_SNAPSHOT_CAPS.pipelineActive);
  assert.equal(result.pipeline.recent.length, FULL_SNAPSHOT_CAPS.pipelineRecent);
  assert.equal(result.alerts.activeCount, 50);
  assert.equal(result.alerts.projectedCount, 50);
  assert.equal(result.alerts.returnedCount, FULL_SNAPSHOT_CAPS.alerts);
  assert.equal(result.alerts.active.length, FULL_SNAPSHOT_CAPS.alerts);
  assert.equal(result._mcp.capped.alerts, true);
  assert.equal(result._mcp.capped.summaryOnly, false);
  assert.equal(result.drift.records.length, 0, 'generic warnings are not mislabeled as explicit drift');
  assert.equal(result.recommendations.length, 0);
  assert.equal(result._mcp.capped.pipelineActive, true);

  const incomplete = buildFullSnapshot(projection({
    alertEvidence: {
      available: true,
      degraded: false,
      authority: 'agentx-product-alerts',
      activeCount: 120,
      returnedCount: 100,
      countComplete: false,
      records: Array.from({ length: 100 }, (_, id) => ({
        id: `alert-${id}`, ruleId: `rule-${id}`, severity: 'warning', status: 'active'
      }))
    }
  }));
  assert.equal(incomplete.alerts.activeCount, 120);
  assert.equal(incomplete.alerts.projectedCount, 100);
  assert.equal(incomplete.alerts.returnedCount, FULL_SNAPSHOT_CAPS.alerts);
  assert.equal(incomplete.alerts.active.length, FULL_SNAPSHOT_CAPS.alerts);
  assert.equal(incomplete.alerts.countComplete, false);
  assert.equal(incomplete._mcp.capped.alerts, true);
});

test('tool supports the Overseer full/60000 contract and falls back within a smaller ceiling', async () => {
  const full = await callEcosystemSnapshot({ mode: 'full', maxChars: 60000 }, { projectionProvider: async () => projection() });
  assert.equal(full.isError, false);
  assert.equal(full.structuredContent.pipeline.active.length, 2);
  assert.ok(JSON.stringify(full.structuredContent).length <= 60000);
  assert.equal(full.content[0].text, JSON.stringify(full.structuredContent));
  assert.ok(full.content[0].text.length <= 60000);

  const longTitle = 'x'.repeat(1000);
  const bounded = await callEcosystemSnapshot({ mode: 'full', maxChars: 5000 }, {
    projectionProvider: async () => projection({
      agents: Array.from({ length: 60 }, (_, id) => ({ id: `agent-${id}`, responsibility: longTitle })),
      automations: Array.from({ length: 80 }, (_, id) => ({ id: `job-${id}`, purpose: longTitle })),
    }),
  });
  assert.equal(bounded.isError, false);
  assert.equal(bounded.structuredContent.truncated, true);
  assert.deepEqual(bounded.structuredContent.pipeline.counts, { queued: 2, review: 1, done: 3 });
  assert.equal(bounded.structuredContent.alerts.returnedCount, 0);
  assert.equal(bounded.structuredContent.alerts.projectedCount, 1);
  assert.deepEqual(bounded.structuredContent.alerts.active, []);
  assert.equal(typeof bounded.structuredContent._mcp.capped, 'object');
  assert.equal(bounded.structuredContent._mcp.capped.summaryOnly, true);
  assert.ok(JSON.stringify(bounded.structuredContent).length <= 5000);
});

test('argument and schema failures return clear MCP tool errors', async () => {
  assert.throws(() => validateArguments({ mode: 'compact' }), /unsupported ecosystem snapshot mode/);
  assert.throws(() => validateArguments({ mode: 'full', maxChars: 60001 }), /5000 through 60000/);
  assert.throws(() => validateArguments({ mode: 'full', extra: true }), /unsupported argument/);

  const invalidArgs = await callEcosystemSnapshot({ mode: 'compact' }, { projectionProvider: async () => projection() });
  assert.equal(invalidArgs.isError, true);
  assert.equal(invalidArgs.structuredContent.error, 'INVALID_ARGUMENTS');
  const invalidProjection = await callEcosystemSnapshot({ mode: 'full' }, { projectionProvider: async () => ({ schemaVersion: 4 }) });
  assert.equal(invalidProjection.isError, true);
  assert.equal(invalidProjection.structuredContent.error, 'ECOSYSTEM_SNAPSHOT_PROJECTION_INVALID');
  const providerFailure = await callEcosystemSnapshot({ mode: 'full' }, {
    projectionProvider: async () => { throw new Error('token=private-value C:\\private\\operator'); },
  });
  assert.equal(providerFailure.isError, true);
  assert.equal(providerFailure.structuredContent.message, 'Agent Ops projection could not be collected.');
  assert.doesNotMatch(JSON.stringify(providerFailure), /private-value|private\\operator/);
});

test('tools/list merge preserves downstream and later-extension tools without duplicates', () => {
  const productTool = { name: 'check_health', description: 'Product tool' };
  const householdTool = { name: 'list_personal_tasks', description: 'Household tool' };
  const merged = mergeTools({ jsonrpc: '2.0', id: 1, result: { tools: [productTool, householdTool] } });
  assert.deepEqual(merged.result.tools.slice(0, 2), [productTool, householdTool]);
  assert.equal(merged.result.tools[2], ECOSYSTEM_SNAPSHOT_TOOL);
  assert.equal(mergeTools(merged).result.tools.filter((tool) => tool.name === 'ecosystem_snapshot').length, 1);
  const collision = mergeTools({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'ecosystem_snapshot', inputSchema: { type: 'string' } }] } });
  assert.equal(collision.error.code, -32009);
  assert.deepEqual(collision.error.data, {
    code: 'MCP_TOOL_OWNERSHIP_COLLISION', tool: 'ecosystem_snapshot'
  });
  const downstreamError = { jsonrpc: '2.0', id: 1, error: { code: -1 } };
  assert.equal(mergeTools(downstreamError), downstreamError);
});

test('middleware traverses downstream list/non-target calls and intercepts only the snapshot', async () => {
  const providerCalls = [];
  const middleware = ecosystemSnapshotMcpMiddleware({
    projectionProvider: async () => { providerCalls.push('projection'); return projection(); },
  });

  const listRes = response();
  let listNext = false;
  await middleware(request(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { authorization: 'Bearer secret' }
  ), listRes, () => { listNext = true; });
  assert.equal(listNext, true);
  listRes.json({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'check_health' }] } });
  assert.deepEqual(listRes.body.result.tools.map((tool) => tool.name), ['check_health', 'ecosystem_snapshot']);

  let otherNext = false;
  await middleware(request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'check_health' } }), response(), () => { otherNext = true; });
  assert.equal(otherNext, true);

  const allowed = response();
  await middleware(request(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ecosystem_snapshot', arguments: { mode: 'full', maxChars: 60000 } } },
    { authorization: 'Bearer secret' }
  ), allowed, () => {});
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.result.isError, false);
  assert.equal(providerCalls.length, 1);
});

test('registration matches the household MCP boundary', () => {
  const uses = [];
  const parser = { kind: 'standard-json-parser' };
  registerEcosystemSnapshotMcp({
    app: { use(...args) { uses.push(args); } },
    standardJsonParser: parser,
    projectionProvider: async () => projection(),
  });
  assert.deepEqual(uses[0][0], ['/mcp', '/api/mcp']);
  assert.equal(uses[0][1], parser);
  assert.equal(typeof uses[0][2], 'function');
});
