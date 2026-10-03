'use strict';

(function exposeSpeechLanguage(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) { root.AgentXSpeech = api; root.NestorSpeech = api; }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const PROFILES = Object.freeze({
    en: Object.freeze({
      language: 'en',
      locale: 'en-CA',
      nativeLanguage: 'en-us',
      nativeVoice: 'af_heart',
      label: 'English'
    }),
    fr: Object.freeze({
      language: 'fr',
      locale: 'fr-CA',
      nativeLanguage: 'fr-fr',
      nativeVoice: 'ff_siwis',
      label: 'Français'
    })
  });

  // Both lists are function words only, and deliberately exclude anything that
  // is a word in the other language -- "a", "on", "son", "me", "part" all mean
  // something on both sides and would score for whichever list claimed them.
  // The original lists were built for long operator briefings and scored a
  // child's "quel bruit fait la vache?" as 0-0, which fell through to English
  // and spoke French text in an English voice.
  const FRENCH_WORDS = new Set([
    'alors', 'aide', 'au', 'aux', 'avec', 'bonjour', 'ce', 'ceci', 'cet', 'cette',
    'comment', 'dans', 'des', 'dit', 'du', 'elle', 'elles', 'est', 'et', 'faire',
    'fais', 'fait', 'font', 'français', 'ils', 'je', 'la', 'le', 'les', 'lui',
    'maintenant', 'merci', 'mes', 'moi', 'mon', 'ne', 'nous', 'oui', 'pas',
    'peut', 'peux', 'plus', 'pour', 'pourquoi', 'quand', 'que', 'quel', 'quelle',
    'qui', 'quoi', 'salut', 'sans', 'sont', 'sur', 'ta', 'tes', 'toi', 'ton', 'tout',
    'très', 'tu', 'un', 'une', 'vous'
  ]);
  const ENGLISH_WORDS = new Set([
    'and', 'answer', 'are', 'ask', 'brief', 'can', 'could', 'day', 'do', 'does',
    'english', 'for', 'from', 'hello', 'house', 'how', 'is', 'it', 'like',
    'make', 'memory', 'my', 'needs', 'now', 'of', 'operations', 'please',
    'priorities', 'ready', 'review', 'sound', 'sounds', 'that', 'the', 'them',
    'then', 'they', 'this', 'to', 'today', 'top', 'want', 'was', 'were', 'what',
    'why', 'will', 'with', 'would', 'you', 'your'
  ]);

  function normalizeSpeechLanguage(value) {
    const language = String(value || '').trim().toLowerCase().replace('_', '-');
    if (language === 'en' || language.startsWith('en-')) return 'en';
    if (language === 'fr' || language.startsWith('fr-')) return 'fr';
    return '';
  }

  // Nestor speaks Québécois French by default: English needs more English than
  // French words. `decided` separates a real score from that default.
  function scoreSpeechLanguage(text) {
    const source = String(text || '').toLowerCase();
    const words = source.normalize('NFKC').match(/[\p{L}']+/gu) || [];
    let french = /[àâçéèêëîïôùûüÿœæ]/u.test(source) ? 3 : 0;
    let english = 0;
    for (const word of words) {
      if (FRENCH_WORDS.has(word)) french += 1;
      if (ENGLISH_WORDS.has(word)) english += 1;
    }
    return { french, english, language: english > french ? 'en' : 'fr', decided: french !== english };
  }

  function detectSpeechLanguage(text, hint = '') {
    const explicit = normalizeSpeechLanguage(hint);
    if (explicit) return explicit;
    return scoreSpeechLanguage(text).language;
  }

  function speechProfile(text, hint = '') {
    return PROFILES[detectSpeechLanguage(text, hint)];
  }

  // Recognition preferences cannot override the language of generated words.
  // Ambiguous fragments (host names, OK) inherit the previous spoken clause.
  function replySpeechLanguage(text, fallback = '') {
    const score = scoreSpeechLanguage(text);
    return score.decided ? score.language : normalizeSpeechLanguage(fallback) || score.language;
  }

  // A language the person chose, as opposed to an automatic mode (auto, fr-en).
  function explicitSpeechLanguage(value) {
    const language = String(value || '').trim().toLowerCase().replace('_', '-');
    return ['fr-en', 'en-fr'].includes(language) ? '' : normalizeSpeechLanguage(language);
  }

  // One voice per turn: a franglais reply must not switch speakers between
  // clauses. A chosen French or English preference wins. In automatic mode the
  // language recognized in the user's speech decides, then the words they
  // used, then French.
  function turnSpeechLanguage(text, recognized = '', preferred = '') {
    const chosen = explicitSpeechLanguage(preferred);
    if (chosen) return chosen;
    const score = scoreSpeechLanguage(text);
    return normalizeSpeechLanguage(recognized) || (score.decided ? score.language : 'fr');
  }

  function withoutMediaReferences(text) {
    return String(text || '').replace(/\bMEDIA:\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s<>]+)/g, '').trim();
  }

  // Presentation-only cleanup at the speech boundary. Never rewrite the stored
  // reply, translate technical identifiers, or remove ordinary words (e.g. chouette).
  function speechText(text) {
    return withoutMediaReferences(text)
      .replace(/(```|~~~)[\s\S]*?(?:\1|$)/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/^[ \t]*\|.*\|[ \t]*$/gm, '')
      .replace(/[0-9#*]\uFE0F?\u20E3/gu, '')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u{E0020}-\u{E007F}]/gu, '')
      .replace(/\\([_*`])/g, '$1')
      .replace(/^[ \t]*```(?:[\w+-]+)?[ \t]*$/gm, '')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, '$2')
      .replace(/(^|\s)([*_])(\S(?:[^\n]*?\S)?)\2(?=\s|[.,!?;:]|$)/g, '$1$3')
      .replace(/^[ \t]*(?:#{1,6}\s+|>\s+|[-*•]\s+)/gm, '')
      .replace(/^[ \t]*\d{1,3}[.)][ \t]+(?=\S)/gm, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function transcriptionLanguage(value) {
    return normalizeSpeechLanguage(value) || 'fr-en';
  }

  function synthesisText(value, provider = 'kokoro') {
    const text = speechText(value);
    if (provider && provider !== 'kokoro') return text;
    // Kokoro's sentence splitter otherwise sends a closing quote on its own.
    // That fragment has no phonemes and fails the entire PCM stream.
    return text.replace(/([.!?\n])(?:[ \t]*[»”"])+(?=\s|$|[.!?,;:])/g, '$1').trim();
  }

  function pickBrowserVoice(voices, profile) {
    const expected = normalizeSpeechLanguage(profile?.language);
    const matches = Array.from(voices || []).filter((voice) => normalizeSpeechLanguage(voice.lang) === expected);
    if (!matches.length) return null;
    const exactLocale = matches.find((voice) => String(voice.lang || '').toLowerCase() === profile.locale.toLowerCase());
    return exactLocale || matches.find((voice) => voice.localService) || matches[0];
  }

  return Object.freeze({
    PROFILES,
    detectSpeechLanguage,
    normalizeSpeechLanguage,
    scoreSpeechLanguage,
    replySpeechLanguage,
    explicitSpeechLanguage,
    turnSpeechLanguage,
    speechText,
    synthesisText,
    withoutMediaReferences,
    transcriptionLanguage,
    pickBrowserVoice,
    speechProfile
  });
}));
