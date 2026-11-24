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
const createFamilyAmbient = jest.spyOn(require('../../surfaces/household/family-ambient'), 'createFamilyAmbient');
const { app } = require('../../src/app');
const { fetchData } = require('../../src/services/dataServiceClient');
const { executeForTest } = require('../../src/extensions/trustedRuntimeServices');

const base = '/api/voice-personas/family/sessions';
let fetchedAt, observedAt;

beforeAll(() => {
  fetchedAt = new Date().toISOString();
  observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fetchData.mockImplementation(async path => {
    if (path !== '/api/v1/livedata/ec-weather') throw new Error('No synthetic data for this path');
    return { response: { ok: true }, body: { status: 'success', data: {
      fetchedAt, current: { observedAt, temperatureC: 14 }
    } } };
  });
});

function weatherClarification(prompt) {
  return prompt.split('\n').find(line => /weather|météo/i.test(line) && /clarif|rephras|reformul/i.test(line));
}

async function startSession() {
  const created = await request(app).post(base)
    .send({ packId: 'kidx_nestor', modeId: 'family', scopeId: 'family', backend: 'agentx' }).expect(201);
  return created.body.data.session.sessionId;
}

async function voiceTurn(sessionId, text) {
  const before = executeForTest.mock.calls.length;
  await request(app).post(`${base}/${sessionId}/turns/text`)
    .send({ text, channel: 'voice', stream: true }).expect(200);
  expect(executeForTest.mock.calls).toHaveLength(before + 1);
  return executeForTest.mock.calls.at(-1)[0].messages.at(-1).content;
}

test('the Family voice session supplies a dated observation when the speaker asks or asks again politely', async () => {
  const sessionId = await startSession();
  for (const text of ['Quelle météo il fait DEHORS ?', 'Quelle météo fait-il dehors ?',
    'Quelle est la météo, s’il te plaît ?', 'Peux-tu me redire la météo, s’il te plaît ?']) {
    const prompt = await voiceTurn(sessionId, text);
    expect(prompt).toContain('"temperatureC":14');
    expect(prompt).toContain('lead with the temperature and conditions');
    expect(prompt).not.toContain('start the spoken reply with');
    expect(prompt).toContain(`"observedAt":"${observedAt}"`);
    expect(prompt).toContain(`"fetchedAt":"${fetchedAt}"`);
  }
  expect(fetchData.mock.calls.filter(([path]) => path === '/api/v1/livedata/ec-weather')).toHaveLength(1);
});

test('the observation time stays available in a spoken follow-up from the same Family session', async () => {
  const sessionId = await startSession();
  for (const text of ['À quelle heure ?', 'À quelle heure a été pris le relevé ?', 'De quand date le relevé météo ?']) {
    await voiceTurn(sessionId, 'La météo, s’il te plaît.');
    const prompt = await voiceTurn(sessionId, text);
    expect(prompt).toContain(`"observedAt":"${observedAt}"`);
    expect(prompt).toContain(`"fetchedAt":"${fetchedAt}"`);
    expect(prompt).not.toContain('"temperatureC":14');
    expect(prompt).toMatch(/"observedAtLocal":"\d{4}-\d{2}-\d{2} \d{2}:\d{2}"/);
  }
  await voiceTurn(sessionId, 'Parle-moi du relevé bancaire.');
  expect(await voiceTurn(sessionId, 'De quand date le relevé ?')).not.toContain('"temperatureC":14');
});

test('an ambiguous spoken weather fragment gets clarification guidance without an observation or a source failure', async () => {
  const sessionId = await startSession();
  await voiceTurn(sessionId, 'Quelle est la météo ?');
  await voiceTurn(sessionId, 'Raconte-moi une petite histoire.');
  const ambient = createFamilyAmbient.mock.results.at(-1).value;
  const weather = jest.spyOn(ambient, 'weather').mockClear();
  const forecast = jest.spyOn(ambient, 'forecastTomorrow').mockClear();
  const prompt = await voiceTurn(sessionId, 'Euh, c’est un peu jeudi dans la météo, s’il te plaît.');
  expect(weather).not.toHaveBeenCalled();
  expect(forecast).not.toHaveBeenCalled();
  expect(prompt).not.toMatch(/"temperatureC":14|current conditions are unavailable or outdated|no verified daytime forecast coverage/);
  expect(weatherClarification(prompt) || '').toMatch(/ask|question|demande/i);
});

test('weather mentions and clear requests outside local current coverage keep their meaning', async () => {
  const sessionId = await startSession();
  const ambient = createFamilyAmbient.mock.results.at(-1).value;
  const weather = jest.spyOn(ambient, 'weather').mockClear();
  const forecast = jest.spyOn(ambient, 'forecastTomorrow').mockClear();
  for (const text of ['Raconte-moi une histoire sur la météo.', 'Je ne veux pas la météo, merci.',
    'Quelle météo fait-il à Toulouse ?', 'Quelle sera la météo jeudi ?']) {
    const prompt = await voiceTurn(sessionId, text);
    expect(prompt).not.toMatch(/"temperatureC":14|current conditions are unavailable or outdated|no verified daytime forecast coverage/);
    const guidance = weatherClarification(prompt);
    if (guidance) expect(guidance).toMatch(/(?:if|when|si)\b[^.!?]*(?:unclear|ambiguous|ambigu|incertain)/i);
    expect(weather).not.toHaveBeenCalled();
    expect(forecast).not.toHaveBeenCalled();
  }
  const tomorrow = await voiceTurn(sessionId, 'Peux-tu me dire la météo de demain, s’il te plaît ?');
  expect(forecast).toHaveBeenCalledTimes(1);
  expect(weather).not.toHaveBeenCalled();
  expect(tomorrow).toContain('no verified daytime forecast coverage');
});
