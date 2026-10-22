const Controller = require('../../public/js/pipeline-launch');
const ID = '10000000-0000-4000-8000-000000000001';
const NEXT = '10000000-0000-4000-8000-000000000002';
const selection = { requestId: ID, pipelineId: '0700', expectedAttemptCount: 0 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const snapshot = (run = null, busy = false, count = 0) => ({ data: {
  contractVersion: 2, available: true, busy, candidates: [{ pipelineId: '0700', expectedAttemptCount: count }], run
} });
const run = (phase, status = 'queued', extra = {}) => ({ ...selection, phase, task: { pipelineId: '0700', status, automationAttemptCount: 0 }, ...extra });

describe('Pipeline launch reconciliation', () => {
  let controllers, data, request, storage, refreshTasks;
  const make = () => {
    const controller = new Controller({ request, storage, refreshTasks, newId: jest.fn().mockReturnValueOnce(ID).mockReturnValue(NEXT) });
    controllers.push(controller);
    return controller;
  };
  beforeEach(() => {
    jest.useFakeTimers();
    controllers = [];
    data = new Map();
    storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    request = jest.fn().mockResolvedValue(snapshot());
    refreshTasks = jest.fn();
  });
  afterEach(() => { controllers.forEach(c => c.dispose()); jest.clearAllTimers(); jest.useRealTimers(); });
  const posts = () => request.mock.calls.filter(([, options]) => options.method === 'POST');

  test('an unknown execution is recovered after reload and cannot be retried', async () => {
    request.mockResolvedValue(snapshot(run('unknown', 'in_progress', { canRetry: false }), true));
    const controller = make();
    await controller.refresh();
    expect(controller.pending).toEqual(selection);
    expect(controller.canLaunch('0700')).toBe(false);
    expect(controller.canRetry()).toBe(false);
    controller.dispose();
    const reloaded = make();
    await reloaded.refresh();
    await jest.advanceTimersByTimeAsync(8000);
    expect(reloaded.pending).toEqual(selection);
    expect(posts()).toHaveLength(0);
  });

  test('a guarded browser request is retained without resuming it through the replacement worker', async () => {
    const original = JSON.stringify(selection);
    storage.setItem('agentx.pipeline.launchRequest.v1', original);
    const controller = make();
    await controller.refresh();
    expect(controller.pending).toBeNull();
    expect(controller.canRetry()).toBe(false);
    expect(posts()).toHaveLength(0);
    expect(storage.getItem('agentx.pipeline.launchRequest.v1')).toBe(original);
  });

  test('a reloaded capacity wait keeps its identity and cancels once without launching another task', async () => {
    request.mockResolvedValue(snapshot(run('waiting', 'queued', { canCancel: true }), true));
    const controller = make();
    await controller.refresh();
    expect(controller.pending).toEqual(selection);
    expect(controller.canLaunch('0700')).toBe(false);
    expect(controller.canRetry()).toBe(false);
    expect(posts()).toHaveLength(0);
    const cancelled = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? cancelled.promise
      : Promise.resolve(snapshot(run('stopped'), false)));
    const first = controller.cancel();
    expect(await controller.cancel()).toBe(false);
    cancelled.resolve({ data: { cancelled: true } });
    await first;
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(`/api/runtime-bridges/coding-dispatch/runs/${ID}/cancel`);
    expect(controller.pending).toBeNull();
  });

  test('double click sends one request and queued observations never unlock an accepted run', async () => {
    const controller = make();
    await controller.refresh();
    const post = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? post.promise : Promise.resolve(snapshot(run('accepted'), true)));
    const first = controller.launch('0700');
    expect(controller.lastSubmission).toEqual(selection);
    expect(Object.isFrozen(controller.lastSubmission)).toBe(true);
    expect(await controller.launch('0700')).toBe(false);
    expect(posts()).toHaveLength(1);
    post.resolve({ data: { run: run('accepted') } });
    await first;
    await jest.advanceTimersByTimeAsync(8000);
    expect(controller.canLaunch('0700')).toBe(false);
    expect(controller.pending).toEqual(selection);
    expect(posts()).toHaveLength(1);
    request.mockResolvedValue(snapshot(run('running', 'in_progress'), true));
    await jest.advanceTimersByTimeAsync(2000);
    expect(controller.control.run.task.status).toBe('in_progress');
    expect(refreshTasks).toHaveBeenCalled();
  });

  test('stop targets the current request once and remains pending until a terminal observation', async () => {
    request.mockResolvedValue(snapshot(run('running', 'in_progress', { canStop: true }), true));
    const controller = make();
    await controller.refresh();
    expect(controller.canStop()).toBe(true);
    const stopping = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? stopping.promise
      : Promise.resolve(snapshot(run('stopping', 'in_progress', { canStop: false }), true)));
    const first = controller.stop();
    expect(await controller.stop()).toBe(false);
    stopping.reject(new Error('Response lost'));
    await first;
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe(`/api/runtime-bridges/coding-dispatch/runs/${ID}/stop`);
    expect(JSON.parse(posts()[0][1].body)).toEqual({ pipelineId: '0700', confirm: true });
    expect(controller.pending).toEqual(selection);
    await jest.advanceTimersByTimeAsync(6000);
    expect(posts()).toHaveLength(1);
    expect(controller.canLaunch('0700')).toBe(false);
    request.mockResolvedValue(snapshot(run('finished', 'blocked')));
    await controller.refresh();
    expect(controller.pending).toBeNull();
  });

  test('a stale browser selection cannot stop another task or request', async () => {
    storage.setItem('agentx.pipeline.simpleWorkerRequest.v1', JSON.stringify(selection));
    request.mockResolvedValue(snapshot({ ...run('running', 'in_progress', { canStop: true }), requestId: NEXT, pipelineId: '0701' }, true));
    const controller = make();
    await controller.refresh();
    expect(await controller.stop()).toBe(false);
    expect(posts()).toHaveLength(0);
  });

  test('reload during a lost response restores the same receipt using GET only', async () => {
    const controller = make();
    await controller.refresh();
    request.mockImplementation((url, options) => options.method === 'POST'
      ? Promise.reject(new Error('Connection lost')) : Promise.resolve(snapshot(run('accepted'), true)));
    await controller.launch('0700');
    controller.dispose();
    const reloaded = make();
    await reloaded.refresh();
    expect(reloaded.pending).toEqual(selection);
    expect(request.mock.calls.at(-1)[0]).toContain(`requestId=${ID}`);
    expect(posts()).toHaveLength(1);
    expect(reloaded.canLaunch('0700')).toBe(false);
  });

  test('reload preserves the executor binding in status and follow-up requests', async () => {
    const bound = { ...selection, executorId: 'brutal-local' };
    storage.setItem('agentx.pipeline.simpleWorkerRequest.v1', JSON.stringify(bound));
    request.mockResolvedValue(snapshot(run('waiting', 'queued', {
      executorId: 'brutal-local', canCancel: true
    }), true));
    const controller = make();
    await controller.refresh();
    expect(controller.pending).toEqual(bound);
    expect(request.mock.calls[0][0]).toContain(`requestId=${ID}&executorId=brutal-local`);
    await controller.cancel();
    expect(JSON.parse(posts()[0][1].body)).toEqual({ pipelineId: '0700', executorId: 'brutal-local' });
  });

  test('failed or outdated status cannot re-enable an old candidate', async () => {
    const controller = make();
    await controller.refresh();
    const stale = deferred();
    request.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(snapshot(run('running'), true));
    const oldRead = controller.refresh();
    await controller.refresh();
    stale.resolve(snapshot());
    await oldRead;
    expect(controller.canLaunch('0700')).toBe(false);
    request.mockRejectedValueOnce(new Error('Host offline'));
    await controller.refresh();
    expect(controller.error).toContain('offline');
    expect(controller.canLaunch('0700')).toBe(false);
  });

  test('a terminal GET wins over a late accepted POST and permits a fresh requeued attempt', async () => {
    const controller = make();
    await controller.refresh();
    const post = deferred();
    request.mockImplementation((url, options) => options.method === 'POST' ? post.promise : Promise.resolve(snapshot(run('finished', 'blocked'))));
    const launch = controller.launch('0700');
    await jest.advanceTimersByTimeAsync(1000);
    expect(controller.pending).toBeNull();
    post.resolve({ data: { run: run('accepted') } });
    await launch;
    expect(controller.lastSubmission).toEqual(selection);
    expect(controller.pending).toBeNull();
    expect(controller.control.run.phase).toBe('finished');
    request.mockResolvedValue(snapshot(run('finished', 'queued'), false, 1));
    await controller.refresh();
    request.mockImplementation((url, options) => Promise.resolve(options.method === 'POST'
      ? { data: { run: { ...run('accepted'), requestId: NEXT } } }
      : snapshot({ ...run('accepted'), requestId: NEXT }, true, 1)));
    await controller.launch('0700');
    expect(JSON.parse(posts()[1][1].body)).toEqual({ requestId: NEXT, pipelineId: '0700', expectedAttemptCount: 1, confirm: true });
  });

  test('a missing receipt is retried only explicitly with its original request identity', async () => {
    storage.setItem('agentx.pipeline.simpleWorkerRequest.v1', JSON.stringify(selection));
    request.mockResolvedValue(snapshot(run('not_received')));
    const controller = make();
    await controller.refresh();
    await jest.advanceTimersByTimeAsync(10000);
    expect(posts()).toHaveLength(0);
    expect(controller.canRetry()).toBe(true);
    request.mockResolvedValue(snapshot(run('accepted'), true));
    await controller.retry();
    expect(JSON.parse(posts()[0][1].body)).toEqual({ ...selection, confirm: true });
    expect(controller.canRetry()).toBe(false);
  });

  test('known rejection clears pending state only after authoritative observation', async () => {
    const controller = make();
    await controller.refresh();
    request.mockImplementation((url, options) => options.method === 'POST'
      ? Promise.reject(new Error('Task changed')) : Promise.resolve(snapshot(run('rejected'))));
    await controller.launch('0700');
    expect(controller.pending).toBeNull();
    expect(data.size).toBe(0);
    expect(controller.control.run.phase).toBe('rejected');
  });

  test('unavailable local storage retains in-page exclusion and host status recovers after reload', async () => {
    storage.setItem = () => { throw new Error('Unavailable'); };
    const controller = make();
    await controller.refresh();
    request.mockResolvedValue(snapshot(run('running'), true));
    await controller.launch('0700');
    expect(controller.canLaunch('0700')).toBe(false);
    const reloaded = make();
    await reloaded.refresh();
    expect(reloaded.control.run.requestId).toBe(ID);
    expect(reloaded.pending).toEqual(selection);
    expect(reloaded.canLaunch('0700')).toBe(false);
  });

  test('disposal cancels read reconciliation without another POST', async () => {
    storage.setItem('agentx.pipeline.simpleWorkerRequest.v1', JSON.stringify(selection));
    const controller = make();
    await controller.refresh();
    const count = request.mock.calls.length;
    controller.dispose();
    await jest.advanceTimersByTimeAsync(30000);
    expect(request).toHaveBeenCalledTimes(count);
    expect(controller.canRetry()).toBe(false);
  });
});

