'use strict';

// Only explicit personal mailbox work/Secretary consultations select this path.
// It retains Main's installed native policy and grants no additional tools.
function requestsSecretary(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(?:ne|do not|don't)\b[^.!?]{0,20}\b(?:consulte|demande|lis|lire|cherche|read|search|ask|consult)\b/.test(input)
      && /\b(?:pas|do not|don't)\b/.test(input)) return false;
  const action = /\b(?:consult\w*|demand\w*|ask|contact|resum\w*|summari\w*|lis|lire|read|cherch\w*|search|verifi\w*|check|regard\w*|look|tri\w*|organis\w*|draft|redig\w*|envoi\w*|envoie|send|repond\w*|reply)\b/.test(input);
  if (/\b(?:secretaire|secretary)\b/.test(input) && action) return true;
  const mailbox = /\b(?:courriels?|(?:e[ -]?)?mails?|gmail|boite (?:mail|de reception))\b/.test(input);
  const personal = /\b(?:mes|mon|ma|moi|my|me|our|nos|notre)\b/.test(input);
  const question = /\b(?:quels?|quelle?s?|qu['’]|quoi|combien|what|which|how many|derniers?|recent\w*|latest|last|new)\b/.test(input);
  return mailbox && personal && (action || question);
}

const SECRETARY_DIRECTIVE = 'This request belongs to Main and the Secretary, not the limited task-read worker. Consult the allowed secretary agent with a minimal relevant task using native sessions_spawn and sessions_yield. Preserve the user request and all restrictions. Main has no direct Gmail tools; that does not mean the Secretary is unavailable. Return her verified result or the actual consultation failure; do not ask the user to paste their mailbox merely because Main lacks direct mailbox tools.';

module.exports = { requestsSecretary, SECRETARY_DIRECTIVE };
