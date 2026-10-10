'use strict';
function createConversationCapabilities() {
  return {
    conversationWorks: require('../conversationWorks/capability'),
    conversationRecaps: require('../conversationRecapService').createConversationRecapService(),
    conversationPreferences: require('../conversationPreferences/service').createConversationPreferences()
  };
}
module.exports = { createConversationCapabilities };
