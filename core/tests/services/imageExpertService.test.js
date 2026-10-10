'use strict';
const { randomUUID } = require('node:crypto');
const Conversation = require('../../models/Conversation');
const { createService } = require('../../src/services/images/expertService');
const { invoke } = require('../../src/services/images/expertGateway');
const context = { prompt: 'A lake', profile: 'quick', width: 1024, height: 1024, referenceCount: 1 };
const proposal = { prompt: 'A lake at dawn', profile: 'quick', width: 1024, height: 1024, reason: 'Le même sujet, une lumière précise.' };
const imageService = { status: () => ({ configured: true, profiles: [{ id: 'quick', maxPixels: 1048576 }] }), accept: jest.fn() };
const workshop = { overview: async () => ({ worker: { address: 'private-host' }, profiles: [{ id: 'quick', maxPixels: 1048576 }] }) };
const wait = async (service, sessionId) => {
  for (let i = 0; i < 100; i++) {
    const turns = await service.turns(sessionId);
    if (!turns.some(turn => ['accepted', 'running'].includes(turn.state))) return turns;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Consultation did not settle');
};
beforeEach(async () => { await Conversation.deleteMany({}); imageService.accept.mockClear(); });

test('Hermes proposal and events are canonical, replayable, scoped and advisory', async () => {
  const bridge = { configured: () => true, invoke: jest.fn(async (input, options) => {
    expect(JSON.stringify(input)).not.toContain('private-host');
    await options.onEvent({ type: 'tool_use', name: 'skill_view', output: 'excluded' });
    return { ok: true, expert: 'hermes', text: JSON.stringify(proposal), proposal, model: 'configured-model', tokens: { total: 20 } };
  }) };
  const service = createService({ bridge, workshop, imageService }), session = await service.createSession();
  const input = { clientTurnId: randomUUID(), mode: 'plan', message: 'Affine mon brief', context, references: ['must-not-leave'] };
  await service.accept(session.sessionId, input);
  const [turn] = await wait(service, session.sessionId);
  expect(turn).toMatchObject({ state: 'completed', proposal, context });
  expect(turn.events[1]).toMatchObject({ type: 'tool_use', name: 'skill_view' });
  expect(JSON.stringify(turn.events)).not.toContain('excluded');
  expect(JSON.stringify(bridge.invoke.mock.calls[0][0])).not.toContain('must-not-leave');
  expect(imageService.accept).not.toHaveBeenCalled();
  expect((await Conversation.findOne({ 'surfaceSession.sessionId': session.sessionId })).surface).toBe('image-workshop');
  await service.accept(session.sessionId, input); expect(bridge.invoke).toHaveBeenCalledTimes(1);
  await expect(service.accept(session.sessionId, { ...input, message: 'Changed' })).rejects.toMatchObject({ statusCode: 409 });
  const other = await service.createSession(); expect(await service.turns(other.sessionId)).toEqual([]);
  const reloaded = createService({ bridge, workshop, imageService });
  expect((await reloaded.turns(session.sessionId))[0].proposal).toEqual(proposal);
  const provenance = require('../../src/services/images/expertProvenance');
  const reference = { sessionId: session.sessionId, turnId: input.clientTurnId };
  expect(await provenance.resolve(reference, { ...context, prompt: proposal.prompt }, 'quick')).toMatchObject({ harness: 'hermes', promptEdited: false, settingsEdited: false });
  expect(await provenance.resolve(reference, { ...context, prompt: 'An edited lake' }, 'quick')).toMatchObject({ promptEdited: true });
  await expect(provenance.resolve({ ...reference, sessionId: other.sessionId }, context, 'quick')).rejects.toMatchObject({ statusCode: 409 });
  expect(() => provenance.validate({ ...reference, harness: 'fake' })).toThrow();
  bridge.invoke.mockImplementationOnce(async () => ({ ok: true, expert: 'hermes', text: 'Nous avions proposé un lac à l’aube.' }));
  await service.accept(session.sessionId, { ...input, clientTurnId: randomUUID(), mode: 'consult', message: 'Quel était notre brief ?', context: { ...context, prompt: '' } });
  await wait(service, session.sessionId);
  expect(bridge.invoke.mock.calls[1][0].history[0].content).toContain(context.prompt);
  expect(bridge.invoke.mock.calls[1][0].history[1].content).toContain(proposal.prompt);
});

test('provider failure stays visible, restart does not repeat inference, and only successful history is sent', async () => {
  const bridge = { configured: () => true, invoke: jest.fn().mockRejectedValueOnce(new Error('Provider unavailable'))
    .mockResolvedValue({ ok: true, expert: 'hermes', text: 'Conseil utile' }) };
  const service = createService({ bridge, workshop, imageService }), session = await service.createSession();
  const input = { clientTurnId: randomUUID(), mode: 'consult', message: 'Question', context };
  await service.accept(session.sessionId, input);
  expect((await wait(service, session.sessionId))[0]).toMatchObject({ state: 'failed', error: 'Provider unavailable' });
  await service.accept(session.sessionId, { ...input, clientTurnId: randomUUID() });
  await wait(service, session.sessionId);
  expect(bridge.invoke.mock.calls[1][0].history).toEqual([]);
  const row = await Conversation.findOne({ 'surfaceSession.sessionId': session.sessionId });
  row.messages.find(message => message.turn).turn.outcome = 'running'; await row.save();
  const restarted = createService({ bridge, workshop, imageService });
  expect((await restarted.turns(session.sessionId))[0].state).toBe('interrupted');
  expect(bridge.invoke).toHaveBeenCalledTimes(2);
});

test('a long brief and 32000-unit message survive the real Core store, restart, provenance and replay intact', async () => {
  const constraints = require('../../public/js/image-brief-constraints');
  const manifest = { version: 1, items: [{ id: 'fixture-title', kind: 'exact-text', text: 'École & façade 💡' }] };
  const original = ' \n' + 'Synthetic visual description. '.repeat(350) + 'BRIEF_TERMINAL_SENTINEL \n';
  const prefix = ' \n', tail = 'MESSAGE_TERMINAL_SENTINEL \n';
  const message = prefix + 'm'.repeat(32000 - prefix.length - tail.length) + tail;
  const bridge = { configured: () => true, invoke: jest.fn(async () => ({ proposal, text: proposal.reason, model: 'fixture' })) };
  const service = createService({ bridge, workshop, imageService }), session = await service.createSession();
  const input = { clientTurnId: randomUUID(), mode: 'plan', message, context: { ...context, prompt: original, constraints: manifest } };
  await service.accept(session.sessionId, input);
  const [turn] = await wait(service, session.sessionId);
  expect(turn.state).toBe('completed'); expect(turn.input).toBe(message); expect(turn.context.prompt).toBe(original);
  expect(turn.proposal.constraints).toEqual(manifest);
  expect(turn.proposal.prompt).toBe(constraints.compose(proposal.prompt, manifest));
  expect(bridge.invoke.mock.calls[0][0].request.prompt).toBe(constraints.composeBrief(original, manifest));
  expect(bridge.invoke.mock.calls[0][0].request.instruction).toBe(message);
  const row = await Conversation.findOne({ 'surfaceSession.sessionId': session.sessionId }).lean();
  expect(row.messages[0].content).toBe(message); expect(row.messages[1].turn.toolEvidence.imagex.context.prompt).toBe(original);
  const reloaded = createService({ bridge, workshop, imageService });
  expect((await reloaded.turns(session.sessionId))[0]).toMatchObject({ input: message, context: { prompt: original }, proposal: turn.proposal });
  expect(await reloaded.accept(session.sessionId, input)).toMatchObject({ id: turn.id, state: 'completed' });
  expect(bridge.invoke).toHaveBeenCalledTimes(1); expect(row.surfaceSession.turnCount).toBe(1);
  const reference = { sessionId: session.sessionId, turnId: input.clientTurnId };
  expect(await require('../../src/services/images/expertProvenance').resolve(reference, { ...context, prompt: turn.proposal.prompt }, 'quick'))
    .toMatchObject({ harness: 'hermes', promptEdited: false, settingsEdited: false });
  expect(imageService.accept).not.toHaveBeenCalled();
});

test('gateway keeps its token server-side and decodes split UTF-8 events without following redirects', async () => {
  const response = new TextEncoder().encode(JSON.stringify({ type: 'result', result: { ok: true, expert: 'hermes', text: 'Été' } }) + '\n');
  const fetchImpl = jest.fn(async () => ({ ok: true, body: (async function* () { for (const byte of response) yield new Uint8Array([byte]); })() }));
  const result = await invoke({ action: 'describe' }, { env: { OPENCLAW_GATEWAY_URL: 'http://127.0.0.1:1234', OPENCLAW_GATEWAY_TOKEN: 'private' }, fetchImpl });
  expect(result.text).toBe('Été'); expect(fetchImpl.mock.calls[0][1].redirect).toBe('error');
  expect(JSON.stringify(result)).not.toContain('private');
});
