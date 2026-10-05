'use strict';
const { createHash } = require('node:crypto');
const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const Deliverable = require('../../models/PipelineTaskDeliverable');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const routes = require('../../routes/pipeline');

let harness;
beforeAll(async () => {
  await Deliverable.createCollection();
  await Deliverable.createIndexes();
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/pipeline', routes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function file(text = '# Synthetic report\n\nAll checks passed.\n', { name = 'report.md', mime = 'text/markdown', hash } = {}) {
  const bytes = Buffer.from(text);
  return { name, dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, sha256: hash || sha(bytes), bytes };
}
async function create(input = {}) {
  const response = await harness.request.post('/api/pipeline/tasks').send({ title: 'Deliverable task', spec: '', ...input }).expect(201);
  return response.body.data.task.pipelineId;
}
const register = (id, body) => harness.request.post(`/api/pipeline/tasks/${id}/deliverables`).send(body);
const upload = ({ bytes, ...body }, extra = {}) => ({ ...body, by: 'operator', ...extra });
const list = async id => (await harness.request.get(`/api/pipeline/tasks/${id}/deliverables`).expect(200)).body.data.deliverables;

test('a registration stores the file under the task and its receipt separates storage, availability and external delivery', async () => {
  const id = await create({ service: 'core' });
  const report = file();
  const response = await register(id, upload(report)).expect(201);
  const { created, receipt } = response.body.data;
  expect(created).toBe(true);
  expect(receipt).toMatchObject({
    schema: 'agentx.pipeline-task-deliverable-receipt/v1',
    pipelineId: id, attempt: null, name: 'report.md', mimeType: 'text/markdown', kind: 'document',
    size: report.bytes.length, sha256: report.sha256,
    owner: { kind: 'pipeline_task', ref: `task-${id}` },
    scope: { lane: 'engineering', service: 'core', taskRef: `task-${id}` },
    producer: { declared: 'operator', authenticated: null, channel: 'operator_api' },
    retention: { policy: 'task_lifetime', expiresAt: null },
    storage: { status: 'stored', store: 'mongodb:pipeline_task_deliverables' },
    availability: { status: 'available', hashVerified: true },
    externalDelivery: { status: 'none' },
    memory: { status: 'not_indexed' },
  });
  expect(receipt.ref).toBe(`task-${id}/deliverable-${receipt.id}`);
  // The listing never loads bytes, so it does not claim a verified digest.
  const [listed] = await list(id);
  expect(listed).toMatchObject({ id: receipt.id, availability: { status: 'present_unverified', hashVerified: false } });
  expect(JSON.stringify(listed)).not.toContain(report.dataUrl.split(',')[1]);
  // The task read stays unchanged: deliverables are not part of the task document.
  const task = (await harness.request.get(`/api/pipeline/tasks/${id}`).expect(200)).body.data.task;
  expect(task.deliverables).toBeUndefined();
});

test('registration is idempotent, including concurrent retries, and a different file under the same name conflicts', async () => {
  const id = await create();
  const report = file();
  const first = (await register(id, upload(report)).expect(201)).body.data.receipt;
  const retry = await register(id, upload(report)).expect(200);
  expect(retry.body.data).toMatchObject({ created: false, receipt: { id: first.id, availability: { status: 'available', hashVerified: true } } });
  const raced = await Promise.all([1, 2, 3].map(() => register(id, upload(file('Parallel synthetic log', { name: 'run.log', mime: 'text/plain' })))));
  expect(raced.map(res => res.status).sort()).toEqual([200, 200, 201]);
  expect(new Set(raced.map(res => res.body.data.receipt.id)).size).toBe(1);
  expect(await Deliverable.countDocuments({ pipelineId: id })).toBe(2);
  const changed = await register(id, upload(file('# A different report\n'))).expect(409);
  expect(changed.body.code).toBe('DELIVERABLE_CONFLICT');
  expect(await Deliverable.countDocuments({ pipelineId: id })).toBe(2);
});

test('a missing file or a wrong fingerprint stores nothing', async () => {
  const id = await create();
  const report = file();
  expect((await register(id, { name: 'report.md', sha256: report.sha256, by: 'operator' }).expect(400)).body.code).toBe('DELIVERABLE_CONTENT_MISSING');
  expect((await register(id, upload(report, { sha256: undefined })).expect(400)).body.code).toBe('DELIVERABLE_SHA256_REQUIRED');
  const wrong = await register(id, upload(file(undefined, { hash: 'f'.repeat(64) }))).expect(422);
  expect(wrong.body).toMatchObject({ code: 'DELIVERABLE_HASH_MISMATCH', details: { declared: 'f'.repeat(64), computed: report.sha256 } });
  expect((await register(id, upload(report, { by: '' })).expect(400)).body.code).toBe('INVALID_PRODUCER');
  expect((await register(id, upload(file('x', { mime: 'application/zip', name: 'a.zip' }))).expect(400)).body.code).toBe('DELIVERABLE_TYPE_UNSUPPORTED');
  const fakePng = file('not a png', { mime: 'image/png', name: 'shot.png' });
  expect((await register(id, upload(fakePng)).expect(400)).body.code).toBe('DELIVERABLE_CONTENT_INVALID');
  expect((await register(id, upload(file('../x', { name: '../escape.md' }))).expect(400)).body.code).toBe('DELIVERABLE_NAME_INVALID');
  expect((await register('9999', upload(report)).expect(404)).body.code).toBe('NOT_FOUND');
  expect(await Deliverable.countDocuments({ pipelineId: id })).toBe(0);
});

test('stored bytes that disappear or change are reported and never served', async () => {
  const id = await create();
  const missing = (await register(id, upload(file('Missing later', { name: 'gone.txt', mime: 'text/plain' }))).expect(201)).body.data.receipt;
  const altered = (await register(id, upload(file('Original bytes', { name: 'altered.txt', mime: 'text/plain' }))).expect(201)).body.data.receipt;
  await Deliverable.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(missing.id) }, { $unset: { data: '' } });
  await Deliverable.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(altered.id) }, { $set: { data: Buffer.from('Tampered bytes') } });

  const listed = await list(id);
  expect(listed.find(row => row.id === missing.id).availability.status).toBe('missing');
  // Same length, different content: only the digest can tell.
  expect(listed.find(row => row.id === altered.id).availability.status).toBe('present_unverified');
  expect(listed.every(row => row.storage.status === 'stored' && row.externalDelivery.status === 'none')).toBe(true);

  const verified = (await harness.request.get(`/api/pipeline/tasks/${id}/deliverables/${altered.id}`).expect(200)).body.data.receipt;
  expect(verified.availability).toMatchObject({ status: 'corrupt', hashVerified: false });
  expect((await harness.request.get(`/api/pipeline/tasks/${id}/deliverables/${missing.id}/download`).expect(410)).body.code).toBe('DELIVERABLE_MISSING');
  expect((await harness.request.get(`/api/pipeline/tasks/${id}/deliverables/${altered.id}/download`).expect(409)).body.code).toBe('DELIVERABLE_INTEGRITY');
});

