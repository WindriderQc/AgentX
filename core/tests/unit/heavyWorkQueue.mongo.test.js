'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Queue = require('../../models/HeavyWorkQueue');
const Runtime = require('../../models/RuntimeCoordination');
const Archive = require('../../models/HeavyWorkQueueArchive');
const queue = require('../../src/services/heavyWorkQueueService');
const { reservations } = require('../../src/services/heavyWorkQueueTimeline');

const A = 'http://127.0.0.1:11434';
const ALIAS = 'http://127.0.0.1:8188';
const B = 'http://127.0.0.1:11435';
const request = (key, endpoint = A) => ({ key, title: `Synthetic ${key}`, kind: 'image', hosts: [endpoint],
  estimatedMinutes: 30, source: { type: 'coding', ref: 'synthetic-session' },
  executor: { actionKey: `synthetic-${key}`, prompt: 'Synthetic fixture only' } });
const at = offset => new Date(Date.now() + offset * 60000).toISOString();
const reserve = job => queue.reserve(job.id, { expectedRevision: job.revision, start: at(-1) }, 'test');
const begin = job => queue.begin(job.id, { expectedRevision: job.revision }, 'test');

describe('durable heavy-work planning and dispatch fences', () => {
  const previous = process.env.AGENTX_RUNTIME_RESOURCES_JSON;
  beforeEach(async () => {
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'synthetic-gpu-a', endpoints: [A, ALIAS] }, { id: 'synthetic-gpu-b', endpoints: [B] }]);
    await Queue.deleteMany({});
    await Archive.deleteMany({});
    await Runtime.deleteMany({});
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AGENTX_RUNTIME_RESOURCES_JSON;
    else process.env.AGENTX_RUNTIME_RESOURCES_JSON = previous;
  });

  it('deduplicates concurrent submissions and refuses changed content under the same key', async () => {
    const jobs = await Promise.all(Array.from({ length: 8 }, () => queue.submit(request('same'), 'test')));
    expect(new Set(jobs.map(job => job.id)).size).toBe(1);
    expect((await queue.list()).count).toBe(1);
    await expect(queue.submit({ ...request('same'), title: 'Changed' }, 'test')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_KEY_CONFLICT' });
    expect(await Runtime.countDocuments()).toBe(0);
  });

  it('atomically admits one of two simultaneous bookings on aliases of the same GPU', async () => {
    const first = await queue.submit(request('first'), 'test');
    const second = await queue.submit(request('alias', ALIAS), 'test');
    const results = await Promise.allSettled([reserve(first), reserve(second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected').reason.code).toBe('HEAVY_QUEUE_CONFLICT');
  });

  it('allows different physical GPUs in parallel without runtime claims during planning', async () => {
    const first = await reserve(await queue.submit(request('gpu-a'), 'test'));
    const second = await reserve(await queue.submit(request('gpu-b', B), 'test'));
    const running = await Promise.all([begin(first), begin(second)]);
    expect(running.map(job => job.state)).toEqual(['dispatching', 'dispatching']);
    expect(await Runtime.countDocuments()).toBe(0);
  });

  it('requires fresh owner revisions and refuses a cancelled request at dispatch', async () => {
    const job = await queue.submit(request('revision'), 'test');
    await expect(queue.reserve(job.id, { start: at(5) }, 'test')).rejects.toMatchObject({ statusCode: 400 });
    const booked = await reserve(job);
    await expect(queue.cancel(job.id, { expectedRevision: job.revision }, 'test')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_STALE' });
    const cancelled = await queue.cancel(job.id, { expectedRevision: booked.revision }, 'test');
    await expect(begin(cancelled)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects early and expired dispatches, including an expired startBefore bound', async () => {
    const future = await queue.submit(request('early'), 'test');
    const booked = await queue.reserve(future.id, { expectedRevision: future.revision, start: at(60) }, 'test');
    await expect(begin(booked)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
    const limited = await queue.submit({ ...request('late', B), startBefore: at(1) }, 'test');
    const ready = await reserve(limited);
    await Queue.updateOne({ _id: 'heavy-work', 'jobs.id': ready.id }, { $set: { 'jobs.$.startBefore': at(-1) } });
    await expect(begin(ready)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_WINDOW_CLOSED' });
    expect((await queue.get(ready.id)).state).toBe('reserved');
  });

  it('allows exactly one dispatch when two operator sessions race', async () => {
    const ready = await reserve(await queue.submit(request('race'), 'test'));
    const results = await Promise.allSettled([begin(ready), begin(ready)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await queue.get(ready.id)).events.filter(item => item.action === 'dispatching')).toHaveLength(1);
  });

  it('retains uncertain fences beyond their estimated end and never accepts another operation identity', async () => {
    const job = await begin(await reserve(await queue.submit(request('unknown'), 'test')));
    await queue.record(job.id, { dispatchId: job.dispatchId, state: 'uncertain', reason: 'Synthetic lost reply' }, 'test');
    const later = await queue.submit(request('later', ALIAS), 'test');
    await expect(queue.reserve(later.id, { expectedRevision: later.revision, start: at(180) }, 'test')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_CONFLICT' });
    await expect(queue.cancel(job.id, { expectedRevision: 3 }, 'test')).rejects.toMatchObject({ statusCode: 409 });
    const recorded = await queue.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: 'synthetic-op' }, 'test');
    const replay = await queue.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: 'synthetic-op' }, 'test');
    expect(replay.revision).toBe(recorded.revision);
    await expect(queue.record(job.id, { dispatchId: job.dispatchId, state: 'running', operationId: 'another' }, 'test')).rejects.toMatchObject({ statusCode: 409 });
    await expect(queue.settle(job.id, { operationId: 'another', state: 'completed' }, 'test')).rejects.toMatchObject({ statusCode: 409 });
    await queue.settle(job.id, { operationId: 'synthetic-op', state: 'completed', authority: 'synthetic-executor' }, 'test');
    await expect(reserve(later)).resolves.toMatchObject({ state: 'reserved' });
  });

  it('blocks dispatch after a physical mapping change until existing bookings are reconciled', async () => {
    const ready = await reserve(await queue.submit(request('topology'), 'test'));
    process.env.AGENTX_RUNTIME_RESOURCES_JSON = JSON.stringify([{ id: 'changed-device', endpoints: [A] }]);
    await expect(begin(ready)).rejects.toMatchObject({ code: 'HEAVY_QUEUE_TOPOLOGY_CHANGED' });
    await expect(queue.cancel(ready.id, { expectedRevision: ready.revision }, 'test')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('uses explicit DST offsets and clips one-off reservations to the selected local day', async () => {
    const first = await queue.submit(request('dst-first'), 'test');
    const second = await queue.submit(request('dst-second', ALIAS), 'test');
    await queue.reserve(first.id, { expectedRevision: first.revision, start: '2026-11-01T01:15:00-04:00' }, 'test');
    await queue.reserve(second.id, { expectedRevision: second.revision, start: '2026-11-01T01:15:00-05:00' }, 'test');
    const slots = await reservations(new Date('2026-11-01T04:00:00Z'), new Date('2026-11-02T05:00:00Z'));
    expect(slots.map(item => item.slots[0].start).sort()).toEqual(['2026-11-01T05:15:00.000Z', '2026-11-01T06:15:00.000Z']);
    await expect(queue.reserve(first.id, { expectedRevision: 2, start: '2026-11-01T01:15:00' }, 'test')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('requires a confirmed legacy snapshot, preserves the whole original, and never writes it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-queue-fixture-'));
    const file = path.join(dir, 'QUEUE.md');
    const markdown = '## Running\n\n## Waiting\n| 5 | Synthetic legacy | fixture | old host | unknown | old window | private note |\n## Done\nOriginal history stays here.\n';
    try {
      await fs.writeFile(file, markdown);
      await expect(queue.submit(request('migration'), 'test', { file })).rejects.toMatchObject({ code: 'HEAVY_QUEUE_MIGRATION_REQUIRED' });
      await expect(queue.migrate({ sha256: 'wrong' }, 'test', { file })).rejects.toMatchObject({ statusCode: 409 });
      const snapshot = await queue.legacySnapshot(file);
      await queue.migrate({ sha256: snapshot.sha256 }, 'test', { file });
      await queue.migrate({ sha256: snapshot.sha256 }, 'test', { file });
      expect((await queue.list()).count).toBe(1);
      expect((await Queue.findById('heavy-work').lean()).legacy.markdown).toBe(markdown);
      expect(await fs.readFile(file, 'utf8')).toBe(markdown);
      await expect(queue.submit(request('migration'), 'test', { file })).resolves.toMatchObject({ state: 'requested' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('archives terminal receipts before removing rows and preserves idempotency afterward', async () => {
    const body = request('archived');
    const job = await queue.submit(body, 'test');
    await queue.cancel(job.id, { expectedRevision: job.revision }, 'test');
    await queue.archive('test');
    expect((await queue.list()).count).toBe(0);
    expect((await queue.list()).archivedCount).toBe(1);
    expect((await queue.get(job.id)).state).toBe('cancelled');
    expect((await queue.submit(body, 'test')).id).toBe(job.id);
    expect((await queue.archived()).jobs[0].job.id).toBe(job.id);
    await expect(queue.submit({ ...body, title: 'Different' }, 'test')).rejects.toMatchObject({ code: 'HEAVY_QUEUE_KEY_CONFLICT' });
  });

  it('requires an operator recovery receipt and refuses while native authority is still held', async () => {
    const job = await begin(await reserve(await queue.submit(request('recover'), 'test')));
    const body = { expectedRevision: job.revision, dispatchId: job.dispatchId,
      confirmation: 'EXECUTOR_TERMINATED_AND_RUNTIME_RELEASED', receiptRef: 'synthetic-restart-receipt' };
    await expect(queue.recover(job.id, { ...body, confirmation: 'anything' }, 'test')).rejects.toMatchObject({ statusCode: 400 });
    await Runtime.collection.insertOne({ _id: 'runtime', workloads: [{ hosts: [ALIAS], resourceIds: ['synthetic-gpu-a'] }], inferences: [] });
    await expect(queue.recover(job.id, body, 'test')).rejects.toMatchObject({ statusCode: 409 });
    await Runtime.deleteMany({});
    await expect(queue.recover(job.id, body, 'test')).resolves.toMatchObject({ state: 'failed', releaseReceipt: { authority: 'operator-reconciliation' } });
  });
});
