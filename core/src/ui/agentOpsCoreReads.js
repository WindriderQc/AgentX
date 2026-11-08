'use strict';

const { addCanonicalEnvelope } = require('../middleware/responseEnvelopeCompatibility');

// Only the integrated Core composition supplies these fixed, read-only producers.
module.exports = Object.freeze({
  ecosystem: async () => addCanonicalEnvelope({ status: 'success',
    data: await require('../../routes/nerve-center').buildEcosystemSnapshot() }),
  budget: () => require('../../routes/budget').buildBudgetStatus()
});
