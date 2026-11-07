'use strict';

const { coreRequest } = require('../../clients/coreHttp');
const { CORE_OPERATIONS } = require('../../clients/coreOperations');
const { refusal } = require('./gpuDriverPreparationIdentity');

// Reuse Core's owned claim heartbeat: a private-LAN caller header alone is not
// authority, and public claim discovery omits the capability generation.
async function assertQualificationAuthority(hostUrl, proof, { request = coreRequest } = {}) {
  const { workloadId, workloadAdmissionId, workloadGeneration, claimBatchId, claimGeneration } = proof || {};
  if (!workloadId || workloadId !== claimBatchId || !workloadAdmissionId || !workloadGeneration || !claimGeneration) {
    throw refusal('An exact owned workload and host claim are required', 'GPU_DRIVER_QUALIFICATION_AUTHORITY_REQUIRED');
  }
  const response = await request(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/benchmark-claim/${encodeURIComponent(workloadId)}/heartbeat`, {
    method: 'POST', operationId: CORE_OPERATIONS.CLAIM_HEARTBEAT,
    body: JSON.stringify({ admissionId: workloadAdmissionId, admissionGeneration: workloadGeneration, claimGeneration })
  });
  const receipt = response?.data;
  if (receipt?.heartbeat !== true || receipt.batchId !== workloadId || receipt.claimGeneration !== claimGeneration
    || receipt.snapshotExact !== true) {
    throw refusal('Core did not attest the exact qualification claim', 'GPU_DRIVER_QUALIFICATION_AUTHORITY_REQUIRED');
  }
  return receipt;
}

module.exports = { assertQualificationAuthority };
