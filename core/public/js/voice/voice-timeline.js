/* Timeline of one voice turn: offsets in ms from the moment the end of the
   person's speech was decided. Browser timing, not an acoustic measurement. */
(function (root) {
  'use strict';
  const MARKS = Object.freeze(['sttDone', 'requestSent', 'firstDelta', 'holdingPhrase', 'firstAudio',
    'firstFrameScheduled', 'firstSignalScheduled']);
  // Durations in ms that explain the marks: the silence waited before the end of
  // speech was decided, the length of the captured clip, and the recognition time
  // the speech service reports (the rest of `sttDone` is upload and transport).
  const MEASURES = Object.freeze(['silenceMs', 'audioMs', 'sttServer']);

  // Content-free evidence only. The browser and Core use the same boundary;
  // decoder scores are diagnostics, never a confidence that the words are right.
  function normalizeRecognition(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
    const evidence = {};
    if (typeof input.recognitionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.recognitionId)) evidence.recognitionId = input.recognitionId;
    if (input.schema === 1) {
      const choices = { requestedLanguage: ['fr', 'en', 'auto', 'fr-en'], languageSource: ['requested', 'detected', 'constrained'],
        device: ['cpu', 'cuda'], computeType: ['float32', 'float16', 'int8', 'int8_float16', 'int8_float32', 'bfloat16', 'int8_bfloat16'] };
      for (const [key, allowed] of Object.entries(choices)) if (allowed.includes(input[key])) evidence[key] = input[key];
      if (typeof input.decodedLanguage === 'string' && /^[a-z]{2,3}$/.test(input.decodedLanguage)) evidence.decodedLanguage = input.decodedLanguage;
      for (const [key, low, high] of [['audioSeconds', 0, 86400], ['speechSeconds', 0, 86400], ['queueMs', 0, 3600000],
        ['decodeMs', 0, 3600000], ['segments', 0, 100000], ['avgLogProbability', -100, 0],
        ['maxNoSpeechProbability', 0, 1], ['maxCompressionRatio', 0, 100]]) {
        const value = input[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high
            && (key !== 'segments' || Number.isInteger(value))) evidence[key] = value;
      }
      if (typeof input.normalizationChanged === 'boolean') evidence.normalizationChanged = input.normalizationChanged;
    }
    if (!Object.keys(evidence).length) return undefined;
    if (['early', 'complete'].includes(input.mode)) evidence.mode = input.mode;
    for (const key of ['submittedBytes', 'captureBytes']) {
      if (Number.isInteger(input[key]) && input[key] >= 0 && input[key] <= 32 * 1024 * 1024) evidence[key] = input[key];
    }
    return { schema: 1, ...evidence };
  }

  class VoiceTimeline {
    constructor(now = () => Date.now()) { this.now = now; this.origin = now(); this.marks = {}; this.measures = {}; this.sent = false; this.lastSent = null; this.queued = null; this.reporting = Promise.resolve(); this.playbackOutcome = null; }
    // Only the first occurrence of a mark counts.
    mark(name) {
      if (MARKS.includes(name) && this.marks[name] === undefined) this.marks[name] = Math.max(0, Math.round(this.now() - this.origin));
    }
    // A reported duration; anything that is not a finite, non-negative number is ignored.
    measure(name, value) {
      if (MEASURES.includes(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0) this.measures[name] = Math.round(value);
    }
    transcription(result, capture) {
      this.recognition = normalizeRecognition({ ...result?.recognition, recognitionId: result?.recognitionId, ...capture });
    }
    finish(outcome) { if (['completed', 'failed'].includes(outcome)) this.playbackOutcome = outcome; }
    values(interrupted = false) { return { ...this.marks, ...this.measures, interrupted: interrupted === true,
      ...(this.recognition && { recognition: { ...this.recognition } }),
      ...(this.playbackOutcome && { playbackOutcome: this.playbackOutcome }) }; }
    // Serialize changed snapshots: late completion/interruption must not be
    // lost after first scheduling, and an earlier response cannot overwrite it.
    async report(send, interrupted = () => false, ended = Promise.resolve()) {
      if (typeof send !== 'function' || this.marks.requestSent === undefined) return;
      const values = this.values(interrupted()), fingerprint = JSON.stringify(values);
      if (this.queued === fingerprint) return this.reporting;
      this.queued = fingerprint;
      this.reporting = this.reporting.then(async () => {
        const key = fingerprint;
        if (key === this.lastSent) return;
        this.sent = true;
        try {
          const receipt = await send(values); this.lastSent = key;
          if (receipt?.pending) {
            await ended;
            const latest = this.values(interrupted()); await send(latest); this.lastSent = JSON.stringify(latest);
          }
        } catch { /* a measurement never fails or delays a conversation */ }
      });
      return this.reporting;
    }
  }

  const api = { VoiceTimeline, MARKS, MEASURES, normalizeRecognition };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceTimeline = api;
})(typeof window === 'undefined' ? globalThis : window);
