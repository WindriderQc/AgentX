const SpecialX = require('../../models/SpecialX');
const AutomationTask = require('../../models/AutomationTask');
const AutomationRun = require('../../models/AutomationRun');
const { getAutomationRunnerService } = require('../../src/services/automationRunnerService');

describe('SpecialX automation core', () => {
  const service = getAutomationRunnerService();

  beforeEach(async () => {
    await Promise.all([
      SpecialX.deleteMany({}),
      AutomationTask.deleteMany({}),
      AutomationRun.deleteMany({})
    ]);
  });

  afterAll(() => {
    service.stop();
  });

  test('creates default SpecialX operator profile', async () => {
    const profile = await SpecialX.ensureDefaultOperator();

    expect(profile).toBeTruthy();
    expect(profile.name).toBe('specialx.operator.v1');
    expect(profile.modelPolicy.localFirst).toBe(true);
    expect(profile.taskTypes).toEqual(expect.arrayContaining([
      'docs_drift_check',
      'patch_proposal',
      'patch_apply',
      'proposal_expiry_sweep'
    ]));

    const active = await SpecialX.getActive();
    expect(active).toHaveLength(1);
  });

  test('enqueues tasks with idempotency key de-duplication', async () => {
    const first = await service.enqueueTask({
      type: 'repo_summary',
      idempotencyKey: 'same-key'
    }, { userId: 'tester' });

    const second = await service.enqueueTask({
      type: 'repo_summary',
      idempotencyKey: 'same-key'
    }, { userId: 'tester' });

    expect(String(first._id)).toBe(String(second._id));

    const tasks = await AutomationTask.find({});
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('queued');
  });

  test('claims next queued task with lease', async () => {
    await AutomationTask.create({
      type: 'repo_summary',
      status: 'queued',
      runAt: new Date(Date.now() - 1000),
      priority: 3
    });

    const claimed = await AutomationTask.claimNext('worker-1', 20000);
    expect(claimed).toBeTruthy();
    expect(claimed.status).toBe('leased');
    expect(claimed.lease.owner).toBe('worker-1');
    expect(claimed.lease.leaseExpiresAt).toBeTruthy();
  });

  test('computes queue metrics defaults when empty', async () => {
    const metrics = await service.getQueueMetrics();

    expect(metrics.queue.queued).toBe(0);
    expect(metrics.runs.totalRuns24h).toBe(0);
    expect(metrics.runs.localFirstRatio).toBe(100);
  });

  test('dispatches OpenClaw webhook notifications only when configured', async () => {
    const originalWebhookUrl = process.env.OPENCLAW_WEBHOOK_URL;
    const postSpy = jest.spyOn(service, 'postOpenClawWebhook').mockResolvedValue();

    delete process.env.OPENCLAW_WEBHOOK_URL;
    service.notifyOpenClawTaskResult({
      taskId: 'task-1',
      type: 'repo_summary',
      status: 'completed',
      runId: 'run-1',
      summary: 'done',
      completedAt: new Date()
    });
    expect(postSpy).not.toHaveBeenCalled();

    process.env.OPENCLAW_WEBHOOK_URL = 'http://127.0.0.1:18789/hooks/task-result';
    service.notifyOpenClawTaskResult({
      taskId: 'task-2',
      type: 'repo_summary',
      status: 'completed',
      runId: 'run-2',
      summary: 'done',
      completedAt: new Date()
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(postSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/hooks/task-result',
      expect.objectContaining({
        taskId: 'task-2',
        status: 'completed'
      })
    );

    postSpy.mockRestore();
    if (originalWebhookUrl === undefined) {
      delete process.env.OPENCLAW_WEBHOOK_URL;
    } else {
      process.env.OPENCLAW_WEBHOOK_URL = originalWebhookUrl;
    }
  });
});
