'use strict';
const { randomUUID } = require('node:crypto');
const { createService } = require('../../src/services/images/expertService');
const constraints = require('../../public/js/image-brief-constraints');

const protectedItems = () => ({ version: 1, items: [{ id: 'title-fixture', kind: 'exact-text', text: 'École — façade' }] });
const context = () => ({ prompt: 'A scene', profile: 'quick', width: 1024, height: 1024, referenceCount: 0, constraints: protectedItems() });
const proposal = { prompt: 'A scene at dawn', profile: 'quick', width: 1024, height: 1024, reason: 'A new light.' };
function fixture(result = proposal) {
  const sessions = new Map(), rows = new Map();
  const conversations = {
    createSession: async input => { sessions.set(input.sessionId, input); return input; },
    getSession: async scope => sessions.get(scope.sessionId),
    getTurn: async scope => rows.get(scope.traceId),
    listTurns: async scope => [...rows.values()].filter(row => row.sessionId === scope.sessionId).reverse(),
    recordTurn: jest.fn(async input => { rows.set(input.traceId, input); return input; }),
    updateTurn: async (scope, change) => { Object.assign(rows.get(scope.traceId), change.$set); }
  };
  const bridge = { configured: () => true, invoke: jest.fn(async () => ({ proposal: result, model: 'fixture', text: JSON.stringify(result) })) };
  const service = createService({ conversations, bridge,
    imageService: { status: () => ({ configured: true, profiles: [{ id: 'quick', maxPixels: 1048576 }] }) },
    workshop: { overview: async () => ({ profiles: [{ id: 'quick', maxPixels: 1048576 }] }) }
  });
  async function settle(sessionId) {
    for (let i = 0; i < 40; i++) {
      const turns = await service.turns(sessionId);
      if (!turns.some(turn => ['accepted', 'running'].includes(turn.state))) return turns;
      await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error('Fixture consultation did not finish');
  }
  return { service, bridge, settle, conversations, rows };
}

test('Hermes can rewrite visual description while Core preserves an immutable exact snapshot', async () => {
  const f = fixture(), session = await f.service.createSession();
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() };
  await f.service.accept(session.sessionId, raw);
  raw.context.constraints.items[0].text = 'Modified after acceptance';
  const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('completed');
  expect(turn.proposal.visualPrompt).toBe(proposal.prompt);
  expect(turn.proposal.constraints).toEqual(protectedItems());
  expect(turn.proposal.prompt).toBe(constraints.compose(proposal.prompt, protectedItems()));
  expect(f.bridge.invoke.mock.calls[0][0].request.prompt).toContain('École — façade');
  expect(f.bridge.invoke.mock.calls[0][0].request.constraints).toEqual(protectedItems());
});

test('same request replays and a changed protected item refuses before a second consultation', async () => {
  const f = fixture(), session = await f.service.createSession();
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() };
  await f.service.accept(session.sessionId, raw); await f.settle(session.sessionId);
  await f.service.accept(session.sessionId, raw);
  const changed = context(); changed.constraints.items[0].text = 'Changed title';
  await expect(f.service.accept(session.sessionId, { ...raw, context: changed })).rejects.toMatchObject({ statusCode: 409 });
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
});

test('an oversized proposal fails visibly instead of dropping protected items', async () => {
  const f = fixture({ ...proposal, prompt: 'x'.repeat(8000) }), session = await f.service.createSession();
  await f.service.accept(session.sessionId, { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() });
  const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('failed'); expect(turn.error).toContain('dépassent'); expect(turn.proposal).toBeUndefined();
});

test('old consultations and proposal shape remain compatible without protected items', async () => {
  const f = fixture(), session = await f.service.createSession(), plain = context(); delete plain.constraints;
  await f.service.accept(session.sessionId, { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: plain });
  const [turn] = await f.settle(session.sessionId);
  expect(turn.proposal).toEqual(proposal); expect(turn.context).toEqual(plain);
});

test.each([{ field: 'width', value: 512, label: 'largeur' }, { field: 'height', value: 512, label: 'hauteur' },
  { field: 'profile', value: 'other', label: 'recette' }])('a changed $field fails with a useful diagnosis and preserves the canonical brief', async ({ field, value, label }) => {
  const f = fixture({ ...proposal, [field]: value }), session = await f.service.createSession();
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() };
  await f.service.accept(session.sessionId, raw);
  const [turn] = await f.settle(session.sessionId);
  expect(turn).toMatchObject({ state: 'failed', errorCode: 'IMAGE_EXPERT_SETTINGS_CHANGED', context: raw.context });
  expect(turn.error).toContain(label); expect(turn.error).toContain('1024 × 1024');
  expect(turn.proposal).toBeUndefined();
  await f.service.accept(session.sessionId, raw); expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
});

