'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoOptions = require('../../../../shared/testing/mongoOptions');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');

jest.mock('../../../src/services/profiler/hostProfileService', () => ({ getById: jest.fn() }));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({ getActiveProfile: jest.fn() }));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getDedicationStatuses: jest.fn(),
  coreRequest: jest.fn(),
  CORE_OPERATIONS: { PIN_CONTEXT_APPLY: 'benchmark.core-api.pin-context-apply' }
}));

const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const modelPerformanceProfileService = require('../../../src/services/profiler/modelPerformanceProfileService');
const coreApiClient = require('../../../src/clients/coreApiClient');
const ContextProposalDecision = require('../../../models/ContextProposalDecision');

const GiB = 1024 ** 3;
const coResidents = [{ model: 'bge-m3:latest', size: GiB, sizeVram: GiB, contextLength: 8192 }];
const sample = ctx => ({ passed: true, gpuSizeTotal: 20 * GiB, gpuSizeVram: 20 * GiB, ollamaContextLength: ctx, vramUsedMiB: 30000, coResidents });
const evidence = {
  _id: 'e1', authorityWriteId: 'write-1',
  profile: {
    maxVerifiedContext: 98304, recommendedInteractiveContext: 32768,
    probeSteps: [{ numCtx: 98304, passed: true, tokPerSec: 60, samples: [sample(98304), sample(98304)] }]
  }
};
const pinsAt = ctx => [{
  hostUrl: 'http://gpu:11434',
  pinnedModels: [{ model: 'gemma4:12b', contextSize: ctx, keepAlive: -1 }, { model: 'bge-m3:latest', contextSize: 0, keepAlive: -1 }]
}];

const app = express();
app.use(express.json());
app.use('/api/profiler/context-proposals', require('../../../routes/profiler/contextProposals'));

