'use strict';

/**
 * Journal the host-test routes (single test, run-all, fleet, compare, context
 * probe) like the profile pipeline: each host's runtime requests run under a
 * `profile_run` journal, so a failed restore after the claim leaves a journal
 * the recovery sweep can adopt instead of an orphan UNKNOWN workload (#145).
 *
 * A host outside the configuration has no HostProfile to journal into and runs
 * as before.
 */

const { runJournaledProfile } = require('./profilerRunJournal');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');

const origin = value => String(value || '').trim().replace(/\/+$/, '').toLowerCase();

function configuredHostId(hostUrl) {
  const wanted = origin(hostUrl);
  const host = getConfiguredHosts().find(item => origin(item.url) === wanted);
  return host?.id || null;
}

function runHostJournaled(lease, { hostId = null, hostUrl, modelName }, operation) {
  const id = hostId || configuredHostId(hostUrl);
  if (!id) return operation();
  return runJournaledProfile(lease, { hostId: id, hostUrl, modelName: String(modelName || '').slice(0, 200) }, operation);
}

module.exports = { runHostJournaled, configuredHostId };
