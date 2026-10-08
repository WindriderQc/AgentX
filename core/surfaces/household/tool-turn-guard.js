'use strict';

const TASK_TOOLS = new Set(['list_personal_tasks', 'agentx__list_personal_tasks', 'personal_briefing', 'agentx__personal_briefing']);

// A deliberately narrow requirement: an explicit request to read/count the
// current personal task list. Advice, stories and general task questions stay
// conversational. This does not claim semantic grounding of every answer.
function requestsTaskCheck(text) {
  const input = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(?:comment|how to|explain|explique|conseils?|advice|histoire|story)\b/.test(input)) return false;
  if (/\b(?:ne|don't|do not)\b[^.!?]{0,40}\b(?:pas|check|look|list|read)\b/.test(input)) return false;
  const topic = /\b(?:taches?|tasks?|to[ -]?do(?: list)?)\b/.test(input);
  const read = /\b(?:regard(?:e|er|ez|ons)|verifi(?:e|er|ez|ons)|consult(?:e|er|ez|ons)|list(?:e|er|ez|ons)|montr(?:e|er|ez)|combien|check|look|list|show|how many|read|count|review)\b/.test(input);
  const personal = /\b(?:mes|nos|ma|mon|my|our|personal|personnelles?)\b/.test(input);
  return topic && read && personal;
}

function taskCheckObserved(evidence, runId) {
  const checks = evidence?.toolChecks;
  if (checks?.status === 'observed' && checks.runId === runId
      && checks.completedTools?.some(tool => TASK_TOOLS.has(tool))) return true;
  return (evidence?.receipts || []).some(row => row.runId === runId && row.status === 'verified' && TASK_TOOLS.has(row.tool));
}

function confirmedLoop(evidence, runId) {
  const checks = evidence?.toolChecks;
  return checks?.status === 'observed' && checks.runId === runId && checks.loop?.repetitions >= 4 ? checks.loop : null;
}

const checkFailure = language => language === 'en'
  ? 'I could not complete that check. No verified result is available. Please try again.'
  : 'La vérification n’a pas abouti. Je n’ai pas de résultat vérifié. Réessaie ta demande.';

module.exports = { requestsTaskCheck, taskCheckObserved, confirmedLoop, checkFailure };
