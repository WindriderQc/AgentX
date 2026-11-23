'use strict';

const { recentBlocks, ready, UUID } = require('./shown-images');

const statusQuestion = /^(?:(?:est ce que )?(?:mon|le) dessin est (?:pret|termine)|(?:mon|le) dessin est il (?:pret|termine)|(?:as tu|tu as) (?:fait|termine) (?:mon|le) dessin|ou (?:est|en est) (?:mon|le) dessin|is (?:my|the) drawing (?:ready|finished)|did you finish (?:my|the) drawing)$/;

// Accept exactly one visibility report, optionally paired with a request to
// show the existing drawing. Keep punctuation within each clause significant.
function missingDrawing(report, show, reason) {
  const separator = '(?: *[,.!?;:]+ *| +)';
  return new RegExp('^(?:' + report + '(?:' + separator + show + ')?|' + show + separator + '(?:' + reason + ' )?' + report + ')$');
}
const missingFr = missingDrawing(
  "(?:je (?:ne )?vois (?:toujours )?pas (?:ton image|mon image|l'image|(?:ton|mon|le) dessin))",
  "(?:montre moi|(?:peux tu|pourrais tu|(?:est ce que )?tu peux) me montrer) (?:le (?:dernier )?dessin|la derniere image)(?: que tu (?:as (?:fait|cree)|viens de faire))?(?:,? s'il te plait)?",
  '(?:car|parce que)'
);
const missingEn = missingDrawing(
  "i (?:can't|cannot|can not|don't|do not) see (?:your|my|the) (?:picture|image|drawing)",
  '(?:please show me|show me|(?:can|could) you (?:please )?show me) (?:the (?:last |latest )?(?:drawing|picture)|my drawing)(?:,? please)?',
  'because'
);

async function statusReply({ text, language, session, conversations, service, scope }) {
  if (typeof text !== 'string' || text.length > 180) return '';
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/’/g, "'").trim().replace(/[?!.]+$/, '').replace(/[-\s]+/g, ' ').trim();
  const missing = missingFr.test(words) || missingEn.test(words);
  if (!missing && !statusQuestion.test(words)) return '';
  try {
    const latest = (await recentBlocks({ conversations, session })).find(block => block.source === 'local' && block.presentation !== 'illustration');
    if (!UUID.test(latest?.operation?.id || '')) return '';
    // Both the latest explicit request and the latest scoped explicit receipt
    // must identify the same drawing. Never fall back to an older success.
    const operation = (await service.listForConversation(scope)).find(op => !op.admissionPolicy);
    if (!operation || operation.id !== latest.operation.id) return '';
    const en = language === 'en';
    if (ready(operation)) {
      if (missing) return en ? 'Your drawing is ready. I cannot verify whether it appeared on your screen.'
        : 'Ton dessin est prêt. Je ne peux pas vérifier s’il s’affiche sur ton écran.';
      return en ? 'Your drawing is ready.' : 'Ton dessin est prêt.';
    }
    switch (operation.state) {
      case 'failed': return en ? 'The drawing request failed.' : 'La création de ton dessin a échoué.';
      case 'cancelled': return en ? 'The drawing request was cancelled.' : 'La demande de dessin a été annulée.';
      case 'accepted':
      case 'queued': return en ? 'Your drawing request is awaiting processing.' : 'Ta demande de dessin est en attente.';
      case 'reserving':
      case 'generating':
      case 'archiving':
      case 'restoring': return en ? 'Your drawing is being prepared.' : 'Ton dessin est en préparation.';
      default: return en ? 'The drawing’s availability is unconfirmed.' : 'La disponibilité du dessin n’est pas confirmée.';
    }
  } catch { return ''; }
}

module.exports = { statusReply };
