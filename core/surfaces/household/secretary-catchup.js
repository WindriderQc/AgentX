'use strict';
const { annualProjection } = require('./secretary-annual-coverage');

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
  const words = clean(body.text, 4001);
  if (!words) throw failure(400, 'CATCHUP_PROPOSAL_TEXT_REQUIRED', 'text is required');
  if (words.length > 1200) throw failure(400, 'CATCHUP_PROPOSAL_TOO_LONG', 'Shorten the finding without losing its actor or conditions; keep the source linked.');
  if (!KEY.test(String(body.key || ''))) throw failure(400, 'CATCHUP_PROPOSAL_BAD_KEY', 'key is invalid');
  if (body.findingKey !== undefined && !KEY.test(body.findingKey)) throw failure(400, 'CATCHUP_PROPOSAL_BAD_KEY', 'findingKey is invalid');
  const due = clean(body.due, 40);
  const url = GMAIL_URL.test(String(body.gmailUrl || '')) ? body.gmailUrl : '';
  const owner = clean(body.owner, 300);
  const attribution = body.kind === 'action' && owner
    ? ` — ${/^(owner|propriétaire|unknown|inconnu)$/i.test(owner) ? 'Acteur à clarifier' : `Demande attribuée à ${owner} (à confirmer)`}` : '';
  const sourceDate = body.sourceDate && Number.isFinite(Date.parse(body.sourceDate)) ? new Date(body.sourceDate).toISOString() : '';
  return {
    text: `${label} : ${words}${due ? ` (échéance : ${due})` : ''}${attribution}${sourceDate ? ` — source du ${sourceDate}` : ''}${url ? ` — ${url}` : ''}`,
    origin: 'secretary',
    kind: due ? 'reminder' : 'idea',
    tags: ['secretary-catchup', body.kind === 'memory' ? 'memoire' : 'action'],
    sourceKey: `catchup-${body.findingKey || body.key}`
  };
}

function registerSecretaryCatchupRoutes({ router, envelope, fail, ideaInbox = null }) {
  router.post('/catchup/proposals', async (req, res) => {
    try {
      const signal = await require('../../src/services/personalTaskEvidenceSignalService').route(req.body || {});
      if (signal) return envelope(res, signal, signal.duplicate ? 200 : 201);
      const captured = await (ideaInbox || defaultIdeaInbox()).captureIdea(proposalIdea(req.body || {}));
      return envelope(res, captured, captured.duplicate ? 200 : 201);
    } catch (error) {
      return fail(res, error.status || 500, error.message, error.code || 'CATCHUP_PROPOSAL_FAILED');
    }
  });
}

// Counts only, as the host reported them; never message content.
const count = value => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
const REVIEW_COUNTS = ['targetSources', 'materializedSources', 'sourcesPendingMaterialization', 'sourcesTextReviewed',
  'sourcesWithGaps', 'sourceErrors', 'expectedPagesKnown', 'reviewedPages', 'pendingPagesKnown', 'invalidReviewReceipts', 'extractedMoments', 'reviewGaps', 'sourcesTextCovered', 'equivalentPages',
  'rejectedPages', 'sourcesWithRejectedPages'];
function reviewProgress(body) {
  const archive = body.archiveProgress;
  return {
    archiveProgress: archive && typeof archive === 'object' ? {
      at: archive.at || null, pending: archive.pending === true,
      pendingTextPages: count(archive.pendingTextPages), reviewedPages: count(archive.reviewedPages),
      unresolvedInferenceAttempts: count(archive.unresolvedInferenceAttempts), uncollectedThreads: count(archive.uncollectedThreads),
      discoveringScopes: Array.isArray(archive.discoveringScopes) ? archive.discoveringScopes.filter(v => ['contact', 'invoices', 'mailbox'].includes(v)) : [],
      unavailableMessages: count(archive.unavailableMessages), unavailableDraftMessages: count(archive.unavailableDraftMessages)
    } : null,
    objectiveReviews: (Array.isArray(body.objectiveReviews) ? body.objectiveReviews : []).slice(0, 100).map(v => {
      const annualCoverage = annualProjection(v.annualCoverage);
      return {
      objectiveId: clean(v.objectiveId, 80), version: clean(v.version, 80), at: v.at || null, phase: clean(v.phase, 40),
      counts: Object.fromEntries(REVIEW_COUNTS.filter(k => v.counts && Number.isSafeInteger(v.counts[k]) && v.counts[k] >= 0).map(k => [k, v.counts[k]])),
      allTargetTextReviewed: v.allTargetTextReviewed === true, semanticAcceptance: 'not-established', userConfirmed: false,
      allTargetTextCovered: v.allTargetTextCovered === true,
      newlyReviewedPages: count(v.newlyReviewedPages), elapsedSeconds: count(v.elapsedSeconds),
      ...(annualCoverage ? { annualCoverage } : {})
      };
    })
  };
}

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
    updatedAt: body.updatedAt || null, finishedAt: body.finishedAt || null,
    ...(body.archiveProgress || body.objectiveReviews ? reviewProgress(body) : {})
  };
}

module.exports = { catchupProjection, proposalIdea, registerSecretaryCatchupRoutes };
