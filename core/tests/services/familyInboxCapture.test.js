'use strict';

const { captureFamilyTurn } = require('../../src/services/ideaInboxService');
const planning = require('../../src/services/planningService');
const Item = require('../../models/PlanningItem');

const bound = { sessionId: 'synthetic-family-session', turnId: 'synthetic-turn-identity',
  userText: 'Peux-tu garder pour papa mon idée de cabane ?\nJe la voudrais bleue.', kind: 'idea' };

test('concurrent model calls create one parent item and a replay cannot reopen an archived capture', async () => {
  const receipts = await Promise.all(Array.from({ length: 8 }, () => captureFamilyTurn(bound)));
  const id = receipts[0].ideaId;
  expect(receipts.every(row => row.ideaId === id && row.kind === 'idea' && row.status === 'inbox')).toBe(true);
  expect(await Item.countDocuments({ owner: 'household-family' })).toBe(1);
  expect(await Item.findById(id).lean()).toMatchObject({ type: 'idea', owner: 'household-family',
    tags: ['origin:family', 'kind:idea'], summary: bound.userText });
  await planning.archiveItem(id, { by: 'test-parent' });
  const recovered = await captureFamilyTurn({ ...bound, kind: 'reminder' });
  expect(recovered).toEqual({ ...receipts[0], status: 'archived' });
  await expect(captureFamilyTurn({ ...bound, userText: 'Different input on replay.' }))
    .rejects.toMatchObject({ code: 'IDEA_FAMILY_TURN_CONFLICT' });
});

test('a lost acknowledgement is recovered by exact turn and input without making a replacement', async () => {
  const realCreate = planning.createItem;
  const create = jest.spyOn(planning, 'createItem').mockImplementationOnce(async (...args) => {
    await realCreate(...args);
    throw new Error('simulated reply loss');
  });
  const capture = { ...bound, turnId: 'lost-ack-fixture-identity' };
  try {
    const receipt = await captureFamilyTurn(capture);
    expect(receipt).toMatchObject({ status: 'inbox', kind: 'idea' });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await captureFamilyTurn(capture)).ideaId).toBe(receipt.ideaId);
  } finally { create.mockRestore(); }
});

test('invalid or interrupted input cannot write a partial idea', async () => {
  const capture = { ...bound, turnId: 'cancelled-fixture-identity' };
  const before = await Item.countDocuments();
  await expect(captureFamilyTurn({ ...capture, signal: AbortSignal.abort() })).rejects.toThrow();
  await expect(captureFamilyTurn({ ...capture, userText: 'x'.repeat(4001) })).rejects.toMatchObject({ code: 'IDEA_INVALID_FAMILY_TURN' });
  expect(await Item.countDocuments()).toBe(before);
});