test('a deliverable is reachable only through its own task, and worker files only for worker-scope attempts', async () => {
  const owner = await create();
  const other = await create();
  const receipt = (await register(owner, upload(file())).expect(201)).body.data.receipt;
  expect((await harness.request.get(`/api/pipeline/tasks/${other}/deliverables/${receipt.id}`).expect(404)).body.code).toBe('DELIVERABLE_NOT_FOUND');
  expect((await harness.request.get(`/api/pipeline/tasks/${other}/deliverables/${receipt.id}/download`).expect(404)).body.code).toBe('DELIVERABLE_NOT_FOUND');
  expect(await list(other)).toEqual([]);
  expect((await harness.request.get(`/api/pipeline/tasks/${owner}/deliverables/not-an-id`).expect(400)).body.code).toBe('INVALID_DELIVERABLE_ID');

  // A worker attempt must exist on this task.
  expect((await register(owner, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'synthetic-lease' })).expect(404)).body.code).toBe('ATTEMPT_NOT_FOUND');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60000);
  await PipelineTask.updateOne({ pipelineId: owner }, {
    $set: { status: 'in_progress', assignee: 'worker-a', automationLease: {
      leaseId: 'synthetic-lease', assignee: 'worker-a', attempt: 1,
      acquiredAt: now, heartbeatAt: now, expiresAt, durationMs: 60000,
    } },
    $push: { automationAttempts: {
      leaseId: 'synthetic-lease', assignee: 'worker-a', attempt: 1, acquiredAt: now, heartbeatAt: now, expiresAt,
    } },
  });
  expect((await register(owner, upload(file(), { attempt: 1, by: 'worker-a' })).expect(400)).body.code).toBe('DELIVERABLE_LEASE_REQUIRED');
  expect((await register(owner, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'wrong-lease' })).expect(409)).body.code).toBe('DELIVERABLE_LEASE_INACTIVE');
  expect((await register(owner, upload(file(), { by: 'worker-a' })).expect(403)).body.code).toBe('DELIVERABLE_WORKER_ATTEMPT_REQUIRED');
  const worker = (await register(owner, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'synthetic-lease' })).expect(201)).body.data.receipt;
  expect(worker).toMatchObject({ attempt: 1, attemptRef: `task-${owner}/attempt-1`, producer: {
    channel: 'worker_api', declared: 'worker-a', leaseRef: expect.stringMatching(/^lease-[a-f0-9]{16}$/), permitSeq: 1,
  } });
  expect(JSON.stringify(worker)).not.toContain('synthetic-lease');
  expect(worker.id).not.toBe(receipt.id);

  const retry = await register(owner, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'synthetic-lease' })).expect(200);
  expect(retry.body.data.receipt.id).toBe(worker.id);
  expect((await PipelineTask.findOne({ pipelineId: owner }).lean()).deliverablePermitSeq).toBe(1);
  await PipelineTask.updateOne({ pipelineId: owner }, { $set: { status: 'review', 'automationAttempts.0.finalState': 'review' } });
  expect((await register(owner, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'synthetic-lease' })).expect(409)).body.code).toBe('DELIVERABLE_LEASE_INACTIVE');
  expect(await Deliverable.countDocuments({ pipelineId: owner, attempt: 1 })).toBe(1);

  // Private lanes never receive worker deliverables; an operator file keeps the private scope.
  const personal = await create({ service: 'personal' });
  expect((await register(personal, upload(file(), { attempt: 1 })).expect(403)).body.code).toBe('DELIVERABLE_SCOPE_DENIED');
  const privateReceipt = (await register(personal, upload(file())).expect(201)).body.data.receipt;
  expect(privateReceipt.scope.lane).toBe('private');
});

