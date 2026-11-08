'use strict';

const { addCanonicalEnvelope } = require('../middleware/responseEnvelopeCompatibility');

// Built-in surface composition. External mounts can omit any reader and retain
// their existing HTTP transport. These readers confer no identity or authority.
function createHouseholdCoreReads(readHealth) {
  return {
    corePanelReads: {
      health: readHealth,
      ecosystem: () => require('../../routes/nerve-center').buildEcosystemSnapshot()
    },
    coreBriefingReads: {
      morningBrief: async () => addCanonicalEnvelope(await require('../../routes/reports').buildMorningBrief()),
      budget: () => require('../../routes/budget').buildBudgetStatus()
    }
  };
}

module.exports = { createHouseholdCoreReads };
