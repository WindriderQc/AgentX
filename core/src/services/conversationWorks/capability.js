'use strict';
// Trusted surfaces compose this Core-owned capability with their native agent
// adapter. No browser or model can construct a scope, repository or executor.
module.exports = Object.freeze({
  create: require('./service').createConversationWorks,
  observe: require('./observer').createWorkObserver,
  registerRoutes: require('./routes').registerConversationWorkRoutes
});
