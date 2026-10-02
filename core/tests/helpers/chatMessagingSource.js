'use strict';

const fs = require('fs');
const path = require('path');

const CHAT_DIR = path.resolve(__dirname, '../../public/js/chat');

// chat-messaging.js re-exports its rendering and model helpers from sibling
// modules. Source-text tests read the three files in their original order.
const CHAT_MESSAGING_MODULES = ['chat-message-render.js', 'chat-messaging.js', 'chat-models.js'];

function readChatMessagingSource() {
  return CHAT_MESSAGING_MODULES
    .map((file) => fs.readFileSync(path.join(CHAT_DIR, file), 'utf8'))
    .join('\n');
}

module.exports = { CHAT_MESSAGING_MODULES, readChatMessagingSource };
