'use strict';

const http = require('node:http');
const { classifyFailure, createBroker } = require('./broker');

const MAX_REQUEST_BYTES = 4_000_000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      const error = new Error('request exceeds 4000000 bytes');
      error.code = 'REQUEST_TOO_LARGE'; error.statusCode = 413; throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    const error = new Error('request body must be JSON'); error.code = 'INVALID_JSON'; error.statusCode = 400; throw error;
  }
}

function createServer(options = {}) {
  const broker = options.broker || createBroker({
    configPath: options.configPath || requiredEnv('BENCHMARK_HARNESS_TARGETS_PATH'),
    auditPath: options.auditPath || requiredEnv('BENCHMARK_HARNESS_AUDIT_PATH'),
    ledgerPath: options.ledgerPath || requiredEnv('BENCHMARK_HARNESS_SPEND_LEDGER_PATH'),
    signingKey: options.signingKey || String(process.env.AGENTX_BENCHMARK_SPEND_SIGNING_KEY || '')
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://broker.invalid');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const catalog = await broker.catalog();
        return send(res, 200, { status: 'success', data: { ok: true, service: 'aiops-benchmark-harness-broker', targetCount: catalog.targets.length } });
      }
      if (req.method === 'GET' && url.pathname === '/v1/benchmark/targets') {
        return send(res, 200, { status: 'success', data: await broker.catalog() });
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/spend-grants') {
        const request = await readJson(req);
        return send(res, 201, { status: 'success', data: await broker.issueSpendGrant(request) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/benchmark/execute') {
        const request = await readJson(req);
        if (request?.schema !== 'agentx.harness-execution/v1' || Number(request.schemaVersion) !== 1) {
          const error = new Error('agentx.harness-execution/v1 request is required'); error.code = 'INVALID_REQUEST_SCHEMA'; error.statusCode = 400; throw error;
        }
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded) controller.abort(); };
        req.once('aborted', onClose);
        res.once('close', onClose);
        const result = await broker.execute(request, { signal: controller.signal });
        return send(res, 200, { status: 'success', data: result });
      }
      return send(res, 404, { status: 'error', code: 'NOT_FOUND', error: 'Not found' });
    } catch (error) {
      return send(res, Number(error.statusCode) || 500, {
        status: 'error', code: error.code || 'BROKER_ERROR', error: error.message,
        failure: { classification: error.failureClassification || classifyFailure(error.code), code: error.code || 'BROKER_ERROR' }
      });
    }
  });
}

if (require.main === module) {
  const host = String(process.env.BENCHMARK_HARNESS_BIND || '127.0.0.1');
  const port = Number(process.env.BENCHMARK_HARNESS_PORT || 3091);
  const server = createServer();
  server.listen(port, host, () => process.stdout.write(`benchmark-harness-broker listening on ${host}:${port}\n`));
}

module.exports = { createServer, readJson };
