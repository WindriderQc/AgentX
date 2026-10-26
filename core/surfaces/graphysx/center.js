'use strict';

// The GraphysX Center on a Core page, and Nestor's push into it (phase 2 of GraphysX's
// docs/NESTOR_PROPOSALS.md).
//
// `/graphysx` frames the Center from `GRAPHYSX_CENTER_URL` and loads `<graphysx-center>`, the
// host end of the bridge GraphysX publishes at `/embed/center-host.js`, relayed here from Core's
// own origin like `diskx.js`. Both ends of the bridge ship from one GraphysX build; Core carries
// no copy of the protocol. On this page the Center's request field asks `POST /api/graphysx/propose`
// same-origin — no key, no relay, no cross-site POST — and Core can reach the page:
//
//   GET  /api/graphysx/center/events     one stream per open page; Core says hello with a page id
//   POST /api/graphysx/center/state      the page's revision and bounded scene summary (ids, types,
//                                        labels; never the document), whenever they change
//   POST /api/graphysx/center/receipts   what the Center did with a pushed proposal
//
// The tool `propose_world_change` is what Nestor calls when, in a conversation, it announces an
// intention on the world. Core composes against the most recently active page's reported scene,
// through the same prompt and validation as a typed request, and pushes the result on that
// page's stream. The Center shows it as a card attributed to Nestor · Core, inert until a person
// presses Apply there, and sends a receipt — shown, shown but stale, or refused — which the tool
// relays so Nestor never claims more than happened. Core applies nothing and keeps no scene.
//
// Pages are process memory, like live sessions in GraphysX: a Core restart forgets them and loses
// nothing, since nothing here is authored. Full profile only; a family-pinned device cannot open
// the page or its routes (family-device.js), like DiskX.

const path = require('path');
const crypto = require('crypto');
const { createScriptRelay, configuredModuleUrl } = require('../household/asset-relay');

const PAGE = '/graphysx';
const API_BASE = '/api/graphysx';
const HOST_MODULE_ROUTE = `${API_BASE}/center-host.js`;
const EVENTS_ROUTE = `${API_BASE}/center/events`;
const STATE_ROUTE = `${API_BASE}/center/state`;
const RECEIPTS_ROUTE = `${API_BASE}/center/receipts`;
/** The host module is a few KB; well under the shared relay cap, bounded tighter here. */
const HOST_MODULE_MAX_BYTES = 512 * 1024;
const MAX_PAGES = 8;
const HEARTBEAT_MS = 25_000;
/** How long the tool waits for the Center's receipt before answering "unconfirmed". */
const RECEIPT_WAIT_MS = 5_000;
const REQUEST_CHARS = 2000;
const PUSH_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const TOOL_NAME = 'propose_world_change';
const NESTOR_ACTOR = Object.freeze({ id: 'nestor', label: 'Nestor · Core', kind: 'agent' });
const CENTER_MCP_META = Object.freeze({
  'agentx/owner': 'agentx-graphysx',
  'agentx/version': '1.0.0',
  'agentx/capability': 'nestor-graphysx-center'
});

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const escapeAttribute = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function invalid(message, code = 'INVALID_CENTER_REQUEST') {
  return Object.assign(new Error(message), { status: 400, code });
}

/** The Center's URL, e.g. https://graphysx.example/ — the page framed, and the origin the host module comes from. */
function centerUrl(env = process.env) {
  return configuredModuleUrl(env, 'GRAPHYSX_CENTER_URL', 'GRAPHYSX_CENTER_NOT_CONFIGURED', 'GraphysX Center');
}

/** `/embed/center-host.js` of the same build the Center is served from, so both ends of the bridge match. */
function hostModuleUrl(env = process.env) {
  return `${new URL(centerUrl(env)).origin}/embed/center-host.js`;
}

/**
 * The page's Content-Security-Policy with the Center's origin allowed as a frame. Core's policy
 * has no `frame-src`, so `default-src 'self'` would refuse the iframe; this page alone names one
 * origin. Without a policy nothing changes.
 */
function allowFrame(policy, origin) {
  if (!policy) return policy;
  const directives = String(policy).split(';').map((part) => part.trim()).filter(Boolean);
  const index = directives.findIndex((part) => /^frame-src(\s|$)/i.test(part));
  if (index === -1) directives.push(`frame-src 'self' ${origin}`);
  else if (!directives[index].split(/\s+/).includes(origin)) directives[index] = `${directives[index]} ${origin}`;
  return directives.join('; ');
}

