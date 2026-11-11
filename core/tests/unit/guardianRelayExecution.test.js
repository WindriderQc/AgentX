'use strict';
const { runLocalConversation } = require('../../surfaces/household/conversation-inference');
const { guardianReadTools } = require('../../surfaces/household/guardian-read-tools');
const { createConversationContinuity } = require('../../src/services/routing/conversationContinuity');
const packs = require('../../surfaces/household/packs');
function fixture({ hermes = false, iss = false, failure = null } = {}) {
  const pack = packs.packById(hermes ? 'personal_operator' : 'kidx_nestor');
  let busy = true;
  const execute = jest.fn(async (body, options) => {
    if (body.model === 'synthetic-main') throw Object.assign(Error('busy'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED',
      failure: failure || { safeToRetry: true, cause: 'inference_active', holder: { type: 'inference' } } });
    const final = body.messages.some(message => message.role === 'tool');
    return { ok: true, body: { message: { content: final ? 'Le résultat est 13.' : '', ...(!final && { tool_calls: [
      { function: iss ? { name: 'iss_passes', arguments: { hours: 24, visible_only: true, max_passes: 1 } } : { name: 'math', arguments: { operation: 'add', a: 8, b: 5 } } }
    ] }) } }, metadata: { model: body.model, conversationContinuity: options.conversationContinuity } };
  });
  const continuation = createConversationContinuity({ execute, readPolicy: () => '{"hosts":["guardian"]}',
    readSnapshot: async () => ({ hosts: { guardian: 'http://127.0.0.2:11434' }, tasks: {
      daily_operator: { model: 'synthetic-main', hostUrl: 'http://127.0.0.1:11434', pinAligned: true, contextSize: 8192 },
      voice_persona_chat: { model: 'synthetic-main', hostUrl: 'http://127.0.0.1:11434', pinAligned: true, contextSize: 8192 }
    } }), observeFamilyOccupation: async () => busy,
    deps: { hostPreferenceService: { getByHost: async () => ({ pinnedModels: [{ model: 'synthetic-guardian', contextSize: 8192 }] }) },
      assertHostAvailableForConsumer: async () => {}, modelsMatch: (a, b) => a === b,
      fetch: async () => ({ ok: true, json: async () => ({ models: [{ name: 'synthetic-guardian', context_length: 8192 }] }) }) }, log: { warn() {} } });
  const request = { backend: hermes ? 'hermes' : 'agentx', session: { packId: pack.id, modeId: pack.defaultMode, persona: { name: 'Nestor' } },
    pack, text: 'Explique avec un calcul.', channel: 'voice', streaming: false, agentxInstructions: 'Original main instructions',
    guardianTools: guardianReadTools({ HOUSEHOLD_GUARDIAN_TOOLS: iss ? 'iss_passes,weather,math' : 'weather,math' }, {
      readIss: args => require('../../src/services/mcpIssTools').issPasses(args, { now: () => new Date('2026-10-24T22:30:00Z'),
        fetchData: async path => path.endsWith('/tle') ? { response: { ok: false, status: 404 } } : { response: { ok: true, status: 200 }, body: { status: 'success', data: path.includes('satellites')
          ? [{ ts: '2026-10-24T17:03:41.618Z', payload: { noradId: '25544', tle1: '1 25544U 98067A   26297.20915682  .00007800  00000+0  14938-3 0  9991', tle2: '2 25544  51.6335  21.6229 0006884 302.9098  57.1228 15.49030149591752' } }]
          : [{ timeStamp: '2026-10-24T22:18:41.733Z', lat: 30, lon: 0 }] } } }) }),
    ...(hermes && { relayOccupation: async () => ({ authority: 'hermes', state: busy ? 'running' : 'completed', runId: 'original', sessionKey: 'original-session' }) }) };
  return { execute, request, run: () => runLocalConversation({ request, prepared: [{ role: 'user', content: request.text }],
    inference: { conversation: continuation, execute }, consumerContract: {}, env: { HOUSEHOLD_CONVERSATION_RELAY_ENABLED: 'true' } }),
    clear: () => { busy = false; } };
}
test.each([false, true])('actual relay dispatch executes bounded tools on the same host, no primary replay (Hermes=%s)', async hermes => {
  const w = fixture({ hermes }); const result = await w.run();
  expect(result.text).toContain('Le résultat est 13.');
  expect(result.tools).toMatchObject({ status: 'observed', authority: 'agentx/core', receipts: [expect.objectContaining({ tool: 'math', status: 'completed' })],
    conversationRelay: { role: 'relay', completed: true } });
  expect(w.execute.mock.calls.map(([body]) => body.model)).toEqual(hermes
    ? ['synthetic-guardian', 'synthetic-guardian'] : ['synthetic-main', 'synthetic-guardian', 'synthetic-guardian']);
  expect(w.execute.mock.calls.at(-1)[1]).toMatchObject({ hostUrl: 'http://127.0.0.2:11434', retry: { enabled: false } });
});
test('occupation ending after the first model reply stops before any read or additional model request', async () => {
  const w = fixture(); const execute = w.request.guardianTools.execute;
  w.request.guardianTools.execute = jest.fn(execute);
  const native = w.execute.getMockImplementation();
  w.execute.mockImplementation(async (...args) => { const result = await native(...args); w.clear(); return result; });
  await expect(w.run()).rejects.toMatchObject({ code: 'RELAY_OCCUPATION_CHANGED' });
  expect(w.request.guardianTools.execute).not.toHaveBeenCalled();
  expect(w.execute).toHaveBeenCalledTimes(2);
});

