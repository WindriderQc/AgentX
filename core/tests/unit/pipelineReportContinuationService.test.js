'use strict';

const lean = value => ({ lean: async () => value, select: () => ({ lean: async () => value }) });
const store = { tasks: [], settings: null, runs: [] };

jest.mock('../../models/PipelineTask', () => ({
  find: jest.fn(() => lean(store.tasks)),
  findOne: jest.fn(query => lean(store.tasks.find(task => task.pipelineId === query.pipelineId) || null)),
  findOneAndUpdate: jest.fn((query, update) => {
    const task = store.tasks.find(row => String(row._id) === String(query._id));
    if (!task) return lean(null);
    if (update.$set?.reportContinuation) task.reportContinuation = update.$set.reportContinuation;
    for (const [key, value] of Object.entries(update.$set || {})) {
      const match = key.match(/^reportContinuation\.runs\.\$\.(\w+)$/);
      if (match) task.reportContinuation.runs.find(run => run.requestId === query['reportContinuation.runs.requestId'])[match[1]] = value;
    }
    return lean(task);
  })
}));
jest.mock('../../models/PipelineReportRun', () => ({
  find: jest.fn(() => lean(store.runs)),
  findById: jest.fn(id => lean(store.runs.find(run => run._id === id) || null))
}));
jest.mock('../../models/PipelineReportContinuation', () => ({
  findById: jest.fn(() => lean(store.settings)),
  findOneAndUpdate: jest.fn((query, update) => {
    if (!store.settings && update.$set?.enabled !== undefined) store.settings = { _id: 'report-continuation', enabled: false, revision: 0, active: null };
    const s = store.settings;
    if (!s || (query.revision !== undefined && s.revision !== query.revision) || (query.active === null && s.active)) return lean(null);
    Object.assign(s, update.$set || {});
    if (update.$inc?.revision) s.revision += update.$inc.revision;
    return lean(s);
  }),
  updateOne: jest.fn(async (query, update) => {
    if (store.settings?.active?.requestId === query['active.requestId']) Object.assign(store.settings, update.$set);
  })
}));
jest.mock('../../src/services/pipelineReportAuthority', () => ({
  history: jest.fn(() => ({ executions: 2, modelCalls: 200, workSeconds: 3000 })),
  limits: jest.fn(() => ({ executions: 4, modelCalls: 600, workSeconds: 20000 })),
  campaign: jest.fn(async () => ({ id: 'q' }))
}));
jest.mock('../../src/services/pipelineReportNotifications', () => ({ publish: jest.fn(async () => 'alert') }));

const service = require('../../src/services/pipelineReportContinuationService');
const authority = require('../../src/services/pipelineReportAuthority');
const notifications = require('../../src/services/pipelineReportNotifications');

const PARENT = '10d7dc99-f2dc-4bd4-b903-6258c6e1d6a7';
const SHA = 'f'.repeat(64);
function task(outcomes, extra = {}) {
  return { _id: 't1', pipelineId: '0939', status: 'blocked', updatedAt: new Date('2026-10-16T08:00:00Z'),
    codingResult: { profile: 'report', reportName: 'DOCUMENTATION_PEER_REVIEW.md', modelCallLimit: 128 },
    codingReportAuthority: { grants: [{ key: 'g1', queueRequestId: 'q1', additionalRuns: 3 }], bindings: [{ grantKey: 'g1' }] },
    feedback: outcomes.map(reportOutcome => ({ by: 'coding-team', reportOutcome })), ...extra };
}
const stopped = (requestId, reason, sha = SHA) => ({ requestId, kind: 'blocked', reason, partial: { deliverableId: 'd', sha256: sha } });

function controls() {
  const control = { target: 'host', status: jest.fn(async ({ requestId }) => (requestId
    ? { run: { phase: 'not_received', requestId } }
    : { candidates: [{ pipelineId: '0939', expectedAttemptCount: 0 }] })),
  launch: jest.fn(async () => ({ accepted: true })), reconcile: jest.fn() };
  const preparation = { apply: jest.fn(async input => {
    const row = store.tasks[0];
    row.status = 'queued';
    row.codingResult = { ...row.codingResult, ...input.result };
    return row;
  }) };
  service.configure({ control, preparation });
  return { control, preparation };
}