function renderPage({ center }) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<title>GraphysX</title>
<link rel="stylesheet" href="/assets/graphysx/center.css">
<script type="module" src="${HOST_MODULE_ROUTE}"></script>
<script defer src="/assets/graphysx/center-page.js"></script>
</head>
<body>
<graphysx-center center="${escapeAttribute(center)}" api-base="${API_BASE}"></graphysx-center>
<p id="graphysx-status" role="status" aria-live="polite">Chargement du Centre GraphysX…</p>
<noscript><p>Le Centre GraphysX a besoin de JavaScript.</p></noscript>
</body>
</html>
`;
}

function errorPage(message) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>GraphysX</title><link rel="stylesheet" href="/assets/graphysx/center.css"></head>
<body><p id="graphysx-status" class="error" role="alert">${escapeAttribute(message)}</p></body></html>
`;
}

/**
 * The open pages: one entry per event stream, with the last scene summary the page reported and
 * the receipts the tool is waiting for. Bounded, in memory, forgotten on close.
 */
function createCenterRegistry({ now = () => Date.now(), maxPages = MAX_PAGES } = {}) {
  const pages = new Map();
  return {
    open(res) {
      if (pages.size >= maxPages) return null;
      const id = crypto.randomBytes(12).toString('hex');
      const page = { id, res, revision: null, scene: null, openedAt: now(), lastSeen: now(), waiters: new Map() };
      pages.set(id, page);
      return page;
    },
    close(id) {
      const page = pages.get(id);
      if (!page) return;
      pages.delete(id);
      for (const resolve of page.waiters.values()) resolve(null);
      page.waiters.clear();
    },
    get(id) { return pages.get(id) || null; },
    setState(id, { revision, scene }) {
      const page = pages.get(id);
      if (!page) return false;
      page.revision = revision;
      page.scene = scene;
      page.lastSeen = now();
      return true;
    },
    /** The page Core composes for: the one most recently heard from that has reported a scene. */
    mostRecent() {
      return [...pages.values()].filter((page) => page.scene !== null).sort((a, b) => b.lastSeen - a.lastSeen)[0] || null;
    },
    send(page, event, data) {
      if (!pages.has(page.id) || page.res.writableEnded || page.res.destroyed) return false;
      page.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    /** Resolves when the page's receipt for `pushId` arrives, with null after `waitMs` or when the page closes. */
    awaitReceipt(page, pushId, waitMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => { page.waiters.delete(pushId); resolve(null); }, waitMs);
        page.waiters.set(pushId, (receipt) => { clearTimeout(timer); page.waiters.delete(pushId); resolve(receipt); });
      });
    },
    receipt(id, body) {
      const page = pages.get(id);
      if (!page) return false;
      page.lastSeen = now();
      const resolve = page.waiters.get(body.id);
      if (resolve) resolve(body);
      return true;
    },
    get size() { return pages.size; },
    summary() {
      return [...pages.values()].map((page) => ({ id: page.id, revision: page.revision, entities: page.scene ? page.scene.entities.length : null, lastSeen: new Date(page.lastSeen).toISOString() }));
    }
  };
}

function checkReceipt(body) {
  if (!isRecord(body)) throw invalid('The body must be a receipt object');
  const unknown = Object.keys(body).filter((key) => !['pageId', 'id', 'status', 'proposalId', 'stale', 'reason'].includes(key));
  if (unknown.length) throw invalid(`Unknown field: ${unknown[0].slice(0, 40)}`);
  if (!text(body.pageId, 64) || !body.pageId) throw invalid('pageId is required');
  if (typeof body.id !== 'string' || !PUSH_ID_PATTERN.test(body.id)) throw invalid('id must name the pushed proposal');
  if (!['shown', 'refused'].includes(body.status)) throw invalid('status must be shown or refused');
  if (body.proposalId !== undefined && !text(body.proposalId, 400)) throw invalid('proposalId must be a short string');
  if (body.stale !== undefined && typeof body.stale !== 'boolean') throw invalid('stale must be a boolean');
  if (body.reason !== undefined && !text(body.reason, 400)) throw invalid('reason must be a short sentence');
  return {
    pageId: body.pageId, id: body.id, status: body.status,
    ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {}),
    ...(body.stale !== undefined ? { stale: body.stale } : {}),
    ...(body.reason !== undefined ? { reason: body.reason.trim().replace(/\s+/g, ' ') } : {})
  };
}

/**
 * Nestor's push. Composes for the most recent page through `compose` (the same prompt, inference
 * and validation as a typed request), sends the proposal on the page's stream and waits briefly
 * for the Center's receipt. Returns what Nestor may say — and no more.
 */
