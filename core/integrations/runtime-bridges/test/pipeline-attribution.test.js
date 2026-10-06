'use strict';

const assert = require('assert');
const test = require('node:test');

const {
  PIPELINE_CONSUMER_CONTRACT,
  PIPELINE_MODEL_ALIAS,
  PipelineAttributionLeaseManager
} = require('../pipeline-attribution');

function qualifiedSnapshot(model = 'qwen-qualified') {
  return {
    tasks: {
      code_generation: {
        model,
        inferenceContract: { qualification: { qualified: true } }
      }
    }
  };
}

function activeTask(overrides = {}) {
  return {
    pipelineId: '0401',
    status: 'in_progress',
    assignee: 'clawdx-coder',
    automationAttemptCount: 1,
    automationLease: { attempt: 1 },
    automationAttempts: [{ attempt: 1, finalState: 'active' }],
    ...overrides
  };
}

test('a capacity-backed task carries its frozen host and exact lease into native inference', async () => {
  const target = { model: 'reference-model', hostUrl: 'http://model.test:11434', contextSize: 32768, keepAlive: -1,
    inferenceContract: { qualification: { qualified: true }, artifact: { digest: 'digest', runtimeFingerprint: 'runtime' } } };
  const task = activeTask({ automationLease: { attempt: 1, leaseId: 'task-lease' }, codingCapacity: {
    model: target.model, host: target.hostUrl, numCtx: 32768, keepAlive: -1, digest: 'digest', runtimeFingerprint: 'runtime',
  } });
  const manager = new PipelineAttributionLeaseManager({ taskReader: async () => task,
    snapshotProvider: async () => ({ tasks: { code_generation: target } }) });
  await manager.open({ pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'capacity-run' });
  const inference = await manager.authorizeAlias(PIPELINE_MODEL_ALIAS);
  assert.deepEqual(inference.codingCapacity, { pipelineId: '0401', leaseId: 'task-lease' });
  assert.equal(inference.hostUrl, target.hostUrl);
  assert.equal(inference.numCtx, 32768);
  assert.equal(manager.status().active.codingCapacity, undefined);
  target.hostUrl = 'http://different.test:11434';
  await assert.rejects(manager.revalidate(inference.attribution.correlationId), error => error.code === 'CODING_CAPACITY_CHANGED');
});

