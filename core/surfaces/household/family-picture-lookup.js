'use strict';

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

async function reply({ text, language, visuals, signal, turnId }) {
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

module.exports = { genericPicture, reply, animalSearchQuery };
