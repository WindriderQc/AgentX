const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const pipelineRoutes = require('../../routes/pipeline');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRoutes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(async () => { await PipelineTask.deleteMany({}); });

test.each([
  { service: 'family' },
  { service: 'personal' },
  { service: 'household' },
  { service: 'secretary' },
  { source: 'idea-drop' },
  { source: 'household-routine' },
  { service: ' Family ' },
  { source: ' Household-routine ' },
])('keeps requeued private work out of every worker entry point: %j', async (lane) => {
  await PipelineTask.create([
    { pipelineId: '0900', title: 'Synthetic private routine', spec: 'Private fixture',
      status: 'in_progress', assignee: 'household-family', priority: 1, ...lane },
    { pipelineId: '0901', title: 'Public work', service: 'core', priority: 5 },
  ]);
  await harness.request.post('/api/pipeline/tasks/0900/status').send({ status: 'queued' }).expect(200);
  for (const query of ['', '?includePersonal=true', '?includeIdeaDrop=true']) {
    const next = await harness.request.get('/api/pipeline/tasks/next' + query).expect(200);
    expect(next.body.data.nextTaskId).toBe('0901');
  }
  await harness.request.get('/api/pipeline/tasks/0900/worker?agent=worker-a').expect(404);
  await harness.request.post('/api/pipeline/tasks/0900/claim').send({ assignee: 'worker-a' }).expect(404);
  expect(await PipelineTask.findOne({ pipelineId: '0900' }).lean()).toMatchObject({ status: 'queued', assignee: null });

  // Human task management is still available; this is worker selection scope.
  const human = await harness.request.get('/api/pipeline/tasks/0900').expect(200);
  expect(human.body.data.task.spec).toBe('Private fixture');
  const list = await harness.request.get('/api/pipeline/tasks').expect(200);
  expect(list.body.data.tasks.map(task => task.pipelineId)).toContain('0900');
  const engineering = await harness.request.get('/api/pipeline/tasks?scope=engineering').expect(200);
  expect(engineering.body.data.tasks.map(task => task.pipelineId)).toEqual(['0901']);
  expect(engineering.body.data.summary).toMatchObject({ matchedCount: 1, openCount: 1 });
  expect(engineering.body.data.evidence.scope.taskScope).toBe('engineering');

  await harness.request.post('/api/pipeline/tasks/0901/claim').send({ assignee: 'worker-a' }).expect(200);
  const worker = await harness.request.get('/api/pipeline/tasks/0901/worker?agent=worker-a').expect(200);
  expect(worker.body.data.task.assignee).toBe('worker-a');
});

test('engineering history applies its scope before pagination, counts and explicit service filters', async () => {
  await PipelineTask.create([
    { pipelineId: '0001', title: 'Synthetic personal action', service: 'personal', status: 'done' },
    { pipelineId: '0002', title: 'Synthetic family routine', service: 'family', status: 'queued' },
    { pipelineId: '0003', title: 'Synthetic household source', service: 'core', source: 'household-parent', status: 'done' },
    { pipelineId: '0004', title: 'Synthetic idea', source: 'idea-drop', status: 'done' },
    { pipelineId: '0901', title: 'Human engineering change', service: 'core', status: 'done' },
    { pipelineId: '0902', title: 'Coding Team change', service: 'agentx-coding', status: 'done' },
    { pipelineId: '0903', title: 'Engineering backlog', service: 'core', status: 'queued' },
  ]);
  const snapshot = await PipelineTask.find({}).sort({ pipelineId: 1 }).lean();
  const response = await harness.request.get('/api/pipeline/tasks?scope=engineering&includeDone=true&view=summary&limit=2').expect(200);
  const data = response.body.data;
  expect(data.tasks.map(task => task.pipelineId)).toEqual(['0901', '0902']);
  expect(data.summary).toMatchObject({ byStatus: { queued: 1, in_progress: 0, review: 0, blocked: 0, done: 2 }, matchedCount: 3, openCount: 1, doneCount: 2 });
  expect(data.evidence).toMatchObject({ scope: { taskScope: 'engineering', includesDone: true }, rows: { returnedCount: 2, matchedCount: 3, truncated: true } });
  const filtered = await harness.request.get('/api/pipeline/tasks?scope=engineering&status=done&service=core').expect(200);
  expect(filtered.body.data.tasks.map(task => task.pipelineId)).toEqual(['0901']);
  expect(filtered.body.data.evidence.scope.filters).toEqual({ service: 'core' });
  const personal = await harness.request.get('/api/pipeline/tasks?scope=engineering&includeDone=true&service=personal').expect(200);
  expect(personal.body.data.summary.matchedCount).toBe(0);
  expect(personal.body.data.tasks).toEqual([]);
  const all = await harness.request.get('/api/pipeline/tasks?includeDone=true').expect(200);
  expect(all.body.data.summary.matchedCount).toBe(7);
  expect(all.body.data.evidence.scope.taskScope).toBe('all');
  expect(await PipelineTask.find({}).sort({ pipelineId: 1 }).lean()).toEqual(snapshot);
});