async function pushWorldProposal({ request }, { registry, compose, receiptWaitMs = RECEIPT_WAIT_MS }) {
  if (!text(request, REQUEST_CHARS) || !request.trim()) {
    throw Object.assign(new Error(`request must be a sentence of at most ${REQUEST_CHARS} characters`), { code: 'INVALID_ARGUMENTS' });
  }
  const page = registry.mostRecent();
  if (!page) {
    return { status: 'no-page', page: PAGE, message: `No GraphysX Center page is open on Core (${PAGE}). Nothing was proposed; ask the person to open it.` };
  }
  const composed = await compose({ request: request.trim(), revision: page.revision, scene: page.scene });
  if (!composed || !composed.ok) {
    return { status: 'declined', page: PAGE, reason: (composed && composed.reason) || 'The proposal could not be composed.', model: (composed && composed.model) || null };
  }
  const id = `push-${crypto.randomBytes(6).toString('hex')}`;
  const proposal = { id, actor: NESTOR_ACTOR, intent: composed.intent, commands: composed.commands, expectedRevision: page.revision, model: composed.model || null };
  const pending = registry.awaitReceipt(page, id, receiptWaitMs);
  if (!registry.send(page, 'proposal', proposal)) {
    registry.close(page.id);
    return { status: 'no-page', page: PAGE, message: 'The GraphysX Center page closed before the proposal reached it. Nothing was proposed.' };
  }
  const receipt = await pending;
  const delivery = receipt
    ? { status: receipt.status, ...(receipt.stale !== undefined ? { stale: receipt.stale } : {}), ...(receipt.reason ? { reason: receipt.reason } : {}), ...(receipt.proposalId ? { proposalId: receipt.proposalId } : {}) }
    : { status: 'unconfirmed', reason: 'The page has not acknowledged the proposal yet.' };
  return {
    status: 'proposed', id, page: PAGE, intent: composed.intent, commandCount: composed.commands.length,
    expectedRevision: page.revision, model: composed.model || null, delivery,
    note: 'A proposal card in the Center, inert until a person presses Apply there; Core applied nothing.'
  };
}

