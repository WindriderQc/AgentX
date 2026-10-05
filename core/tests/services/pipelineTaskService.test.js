const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const Counter = require('../../models/Counter');
const { buildRevision } = require('../../src/services/pipelineTaskPlans');
const {
  normalizeTaskRoutingMetadata,
  createTaskInMongo,
  findNextEligibleTask,
  claimEligibleTask,
  assertNoDependencyCycle,
  heartbeatClaim,
  releaseAutomationSlot,
  assertLeaseMutationAllowed,
} = require('../../src/services/pipelineTaskService');

function reviewOnlyAutomation(overrides = {}) {
  return {
    schema: 'agentx.pipeline-automation/v1',
    mode: 'review_only',
    policyRef: 'product.low-risk-code/v1',
    dataClassification: 'public',
    operations: ['create', 'update'],
    scope: ['core/src/example.js'],
    lockKeys: ['repo:core/example'],
    executionProfile: 'workspace-write-no-network/v1',
    verificationProfile: 'core-unit/v1',
    budgets: {
      maxDurationMs: 900000,
      maxAttempts: 2,
      maxCostNanodollars: 0,
    },
    humanGates: ['review', 'merge', 'deploy'],
    ...overrides,
  };
}

describe('pipeline task eligibility and metadata', () => {
  beforeEach(async () => {
    await PipelineTask.deleteMany({});
    await PipelineAutomationSlot.deleteMany({});
    await Counter.deleteMany({ _id: 'pipelineTask' });
  });

  test('normalizes priority, dependencies, dates, risk, and the surface_after alias', () => {
    const metadata = normalizeTaskRoutingMetadata({
      priority: '1',
      dependsOn: ['0042', '0042', '0043'],
      surface_after: '2026-08-07T12:00:00Z',
      dueAt: '2026-08-08T12:00:00Z',
      risk: 'HIGH',
    });

    expect(metadata).toMatchObject({
      priority: 1,
      dependsOn: ['0042', '0043'],
      risk: 'high',
    });
    expect(metadata.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
    expect(metadata.dueAt.toISOString()).toBe('2026-08-08T12:00:00.000Z');
  });

  test('normalizes a fingerprinted review-only automation intent', () => {
    const metadata = normalizeTaskRoutingMetadata({
      risk: 'low',
      automation: reviewOnlyAutomation(),
    });

    expect(metadata.automation).toMatchObject({
      schema: 'agentx.pipeline-automation/v1',
      mode: 'review_only',
      scope: ['core/src/example.js'],
      humanGates: ['deploy', 'merge', 'review'],
    });
    expect(metadata.automation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test.each([
    [reviewOnlyAutomation({ scope: ['../outside'] }), 'INVALID_AUTOMATION_INTENT'],
    [reviewOnlyAutomation({ humanGates: ['review', 'deploy', 'protected_change'] }), 'AUTOMATION_HUMAN_GATE_REQUIRED'],
    [reviewOnlyAutomation({ budgets: { maxDurationMs: 0, maxAttempts: 2, maxCostNanodollars: 0 } }), 'INVALID_AUTOMATION_INTENT'],
  ])('rejects ambiguous automation intent %#', (automation, code) => {
    expect(() => normalizeTaskRoutingMetadata({ automation })).toThrow(
      expect.objectContaining({ code })
    );
  });

  test.each([
    [{ priority: 0 }, 'INVALID_TASK_PRIORITY'],
    [{ dependsOn: ['abc'] }, 'INVALID_TASK_DEPENDENCIES'],
    [{ notBefore: 'tomorrow-ish' }, 'INVALID_TASK_DATE'],
    [{ risk: 'extreme' }, 'INVALID_TASK_RISK'],
  ])('rejects invalid routing metadata %#', (input, code) => {
    expect(() => normalizeTaskRoutingMetadata(input)).toThrow(
      expect.objectContaining({ code })
    );
  });

  test('persists creation metadata and requires referenced dependencies to exist', async () => {
    await PipelineTask.create({ pipelineId: '0042', title: 'prerequisite', status: 'done' });

    const created = await createTaskInMongo({
      title: 'scheduled work',
      service: 'core',
      priority: 2,
      dependsOn: ['0042'],
      notBefore: '2026-08-07T12:00:00Z',
      dueAt: '2026-08-08T12:00:00Z',
      risk: 'medium',
    });
    const stored = await PipelineTask.findOne({ pipelineId: created.pipelineId }).lean();

    expect(stored).toMatchObject({
      priority: 2,
      dependsOn: ['0042'],
      risk: 'medium',
    });
    expect(stored.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
    await expect(createTaskInMongo({ title: 'bad dependency', dependsOn: ['0999'] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_TASK_DEPENDENCY', status: 400 });
  });

  test.each([
    { title: 'Concise task', objective: 'Keep this complete objective.' },
    { title: 'Partial task', objective: 'Keep this objective.', steps: ['Read the code'], constraints: ['No model campaign'] },
    { title: 'Camel case task', objective: 'Keep these details.', service: 'core', sourceFiles: ['core/routes/pipeline.js'], steps: ['Inspect persistence'], constraints: ['Preserve the API'], acceptanceCriteria: ['The task is readable'] },
  ])('persists supplied task details for $title', async (input) => {
    const created = await createTaskInMongo(input);
    const stored = await PipelineTask.findOne({ pipelineId: created.pipelineId }).lean();
    expect(stored.title).toBe(input.title);
    expect(stored.spec).toContain(input.objective);
    for (const field of ['steps', 'constraints', 'sourceFiles', 'acceptanceCriteria']) {
      for (const value of input[field] || []) expect(stored.spec).toContain(value);
    }
  });

  test('preserves an explicit spec verbatim and accepts a title-only task', async () => {
    const spec = '# Operator spec\n\nExact instructions.\n';
    const created = await createTaskInMongo({ title: 'Explicit spec', spec });
    expect((await PipelineTask.findOne({ pipelineId: created.pipelineId })).spec).toBe(spec);
    await expect(createTaskInMongo({ title: 'A quick reminder' })).resolves.toMatchObject({ title: 'A quick reminder' });
  });

  test('source-scoped idempotency keys return the existing task on retry', async () => {
    const first = await createTaskInMongo({
      title: 'memory follow-up', source: 'memory-review', sourceKey: 'candidate:abc',
    });
    const second = await createTaskInMongo({
      title: 'memory follow-up retry', source: 'memory-review', sourceKey: 'candidate:abc',
    });
    expect(second.pipelineId).toBe(first.pipelineId);
    expect(second.alreadyExisting).toBe(true);
    expect(await PipelineTask.countDocuments({ source: 'memory-review' })).toBe(1);
  });

  test('distinguishes an absent date gate from an explicitly cleared one', () => {
    // Absent: leave whatever is stored alone.
    expect(normalizeTaskRoutingMetadata({})).not.toHaveProperty('notBefore');
    expect(normalizeTaskRoutingMetadata({})).not.toHaveProperty('dueAt');

    // Explicitly cleared: surface the task now. Collapsing this to "absent"
    // silently keeps an old gate and the card stays invisible.
    expect(normalizeTaskRoutingMetadata({ notBefore: '' })).toHaveProperty('notBefore', null);
    expect(normalizeTaskRoutingMetadata({ notBefore: null })).toHaveProperty('notBefore', null);
    expect(normalizeTaskRoutingMetadata({ dueAt: '' })).toHaveProperty('dueAt', null);

    // An explicit null must not fall through to the surface_after alias.
    expect(normalizeTaskRoutingMetadata({
      notBefore: null,
      surface_after: '2026-08-07T12:00:00Z',
    })).toHaveProperty('notBefore', null);

    // The alias still applies when notBefore is genuinely absent.
    const aliased = normalizeTaskRoutingMetadata({ surface_after: '2026-08-07T12:00:00Z' });
    expect(aliased.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  test('rejects self-dependencies and cycles that would make a task unclaimable', async () => {
    await expect(assertNoDependencyCycle('0500', ['0500']))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCY_CYCLE', status: 400 });

    // 0501 -> 0502 -> 0503. Closing the loop means giving 0503 a dependency
    // that reaches back to it, which is only visible two hops out.
    await PipelineTask.create([
      { pipelineId: '0501', title: 'a', dependsOn: ['0502'] },
      { pipelineId: '0502', title: 'b', dependsOn: ['0503'] },
      { pipelineId: '0503', title: 'c' },
    ]);
    await expect(assertNoDependencyCycle('0503', ['0501']))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCY_CYCLE' });

    // A shortcut edge across the same chain is acyclic and must stay allowed.
    await expect(assertNoDependencyCycle('0501', ['0503'])).resolves.toBeUndefined();
    // A brand-new task depending on the head of the chain terminates cleanly.
    await expect(assertNoDependencyCycle('0504', ['0501'])).resolves.toBeUndefined();
    await expect(assertNoDependencyCycle('0504', [])).resolves.toBeUndefined();
  });

  test('a task that depends on itself is never returned as eligible work', async () => {
    // Reachable today only by a hand-edited row, which is exactly the case the
    // guard exists for. Left undetected it reads as "no work available".
    await PipelineTask.create({ pipelineId: '0600', title: 'self blocked', dependsOn: ['0600'] });
    expect(await findNextEligibleTask({}, new Date('2026-08-06T12:00:00Z'))).toBeNull();
  });

  test('selects only eligible work by priority, due date, then pipeline id', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    await PipelineTask.create([
      { pipelineId: '0100', title: 'done dependency', status: 'done' },
      { pipelineId: '0101', title: 'open dependency', status: 'queued' },
      { pipelineId: '0200', title: 'blocked high priority', priority: 1, dependsOn: ['0101'] },
      { pipelineId: '0201', title: 'later due', priority: 1, dependsOn: ['0100'], dueAt: '2026-08-09T00:00:00Z' },
      { pipelineId: '0202', title: 'earlier due', priority: 1, dueAt: '2026-08-08T00:00:00Z' },
      { pipelineId: '0203', title: 'future', priority: 1, notBefore: '2026-08-07T00:00:00Z' },
      { pipelineId: '0204', title: 'lower priority', priority: 5 },
    ]);

    const next = await findNextEligibleTask({}, now);
    expect(next.pipelineId).toBe('0202');
  });

  test('autonomous selection is opt-in, low-risk, dependency-aware, and attempt-bounded', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create([
      { pipelineId: '0250', title: 'manual priority', priority: 1, risk: 'low' },
      { pipelineId: '0251', title: 'high risk', priority: 1, risk: 'high', automation },
      { pipelineId: '0252', title: 'attempt exhausted', priority: 1, risk: 'low', automation, automationAttemptCount: 2 },
      { pipelineId: '0253', title: 'admissible', priority: 2, risk: 'low', automation },
    ]);

    expect((await findNextEligibleTask({}, now)).pipelineId).toBe('0250');
    expect((await findNextEligibleTask({ automation: 'review_only' }, now)).pipelineId).toBe('0253');
  });

  test('claim rechecks time and dependencies, then permits only one concurrent winner', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    await PipelineTask.create([
      { pipelineId: '0300', title: 'future', notBefore: '2026-08-07T00:00:00Z' },
      { pipelineId: '0301', title: 'dependency', status: 'queued' },
      { pipelineId: '0302', title: 'blocked', dependsOn: ['0301'] },
      { pipelineId: '0303', title: 'claimable' },
    ]);

    await expect(claimEligibleTask('0300', 'worker-a', now))
      .rejects.toMatchObject({ code: 'TASK_NOT_READY', status: 409 });
    await expect(claimEligibleTask('0302', 'worker-a', now))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCIES_BLOCKED', status: 409 });

    const results = await Promise.allSettled([
      claimEligibleTask('0303', 'worker-a', now),
      claimEligibleTask('0303', 'worker-b', now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('TASK_UNAVAILABLE');
  });

  test('automated claim creates one bounded lease and lease-bound heartbeat rejects stale identity', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create({
      pipelineId: '0310',
      title: 'automated claim',
      risk: 'low',
      automation,
    });

    const claimed = await claimEligibleTask('0310', 'worker-a', now, {
      automated: true,
      leaseDurationMs: 60000,
    });
    expect(claimed).toMatchObject({
      status: 'in_progress',
      assignee: 'worker-a',
      automationAttemptCount: 1,
    });
    expect(claimed.automationLease.leaseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(claimed.automationAttempts).toHaveLength(1);
    expect(claimed.automationAttempts[0].planRevision).toBeUndefined();
    expect(claimed.automationAttempts[0].planFingerprint).toBeUndefined();
    // The claim and its typed transition are one write; the lease appears only as a fingerprint.
    expect(claimed.toObject().transitions).toEqual([expect.objectContaining({
      seq: 1, from: 'queued', to: 'in_progress', kind: 'claimed', attempt: 1,
      actor: { declared: 'worker-a', authenticated: null, channel: 'automation_lease' },
      evidence: expect.objectContaining({ attemptRef: 'task-0310/attempt-1', leaseRef: expect.stringMatching(/^lease-[a-f0-9]{16}$/) }),
    })]);
    expect(JSON.stringify(claimed.transitions)).not.toContain(claimed.automationLease.leaseId);

    await expect(heartbeatClaim('0310', {
      assignee: 'worker-a',
      leaseId: '00000000-0000-0000-0000-000000000000',
    }, new Date(now.getTime() + 1000))).rejects.toMatchObject({ code: 'TASK_LEASE_MISMATCH' });

    const heartbeat = await heartbeatClaim('0310', {
      assignee: 'worker-a',
      leaseId: claimed.automationLease.leaseId,
    }, new Date(now.getTime() + 1000));
    expect(heartbeat.automationLease.expiresAt.toISOString()).toBe('2026-08-06T12:01:01.000Z');
  });

  test('binds each automated attempt to its own launch request without substitutes', async () => {
    const { taskEvidenceReferences } = require('../../src/services/pipelineEvidenceReferences');
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create({ pipelineId: '0315', title: 'two requests', risk: 'low', automation });
    const first = '10000000-0000-4000-8000-000000000001';
    const second = '10000000-0000-4000-8000-000000000002';

    await expect(claimEligibleTask('0315', 'worker-a', now, {
      automated: true, leaseDurationMs: 60000, dispatchRequestId: '../host/path',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_DISPATCH_REQUEST' });
    expect((await PipelineTask.findOne({ pipelineId: '0315' }).lean()).automationAttemptCount).toBe(0);
    expect(await PipelineAutomationSlot.findOne({ leaseId: { $type: 'string' } }).lean()).toBeNull();

    const claimed = await claimEligibleTask('0315', 'worker-a', now, {
      automated: true, leaseDurationMs: 60000, dispatchRequestId: first,
    });
    expect(claimed.automationLease.dispatchRequestId).toBe(first);
    expect(claimed.automationAttempts[0].dispatchRequestId).toBe(first);
    await releaseAutomationSlot({ leaseId: claimed.automationLease.leaseId, pipelineId: '0315', assignee: 'worker-a' });
    await PipelineTask.updateOne({ pipelineId: '0315' }, {
      $set: { status: 'queued', assignee: null, 'automationAttempts.0.finalState': 'released' },
      $unset: { automationLease: 1 },
    });
    await claimEligibleTask('0315', 'worker-b', new Date(now.getTime() + 1000), {
      automated: true, leaseDurationMs: 60000, dispatchRequestId: second,
    });

    const refs = taskEvidenceReferences(await PipelineTask.findOne({ pipelineId: '0315' }).lean());
    expect(refs.attempts.map(({ attempt, request }) => [attempt, request.requestId])).toEqual([[2, second], [1, first]]);
    expect(refs.activeLease).toMatchObject({ status: 'bound', attempt: 2 });
    expect(refs.conflicts).toEqual([]);
    expect(JSON.stringify(refs)).not.toContain(claimed.automationLease.leaseId);
  });

  test('binds each automated attempt to the current plan revision and fingerprint', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create({ pipelineId: '0316', title: 'planned claim', risk: 'low', automation });
    const task = await PipelineTask.findOne({ pipelineId: '0316' }).lean();
    const firstPlan = buildRevision(task, { text: 'First plan', channel: 'plan_api' });
    await PipelineTask.updateOne({ pipelineId: '0316' }, {
      $set: { planRevision: firstPlan.revision, planRevisions: [firstPlan] },
    });

    const first = await claimEligibleTask('0316', 'worker-a', now, {
      automated: true, leaseDurationMs: 60000,
    });
    expect(first.automationAttempts[0]).toMatchObject({
      planRevision: 1, planFingerprint: firstPlan.fingerprint,
    });

    await releaseAutomationSlot({ leaseId: first.automationLease.leaseId, pipelineId: '0316', assignee: 'worker-a' });
    await PipelineTask.updateOne({ pipelineId: '0316' }, {
      $set: { status: 'queued', assignee: null, 'automationAttempts.0.finalState': 'released' },
      $unset: { automationLease: 1 },
    });
    const secondPlan = buildRevision(await PipelineTask.findOne({ pipelineId: '0316' }).lean(), {
      text: 'Second plan', channel: 'plan_api',
    });
    await PipelineTask.updateOne({ pipelineId: '0316' }, {
      $set: { planRevision: secondPlan.revision },
      $push: { planRevisions: secondPlan },
    });

    const second = await claimEligibleTask('0316', 'worker-b', new Date(now.getTime() + 1000), {
      automated: true, leaseDurationMs: 60000,
    });
    expect(second.automationAttempts.map(({ planRevision, planFingerprint }) => [planRevision, planFingerprint]))
      .toEqual([[1, firstPlan.fingerprint], [2, secondPlan.fingerprint]]);
  });

  test('refuses a claim when its plan changes after eligibility and releases the slot', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create({ pipelineId: '0317', title: 'racing plan', risk: 'low', automation });
    const firstPlan = buildRevision(await PipelineTask.findOne({ pipelineId: '0317' }).lean(), {
      text: 'First plan', channel: 'plan_api',
    });
    await PipelineTask.updateOne({ pipelineId: '0317' }, {
      $set: { planRevision: 1, planRevisions: [firstPlan] },
    });
    const originalUpdate = PipelineTask.findOneAndUpdate.bind(PipelineTask);
    const spy = jest.spyOn(PipelineTask, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      const secondPlan = buildRevision(await PipelineTask.findOne({ pipelineId: '0317' }).lean(), {
        text: 'Revised during claim', channel: 'plan_api',
      });
      await PipelineTask.updateOne({ pipelineId: '0317' }, {
        $set: { planRevision: secondPlan.revision },
        $push: { planRevisions: secondPlan },
      });
      return originalUpdate(...args);
    });
    try {
      await expect(claimEligibleTask('0317', 'worker-a', now, {
        automated: true, leaseDurationMs: 60000,
      })).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE', status: 409 });
    } finally {
      spy.mockRestore();
    }
    const task = await PipelineTask.findOne({ pipelineId: '0317' }).lean();
    expect(task).toMatchObject({ status: 'queued', planRevision: 2, automationAttemptCount: 0 });
    expect(task.automationAttempts).toHaveLength(0);
    expect(await PipelineAutomationSlot.countDocuments({ leaseId: { $type: 'string' } })).toBe(0);
  });

  test('refuses an invalid current plan binding before reserving an automation slot', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create({ pipelineId: '0318', title: 'missing plan', risk: 'low', automation });
    await PipelineTask.updateOne({ pipelineId: '0318' }, { $set: { planRevision: 1 } });
    await expect(claimEligibleTask('0318', 'worker-a', now, {
      automated: true, leaseDurationMs: 60000,
    })).rejects.toMatchObject({ code: 'PLAN_REVISION_UNAVAILABLE', status: 409 });
    expect(await PipelineAutomationSlot.countDocuments({})).toBe(0);
  });

  test('a named lease that is no longer on the task is refused instead of acting as unleased input', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    await PipelineTask.create([
      { pipelineId: '0313', title: 'decided after automation', status: 'done', assignee: 'worker-a' },
      { pipelineId: '0314', title: 'manual claim', status: 'in_progress', assignee: 'worker-b' },
    ]);
    const stale = { assignee: 'worker-a', leaseId: '00000000-0000-0000-0000-000000000001', now };
    expect(() => assertLeaseMutationAllowed(
      { status: 'queued', automationLease: undefined }, stale,
    )).toThrow(expect.objectContaining({ code: 'TASK_LEASE_INACTIVE', status: 409 }));
    expect(assertLeaseMutationAllowed({ status: 'in_progress' }, { assignee: 'worker-b', now })).toBeNull();

    await expect(heartbeatClaim('0313', stale, now)).rejects.toMatchObject({ code: 'TASK_LEASE_INACTIVE' });
    expect((await PipelineTask.findOne({ pipelineId: '0313' }).lean()).heartbeatAt).toBeFalsy();
    const manual = await heartbeatClaim('0314', { assignee: 'worker-b' }, now);
    expect(manual.heartbeatAt.toISOString()).toBe(now.toISOString());
  });

  test('atomically permits only one autonomous claim across different task ids', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    const automation = normalizeTaskRoutingMetadata({ automation: reviewOnlyAutomation() }).automation;
    await PipelineTask.create([
      { pipelineId: '0311', title: 'first autonomous task', risk: 'low', automation },
      { pipelineId: '0312', title: 'second autonomous task', risk: 'low', automation },
    ]);

    const results = await Promise.allSettled([
      claimEligibleTask('0311', 'worker-a', now, { automated: true, leaseDurationMs: 60000 }),
      claimEligibleTask('0312', 'worker-b', now, { automated: true, leaseDurationMs: 60000 }),
    ]);
    const winner = results.find((result) => result.status === 'fulfilled').value;
    const loser = results.find((result) => result.status === 'rejected').reason;

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(loser).toMatchObject({ code: 'AUTOMATION_SLOT_OCCUPIED', status: 409 });
    const remainingId = winner.pipelineId === '0311' ? '0312' : '0311';
    expect(await PipelineTask.findOne({ pipelineId: remainingId }).lean()).toMatchObject({
      status: 'queued', assignee: null, automationAttemptCount: 0, automationAttempts: [],
    });

    await releaseAutomationSlot({
      leaseId: winner.automationLease.leaseId,
      pipelineId: winner.pipelineId,
      assignee: winner.assignee,
    });
    const next = await claimEligibleTask(remainingId, 'worker-c', new Date(now.getTime() + 1000), {
      automated: true,
      leaseDurationMs: 60000,
    });
    expect(next.status).toBe('in_progress');
  });
});
