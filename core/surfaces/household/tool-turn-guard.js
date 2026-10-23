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
  // A request to create tasks "sans consulter de spécialiste" is not a
  // request to read the personal list. Ignore only the negated read verb;
  // an explicit subsequent "puis regarde mes tâches" still requires evidence.
  const readInput = input.replace(/\bsans\s+(?:aller\s+)?(?:regarder|verifier|consulter|lister|montrer)\b/g, '');
  const read = /\b(?:regard(?:e|er|ez|ons)|verifi(?:e|er|ez|ons)|consult(?:e|er|ez|ons)|list(?:e|er|ez|ons)|montr(?:e|er|ez)|combien|quels?|quelles?|quoi|prioritaires?|check|look|list|show|how many|what|which|read|count|review)\b/.test(readInput);
  const personal = /\b(?:mes|nos|ma|mon|my|our|personal|personnelles?)\b/.test(input);
  return topic && read && personal;
}

function taskCheckObserved(evidence, runId) {
  const checks = evidence?.toolChecks;
  if (checks?.status === 'observed' && checks.runId === runId
      && checks.completedTools?.some(tool => TASK_TOOLS.has(tool))) return true;
  return (evidence?.receipts || []).some(row => row.runId === runId && row.status === 'verified'
    && (TASK_TOOLS.has(row.tool) || row.tool === 'conversation_work'
      && row.workRead?.tool === 'tasks.personal.list' && /^[a-f0-9]{64}$/.test(row.workRead.id || '')));
}

function confirmedLoop(evidence, runId) {
  const checks = evidence?.toolChecks;
  return checks?.status === 'observed' && checks.runId === runId && checks.loop?.repetitions >= 4 ? checks.loop : null;
}

const checkFailure = language => language === 'en'
  ? 'I could not complete that check. Verify the original request outcome before trying again.'
  : 'La vérification n’a pas abouti. Vérifie le résultat de la demande initiale avant de la relancer.';

function recordedTaskReply(evidence, runId, language) {
  const ids = [...new Set((evidence?.receipts || []).filter(row => row.runId === runId && row.status === 'verified'
    && ['add_personal_task', 'agentx__add_personal_task'].includes(row.tool)
    && /^personal-task:\d{1,12}$/.test(row.resultRef || '')).map(row => row.resultRef.split(':')[1]))];
  if (!ids.length) return null;
  return language === 'en'
    ? `Recorded personal task IDs: ${ids.join(', ')}. The requested list check was not verified. Keep these tasks; do not create them again.`
    : `Tâches personnelles enregistrées : ${ids.join(', ')}. La lecture de la liste demandée n’a pas été vérifiée. Ces tâches sont conservées; ne les recrée pas.`;
}

module.exports = { requestsTaskCheck, taskCheckObserved, confirmedLoop, checkFailure, recordedTaskReply };
