'use strict';
const { normalizeMessage, AnswerBlocksError } = require('../../../../shared/answerBlocks');
const { withPlaygroundHistoryFilter, isPlaygroundConversation } = require('../conversationSurfacePolicy');

function blockWriteRequested(messages) { return messages.some(message => message?.answerBlocks !== undefined); }
function stampMessages(messages) { return messages.map(message => ({ ...normalizeMessage(message), timestamp: new Date() })); }
function visibleBlockScope(userId, id) {
  return withPlaygroundHistoryFilter({ userId, ...(id ? { _id: id } : {}), surface: { $exists: false },
    surfaceSession: { $exists: false }, 'lifecycle.status': { $ne: 'archived' } });
}
// Apply before pagination/projection: native surface authors must not expose
// table fallbacks through a Playground preview or search. Plaintext keeps its
// existing visibility contract.
function withBlockHistoryFilter(base) {
  return { ...base, $and: [...(base.$and || []), { $or: [
    { 'messages.answerBlocks': { $exists: false } }, visibleBlockScope(base.userId)
  ] }] };
}
function blockHistoryReadable(conversation) {
  if (!conversation?.messages?.some(message => message.answerBlocks !== undefined)) return true;
  return conversation.surface === undefined && conversation.surfaceSession === undefined
    && conversation.lifecycle?.status !== 'archived' && isPlaygroundConversation(conversation);
}
function assertVisibleCreation(input) {
  if (!isPlaygroundConversation(input)) throw new AnswerBlocksError('Answer tables belong to visible Playground history.');
}
module.exports = { blockWriteRequested, stampMessages, visibleBlockScope, withBlockHistoryFilter, blockHistoryReadable, assertVisibleCreation };
