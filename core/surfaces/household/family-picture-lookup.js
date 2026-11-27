'use strict';

const { familyAlbumTurn } = require('./family-album-access');
const { familyAlbumReceipts } = require('./family-album-receipts');

const { CATALOG, normalize } = require('./sound-library');
const fr = /^(?:(?:est-ce que tu peux|peux-tu|pourrais-tu) me montrer|montre-moi|(?:peux-tu|pourrais-tu) afficher|affiche-moi) (?:une image|une illustration) (?:de |du |d')([\p{L}][\p{L} '-]*)[ ?!.]*$/u;
const en = /^(?:(?:can|could) you (?:please )?show me|(?:please )?show me) (?:an image|a picture) of ([a-z][a-z '-]*)[ ?!.]*$/;
const word = text => normalize(text).replace(/[‐‑]/g, '-').trim();
const names = new Map();
for (const animal of CATALOG) for (const name of animal.names || []) {
  const key = word(name);
  if (!names.has(key)) names.set(key, animal);
  else if (names.get(key) !== animal) names.set(key, null);
}

// Intent alone does not authorize sending arbitrary speech to a search provider.
function genericPicture(text) {
  if (typeof text !== 'string' || text.length > 160 || /[,;:<>\n\r]/.test(text)) return null;
  const clean = word(text).replace(/[.!?]+$/, '').trim();
  if (/\b(?:artx|puis|ensuite|then|album|albums|galerie|gallery|photos)\b|\b(?:et|and) (?:montre|affiche|ouvre|cherche|dessine|explique|show|open|search|draw|explain)\b/i.test(clean)) return null;
  const match = fr.exec(clean) || en.exec(clean);
  if (!match) return null;
  const exact = match[1].trim().replace(/ (?:s'il te plait|svp|stp|please)$/, '').replace(/^(?:(?:un|une|le|la|les|des|the|a|an) |l')/, '');
  return { subject: exact, animal: names.get(exact) || null };
}

// An explicit household source is never a public-image or drawing request.
function householdPicture(text) {
  if (typeof text !== 'string' || text.length > 160 || /[,;:<>/\\\n\r]/.test(text)) return null;
  const clean = text.normalize('NFC').toLowerCase().replace(/[’ʼ]/g, "'")
    .replace(/[‐‑]/g, '-').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  const localFr = /^(?:(?:est-ce que tu peux|peux-tu|pourrais-tu) me (?:montrer|trouver)|montre-moi|trouve-moi|retrouve(?:-moi)?|cherche|affiche-moi) (?:une|la|des) (?:photo|photos|image|images) (?:de |du |d')([\p{L}\p{N}][\p{L}\p{N} '\-]{0,79}) dans (?:mes|nos|les) (photos|médias|medias)(?: s'il te plaît)?$/u;
  const localEn = /^(?:(?:can|could) you (?:please )?(?:show me|find)|(?:please )?(?:show me|find)) (?:a|the|some) (?:photo|photos|image|images|picture|pictures) of ([\p{L}\p{N}][\p{L}\p{N} '\-]{0,79}) in (?:my|our|the) (photos|media)(?: please)?$/u;
  const possessiveFr = /^(?:montre-moi|affiche-moi|trouve-moi|retrouve|cherche) (?:nos|mes) photos (?:de |du |d')([\p{L}\p{N}][\p{L}\p{N} '\-]{0,79})$/u;
  const possessive = possessiveFr.exec(clean);
  const exact = localFr.exec(clean) || localEn.exec(clean);
  const subject = exact?.[1] || possessive?.[1];
  if (!subject || /\b(?:(?:puis|ensuite|then)|(?:et|and) (?:montre|affiche|ouvre|cherche|dessine|explique|show|open|search|draw|explain))\b/.test(subject)) return null;
  return { source: possessive || exact[2] === 'photos' ? 'photos' : 'media', query: subject.trim() };
}

async function householdReply(intent, { language, signal, turnId, albumAllowed = false, issueAlbumImage,
  album = () => require('../../src/services/photos/photoFrameService').createPhotoFrameService() }) {
  const en = language === 'en';
  const unavailable = en ? 'The approved Family album is unavailable here.' : 'L’album approuvé n’est pas accessible ici.';
  // There is no explicitly approved general Media source in this route.
  if (!albumAllowed || typeof issueAlbumImage !== 'function' || intent.source !== 'photos') return { text: unavailable, display: [] };
  signal.throwIfAborted();
  let selected;
  try { selected = await album().lookup(intent.query); }
  catch {
    signal.throwIfAborted();
    return { text: unavailable, display: [] };
  }
  signal.throwIfAborted();
  if (!selected) return { text: en ? 'I couldn’t find a matching photo in the approved album.'
    : 'Je n’ai pas trouvé de photo correspondante dans l’album approuvé.', display: [] };
  const src = issueAlbumImage(selected.id);
  if (!src) return { text: unavailable, display: [] };
  const block = { id: 'family-picture', key: 'family-picture:' + turnId, kind: 'image', source: 'photos',
    title: en ? 'Photo from the approved album' : 'Photo de l’album approuvé', body: en ? 'Family photo' : 'Photo de famille',
    status: 'found', image: { url: src, sourceLabel: en ? 'Approved album' : 'Album approuvé' } };
  return { text: en ? 'I found a photo in the approved album.' : 'J’ai trouvé une photo dans l’album approuvé.', display: [block] };
}

async function reply({ text, language, visuals, signal, turnId, albumAllowed, album, issueAlbumImage }) {
  const local = householdPicture(text);
  if (local) return householdReply(local, { language, signal, turnId, albumAllowed, album, issueAlbumImage });
  if (visuals?.reviewedFamilyPicturesEnabled?.()) return null;
  const intent = genericPicture(text);
  if (!intent) return null;
  const en = language === 'en';
  const none = en ? 'No approved public image source is available right now.' : 'Je n’ai pas de source publique d’images approuvée pour le moment.';
  if (!visuals.sources({ family: true }).includes('web')) return { text: none, display: [] };
  if (!intent.animal) return { text: en ? 'My public picture catalogue does not cover that subject.'
    : 'Mon catalogue d’images publiques ne couvre pas ce sujet.', display: [] };

  signal.throwIfAborted();
  const block = { id: 'family-picture', key: 'family-picture:' + turnId, kind: 'image', source: 'web',
    title: en ? 'Animal picture' : 'Image d’animal', body: animalSearchQuery(intent.subject, language) };
  const found = await visuals.present(block, { family: true, language }).catch(() => null);
  signal.throwIfAborted();
  if (found?.source !== 'web' || found.status !== 'found' || !found.image?.url) {
    return { text: en ? 'I couldn’t find a picture of that animal right now.' : 'Je n’ai pas trouvé d’image de cet animal pour le moment.', display: [] };
  }
  return { text: en ? 'I found a picture.' : 'J’ai trouvé une image.', display: [found] };
}

// The normalized label selects a catalogue row. Only its reviewed description
// can leave Core as an animal search query.
function animalSearchQuery(label, language) {
  const animal = names.get(label);
  return animal ? 'animal ' + animal.label[language === 'en' ? 'en' : 'fr'].split(' (')[0] : '';
}

function replyForTurn(device, packId, session, request) {
  return reply({ ...request, albumAllowed: familyAlbumTurn(device, packId, session.scopeId),
    issueAlbumImage: id => familyAlbumReceipts.issue(device, session.sessionId, id) });
}

module.exports = { genericPicture, householdPicture, reply, replyForTurn, animalSearchQuery };
