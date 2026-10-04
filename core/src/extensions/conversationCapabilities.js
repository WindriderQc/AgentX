'use strict';
function createConversationCapabilities() {
  return {
    conversationRecaps: require('../services/conversationRecapService').createConversationRecapService(),
    conversationPreferences: require('../services/conversationPreferences/service').createConversationPreferences()
  };
}
module.exports = { createConversationCapabilities };
