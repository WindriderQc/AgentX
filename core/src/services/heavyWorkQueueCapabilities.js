'use strict';

// Shared by native admission and its read model. A capability is not consent,
// an open reservation, runtime admission or evidence that a launch occurred.
const AUTO_START_KINDS = ['profiler', 'embedding-reindex', 'topology', 'transcription'];
function autoStartable(job) {
  if (job.executor?.mode === 'pinned-fit') return false;
  return Boolean(job.executor) && (AUTO_START_KINDS.includes(job.kind) || job.executor.mode === 'pipeline-report'
    || (job.kind === 'benchmark' && job.executor.mode === 'coverage'));
}
const manuallyStartable = job => autoStartable(job)
  || job.kind === 'profiler' && job.executor?.mode === 'pinned-fit';

module.exports = { AUTO_START_KINDS, autoStartable, manuallyStartable };