test('the native bridge width refusal is translated and remains terminal without inference replay', async () => {
  const f = fixture(), session = await f.service.createSession();
  f.bridge.invoke.mockRejectedValue(new Error('Image expert changed the requested width'));
  await f.service.accept(session.sessionId, { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() });
  const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('failed'); expect(turn.errorCode).toBe('IMAGE_EXPERT_SETTINGS_CHANGED');
  expect(turn.error).toContain('Ton brief reste conservé');
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
});

test.each(['plan', 'consult'])('a %s preserves a long original brief, message whitespace and protected intent without repeating replay', async mode => {
  const f = fixture(mode === 'plan' ? proposal : null), session = await f.service.createSession();
  const original = ' \n' + 'Synthetic visual brief. '.repeat(450) + 'TERMINAL_BRIEF_SENTINEL \n';
  const message = ' \n' + 'Synthetic instruction. '.repeat(450) + 'TERMINAL_MESSAGE_SENTINEL \n';
  const raw = { clientTurnId: randomUUID(), mode, message, context: { ...context(), prompt: original } };
  await f.service.accept(session.sessionId, raw);
  const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('completed'); expect(turn.input).toBe(message); expect(turn.context.prompt).toBe(original);
  expect(turn.context.constraints).toEqual(protectedItems());
  const envelope = f.bridge.invoke.mock.calls[0][0];
  if (mode === 'plan') {
    expect(envelope.request.prompt).toBe(constraints.composeBrief(original, protectedItems()));
    expect(envelope.request.instruction).toBe(message);
    expect(turn.proposal.prompt.length).toBeLessThanOrEqual(8000);
  } else {
    expect(envelope.prompt).toBe(message); expect(envelope.context.prompt).toBe(original);
  }
  expect(await f.service.accept(session.sessionId, raw)).toMatchObject({ id: turn.id, state: 'completed' });
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1); expect(f.conversations.recordTurn).toHaveBeenCalledTimes(1);
});

test('context composition and messages enforce the 32000 UTF-16 boundary before recording or invoking', async () => {
  const f = fixture(), session = await f.service.createSession(), protectedContext = context();
  const suffixLength = constraints.block(protectedContext.constraints).length + 2;
  protectedContext.prompt = 'x'.repeat(32000 - suffixLength);
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: protectedContext };
  await f.service.accept(session.sessionId, raw); await f.settle(session.sessionId);
  expect(f.bridge.invoke.mock.calls[0][0].request.prompt).toHaveLength(32000);
  await expect(f.service.accept(session.sessionId, { ...raw, clientTurnId: randomUUID(),
    context: { ...protectedContext, prompt: protectedContext.prompt + 'x' } })).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.service.accept(session.sessionId, { ...raw, clientTurnId: randomUUID(), message: '💡'.repeat(16000) + 'x' }))
    .rejects.toMatchObject({ statusCode: 400 });
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1); expect(f.conversations.recordTurn).toHaveBeenCalledTimes(1);
});

test('an exact 32000-unit emoji message is accepted whole and an invalid Unicode input refuses before recording', async () => {
  const f = fixture(null), session = await f.service.createSession(), message = '💡'.repeat(16000);
  const raw = { clientTurnId: randomUUID(), mode: 'consult', message, context: context() };
  await f.service.accept(session.sessionId, raw); const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('completed'); expect(turn.input).toBe(message);
  for (const patch of [{ message: 'bad\uD800' }, { context: { ...context(), prompt: 'bad\uDC00' } }]) {
    await expect(f.service.accept(session.sessionId, { ...raw, ...patch, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 400 });
  }
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1); expect(f.conversations.recordTurn).toHaveBeenCalledTimes(1);
});

test('a model proposal exceeding the unchanged final 8000-unit limit is rejected', async () => {
  const f = fixture({ ...proposal, prompt: 'x'.repeat(8001) }), session = await f.service.createSession();
  await f.service.accept(session.sessionId, { clientTurnId: randomUUID(), mode: 'plan', message: 'Refine', context: context() });
  const [turn] = await f.settle(session.sessionId);
  expect(turn.state).toBe('failed'); expect(turn.error).toContain('Proposition Hermes invalide'); expect(turn.proposal).toBeUndefined();
});

async function envelopeFixture() {
  const f = fixture(), session = await f.service.createSession(), plain = context(); delete plain.constraints;
  await f.service.accept(session.sessionId, { clientTurnId: randomUUID(), mode: 'plan', message: 'Probe', context: plain });
  await f.settle(session.sessionId);
  const base = JSON.parse(JSON.stringify(f.bridge.invoke.mock.calls[0][0]));
  f.rows.clear(); f.bridge.invoke.mockClear(); f.conversations.recordTurn.mockClear();
  base.history = []; base.request.instruction = '';
  return { ...f, session, plain, base };
}

