'use strict';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/PipelineTask');
const Settings = require('../../models/PipelineCodingAutonomy');
const service = require('../../src/services/pipelineCodingAutonomyService');
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline-coding-autonomy'));
const CAMPAIGN = '11111111-2222-4333-8444-555555555555';
let control;
const proposal = () => ({ authorized: true, confirm: true, expectedRevision: 0, queueRequestId: CAMPAIGN, lowRisk: true,
  scope: ['core/src/services/inferenceRuntimePolicy.js'], verificationProfile: 'agentx-core-runner-tests/v1',
  limits: { workSeconds: 900, modelCalls: 32 }, qualification: {
    acceptanceCriteria: ['The deterministic policy accepts a valid request and refuses an invalid one.'],
    requiredCapabilities: ['source_read', 'source_write', 'cpu_tests'], estimate: { workSeconds: 600, modelCalls: 20 } } });
beforeEach(async () => {
  await Promise.all([Task.deleteMany({}), Settings.deleteMany({})]);
  await Task.create({ pipelineId: '0001', title: 'Bounded policy fix', spec: 'Verify a small policy behavior.',
    service: 'agentx-coding', status: 'queued' });
  control = { target: 'fixture', launch: jest.fn(), status: jest.fn(), stop: jest.fn() };
  service.configureControl(control);
});
afterEach(() => { jest.restoreAllMocks(); service.configureControl(null); });
const url = '/api/pipeline/coding-autonomy/tasks/0001';
test('readiness GET and proposal POST leave the task and scheduler untouched', async () => {
  const before = await Task.findOne({ pipelineId: '0001' }).lean();
  const unknown = await request(app).get(url + '/readiness');
  expect(unknown.status).toBe(200); expect(unknown.body.data.status).toBe('missing_prerequisite');
  const view = await request(app).post(url + '/readiness').send(proposal());
  expect(view.status).toBe(200); expect(view.body.data).toMatchObject({ status: 'ready', canAuthorize: true });
  expect(await Task.findOne({ pipelineId: '0001' }).lean()).toEqual(before);
  expect(await Settings.countDocuments()).toBe(0); expect(control.launch).not.toHaveBeenCalled();
});
test.each(['network', 'deployment', 'live_inference'])('%s requirements refuse authorization without creating an intent or dispatch', async capability => {
  const input = proposal(); input.qualification.requiredCapabilities.push(capability);
  const response = await request(app).post(url + '/authorization').send(input);
  expect(response.status).toBe(409); expect(response.body.code).toBe('CODING_TASK_NOT_READY');
  const current = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(current.automation).toBeUndefined(); expect(current.codingAutonomy).toBeUndefined();
  expect(control.launch).not.toHaveBeenCalled(); expect(control.status).not.toHaveBeenCalled();
});
test('an excessive estimate requires decomposition before a worker or budget grant exists', async () => {
  const input = proposal(); input.qualification.estimate.modelCalls = 40;
  expect((await request(app).post(url + '/readiness').send(input)).body.data.status).toBe('needs_decomposition');
  expect((await request(app).post(url + '/authorization').send(input)).status).toBe(409);
  expect((await Task.findOne({ pipelineId: '0001' }).lean()).codingAutonomy).toBeUndefined();
});
test('authorization binds reviewed criteria and a later spec edit prevents selection', async () => {
  const response = await request(app).post(url + '/authorization').send(proposal());
  expect(response.status).toBe(200); expect(response.body.data.readiness.status).toBe('ready');
  const approved = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(approved.codingAutonomy.qualification.definition.acceptanceCriteria).toEqual(proposal().qualification.acceptanceCriteria);
  await service.configure({ enabled: true, confirm: true, expectedRevision: 0 });
  await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'Changed requirement requiring new review.' } });
  await service.tick();
  const changed = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(changed.codingAutonomy.state).toBe('blocked'); expect(changed.codingAutonomy.runs).toHaveLength(0);
  expect(control.launch).not.toHaveBeenCalled();
});
test('a concurrent task edit cannot receive an authorization assessed against the old request', async () => {
  const original = Task.findOneAndUpdate;
  jest.spyOn(Task, 'findOneAndUpdate').mockImplementation(function(query, update, options) {
    if (!update.$set?.codingAutonomy) return original.call(this, query, update, options);
    return { lean: async () => {
      await Task.updateOne({ pipelineId: '0001' }, { $set: { spec: 'Another reviewed request', updatedAt: new Date(Date.now() + 1000) } }, { timestamps: false });
      return original.call(Task, query, update, options).lean();
    } };
  });
  expect((await request(app).post(url + '/authorization').send(proposal())).status).toBe(409);
  const changed = await Task.findOne({ pipelineId: '0001' }).lean();
  expect(changed.spec).toBe('Another reviewed request'); expect(changed.codingAutonomy).toBeUndefined();
});
