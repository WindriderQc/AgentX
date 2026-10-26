'use strict';
const express = require('express'), request = require('supertest');
const Task = require('../../models/PipelineTask');
const service = require('../../src/services/pipelineWorkReadService');
const { handleOwnerMcp } = require('../../src/services/mcpOwnerTools');
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline'));
const create = extra => require('../../src/services/pipelineTaskService').createTaskInMongo({
  title: 'Synthetic coding work', spec: 'A synthetic observable result.', service: 'core', ...extra });
const call = arguments_ => handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'pipeline_tasks', arguments: arguments_ } });
beforeAll(() => Task.createIndexes());
beforeEach(() => Task.deleteMany({}));

test('owner dossier exposes recorded work even when summaries and the artifact registry do not', async () => {
  const task = await create({ spec: 'Synthetic request and four acceptance criteria.' });
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { status: 'review',
    feedback: [{ by: 'fixture-worker', at: new Date(), text: 'Synthetic PR, test and installation references. No fresh model acceptance.' }] } });
  const before = await Task.findOne({ pipelineId: task.pipelineId }).lean();
  const summary = await call({ pipelineId: String(Number(task.pipelineId)) });
  expect(summary.result.structuredContent.tasks[0]).not.toHaveProperty('feedback');
  const artifacts = await request(app).get(`/api/pipeline/tasks/${task.pipelineId}/deliverables`).expect(200);
  expect(artifacts.body.data.deliverables).toEqual([]);
  const response = await call({ pipelineId: task.pipelineId, view: 'dossier' });
  expect(response.result.isError).toBe(false);
  const doc = JSON.parse(response.result.structuredContent.text);
  expect(doc.task.spec).toContain('four acceptance criteria');
  expect(doc.feedback[0].text).toContain('No fresh model acceptance');
  expect(doc.attempts).toEqual([]);
  expect(doc.interpretation.artifacts).toContain('does not mean no work');
  expect(response.result.structuredContent.executionAuthority).toBe('none');
  expect(await Task.findOne({ pipelineId: task.pipelineId }).lean()).toEqual(before);
});

test('all long specification and feedback pages reconstruct exactly, guarded against mixing revisions', async () => {
  const task = await create({ spec: 'Synthetic specification 🙂 '.repeat(1500) + 'END-SPEC' });
  await Task.updateOne({ pipelineId: task.pipelineId }, { $set: { feedback: [{ by: 'fixture', text: 'Long review '.repeat(2000) + 'END-FEEDBACK' }] } });
  let page = await service.dossier({ pipelineId: task.pipelineId, pageChars: 3000 });
  const first = page, hash = page.contentHash; let text = page.text, pages = 1;
  while (page.hasMore) {
    page = await service.dossier({ pipelineId: task.pipelineId, offset: page.nextOffset, pageChars: 3000, expectedHash: hash });
    expect(page.task).toBeUndefined(); expect(page.contentHash).toBe(hash); text += page.text; pages++;
  }
  expect(pages).toBeGreaterThan(10);
  expect(text.length).toBe(first.totalChars);
  const doc = JSON.parse(text);
  expect(doc.task.spec.endsWith('END-SPEC')).toBe(true);
  expect(doc.feedback[0].text.endsWith('END-FEEDBACK')).toBe(true);
  await Task.updateOne({ pipelineId: task.pipelineId }, { $push: { feedback: { text: 'A concurrent review.' } } });
  await expect(service.dossier({ pipelineId: task.pipelineId, offset: first.nextOffset, expectedHash: hash }))
    .rejects.toMatchObject({ code: 'PIPELINE_DOSSIER_CHANGED', status: 409 });
});

test('coordination credentials stay out of both dossier bytes and summary metadata', async () => {
  const task = await create();
  await Task.collection.updateOne({ pipelineId: task.pipelineId }, { $set: {
    automationLease: { leaseId: 'SECRET-LEASE', expiresAt: new Date(Date.now() + 60000), attempt: 1 },
    codingCapacity: { admissionId: 'SECRET-ADMISSION', generation: 'SECRET-GENERATION', workloadId: 'SECRET-WORKLOAD' },
    codingAutonomy: { state: 'stopped', authorized: false, leaseId: 'SECRET-AUTONOMY', limits: { workSeconds: 100 }, spent: { workSeconds: 20 },
      runs: [{ requestId: '00000000-0000-4000-8000-000000000001', leaseId: 'SECRET-RUN', finishedAt: new Date().toISOString(),
        result: 'blocked', usage: { workSeconds: 20 }, pendingInferences: [] }], manualInterventions: [] },
  } });
  const result = await service.dossier({ pipelineId: task.pipelineId });
  const wire = JSON.stringify(result);
  expect(wire).not.toContain('SECRET-');
  const keys = value => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, child]) => [key, ...keys(child)]) : [];
  expect(keys({ ...result, document: JSON.parse(result.text) })).not.toContain('leaseId');
  const doc = JSON.parse(result.text);
  expect(doc.execution.remaining.workSeconds).toBe(80);
  expect(doc.execution.runs[0].usage.workSeconds).toBe(20);
});

test('engineering scope, literal search, recent ordering, status counts and pagination agree', async () => {
  const first = await create({ title: 'Literal [match]', status: 'blocked' });
  const second = await create({ title: 'Another engineering task', status: 'review' });
  await Task.updateOne({ pipelineId: first.pipelineId }, { $set: { status: 'blocked' } });
  await Task.updateOne({ pipelineId: second.pipelineId }, { $set: { status: 'review' } });
  await create({ service: 'personal', title: 'Private errand' });
  await create({ service: 'family', title: 'Private family task' });
  const page = await request(app).get('/api/pipeline/work?limit=1').expect(200);
  expect(page.headers['cache-control']).toContain('no-store');
  expect(page.body.data.total).toBe(2); expect(page.body.data.hasMore).toBe(true);
  expect(page.body.data.tasks[0].pipelineId).toBe(second.pipelineId);
  const next = await service.list({ limit: 1, offset: page.body.data.nextOffset });
  expect(next.tasks[0].pipelineId).toBe(first.pipelineId); expect(next.hasMore).toBe(false);
  expect((await service.list({ query: '[match]' })).tasks.map(task => task.pipelineId)).toEqual([first.pipelineId]);
  expect((await service.list({ query: String(Number(first.pipelineId)) })).tasks[0].pipelineId).toBe(first.pipelineId);
  expect((await service.list({ status: 'review' })).total).toBe(1);
});

test('private tasks and invalid read requests fail without widening authority', async () => {
  const privateTask = await create({ service: 'personal' });
  await request(app).get(`/api/pipeline/tasks/${privateTask.pipelineId}/dossier`).expect(404);
  for (const path of ['/api/pipeline/work?limit=0', '/api/pipeline/work?status=arbitrary', '/api/pipeline/work?offset=-1',
    '/api/pipeline/work?grant=true', '/api/pipeline/tasks/no-path/dossier', '/api/pipeline/tasks/0001/dossier?offset=1',
    '/api/pipeline/tasks/0001/dossier?pageChars=25000']) await request(app).get(path).expect(400);
  for (const input of [{ view: 'dossier' }, { pipelineId: '0001', view: 'dossier', status: 'review' },
    { pipelineId: '0001', view: 'dossier', approve: true }, { pipelineId: '0001', pageChars: 1000 }]) {
    expect((await call(input)).result.isError).toBe(true);
  }
});
