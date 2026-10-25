'use strict';

// This predicate narrows an already selected space. Missing fact dates stay
// current; a scheduled invalidation takes effect only at its stated instant.
function currentFactFilter(now = new Date()) {
  return { $or: [{ invalidatedAt: null }, { invalidatedAt: { $gt: now } }] };
}

module.exports = { currentFactFilter };
