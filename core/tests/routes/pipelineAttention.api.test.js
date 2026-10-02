const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const pipelineRoutes = require('../../routes/pipeline');
const { readAttention } = require('../../src/services/pipelineAttentionService');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRoutes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => { await PipelineTask.deleteMany({}); });

const id = n => String(n).padStart(4, '0');

// 25 engineering attention items across ranks, 3 private-lane attention items
// and non-attention noise (fresh in-progress, done, deferred).
async function seed() {
  const now = Date.now();
  const rows = [];
  for (let n = 1; n <= 25; n += 1) {
    const status = n % 3 === 0 ? 'blocked' : n % 3 === 1 ? 'review' : 'in_progress';
    rows.push({ pipelineId: id(n), title: n === 7 ? 'Réparer la file' : `Engineering ${n}`, service: n <= 12 ? 'core' : 'benchmark',
      source: n % 2 ? 'roadmap' : 'agent', status, assignee: status === 'in_progress' ? 'worker-a' : null,
      heartbeatAt: status === 'in_progress' ? new Date(now - 3 * 3600_000) : null, automationAttemptCount: 1 });
  }
  rows.push(
    { pipelineId: id(101), title: 'Private family blocker', service: 'family', status: 'blocked' },
    { pipelineId: id(102), title: 'Household routine review', service: 'core', source: 'household-routine', status: 'review' },
    { pipelineId: id(103), title: 'Idea waiting', service: '', source: 'idea-drop', status: 'blocked' },
    { pipelineId: id(201), title: 'Fresh work', service: 'core', status: 'in_progress', assignee: 'worker-b', heartbeatAt: new Date(now) },
    { pipelineId: id(202), title: 'Closed', service: 'core', status: 'done' },
    { pipelineId: id(203), title: 'Queued', service: 'core', status: 'queued' },
  );
  await PipelineTask.create(rows);
}

async function read(query = '') {
  const res = await harness.request.get(`/api/pipeline/attention${query}`).expect(200);
  return res.body.data.attention;
}

test('pages 25 engineering items with an exact total, stable order and no private lane', async () => {
  await seed();
  const pages = [await read(), await read('?offset=10'), await read('?offset=20')];
  expect(pages.map(page => page.items.length)).toEqual([10, 10, 5]);
  expect(pages[0]).toMatchObject({ schema: 'agentx.pipeline-attention/v1', scope: 'engineering', authorization: 'not_granted',
    coverage: { complete: true, total: 25, candidateCount: 27 }, page: { offset: 0, hasPrevious: false, hasNext: true } });
  expect(pages[2].page).toMatchObject({ offset: 20, hasPrevious: true, hasNext: false });
  const ids = pages.flatMap(page => page.items.map(item => item.pipelineId));
  expect(new Set(ids).size).toBe(25);
  expect(ids).not.toEqual(expect.arrayContaining(['0101', '0102', '0103', '0201', '0202', '0203']));
  const ranks = pages.flatMap(page => page.items.map(item => item.rank));
  expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  expect(ids.slice(0, 8)).toEqual(['0003', '0006', '0009', '0012', '0015', '0018', '0021', '0024']);
  expect(pages[0].signal.keys).toHaveLength(25);
  expect(pages[0].otherScope).toEqual({ scope: 'private', count: null });
});

test('keeps private lanes in their own scope', async () => {
  await seed();
  const privateScope = await read('?scope=private');
  expect(privateScope.items.map(item => item.pipelineId)).toEqual(['0101', '0103', '0102']);
  expect(privateScope.otherScope).toEqual({ scope: 'engineering', count: null });
  const idea = await read('?lane=idea-drop');
  expect(idea.items).toEqual([]);
  expect(idea.coverage.total).toBe(0);
  expect((await read('?scope=private&lane=idea-drop')).coverage.total).toBe(1);
});

test('applies the board filters (lane, service, status, search) before paging', async () => {
  await seed();
  expect((await read('?lane=roadmap')).coverage.total).toBe(13);
  expect((await read('?service=benchmark')).coverage.total).toBe(13);
  expect((await read('?status=review&limit=50')).items.every(item => item.status === 'review')).toBe(true);
  expect((await read('?search=reparer')).items.map(item => item.pipelineId)).toEqual(['0007']);
  expect((await read('?status=done')).coverage).toMatchObject({ complete: true, total: 0 });
  expect((await read('?task=0004&assignee=worker_a&alias=x')).items.map(item => item.pipelineId)).toEqual([]);
  expect((await read('?task=0005&assignee=Worker%20A')).items.map(item => item.pipelineId)).toEqual(['0005']);
});

test('refresh is idempotent, and a change updates the signal without duplicates', async () => {
  await seed();
  const first = await read();
  const again = await read();
  expect(again.signal.fingerprint).toBe(first.signal.fingerprint);
  expect(again.items).toEqual(first.items.map(item => ({ ...item })));
  await PipelineTask.updateOne({ pipelineId: '0003' }, { status: 'done' });
  const changed = await read('?offset=20');
  expect(changed.signal.fingerprint).not.toBe(first.signal.fingerprint);
  expect(changed.coverage.total).toBe(24);
  expect(changed.items).toHaveLength(4);
  const beyond = await read('?offset=30');
  expect(beyond.page).toMatchObject({ offset: 20, requestedOffset: 30, returnedCount: 4 });
});

test('a read changes no task, slot or attempt state', async () => {
  await seed();
  const snapshot = async () => (await PipelineTask.find({}).sort({ pipelineId: 1 }).lean())
    .map(({ pipelineId, status, assignee, heartbeatAt, automationAttemptCount, updatedAt, automationAttempts }) =>
      ({ pipelineId, status, assignee, heartbeatAt, automationAttemptCount, updatedAt, automationAttempts }));
  const before = await snapshot();
  await read('?limit=50');
  await read('?scope=private');
  expect(await snapshot()).toEqual(before);
});

test('reports partial coverage honestly when the bounded scan cannot see every task', async () => {
  await seed();
  const partial = await readAttention({ limit: '10' }, { scanLimit: 12 });
  expect(partial.coverage).toMatchObject({ complete: false, total: null, candidateCount: 27, scannedCount: 12, lowerBound: 12 });
  expect(partial.coverage.basis).toMatch(/total is unknown/);
});

test('does not scan the other scope to answer one scope', async () => {
  await seed();
  const find = jest.spyOn(PipelineTask, 'find');
  await read();
  const scopes = find.mock.calls.filter(([query]) => query?.$and).map(([query]) => JSON.stringify(query.$and[1]));
  expect(scopes).toHaveLength(1);
  expect(scopes[0]).not.toContain('$or');
  find.mockRestore();
});

test('rejects invalid queries and hides store errors', async () => {
  await harness.request.get('/api/pipeline/attention?scope=all').expect(400);
  await harness.request.get('/api/pipeline/attention?limit=500').expect(400);
  await harness.request.get('/api/pipeline/attention?offset=-1').expect(400);
  await harness.request.get('/api/pipeline/attention?status=unknown').expect(400);
  const spy = jest.spyOn(PipelineTask, 'countDocuments').mockRejectedValueOnce(new Error('mongo://secret-host down'));
  const res = await harness.request.get('/api/pipeline/attention').expect(500);
  expect(JSON.stringify(res.body)).not.toContain('secret-host');
  spy.mockRestore();
});
