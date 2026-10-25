'use strict';

// Shared by native admission and its read model. A capability is not consent,
// an open reservation, runtime admission or evidence that a launch occurred.
const AUTO_START_KINDS = ['profiler', 'embedding-reindex', 'topology'];
function autoStartable(job) {
  return Boolean(job.executor) && (AUTO_START_KINDS.includes(job.kind) || job.executor.mode === 'pipeline-report');
}

module.exports = { AUTO_START_KINDS, autoStartable };