beforeEach(() => {
  jest.clearAllMocks();
  store.tasks = []; store.runs = []; store.settings = { _id: 'report-continuation', enabled: true, revision: 1, active: null };
});

describe('report continuation decisions', () => {
  it('continues only a call or time stop with a saved report that changed', () => {
    expect(service.decide(task([stopped(PARENT, 'model_call_limit')])).action).toBe('continue');
    expect(service.decide(task([stopped(PARENT, 'hard_budget')])).action).toBe('continue');
    expect(service.decide(task([stopped(PARENT, 'runner_error')])).action).toBe('failed');
    expect(service.decide(task([{ ...stopped(PARENT, 'model_call_limit'), partial: null }])).action).toBe('failed');
    expect(service.decide(task([stopped('a', 'model_call_limit'), stopped(PARENT, 'model_call_limit')])).action).toBe('no_progress');
    expect(service.decide(task([stopped('a', 'model_call_limit', 'e'.repeat(64)), stopped(PARENT, 'model_call_limit')])).action).toBe('continue');
    expect(service.decide(task([{ requestId: PARENT, deliverableId: 'd', sha256: SHA }])).action).toBe('completed');
  });

  it('derives one stable request id per parent', () => {
    const id = service.continuationId('0939', PARENT);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(service.continuationId('0939', PARENT)).toBe(id);
    expect(service.continuationId('0939', 'other')).not.toBe(id);
  });
});

