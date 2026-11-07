'use strict';

// Receipt transport only. Native owners decide no-start and Core decides release.
async function recordRefusal(job, dispatchId, error, client) {
  const body = { dispatchId, code: String(error.code || error.details?.code || 'LAUNCH_REFUSED').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100) || 'LAUNCH_REFUSED',
    reason: String(error.message || error).replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 1000) || 'Launch refused' };
  let current;
  try { current = await client(`/${job.id}/refused`, body); }
  catch { try { current = await client(`/${job.id}`); } catch { return null; } }
  return current?.state === 'failed' && current.launchRefusal?.dispatchId === dispatchId
    && current.launchRefusal.code === body.code && current.launchRefusal.reason === body.reason
    && current.releaseReceipt?.authority === 'operator-launch-refusal' ? current : null;
}
module.exports = { recordRefusal };