describe('private report launch selection', () => {
  const profile = { reportName: 'REVIEW.md', modelCallLimit: 256 };
  test('selects an executor compatible with the requested profile', async () => {
    const request = jest.fn(async (_url, options = {}) => options.method === 'POST'
      ? { data: { run: run('accepted', 'queued', { executorId: 'report-host' }) } }
      : snapshot(run('accepted', 'queued', { executorId: 'report-host' }), true));
    const controller = new Controller({ request, newId: () => ID });
    controller.control = { available: true, busy: false, candidates: [
      { pipelineId: '0700', expectedAttemptCount: 0, executorId: 'code-host', executorProfiles: ['code'] },
      { pipelineId: '0700', expectedAttemptCount: 0, executorId: 'report-host', executorLabel: 'Report worker',
        harness: 'opencode', executorProfiles: ['report'] },
    ] };
    try {
      await controller.launch('0700', profile);
      const body = JSON.parse(request.mock.calls.find(([, options]) => options.method === 'POST')[1].body);
      expect(body).toMatchObject({ executorId: 'report-host', executorLabel: 'Report worker', harness: 'opencode', ...profile });
    } finally { controller.dispose(); }
  });
  test('lost-response recovery and an explicit retry preserve report mode, budget and request identity', async () => {
    const data = new Map();
    const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
    const request = jest.fn().mockResolvedValue(snapshot());
    const first = new Controller({ request, storage, newId: () => ID });
    await first.refresh();
    request.mockImplementation(async (_url, options) => {
      if (options.method === 'POST') throw new Error('Response lost');
      return snapshot(run('unknown', 'in_progress', profile), true);
    });
    await first.launch('0700', profile); first.dispose();
    const reloaded = new Controller({ request, storage });
    try {
      expect(reloaded.pending).toEqual({ ...selection, ...profile });
      request.mockResolvedValue(snapshot(run('not_received', 'queued', profile)));
      await reloaded.refresh();
      expect(reloaded.canRetry()).toBe(true);
      await reloaded.retry();
      const posts = request.mock.calls.filter(([, opts]) => opts.method === 'POST');
      expect(posts).toHaveLength(2);
      for (const [, opts] of posts) expect(JSON.parse(opts.body)).toEqual({ ...selection, ...profile, confirm: true });
    } finally { reloaded.dispose(); }
  });
  test('recovery from a native running receipt without browser storage preserves the report profile', async () => {
    const controller = new Controller({ request: async () => snapshot(run('running', 'in_progress', profile), true) });
    try { await controller.refresh(); expect(controller.pending).toEqual({ ...selection, ...profile }); }
    finally { controller.dispose(); }
  });
});