describe('report continuation loop', () => {
  it('selects, prepares from the saved checkpoint and launches once under the derived id', async () => {
    const { control, preparation } = controls();
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick();
    const requestId = service.continuationId('0939', PARENT);
    expect(store.settings.active).toMatchObject({ pipelineId: '0939', requestId });
    expect(store.tasks[0].reportContinuation.runs).toEqual([expect.objectContaining({ requestId, parentRequestId: PARENT, parentSha256: SHA })]);
    expect(control.launch).not.toHaveBeenCalled();
    await service.tick();
    expect(preparation.apply).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: '0939',
      result: expect.objectContaining({ profile: 'report', parentRequestId: PARENT, parentSha256: SHA }) }));
    expect(preparation.apply.mock.calls[0][0].reportGrant).toBeUndefined();
    expect(control.launch).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: '0939', requestId, expectedAttemptCount: 0,
      confirm: true, reportName: 'DOCUMENTATION_PEER_REVIEW.md', modelCallLimit: 128, parentRequestId: PARENT, parentSha256: SHA }));
  });

  it('journals the selected executor before launching a continuation', async () => {
    const { control } = controls();
    control.select = jest.fn(async () => ({ id: 'brutal-local', harness: 'opencode' }));
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick();
    expect(store.settings.active).toMatchObject({ executorId: 'brutal-local', harness: 'opencode' });
    expect(store.tasks[0].reportContinuation.runs[0]).toMatchObject({
      executorId: 'brutal-local', harness: 'opencode'
    });
    await service.tick();
    expect(control.status).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'brutal-local' }));
    expect(control.launch).toHaveBeenCalledWith(expect.objectContaining({ executorId: 'brutal-local' }));
  });

  it('never selects the same parent twice and records the finished run', async () => {
    const { control } = controls();
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick(); await service.tick();
    const requestId = service.continuationId('0939', PARENT);
    control.status.mockImplementation(async () => ({ run: { phase: 'finished', pipelineId: '0939', requestId,
      progress: { phase: 'finished', coreRecorded: true, result: 'blocked', stopReason: 'model_call_limit' } } }));
    await service.tick();
    expect(store.settings.active).toBeNull();
    expect(store.tasks[0].reportContinuation.runs[0]).toMatchObject({ result: 'blocked', stopReason: 'model_call_limit' });
    store.tasks[0].status = 'blocked';
    await service.tick();
    expect(store.settings.active).toBeNull();
    expect(control.launch).toHaveBeenCalledTimes(1);
  });

  it('blocks and alerts instead of relaunching when the outcome cannot be proven', async () => {
    const { control } = controls();
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick(); await service.tick();
    control.status.mockImplementation(async ({ requestId }) => ({ run: { phase: 'unknown', pipelineId: '0939', requestId } }));
    control.reconcile.mockRejectedValue(new Error('no verdict'));
    await service.tick();
    expect(store.tasks[0].reportContinuation).toMatchObject({ state: 'blocked', reason: 'runner_outcome_unknown' });
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'outcome_unknown', expect.any(String), expect.anything());
    expect(control.launch).toHaveBeenCalledTimes(1);
  });

  it('keeps an unknown launch answer under the same id for the next observation', async () => {
    const { control } = controls();
    control.launch.mockRejectedValue(Object.assign(new Error('lost'), { code: 'CODING_DISPATCH_OUTCOME_UNKNOWN' }));
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick(); await service.tick();
    expect(store.tasks[0].reportContinuation.state).toBe('dispatching');
    expect(store.settings.active).not.toBeNull();
  });

  it('alerts the owner instead of launching when the grant or window does not allow it', async () => {
    const { control } = controls();
    authority.campaign.mockRejectedValueOnce(new Error('closed'));
    store.tasks = [task([stopped(PARENT, 'hard_budget')])];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'needs_grant', PARENT, { reason: 'campaign_window_closed' });
    expect(store.settings.active).toBeNull();
    store.tasks[0].codingReportAuthority.bindings = [{ grantKey: 'g1' }, { grantKey: 'g1' }, { grantKey: 'g1' }];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'needs_grant', PARENT, { reason: 'grant_runs_used' });
    expect(control.launch).not.toHaveBeenCalled();
  });

  it('reports blocked documents, failures, no progress and completion without launching', async () => {
    const { control } = controls();
    store.runs = [{ _id: PARENT, coverage: { documents: [{ path: 'docs/A.md', state: 'blocked' }, { path: 'docs/B.md', state: 'reviewed' }] } }];
    store.tasks = [task([stopped(PARENT, 'runner_error')])];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'documents_blocked', PARENT, { paths: ['docs/A.md'] });
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'execution_failed', PARENT, { reason: 'runner_error' });
    store.tasks = [task([stopped('a', 'model_call_limit'), stopped(PARENT, 'model_call_limit')])];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'no_progress', PARENT);
    store.tasks = [task([{ requestId: PARENT, deliverableId: 'd', sha256: SHA }], { status: 'review' })];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'completed', PARENT);
    expect(control.launch).not.toHaveBeenCalled();
  });

  it('launches nothing while switched off but still alerts, and the switch needs confirmation and the current revision', async () => {
    const { control } = controls();
    store.settings.enabled = false;
    store.tasks = [task([stopped(PARENT, 'model_call_limit')])];
    await service.tick();
    expect(store.settings.active).toBeNull();
    expect(notifications.publish).not.toHaveBeenCalledWith(expect.anything(), 'needs_grant', expect.anything(), expect.anything());
    store.tasks = [task([stopped(PARENT, 'runner_error')])];
    await service.tick();
    expect(notifications.publish).toHaveBeenCalledWith(expect.anything(), 'execution_failed', PARENT, { reason: 'runner_error' });
    await expect(service.configureSwitch({ enabled: true })).rejects.toThrow('Confirm the switch');
    await expect(service.configureSwitch({ enabled: true, confirm: true, expectedRevision: 9 })).rejects.toThrow('changed');
    await expect(service.configureSwitch({ enabled: true, confirm: true, expectedRevision: 1 })).resolves.toMatchObject({ enabled: true, revision: 2 });
    expect(control.launch).not.toHaveBeenCalled();
  });

  it('chains a task the owner resumed with automatic chaining even while the global switch is off', async () => {
    const { control } = controls();
    store.settings.enabled = false;
    store.tasks = [task([stopped(PARENT, 'model_call_limit')], { reportResume: { autoContinue: true } })];
    await expect(service.wouldContinue(store.tasks[0])).resolves.toBe(true);
    await service.tick(); await service.tick();
    expect(control.launch).toHaveBeenCalledTimes(1);
    store.tasks = [task([stopped(PARENT, 'model_call_limit')], { reportResume: { autoContinue: false } })];
    await expect(service.wouldContinue(store.tasks[0])).resolves.toBe(false);
  });
});
