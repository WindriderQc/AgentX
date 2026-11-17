'use strict';
// A conservative browsing policy over existing proposals, not a replacement analysis.
// Do not interpret OCR (which also occurs in actual photographs) as a document by itself.
const EXCLUDED = 'pochette|(?:album|cd)[ -]?cover|cover art|couverture (?:d[’\x27](?:un )?|de |du )(?:album|disque|livre)|'
  + '\\b(?:document|facture|reçu|recu|receipt|formulaire|ordonnance|ticket de caisse|carte d[’\x27]identit[eé])s?\\b|'
  + 'feuille(?:s)? (?:de |d[’\x27]un[e]? )?papier|sheet of paper|capture(?:s)? d[’\x27][eé]cran|screenshot|'
  + 'm[eè]me internet|internet meme|citation (?:illustr[eé]e|inspirante)|affiche publicitaire';
const text = { $concat: [{ $ifNull: ['$analysis.card.proposal.description', ''] }, ' ',
  { $reduce: { input: { $ifNull: ['$analysis.card.proposal.tags', []] }, initialValue: '',
    in: { $concat: ['$$value', ' ', '$$this'] } } }] };
const reason = { $switch: { branches: [
  { case: { $eq: ['$frame.selected', true] }, then: 'selected' },
  { case: { $gt: [{ $ifNull: ['$frame.revision', 0] }, 0] }, then: 'dismissed' },
  { case: { $regexMatch: { input: text, regex: EXCLUDED, options: 'i' } }, then: 'document-or-cover' },
  { case: { $eq: ['$analysis.card.proposal.privacyReview', true] }, then: 'privacy-review' },
  { case: { $ne: ['$analysis.card.proposal.quality', 'bonne'] }, then: 'quality' },
  { case: { $ne: ['$analysis.card.proposal.frameSuitability', 'oui'] }, then: 'model' },
], default: 'suggested' } };
module.exports = { reason };
