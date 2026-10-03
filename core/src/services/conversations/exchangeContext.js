'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const exchanges = require('./exchangeReceipts');
const context = new AsyncLocalStorage();

// Only authenticated server middleware installs this context. Public body or
// query fields cannot select a stored receipt or bypass its erasure boundary.
const withRequestReceipt = (receipt, action) => context.run(receipt, action);
function publishConversation(conversationId, action) {
  const receipt = context.getStore();
  return receipt ? exchanges.publish(receipt, conversationId, action) : action();
}

module.exports = { withRequestReceipt, publishConversation };
