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

  await harness.request.post('/api/pipeline/tasks/0901/claim').send({ assignee: 'worker-a' }).expect(200);
  const worker = await harness.request.get('/api/pipeline/tasks/0901/worker?agent=worker-a').expect(200);
  expect(worker.body.data.task.assignee).toBe('worker-a');
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
