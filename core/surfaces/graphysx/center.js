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
//   POST /api/graphysx/center/receipts   what the Center did with a pushed proposal: first whether
//                                        the card was shown, then what the person decided
//
// The tool `propose_world_change` is what Nestor calls when, in a conversation, it announces an
// intention on the world. Core composes against the most recently active page's reported scene,
// through the same prompt and validation as a typed request, and pushes the result on that
// page's stream. The Center shows it as a card attributed to Nestor · Core, inert until a person
// presses Apply there, and sends a receipt — shown, shown but stale, or refused — which the tool
// relays so Nestor never claims more than happened. When the person decides, the Center sends a
// second receipt under the same push id — accepted at which revision and commit, or discarded,
// stale, rejected — and Core keeps it, bounded, so `world_proposal_status` can answer "accepted in
// revision 9" or "discarded" when Nestor is asked later. Core applies nothing and keeps no scene.
//
// Pages and push records are process memory, like live sessions in GraphysX: a Core restart
// forgets them and loses nothing, since nothing here is authored. Full profile only; a
// family-pinned device cannot open the page or its routes (family-device.js), like DiskX.

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
/** Push records kept for `world_proposal_status`, oldest forgotten first. */
const MAX_PUSHES = 64;
const HEARTBEAT_MS = 25_000;
/** How long the tool waits for the Center's receipt before answering "unconfirmed". */
const RECEIPT_WAIT_MS = 5_000;
const REQUEST_CHARS = 2000;
const PUSH_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const TOOL_NAME = 'propose_world_change';
const STATUS_TOOL_NAME = 'world_proposal_status';
/** The Center's two receipts: whether the card was shown, then what the person decided. */
const DELIVERY_STATUSES = Object.freeze(['shown', 'refused']);
const DECISION_STATUSES = Object.freeze(['accepted', 'discarded', 'stale', 'rejected']);
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
function createCenterRegistry({ now = () => Date.now(), maxPages = MAX_PAGES, maxPushes = MAX_PUSHES } = {}) {
  const pages = new Map();
  /** push id → record; insertion order is push order, so the oldest is evicted first. */
  const pushes = new Map();
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
    /**
     * A receipt from the page. A delivery receipt (shown, refused) wakes the tool waiting for
     * it; a decision receipt (accepted, discarded, stale, rejected) is kept on the push record.
     * Either is kept only for a push Core sent: the page cannot invent a decision on a card
     * nobody pushed, and a push is decided once — a second decision is ignored, not rewritten.
     */
    receipt(id, body) {
      const page = pages.get(id);
      if (!page) return false;
      page.lastSeen = now();
      const record = pushes.get(body.id);
      if (DECISION_STATUSES.includes(body.status)) {
        if (record && record.pageId === page.id && !record.decision && (!record.delivery || record.delivery.status !== 'refused')) {
          record.decision = {
            status: body.status, proposalId: body.proposalId, revision: body.revision, at: new Date(now()).toISOString(),
            ...(body.commitId !== undefined ? { commitId: body.commitId } : {}),
            ...(body.reason !== undefined ? { reason: body.reason } : {})
          };
        }
        return true;
      }
      if (record && record.pageId === page.id && !record.delivery) {
        record.delivery = {
          status: body.status,
          ...(body.stale !== undefined ? { stale: body.stale } : {}),
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {})
        };
      }
      const resolve = page.waiters.get(body.id);
      if (resolve) resolve(body);
      return true;
    },
    /** Remembers a push the tool sent, so its receipts have somewhere to land. Bounded. */
    recordPush(page, proposal) {
      while (pushes.size >= maxPushes) pushes.delete(pushes.keys().next().value);
      const record = { id: proposal.id, pageId: page.id, intent: proposal.intent, commandCount: proposal.commands.length, expectedRevision: proposal.expectedRevision, pushedAt: new Date(now()).toISOString(), delivery: null, decision: null };
      pushes.set(proposal.id, record);
      return record;
    },
    push(id) { return pushes.get(id) || null; },
    /** The most recent pushes first. */
    recentPushes(limit = 5) { return [...pushes.values()].reverse().slice(0, limit); },
    get size() { return pages.size; },
    get pushCount() { return pushes.size; },
    summary() {
      return [...pages.values()].map((page) => ({ id: page.id, revision: page.revision, entities: page.scene ? page.scene.entities.length : null, lastSeen: new Date(page.lastSeen).toISOString(), decisions: [...pushes.values()].filter((record) => record.pageId === page.id && record.decision).length }));
    }
  };
}

