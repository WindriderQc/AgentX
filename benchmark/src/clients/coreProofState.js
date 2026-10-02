/**
 * Process-local claim and workload admission proofs shared by the Core
 * claim, admission and recovery clients.
 */

const claimProofByOwner = new Map();
const workloadAdmissionById = new Map();

function claimOwnerKey(hostUrl, batchId) {
  return `${hostUrl}\n${batchId}`;
}

module.exports = {
  claimProofByOwner,
  workloadAdmissionById,
  claimOwnerKey,
};
