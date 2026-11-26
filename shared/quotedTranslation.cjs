'use strict';

// A complete request with one quoted operand. Multiple instructions, attached
// documents and references to external text keep their normal native owner.
function quotedTranslation(text) {
  if (typeof text !== 'string') return null;
  const fr = /^Traduis en (\p{L}{2,32})\s*:?\s*([«“"])([^«»“”"\r\n]+)([»”"])\s*[.!]?$/iu.exec(text.trim());
  const en = !fr && /^Translate\s+([«“"])([^«»“”"\r\n]+)([»”"])\s+into\s+(\p{L}{2,32})\s*[.!]?$/iu.exec(text.trim());
  if (!fr && !en) return null;
  const [open, source, close] = fr ? fr.slice(2) : en.slice(1, 4);
  if (!source.trim() || ({ '«': '»', '“': '”', '"': '"' })[open] !== close) return null;
  return { target: fr ? fr[1] : en[4], source: source.trim(), label: fr ? 'Traduction' : 'Translation' };
}

const translationSessionKey = id => 'agent:main:household:translation:' + id;
const isTranslationSession = key => /^agent:main:household:translation:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key || '');

module.exports = { quotedTranslation, translationSessionKey, isTranslationSession };
