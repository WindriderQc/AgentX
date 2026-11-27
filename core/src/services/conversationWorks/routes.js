'use strict';

const { isTranslationSession } = require('../../../../shared/quotedTranslation.cjs');
const { tokenMatches, fail } = require('./contract');
const { requireProtectedBackend, nativeInputOnly, sourceTransferError } = require('../conversations/protectedSources');
const { isNativeToolCallId } = require('../../../../shared/nativeToolCallId.cjs');
const { isDelegationTool } = require('../../../../shared/nativeDelegation.cjs');
const { createWorkDelivery } = require('./delivery');

function registerConversationWorkRoutes(router, { works, env = process.env, isForegroundRun }) {
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
  router.post('/private/sessions/:sessionId/work/:workId/questions',
    handle(req => works.questions.submit(req.params.sessionId, req.params.workId, req.body)));
  router.post('/private/sessions/:sessionId/work/:workId/question-intents/:intentId/resume',
    handle(req => works.questions.resume(req.params.sessionId, req.params.workId, req.params.intentId, req.body)));
  router.get('/private/sessions/:sessionId/work/:workId/question-intents/:intentId',
    handle(req => works.questions.lookup(req.params.sessionId, req.params.workId, req.params.intentId)));
  router.post('/native/work', handle(async req => {
    const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '')?.[1];
    const explicit = nativeInputOnly('openclaw', env);
    if (!tokenMatches(token, env.PERSONAL_CONVERSATION_WORK_TOKEN)) {
      if (explicit) throw fail('CONVERSATION_WORK_UNAUTHORIZED', 'Conversation work unavailable.', 403);
      throw fail('CONVERSATION_WORK_NOT_FOUND', 'Conversation work not found.', 404);
    }
    if (isTranslationSession(req.body?.context?.sessionKey)) throw fail('CONVERSATION_WORK_NOT_FOUND', 'Conversation work not found.', 404);
    requireProtectedBackend('openclaw', env);
    const { operation, context, input, callId } = req.body || {};
    if (Object.keys(req.body || {}).some(key => !['operation', 'context', 'input', 'callId'].includes(key))) throw fail('CONVERSATION_WORK_REQUEST_INVALID', 'Invalid work request.');
    if (explicit) {
      // A foreground check returns only a control decision. Worker/source handlers below remain inaccessible.
      if (!['guardian_tool', 'native_budget'].includes(operation) || !isNativeToolCallId(callId)
          || !input || Object.keys(input).length !== 1 || !isDelegationTool(input.tool)
          || !context || Object.keys(context).some(k => !['agentId', 'sessionKey', 'runId'].includes(k))
          || isForegroundRun?.(context) !== true) throw sourceTransferError();
      return operation === 'guardian_tool'
        ? { authority: 'core.conversation-works', foreground: true, delegated: false }
        : { authority: 'core.conversation-works', foreground: true, admitted: true };
    }
    if (operation === 'question_context') return works.questions.context(input);
    if (operation === 'question_effect') return works.questions.claim(input);
    if (operation === 'request') return works.request(context);
    if (operation === 'context') return works.contextForWorker(context);
    if (operation === 'native_context') return works.contextForNative(context, callId);
    if (operation === 'native_owner') return works.nativeOwner(context);
    if (operation === 'guardian_tool') return works.guardianTool(context);
    if (operation === 'guardian_tools') return works.guardianTools(context);
    if (operation === 'guardian_read') return works.guardianRead(context, input, callId);
    if (operation === 'tasks') return works.readTasks(context, input, callId);
    if (operation === 'evidence') return works.readEvidence(context, input);
    if (operation === 'native_budget') return works.admitNativeTool(context, input, callId);
    if (operation === 'publish') return works.publish(context, input);
    throw fail('CONVERSATION_WORK_OPERATION_INVALID', 'Unknown work operation.');
  }));
  return delivery;
}
module.exports = { registerConversationWorkRoutes };
