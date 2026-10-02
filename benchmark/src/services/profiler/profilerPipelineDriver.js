'use strict';
const { runJournaledProfile, prepareProfilerRunJournals } = require('./profilerRunJournal');
function createProfilerPipelineDriver({ profile, hostTestService }) {
  async function scout(modelName, hosts, { assertClaimActive, claimIdentityFor, signal, journalLease } = {}) {
    if (journalLease) await prepareProfilerRunJournals(journalLease, hosts, modelName);
    const results = [];
    for (const host of hosts) {
      try {
        assertClaimActive?.();
        const operation = () => hostTestService.testModelOnHost(modelName, host.hostUrl, {
          benchmarkClaim: claimIdentityFor?.(host.hostUrl) || null,
          assertClaimActive,
          signal
        });
        const testResult = journalLease ? await runJournaledProfile(journalLease, { ...host, modelName }, operation) : await operation();
        assertClaimActive?.();
        results.push({
          hostId: host.hostId,
          fit: testResult.status === 'pass',
          tokensPerSec: testResult.tokensPerSec || null,
          error: testResult.error || null
        });
      } catch (err) {
        if (err.retainAdmission === true || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        results.push({ hostId: host.hostId, fit: false, error: err.message });
      }
    }
    return results;
  }

  async function fullPipeline(modelName, hosts, { assertClaimActive, claimIdentityFor, signal, journalLease } = {}) {
    if (journalLease) await prepareProfilerRunJournals(journalLease, hosts, modelName);
    const results = [];
    for (const host of hosts) {
      try {
        assertClaimActive?.();
        const operation = () => profile(modelName, host.hostId, host.hostUrl, 'full', {
          assertClaimActive,
          claimIdentity: claimIdentityFor?.(host.hostUrl) || null,
          signal
        });
        const profileResult = journalLease ? await runJournaledProfile(journalLease, { ...host, modelName }, operation) : await operation();
        results.push({
          ...host,
          profileResult,
          success: true,
          benchmarkQualified: profileResult?.profile?.benchmarkQualified === true
        });
      } catch (err) {
        if (err.retainAdmission === true || err.authorityInvalidationFailed === true
          || err.code === 'BENCHMARK_CLAIM_LOST'
          || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        results.push({ ...host, success: false, error: err.message });
      }
    }
    const failures = results.filter(result => result.success !== true);
    return {
      completed: failures.length === 0 && results.length === hosts.length,
      benchmarkQualified: failures.length === 0
        && results.length === hosts.length
        && results.every(result => result.benchmarkQualified === true),
      results,
      failures: failures.map(result => ({ hostId: result.hostId, error: result.error }))
    };
  }

  return { scout, fullPipeline };
}
module.exports = { createProfilerPipelineDriver };
