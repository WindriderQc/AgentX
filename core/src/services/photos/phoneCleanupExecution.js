'use strict';

// The native adapter performs only exact transport/USB operations. Core owns
// selection, backup verification, dispatch identity and result reconciliation.
const crypto = require('node:crypto');
const { fail } = require('./importFiles');

async function executePhoneCleanup({ input, remote, source, remove, enabled }) {
  if (enabled !== true) throw fail('CLEANUP_DISABLED', 'Phone cleanup is not enabled on this collector');
  const plan = await remote({ action: 'library' }, { json: { op: 'plan', planId: input.planId } });
  if (input.digest !== plan.digest || input.confirmation !== plan.confirmation)
    throw fail('CONFIRMATION_REQUIRED', 'Confirm the exact selection');
  const record = async (result) => {
    const item = plan.items.find((x) => x.requestId === result.requestId);
    if (
      !item ||
      result.state !== 'deleted' ||
      result.operationId !== input.operationId ||
      result.planId !== plan.planId ||
      result.digest !== plan.digest ||
      result.sha256 !== item.sha256
    )
      throw fail('CLEANUP_UNCERTAIN', 'Native receipt differs from its selected source');
    return remote({ action: 'library' }, { json: { op: 'deleted', ...result } });
  };
  let current = await remote({ action: 'library' }, { json: { op: 'cleanupStatus', planId: plan.planId } });
  if (remove.reconcile)
    for (const item of plan.items) {
      if (current.results.find((x) => x.requestId === item.requestId)?.state === 'deleted') continue;
      const result = await remove.reconcile({ operationId: input.operationId, item });
      if (result) await record(result);
    }
  current = await remote({ action: 'library' }, { json: { op: 'cleanupStatus', planId: plan.planId } });
  if (current.deleted === plan.items.length) return current;
  const devices = await source.devices();
  const matches = devices.filter(
    (d) => crypto.createHash('sha256').update(d.id).digest('hex') === plan.deviceKey,
  );
  if (matches.length !== 1)
    throw fail('PHONE_UNAVAILABLE', 'Reconnect the same phone in USB file-transfer mode');
  const deviceId = matches[0].id;
  const inventory = await source.inventory(deviceId);
  if (!inventory.complete || inventory.errors.length)
    throw fail('INCOMPLETE_PHONE_INVENTORY', 'Phone inventory must complete before cleanup');
  for (const item of plan.items) {
    const lookup = { op: 'cleanupStatus', planId: plan.planId };
    const status = await remote({ action: 'library' }, { json: lookup });
    if (status.results.find((x) => x.requestId === item.requestId)?.state === 'deleted') continue;
    const fresh = inventory.files.filter((x) => x.key === item.key && x.relativePath === item.relativePath);
    // Reconcile an existing local success before needing a surviving source:
    // a previously deleted file may correctly be absent after a lost reply.
    const request = {
      operationId: input.operationId,
      planId: plan.planId,
      digest: plan.digest,
      deviceId,
      item: { ...item, objectId: fresh.length === 1 ? fresh[0].objectId : null },
    };
    const result = await remove(request, async (ready) => {
      if (
        fresh.length !== 1 ||
        fresh[0].name !== item.name ||
        fresh[0].size !== item.size ||
        fresh[0].modified !== item.modified ||
        ready.sha256 !== item.sha256 ||
        ready.size !== item.size
      )
        throw fail('SOURCE_CHANGED', 'Phone file changed after backup');
      return remote(
        { action: 'library' },
        {
          json: {
            op: 'authorize',
            planId: plan.planId,
            operationId: input.operationId,
            requestId: item.requestId,
            digest: plan.digest,
            confirmation: input.confirmation,
            sha256: ready.sha256,
            attemptId: ready.attemptId,
          },
        },
      );
    });
    if (
      result.state !== 'deleted' ||
      result.operationId !== input.operationId ||
      result.planId !== plan.planId ||
      result.digest !== plan.digest ||
      result.requestId !== item.requestId ||
      result.sha256 !== item.sha256
    )
      throw fail('CLEANUP_UNCERTAIN', 'Native deletion receipt does not match the selected source');
    await record(result);
  }
  return remote({ action: 'library' }, { json: { op: 'cleanupStatus', planId: plan.planId } });
}

module.exports = { executePhoneCleanup };
