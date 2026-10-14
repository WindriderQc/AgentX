/* Spoken intent, shared by Core reply channels and browser voice adapters. */
(function (root) {
  'use strict';
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
  // Conversational prose is spoken completely. Document/list summaries are
  // composed upstream with their full screen blocks; length cannot replace
  // an answer with a pointer. Keep this adapter for shared browser callers.
  function ordinarySpeech(text) { return String(text || ''); }
  function create({ onSay = () => {} } = {}) {
    let ended = false;
    return {
      push(delta) { if (!ended && delta) onSay(String(delta)); },
      end() { ended = true; },
    };
  }
  const api = { readingRequested, hasSafetyContent, ordinarySpeech, create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentXSpokenPresentation = api;
})(typeof window === 'undefined' ? globalThis : window);
