'use strict';

// The background review rereads a PsyX conversation after each completed turn.
// It never speaks to the user: it returns a digest of the conversation and a
// few memory proposals the user accepts or rejects.

const { stateForPrompt } = require('./stateRepository');
const { PROPOSAL_LIMITS, normalizeProposal, normalizeDigest } = require('./proposals');

const REVIEW_PROMPT_VERSION = 1;

const REVIEW_SYSTEM_PROMPT = `You are the background reviewer of PsyX, a private psychological thinking partner for one adult user. You never speak to the user. Reread the conversation with the current longitudinal state and return only one JSON object:

{"digest":{"summary":"2-3 sentences: what this conversation is about and where it stands","themes":["short theme"],"movement":"what shifted, if anything","commitment":"what the user intends to do next, if stated"},
"next":{"stance":"talk|analyze|challenge|plan","depth":"normal|deep","reason":"one short sentence, shown to the user"},
"proposals":[{"kind":"patterns|hypotheses|openLoops|activeThreads|notes","text":"one precise sentence","evidence":["short quote or paraphrase from the conversation"],"confidence":0.0,"rationale":"why this deserves durable memory"},
{"kind":"experiments","hypothesis":"what we think is happening","action":"smallest observable intervention","expectedSignal":"what would support or challenge it","evidence":["..."],"confidence":0.0,"rationale":"..."},
{"kind":"experimentResult","experimentId":"id of an open experiment from the state","outcome":"worked|partly|did_not_work|not_done","result":"what happened, in the user's words","evidence":["..."],"confidence":0.0}]}

Rules:
- Propose at most ${PROPOSAL_LIMITS.perReview} items, only what deserves durable memory beyond this conversation. An empty list is a good answer.
- Every proposal needs evidence from the conversation. Distinguish what the user said from your inference; patterns and hypotheses are fallible working observations, never diagnoses.
- Do not repeat or rephrase anything already in the longitudinal state or in the pending proposals.
- When the user reports how an open experiment of the longitudinal state went, propose its experimentResult with that experiment's id. Never guess an outcome the user did not report.
- Prefer an experiment when the user is ready to test something; prefer an open loop for an unresolved question the user will want to return to.
- If the conversation contains any sign of suicidal thoughts, self-harm or harm to others, "next" is talk with normal depth.
- "next" sets how PsyX should answer the user's next message. talk: stay with lived experience, especially while emotion is high or the user is still telling the story. analyze: map triggers, beliefs and loops once the situation is on the table. challenge: pressure-test a convenient narrative, avoidance or certainty the evidence does not support, when the user can hear it. plan: turn an insight the user accepts into one small observable step. depth deep only when the next answer needs deliberate reasoning: high emotional load, an important decision, contradictions or competing explanations; otherwise normal.
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
  const pending = (state.proposals || []).map(item => item.kind === 'experimentResult'
    ? `result of experiment ${item.experimentId}: ${item.outcome}`
    : item.text || `${item.hypothesis} → ${item.action}`);
  const context = {
    longitudinalState: stateForPrompt(state),
    pendingProposals: pending
  };
  return [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: `Current longitudinal state and pending proposals (do not repeat them):\n${JSON.stringify(context)}\n\nConversation:\n${transcript(selected)}` }
  ];
}

function readReview(raw, { conversationId, settled = [], openExperimentIds = [] } = {}) {
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
    // Ids, dates and the conversation come from the caller, never from the model.
    const proposal = normalizeProposal({ ...item, id: undefined, createdAt: undefined, conversationId: undefined }, { conversationId, now });
    if (!proposal || !proposal.evidence.length || settledSet.has(proposal.fingerprint) || seen.has(proposal.fingerprint)) continue;
    if (proposal.kind === 'experimentResult' && !openExperimentIds.includes(proposal.experimentId)) continue;
    seen.add(proposal.fingerprint);
    proposals.push(proposal);
    if (proposals.length >= PROPOSAL_LIMITS.perReview) break;
  }
  // The prompt asks for "next" beside "digest"; a nested one is accepted too.
  const digest = value.digest && typeof value.digest === 'object'
    ? normalizeDigest({ ...value.digest, id: undefined, conversationId: undefined, next: value.next ?? value.digest.next }, { conversationId, now })
    : null;
  return { digest, proposals };
}

module.exports = { REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, reviewMessages, readReview };
