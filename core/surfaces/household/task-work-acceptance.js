'use strict';
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');

// This callback is supplied by Household's canonical capability, never by a
// browser or native tool parameter. Acceptance is not a completed task read.
async function taskWorkAcknowledgment(readAcceptedTaskWork, { session, text, language = 'fr' }) {
  if (typeof readAcceptedTaskWork !== 'function') return null;
  let work;
  try { work = await readAcceptedTaskWork(); } catch { return null; }
  if (work?.authority !== 'core.conversation-works' || work.accepted !== true
      || work.sessionId !== session.sessionId || work.requestSha256 !== hash(text)
      || work.id !== hash(work.sessionId + '\n' + work.turnId)) return null;
  const english = language === 'en';
  const reply = work.resultReady
    ? english ? 'The task lookup result is ready. I’ll present it at the next pause.' : 'Le résultat de la lecture des tâches est prêt. Je te le présente à la prochaine pause.'
    : work.state === 'failed' ? english ? 'The task lookup failed. Its request and status remain saved.' : 'La lecture des tâches a échoué. La demande et son état restent enregistrés.'
      : work.state === 'cancelled' ? english ? 'This task lookup was cancelled.' : 'Cette lecture des tâches a été annulée.'
        : work.state === 'paused' ? english ? 'The task lookup is paused. You can keep talking to me.' : 'La lecture des tâches est en pause. Tu peux continuer à me parler.'
          : work.state === 'uncertain' ? english ? 'Your request is saved, but its execution receipt still needs verification.' : 'Ta demande est enregistrée, mais son reçu d’exécution reste à vérifier.'
            : english ? 'Your request is saved for a task lookup. You can keep talking to me.' : 'Ta demande est enregistrée pour vérification. Tu peux continuer à me parler.';
  return { text: reply, acceptedWork: { authority: work.authority, id: work.id, state: work.state,
    execution: work.resultReady ? 'completed' : ['failed', 'cancelled'].includes(work.state) ? work.state : 'pending' } };
}
module.exports = { taskWorkAcknowledgment };
