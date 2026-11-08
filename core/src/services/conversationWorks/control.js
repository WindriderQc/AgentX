'use strict';
const { fail, notFound, hash, LIMITS } = require('./contract');
function createWorkControl(works) {
  return async function control(sessionId, id, input) {
    await works.session(sessionId);
    if (!input || Object.keys(input).some(key => !['version', 'action', 'revision', 'requestId', 'requestSha256', 'workId'].includes(key))
        || input.version !== 2
        || !['pause', 'resume', 'cancel'].includes(input.action) || !Number.isSafeInteger(input.revision) || input.revision < 0
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId || '')
        || !/^[a-f0-9]{64}$/.test(input.requestSha256 || '') || input.workId !== id) {
      throw fail('CONVERSATION_WORK_CONTROL_INVALID', 'Refresh this conversation and select the current request controls.');
    }
    const fingerprint = hash(JSON.stringify([id, sessionId, input.action, input.revision, input.requestSha256]));
    const row = await works.repo.mutate(id, async current => {
      if (current.sessionId !== sessionId) throw notFound();
      const previous = current.controlReceipts?.find(receipt => receipt.requestId === input.requestId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw fail('CONVERSATION_WORK_CONTROL_CONFLICT', 'The command identity belongs to another control.', 409);
        return null;
      }
      if (current.revision !== input.revision) throw fail('CONVERSATION_WORK_CONTROL_STALE', 'Read the current work before changing it.', 409);
      if (current.requestSha256 !== input.requestSha256 || await works.requestTextForDisplay(current) === null) {
        throw fail('CONVERSATION_WORK_CONTROL_REQUEST_UNAVAILABLE', 'The exact canonical request must be available before changing its work.', 409);
      }
      if (current.classification === 'native_only' || current.attempt || !['received', 'queued', 'paused'].includes(current.state)) {
        throw fail('CONVERSATION_WORK_ALREADY_DISPATCHED', 'Native work has already started or settled; its owner must reconcile it.', 409);
      }
      if (input.action === 'resume' && current.state !== 'paused' || input.action === 'pause' && current.state === 'paused') {
        throw fail('CONVERSATION_WORK_CONTROL_CONFLICT', 'The requested control does not match its current state.', 409);
      }
      // Never discard an older command receipt to make room for a new one.
      // Reserve the last slot for cancellation before dispatch.
      if ((current.controlReceipts?.length || 0) >= LIMITS.events - (input.action === 'cancel' ? 0 : 1)) {
        throw fail('CONVERSATION_WORK_CONTROL_LIMIT', 'The retained control budget is exhausted. Cancellation remains available before dispatch.', 409);
      }
      const state = input.action === 'cancel' ? 'cancelled' : input.action === 'pause' ? 'paused' : current.contextReady ? 'queued' : 'received';
      const receipt = { version: 2, requestId: input.requestId, fingerprint, workId: id, action: input.action,
        requestSha256: current.requestSha256, baseRevision: current.revision, revision: current.revision + 1, state };
      return { fields: { state, reason: input.action === 'cancel' ? 'owner_cancelled_before_dispatch' : '',
        controlReceipts: [...(current.controlReceipts || []), receipt] }, event: 'owner_' + input.action,
        eventData: { requestId: input.requestId } };
    });
    works.wake();
    const { fingerprint: _, ...commandReceipt } = row.controlReceipts.find(receipt => receipt.requestId === input.requestId);
    // A replay reads the original result, even if a later command changed state.
    return { authority: 'core.conversation-works', id: row._id, state: commandReceipt.state,
      revision: commandReceipt.revision, commandReceipt };
  };
}
module.exports = { createWorkControl };
