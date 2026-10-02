'use strict';

jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const snapshot = { generatedAt: new Date().toISOString(), tasks: { daily_operator: {
    taskType: 'daily_operator', model: 'synthetic-model', contextSize: 8192,
    hostUrl: 'http://synthetic.invalid:11434', inferenceContract: { qualification: { qualified: true } }
  } } };
  const execute = jest.fn(async input => ({
    ok: true, status: 200, metadata: { model: input.model, upstreamProtocol: 'ollama' },
    ...(input.stream ? { stream: require('node:stream').Readable.from([
      JSON.stringify({ model: input.model, message: { role: 'assistant', content: 'Synthetic reply' }, done: false }) + '\n',
      JSON.stringify({ model: input.model, message: { role: 'assistant', content: '' }, done: true }) + '\n'
    ]), completion: Promise.resolve({ completed: true, terminalComplete: true }) }
      : { body: { model: input.model, message: { role: 'assistant', content: 'Synthetic reply' }, done: true } })
  }));
  return { ...actual, executeForTest: execute,
    createTrustedRuntimeServices: () => ({ ...actual.createTrustedRuntimeServices(),
      inference: { execute }, routing: { getEffectiveSnapshot: async () => snapshot } }) };
});

process.env.AGENTX_RUNTIME_BRIDGES_ENABLED = 'true';
process.env.AGENTX_PRINTER_VISION_ENABLED = 'true';
const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');
const messages = [{ role: 'user', content: 'Synthetic request' }];

describe('optional integrations registered in canonical Core', () => {
  beforeEach(() => executeForTest.mockClear());

  test('OpenClaw and Hermes call the same admitted runtime and reject mismatched routing before execution', async () => {
    expect((await request(app).get('/api/runtime-bridges/status').expect(200)).body.data.coreRuntimeContract).toBe(1);
    await request(app).post('/api/openclaw-ollama/api/chat').send({ model: 'unknown', messages }).expect(409);
    await request(app).post('/api/openclaw-ollama/api/chat').send({ model: 'synthetic-model', messages, options: { num_ctx: 4096 } }).expect(409);
    expect(executeForTest).not.toHaveBeenCalled();
    const openclaw = await request(app).post('/api/openclaw-ollama/api/chat').send({ model: 'synthetic-model', messages, stream: true }).expect(200);
    expect(openclaw.text).toContain('Synthetic reply');
    expect(JSON.parse(openclaw.text.trim().split('\n').at(-1)).done).toBe(true);
    expect(executeForTest.mock.calls.at(-1)[1].consumerContract).toBe('openclaw-runtime-v1');
    const hermes = await request(app).post('/api/hermes-openai/v1/chat/completions').send({ model: 'synthetic-model', messages, stream: true }).expect(200);
    expect(hermes.text).toContain('Synthetic reply');
    expect(hermes.text).toContain('data: [DONE]');
    expect(executeForTest.mock.calls.at(-1)[1].consumerContract).toBe('hermes-runtime-v1');
    await request(app).post('/api/openclaw-ollama/api/pull').send({ model: 'unknown' }).expect(404);
    expect(executeForTest).toHaveBeenCalledTimes(2);
  });

  test('Household and the runtime bridges exchange hooks under the same app.locals names', async () => {
    expect(typeof app.locals.aioOpsConversationTarget).toBe('function');
    await expect(app.locals.aioOpsConversationTarget('synthetic-model')).resolves.toBeNull();
    expect(app.locals.aioOpsRuntimeEvidence.contractVersion).toBe(1);
  });

  test('host reservation refusal remains a conflict and never looks like a successful turn', async () => {
    executeForTest.mockRejectedValueOnce(Object.assign(new Error('Synthetic reserved host'), { code: 'BENCHMARK_CLAIM_ACTIVE', statusCode: 503 }));
    const response = await request(app).post('/api/openclaw-ollama/api/chat').send({ model: 'synthetic-model', messages }).expect(409);
    expect(response.body.code).toBe('BENCHMARK_CLAIM_ACTIVE');
  });

  test('printer evidence uses Core Mongo, keeps images out of status JSON and rejects malformed maps without writing', async () => {
    const now = new Date().toISOString();
    const payload = { printerId: 'synthetic-printer', firstAnalysisAt: now, lastAnalysisAt: now,
      status: 'WATCH', confidence: 'LOW', intervalSeconds: 30, model: 'synthetic-model',
      observations: 'Synthetic observation', imageBase64: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64') };
    const saved = await request(app).post('/api/printer-vision/status').send(payload).expect(201);
    expect(saved.body.data.printer.controlMode).toBe('ALERT ONLY');
    expect(saved.body.data.printer.imageBase64).toBeUndefined();
    expect(await mongoose.connection.db.collection('printervisionstatuses').countDocuments({ printerId: payload.printerId })).toBe(1);
    const image = await request(app).get(saved.body.data.printer.imageUrl).expect(200);
    expect(image.body).toEqual(Buffer.from(payload.imageBase64, 'base64'));
    await request(app).post('/api/printer-vision/status').send({ ...payload, firstAnalysisAt: null }).expect(400);
    await request(app).post('/api/printer-vision/bed-maps/synthetic-printer').send({ points: Array(9).fill(null) }).expect(400);
    const points = ['back-left', 'back-center', 'back-right', 'center-left', 'center', 'center-right', 'front-left', 'front-center', 'front-right'].map((id, i) => ({ id, x: i, y: i, z: 0 }));
    await request(app).post('/api/printer-vision/bed-maps/synthetic-printer').send({ points }).expect(201);
    expect((await request(app).get('/api/printer-vision/bed-maps/synthetic-printer').expect(200)).body.data.maps).toHaveLength(1);
    expect((await request(app).get('/api/printer-vision/bed-maps/other-printer').expect(200)).body.data.maps).toHaveLength(0);
    await request(app).get('/api/printer-vision/status/other-printer').expect(404);
  });
});
