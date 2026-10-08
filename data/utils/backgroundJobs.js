'use strict';

/**
 * The one place that knows whether this instance runs background work (live
 * feeds, janitor profile timers). It is an explicit instance choice
 * (DATA_BACKGROUND_JOBS_ENABLED=true) and never a test side effect.
 */
function backgroundJobsEnabled(env = process.env) {
  return env.NODE_ENV !== 'test' && env.DATA_BACKGROUND_JOBS_ENABLED === 'true';
}

module.exports = { backgroundJobsEnabled };
