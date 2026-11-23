'use strict';

// Available conversation pictures, numbered newest first so the model can name
// one as the reference of a drawing: <show kind="image" source="draw" from="1"> (#1026).
// The model never gives an address; Core reads back the picture it resolved itself.
const { fitReference, decodable } = require('../../src/services/images/codec');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMITS = Object.freeze({ listed: 6, turns: 12 });
const LABELS = Object.freeze({ web: 'Internet', photos: 'family photo', media: 'household media', generated: 'generated picture', local: 'local creation' });

function ready(operation) {
  return UUID.test(operation?.id || '') && operation.state === 'completed' && operation.runtimeRestored === true
    && /^[a-f0-9]{64}$/.test(operation.artifact?.sha256 || '');
}

async function recentBlocks({ conversations, session }) {
  const turns = await conversations.listTurns({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId },
    { sort: { createdAt: -1 }, limit: LIMITS.turns });
  return turns.flatMap(turn => Array.isArray(turn.display) ? [...turn.display].reverse() : []).filter(block => block?.kind === 'image');
}

async function recentShown({ conversations, session, operations = [] }) {
  const available = new Set(operations.filter(ready).map(op => op.id));
  return (await recentBlocks({ conversations, session })).filter(block => block.source === 'local'
    ? Boolean(block.operation?.id && available.has(block.operation.id)) : block.status === 'found' && block.image?.url).slice(0, LIMITS.listed);
}

function contextText(shown) {
  if (!shown.length) return '';
  return '\n\nAvailable conversation pictures, newest first (reference data; display on the device is unverified. To change one, add its number as from="N" to a draw block):\n'
    + shown.map((block, index) => `${index + 1}. ${String(block.title || block.body || 'picture').replace(/\s+/g, ' ').slice(0, 120)} (${LABELS[block.source] || 'picture'})`).join('\n');
}

// The reference for an edit: the picture's own bytes, fitted to the image service's limits.
async function referenceFor(block, { visuals, service, conversation, family }) {
  let bytes;
  if (block.source === 'local') {
    const operation = await service.getForConversation(block.operation.id, conversation);
    if (operation.id !== block.operation.id || !ready(operation)) throw new Error('The earlier creation is not ready.');
    ({ bytes } = await service.image(operation.id));
  } else bytes = await visuals.bytesFor(block.image, { family });
  const fitted = fitReference(await decodable(bytes));
  return { reference: Buffer.from(fitted.bytes).toString('base64'), width: fitted.width, height: fitted.height };
}

// Output dimensions that keep the reference's shape within the quick preset's pixel budget.
function editSize(quick, { width, height }) {
  const area = quick.width * quick.height, aspect = Math.min(2, Math.max(0.5, width / height));
  const round = value => Math.max(256, Math.floor(value / 32) * 32);
  return { width: round(Math.sqrt(area * aspect)), height: round(Math.sqrt(area / aspect)) };
}

module.exports = { recentBlocks, recentShown, ready, contextText, referenceFor, editSize, LIMITS, UUID };
