'use strict';

// Background-review output kept in the PsyX state document: pending memory
// proposals the user accepts or rejects, and one digest per conversation.
// Proposals never reach the prompt until accepted; digests do.

const crypto = require('crypto');
const { EXPERIMENT_OUTCOMES } = require('./followUp');

const PROPOSAL_KINDS = Object.freeze(['activeThreads', 'notes', 'patterns', 'hypotheses', 'openLoops', 'goals', 'experiments', 'experimentResult']);
const PROPOSAL_LIMITS = Object.freeze({ pending: 30, perReview: 5, settled: 200, digests: 50 });
// Same keys as the domain's MODE_CONFIG and DEPTH_CONFIG (asserted by the domain tests).
const STANCES = Object.freeze(['talk', 'analyze', 'challenge', 'plan']);
const DEPTHS = Object.freeze(['normal', 'deep']);

const clean = (value, max) => String(value || '').trim().slice(0, max);

function fingerprint(...parts) {
  return crypto.createHash('sha256')
    .update(['psyx-proposal', ...parts.map(part => clean(part, 1000).toLocaleLowerCase('en-US'))].join(':'))
    .digest('hex').slice(0, 24);
}

function normalizeDate(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeEvidence(value) {
  return (Array.isArray(value) ? value : []).map(item => clean(item, 240)).filter(Boolean).slice(0, 5);
}

function normalizeConfidence(value) {
  const number = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : null;
}

// Accepts model output or a stored document; returns null for anything unusable.
function normalizeProposal(raw, { conversationId = null, now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object' || !PROPOSAL_KINDS.includes(raw.kind)) return null;
  const base = {
    id: clean(raw.id, 80) || crypto.randomUUID(),
    kind: raw.kind,
    evidence: normalizeEvidence(raw.evidence),
    confidence: normalizeConfidence(raw.confidence),
    rationale: clean(raw.rationale, 400),
    conversationId: clean(raw.conversationId || conversationId, 80) || null,
    createdAt: normalizeDate(raw.createdAt, now)
  };
  if (raw.kind === 'experimentResult') {
    const experimentId = clean(raw.experimentId, 80);
    if (!experimentId || !EXPERIMENT_OUTCOMES.includes(raw.outcome)) return null;
    return { ...base, experimentId, outcome: raw.outcome, result: clean(raw.result, 1500), fingerprint: fingerprint(raw.kind, experimentId, raw.outcome) };
  }
  if (raw.kind === 'experiments') {
    const hypothesis = clean(raw.hypothesis, 1000);
    const action = clean(raw.action, 1000);
    if (!hypothesis || !action) return null;
    return { ...base, hypothesis, action, expectedSignal: clean(raw.expectedSignal, 1000), fingerprint: fingerprint(raw.kind, hypothesis, action) };
  }
  const text = clean(raw.text, raw.kind === 'notes' ? 1000 : 500);
  if (!text) return null;
  return { ...base, text, fingerprint: fingerprint(raw.kind, text) };
}

function normalizeProposals(value) {
  return (Array.isArray(value) ? value : []).map(item => normalizeProposal(item)).filter(Boolean).slice(-PROPOSAL_LIMITS.pending);
}

// The review's recommendation for the next turn of this conversation.
function normalizeNext(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const stance = STANCES.includes(raw.stance) ? raw.stance : null;
  const depth = DEPTHS.includes(raw.depth) ? raw.depth : null;
  if (!stance && !depth) return null;
  return { stance, depth, reason: clean(raw.reason, 200) };
}

function normalizeDigest(raw, { conversationId = null, now = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = clean(raw.summary, 600);
  const id = clean(raw.conversationId || conversationId, 80);
  if (!summary || !id) return null;
  return {
    id: clean(raw.id, 80) || crypto.randomUUID(),
    conversationId: id,
    summary,
    themes: (Array.isArray(raw.themes) ? raw.themes : []).map(item => clean(item, 80)).filter(Boolean).slice(0, 5),
    movement: clean(raw.movement, 300),
    commitment: clean(raw.commitment, 300),
    next: normalizeNext(raw.next),
    updatedAt: normalizeDate(raw.updatedAt, now)
  };
}

// One digest per conversation: the latest wins if a replacement was interrupted.
function normalizeDigests(value) {
  const latest = new Map();
  for (const digest of (Array.isArray(value) ? value : []).map(item => normalizeDigest(item)).filter(Boolean)) {
    latest.delete(digest.conversationId);
    latest.set(digest.conversationId, digest);
  }
  return [...latest.values()].slice(-PROPOSAL_LIMITS.digests);
}

function normalizeSettled(value) {
  return (Array.isArray(value) ? value : []).map(item => clean(item, 40)).filter(Boolean).slice(-PROPOSAL_LIMITS.settled);
}

module.exports = {
  proposalFingerprint: fingerprint,
  PROPOSAL_KINDS,
  PROPOSAL_LIMITS,
  STANCES,
  DEPTHS,
  normalizeNext,
  normalizeProposal,
  normalizeProposals,
  normalizeDigest,
  normalizeDigests,
  normalizeSettled
};