test('the exact serialized studio envelope accepts 60000 UTF-16 units and refuses one extra before recording', async () => {
  const f = await envelopeFixture(); f.base.request.prompt = 'p'.repeat(32000);
  const message = 'm'.repeat(60000 - JSON.stringify(f.base).length);
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message, context: { ...f.plain, prompt: f.base.request.prompt } };
  await f.service.accept(f.session.sessionId, raw); await f.settle(f.session.sessionId);
  expect(JSON.stringify(f.bridge.invoke.mock.calls[0][0])).toHaveLength(60000);
  f.rows.clear();
  await expect(f.service.accept(f.session.sessionId, { ...raw, clientTurnId: randomUUID(), message: message + 'x' }))
    .rejects.toThrow('capacité du relais Hermes');
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1); expect(f.conversations.recordTurn).toHaveBeenCalledTimes(1);
});

test.each(['界', '💡'])('the exact JSON envelope accepts 65536 UTF-8 bytes with %s and refuses one extra byte', async character => {
  const f = await envelopeFixture(); f.base.request.prompt = character.repeat(12000);
  const message = 'm'.repeat(65536 - Buffer.byteLength(JSON.stringify(f.base), 'utf8'));
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message, context: { ...f.plain, prompt: f.base.request.prompt } };
  await f.service.accept(f.session.sessionId, raw); await f.settle(f.session.sessionId);
  const json = JSON.stringify(f.bridge.invoke.mock.calls[0][0]);
  expect(Buffer.byteLength(json, 'utf8')).toBe(65536); expect(json.length).toBeLessThan(60000);
  f.rows.clear();
  await expect(f.service.accept(f.session.sessionId, { ...raw, clientTurnId: randomUUID(), message: message + 'x' }))
    .rejects.toThrow('capacité du relais Hermes');
  expect(f.bridge.invoke).toHaveBeenCalledTimes(1); expect(f.conversations.recordTurn).toHaveBeenCalledTimes(1);
});

test('JSON escaping participates in the transport budget before accepting a new input', async () => {
  const f = await envelopeFixture();
  const raw = { clientTurnId: randomUUID(), mode: 'consult', message: 'START' + '\u0000'.repeat(12000) + 'END', context: f.plain };
  await expect(f.service.accept(f.session.sessionId, raw)).rejects.toThrow('capacité du relais Hermes');
  expect(f.bridge.invoke).not.toHaveBeenCalled(); expect(f.conversations.recordTurn).not.toHaveBeenCalled();
});

test('oversized history removes only complete oldest pairs and retains current inputs and stored history verbatim', async () => {
  const f = fixture(), session = await f.service.createSession(), originals = [];
  for (let index = 0; index < 3; index += 1) {
    const raw = { clientTurnId: randomUUID(), mode: 'plan', message: `Question ${index}`,
      context: { ...context(), prompt: `OLD_${index}_` + 'x'.repeat(11000) + `_TAIL_${index}` } };
    await f.service.accept(session.sessionId, raw); await f.settle(session.sessionId); originals.push(raw);
  }
  const current = { clientTurnId: randomUUID(), mode: 'plan', message: 'CURRENT_INSTRUCTION_TERMINAL',
    context: { ...context(), prompt: 'CURRENT_' + 'y'.repeat(29000) + '_CURRENT_TERMINAL' } };
  await f.service.accept(session.sessionId, current); await f.settle(session.sessionId);
  const envelope = f.bridge.invoke.mock.calls.at(-1)[0];
  expect(envelope.history).toHaveLength(4);
  expect(envelope.history.map(row => row.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(envelope.history[0].content).toBe(`Brief à affiner : ${originals[1].context.prompt}\nDemande : ${originals[1].message}`);
  expect(envelope.history[2].content).toBe(`Brief à affiner : ${originals[2].context.prompt}\nDemande : ${originals[2].message}`);
  expect(envelope.request.prompt).toBe(constraints.composeBrief(current.context.prompt, protectedItems()));
  expect(envelope.request.instruction).toBe(current.message);
  expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(60000);
  expect(Buffer.byteLength(JSON.stringify(envelope), 'utf8')).toBeLessThanOrEqual(65536);
  expect(f.rows.get(originals[0].clientTurnId).toolEvidence.imagex.context.prompt).toBe(originals[0].context.prompt);
});

test('the isolated HTTP router accepts a body over 40kb and returns a clear semantic refusal before recording', async () => {
  const express = require('express'), request = require('supertest');
  const { createRouter } = require('../../routes/image-expert');
  const f = fixture(), session = await f.service.createSession(), plain = context(); delete plain.constraints;
  const raw = { clientTurnId: randomUUID(), mode: 'plan', message: 'm'.repeat(32000), context: { ...plain, prompt: 'p'.repeat(32000) } };
  const app = express(); app.use('/expert', createRouter(f.service));
  const response = await request(app).post(`/expert/sessions/${session.sessionId}/turns`).send(raw);
  expect(response.status).toBe(400); expect(response.body).toMatchObject({ ok: false });
  expect(response.body.message).toContain('capacité du relais Hermes');
  expect(f.conversations.recordTurn).not.toHaveBeenCalled(); expect(f.bridge.invoke).not.toHaveBeenCalled();
});
