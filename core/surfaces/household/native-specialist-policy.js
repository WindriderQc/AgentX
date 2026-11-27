'use strict';

// Only explicit personal mailbox work/Secretary consultations select this path.
// It retains Main's installed native policy and grants no additional tools.
function requestsSecretary(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(?:ne|do not|don't)\b[^.!?]{0,20}\b(?:consulte|demande|lis|lire|cherche|read|search|ask|consult)\b/.test(input)
      && /\b(?:pas|do not|don't)\b/.test(input)) return false;
  const action = /\b(?:consult\w*|demand\w*|ask|contact|resum\w*|summari\w*|lis|lire|read|cherch\w*|search|verifi\w*|check|regard\w*|look|tri\w*|organis\w*|draft|redig\w*|envoi\w*|envoie|send|repond\w*|reply)\b/.test(input);
  if (/\b(?:secretaire|secretary)\b/.test(input) && action) return true;
  const mailbox = /\b(?:courriels?|(?:e[ -]?)?mails?|gmail|inbox|boite (?:mail|de reception)|messages? (?:de|dans) (?:ma|notre) boite(?=\s*(?:$|[.,!?;])))\b/.test(input);
  const personal = /\b(?:mes|mon|ma|moi|my|me|our|nos|notre)\b/.test(input);
  const question = /\b(?:quels?|quelle?s?|qu['’]|quoi|combien|what|which|how many|derniers?|recent\w*|latest|last|new)\b/.test(input);
  return mailbox && personal && (action || question);
}

const SECRETARY_DIRECTIVE = 'This request belongs to Main and the Secretary, not the limited task-read worker. For currentness of an existing personal action, use the shared personal_task_dossier when available. Consult the allowed secretary agent for other mailbox reads or missing correspondence with a minimal relevant task using native sessions_spawn and sessions_yield. Preserve the user request and all restrictions, including in the delegated task and your final recommendations. An unsent draft is uncommunicated intent, never an accepted duty to send; no reply to an unsent draft is not waiting on the recipient. Keep established owner commitments separate from open questions and optional suggestions. When sending is prohibited, do not turn sending or following up into a required next step. Establish booking from dated received/sent evidence, not a draft or task title. Main lacking direct Gmail tools does not make the Secretary unavailable. Return verified facts, remaining accepted work, open questions or the actual consultation failure; do not ask the user to paste their mailbox merely because Main lacks direct mailbox tools.';

// A conservative migration selector, never an authorization decision. Ambiguous
// requests and effects retain the existing native owner/approval path.
function requestsReadEffects(text) {
  // A complete, explicitly tool-free reply-style clause addresses this
  // conversation. It must not force an external reply/action path. Addressed
  // replies and effect verbs elsewhere in the request remain unchanged.
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/(^|[.!?]\s*)(?:repond(?:s|ez)?|reply|respond|answer)\s+(?:(?:brievement|en une phrase|briefly|in one sentence)\s*,?\s*)?(?:sans (?:aucun )?outils?|without (?:any )?tools?)(?=\s*(?:[.!?]|$))/g, '$1');
  return /\b(?:envoi\w*|envoie|send\w*|repond\w*|reply|draft\w*|redig\w*|modifi\w*|modify|change\w*|supprim\w*|delet\w*|effac\w*|archiv\w*|tri\w*|organis\w*|marqu\w*|mark|cre\w*|add|ajout\w*|transfer\w*|forward|unsubscribe|desabonn\w*|achete\w*|buy|reserve\w*|book|publie\w*|publish)\b/.test(input);
}

function requestsSecretaryRead(text, { direct = false } = {}) {
  if (!requestsSecretary(text)) return false;
  const input = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (requestsReadEffects(input)) return false;
  const read = /\b(?:lis|lire|read|lectur\w*|resum\w*|summari\w*|cherch\w*|search|verifi\w*|check|regard\w*|look|list\w*|quels?|quelle?s?|quoi|combien|what|which|how many)\b/.exec(input);
  return Boolean(read && (!direct || read.index === 0));
}

// Free-form conversation leaves the choice to Main. Require a missing-receipt
// notice up front only for a direct read clause, excluding quoted operands.
function requestsDirectSecretaryRead(text) {
  const request = String(text || '').replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, ' ');
  return request.split(/[.!?;]|\b(?:puis|then)\b/i).some(clause =>
    requestsSecretaryRead(clause.trim().replace(/^please\s+/i, ''), { direct: true }));
}

// A retained direct session may receive an older child's announcement. Its
// session prefix alone cannot associate that delivery with this parent's run.
function secretaryReturnObserved(evidence, sessionKey, runId, { isolated = false } = {}) {
  const checks = evidence?.toolChecks;
  const delivery = evidence?.answer?.deliveredBy;
  if (evidence?.ok !== true || evidence.authority !== 'openclaw.nestor' || evidence.operation !== 'turn'
      || evidence.run?.status !== 'completed' || evidence.run.runId !== runId || evidence.run.sessionKey !== sessionKey
      || evidence.answer?.status !== 'ready' || evidence.answer.runId !== runId || evidence.answerObservation || checks?.loop) return false;
  const prefix = `announce:requester-settle:main:${sessionKey}:`;
  if (typeof delivery !== 'string' || !delivery.startsWith(prefix)
      || checks?.runId !== runId || checks.status !== 'observed'
      || !Array.isArray(checks.completedTools) || !checks.completedTools.includes('sessions_spawn') || !checks.completedTools.includes('sessions_yield')) return false;
  if (Object.hasOwn(checks, 'settledChild')) {
    const child = checks.settledChild;
    return child?.agentId === 'secretary' && Boolean(child.runId) && child.runId === delivery.slice(prefix.length).split(':', 1)[0];
  }
  // Older adapters provide session-level delivery only. Core creates a fresh
  // session for each isolated attempt, and all its spawns must name Secretary.
  if (!isolated || !Array.isArray(evidence.progress)) return false;
  const spawns = evidence.progress.filter(call => call.tool === 'sessions_spawn');
  return spawns.length > 0 && spawns.every(call => call.agentId === 'secretary');
}

module.exports = { secretaryReturnObserved, requestsDirectSecretaryRead, requestsSecretary, requestsSecretaryRead, requestsReadEffects, SECRETARY_DIRECTIVE };
