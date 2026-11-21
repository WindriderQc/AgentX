import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const localHost = '127.0.0.1';
const route = '/mcp';
const keyHeader = 'x-api-key';
const versions = ['2025-03-26', '2025-06-18', '2025-11-25'];
const tool = {
  name: 'janitor_report_view',
  description: 'Read the latest stored DiskX Janitor report date and its direct link on the private network. This is a read-only operation.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => Number.isSafeInteger(value) || (typeof value === 'string' && value.length <= 128);
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const textContent = text => [{ type: 'text', text }];

function checkedOrigin(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new Error('Expected an origin without credentials or a path');
  }
  return url;
}

function send(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

class BodyTooLarge extends Error {}

async function readJson(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw new BodyTooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
}

function reportProjection(report, linkOrigin) {
  if (!record(report) || report.readOnly !== true || typeof report.available !== 'boolean' || typeof report.status !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,47}$/.test(report.status)) {
    throw new Error('Invalid Core report');
  }
  const view = { available: report.available, status: report.status, readOnly: true, source: 'AgentX Core / Data Janitor' };
  if (!report.available) return { ...view, generatedAt: null, link: null };

  const stamp = report.generatedAt;
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(stamp) ||
      new Date(stamp).toISOString() !== stamp || typeof report.link !== 'string') {
    throw new Error('Invalid Core report date');
  }
  const link = new URL(report.link, linkOrigin);
  if (link.origin !== linkOrigin.origin || link.pathname !== '/diskx' || link.username || link.password ||
      link.hash || [...link.searchParams].length !== 2 || link.searchParams.get('janitor') !== 'latest' ||
      link.searchParams.get('report') !== stamp) {
    throw new Error('Unexpected Core report link');
  }
  return { ...view, generatedAt: stamp, link: link.href, linkScope: 'private_network' };
}

async function readLatestReport({ ownerEndpoint, linkOrigin, fetchCore }) {
  const id = randomUUID();
  const response = await fetchCore(ownerEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-service-caller': 'claude-ai-diskx',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name, arguments: {} },
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Core request failed');
  }
  const reply = await readJson(response.body, 32768);
  if (reply?.jsonrpc !== '2.0' || reply.id !== id || reply.error || reply.result?.isError !== false) {
    throw new Error('Core tool failed');
  }
  return reportProjection(reply.result.structuredContent, linkOrigin);
}

async function dispatch(message, upstream) {
  const { id, method, params = {} } = message;
  if (!record(params)) return rpcError(id, -32602, 'Invalid params');
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
        capabilities: { tools: {} },
        serverInfo: { name: 'agentx-diskx', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: [tool] });
    case 'tools/call': {
      const { name, arguments: args = {} } = params;
      if (name !== tool.name || !record(args) || Object.keys(args).length !== 0) {
        return rpcError(id, -32602, 'Only janitor_report_view with empty arguments is available');
      }
      try {
        const report = await readLatestReport(upstream);
        return rpcResult(id, { content: textContent(JSON.stringify(report)), structuredContent: report, isError: false });
      } catch {
        return rpcResult(id, { content: textContent('AgentX could not verify the stored Janitor report.'), isError: true });
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found');
  }
}

/** The HTTPS front door must rewrite Host to this listener's loopback address. */
export function createDiskxMcpServer({ key, coreOrigin, linkOrigin, fetchCore = fetch }) {
  if (!validKey(key)) throw new Error('Expected a 256-bit lowercase hexadecimal relay key');
  const secret = Buffer.from(key, 'hex');
  const upstream = {
    ownerEndpoint: new URL('/api/consumers/nestor/v1/mcp', checkedOrigin(coreOrigin, ['http:', 'https:'])),
    linkOrigin: checkedOrigin(linkOrigin, ['https:']),
    fetchCore,
  };

  const server = createServer({ requestTimeout: 12000, headersTimeout: 5000 }, async (request, response) => {
    const { headers, method, url } = request;
    if (url !== route) return send(response, 404, { error: 'Not found' });
    if (headers.host !== `${localHost}:${request.socket.localPort}` ||
        (headers.origin !== undefined && headers.origin !== 'https://claude.ai')) {
      return send(response, 403, { error: 'Forbidden' });
    }
    const supplied = headers[keyHeader];
    if (!validKey(supplied) || !timingSafeEqual(secret, Buffer.from(supplied, 'hex'))) {
      return send(response, 401, { error: 'Authentication required' });
    }
    if (method !== 'POST') return send(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    if (headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return send(response, 415, { error: 'Expected application/json' });
    }
    if (Number(headers['content-length']) > 4096) {
      return send(response, 413, { error: 'Request too large' }, { Connection: 'close' });
    }

    let message;
    try {
      message = await readJson(request.iterator({ destroyOnReturn: false }), 4096);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        return send(response, 413, { error: 'Request too large' }, { Connection: 'close' });
      }
      return send(response, 400, rpcError(null, -32700, 'Parse error'));
    }
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return send(response, 400, rpcError(null, -32600, 'Invalid request'));
    }
    const version = headers['mcp-protocol-version'];
    if (message.method !== 'initialize' && version !== undefined && !versions.includes(version)) {
      return send(response, 400, rpcError(null, -32600, 'Unsupported MCP protocol version'));
    }
    if (message.id === undefined && ['notifications/initialized', 'notifications/cancelled'].includes(message.method)) {
      return send(response, 202);
    }
    if (!validId(message.id)) return send(response, 400, rpcError(null, -32600, 'Invalid request id'));
    return send(response, 200, await dispatch(message, upstream));
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.AGENTX_DISKX_MCP_PORT ?? '8313');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port');
  const server = createDiskxMcpServer({
    key: readFileSync(process.env.AGENTX_DISKX_MCP_KEY_FILE, 'utf8').trim(),
    coreOrigin: process.env.AGENTX_DISKX_MCP_CORE_ORIGIN ?? 'http://127.0.0.1:3180',
    linkOrigin: process.env.AGENTX_DISKX_MCP_LINK_ORIGIN,
  });
  server.listen(port, localHost, () => console.log(`DiskX MCP listening on ${localHost}:${port}`));
}
