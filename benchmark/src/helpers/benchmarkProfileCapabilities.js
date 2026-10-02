'use strict';

const { normalizeAgentXProfile } = require('../../../shared/agentxRuntimeProfile');

// Core serves the claim, workload admission and workload recovery routes in
// both profiles (shared/agentxRuntimeProfile.js isProductCoordination), so
// claim, profiler and authority recovery run everywhere. Only the registered
// inference-host list belongs to the full-profile Nerve Center surface.
function shouldSyncRegisteredHosts(profile = process.env.AGENTX_PROFILE) {
  return normalizeAgentXProfile(profile) === 'full';
}

module.exports = { shouldSyncRegisteredHosts };