/**
 * A receipt from the page: a delivery (`shown` with `stale`, or `refused` with a reason) or a
 * decision (`accepted` with the commit's `revision` and `commitId`, `discarded`, `stale` or
 * `rejected` with a reason, each with the `revision` after the decision). The fields of one are
 * not accepted on the other: a decision has no `stale`, a delivery has no `revision`.
 */
function checkReceipt(body) {
  if (!isRecord(body)) throw invalid('The body must be a receipt object');
  const unknown = Object.keys(body).filter((key) => !['pageId', 'id', 'status', 'proposalId', 'stale', 'reason', 'revision', 'commitId'].includes(key));
  if (unknown.length) throw invalid(`Unknown field: ${unknown[0].slice(0, 40)}`);
  if (!text(body.pageId, 64) || !body.pageId) throw invalid('pageId is required');
  if (typeof body.id !== 'string' || !PUSH_ID_PATTERN.test(body.id)) throw invalid('id must name the pushed proposal');
  const decision = DECISION_STATUSES.includes(body.status);
  if (!decision && !DELIVERY_STATUSES.includes(body.status)) throw invalid(`status must be one of ${[...DELIVERY_STATUSES, ...DECISION_STATUSES].join(', ')}`);
  if (body.proposalId !== undefined && !text(body.proposalId, 400)) throw invalid('proposalId must be a short string');
  if (body.reason !== undefined && !text(body.reason, 400)) throw invalid('reason must be a short sentence');
  if (decision) {
    if (body.proposalId === undefined) throw invalid('a decision must name the proposal it was taken on');
    if (!Number.isInteger(body.revision) || body.revision < 0) throw invalid('a decision must carry the revision after it, a non-negative integer');
    if (body.stale !== undefined) throw invalid('stale belongs to a shown receipt, not a decision');
    if (body.commitId !== undefined && (body.status !== 'accepted' || !text(body.commitId, 120) || !body.commitId)) throw invalid('commitId is a short string, on an accepted decision only');
    if (body.reason !== undefined && body.status !== 'rejected') throw invalid('reason belongs to a rejected decision');
  } else {
    if (body.stale !== undefined && typeof body.stale !== 'boolean') throw invalid('stale must be a boolean');
    if (body.revision !== undefined || body.commitId !== undefined) throw invalid('revision and commitId belong to a decision, not a delivery receipt');
  }
  return {
    pageId: body.pageId, id: body.id, status: body.status,
    ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {}),
    ...(body.stale !== undefined ? { stale: body.stale } : {}),
    ...(body.revision !== undefined ? { revision: body.revision } : {}),
    ...(body.commitId !== undefined ? { commitId: body.commitId } : {}),
    ...(body.reason !== undefined ? { reason: body.reason.trim().replace(/\s+/g, ' ') } : {})
  };
}

/**
 * Nestor's push. Composes for an explicit page, or the most recent page when omitted, through `compose` (the same prompt, inference
 * and validation as a typed request), sends the proposal on the page's stream and waits briefly
 * for the Center's receipt. Returns what Nestor may say — and no more.
 */