describe('native report reconciliation', () => {
  const profile = { reportName: 'REVIEW.md', modelCallLimit: 256 };
  test('a canonical native receipt restores the report profile even when browser storage is stale', async () => {
    const storage = { getItem: () => JSON.stringify(selection), setItem() {}, removeItem() {} };
    const controller = new Controller({ storage, request: async () => snapshot(run('unknown', 'in_progress', { ...profile, canReconcile: true }), false) });
    try {
      await controller.refresh(); expect(controller.pending).toEqual({ ...selection, ...profile });
      expect(controller.canReconcile()).toBe(true); expect(controller.canLaunch('0700')).toBe(false);
    } finally { controller.dispose(); }
  });
  test('a reconciliation refusal remains visible after a successful status read and starts no replacement', async () => {
    const request = jest.fn(async (_url, options) => {
      if (options.method === 'POST') throw new Error('Original native inference remains unverified');
      return snapshot(run('unknown', 'in_progress', { ...profile, canReconcile: true }), false);
    });
    const controller = new Controller({ request });
    try {
      await controller.refresh(); expect(await controller.reconcile()).toBe(false);
      expect(controller.reconcileError).toContain('inference remains unverified');
      expect(controller.pending.requestId).toBe(ID); expect(controller.canLaunch('0700')).toBe(false);
      const posts = request.mock.calls.filter(([, options]) => options.method === 'POST');
      expect(posts).toHaveLength(1); expect(posts[0][0]).toContain(`/runs/${ID}/reconcile`);
      expect(JSON.parse(posts[0][1].body)).toEqual({ pipelineId: '0700', confirm: true });
    } finally { controller.dispose(); }
  });
});

