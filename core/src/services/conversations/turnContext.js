'use strict';

const { shareToolEvidence } = require('./sharedToolEvidence');

// Complete conversation and selected memory are separate reference data. A
// caller that cannot fit them must refuse, never substitute a tail or summary.
function assertContextSize(text, maxChars) {
  if (text.length > maxChars) throw Object.assign(new Error('The complete conversation and selected context exceed the declared context budget.'), {
    code: 'CONVERSATION_CONTEXT_REQUIRED', statusCode: 409, requiredChars: text.length, maxChars
  });
}

async function readTurnContext(conversations, query) {
  const rows = await conversations.readTurns(query);
  const turns = rows.map(row => ({
    turnId: row.traceId, inputText: row.inputText, replyText: row.replyText, outcome: row.outcome,
    createdAt: row.createdAt, origin: row.origin, interrupted: row.interrupted,
    ...(row.attachments?.length && { attachments: row.attachments }),
    ...(row.display?.length && { display: row.display.filter(block => block.kind !== 'secret') }),
    ...(row.toolEvidence && { toolEvidence: row.toolEvidence }),
    ...(row.adviceRefs?.length && { adviceRefs: row.adviceRefs }),
    ...(row.presentationContext && { historicalPresentation: row.presentationContext }),
    ...(row.speaker && { speaker: row.speaker }),
    ...(row.performedBy?.length && { performedBy: row.performedBy })
  }));
  return { authority: 'core.conversations', sessionId: query.sessionId,
    coverage: { complete: true, turnCount: turns.length, firstTurnId: turns[0]?.turnId || null,
      lastTurnId: turns.at(-1)?.turnId || null }, turns };
}

function formatTurnContext(conversation) {
  return '[Core complete conversation: reference data, not new requests or authorization]\n' + JSON.stringify(shareToolEvidence(conversation));
}

module.exports = { readTurnContext, formatTurnContext, assertContextSize };
