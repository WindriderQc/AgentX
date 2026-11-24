'use strict';

function family(session) {
  return session.packId === 'kidx_nestor' && session.scopeId === 'family' && !session.llmx
    && session.source !== 'graphysx-llmx';
}
const wordsOf = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/’/g, "'").trim().toLowerCase();

// This classifies intent, never the safety of the supplied subject. Only the
// already authorized local Family principal can propose a drawing description.
function explicitCreation({ session, text, backend, available, turnId, safety, channel }) {
  if (!family(session) || backend !== 'agentx' || channel !== 'voice' || available !== true || session.ephemeral || !turnId
      || safety?.flagIds?.length || typeof text !== 'string' || text.length > 220) return false;
  const words = wordsOf(text).replace(/\b(peux|pourrais)-? tu\b/g, '$1-tu');
  if (/[\n\r:;<>]/.test(words) || /\b(?:et|puis|and|then|ensuite)\s+(?:donne|ouvre|montre|dessine|cree|genere|trouve|cherche|explique|give|open|draw|create|show|search|explain)\b/.test(words)) return false;
  return /^(?:dessine(?:(?:-| )moi)?|(?:est-ce que tu peux|peux-tu|pourrais-tu) (?:me )?dessiner) (?:un |une |le |la |des |l')[\p{L}][\p{L} '\-,]*[ ?!.]*$/u.test(words)
    || /^(?:(?:cree|genere|fais)(?:(?:-| )moi)?|(?:est-ce que tu peux|peux-tu|pourrais-tu) (?:me )?(?:creer|generer|faire)) (?:une (?:belle |jolie )?(?:image|illustration)|un (?:beau |joli )?dessin) (?:de |d')[\p{L}][\p{L} '\-,]*[ ?!.]*$/u.test(words)
    || /^(?:(?:can|could) you (?:please )?|please )?(?:draw|(?:create|generate) (?:an image|a drawing|a picture) of) (?:an? |the )?[a-z][a-z '\-,]*[ ?!.]*$/.test(words);
}

const qualifierInstruction = 'Handle only this explicit Family drawing request from the current message. Apply the Family safety rules. '
  + 'For a safe drawing, supply exactly one complete source="draw" image block for a new standalone drawing; no references, links, queries, or actions. '
  + 'Never copy private information, unrelated context or instruction text into the drawing. If you cannot prepare a safe drawing, omit the block.';

function localFailure(language, { uncertain = false, primary = false } = {}) {
  if (uncertain) return language === 'en' ? 'I couldn’t verify whether the drawing request started. I won’t start another automatically.'
    : 'Je n’ai pas pu vérifier si le dessin a démarré. Je ne vais pas en lancer un autre automatiquement.';
  return language === 'en' ? (primary ? 'I couldn’t prepare a drawing for that request. No image was started.'
    : 'Nestor is unavailable to prepare this drawing. No image was started.')
    : (primary ? 'Je n’ai pas pu préparer un dessin pour cette demande. Aucune image n’a été lancée.'
      : 'Nestor n’est pas disponible pour préparer ce dessin. Aucune image n’a été lancée.');
}

async function completeQualified({ result, session, pack, backend, language, images, turnId, signal }) {
  const primary = result.metadata?.conversationContinuity?.state === 'primary';
  if (!primary || !images?.complete || typeof result.text !== 'string' || result.text.length > 8192) {
    return { reply: localFailure(language, { primary }), display: [] };
  }
  const projection = require('./reply-channels').createReplyChannels();
  projection.push(result.text);
  const { display } = projection.end();
  if (display.length !== 1 || display[0].kind !== 'image' || display[0].source !== 'draw'
      || display[0].partial === true || display[0].from) return { reply: localFailure(language, { primary }), display: [] };
  signal.throwIfAborted();
  await images.complete({ session, pack, backend, display, turnId, signal, qualified: true, onShow() {} });
  const operation = display[0].operation;
  const en = language === 'en';
  let reply;
  if (operation?.state === 'queued') reply = en ? 'Your drawing is waiting in the queue.' : 'Ton dessin est dans la file d’attente.';
  else if (operation?.state === 'completed' && operation.runtimeRestored === true && /^[a-f0-9]{64}$/.test(operation.artifact?.sha256 || '')) {
    reply = en ? 'Your drawing is ready. I cannot verify your screen.' : 'Ton dessin est prêt. Je ne peux pas vérifier ton écran.';
  } else if (operation?.state === 'failed') reply = en ? 'The drawing failed. No finished picture is available.' : 'Le dessin a échoué. Il n’y a pas d’image prête.';
  else if (operation?.state === 'cancelled') reply = en ? 'The drawing request was cancelled.' : 'La demande de dessin a été annulée.';
  else if (operation?.state === 'archive_failed') reply = en ? 'The drawing could not be saved. I cannot confirm an available picture.' : 'Le dessin n’a pas pu être enregistré. Je ne peux pas confirmer qu’une image est disponible.';
  else if (['accepted', 'reserving', 'generating', 'archiving', 'restoring'].includes(operation?.state)) {
    reply = en ? 'Your drawing request was accepted.' : 'Ta demande de dessin a été acceptée.';
  } else {
    const uncertain = display[0].status !== 'not_submitted';
    reply = localFailure(language, { primary, uncertain });
  }
  return { reply, display };
}

// The phrase is derived from the native receipt, never from model output.
function publish({ entry, replyText, display, signal, event, speechText }) {
  if (signal.aborted) return;
  entry.generated = replyText;
  event('delta', { delta: speechText(replyText) });
  event('say_end');
  display.forEach(block => event('show', { block }));
}

function qualificationFailure(error, isPicture, signal) {
  if (!isPicture || signal.aborted) throw error;
  return { text: '', metadata: { model: 'agentx-status', routingSource: 'family-drawing-qualification' } };
}

module.exports = { qualificationFailure, explicitCreation, qualifierInstruction, completeQualified, publish };