test('invalid task scopes refuse before reading the task store', async () => {
  const find = jest.spyOn(PipelineTask, 'find');
  try {
    const response = await harness.request.get('/api/pipeline/tasks?scope=unsupported').expect(400);
    expect(response.body.code).toBe('INVALID_TASK_SCOPE');
    expect(find).not.toHaveBeenCalled();
  } finally { find.mockRestore(); }
});

test('an existing worker assignment does not disclose a private task', async () => {
  await PipelineTask.create({ pipelineId: '0900', title: 'Private fixture', service: 'family',
    status: 'in_progress', assignee: 'worker-a' });
  await harness.request.get('/api/pipeline/tasks/0900/worker?agent=worker-a').expect(404);
});

test('a task becoming private between selection and atomic claim is not claimed', async () => {
  await PipelineTask.create({ pipelineId: '0900', title: 'Changed lane', service: 'core' });
  const update = PipelineTask.findOneAndUpdate.bind(PipelineTask);
  const spy = jest.spyOn(PipelineTask, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await PipelineTask.updateOne({ pipelineId: '0900' }, { $set: { service: 'family' } });
    return update(...args);
  });
  try {
    await harness.request.post('/api/pipeline/tasks/0900/claim').send({ assignee: 'worker-a' }).expect(409);
    expect(await PipelineTask.findOne({ pipelineId: '0900' }).lean()).toMatchObject({ service: 'family', status: 'queued', assignee: null });
  } finally { spy.mockRestore(); }
});

test('archive counts cover the full engineering scope beyond the loaded page without changing task statuses', async () => {
  const qualification = { disposition: { kind: 'qualification', outcome: 'abandoned' } };
  await PipelineTask.create([
    { pipelineId: '0100', title: 'Current queued work', status: 'queued' },
    { pipelineId: '0101', title: 'Current blocked work', status: 'blocked' },
    { pipelineId: '0102', title: 'Archived blocked fixture', status: 'blocked', codingAutonomy: qualification },
    { pipelineId: '0103', title: 'Archived review fixture', status: 'review', codingAutonomy: qualification },
    { pipelineId: '0104', title: 'Archived queued fixture', status: 'queued', codingAutonomy: qualification },
    { pipelineId: '0105', title: 'Closed engineering work', status: 'done' },
    { pipelineId: '0106', title: 'Private fixture', service: 'family', status: 'blocked', codingAutonomy: qualification },
  ]);
  const before = await PipelineTask.find({}).sort({ pipelineId: 1 }).lean();
  const { body: { data } } = await harness.request.get('/api/pipeline/tasks?scope=engineering&includeDone=true&view=summary&limit=1').expect(200);
  expect(data.tasks).toHaveLength(1);
  expect(data.summary.byStatus).toEqual({ queued: 2, in_progress: 0, review: 1, blocked: 2, done: 1 });
  expect(data.summary.archivedQualifications).toEqual({ matchedCount: 3,
    byStatus: { queued: 1, in_progress: 0, review: 1, blocked: 1, done: 0 } });
  expect(data.evidence.rows).toMatchObject({ matchedCount: 6, returnedCount: 1, truncated: true });
  expect(await PipelineTask.find({}).sort({ pipelineId: 1 }).lean()).toEqual(before);
});
