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
    recordTurn: async input => { rows.set(input.traceId, input); return input; },
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
  return { service, bridge, settle };
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
