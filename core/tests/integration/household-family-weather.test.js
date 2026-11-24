'use strict';

jest.mock('../../src/services/dataServiceClient', () => ({
  ...jest.requireActual('../../src/services/dataServiceClient'),
  fetchData: jest.fn()
}));
jest.mock('../../src/extensions/trustedRuntimeServices', () => {
  const actual = jest.requireActual('../../src/extensions/trustedRuntimeServices');
  const execute = jest.fn(async () => ({ ok: true, body: { response: 'Réponse synthétique.' } }));
  return { ...actual, executeForTest: execute,
    createTrustedRuntimeServices: (...args) => ({ ...actual.createTrustedRuntimeServices(...args), inference: { execute } }) };
});

const request = require('supertest');
const { app } = require('../../src/app');
const { fetchData } = require('../../src/services/dataServiceClient');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');

test('the Family voice session supplies the dated observation for both French weather question orders', async () => {
  const fetchedAt = new Date().toISOString();
  const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fetchData.mockImplementation(async path => {
    if (path !== '/api/v1/livedata/ec-weather') throw new Error('No synthetic data for this path');
    return { response: { ok: true }, body: { status: 'success', data: {
      fetchedAt, current: { observedAt, temperatureC: 14 }
    } } };
  });
  const base = '/api/voice-personas/family/sessions';
  const created = await request(app).post(base)
    .send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201);
  for (const text of ['Quelle météo il fait DEHORS ?', 'Quelle météo fait-il dehors ?']) {
    const before = executeForTest.mock.calls.length;
    await request(app).post(`${base}/${created.body.data.session.sessionId}/turns/text`)
      .send({ text, channel: 'voice', stream: true }).expect(200);
    expect(executeForTest.mock.calls.length).toBe(before + 1);
    const prompt = executeForTest.mock.calls.at(-1)[0].messages.at(-1).content;
    expect(prompt).toContain('"temperatureC":14');
    expect(prompt).toContain(`"observedAt":"${observedAt}"`);
    expect(prompt).toContain(`"fetchedAt":"${fetchedAt}"`);
  }
  expect(fetchData.mock.calls.filter(([path]) => path === '/api/v1/livedata/ec-weather')).toHaveLength(1);
});
