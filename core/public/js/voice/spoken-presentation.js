/* Presentation limits, shared by Core reply channels and browser voice adapters. */
(function (root) {
  'use strict';
  const LIMITS = Object.freeze({ sentences: 3, characters: 600 });
  const POINTER = Object.freeze({ fr: 'Le texte complet est à l’écran. Je peux te le lire si tu veux.',
    en: 'The complete text is on screen. I can read it to you if you want.' });
  const ABBREVIATION = /\b(?:M|Mme|Mlle|Mr|Mrs|Ms|Dr|Dre|Pr|Prof|St|Ste|etc|e\.g|i\.e)\.$/i;
  const BOUNDARY = /[.!?]+(?:[ \t]*["'»”’)*_])*(?:\s+|$)/g;

  // An unfinished final sentence counts too. Decimals and common abbreviations
  // do not consume a sentence; punctuation split across deltas is reclassified.
  function sentenceCount(value) {
    const text = String(value || '').trim();
    let count = 0, end = 0;
    for (const match of text.matchAll(BOUNDARY)) {
      if (match[0].startsWith('.') && ABBREVIATION.test(text.slice(0, match.index + 1))) continue;
      count++; end = match.index + match[0].length;
    }
    return count + (text.slice(end).trim() ? 1 : 0);
  }
  function isLongReply(value) {
    const text = String(value || '').trim();
    return text.length > LIMITS.characters || sentenceCount(text) > LIMITS.sentences;
  }
  function readingRequested(text) {
    const value = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[’'-]/g, ' ').replace(/\s+/g, ' ').trim();
    return /^(?:(?:s il te plait|please)\s+)?(?:(?:peux tu|pourrais tu|pouvez vous|voudrais tu)\s+(?:me\s+)?lire\b|(?:lis|lisez)(?:\s+moi)?\b|(?:can|could|would) you\s+read\b|read\b)/.test(value);
  }
  // Presentation must keep help contacts and crisis instructions audible. This
  // is no safety classifier: a domain can additionally pass preserveSafety.
  function hasSafetyContent(text) {
    return /\b(?:911|9[ -]?8[ -]?8|8[ -]?1[ -]?1|1[ -]?866[ -]?(?:APPELLE|277[ -]?3553))\b|\b(?:suicide|988)\.ca\b|\b(?:suicid\w*|self[ -]harm|automutil\w*|danger imm[ée]diat|immediate danger|emergency services|services d’urgence)\b/i.test(String(text || ''));
  }
  function introduction(text, language) {
    const source = String(text || '').trim(), lang = String(language || '').startsWith('en') ? 'en' : 'fr';
    let at = 0;
    for (const match of source.matchAll(BOUNDARY)) {
      if (match[0].startsWith('.') && ABBREVIATION.test(source.slice(0, match.index + 1))) continue;
      at = match.index + match[0].length; break;
    }
    // Give a useful opening when it is already brief. The complete original is
    // retained separately; a long first sentence is never sliced into speech.
    const opening = at && at <= 200 ? source.slice(0, at).trim() : '';
    return [opening, POINTER[lang]].filter(Boolean).join(' ');
  }
  function ordinarySpeech(text, { language = 'fr', readAloud = false, preserveSafety = false } = {}) {
    return readAloud || preserveSafety || hasSafetyContent(text) || !isLongReply(text)
      ? String(text || '') : introduction(text, language);
  }

  // Hold at most one short spoken answer before deciding its presentation.
  // Once long, emit one introduction and update the complete screen text as it
  // arrives. No already-spoken prefix has to be recalled or repeated.
  function create({ language = 'fr', readAloud = false, preserveSafety = false, onSay = () => {}, onShow = () => {} } = {}) {
    let text = '', delivered = 0, shown = 0, long = false, ended = false, safety = preserveSafety;
    const flush = () => { const rest = text.slice(delivered); delivered = text.length; if (rest) onSay(rest); };
    const show = (force = false) => { if (force || !shown || text.length - shown >= 256) { shown = text.length; onShow(text); } };
    return {
      push(delta) {
        if (ended || !delta) return;
        delta = String(delta);
        text += delta;
        safety ||= hasSafetyContent(text);
        if (readAloud || safety) { if (long) show(); flush(); return; }
        if (!long && isLongReply(text)) { long = true; onSay(introduction(text, language)); }
        if (long) show();
      },
      end() { if (ended) return; ended = true; if (!long) flush(); else show(true); },
    };
  }
  const api = { LIMITS, sentenceCount, isLongReply, readingRequested, hasSafetyContent, ordinarySpeech, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXSpokenPresentation = api;
})(typeof window === 'undefined' ? globalThis : window);