async function pushWorldProposal({ request, pageId }, { registry, compose, receiptWaitMs = RECEIPT_WAIT_MS }) {
  if (!text(request, REQUEST_CHARS) || !request.trim()) {
    throw Object.assign(new Error(`request must be a sentence of at most ${REQUEST_CHARS} characters`), { code: 'INVALID_ARGUMENTS' });
  }
  if (pageId !== undefined && (!text(pageId, 64) || !pageId)) {
    throw Object.assign(new Error('pageId must identify the observed Center page'), { code: 'INVALID_ARGUMENTS' });
  }
  const page = pageId === undefined ? registry.mostRecent() : registry.get(pageId);
  if (!page || !page.scene || page.res.writableEnded || page.res.destroyed) {
    return { status: 'no-page', page: PAGE, message: pageId === undefined ? `No GraphysX Center page is open on Core (${PAGE}). Nothing was proposed; ask the person to open it.` : 'The requested Center page is not open and ready. Nothing was proposed; no other page was used.' };
  }
  // Bind the model input, card and receipt to one observation before the asynchronous work.
  const revision = page.revision, scene = structuredClone(page.scene);
  const composed = await compose({ request: request.trim(), revision, scene });
  if (!composed || !composed.ok) {
    return { status: 'declined', page: PAGE, reason: (composed && composed.reason) || 'The proposal could not be composed.', model: (composed && composed.model) || null };
  }
  const id = `push-${crypto.randomBytes(6).toString('hex')}`;
  const proposal = { id, actor: NESTOR_ACTOR, intent: composed.intent, commands: composed.commands, expectedRevision: revision, model: composed.model || null };
  const pending = registry.awaitReceipt(page, id, receiptWaitMs);
  if (!registry.send(page, 'proposal', proposal)) {
    registry.close(page.id);
    return { status: 'no-page', page: PAGE, message: 'The GraphysX Center page closed before the proposal reached it. Nothing was proposed.' };
  }
  registry.recordPush(page, proposal);
  const receipt = await pending;
  const delivery = receipt
    ? { status: receipt.status, ...(receipt.stale !== undefined ? { stale: receipt.stale } : {}), ...(receipt.reason ? { reason: receipt.reason } : {}), ...(receipt.proposalId ? { proposalId: receipt.proposalId } : {}) }
    : { status: 'unconfirmed', reason: 'The page has not acknowledged the proposal yet.' };
  return {
    // `refused` at the top too: Nestor reads one word first, and a card the page did not show
    // was not proposed to anyone.
    status: delivery.status === 'refused' ? 'refused' : 'proposed',
    id, page: PAGE, pageId: page.id, intent: composed.intent, commandCount: composed.commands.length,
    expectedRevision: revision, model: composed.model || null, delivery,
    note: 'A proposal card in the Center, inert until a person presses Apply there; Core applied nothing.',
    followUp: `Call ${STATUS_TOOL_NAME} with this id to learn what the person decided.`
  };
}

/** One word Nestor reads first, from where the push stands: pushed, shown, refused, or the decision. */
function pushStatusWord(record) {
  if (record.decision) return record.decision.status;
  if (record.delivery) return record.delivery.status;
  return 'pending';
}

function pushStatusSentence(record) {
  const { decision, delivery } = record;
  if (decision) {
    switch (decision.status) {
      case 'accepted': return `Accepted: the person pressed Apply and the world is at revision ${decision.revision}${decision.commitId ? ` (commit ${decision.commitId})` : ''}.`;
      case 'discarded': return 'Discarded by the person; the world did not change.';
      case 'stale': return `Not applied: the world had moved to revision ${decision.revision} since the proposal was composed, so the Center refused it.`;
      case 'rejected': return `Not applied: the scene refused the change${decision.reason ? ` (${decision.reason})` : ''}.`;
      default: return 'Decided.';
    }
  }
  if (delivery) {
    if (delivery.status === 'refused') return `The Center did not show it${delivery.reason ? `: ${delivery.reason}` : '.'}`;
    return delivery.stale
      ? 'Shown as a stale card: the world moved before it arrived, so Apply is disabled; the person has not dismissed it yet.'
      : 'Shown as a card in the Center; the person has not decided yet. Say it is proposed, not done.';
  }
  return 'Pushed to the page, which has not acknowledged it yet.';
}

function describePush(record) {
  return {
    status: pushStatusWord(record), id: record.id, page: PAGE, pageId: record.pageId, intent: record.intent, commandCount: record.commandCount,
    expectedRevision: record.expectedRevision, pushedAt: record.pushedAt, delivery: record.delivery, decision: record.decision,
    message: pushStatusSentence(record)
  };
}

/**
 * What became of a push: the one named by `id`, or the most recent one. Reads the bounded
 * records; never touches the page. `unknown` names a push Core has no record of (never sent,
 * or forgotten after ${MAX_PUSHES} newer ones or a Core restart) — never a guess.
 */
function readWorldProposalStatus({ id }, { registry }) {
  if (id !== undefined && (typeof id !== 'string' || !PUSH_ID_PATTERN.test(id))) {
    throw Object.assign(new Error('id must be the push id a propose_world_change reply returned'), { code: 'INVALID_ARGUMENTS' });
  }
  const recent = registry.recentPushes(5).map((record) => ({ id: record.id, status: pushStatusWord(record), intent: record.intent, pushedAt: record.pushedAt }));
  if (id === undefined) {
    const latest = registry.recentPushes(1)[0];
    if (!latest) return { status: 'none', page: PAGE, message: 'No proposal has been pushed to a GraphysX Center page since Core started.', recent };
    return { ...describePush(latest), recent };
  }
  const record = registry.push(id);
  if (!record) return { status: 'unknown', id, page: PAGE, message: `Core has no record of push ${id}: it was never sent, or it is older than the ${MAX_PUSHES} pushes Core keeps.`, recent };
  return { ...describePush(record), recent };
}

