/* Presentation preferences reuse the catalog; they never author identities. */
(function (root) {
  'use strict';
  const key = 'household.conversation.preferences.v2';
  const legacyKey = 'household.conversation.preferences.v1';
  function visual(value) {
    if (!value || !['initials', 'orb'].includes(value.style)) return null;
    return { style: value.style, color: /^#[a-f0-9]{6}$/i.test(value.color || '') ? value.color.toLowerCase() : '#52cfc5' };
  }
  function profile(value = {}) {
    const selected = selections(value?.selections);
    return { language: ['auto', 'fr', 'en'].includes(value?.language) ? value.language : 'auto',
      voice: ['masculine', 'feminine'].includes(value?.voice) ? value.voice : '',
      ...(Object.keys(selected).length ? { selections: selected } : {}), visual: visual(value?.visual) };
  }
  function selections(value) {
    const result = {};
    for (const language of ['fr', 'en']) {
      const key = value?.[language];
      if (typeof key === 'string' && /^(kokoro|windows_sapi|voxcpm)\|[^\r\n]{1,120}$/.test(key)) result[language] = key;
    }
    return result;
  }
  function read(storage, personas) {
    let saved, legacy;
    try { saved = JSON.parse(storage.getItem(key) || 'null'); legacy = JSON.parse(storage.getItem(legacyKey) || '{}'); } catch { /* clean defaults */ }
    const profiles = Object.create(null);
    for (const p of personas) profiles[p.id] = profile(saved?.profiles?.[p.id]
      || { language: legacy?.language, voice: legacy?.voices?.[p.id] });
    const id = saved?.personaId || legacy?.personaId;
    return { personaId: personas.some(p => p.id === id) ? id : personas.find(p => p.id === 'nestor')?.id || personas[0]?.id,
      interruption: saved?.interruption !== false,
      lastVoice: profile({ voice: saved?.lastVoice }).voice, profiles };
  }
  function save(storage, preferences) {
    try { storage.setItem(key, JSON.stringify(preferences)); return true; } catch { return false; }
  }
  function speechFor(persona, language, preferences = {}) {
    const selected = selections(preferences?.selections)[language];
    if (selected) { const index = selected.indexOf('|'); return { provider: selected.slice(0, index), language, voice: selected.slice(index + 1) }; }
    const voice = persona?.voice || {};
    const presentation = preferences?.presentation || voice.presentation || 'feminine';
    const voices = presentation === voice.presentation ? voice.voices : null;
    const defaults = presentation === 'masculine'
      ? { en: 'am_michael', fr: 'am_michael:0.50+ff_siwis:0.50' }
      : { en: 'af_heart', fr: 'ff_siwis' };
    return { provider: voice.provider || 'kokoro', language, voice: voices?.[language] || (!voice.provider || voice.provider === 'kokoro' ? defaults[language] : ''), presentation };
  }
  function chosenVoice(persona, override, lastVoice) {
    return profile({ voice: override }).voice || persona?.voice?.presentation
      || profile({ voice: lastVoice }).voice || 'feminine';
  }
  // The click unlocks a speaker context before the asynchronous synthesis call.
  // No microphone, private conversation, Open hold or model request is opened.
  async function preview(fetchBytes, signal, gain = 1) {
    const requestStartedAt = root.performance.now();
    const Context = root.AudioContext || root.webkitAudioContext;
    if (!Context) throw new Error('Audio playback is unavailable in this browser.');
    const context = new Context();
    let source, finish = () => {}, closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { source?.stop(); } catch { /* already ended */ }
      source?.disconnect(); finish();
      context.close().catch(() => {});
    };
    signal.addEventListener('abort', close, { once: true });
    try {
      if (signal.aborted) return;
      await context.resume();
      if (signal.aborted) return;
      const bytes = await fetchBytes(signal);
      if (signal.aborted) return;
      const output = context.createGain();
      output.gain.value = Number(gain) || 1;
      output.connect(context.destination);
      if (root.VoixAudio) return await new root.VoixAudio.Player(context, { destinations: [output] }).play(bytes, signal, { requestStartedAt });
      const buffer = await context.decodeAudioData(bytes);
      if (signal.aborted) return;
      await new Promise((resolve, reject) => {
        finish = resolve;
        source = context.createBufferSource(); source.buffer = buffer;
        source.connect(output); source.onended = resolve;
        try { source.start(); } catch (error) { reject(error); }
      });
    } finally { signal.removeEventListener('abort', close); close(); }
  }
  const api = { visual, profile, selections, read, save, speechFor, chosenVoice, preview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PersonaPresentation = api;
})(typeof window === 'undefined' ? globalThis : window);
