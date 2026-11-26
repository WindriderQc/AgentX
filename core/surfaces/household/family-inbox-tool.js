'use strict';

const { inboxCaptureAllowed } = require('./family-context');
const ideas = require('../../src/services/ideaInboxService');

const TOOL = {
  name: 'family_inbox_capture',
  description: 'Save the speaker’s current idea or reminder in the parent review inbox only when they ask to keep it for the parent. Core binds the current words. Skip quotations, hypotheticals, private remarks and withdrawn requests. A receipt confirms only the inbox item. No alarm, notification, chore or task is scheduled.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['kind'],
    properties: { kind: { type: 'string', enum: ['idea', 'reminder'] } } }
};
async function callTool({ kind }, binding) {
  if (!binding || binding.signal.aborted || !inboxCaptureAllowed(binding.userText)) {
    return { isError: true, structuredContent: { error: 'FAMILY_INBOX_NOT_AVAILABLE' } };
  }
  try {
    const receipt = await ideas.captureFamilyTurn({ ...binding, kind });
    return { structuredContent: receipt };
  } catch (error) {
    const code = error.code === 'IDEA_FAMILY_TURN_CONFLICT' ? error.code : 'FAMILY_INBOX_UNCONFIRMED';
    return { isError: true, structuredContent: { error: code, message: 'The parent inbox capture could not be confirmed for this turn.' } };
  }
}

module.exports = { TOOL, callTool };
