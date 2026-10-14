'use strict';
const { selectors, hash } = require('./expertReferences');
const { safeReceipt } = require('./expertInspection');
const { forSurface } = require('../surfaceConversationService');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = () => Object.assign(new Error('The associated imageX proposal is missing or invalid.'), { statusCode: 409 });
function validate(value) {
  if (value === undefined) return undefined;
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !['sessionId', 'turnId'].includes(key))
    || !UUID.test(value.sessionId || '') || !UUID.test(value.turnId || '')) throw fail();
  return { sessionId: value.sessionId, turnId: value.turnId };
}
async function resolve(reference, request, profile, received = {}) {
  if (!reference) return undefined;
  const turn = await forSurface('image-workshop').getTurn({ sessionId: reference.sessionId, traceId: reference.turnId,
    packId: 'atelier', scopeId: 'workspace' });
  const expert = turn?.toolEvidence?.imagex, proposal = expert?.proposal;
  if (turn?.outcome !== 'completed' || turn.source !== 'imagex-hermes' || !proposal) throw fail();
  if (expert.context?.references !== undefined) {
    const expected = selectors(expert.context.references);
    if (received.selection === undefined || JSON.stringify(selectors(received.selection)) !== JSON.stringify(expected)) throw fail();
    const actual = [...(received.parent ? [{ kind: 'parent', ...received.parent }] : []),
      ...(received.originals || []).map((bytes, index) => ({ ...expected[index + (received.parent ? 1 : 0)], sha256: hash(bytes) }))];
    if (actual.length !== expected.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw fail();
  }
  if (expert.context?.inspectReferences && (expert.inspection?.state !== 'completed'
    || expert.inspection.nativeReceipt?.completion !== 'completed'
    || expert.inspection.nativeReceipt?.requestId !== expert.inspection.requestId)) throw fail();
  return { ...reference, agent: 'imagex', harness: 'hermes',
    reportedModel: expert.reportedModel || null, promptEdited: request.prompt !== proposal.prompt,
    settingsEdited: profile !== proposal.profile || request.width !== proposal.width || request.height !== proposal.height,
    ...(expert.inspection?.state === 'completed' && { referenceInspection: { referenceSha256: expert.inspection.referenceSha256,
      references: expert.inspection.references, nativeReceipt: safeReceipt(expert.inspection.nativeReceipt) } }) };
}
module.exports = { validate, resolve };
