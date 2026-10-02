'use strict';

// Owner confirmation for what the Secretary's archive catch-up found (#130).
// The native job never writes tasks or memory: a current action or personal
// fact from recent mail becomes one idea in Dad's inbox, to promote or set aside.

// Loaded on first use, so the desk projection below stays free of models.
const defaultIdeaInbox = () => require('../../src/services/ideaInboxService');

const LABELS = Object.freeze({ action: 'Action', memory: 'À retenir' });
const KEY = /^[a-f0-9]{32}$/;
const GMAIL_URL = /^https:\/\/mail\.google\.com\/\S{1,300}$/;
const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });

function proposalIdea(body = {}) {
  const label = LABELS[body.kind];
  if (!label) throw failure(400, 'CATCHUP_PROPOSAL_BAD_KIND', 'kind must be action or memory');
  const words = clean(body.text, 600);
  if (!words) throw failure(400, 'CATCHUP_PROPOSAL_TEXT_REQUIRED', 'text is required');
  if (!KEY.test(String(body.key || ''))) throw failure(400, 'CATCHUP_PROPOSAL_BAD_KEY', 'key is invalid');
  const due = clean(body.due, 40);
  const url = GMAIL_URL.test(String(body.gmailUrl || '')) ? body.gmailUrl : '';
  return {
    text: `${label} : ${words}${due ? ` (échéance : ${due})` : ''}${url ? ` — ${url}` : ''}`,
    origin: 'secretary',
    kind: due ? 'reminder' : 'idea',
    tags: ['secretary-catchup', body.kind === 'memory' ? 'memoire' : 'action'],
    sourceKey: `catchup-${body.key}`
  };
}

function registerSecretaryCatchupRoutes({ router, envelope, fail, ideaInbox = null }) {
  router.post('/catchup/proposals', async (req, res) => {
    try {
      const captured = await (ideaInbox || defaultIdeaInbox()).captureIdea(proposalIdea(req.body || {}));
      return envelope(res, captured, captured.duplicate ? 200 : 201);
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'CATCHUP_PROPOSAL_FAILED');
    }
  });
}

// Counts only, as the host reported them; never message content.
const count = value => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);

function catchupProjection(body) {
  if (!body) return null;
  if (body.error) return { status: 'unavailable', error: String(body.error) };
  if (!body.known) return null;
  const paused = body.paused?.reason ? String(body.paused.reason) : null;
  const status = body.running ? (paused ? 'paused' : 'running')
    : ['done', 'stopped', 'partial'].includes(body.phase) ? body.phase : 'idle';
  return {
    status, paused, lane: body.lane || null,
    pending: count(body.pending), reviewed: count(body.reviewed), failed: count(body.failed),
    remaining: count(body.remaining), pagesPerHour: count(body.pagesPerHour), etaHours: count(body.etaHours),
    proposalsQueued: count(body.proposalsQueued), proposalsPending: count(body.proposalsPending),
    updatedAt: body.updatedAt || null, finishedAt: body.finishedAt || null
  };
}

module.exports = { catchupProjection, proposalIdea, registerSecretaryCatchupRoutes };
