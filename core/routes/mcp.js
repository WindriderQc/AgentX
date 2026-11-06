const express = require('express');
const router = express.Router();
const { handleMcpMessage } = require('../src/services/mcpSkillBus');
const { countExchange } = require('../src/services/agentToolUsage');

router.post(['/', '/memory'], async (req, res) => {
  if (Array.isArray(req.body)) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Batch JSON-RPC is not supported by this MCP endpoint' },
    });
  }

  const bus = req.path.replace(/\/$/, '').toLowerCase() === '/memory' ? 'memory' : 'general';
  try {
    const response = bus === 'memory'
      ? await handleMcpMessage(req.body || {}, {}, { profile: 'memory' })
      : await handleMcpMessage(req.body || {});
    countExchange(bus, req, response);
    if (!response) return res.status(202).end();
    return res.type('application/json').json(response);
  } catch (err) {
    countExchange(bus, req, { error: { code: -32603 } });
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message || 'Internal error' },
    });
  }
});

router.get(['/', '/memory'], (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'SSE stream is not supported; use POST for Streamable HTTP requests' },
  });
});

module.exports = router;
