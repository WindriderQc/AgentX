'use strict';

const { validTimestamp } = require('../livingSourceFreshness');

// Read the native ingestion receipt, not statement dates or scheduler status.
// Bounded execution: a slow/unavailable journal yields unknown, never a read-time
// success. No index creation, ingestion or other write occurs on this path.
async function read({ now = () => new Date(), collection = () => require('mongoose').connection.db.collection('finance_ingestions'),
  withAccess = fn => require('./financeAccess').withAccess(fn) } = {}) {
  try {
    const row = await withAccess(() => collection().find({
      phase: 'applied', 'candidate.base.ledger': { $ne: 'corp' },
      'receipt.appliedAt': { $type: 'string' }
    }, { projection: { _id: 0, 'receipt.appliedAt': 1 } })
      .sort({ 'receipt.appliedAt': -1 }).limit(1).maxTimeMS(1000).next());
    const at = row?.receipt?.appliedAt;
    const timestamp = validTimestamp(at, now());
    return { status: timestamp ? 'attested' : 'unknown',
      lastAppliedAt: timestamp,
      scope: 'personal_ledger_journaled_ingestions', lastFailedAt: null };
  } catch {
    return { status: 'unavailable', lastAppliedAt: null,
      scope: 'personal_ledger_journaled_ingestions', lastFailedAt: null };
  }
}
module.exports = { read };
