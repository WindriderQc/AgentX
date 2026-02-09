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
});
