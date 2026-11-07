'use strict';

const { exactPipelineId, exactRequestId, CodingDispatchControlError } = require('./coding-dispatch-control');
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (message, statusCode = 400) => {
  throw new CodingDispatchControlError(message, { code: 'CODING_SESSION_INVALID_REQUEST', statusCode });
};

/** Native transport bound to one existing Core executor/request; no owner failover. */
class CodingSessionsControl {
  constructor(control) { this.control = control; }
  async call(action, input) {
    if (!['list', 'read', 'handoff'].includes(action)) fail('Invalid native session operation.');
    const pipelineId = exactPipelineId(input.pipelineId);
    const requestId = exactRequestId(input.requestId);
    if (!ID.test(input.executorId || '')) fail('The original executor is required.');
    const executor = this.control.executor(input.executorId);
    if (executor.harness !== 'opencode') fail('Native OpenCode histories are unavailable for this executor.', 409);
    let suffix = '';
    if (action !== 'list') suffix = ` ${exactRequestId(input.invocationId)}`;
    if (action === 'read') {
      const offset = input.offset === undefined ? '0' : String(input.offset);
      if (!/^\d{1,5}$/.test(offset)) fail('Invalid history offset.');
      if (input.revision !== undefined && !HASH.test(input.revision)) fail('Invalid history revision.');
      suffix += ` ${offset} ${input.revision || '-'}`;
    } else if (action === 'handoff') {
      if (input.confirm !== true) fail('Confirm the independent human copy.');
      if (!HASH.test(input.revision || '')) fail('The exact source revision is required.');
      suffix += ` ${exactRequestId(input.handoffRequestId)} ${input.revision}`;
    }
    const data = await this.control.call(executor,
      `/usr/bin/python3 ${executor.remoteRoot}/integrations/coding/coding_sessions_control.py ${action} ${pipelineId} ${requestId} ${executor.id}${suffix}`,
      action === 'handoff' ? { timeoutMs: 180_000 } : {});
    if (data.pipelineId !== pipelineId || data.requestId !== requestId || data.executorId !== executor.id
        || action !== 'list' && data.invocationId !== input.invocationId
        || action === 'handoff' && data.handoffRequestId !== input.handoffRequestId)
      fail('The native response does not match the original request.', 503);
    return data;
  }
}

function registerCodingSessionsRoutes({ router, control, logger }) {
  const sessions = new CodingSessionsControl(control);
  const respond = (action, input) => async (req, res) => {
    try {
      const data = await sessions.call(action, input(req));
      res.set?.('Cache-Control', 'no-store');
      return res.json({ status: 'success', data });
    } catch (error) {
      const status = Number(error.statusCode) || 500;
      const code = error.code || 'CODING_SESSION_UNAVAILABLE';
      if (status >= 500) logger?.warn?.('Native coding session read unavailable', { code });
      return res.status(status).json({ status: 'error', message: error.message || 'Native session unavailable', error: { code } });
    }
  };
  router.get('/runs/:requestId/sessions', respond('list', req => ({ ...req.query, requestId: req.params.requestId })));
  router.get('/runs/:requestId/sessions/:invocationId', respond('read', req => ({ ...req.query, ...req.params })));
  router.post('/runs/:requestId/sessions/:invocationId/handoff', respond('handoff', req => ({ ...req.body, ...req.params })));
  return router;
}

module.exports = { CodingSessionsControl, registerCodingSessionsRoutes };
