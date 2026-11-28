'use strict';

const { familyAlbumTurn } = require('./family-album-access');
const { familyAlbumReceipts } = require('./family-album-receipts');

const { CATALOG, normalize } = require('./sound-library');
const fr = /^(?:(?:est-ce que tu peux|peux-tu|pourrais-tu) me montrer|montre-moi|(?:peux-tu|pourrais-tu) afficher|affiche-moi) (?:une image|une illustration) (?:de |du |d')([\p{L}][\p{L} '-]*)[ ?!.]*$/u;
const en = /^(?:(?:can|could) you (?:please )?show me|(?:please )?show me) (?:an image|a picture) of ([a-z][a-z '-]*)[ ?!.]*$/;
const { fold } = require('../../src/services/photos/photoFilters');
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
  const unavailable = en ? 'Family photo search is unavailable here.' : 'La photothèque Famille n’est pas accessible ici.';
  // There is no explicitly approved general Media source in this route.
  if (!albumAllowed || typeof issueAlbumImage !== 'function' || intent.source !== 'photos') return { text: unavailable, display: [] };
  signal.throwIfAborted();
  let selected;
  try { selected = await album().lookup(intent.query, signal); }
  catch {
    signal.throwIfAborted();
    return { text: unavailable, display: [] };
  }
  signal.throwIfAborted();
  if (!selected) return { text: en ? 'I couldn’t find a matching photo in the Family library.'
    : 'Je n’ai pas trouvé de photo correspondante dans nos photos.', display: [] };
  const src = issueAlbumImage(selected.id);
  if (!src) return { text: unavailable, display: [] };
  const block = { id: 'family-picture', key: 'family-picture:' + turnId, kind: 'image', source: 'photos',
    title: en ? 'Photo from the Family library' : 'Photo de notre bibliothèque', body: en ? 'Family photo' : 'Photo de famille',
    status: 'found', image: { url: src, sourceLabel: en ? 'Family library' : 'Nos photos' } };
  return { text: en ? 'I found a photo in the Family library.' : 'J’ai trouvé une photo dans nos photos.', display: [block] };
}

async function reply({ text, language, visuals, signal, turnId, albumAllowed, album, issueAlbumImage, choice }) {
  const local = choice?.source === 'photos' ? choice : householdPicture(text);
  if (local) return householdReply(local, { language, signal, turnId, albumAllowed, album, issueAlbumImage });
  const reviewed = visuals?.reviewedFamilyPicturesEnabled?.();
  if (reviewed && !choice) return null;
  const intent = choice ? { subject: word(choice.query), animal: names.get(word(choice.query)) } : genericPicture(text);
  if (!intent) return null;
  const en = language === 'en';
  const none = en ? 'No approved public image source is available right now.' : 'Je n’ai pas de source publique d’images approuvée pour le moment.';
  if (!visuals.sources({ family: true }).includes('web')) return { text: none, display: [] };
  if (!intent.animal && !(reviewed && visuals.hasReviewedFamilyPicture?.(intent.subject))) return { text: en ? 'My public picture catalogue does not cover that subject.'
    : 'Mon catalogue d’images publiques ne couvre pas ce sujet.', display: [] };

  signal.throwIfAborted();
  const block = { id: 'family-picture', key: 'family-picture:' + turnId, kind: 'image', source: 'web',
    title: en ? 'Web picture' : 'Image du Web', body: reviewed ? intent.subject : animalSearchQuery(intent.subject, language) };
  const found = await visuals.present(block, { family: true, language }).catch(() => null);
  signal.throwIfAborted();
  if (found?.source !== 'web' || found.status !== 'found' || !found.image?.url) {
    return { text: en ? 'I couldn’t find that picture on the Web.' : 'Je n’ai pas trouvé d’image sur le Web pour le moment.', display: [] };
  }
  return { text: en ? 'I found a picture.' : 'J’ai trouvé une image.', display: [found] };
}

// The normalized label selects a catalogue row. Only its reviewed description
// can leave Core as an animal search query.
function animalSearchQuery(label, language) {
  const animal = names.get(label);
  return animal ? 'animal ' + animal.label[language === 'en' ? 'en' : 'fr'].split(' (')[0] : '';
}

// A source-only answer may refer only to a recent, uninterrupted sequence
// of actual photo lookup turns within this Family session.
function sourceOnly(text) {
  const value = fold(text).replace(/[?!.]+$/, '').trim();
  if (/^(?:(?:plutot )?sur (?:le web|internet)|(?:the )?web|on the web)$/.test(value)) return 'web';
  if (/^(?:plutot )?(?:(?:dans )?(?:nos|mes) photos|(?:dans |sur )?immich|(?:in )?our photos)$/.test(value)) return 'photos';
  return null;
}

function photoChoice(text) {
  if (typeof text !== 'string' || text.length > 160 || /[,;:<>/\\\r\n]/.test(text)) return null;
  const local = householdPicture(text);
  if (local) return local;
  const clean = text.normalize('NFC').toLowerCase().replace(/[’ʼ]/g, "'").replace(/[‐‑]/g, '-').trim()
    .replace(/[?!.]+$/, '').trim();
  const suffix = /\s+(sur (?:le web|internet)|on the web|(?:dans|sur|in) immich)$/.exec(clean);
  const phrase = suffix ? clean.slice(0, suffix.index) : clean;
  const request = /^(?:montre-moi|affiche-moi|trouve(?:-moi)?|retrouve(?:-moi)?|cherche|peux-tu me montrer|show me|find) (?:(?:(?:une?|la|des|les|a|an) (?:vraie? |real )?(?:photos?|images?|pictures?)) (?:de |du |des |d'|of )|(?=(?:un |une |le |la |l'|a |an )))([\p{L}\p{N}][\p{L}\p{N} '\-]{0,79})$/u.exec(phrase);
  if (!request || /\b(?:puis|ensuite|then|album|galerie|gallery|photos|médias|immich|internet|web)\b/.test(request[1])) return null;
  const subject = request[1].replace(/^(?:(?:un|une|le|la|les|a|an|the) |l')/, '').trim();
  // An ordinary request to show a page or a calculation keeps its own route.
  const photo = /\b(?:photos?|pictures?)\b/.test(phrase);
  if (!suffix && !photo && (genericPicture(phrase) || !names.get(word(subject)))) return null;
  if (!suffix) return { source: 'ask', query: subject };
  return { source: suffix[1].endsWith('immich') ? 'photos' : 'web', query: subject };
}

async function previousPhoto(conversations, session) {
  if (!conversations) return null;
  const rows = await conversations.listTurns({ sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId },
    { sort: { createdAt: -1 }, limit: 6 });
  for (const row of rows) {
    const age = Date.now() - Date.parse(row.createdAt);
    if (row.sessionId !== session.sessionId || row.scopeId !== session.scopeId || row.packId !== session.packId
        || row.knowledgeStatus !== 'not-required-picture-lookup' || row.safetyFlags?.length || row.interrupted
        || !Number.isFinite(age) || age < 0 || age > 120000) return null;
    const initial = photoChoice(row.inputText);
    if (initial) return initial.query;
    const generic = genericPicture(row.inputText);
    if (generic?.animal) return generic.subject;
    if (!sourceOnly(row.inputText)) break;
  }
  return null;
}

async function replyForTurn(device, packId, session, request) {
  let choice = photoChoice(request.text);
  const source = sourceOnly(request.text);
  const en = request.language === 'en';
  if (source) {
    const query = await previousPhoto(request.conversations, session);
    if (!query) return { text: en ? 'What would you like a photo of?' : 'Tu veux une photo de quoi?', display: [] };
    choice = { source, query };
  }
  if (choice?.source === 'ask') return { text: en ? 'In our photos or on the Web?' : 'Dans nos photos ou sur le Web?', display: [] };
  return reply({ ...request, choice, albumAllowed: familyAlbumTurn(device, packId, session.scopeId),
    issueAlbumImage: id => familyAlbumReceipts.issue(device, session.sessionId, id) });
}

module.exports = { genericPicture, householdPicture, reply, replyForTurn, animalSearchQuery };
