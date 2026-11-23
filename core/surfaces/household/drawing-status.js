'use strict';

const { recentBlocks, ready, UUID } = require('./shown-images');

// Only standalone questions about the drawing. Edits, retries and requests to
// display an image still go through the normal turn and its safety boundaries.
function asksDrawingStatus(text) {
  if (typeof text !== 'string' || text.length > 100) return false;
  const words = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .trim().replace(/[?!.]+$/, '').replace(/[-\s]+/g, ' ').trim();
  return /^(?:(?:est ce que )?(?:mon|le) dessin est (?:pret|termine)|(?:mon|le) dessin est il (?:pret|termine)|(?:as tu|tu as) (?:fait|termine) (?:mon|le) dessin|ou (?:est|en est) (?:mon|le) dessin|is (?:my|the) drawing (?:ready|finished)|did you finish (?:my|the) drawing)$/.test(words);
}

async function statusReply({ text, language, session, conversations, service, scope }) {
  if (!asksDrawingStatus(text)) return '';
  try {
    const latest = (await recentBlocks({ conversations, session })).find(block => block.source === 'local' && block.presentation !== 'illustration');
    if (!UUID.test(latest?.operation?.id || '')) return '';
    // Both the latest explicit request and the latest scoped explicit receipt
    // must identify the same drawing. Never fall back to an older success.
    const operation = (await service.listForConversation(scope)).find(op => !op.admissionPolicy);
    if (!operation || operation.id !== latest.operation.id) return '';
    const en = language === 'en';
    if (ready(operation)) return en ? 'Your drawing is ready.' : 'Ton dessin est prêt.';
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