const STATUS_TOOL = Object.freeze({
  name: STATUS_TOOL_NAME,
  title: 'What Became Of A Proposed GraphysX World Change',
  description: 'Read what happened to a change proposed with propose_world_change: whether the GraphysX Center showed the card and, once the person decided, whether they accepted it (status accepted, with the world revision and commit id), discarded it, or the Center refused it as stale or rejected. Pass the id a propose_world_change reply returned, or nothing for the most recent proposal. Reads Core\'s own records only; it changes nothing. Use it when the person asks whether a change went through, or before saying a proposed change happened: say "accepted in revision N" only when this tool says so.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1, maxLength: 80, description: 'The push id (push-…) from a propose_world_change reply. Omit for the most recent proposal.' } },
    additionalProperties: false
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  _meta: CENTER_MCP_META
});

const TOOL = Object.freeze({
  name: TOOL_NAME,
  title: 'Propose A Change To The GraphysX World',
  description: 'Propose one change to the 3D world shown in the GraphysX Center page open on Core (/graphysx), as one request in plain words (for example "add a lake with a flock of birds at sunset"). Core composes world commands from GraphysX\'s own vocabulary and shows them in the page as a proposal card from Nestor; nothing is applied until the person presses Apply there, and the reply says whether the card was shown (delivery.status: shown, refused with a reason, or unconfirmed). Use it when the person asks to add, change or remove something in the 3D scene, or when you announce such an intention. Never say the change happened: say it is proposed. With no page open the reply says so; ask the person to open /graphysx.',
  inputSchema: {
    type: 'object',
    properties: { request: { type: 'string', minLength: 1, maxLength: REQUEST_CHARS, description: 'What should change in the world, as one request in the person\'s words or your own.' }, pageId: { type: 'string', minLength: 1, maxLength: 64, description: 'Optional exact Center page id from its host state. Omit to use the most recently active page. A missing or closed explicit target never falls back to another page.' } },
    required: ['request'],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  _meta: CENTER_MCP_META
});

function toolResult(structuredContent, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent, isError };
}

async function callCenterTool(args, deps, name = TOOL_NAME) {
  try {
    if (!isRecord(args)) throw Object.assign(new Error('arguments must be an object'), { code: 'INVALID_ARGUMENTS' });
    const keys = name === STATUS_TOOL_NAME ? ['id'] : ['request', 'pageId'];
    if (Object.keys(args).some(key => !keys.includes(key))) throw Object.assign(new Error('Unknown tool argument'), { code: 'INVALID_ARGUMENTS' });
    if (name === STATUS_TOOL_NAME) return toolResult(readWorldProposalStatus({ id: args.id }, deps));
    return toolResult(await pushWorldProposal({ request: args.request, pageId: args.pageId }, deps));
  } catch (error) {
    return toolResult({ error: error.code || 'GRAPHYSX_CENTER_TOOL_ERROR', message: error.message }, true);
  }
}

const TOOLS = Object.freeze([TOOL, STATUS_TOOL]);

/** tools/list with these tools appended, each once; one a listing already names is left alone. */
function appendTool(body) {
  if (!Array.isArray(body?.result?.tools)) return body;
  const missing = TOOLS.filter((tool) => !body.result.tools.some((listed) => listed?.name === tool.name));
  if (!missing.length) return body;
  return { ...body, result: { ...body.result, tools: [...body.result.tools, ...missing] } };
}

/** Answers `propose_world_change` and `world_proposal_status` on Core's MCP transport and lists them; everything else passes through. */
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
    if (message.method !== 'tools/call' || !TOOLS.some((tool) => tool.name === message.params?.name)) return next();
    if (message.id === undefined || message.id === null) return res.status(204).end();
    const result = await callCenterTool(message.params?.arguments || {}, deps, message.params.name);
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
  return { registry, callTool: (args, name) => callCenterTool(args, deps, name) };
}

module.exports = {
  register, createCenterRegistry, pushWorldProposal, readWorldProposalStatus, callCenterTool, centerMcpMiddleware, appendTool, checkReceipt,
  allowFrame, renderPage, centerUrl, hostModuleUrl,
  TOOL, STATUS_TOOL, TOOLS, TOOL_NAME, STATUS_TOOL_NAME, NESTOR_ACTOR, PAGE, API_BASE, HOST_MODULE_ROUTE, EVENTS_ROUTE, STATE_ROUTE, RECEIPTS_ROUTE,
  MAX_PAGES, MAX_PUSHES, RECEIPT_WAIT_MS, DELIVERY_STATUSES, DECISION_STATUSES
};
