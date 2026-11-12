'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const ImageOperation = require('../../models/ImageOperation');
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
jest.mock('../../src/services/hostPinPrimitives', () => ({ ...jest.requireActual('../../src/services/hostPinPrimitives'), fetchRunningModelInfosStrict: jest.fn() }));
const { fetchRunningModelInfosStrict } = require('../../src/services/hostPinPrimitives');
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const service = require('../../src/services/images/imageService');
const profile = { family: 'klein', diffusion: 'diffusion.safetensors', encoder: 'encoder.safetensors', vae: 'vae.safetensors', steps: 4, maxPixels: 4194304, label: 'Test image' };
const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const waitFor = async (id, state) => {
  for (let i = 0; i < 100; i++) { const op = await service.get(id); if (op.state === state) return op; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`Operation did not reach ${state}: ${JSON.stringify(await service.get(id))}`);
};
describe('durable local image operations', () => {
  let dir, client, reservation;
  beforeEach(async () => {
    jest.clearAllMocks();
    await ImageOperation.deleteMany({});
    // Preserve the singleton identity and CAS revision while prior asynchronous
    // receipt writes finish, rather than racing delete/create with ensure().
    await require('../../models/HeavyWorkQueue').updateOne({ _id: 'heavy-work' },
      { $set: { jobs: [] }, $inc: { revision: 1 } }, { upsert: true });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-image-test-'));
    process.env.IMAGE_ARCHIVE_DIR = dir;
    loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', ollamaHosts: ['http://127.0.0.1:11434'], profiles: { quality: profile }, defaultProfile: 'quality' });
    client = { ready: jest.fn().mockResolvedValue({}), json: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
      upload: jest.fn().mockImplementation(async (_bytes, name) => name), submit: jest.fn().mockResolvedValue({}),
      observe: jest.fn().mockImplementation(async (_id, options) => { await options.onTerminal(); return { filename: 'result.png', subfolder: 'agentx', type: 'output' }; }),
      read: jest.fn().mockResolvedValue(bytes), free: jest.fn().mockResolvedValue({}) };
    reservation = { assertOwned: jest.fn().mockResolvedValue(), verified: jest.fn().mockResolvedValue(), restore: jest.fn().mockResolvedValue(), quarantine: jest.fn().mockResolvedValue() };
    fetchRunningModelInfosStrict.mockResolvedValue([]);
    reserve.mockResolvedValue(reservation); createComfyClient.mockReturnValue(client);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });
  test('archives and restores before reporting completion, then replays the same action', async () => {
    const body = { actionKey: 'action-first', prompt: 'A lake', references: [bytes.toString('base64')] };
    const first = await service.accept(body);
    const done = await waitFor(first.id, 'completed');
    expect(done.runtimeRestored).toBe(true);
    expect((await service.image(first.id)).bytes).toEqual(bytes);
    expect(client.upload).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining(first.id));
    expect(reservation.restore).toHaveBeenCalledTimes(1);
    expect((await service.accept(body)).id).toBe(first.id);
    expect(client.submit).toHaveBeenCalledTimes(1);
    await expect(service.accept({ ...body, prompt: 'A mountain' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('opportunistic acceptance keeps its worker and policy in the original identity and receipt', async () => {
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    const body = { actionKey: 'opportunistic-first', prompt: 'A synthetic lake' };
    const first = await service.acceptOpportunistic(body, { workerId: 'default' });
    const done = await waitFor(first.id, 'completed');
    expect(done).toMatchObject({ admissionPolicy: 'opportunistic', worker: 'default', runtimeRestored: true });
    expect(reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ admissionPolicy: 'opportunistic' }), expect.any(Function), expect.any(Function));
    expect(await service.acceptOpportunistic(body, { workerId: 'default' })).toMatchObject({ id: first.id });
    await expect(service.acceptOpportunistic(body, { workerId: 'other' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.accept(body)).rejects.toMatchObject({ statusCode: 409 });
    expect(client.submit).toHaveBeenCalledTimes(1);
    await require('../../src/services/heavyWorkQueueEvidence').reconcile(first.queueRequestId, 'fixture');
    expect(await require('../../src/services/heavyWorkQueueService').get(first.queueRequestId)).toMatchObject({ state: 'completed' });
  });
  test('Family illustrations use the native engine and release receipt while keeping temporary bytes outside the archive', async () => {
    const { randomUUID } = require('node:crypto');
    const sessions = require('../../src/services/surfaceConversationService').forSurface('household');
    const bound = { surface: 'household', sessionId: 'family:engine.' + randomUUID(), packId: 'kidx_nestor', scopeId: 'family' };
    const epoch = randomUUID(), expiresAt = new Date(Date.now() + 600000).toISOString();
    await sessions.createSession({ ...bound, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    client.discardOutput = jest.fn(async (jobId, sha256) => ({ contract: 'agentx.image-output-removal/v1', jobId, sha256, removed: true }));
    const actionKey = 'illustrated-engine:' + randomUUID();
    const op = await service.acceptOpportunistic({ actionKey, prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true });
    const done = await waitFor(op.id, 'completed');
    expect(done).toMatchObject({ runtimeRestored: true, retention: { temporary: true, kept: false } });
    expect((await service.image(op.id)).bytes).toEqual(bytes);
    expect(fs.readdirSync(dir)).toEqual([]);
    for (let i = 0; i < 100 && !(await ImageOperation.findById(op.id).lean()).illustration.workerRemoval?.removed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect((await ImageOperation.findById(op.id).lean()).illustration.workerRemoval.removed).toBe(true);
    expect(client.discardOutput).toHaveBeenCalledWith(op.id, done.artifact.sha256);
    expect(reservation.restore).toHaveBeenCalledTimes(1);
    expect(await service.listFinished()).toEqual([]);
    await require('../../src/services/images/illustrationStorage').end(bound, { epoch, requestId: randomUUID() });
    expect(await service.acceptOpportunistic({ actionKey, prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true })).toMatchObject({ id: op.id });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test.each(['before-accept', 'before-dispatch', 'qualified'])('ephemeral scenes require native removal proof %s while probes remain read-only', async stage => {
    const { randomUUID } = require('node:crypto');
    const sessions = require('../../src/services/surfaceConversationService').forSurface('household');
    const bound = { surface: 'household', sessionId: 'family:qualification.' + randomUUID(), packId: 'kidx_nestor', scopeId: 'family' };
    await sessions.createSession({ ...bound, modeId: 'family' });
    const requests = []; let statsReads = 0;
    const nodes = { UNETLoader: { input: { required: { unet_name: [[profile.diffusion]] } } },
      CLIPLoader: { input: { required: { clip_name: [[profile.encoder]] } } },
      VAELoader: { input: { required: { vae_name: [[profile.vae]] } } } };
    const actual = jest.requireActual('../../src/services/images/comfyClient').createComfyClient('http://127.0.0.1:8188', async (url, options) => {
      const path = new URL(url).pathname; requests.push([path, options.method]);
      let value = path === '/queue' ? { queue_running: [], queue_pending: [] } : nodes;
      if (path === '/system_stats') {
        statsReads++;
        const qualified = stage === 'qualified' || stage === 'before-dispatch' && statsReads === 1;
        value = { devices: [{ vram_total: 12e9, vram_free: 11e9 }],
          ...(qualified && { outputRemoval: { contract: 'agentx.image-output-removal/v1' } }) };
      }
      return { ok: true, text: async () => JSON.stringify(value) };
    });
    client.ready = jest.fn(actual.ready);
    client.discardOutput = jest.fn(async (jobId, sha256) => ({ contract: 'agentx.image-output-removal/v1', jobId, sha256, removed: true }));
    const accepting = service.acceptOpportunistic({ actionKey: 'illustrated-qualification:' + randomUUID(), prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true });
    if (stage === 'before-accept') {
      await expect(accepting).rejects.toMatchObject({ statusCode: 503 });
      expect(await ImageOperation.countDocuments()).toBe(0);
      expect((await require('../../models/HeavyWorkQueue').findById('heavy-work').lean()).jobs).toEqual([]);
      expect(reserve).not.toHaveBeenCalled();
    } else {
      const op = await accepting;
      expect(await waitFor(op.id, stage === 'qualified' ? 'completed' : 'failed')).toMatchObject({ runtimeRestored: true });
      expect(client.ready).toHaveBeenCalledTimes(2);
    }
    expect(client.ready.mock.calls.every(call => call[1]?.requireOutputRemoval === true)).toBe(true);
    expect(client.submit).toHaveBeenCalledTimes(stage === 'qualified' ? 1 : 0);
    expect(requests.every(([, method]) => method === 'GET')).toBe(true);
  });
  test('a renderer returning after canonical conversation deletion cannot restore bytes, graph or scene', async () => {
    const { randomUUID } = require('node:crypto');
    const sessions = require('../../src/services/surfaceConversationService').forSurface('household');
    const bound = { surface: 'household', sessionId: 'family:late.' + randomUUID(), packId: 'kidx_nestor', scopeId: 'family' };
    const epoch = randomUUID();
    await sessions.createSession({ ...bound, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    client.discardOutput = jest.fn(async (jobId, sha256) => ({ contract: 'agentx.image-output-removal/v1', jobId, sha256, removed: true }));
    let finish, started; const gate = new Promise(resolve => { finish = resolve; });
    const observing = new Promise(resolve => { started = resolve; });
    client.observe.mockImplementationOnce(async (_id, options) => { started(); await gate; await options.onTerminal();
      return { filename: 'result.png', subfolder: 'agentx', type: 'output' }; });
    const op = await service.acceptOpportunistic({ actionKey: 'illustrated-late:' + randomUUID(), prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true });
    // Test a renderer that has actually crossed dispatch, not the earlier UI
    // state that can still be correctly cancelled before dispatch under load.
    await observing;
    const { surface, ...sessionQuery } = bound; await sessions.deleteSession(sessionQuery); finish();
    const done = await waitFor(op.id, 'completed');
    expect(done).not.toHaveProperty('artifact');
    const row = await ImageOperation.findById(op.id).select('+temporaryImage +request +execution').lean();
    expect(row).not.toHaveProperty('temporaryImage'); expect(row.request).not.toHaveProperty('prompt');
    expect(row.execution).not.toHaveProperty('graph');
    expect(row.requestHash).toHaveLength(64); expect(row.queueRequestId).toBeTruthy();
    await expect(service.image(op.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(reservation.restore).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test.each(['delete', 'end'])('slow readiness followed by %s cannot recreate the original illustration prompt or queue work', async action => {
    const { randomUUID } = require('node:crypto');
    const sessions = require('../../src/services/surfaceConversationService').forSurface('household');
    const bound = { surface: 'household', sessionId: 'family:preflight.' + randomUUID(), packId: 'kidx_nestor', scopeId: 'family' };
    const { surface, ...sessionQuery } = bound, epoch = randomUUID();
    await sessions.createSession({ ...sessionQuery, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    let entered, release;
    const ready = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    client.ready.mockImplementationOnce(async () => { entered(); await gate; return { devices: [{ vram_total: 12e9, vram_free: 11e9 }] }; });
    const accepting = service.acceptOpportunistic({ actionKey: 'illustrated-probe:' + randomUUID(), prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true });
    await ready;
    if (action === 'delete') await sessions.deleteSession(sessionQuery);
    else {
      await sessions.updateSession(sessionQuery, { $set: { 'illustrationRetention.endedAt': new Date().toISOString() } });
      await require('../../src/services/images/illustrationStorage').expireConversation(bound);
    }
    release(); await expect(accepting).rejects.toMatchObject({ statusCode: 409, notSubmitted: true });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect((await require('../../models/HeavyWorkQueue').findById('heavy-work').lean()).jobs).toEqual([]);
    expect(client.submit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  });
  test('a slow admitted image transport does not block canonical erasure and its late reply cannot restore content', async () => {
    const { randomUUID } = require('node:crypto');
    const sessions = require('../../src/services/surfaceConversationService').forSurface('household');
    const bound = { surface: 'household', sessionId: 'family:transport.' + randomUUID(), packId: 'kidx_nestor', scopeId: 'family' };
    const { surface, ...sessionQuery } = bound, epoch = randomUUID();
    await sessions.createSession({ ...sessionQuery, modeId: 'family', illustrationRetention: { epoch, expiresAt: new Date(Date.now() + 600000).toISOString() } });
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    client.discardOutput = jest.fn(async (jobId, sha256) => ({ contract: 'agentx.image-output-removal/v1', jobId, sha256, removed: true }));
    let entered, release; const sent = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    client.submit.mockImplementationOnce(async () => { entered(); await gate; return {}; });
    const op = await service.acceptOpportunistic({ actionKey: 'illustrated-slow-transport:' + randomUUID(), prompt: 'A fictional moon' },
      { workerId: 'default', conversation: bound, temporary: true });
    await sent;
    let timeout;
    try {
      await Promise.race([sessions.deleteSession(sessionQuery), new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Erasure blocked by image transport')), 3000);
      })]);
    } finally { clearTimeout(timeout); release(); }
    const done = await waitFor(op.id, 'completed');
    expect(done).not.toHaveProperty('artifact');
    const row = await ImageOperation.findById(op.id).select('+temporaryImage +execution +request').lean();
    expect(row).not.toHaveProperty('temporaryImage'); expect(row.execution).not.toHaveProperty('graph');
    expect(row.request).not.toHaveProperty('prompt');
    expect(row.illustration.submission.requestId).toBe(op.id);
    expect(client.submit).toHaveBeenCalledTimes(1); expect(reservation.restore).toHaveBeenCalledTimes(1);
  });
  test('opportunistic images refuse an occupied worker without dormant work or fallback', async () => {
    client.ready.mockRejectedValue(new Error('busy'));
    await expect(service.acceptOpportunistic({ actionKey: 'opportunistic-busy', prompt: 'A lake' }, { workerId: 'default' }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect((await require('../../models/HeavyWorkQueue').findById('heavy-work').lean()).jobs).toEqual([]);
    expect(reserve).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });
  test('opportunistic images refuse a missing canonical queue instead of assuming there is no legacy work', async () => {
    await require('../../models/HeavyWorkQueue').deleteMany({});
    await expect(service.acceptOpportunistic({ actionKey: 'opportunistic-no-queue', prompt: 'A lake' }, { workerId: 'default' }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect(client.ready).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });
  test.each([{}, { queue_running: null, queue_pending: null }, { queue_running: [], queue_pending: null }])(
    'native queue becoming malformed after preflight cannot submit or free the worker: %j', async malformed => {
      let reads = 0;
      const requests = [];
      const responses = { '/system_stats': { devices: [{ vram_total: 12e9, vram_free: 11e9 }] },
        '/object_info': { UNETLoader: { input: { required: { unet_name: [[profile.diffusion]] } } },
          CLIPLoader: { input: { required: { clip_name: [[profile.encoder]] } } },
          VAELoader: { input: { required: { vae_name: [[profile.vae]] } } } } };
      const actual = jest.requireActual('../../src/services/images/comfyClient').createComfyClient('http://127.0.0.1:8188', async url => {
        const route = new URL(url).pathname; requests.push(route);
        const value = route === '/queue' ? ++reads === 1 ? { queue_running: [], queue_pending: [] } : malformed : responses[route];
        return { ok: true, text: async () => JSON.stringify(value) };
      });
      client.ready = jest.fn(actual.ready); client.free = jest.fn(actual.free);
      const op = await service.acceptOpportunistic({ actionKey: 'opportunistic-malformed-queue', prompt: 'A lake' }, { workerId: 'default' });
      expect(await waitFor(op.id, 'unknown')).toMatchObject({ runtimeRestored: false });
      expect(client.ready).toHaveBeenCalledTimes(2);
      expect(client.ready.mock.calls.every(call => call[1]?.requireQueueProof === true)).toBe(true);
      expect(client.submit).not.toHaveBeenCalled();
      expect(requests).not.toContain('/free');
      expect(reservation.restore).not.toHaveBeenCalled();
      expect(reservation.quarantine).toHaveBeenCalledTimes(1);
    }
  );
  test('a reservation that wins after opportunistic preflight cancels the exact image instead of queueing it', async () => {
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    const queue = require('../../src/services/heavyWorkQueueService');
    const realSubmit = queue.submit;
    let blocker;
    const submit = jest.spyOn(queue, 'submit').mockImplementationOnce(async (...args) => {
      const job = await realSubmit({ key: 'opportunistic-race-blocker', title: 'Synthetic late reservation', kind: 'diagnostic',
        hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5, source: { type: 'coding' } }, 'fixture');
      blocker = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
      return realSubmit(...args);
    });
    try {
      const body = { actionKey: 'opportunistic-race', prompt: 'A synthetic lake' };
      const op = await service.acceptOpportunistic(body, { workerId: 'default' });
      expect(op).toMatchObject({ state: 'cancelled', cancelRequested: true, admissionPolicy: 'opportunistic' });
      expect(await queue.get(op.queueRequestId)).toMatchObject({ state: 'cancelled' });
      expect(await service.acceptOpportunistic(body, { workerId: 'default' })).toMatchObject({ id: op.id, state: 'cancelled' });
      await queue.cancel(blocker.id, { expectedRevision: blocker.revision }, 'fixture');
      await service.dispatchQueued();
      expect((await service.get(op.id)).state).toBe('cancelled');
      expect(client.submit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    } finally { submit.mockRestore(); }
  });
  test('opportunistic unknown submission is reconciled by its original action, never replaced', async () => {
    client.ready.mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] });
    client.submit.mockRejectedValue(new Error('lost response'));
    const body = { actionKey: 'opportunistic-unknown', prompt: 'A lake' };
    const first = await service.acceptOpportunistic(body, { workerId: 'default' });
    await waitFor(first.id, 'unknown');
    await service.dispatchQueued();
    expect(await service.acceptOpportunistic(body, { workerId: 'default' })).toMatchObject({ id: first.id, state: 'unknown' });
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(reservation.restore).not.toHaveBeenCalled();
    expect(reservation.quarantine).toHaveBeenCalledTimes(1);
  });
  test('a lost submission response is UNKNOWN and cannot be automatically repeated', async () => {
    client.submit.mockRejectedValue(new Error('connection lost after dispatch'));
    const first = await service.accept({ actionKey: 'action-unknown', prompt: 'A lake' });
    await waitFor(first.id, 'unknown');
    expect(reservation.restore).not.toHaveBeenCalled();
    expect(reservation.quarantine).toHaveBeenCalledTimes(1);
    expect((await service.accept({ actionKey: 'action-unknown', prompt: 'A lake' })).state).toBe('unknown');
    expect((await service.accept({ actionKey: 'action-another', prompt: 'A mountain' })).state).toBe('queued');
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('unavailable worker refuses immediately without persisting dormant work', async () => {
    client.ready.mockRejectedValue(new Error('offline'));
    await expect(service.accept({ actionKey: 'action-offline', prompt: 'A lake' })).rejects.toMatchObject({ statusCode: 503 });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
  });
  test('a worker lost after manual dispatch persists a refusal before the HTTP failure and frees the next request', async () => {
    const queue = require('../../src/services/heavyWorkQueueService');
    const Runtime = require('../../models/RuntimeCoordination');
    await Runtime.deleteMany({});
    await Runtime.collection.insertOne({ _id: 'runtime', workloads: [], inferences: [] });
    const executor = { actionKey: 'action-manual-offline', prompt: 'A lake' };
    const job = await queue.submit({ key: executor.actionKey, title: 'Synthetic offline worker', kind: 'image',
      hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5, executor }, 'fixture');
    const ready = await queue.reserve(job.id, { expectedRevision: job.revision, start: new Date().toISOString() }, 'fixture');
    const begun = await queue.begin(job.id, { expectedRevision: ready.revision }, 'fixture');
    client.ready.mockRejectedValue(new Error('offline'));
    await expect(service.accept({ ...executor, queueRequestId: job.id, queueDispatchId: begun.dispatchId })).rejects.toMatchObject({ statusCode: 503 });
    expect(await queue.get(job.id)).toMatchObject({ state: 'failed', launchRefusal: { code: 'IMAGE_WORKER_UNAVAILABLE' } });
    expect(await ImageOperation.countDocuments()).toBe(0);
    const next = await queue.submit({ key: 'after-worker-refusal', title: 'Next synthetic image', kind: 'image', hosts: job.hosts,
      estimatedMinutes: 5, executor: { ...executor, actionKey: 'action-after-refusal' } }, 'fixture');
    await expect(queue.reserve(next.id, { expectedRevision: next.revision, start: new Date().toISOString() }, 'fixture')).resolves.toMatchObject({ state: 'reserved' });
    expect(reserve).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });
  test('a second image waits behind the busy first worker and keeps its identity until dispatch', async () => {
    let finishFirst;
    const firstOutput = new Promise(resolve => { finishFirst = resolve; });
    client.observe.mockImplementationOnce(async (_id, options) => {
      await firstOutput; await options.onTerminal();
      return { filename: 'result.png', subfolder: 'agentx', type: 'output' };
    });
    const first = await service.accept({ actionKey: 'image-busy-first', prompt: 'A synthetic lake' });
    await waitFor(first.id, 'generating');
    client.ready.mockImplementation(async (_profile, options) => {
      if (!options?.allowBusy) throw new Error('Worker busy');
      return {};
    });
    const second = await service.accept({ actionKey: 'image-busy-second', prompt: 'A synthetic mountain' });
    expect(second.state).toBe('queued'); expect(client.submit).toHaveBeenCalledTimes(1);
    expect((await service.accept({ actionKey: 'image-busy-second', prompt: 'A synthetic mountain' })).id).toBe(second.id);
    client.ready.mockResolvedValue({}); finishFirst();
    await waitFor(first.id, 'completed');
    await require('../../src/services/heavyWorkQueueEvidence').reconcile(first.queueRequestId, 'fixture');
    await service.dispatchQueued(); await waitFor(second.id, 'completed');
    expect(client.submit).toHaveBeenCalledTimes(2);
  });
  test('waits in the durable queue behind coding work, then dispatches exactly once after release', async () => {
    const queue = require('../../src/services/heavyWorkQueueService');
    const blocker = await queue.submit({ key: 'synthetic-coding', title: 'Synthetic coding', kind: 'diagnostic',
      hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5, source: { type: 'coding' } }, 'fixture');
    const slot = await queue.reserve(blocker.id, { expectedRevision: blocker.revision, start: new Date().toISOString() }, 'fixture');
    const op = await service.accept({ actionKey: 'image-waits', prompt: 'A synthetic lake' });
    expect(op.state).toBe('queued'); expect(op.queueRequestId).toBeTruthy(); expect(client.submit).not.toHaveBeenCalled();
    await queue.cancel(slot.id, { expectedRevision: slot.revision }, 'fixture');
    await Promise.all([service.dispatchQueued(), service.dispatchQueued()]);
    await waitFor(op.id, 'completed');
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect((await service.accept({ actionKey: 'image-waits', prompt: 'A synthetic lake' })).id).toBe(op.id);
  });
  test('cancelling an unstarted queued image changes the same queue request without GPU effects', async () => {
    const queue = require('../../src/services/heavyWorkQueueService');
    const blocker = await queue.submit({ key: 'synthetic-blocker', title: 'Synthetic blocker', kind: 'diagnostic',
      hosts: ['http://127.0.0.1:11434'], estimatedMinutes: 5 }, 'fixture');
    await queue.reserve(blocker.id, { expectedRevision: blocker.revision, start: new Date().toISOString() }, 'fixture');
    const op = await service.accept({ actionKey: 'image-cancel-waits', prompt: 'A synthetic lake' });
    expect((await service.cancel(op.id)).state).toBe('cancelled');
    expect((await queue.get(op.queueRequestId)).state).toBe('cancelled');
    await service.dispatchQueued(); expect(client.submit).not.toHaveBeenCalled();
  });
  test('archive failure restores the GPU and permits storage-only recovery', async () => {
    client.read.mockRejectedValueOnce(new Error('output temporarily unavailable'));
    const first = await service.accept({ actionKey: 'action-storage', prompt: 'A lake' });
    const failed = await waitFor(first.id, 'archive_failed');
    expect(failed.runtimeRestored).toBe(true);
    expect((await service.retryArchive(first.id)).state).toBe('completed');
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('changing the worker cannot retrieve a different worker’s output', async () => {
    client.read.mockRejectedValueOnce(new Error('output temporarily unavailable'));
    const first = await service.accept({ actionKey: 'action-worker-change', prompt: 'A lake' });
    await waitFor(first.id, 'archive_failed');
    loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:9999', profiles: { quality: profile }, defaultProfile: 'quality' });
    await expect(service.retryArchive(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('corrupt archived bytes are refused even when their size matches', async () => {
    const first = await service.accept({ actionKey: 'action-corrupt', prompt: 'A lake' });
    await waitFor(first.id, 'completed');
    const record = await ImageOperation.findById(first.id).lean();
    await fs.promises.writeFile(path.join(dir, record.artifact.path), Buffer.alloc(bytes.length));
    await expect(service.image(first.id)).rejects.toMatchObject({ statusCode: 503 });
  });
  test('a valid new action generates a distinct variant; identical prompts are not deduplicated', async () => {
    const first = await service.accept({ actionKey: 'action-variant-1', prompt: 'A lake' });
    await waitFor(first.id, 'completed');
    const second = await service.accept({ actionKey: 'action-variant-2', prompt: 'A lake' });
    await waitFor(second.id, 'completed');
    expect(first.id).not.toBe(second.id); expect(client.submit).toHaveBeenCalledTimes(2);
  });
  test('conversation scope is durable, isolates receipts, and participates in replay identity', async () => {
    const conversation = { surface: 'household', sessionId: 'family-session', packId: 'kidx_nestor', scopeId: 'family' };
    const body = { actionKey: 'action-conversation', prompt: 'Two robots in a cardboard car', seed: 42 };
    const first = await service.accept(body, { conversation });
    await waitFor(first.id, 'completed');
    expect((await service.getForConversation(first.id, conversation)).id).toBe(first.id);
    expect((await service.listForConversation(conversation)).map(op => op.id)).toEqual([first.id]);
    const other = { ...conversation, sessionId: 'different-session' };
    await expect(service.getForConversation(first.id, other)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.listForConversation(other)).toEqual([]);
    expect((await service.list()).map(op => op.id)).not.toContain(first.id);
    await expect(service.accept(body, { conversation: other })).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.accept(body)).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.accept(body, { conversation })).id).toBe(first.id);
    expect(await service.draft(first.id)).toMatchObject({ prompt: body.prompt, seed: 42, profile: 'quality', width: 1024, height: 1024 });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('a disconnect before admission commits no work; quick preset never selects Qwen implicitly', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(service.accept({ actionKey: 'action-disconnect', prompt: 'A lake' }, { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect(client.submit).not.toHaveBeenCalled();
    expect(service.status().conversationProfile).toEqual({ id: 'quality', width: 1024, height: 1024 });
    loadConfig.mockReturnValue({ defaultProfile: 'quality', profiles: { quality: { ...profile, family: 'qwen21', steps: 25 } } });
    expect(service.status().conversationProfile).toBeNull();
  });
  describe('resource receipts (synthetic worker answers only)', () => {
    const OTHER = '6a1f9c3e-2b4d-4e8f-9c1a-7b3d5e6f8a90';
    const workerRelease = jobId => ({ resources: { contract: 'agentx.image-worker-resources/v1',
      child: { spawnedAtMs: 1000, readyAtMs: 2000, releasedAtMs: 9000, reserveVramGiB: 1.2, jobIds: [jobId] },
      ram: { status: 'measured', peakKiB: 4096 }, vram: { status: 'sampled', bound: 'lower', intervalMs: 1000,
        samples: { attempted: 2, matched: 2, absent: 0, failed: 0, invalid: 0 }, observedMaxMiB: 512,
        observedMaxAtMs: 3000, firstMatchedAtMs: 2500, lastMatchedAtMs: 3000 },
      jobs: [{ jobId, executionMs: 1500 }] } });
    const releaseWith = answer => client.free.mockImplementation(async (_owned, _empty, _ratio, onReleased) => {
      onReleased(typeof answer === 'function' ? answer(client.submit.mock.calls.at(-1)[0]) : answer); return {};
    });
    const phases = op => Object.keys(op.timings.phasesMs);
    const expectPhases = (op, names) => {
      expect(phases(op)).toEqual(names);
      const values = Object.values(op.timings.phasesMs);
      expect(values.every(value => Number.isInteger(value) && value >= 0)).toBe(true);
      expect(values.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(op.timings.totalMs);
    };
    test('completion, failure and cancellation each keep their own child receipt and Core phases', async () => {
      releaseWith(workerRelease);
      const done = await waitFor((await service.accept({ actionKey: 'resources-done', prompt: 'A lake' })).id, 'completed');
      expect(done.resources).toMatchObject({ contract: 'agentx.image-resources/v1', status: 'recorded', attribution: 'exclusive', executionMs: 1500,
        ram: { status: 'measured', peakKiB: 4096, scope: 'cuda-child-process' },
        vram: { status: 'sampled-lower-bound', observedMaxMiB: 512, scope: 'cuda-child-process' } });
      expectPhases(done, ['reserving', 'generating', 'archiving', 'restoring']);
      client.observe.mockImplementationOnce(async (_id, options) => { await options.onTerminal(); throw Object.assign(new Error('Image generation failed'), { terminal: true }); });
      const failed = await waitFor((await service.accept({ actionKey: 'resources-failed', prompt: 'A lake' })).id, 'failed');
      expect(failed).toMatchObject({ runtimeRestored: true, resources: { status: 'recorded', ram: { peakKiB: 4096 } } });
      expectPhases(failed, ['reserving', 'generating', 'restoring']);
      client.observe.mockImplementationOnce(async (_id, options) => { await options.onTerminal(); throw Object.assign(new Error('Image generation cancelled'), { terminal: true, cancelled: true }); });
      const cancelled = await waitFor((await service.accept({ actionKey: 'resources-cancelled', prompt: 'A lake' })).id, 'cancelled');
      expect(cancelled).toMatchObject({ runtimeRestored: true, resources: { status: 'recorded' } });
      expect(reservation.restore).toHaveBeenCalledTimes(3);
    });
    test('an uncertain dispatch never reaches release, so it records no resource figure', async () => {
      releaseWith(workerRelease);
      client.submit.mockRejectedValue(new Error('connection lost after dispatch'));
      const unknown = await waitFor((await service.accept({ actionKey: 'resources-unknown', prompt: 'A lake' })).id, 'unknown');
      expect(unknown.resources).toBeNull();
      expect(client.free).not.toHaveBeenCalled();
      expectPhases(unknown, ['reserving', 'generating']);
    });
    test('a stale, missing or malformed worker receipt never blocks completion or attributes figures', async () => {
      for (const [key, answer, status] of [['stale', workerRelease(OTHER), 'stale'], ['empty', {}, 'unavailable'], ['garbage', { resources: [1, 2] }, 'unavailable']]) {
        releaseWith(answer);
        const done = await waitFor((await service.accept({ actionKey: `resources-${key}`, prompt: 'A lake' })).id, 'completed');
        expect(done.runtimeRestored).toBe(true);
        expect(done.resources.status).toBe(status);
        expect(done.resources).not.toHaveProperty('ram');
      }
    });
    test('older receipts keep their fields and report no resource receipt', async () => {
      await ImageOperation.collection.insertOne({ _id: 'legacy-image-operation', actionKey: 'legacy-action-key', requestHash: 'a'.repeat(64),
        state: 'completed', request: { prompt: 'A lake' }, profile: { id: 'quality', label: 'Test image' }, runtimeRestored: true,
        timings: { totalMs: 4200 }, createdAt: new Date(), updatedAt: new Date() });
      const legacy = await service.get('legacy-image-operation');
      expect(legacy).toMatchObject({ state: 'completed', runtimeRestored: true, timings: { totalMs: 4200 }, resources: null });
    });
  });
});