describe('profiler context proposal routes', () => {
  let mongoServer;
  let http;
  const base = '/api/profiler/context-proposals';
  const apply = { hostId: 'gpu', proposalId: 'write-1', contextSize: 98304, decision: 'apply' };

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
    http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
  }, 30000);
  afterAll(async () => {
    await http.close();
    await mongoose.disconnect();
    await mongoServer?.stop();
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    await ContextProposalDecision.deleteMany({});
    hostProfileService.getById.mockResolvedValue({ hostId: 'gpu', hostUrl: 'http://gpu:11434/' });
    modelPerformanceProfileService.getActiveProfile.mockResolvedValue(evidence);
    coreApiClient.getDedicationStatuses.mockResolvedValue(pinsAt(65536));
  });

  it('lists proposals for pinned models only and exposes the offer', async () => {
    const response = await http.request.get(`${base}?hostId=gpu`);
    expect(response.status).toBe(200);
    const byModel = Object.fromEntries(response.body.data.proposals.map(p => [p.modelName, p]));
    expect(byModel['gemma4:12b']).toMatchObject({ status: 'proposed', offer: true, currentContext: 65536, proposedContext: 98304 });
    expect(byModel['bge-m3:latest'].offer).toBe(false);
  });

  it('keeps a declined proposal visible on the card', async () => {
    const decline = await http.request.post(`${base}/gemma4%3A12b/decision`).send({ ...apply, decision: 'keep_current' });
    expect(decline.status).toBe(200);
    expect(decline.body.data.proposal).toMatchObject({ status: 'proposed', declined: true });
    expect(coreApiClient.coreRequest).not.toHaveBeenCalled();
    const card = await http.request.get(`${base}/gemma4%3A12b?hostId=gpu`);
    expect(card.body.data.declined).toBe(true);
  });

  it('forwards Apply to Core with the pin the operator saw, then the proposal matches', async () => {
    coreApiClient.coreRequest.mockImplementation(async () => {
      coreApiClient.getDedicationStatuses.mockResolvedValue(pinsAt(98304));
      return { status: 'success', data: { contextApply: { contextSize: 98304, speed: { before: { tokensPerSec: 50 }, after: { tokensPerSec: 49 } } } } };
    });
    const response = await http.request.post(`${base}/gemma4%3A12b/decision`).send(apply);
    expect(response.status).toBe(200);
    const [path, options] = coreApiClient.coreRequest.mock.calls[0];
    expect(path).toBe('/api/nerve-center/host-preferences/http%3A%2F%2Fgpu%3A11434/pin/context');
    expect(JSON.parse(options.body)).toEqual({ model: 'gemma4:12b', contextSize: 98304, expectedContextSize: 65536, operatorDecision: 'apply' });
    expect(response.body.data).toMatchObject({ decision: 'applied', proposal: { status: 'matches' } });
    expect(await ContextProposalDecision.countDocuments({ decision: 'applied' })).toBe(1);
  });

  it('reports a Core rollback and keeps the proposal offered with the failed attempt', async () => {
    coreApiClient.coreRequest.mockRejectedValue(Object.assign(new Error('Core API 409'), {
      status: 409,
      body: JSON.stringify({ code: 'HOST_PIN_SPEED_REGRESSION', message: 'Short-prompt speed fell; previous pins restored', rollback: 'verified' })
    }));
    const response = await http.request.post(`${base}/gemma4%3A12b/decision`).send(apply);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'HOST_PIN_SPEED_REGRESSION', outcome: { rollback: 'verified' } });
    expect(response.body.proposal).toMatchObject({ status: 'proposed', offer: true, lastAttempt: { outcome: { code: 'HOST_PIN_SPEED_REGRESSION' } } });
  });

  it('records an apply without a Core answer as outcome unknown, not failed', async () => {
    coreApiClient.coreRequest.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    const response = await http.request.post(`${base}/gemma4%3A12b/decision`).send(apply);
    expect(response.status).toBe(504);
    expect(response.body.code).toBe('PIN_CONTEXT_APPLY_OUTCOME_UNKNOWN');
    expect(response.body.error).toMatch(/outcome is unknown.*Check the current pin/);
    expect(response.body.proposal.lastAttempt).toMatchObject({ outcomeUnknown: true });
    expect(await ContextProposalDecision.countDocuments({ decision: 'apply_failed' })).toBe(0);
    expect(await ContextProposalDecision.countDocuments({ decision: 'apply_outcome_unknown' })).toBe(1);
    // The pin is re-read: if Core did apply, the proposal now matches.
    coreApiClient.getDedicationStatuses.mockResolvedValue(pinsAt(98304));
    const card = await http.request.get(`${base}/gemma4%3A12b?hostId=gpu`);
    expect(card.body.data.status).toBe('matches');
  });

  it('refuses a stale proposal without calling Core', async () => {
    coreApiClient.getDedicationStatuses.mockResolvedValue(pinsAt(98304));
    const response = await http.request.post(`${base}/gemma4%3A12b/decision`).send(apply);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PROPOSAL_STALE');
    expect(coreApiClient.coreRequest).not.toHaveBeenCalled();
  });

  it('refuses a decision for a model that is not pinned', async () => {
    const response = await http.request.post(`${base}/qwen3%3A8b/decision`).send(apply);
    expect(response.status).toBe(409);
    expect(response.body.proposal.status).toBe('not_pinned');
    expect(coreApiClient.coreRequest).not.toHaveBeenCalled();
  });

  it('shows no proposals when Core pins are unreadable', async () => {
    coreApiClient.getDedicationStatuses.mockRejectedValue(new Error('Core offline'));
    const response = await http.request.get(`${base}?hostId=gpu`);
    expect(response.body.data).toEqual({ hostId: 'gpu', pinsReadable: false, proposals: [] });
  });

  it('validates the host and decision', async () => {
    expect((await http.request.get(`${base}?hostId=`)).status).toBe(400);
    expect((await http.request.post(`${base}/gemma4%3A12b/decision`).send({ ...apply, decision: 'maybe' })).status).toBe(400);
  });
});
