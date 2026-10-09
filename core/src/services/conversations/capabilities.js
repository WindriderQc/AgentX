'use strict';
function createConversationCapabilities() {
  return {
    conversationRecaps: require('../conversationRecapService').createConversationRecapService(),
    conversationPreferences: require('../conversationPreferences/service').createConversationPreferences()
  };
}
module.exports = { createConversationCapabilities };