test('a terminal transition before the atomic worker permit prevents a late file', async () => {
  const id = await create();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60000);
  await PipelineTask.updateOne({ pipelineId: id }, {
    $set: { status: 'in_progress', assignee: 'worker-a', automationLease: {
      leaseId: 'lease-race', assignee: 'worker-a', attempt: 1,
      acquiredAt: now, heartbeatAt: now, expiresAt, durationMs: 60000,
    } },
    $push: { automationAttempts: {
      leaseId: 'lease-race', assignee: 'worker-a', attempt: 1, acquiredAt: now, heartbeatAt: now, expiresAt,
    } },
  });
  const originalCount = Deliverable.countDocuments.bind(Deliverable);
  const spy = jest.spyOn(Deliverable, 'countDocuments').mockImplementationOnce(async (...args) => {
    await PipelineTask.updateOne({ pipelineId: id }, {
      $set: { status: 'review', 'automationAttempts.0.finalState': 'review' },
      $unset: { automationLease: 1 },
    });
    return originalCount(...args);
  });
  try {
    const response = await register(id, upload(file(), { attempt: 1, by: 'worker-a', leaseId: 'lease-race' })).expect(409);
    expect(response.body.code).toBe('DELIVERABLE_LEASE_INACTIVE');
  } finally {
    spy.mockRestore();
  }
  expect((await PipelineTask.findOne({ pipelineId: id }).lean()).deliverablePermitSeq).toBe(0);
  expect(await Deliverable.countDocuments({ pipelineId: id })).toBe(0);
});

test('worker registration refuses a stale assignee, expired lease, and a lease without its attempt', async () => {
  const id = await create();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60000);
  await PipelineTask.updateOne({ pipelineId: id }, {
    $set: { status: 'in_progress', assignee: 'worker-a', automationLease: {
      leaseId: 'lease-one', assignee: 'worker-a', attempt: 1,
      acquiredAt: now, heartbeatAt: now, expiresAt, durationMs: 60000,
    } },
    $push: { automationAttempts: {
      leaseId: 'lease-one', assignee: 'worker-a', attempt: 1, acquiredAt: now, heartbeatAt: now, expiresAt,
    } },
  });
  const report = file();
  expect((await register(id, upload(report, { leaseId: 'lease-one' })).expect(400)).body.code).toBe('DELIVERABLE_ATTEMPT_REQUIRED');
  expect((await register(id, upload(report, { attempt: 1, by: 'worker-b', leaseId: 'lease-one' })).expect(409)).body.code).toBe('DELIVERABLE_LEASE_INACTIVE');
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { 'automationLease.expiresAt': new Date(now.getTime() - 1000) } });
  expect((await register(id, upload(report, { attempt: 1, by: 'worker-a', leaseId: 'lease-one' })).expect(409)).body.code).toBe('DELIVERABLE_LEASE_INACTIVE');
  expect(await Deliverable.countDocuments({ pipelineId: id })).toBe(0);
});

test('LAN download returns verified bytes without a human session', async () => {
  const id = await create();
  const report = file('{"passed":12,"failed":0}', { name: 'results.json', mime: 'application/json' });
  const receipt = (await register(id, upload(report)).expect(201)).body.data.receipt;
  const url = `/api/pipeline/tasks/${id}/deliverables/${receipt.id}/download`;
  await harness.request.get(`/api/pipeline/tasks/${id}/deliverables`).expect(200);
  const response = await harness.request.get(url).buffer(true)
    .parse((res, done) => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks))); })
    .expect(200);
  expect(Buffer.compare(response.body, report.bytes)).toBe(0);
  expect(response.headers['x-agentx-deliverable-sha256']).toBe(report.sha256);
  expect(response.headers['content-disposition']).toBe('attachment; filename="results.json"');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['cache-control']).toBe('private, no-store');
});
