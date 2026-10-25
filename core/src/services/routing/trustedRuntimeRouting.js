'use strict';

function createRoutingCapabilities(deps) {
  return Object.freeze({
    getEffectiveSnapshot: require('./routingSnapshotCache').effectiveSnapshotReader(deps),
    planFallback: request => require('./taskFallbackLadder').planExactModelFallback(request),
    hasFallbackLadder: taskType => require('./taskFallbackLadder').hasConversationLadder(taskType)
  });
}

module.exports = { createRoutingCapabilities };
