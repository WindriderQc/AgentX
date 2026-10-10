'use strict';
const { fail, notFound } = require('./contract');
function createWorkControl(works) {
  return async function control(sessionId, id, input) {
    await works.session(sessionId);
    if (!input || Object.keys(input).some(key => !['action', 'revision'].includes(key))
        || !['pause', 'resume', 'cancel'].includes(input.action) || !Number.isInteger(input.revision)) {
      throw fail('CONVERSATION_WORK_CONTROL_INVALID', 'An exact work control is required.');
    }
    const row = await works.repo.mutate(id, current => {
      if (current.sessionId !== sessionId) throw notFound();
      if (current.revision !== input.revision) throw fail('CONVERSATION_WORK_CONTROL_STALE', 'Read the current work before changing it.', 409);
      if (current.classification === 'native_only' || current.attempt || !['received', 'queued', 'paused'].includes(current.state)) {
        throw fail('CONVERSATION_WORK_ALREADY_DISPATCHED', 'Native work has already started or settled; its owner must reconcile it.', 409);
      }
      if (input.action === 'resume' && current.state !== 'paused' || input.action === 'pause' && current.state === 'paused') {
        throw fail('CONVERSATION_WORK_CONTROL_CONFLICT', 'The requested control does not match its current state.', 409);
      }
      const state = input.action === 'cancel' ? 'cancelled' : input.action === 'pause' ? 'paused' : current.contextReady ? 'queued' : 'received';
      return { fields: { state, reason: input.action === 'cancel' ? 'owner_cancelled_before_dispatch' : '' }, event: 'owner_' + input.action };
    });
    works.wake();
    return { authority: 'core.conversation-works', id: row._id, state: row.state, revision: row.revision };
  };
}
module.exports = { createWorkControl };