test('inference backoff revalidates one logical call, preserves progress and refuses replay after restart', async () => {
  let task = activeTask();
  const options = { taskReader: async () => task, snapshotProvider: async () => qualifiedSnapshot(),
    randomId: () => 'same-lease' };
  const manager = new PipelineAttributionLeaseManager(options);
  await manager.open({ pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'one-task' });
  const call = await manager.authorizeAlias(PIPELINE_MODEL_ALIAS);
  await manager.revalidate(call.attribution.correlationId);
  manager.progress('same-lease', { state: 'waiting', cause: 'inference_active', attempts: 1 });
  assert.equal(manager.status().active.inference.state, 'waiting');
  await manager.revalidate('same-lease');
  assert.equal(manager.status().active.requestCount, 1);
  assert.equal(task.automationAttemptCount, 1);
  const restarted = new PipelineAttributionLeaseManager(options);
  await assert.rejects(restarted.revalidate('same-lease'), error => error.code === 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED');
  assert.equal(restarted.status().active, null);
  manager.progress('same-lease', { state: 'completed', attempts: 2, history: [{ attempt: 1, cause: 'inference_active', delayMs: 2000 }] });
  const receipt = manager.close({ leaseId: 'same-lease', requestId: 'one-task' });
  assert.equal(receipt.requestCount, 1);
  assert.equal(receipt.inference.attempts, 2);
});

test('cancellation or deadline changes stop inference retries without a new claim', async () => {
  let task = activeTask();
  const manager = new PipelineAttributionLeaseManager({ taskReader: async () => task,
    snapshotProvider: async () => qualifiedSnapshot(), randomId: () => 'deadline-lease' });
  await manager.open({ pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'one-task' });
  await manager.authorizeAlias(PIPELINE_MODEL_ALIAS);
  task = { ...task, status: 'blocked' };
  await assert.rejects(manager.revalidate('deadline-lease'), error => error.code === 'PIPELINE_ATTRIBUTION_TASK_MISMATCH');
  task = activeTask({ automationLease: { attempt: 1, expiresAt: '2020-01-01T00:00:00Z' } });
  await assert.rejects(manager.revalidate('deadline-lease'), error => error.code === 'PIPELINE_EXECUTION_DEADLINE');
  assert.equal(manager.status().active.requestCount, 1);
});

test('exclusive lease binds live task truth to qualified server attribution', async () => {
  let now = new Date('2026-09-01T04:00:00.000Z');
  let task = activeTask({
    pipelineId: '0377',
    automationAttemptCount: 2,
    automationLease: { attempt: 2 },
    automationAttempts: [
      { attempt: 1, finalState: 'review', reviewOutcome: 'requeued' },
      { attempt: 2, finalState: 'active' }
    ],
    feedback: [{ by: 'human-owner', text: 'Attempt 1 reviewed and requeued.' }]
  });
  const manager = new PipelineAttributionLeaseManager({
    taskReader: async (pipelineId) => pipelineId === '0377' ? task : null,
    snapshotProvider: async () => qualifiedSnapshot(),
    now: () => now,
    randomId: () => 'lease-0377'
  });
  const input = {
    pipelineId: '0377', assignee: 'clawdx-coder', requestId: 'dispatch-0377',
    taskType: 'code_generation', attempt: 2, ttlSeconds: 60
  };
  const opened = await manager.open(input);
  assert.equal(opened.idempotent, false);
  assert.equal(opened.lease.effectiveModel, 'qwen-qualified');
  const retry = await manager.open(input);
  assert.equal(retry.idempotent, true);
  await assert.rejects(
    manager.open({ ...input, requestId: 'another-dispatch' }),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_BUSY'
  );

  const authorized = await manager.authorizeAlias(PIPELINE_MODEL_ALIAS);
  assert.equal(authorized.effectiveModel, 'qwen-qualified');
  assert.equal(authorized.consumerContract, PIPELINE_CONSUMER_CONTRACT);
  assert.deepEqual(authorized.attribution, {
    workItemId: '0377', correlationId: 'lease-0377', runtime: 'external', attempt: 2
  });
  assert.equal(manager.status().active.requestCount, 1);

  const closed = manager.close({ leaseId: 'lease-0377', requestId: 'dispatch-0377' });
  assert.deepEqual(closed, { closed: true, idempotent: false, requestCount: 1 });
  assert.equal(manager.close({ leaseId: 'lease-0377', requestId: 'dispatch-0377' }).idempotent, true);
  assert.equal(manager.status().active, null);
  assert.equal(manager.status().counters.attributedRequests, 1);

  now = new Date('2026-09-01T04:01:01.000Z');
  task = { ...task, status: 'review' };
  await assert.rejects(
    manager.authorizeAlias(PIPELINE_MODEL_ALIAS),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED'
  );
});

test('lease is revoked when Pipeline assignment or effective model drifts', async () => {
  let task = activeTask();
  let model = 'model-a';
  const manager = new PipelineAttributionLeaseManager({
    taskReader: async () => task,
    snapshotProvider: async () => qualifiedSnapshot(model),
    randomId: () => 'lease-0401'
  });
  await manager.open({
    pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'dispatch-0401',
    taskType: 'code_generation'
  });
  task = { ...task, assignee: 'someone-else' };
  await assert.rejects(
    manager.authorizeAlias(PIPELINE_MODEL_ALIAS),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_TASK_MISMATCH'
  );
  assert.equal(manager.status().active, null);

  task = { ...task, assignee: 'clawdx-coder' };
  await manager.open({
    pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'dispatch-0401-retry',
    taskType: 'code_generation'
  });
  model = 'model-b';
  await assert.rejects(
    manager.authorizeAlias(PIPELINE_MODEL_ALIAS),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_MODEL_DRIFT'
  );
  assert.equal(manager.status().active, null);
});

test('simultaneous opens serialize so only one exclusive lease can win', async () => {
  let nextId = 0;
  const manager = new PipelineAttributionLeaseManager({
    taskReader: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return activeTask({ assignee: 'worker' });
    },
    snapshotProvider: async () => qualifiedSnapshot(),
    randomId: () => `lease-${++nextId}`
  });
  const base = {
    pipelineId: '0450', assignee: 'worker', taskType: 'code_generation'
  };
  const results = await Promise.allSettled([
    manager.open({ ...base, requestId: 'dispatch-a' }),
    manager.open({ ...base, requestId: 'dispatch-b' })
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
  const rejected = results.find((row) => row.status === 'rejected');
  assert.equal(rejected.reason.code, 'PIPELINE_ATTRIBUTION_BUSY');
  assert.equal(manager.status().counters.opened, 1);
});

test('unqualified lanes, expired leases, and mismatched closes fail closed', async () => {
  let now = new Date('2026-09-01T04:00:00.000Z');
  let qualified = false;
  const manager = new PipelineAttributionLeaseManager({
    taskReader: async () => activeTask({ assignee: 'worker' }),
    snapshotProvider: async () => ({
      tasks: { code_generation: { model: 'model-a', inferenceContract: { qualification: { qualified } } } }
    }),
    now: () => now,
    randomId: () => 'lease-expiring'
  });
  const input = {
    pipelineId: '0501', assignee: 'worker', requestId: 'dispatch-0501',
    taskType: 'code_generation', ttlSeconds: 30
  };
  await assert.rejects(
    manager.open(input),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_MODEL_UNQUALIFIED'
  );
  qualified = true;
  await manager.open(input);
  assert.throws(
    () => manager.close({ leaseId: 'wrong-lease', requestId: 'dispatch-0501' }),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_LEASE_MISMATCH'
  );
  now = new Date('2026-09-01T04:00:31.000Z');
  await assert.rejects(
    manager.authorizeAlias(PIPELINE_MODEL_ALIAS),
    (error) => error.code === 'PIPELINE_ATTRIBUTION_LEASE_REQUIRED'
  );
  assert.equal(manager.status().counters.expired, 1);
});

test('contradictory Pipeline attempt authorities fail closed', async () => {
  const invalidTasks = [
    activeTask({
      automationAttemptCount: 2,
      automationLease: { attempt: 2 },
      automationAttempts: [{ attempt: 1, finalState: 'active' }]
    }),
    activeTask({
      automationAttemptCount: 2,
      automationLease: { attempt: 1 },
      automationAttempts: [
        { attempt: 1, finalState: 'review' },
        { attempt: 2, finalState: 'active' }
      ]
    })
  ];

  for (const task of invalidTasks) {
    const manager = new PipelineAttributionLeaseManager({
      taskReader: async () => task,
      snapshotProvider: async () => qualifiedSnapshot()
    });
    await assert.rejects(
      manager.open({
        pipelineId: '0401', assignee: 'clawdx-coder', requestId: 'dispatch-invalid',
        taskType: 'code_generation'
      }),
      (error) => error.code === 'PIPELINE_ATTRIBUTION_ATTEMPT_AUTHORITY_INVALID'
    );
  }
});
