'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { workshopContext, workshopPrompt } = require('../kidx-workshop');
const session = { packId: 'kidx_nestor', modeId: 'family', scopeId: 'family' };
const context = () => ({ schemaVersion: 1, screenId: 'screen-one', contextRevision: 3, capturedAt: '2026-09-11T12:00:00Z', locale: 'fr-CA',
  screen: 'build', build: { modelId: 'track3r', stage: 3 }, knowledgeRefs: [{ sourceId: 'ldraw:track3r', locator: 'stage:3', status: 'observed' }], availableActions: ['rotate'] });
test('optional workshop context is restricted to the existing exact Family session', () => {
  assert.equal(workshopContext(undefined, session), null);
  for (const change of [{ packId: 'personal_operator' }, { scopeId: 'personal' }, { modeId: 'open' }, { packId: 'kidx_reader' }]) assert.throws(() => workshopContext(context(), { ...session, ...change }));
  assert.deepEqual(workshopContext(context(), session), context());
  assert.equal(workshopContext({ ...context(), personaId: 'dad', privateMemory: 'hidden' }, session).privateMemory, undefined);
});
test('bad revisions, payload sizes, arbitrary tools and mismatched receipts are rejected', () => {
  for (const change of [{ contextRevision: -1 }, { schemaVersion: 2 }, { capturedAt: 'yesterday' }, { availableActions: ['shell'] },
    { mission: { guide: 'x'.repeat(15000) } }, { actionResult: { action: 'rotate', id: 'turn-abcdefghijkl', screenId: 'wrong', contextRevision: 3, status: 'applied', message: 'Done' } }]) assert.throws(() => workshopContext({ ...context(), ...change }, session));
});
test('Family prompt retains evidence limits, no tool authority and current-screen precedence', () => {
  const data = context(); data.actionResult = { action: 'rotate', id: 'turn-abcdefghijkl', screenId: 'screen-one', contextRevision: 2, status: 'applied', message: 'Vue tournée.' };
  const prompt = workshopPrompt(workshopContext(data, session));
  assert.match(prompt, /canonical Family persona/); assert.match(prompt, /no executable tools/);
  assert.match(prompt, /replaces older screen/); assert.match(prompt, /PDF pages have not been interpreted/);
  assert.match(prompt, /null attempt means no child attempt/); assert.match(prompt, /Vue tournée/);
});
