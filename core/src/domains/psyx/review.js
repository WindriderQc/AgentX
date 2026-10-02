'use strict';

// The background review rereads a PsyX conversation after each completed turn.
// It never speaks to the user: it returns a digest of the conversation and a
// few memory proposals the user accepts or rejects.

const { stateForPrompt } = require('./stateRepository');
const { PROPOSAL_LIMITS, normalizeProposal, normalizeDigest } = require('./proposals');

const REVIEW_PROMPT_VERSION = 1;

const REVIEW_SYSTEM_PROMPT = `You are the background reviewer of PsyX, a private psychological thinking partner for one adult user. You never speak to the user. Reread the conversation with the current longitudinal state and return only one JSON object:

{"digest":{"summary":"2-3 sentences: what this conversation is about and where it stands","themes":["short theme"],"movement":"what shifted, if anything","commitment":"what the user intends to do next, if stated"},
"proposals":[{"kind":"patterns|hypotheses|openLoops|activeThreads|notes","text":"one precise sentence","evidence":["short quote or paraphrase from the conversation"],"confidence":0.0,"rationale":"why this deserves durable memory"},
{"kind":"experiments","hypothesis":"what we think is happening","action":"smallest observable intervention","expectedSignal":"what would support or challenge it","evidence":["..."],"confidence":0.0,"rationale":"..."}]}

Rules:
- Propose at most ${PROPOSAL_LIMITS.perReview} items, only what deserves durable memory beyond this conversation. An empty list is a good answer.
- Every proposal needs evidence from the conversation. Distinguish what the user said from your inference; patterns and hypotheses are fallible working observations, never diagnoses.
- Do not repeat or rephrase anything already in the longitudinal state or in the pending proposals.
- Prefer an experiment when the user is ready to test something; prefer an open loop for an unresolved question the user will want to return to.
- Write in the language of the conversation.`;

function transcript(turns) {
  return turns.map(turn => `${turn.role === 'assistant' ? 'PsyX' : 'User'}: ${turn.content}`).join('\n\n');
}

function reviewMessages({ state, turns, maxCharacters = 24000 }) {
  const selected = [];
  let characters = 0;
  for (const turn of [...turns].reverse()) {
    const content = String(turn?.content || '').trim();
    if (!content) continue;
    if (characters + content.length > maxCharacters) break;
    selected.unshift({ role: turn.role, content });
    characters += content.length;
  }
  const pending = (state.proposals || []).map(item => item.text || `${item.hypothesis} → ${item.action}`);
  const context = {
    longitudinalState: stateForPrompt(state),
    pendingProposals: pending
  };
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `Current longitudinal state and pending proposals (do not repeat them):\n${JSON.stringify(context)}\n\nConversation:\n${transcript(selected)}` }
  ];
}

function readReview(raw, { conversationId, settled = [] } = {}) {
  let value = raw;
  if (typeof raw === 'string') {
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { value = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  }
  if (!value || typeof value !== 'object') return null;
  const now = new Date().toISOString();
  const settledSet = new Set(settled);
  const seen = new Set();
  const proposals = [];
  for (const item of Array.isArray(value.proposals) ? value.proposals : []) {
    // The reviewer generates ids; ours are minted here.
    const proposal = normalizeProposal({ ...item, id: undefined, createdAt: undefined }, { conversationId, now });
    if (!proposal || !proposal.evidence.length || settledSet.has(proposal.fingerprint) || seen.has(proposal.fingerprint)) continue;
    seen.add(proposal.fingerprint);
    proposals.push(proposal);
    if (proposals.length >= PROPOSAL_LIMITS.perReview) break;
  }
  return { digest: normalizeDigest(value.digest, { conversationId, now }), proposals };
}

module.exports = { REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, reviewMessages, readReview };
