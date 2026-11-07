'use strict';

const { createHash } = require('node:crypto');
const Conversation = require('../../../models/Conversation');
const attachments = require('../conversationAttachmentService');
const { withOwnerWrite } = require('../conversations/writeFence');

const storeFor = (conversationId, userId) => attachments.forPlayground({ conversationId, userId });

async function references({ attachmentIds = [], conversationId, userId }) {
  const ids = attachments.ids(attachmentIds);
  return ids.length ? storeFor(conversationId, userId).references(ids) : [];
}

async function prepare(messages, { conversationId, userId }, backend = 'agentx') {
  validateMessages(messages);
  if (!messages.some(message => message.attachments?.length)) return messages;
  return storeFor(conversationId, userId).prepare(messages, backend);
}

function validateMessages(messages) {
  for (const message of messages) {
    if (message.attachments === undefined) continue;
    if (!Array.isArray(message.attachments) || message.role !== 'user') {
      throw Object.assign(new Error('Only user messages can include an attachment array.'),
        { statusCode: 400, code: 'CONVERSATION_ATTACHMENT_INVALID' });
    }
    attachments.ids(message.attachments.map(item => item?.id));
  }
}

async function validateScope(messages, owner) {
  validateMessages(messages);
  for (const message of messages) {
    if (message.attachments?.length) await references({ ...owner, attachmentIds: message.attachments.map(item => item.id) });
  }
}

// A first screenshot creates an ordinary empty Core conversation on Send.
// The browser keeps this identity across transport retries. Its durable owner
// fence rejects a replay after erasure instead of recreating deleted content.
async function upload(userId, input = {}) {
  if (input.conversationId) {
    const attachment = await storeFor(input.conversationId, userId).upload(input);
    return { conversationId: input.conversationId, attachment };
  }
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId)) {
    throw Object.assign(new Error('A capture request identity is required.'), { statusCode: 400, code: 'CAPTURE_REQUEST_INVALID' });
  }
  await attachments.decode(input);
  const conversationId = createHash('sha256').update(JSON.stringify(['playground-attachment', userId, input.requestId]))
    .digest('hex').slice(0, 24);
  return withOwnerWrite(conversationId, async () => {
    if (!await Conversation.exists({ _id: conversationId })) {
      await Conversation.create({ _id: conversationId, userId, source: 'agentx', model: 'unknown',
        title: 'Screen capture', messages: [] });
    }
    const attachment = await storeFor(conversationId, userId).upload(input);
    return { conversationId, attachment };
  });
}

module.exports = { upload, references, prepare, validateScope, storeFor };
