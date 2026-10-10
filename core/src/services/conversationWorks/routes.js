'use strict';

const { tokenMatches, fail } = require('./contract');
const { createWorkDelivery } = require('./delivery');

function registerConversationWorkRoutes(router, { works, env = process.env }) {
  const delivery = createWorkDelivery(works);
  const control = require('./control').createWorkControl(works);
  const handle = action => async (req, res) => {
    try { res.json({ ok: true, status: 'success', data: await action(req) }); }
    catch (cause) { res.status(cause.statusCode || 503).json({ ok: false, status: 'error',
      code: cause.code || 'CONVERSATION_WORK_UNAVAILABLE', message: cause.statusCode ? cause.message : 'Conversation work is unavailable.' }); }
  };
  router.get('/private/sessions/:sessionId/work', handle(req => delivery.snapshot(req.params.sessionId, req.query.cursor)));
  router.post('/private/sessions/:sessionId/work-deliveries/:deliveryId/receipt',
    handle(req => delivery.receipt(req.params.sessionId, req.params.deliveryId, req.body)));
  router.post('/private/sessions/:sessionId/work/:workId/control',
    handle(req => control(req.params.sessionId, req.params.workId, req.body)));
  router.post('/native/work', handle(async req => {
    const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
    if (!tokenMatches(token, env.PERSONAL_CONVERSATION_WORK_TOKEN)) throw fail('CONVERSATION_WORK_NOT_FOUND', 'Conversation work not found.', 404);
    const { operation, context, input, callId } = req.body || {};
    if (Object.keys(req.body || {}).some(key => !['operation', 'context', 'input', 'callId'].includes(key))) throw fail('CONVERSATION_WORK_REQUEST_INVALID', 'Invalid work request.');
    if (operation === 'request') return works.request(context);
    if (operation === 'context') return works.contextForWorker(context);
    if (operation === 'tasks') return works.readTasks(context, input, callId);
    if (operation === 'publish') return works.publish(context, input);
    throw fail('CONVERSATION_WORK_OPERATION_INVALID', 'Unknown work operation.');
  }));
  return delivery;
}
module.exports = { registerConversationWorkRoutes };