const TOOL = Object.freeze({
  name: TOOL_NAME,
  title: 'Propose A Change To The GraphysX World',
  description: 'Propose one change to the 3D world shown in the GraphysX Center page open on Core (/graphysx), as one request in plain words (for example "add a lake with a flock of birds at sunset"). Core composes world commands from GraphysX\'s own vocabulary and shows them in the page as a proposal card from Nestor; nothing is applied until the person presses Apply there, and the reply says whether the card was shown (delivery.status: shown, refused with a reason, or unconfirmed). Use it when the person asks to add, change or remove something in the 3D scene, or when you announce such an intention. Never say the change happened: say it is proposed. With no page open the reply says so; ask the person to open /graphysx.',
  inputSchema: {
    type: 'object',
    properties: { request: { type: 'string', minLength: 1, maxLength: REQUEST_CHARS, description: 'What should change in the world, as one request in the person\'s words or your own.' } },
    required: ['request'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  _meta: CENTER_MCP_META
});

function toolResult(structuredContent, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent, isError };
}

async function callCenterTool(args, deps) {
  try {
    if (!isRecord(args)) throw Object.assign(new Error('arguments must be an object'), { code: 'INVALID_ARGUMENTS' });
    return toolResult(await pushWorldProposal({ request: args.request }, deps));
  } catch (error) {
    return toolResult({ error: error.code || 'GRAPHYSX_CENTER_TOOL_ERROR', message: error.message }, true);
  }
}

/** tools/list with this tool appended once; a listing that already names it is left alone. */
function appendTool(body) {
  if (!Array.isArray(body?.result?.tools) || body.result.tools.some((tool) => tool?.name === TOOL_NAME)) return body;
  return { ...body, result: { ...body.result, tools: [...body.result.tools, TOOL] } };
}

/** Answers `propose_world_change` on Core's MCP transport and lists it; everything else passes through. */
function centerMcpMiddleware(deps) {
  return async (req, res, next) => {
    if (req.path && req.path !== '/') return next();
    const message = req.body;
    if (req.method !== 'POST' || !message || message.jsonrpc !== '2.0') return next();
    if (message.method === 'tools/list') {
      const downstreamJson = res.json.bind(res);
      res.json = (body) => downstreamJson(appendTool(body));
      return next();
    }
    if (message.method !== 'tools/call' || message.params?.name !== TOOL_NAME) return next();
    if (message.id === undefined || message.id === null) return res.status(204).end();
    const result = await callCenterTool(message.params?.arguments || {}, deps);
    return res.json({ jsonrpc: '2.0', id: message.id, result });
  };
}

function register({ app, express, env = process.env, fetchWithTimeout, checkScene, compose, registry = createCenterRegistry(), receiptWaitMs = RECEIPT_WAIT_MS, heartbeatMs = HEARTBEAT_MS }) {
  const fail = (res, error) => res.status(error.status || 500).json({ ok: false, status: 'error', code: error.code || 'GRAPHYSX_CENTER_FAILED', message: error.message });
  const jsonBody = express.json({ limit: '128kb' });

  app.use('/assets/graphysx', express.static(path.join(__dirname, 'public'), { fallthrough: false, maxAge: '5m' }));

  // The literal path, not PAGE: shared/navigationCoverage.test.js reads served pages from source.
  app.get('/graphysx', (_req, res) => {
    let center;
    try { center = centerUrl(env); } catch (error) {
      return res.status(error.status === 404 ? 503 : error.status || 503).type('html').set('Cache-Control', 'no-store')
        .send(errorPage('Le Centre GraphysX n’est pas configuré sur cette instance : définissez GRAPHYSX_CENTER_URL.'));
    }
    const policy = res.getHeader('Content-Security-Policy');
    if (policy) res.set('Content-Security-Policy', allowFrame(policy, new URL(center).origin));
    return res.type('html').set('Cache-Control', 'no-store').send(renderPage({ center }));
  });

  app.get(HOST_MODULE_ROUTE, createScriptRelay({
    resolveUrl: () => hostModuleUrl(env),
    fetchWithTimeout,
    requireScriptType: true,
    maxBytes: HOST_MODULE_MAX_BYTES,
    unavailable: (res, error) => res.status(error.status || 503).json({ ok: false, status: 'error', code: error.code || 'GRAPHYSX_CENTER_UNAVAILABLE', message: error.message })
  }));

  app.get(EVENTS_ROUTE, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const page = registry.open(res);
    if (!page) {
      // Finite: refused before the response is held open, so excess tabs cannot pin sockets.
      return res.status(429).type('application/json').send(JSON.stringify({ ok: false, status: 'error', code: 'GRAPHYSX_CENTER_PAGES_FULL', message: `At most ${MAX_PAGES} Center pages may be open at once.` }));
    }
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ pageId: page.id })}\n\n`);
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, heartbeatMs);
    res.on('close', () => { clearInterval(heartbeat); registry.close(page.id); });
    return undefined;
  });

  app.post(STATE_ROUTE, jsonBody, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const body = req.body;
      if (!isRecord(body)) throw invalid('The body must be a state object');
      const unknown = Object.keys(body).filter((key) => !['pageId', 'revision', 'scene'].includes(key));
      if (unknown.length) throw invalid(`Unknown field: ${unknown[0].slice(0, 40)}`);
      if (!text(body.pageId, 64) || !body.pageId) throw invalid('pageId is required');
      if (!Number.isInteger(body.revision) || body.revision < 0) throw invalid('revision must be a non-negative integer');
      const scene = checkScene(body.scene);
      if (!registry.setState(body.pageId, { revision: body.revision, scene })) {
        throw Object.assign(new Error('No open Center page has this id; the stream may have reconnected'), { status: 404, code: 'GRAPHYSX_CENTER_PAGE_UNKNOWN' });
      }
      return res.status(204).end();
    } catch (error) { return fail(res, error); }
  });

  app.post(RECEIPTS_ROUTE, jsonBody, (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const receipt = checkReceipt(req.body);
      if (!registry.receipt(receipt.pageId, receipt)) {
        throw Object.assign(new Error('No open Center page has this id'), { status: 404, code: 'GRAPHYSX_CENTER_PAGE_UNKNOWN' });
      }
      return res.status(204).end();
    } catch (error) { return fail(res, error); }
  });

  const deps = { registry, compose, receiptWaitMs };
  app.use(['/mcp', '/api/mcp'], express.json({ limit: '64kb' }), centerMcpMiddleware(deps));
  return { registry, callTool: (args) => callCenterTool(args, deps) };
}

module.exports = {
  register, createCenterRegistry, pushWorldProposal, callCenterTool, centerMcpMiddleware, appendTool, checkReceipt,
  allowFrame, renderPage, centerUrl, hostModuleUrl,
  TOOL, TOOL_NAME, NESTOR_ACTOR, PAGE, API_BASE, HOST_MODULE_ROUTE, EVENTS_ROUTE, STATE_ROUTE, RECEIPTS_ROUTE, MAX_PAGES, RECEIPT_WAIT_MS
};
