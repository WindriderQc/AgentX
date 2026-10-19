'use strict';

/**
 * Sibling endpoints a queued profile may also call: the other Ollama
 * endpoints of the same machine that its own Core heavy-work request covers
 * while that request is being executed. A profile started by hand, or a
 * request whose hosts name only the lane, gets none, so the concurrency probe
 * reports the other endpoints as not measured. Reads only; never throws.
 */

const { normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { machineOf } = require('./laneCampaignPlan');
const logger = require('../../../config/logger');

const EXECUTING = new Set(['dispatching', 'running']);

async function reservedSiblingEndpoints(queueRequestId, hostUrl, {
  list = () => require('../../clients/coreHeavyQueue').listHeavyWork()
} = {}) {
  if (!queueRequestId) return [];
  try {
    const job = ((await list())?.jobs || []).find(item => item.id === queueRequestId);
    if (!job || !EXECUTING.has(job.state)) return [];
    const own = normalizeHostUrl(hostUrl);
    if (!(job.hosts || []).some(url => normalizeHostUrl(url) === own)) return [];
    return [...new Set((job.hosts || []).map(url => normalizeHostUrl(url))
      .filter(url => url && url !== own && machineOf(url) === machineOf(own)))].sort();
  } catch (error) {
    logger.warn('Profiler: queue request unreadable; sibling endpoints left unmeasured', { queueRequestId, error: error.message });
    return [];
  }
}

module.exports = { reservedSiblingEndpoints };
