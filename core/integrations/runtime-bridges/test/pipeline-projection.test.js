'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPipelineProjection, PIPELINE_ROUTE } = require('../agent-ops/pipeline-projection');
const { createAioOpsEvidenceService } = require('../evidence-service');
const { callEcosystemSnapshot } = require('../ecosystem-snapshot-mcp');
const response = tasks => ({ ok: true, body: { status: 'success', data: { tasks, count: tasks.length } } });
const now = () => new Date('2026-01-01T00:00:00Z');

test('focused Pipeline read completes while full inventory is still pending and uses its own cache', async () => {
  let finishFull, fullCalls = 0, pipelineCalls = 0;
  const fullResult = { full: true };
  const service = createAioOpsEvidenceService({
    agentOpsBuilder: () => { fullCalls++; return new Promise(resolve => { finishFull = resolve; }); },
    productFetch: async route => {
      assert.equal(route, PIPELINE_ROUTE); pipelineCalls++;
      return response([{ pipelineId: '1001', title: 'Current work', status: 'queued', priority: 1 }]);
    },
    openClawProvider: () => assert.fail('focused read must not collect runtime inventory'),
    hermesProvider: () => assert.fail('focused read must not probe Hermes')
  });
  const full = service.getEcosystemProjection({ mode: 'full' });
  const result = await callEcosystemSnapshot({ mode: 'pipeline', maxChars: 5000 }, {
    projectionProvider: service.getEcosystemProjection
  });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.pipeline.active[0].pipelineId, '1001');
  assert.equal(result.structuredContent.runtime, undefined);
  await service.getEcosystemProjection({ mode: 'pipeline' });
  assert.equal(pipelineCalls, 1);
  await service.getEcosystemProjection({ mode: 'pipeline', refresh: true });
  assert.equal(pipelineCalls, 2);
  finishFull(fullResult); assert.equal(await full, fullResult);
  assert.equal(await service.getAgentOpsProjection(), fullResult);
  assert.equal(fullCalls, 1);
});

test('focused read retains privacy, counts, dependencies and priority order from the shared projection', async () => {
  const tasks = [
    { pipelineId: '1001', title: 'Later', status: 'queued', priority: 4, spec: 'PRIVATE_SPEC' },
    { pipelineId: '1002', title: 'Earlier', status: 'blocked', priority: 1, dependsOn: ['1003'] },
    { pipelineId: '1003', title: 'Private household task', status: 'queued', priority: 0, service: 'personal' },
    { pipelineId: '1004', title: 'Finished', status: 'done', priority: 0 }
  ];
  const result = await callEcosystemSnapshot({ mode: 'pipeline', maxChars: 5000 }, {
    projectionProvider: () => buildPipelineProjection({ fetchJson: async () => response(tasks), now })
  });
  const p = result.structuredContent;
  assert.equal(result.isError, false); assert.equal(p.generatedAt, now().toISOString());
  assert.deepEqual(p.pipeline.active.map(row => row.pipelineId), ['1002', '1001']);
  assert.deepEqual(p.pipeline.active[0].dependsOn, ['1003']);
  assert.equal(p.pipeline.counts.queued, 2); assert.equal(p.pipeline.counts.done, 1);
  assert.equal(p.pipeline.withheldActiveCount, 1); assert.equal(p.pipeline.countsComplete, true);
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE_SPEC|Private household task/);
});

test('unavailable or invalid Pipeline never becomes an authoritative empty result', async () => {
  for (const fetchJson of [async () => { throw new Error('secret=synthetic'); },
    async () => ({ ok: false }), async () => ({ ok: true, body: { status: 'success', data: { tasks: [], count: 3 } } })]) {
    const result = await callEcosystemSnapshot({ mode: 'pipeline', maxChars: 5000 }, {
      projectionProvider: () => buildPipelineProjection({ fetchJson, now })
    });
    assert.equal(result.structuredContent.pipelineSource.status, 'degraded');
    assert.equal(result.structuredContent.pipeline.countsComplete, false);
    assert.doesNotMatch(JSON.stringify(result), /secret=synthetic/);
  }
});

test('a source page at the existing ceiling retains incomplete counts', async () => {
  const tasks = Array.from({ length: 1000 }, (_, i) => ({ pipelineId: String(i), status: 'queued', priority: i }));
  const value = await buildPipelineProjection({ fetchJson: async () => response(tasks), now });
  assert.equal(value.work.counts.queued, 1000); assert.equal(value.work.countsComplete, false);
});
