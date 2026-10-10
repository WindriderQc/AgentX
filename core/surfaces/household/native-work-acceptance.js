'use strict';
const { createHash } = require('node:crypto');
const { scoreSpeechLanguage } = require('../../public/js/voice/speech-language');
const { personalVoice } = require('./conversation-agent');
const hash = value => createHash('sha256').update(value).digest('hex');

async function nativeWorkAcknowledgment(request) {
  const { session, text, channel, readAcceptedNativeWork } = request;
  if (request.backend !== 'openclaw' || !personalVoice(session, channel) || session.inference?.open || session.modeId === 'open'
      || request.model || typeof readAcceptedNativeWork !== 'function') return null;
  const work = await readAcceptedNativeWork();
  if (work?.authority !== 'core.conversation-works' || work.accepted !== true
      || work.sessionId !== session.sessionId || work.requestSha256 !== hash(text)
      || work.id !== hash(work.sessionId + '\n' + work.turnId)) return null;
  const en = scoreSpeechLanguage(text).language === 'en';
  const answer = work.resultReady
    ? en ? 'The consultation result is ready. I’ll present it at the next pause.' : 'Le résultat de la consultation est prêt. Je te le présente à la prochaine pause.'
    : work.state === 'failed' ? en ? 'The consultation failed. Its request and status remain saved.' : 'La consultation a échoué. La demande et son état restent enregistrés.'
      : work.state === 'cancelled' ? en ? 'This consultation was cancelled.' : 'Cette consultation a été annulée.'
        : work.state === 'paused' ? en ? 'The consultation is paused. You can keep talking to me.' : 'La consultation est en pause. Tu peux continuer à me parler.'
          : work.state === 'uncertain' ? en ? 'Your request is saved. I’m still waiting for its execution receipt.' : 'Ta demande est enregistrée. Son reçu d’exécution reste à vérifier.'
            : en ? 'Your consultation request is saved. You can keep talking to me while it runs.' : 'Ta demande de consultation est enregistrée. Tu peux continuer à me parler pendant la vérification.';
  request.signal?.throwIfAborted();
  await request.onSettled?.();
  request.onDelta?.(answer);
  return { text: answer, backend: 'openclaw', metadata: { model: '', routingSource: 'core.conversation-works' },
    tools: { authority: 'core.conversation-works', status: 'deferred', receipts: [],
      acceptedWork: { authority: work.authority, id: work.id, state: work.state,
        execution: work.resultReady ? 'completed' : ['failed', 'cancelled'].includes(work.state) ? work.state : 'pending' } } };
}
module.exports = { nativeWorkAcknowledgment };
