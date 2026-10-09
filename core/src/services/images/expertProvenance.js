'use strict';
const { forSurface } = require('../surfaceConversationService');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error('La proposition imageX associée est introuvable ou invalide.'), { statusCode: 409 });
function validate(value) {
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['sessionId', 'turnId'].includes(key))
    || !UUID.test(value.sessionId || '') || !UUID.test(value.turnId || '')) throw fail();
  return { sessionId: value.sessionId, turnId: value.turnId };
}
async function resolve(reference, request, profile) {
  if (!reference) return undefined;
  const turn = await forSurface('image-workshop').getTurn({ sessionId: reference.sessionId, traceId: reference.turnId,
    packId: 'atelier', scopeId: 'workspace' });
  const expert = turn?.toolEvidence?.imagex, proposal = expert?.proposal;
  if (turn?.outcome !== 'completed' || turn.source !== 'imagex-hermes' || !proposal) throw fail();
  return { ...reference, agent: 'imagex', harness: 'hermes',
    reportedModel: expert.reportedModel || null, promptEdited: request.prompt !== proposal.prompt,
    settingsEdited: profile !== proposal.profile || request.width !== proposal.width || request.height !== proposal.height };
}
module.exports = { validate, resolve };