test('an unavailable Family principal permits the same read-only guardian to finish without claiming occupation', async () => {
  const w = fixture({ failure: { safeToRetry: true, cause: 'admission_conflict_unclassified', holder: null } });
  w.clear();
  const result = await w.run();
  expect(result.text).toContain('Le résultat est 13.');
  expect(result.text).toContain('indisponible');
  expect(result.text).not.toContain('occupé');
  expect(result.tools).toMatchObject({ status: 'observed', receipts: [expect.objectContaining({ tool: 'math', status: 'completed' })] });
  expect(w.execute.mock.calls.map(([body]) => body.model)).toEqual(['synthetic-main', 'synthetic-guardian', 'synthetic-guardian']);
});

test('Family receives a real canonical ISS computation within its unchanged relay budget, with no observer coordinates', async () => {
  const w = fixture({ iss: true }); const result = await w.run();
  expect(result.tools.receipts).toEqual([expect.objectContaining({ tool: 'iss_passes', status: 'completed' })]);
  const content = w.execute.mock.calls.at(-1)[0].messages.find(message => message.role === 'tool').content;
  expect(JSON.parse(content)).toMatchObject({ status: 'ok', visiblePassesComplete: true });
  expect(content).not.toContain('observer=v1:');
});


test('Hermes with no principal toolset can recover a native tool refusal only on the same verified guardian', async () => {
  const w = fixture({ hermes: true });
  expect(w.request.familyTools).toBeUndefined();
  w.execute.mockImplementation(async (body, options) => body.tools?.length
    ? { ok: false, body: { error: 'does not support tools' }, metadata: { model: body.model, conversationContinuity: options.conversationContinuity } }
    : { ok: true, body: { message: { content: 'Réponse du même gardien sans outils.' } }, metadata: { model: body.model, conversationContinuity: options.conversationContinuity } });
  const read = w.request.guardianTools.execute = jest.fn();
  const result = await w.run();
  expect(result.text).toContain('Réponse du même gardien sans outils.');
  expect(result.text).toContain('assure temporairement le relais');
  expect(result.text).toContain('sans outils');
  expect(w.execute.mock.calls.map(([body]) => body.model)).toEqual(['synthetic-guardian', 'synthetic-guardian']);
  expect(w.execute.mock.calls.map(([, options]) => options.hostUrl)).toEqual(['http://127.0.0.2:11434', 'http://127.0.0.2:11434']);
  expect(w.execute.mock.calls[1][0].tools).toBeUndefined();
  expect(w.execute.mock.calls[1][0].messages[0].content).toContain('No tools are available for this answer');
  expect(w.execute.mock.calls[1][0].options.num_ctx).toBe(8192);
  expect(result.tools).toMatchObject({ status: 'not_supported', receipts: [], conversationRelay: { role: 'relay', completed: true } });
  expect(read).not.toHaveBeenCalled();
});

test('a tool refusal never retries after original Hermes occupation ends', async () => {
  const w = fixture({ hermes: true });
  w.execute.mockImplementation(async body => {
    w.clear(); return { ok: false, body: { error: 'does not support tools' }, metadata: { model: body.model } };
  });
  await expect(w.run()).rejects.toMatchObject({ code: 'RELAY_OCCUPATION_CHANGED' });
  expect(w.execute).toHaveBeenCalledTimes(1);
});
