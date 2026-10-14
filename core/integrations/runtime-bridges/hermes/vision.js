'use strict';

const { requestAbort, sendRuntimeError } = require('../common');

const { invalid, VISION_MODEL, visionMessages, visionCompletion, analyzeImages } = require('../../../src/services/imageAnalysisService');

function registerHermesVision(router, { runtimeServices, logger }) {
  router.get('/vision/v1/models', (_req, res) => res.json({ object: 'list', data: [
    { id: VISION_MODEL, object: 'model', owned_by: 'agentx-openclaw' }
  ] }));
  router.post('/vision/v1/chat/completions', async (req, res) => {
    const abort = requestAbort(req, res);
    try {
      const body = req.body || {};
      if (body.model !== VISION_MODEL) throw invalid(`Vision model must be ${VISION_MODEL}.`);
      if (body.tools?.length || body.tool_choice) throw invalid('Vision analysis does not accept caller tool schemas.');
      const { result } = await analyzeImages({ messages: body.messages, signal: abort.signal, runtimeServices });
      const completion = visionCompletion(result);
      res.set({ 'X-AgentX-Execution-Source': 'openclaw', 'X-AgentX-Resolved-Agent': 'main',
        'X-AgentX-Native-Run-Id': result.body.executionReceipt.runId });
      if (body.stream !== true) return res.json(completion);
      // The native agent can rewrite progress; expose only its verified final answer.
      res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform' });
      const chunk = { ...completion, object: 'chat.completion.chunk', choices: [
        { index: 0, delta: completion.choices[0].message, finish_reason: 'stop' }
      ] };
      return res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      return sendRuntimeError(res, error, logger, 'Hermes vision');
    } finally { abort.cleanup(); }
  });
}

module.exports = { VISION_MODEL, visionMessages, visionCompletion, registerHermesVision };
