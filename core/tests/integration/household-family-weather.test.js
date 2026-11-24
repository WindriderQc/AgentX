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
      fetchedAt, current: { observedAt, temperatureC: 14, condition: 'Nuageux' }
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

test.each(['false', 'true'])('the local Family route answers covered weather requests with native source filtering %s', async nativeFilter => {
  const grants = ['iss_passes', 'web_search', 'network_devices'];
  const previous = process.env.HOUSEHOLD_FAMILY_TOOLS;
  const previousFilter = process.env.HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY;
  process.env.HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY = nativeFilter;
  process.env.HOUSEHOLD_FAMILY_TOOLS = grants.join(',');
  try {
    const sessionId = await startSession();
    for (const text of ['Quelle météo fait-il dehors ?', 'Peux-tu me redire la météo, s’il te plaît ?']) {
      executeForTest.mockResolvedValueOnce({ ok: true, body: { message: { content: 'Il fait 14 degrés et le ciel est nuageux.' } } });
      const before = executeForTest.mock.calls.length;
      const response = await request(app).post(`${base}/${sessionId}/turns/text`).send({ text, channel: 'voice', stream: true }).expect(200);
      const events = response.text.trim().split('\n').map(line => JSON.parse(line));
      expect(events.find(row => row.type === 'done').data.reply.text).toContain('14 degrés');
      expect(executeForTest.mock.calls).toHaveLength(before + 1);
      const body = executeForTest.mock.calls.at(-1)[0];
      expect(body.tools.map(tool => tool.function.name).sort()).toEqual(['iss_passes', 'network_devices']);
      expect(body.messages[0].content).not.toMatch(/use web_search/i);
      expect(body.messages.at(-1).content).toContain('"temperatureC":14');
      expect(body.messages.at(-1).content).toContain('Answer this request directly');
    }
    const ambient = createFamilyAmbient.mock.results.at(-1).value;
    for (const reading of [null, { observedAt, fetchedAt, temperatureC: 14 },
      { observedAt: new Date(Date.now() - 4 * 3600000).toISOString(), fetchedAt, temperatureC: 14, condition: 'Nuageux' }]) {
      jest.spyOn(ambient, 'weather').mockResolvedValueOnce(reading);
      await voiceTurn(sessionId, 'Quelle météo fait-il dehors ?');
      expect(executeForTest.mock.calls.at(-1)[0].tools.map(tool => tool.function.name).sort()).toEqual([...grants].sort());
    }
    for (const text of ['Cherche la météo sur le web.', 'Quelle météo fait-il à Lyon ?', 'Quelle est la météo demain ?',
      'Donne-moi la météo et le prochain passage de la station spatiale.']) {
      await voiceTurn(sessionId, text);
      expect(executeForTest.mock.calls.at(-1)[0].tools.map(tool => tool.function.name).sort()).toEqual([...grants].sort());
    }
  } finally {
    if (previousFilter === undefined) delete process.env.HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY;
    else process.env.HOUSEHOLD_NATIVE_EXPLICIT_INPUT_ONLY = previousFilter;
    if (previous === undefined) delete process.env.HOUSEHOLD_FAMILY_TOOLS;
    else process.env.HOUSEHOLD_FAMILY_TOOLS = previous;
  }
});

test('a covered voice turn speaks the source when all model content is on screen, and the next answer keeps its own voice', async () => {
  const sessionId = await startSession();
  const weather = { fetchedAt, observedAt, temperatureC: -1.4, condition: 'Nuageux' };
  const ambient = createFamilyAmbient.mock.results.at(-1).value;
  const first = '<show kind="text" title="Conditions locales">Informations de la station.</show>';
  const second = 'Il fait moins 1,4 degré Celsius et le ciel est nuageux. Mets ton manteau !';
  for (const [index, content] of [first, second, 'Je ne peux pas consulter la météo en ce moment.', ''].entries()) {
    jest.spyOn(ambient, 'weather').mockResolvedValueOnce(weather);
    const stream = (async function* () {
      for (const part of [content.slice(0, 12), content.slice(12)]) yield JSON.stringify({ message: { content: part }, done: false }) + '\n';
      yield '{"done":true}\n';
    })();
    executeForTest.mockResolvedValueOnce({ ok: true, stream, completion: Promise.resolve({}), metadata: {} });
    const response = await request(app).post(`${base}/${sessionId}/turns/text`)
      .send({ text: index ? 'Peux-tu me redire la météo, s’il te plaît ?' : 'Quelle météo fait-il dehors ?', channel: 'voice', stream: true }).expect(200);
    const events = response.text.trim().split('\n').map(line => JSON.parse(line));
    const done = events.find(row => row.type === 'done').data;
    const spoken = events.filter(row => row.type === 'delta').map(row => row.delta);
    expect(spoken.join('').trim()).toBe(done.reply.text);
    expect(events.findIndex(row => row.type === 'delta')).toBeLessThan(events.findIndex(row => row.type === 'say_end'));
    if (index === 1) expect(done.reply.text).toBe(second);
    else {
      expect(spoken).toHaveLength(1);
      expect(done.reply.text).toMatch(/moins 1,4 degré/i);
      expect(done.reply.text).toMatch(/nuageux/i);
      expect(done.reply.text).not.toMatch(/écran|impossible|ne peux/i);
    }
    if (index === 0) {
      expect(done.display).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Conditions locales' })]));
      expect(done.written.segments).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'display' })]));
    }
  }
});
