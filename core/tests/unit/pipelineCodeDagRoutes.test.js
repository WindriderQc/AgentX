'use strict';

const express = require('express');
const request = require('supertest');
const service = require('../../src/services/pipelineCodingAutonomyService');

const ROOT = '11111111-2222-4333-8444-555555555555';
const STEP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ARTIFACT = `code-step-${'a'.repeat(40)}`;
const app = express().use(express.json()).use('/api/pipeline', require('../../routes/pipeline-coding-autonomy'));

afterEach(() => jest.restoreAllMocks());

test('plan, terminal step, adoption and final assembly routes retain exact request identities', async () => {
  const plan = jest.spyOn(service, 'submitCodeStepPlan').mockResolvedValue({ graphId: ROOT });
  const settle = jest.spyOn(service, 'settleCodeStep').mockResolvedValue({ replayed: false });
  const adopt = jest.spyOn(service, 'recordCodeStepAdoption').mockResolvedValue({ replayed: false });
  const complete = jest.spyOn(service, 'completeCodeStepAssembly').mockResolvedValue({ replayed: false });
  const planBody = { sourceCommit: 'a'.repeat(40), plan: { schema: 'synthetic' },
    budget: { workSeconds: 10, testSeconds: 1, modelSeconds: 1, modelCalls: 1 } };
  await request(app).post(`/api/pipeline/coding-autonomy/tasks/0946/runs/${ROOT}/code-step-plan`)
    .send(planBody).expect(200);
  await request(app).post(`/api/pipeline/coding-autonomy/tasks/0946/runs/${STEP}/code-step-result`)
    .send({ outcome: 'failed' }).expect(200);
  await request(app).post(`/api/pipeline/coding-autonomy/tasks/0946/runs/${ROOT}/code-step-adoption`)
    .send({ stepId: 'step-01' }).expect(200);
  await request(app).post(`/api/pipeline/coding-autonomy/tasks/0946/runs/${ROOT}/code-step-assembly`)
    .send({ headCommit: 'b'.repeat(40) }).expect(200);
  expect(plan).toHaveBeenCalledWith('0946', ROOT, planBody);
  expect(settle).toHaveBeenCalledWith('0946', STEP, { outcome: 'failed' });
  expect(adopt).toHaveBeenCalledWith('0946', ROOT, { stepId: 'step-01' });
  expect(complete).toHaveBeenCalledWith('0946', ROOT, { headCommit: 'b'.repeat(40) });
});

test('bundle upload remains raw and download returns the exact immutable bytes', async () => {
  const bytes = Buffer.from('# v2 git bundle\nsynthetic');
  const store = jest.spyOn(service, 'storeCodeStepArtifact').mockResolvedValue({ id: ARTIFACT, sizeBytes: bytes.length });
  jest.spyOn(service, 'downloadCodeStepArtifact').mockResolvedValue({
    metadata: { id: ARTIFACT, sha256: 'b'.repeat(64), sizeBytes: bytes.length, format: 'git-bundle/v1' }, bytes,
  });
  await request(app).put(`/api/pipeline/coding-autonomy/tasks/0946/runs/${STEP}/artifacts/step-01`)
    .set('Content-Type', 'application/x-git-bundle').send(bytes).expect(200);
  expect(store).toHaveBeenCalledWith('0946', STEP, 'step-01', expect.any(Buffer));
  expect(store.mock.calls[0][3].equals(bytes)).toBe(true);
  const response = await request(app).get(`/api/pipeline/coding-autonomy/tasks/0946/runs/${STEP}/artifacts/${ARTIFACT}`)
    .buffer(true).parse((res, callback) => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => callback(null, Buffer.concat(chunks)));
    }).expect(200).expect('Content-Type', 'application/octet-stream').expect('X-AgentX-Artifact-Sha256', 'b'.repeat(64));
  expect(response.body.equals(bytes)).toBe(true);
});