test('a continuation selection survives an unknown response and browser recovery without another launch', async () => {
  const parent = { parentRequestId: '20000000-0000-4000-8000-000000000002', parentSha256: 'a'.repeat(64) };
  const profile = { reportName: 'REVIEW.md', modelCallLimit: 256, ...parent }, data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const request = jest.fn(async (_url, options) => options.method === 'POST' ? Promise.reject(new Error('Response lost')) : snapshot(run('unknown', 'queued', profile)));
  const first = new Controller({ request, storage, newId: () => ID });
  try {
    first.control = snapshot().data; await first.launch('0700', profile);
    const second = new Controller({ request, storage });
    try {
      await second.refresh(); expect(second.pending).toEqual({ ...selection, ...profile });
      expect(request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
    } finally { second.dispose(); }
  } finally { first.dispose(); }
});

test('reloading a prepared archive continuation retains its durable parent until a newer run produces an outcome', () => {
  const archive = '30000000-0000-4000-8000-000000000003', older = '20000000-0000-4000-8000-000000000002';
  const task = { codingResult: { profile: 'report', reportName: 'REVIEW.md', parentRequestId: archive, parentSha256: 'a'.repeat(64) },
    codingReportAuthority: { grants: [{ key: 'grant' }], bindings: [] },
    feedback: [{ reportOutcome: { requestId: older, reportName: 'REVIEW.md', partial: { sha256: 'b'.repeat(64) } } }] };
  expect(Controller.profileFields(task)).toContain(`value="${archive}:${'a'.repeat(64)}"`);
  task.codingReportAuthority.bindings.push({ requestId: older, grantKey: 'grant' });
  expect(Controller.profileFields(task)).toContain(`value="${older}:${'b'.repeat(64)}"`);
});

test('global native candidates use their reconciled checkpoint after review rejection without requiring the private authority ledger', () => {
  const oldParent = '20000000-0000-4000-8000-000000000002', candidate = '30000000-0000-4000-8000-000000000003';
  const nativeCandidate = { canReport: true, codingResult: { profile: 'report', reportName: 'REVIEW.md',
    parentRequestId: oldParent, parentSha256: 'a'.repeat(64) },
    reportCheckpoint: { parentRequestId: candidate, parentSha256: 'b'.repeat(64) } };
  expect(Controller.profileFields(nativeCandidate)).toContain(`value="${candidate}:${'b'.repeat(64)}"`);
});
