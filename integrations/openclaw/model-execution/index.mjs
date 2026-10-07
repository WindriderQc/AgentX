import { definePluginEntry } from 'openclaw/plugin-sdk/core';
import { createNativeBackend } from './native.mjs';
import { createExecutionService } from './service.mjs';
import { createSpendLedger } from './ledger.mjs';

export function registerExecutionRoutes(api, { backend = createNativeBackend(api), ledger = createSpendLedger() } = {}) {
  const service = createExecutionService({ backend, catalogTtlSeconds: api.pluginConfig?.catalogTtlSeconds || 300,
    maxRequestCostNanodollars: api.pluginConfig?.maxRequestCostNanodollars || 0, ledger });
  const send = (res, status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  api.registerHttpRoute({ path: '/api/agentx/execution/models', auth: 'gateway', match: 'exact', handler: async (req, res) => {
    if (req.method !== 'GET') return send(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    try { send(res, 200, await service.catalogue()); }
    catch { send(res, 503, { code: 'OPENCLAW_NATIVE_CATALOG_UNAVAILABLE' }); }
  } });
  api.registerHttpRoute({ path: '/api/agentx/execution/model', auth: 'gateway', match: 'exact', handler: async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    let streaming = false;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > (api.pluginConfig?.maxRequestBytes || 2_000_000)) throw Object.assign(new Error('REQUEST_TOO_LARGE'), { statusCode: 413 });
        chunks.push(chunk);
      }
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      streaming = request.stream === true;
      const emit = event => {
        if (!streaming || controller.signal.aborted) return;
        if (!res.headersSent) { res.statusCode = 200; res.setHeader('content-type', 'text/event-stream'); res.setHeader('cache-control', 'no-store'); }
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      const result = await service.execute(request, { signal: controller.signal, emit });
      if (streaming) { if (!res.headersSent) emit({ type: 'completed', result }); res.end(); }
      else send(res, 200, result);
    } catch (error) {
      const body = { schema: 'agentx.openclaw-model-error/v1',
        partialResponse: error.partialResponse || '', partialThinking: error.partialThinking || '', code: error.code || (error instanceof SyntaxError ? 'OPENCLAW_REQUEST_INVALID' : 'OPENCLAW_EXECUTION_FAILED'),
        executionState: error.executionState || 'not-dispatched', reservation: error.reservation || null };
      if (res.headersSent) { if (!controller.signal.aborted) res.end(`data: ${JSON.stringify({ type: 'error', ...body })}\n\n`); }
      else send(res, error.statusCode || 400, body);
    } finally { res.removeListener('close', abort); }
  } });
}

export default definePluginEntry({ id: 'agentx-model-execution', name: 'AgentX model execution',
  description: 'Native model execution without an agent loop; Core retains canonical conversations and context.',
  register: registerExecutionRoutes });
