'use strict';

const { createHash } = require('node:crypto');
const same = (left, right) => JSON.stringify(left || []) === JSON.stringify(right || []);
const error = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });

// The human message and a pending assistant slot are committed together by the
// existing transcript owner. Completion replaces only that slot, never input.
function turnIntake({ recordTurn, getTurn, updateTurn, withWrite }) {
  async function acceptTurn(input) {
    return withWrite(input.sessionId, async () => {
      const query = { sessionId: input.sessionId, packId: input.packId, scopeId: input.scopeId, traceId: input.traceId };
      let previous = await getTurn(query);
      if (!previous) {
        try { return { turn: await recordTurn({ ...input, replyText: '', outcome: 'pending',
          inputSha256: createHash('sha256').update(input.inputText).digest('hex') }), duplicate: false }; }
        catch (cause) { if (cause.code !== 11000) throw cause; previous = await getTurn(query); }
      }
      if (!previous || previous.inputText !== input.inputText
        || !same(previous.attachments?.map(row => String(row.id)), input.attachments?.map(row => String(row.id)))) {
        throw error('This turn identity belongs to another request.', 'CONVERSATION_TURN_CONFLICT', 409);
      }
      return { turn: previous, duplicate: true };
    });
  }

  async function settleTurn(input) {
    const { inputText, inputSha256, attachments, clientTurnId, createdAt, modeId, channel, traceId, sessionId, packId, scopeId, ...fields } = input;
    if (typeof fields.replyText !== 'string' || fields.replyText.length > 16000) {
      throw error('Invalid bounded conversation reply.', 'CONVERSATION_INVALID', 400);
    }
    const query = { traceId, sessionId, packId, scopeId };
    const previous = await getTurn(query);
    if (!previous) throw error('Conversation turn not found.', 'CONVERSATION_NOT_FOUND', 404);
    if (previous.outcome !== 'pending') return previous;
    const turn = await updateTurn({ ...query, outcome: 'pending' }, { $set: { ...fields,
      outcome: fields.outcome || 'completed', replySha256: createHash('sha256').update(fields.replyText).digest('hex') } });
    return turn || getTurn(query);
  }
  return { acceptTurn, settleTurn };
}

module.exports = { turnIntake };
