'use strict';

const reviewed = require('./personalHistoryReviewRestorationContract');
const preservation = require('./personalHistoryPreservationContract');
const { digest, failure } = require('./personalHistorySourceReviewSources');
const CONTRACT = 'secretary.archive-storage-evidence/v1';
const TOPOLOGY = 'secretary.archive-storage-topology/v1';
const HASH = /^[a-f0-9]{64}$/;
const hash = value => typeof value === 'string' && HASH.test(value);
const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const unavailable = () => failure('The complete selected native storage evidence is unavailable.', 503, 'HISTORY_STORAGE_UNAVAILABLE');

function describe(value, nonce, reference) {
  if (value?.contract !== CONTRACT) throw unavailable();
  const { storage, ...original } = value;
  const proof = reviewed.describe({ ...original, contract: reviewed.CONTRACT }, nonce, reference);
  const checked = preservation.describe(proof.packet, nonce, reference);
  if (!keys(storage, ['contract', 'scope', 'status', 'files', 'filesSha256', 'physicalDiskIdsSha256', 'blockers', 'physicalIndependenceAccepted'])
    || storage.contract !== TOPOLOGY || storage.scope !== 'selected-current-review-files-kernel-device-identities'
    || !Number.isSafeInteger(storage.files) || storage.files !== proof.restoration.filesCopied
    || storage.filesSha256 !== proof.restoration.sourceFilesSha256 || storage.physicalIndependenceAccepted !== false
    || !Array.isArray(storage.physicalDiskIdsSha256) || storage.physicalDiskIdsSha256.length > 32
    || !storage.physicalDiskIdsSha256.every(hash)
    || digest(storage.physicalDiskIdsSha256) !== digest([...new Set(storage.physicalDiskIdsSha256)].sort())
    || !Array.isArray(storage.blockers) || storage.blockers.length > 16
    || !storage.blockers.every(code => typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code))
    || digest(storage.blockers) !== digest([...new Set(storage.blockers)].sort())
    || !['observed_local_devices', 'unqualified'].includes(storage.status)
    || (storage.status === 'observed_local_devices' ? !storage.physicalDiskIdsSha256.length || storage.blockers.length
      : storage.physicalDiskIdsSha256.length || !storage.blockers.length)) throw unavailable();
  return { machineIdSha256: checked.machineIdSha256, archiveIdSha256: checked.archiveIdSha256,
    content: { ...checked.content, reviewPacket: proof.reviewPacket }, restoration: proof.restoration, storage };
}

function coverage(copies) {
  const blockers = [];
  if (copies.some(copy => copy.storage.status !== 'observed_local_devices')) blockers.push('storage_topology_unqualified');
  if (copies[0].machineIdSha256 === copies[1].machineIdSha256) blockers.push('same_native_machine');
  if (digest(copies[0].content) !== digest(copies[1].content)) blockers.push('native_copy_content_mismatch');
  if (copies[0].storage.physicalDiskIdsSha256.some(id => copies[1].storage.physicalDiskIdsSha256.includes(id))) blockers.push('kernel_device_identity_overlap');
  return { state: blockers.length ? 'held' : 'distinct_kernel_devices_observed', blockers };
}

module.exports = { CONTRACT, TOPOLOGY, describe, coverage, unavailable };
