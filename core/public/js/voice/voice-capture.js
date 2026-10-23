/* Microphone endpointing and bounded speculative recognition. No conversation writes. */
(function (root) {
  'use strict';
  // Bounded energy endpointing: retain a short lead-in, ignore brief clicks,
  // and finish after silence. This is not a wake-word or speaker recognizer.
  // A turn ends after one second of silence, so a spoken hesitation ("euh…")
  // does not cut the sentence; a barge-in over Nestor still ends quickly.
  const TURN_END_SILENCE_MS = 1000, INTERRUPTION_END_SILENCE_MS = 250;
  // A short reply must reach the same local speech decoder as an interruption.
  // Keep isolated clicks below 100 ms out; the server VAD still judges speech.
  const MINIMUM_VOICE_MS = 100;
  // Recognition starts halfway through that second, on what was said so far. If the
  // silence holds, its text is ready when the turn ends; if the person goes on, it is dropped.
  const EARLY_RECOGNITION_SILENCE_MS = 500;
  // Recognition measured warm for about a minute after it last ran, and slower after that.
  const RECOGNITION_WARM_INTERVAL_MS = 45000;
  // Match the transcription upload ceiling (32 MiB), leaving room for WAV
  // and multipart headers. Reaching it is an explicit error, never a partial turn.
  const MAX_CAPTURE_BYTES = 32 * 1024 * 1024 - 64 * 1024;
  class Endpoint {
    constructor(rate, minimumVoiceMs = MINIMUM_VOICE_MS, endSilenceMs = TURN_END_SILENCE_MS, threshold = .015) { this.threshold = threshold; this.rate = rate; this.minimumVoiceMs = minimumVoiceMs; this.endSilenceMs = endSilenceMs; this.maxSamples = MAX_CAPTURE_BYTES / 2; this.reset(); }
    reset() {
      this.frames = []; this.preRoll = []; this.preSamples = 0;
      this.voiceSamples = 0; this.silenceSamples = 0; this.total = 0;
      this.onsetGap = 0;
      this.speaking = false;
      this.level = 0;
      this.earlyId = null; this.earlyTaken = false; this.events = [];
      this.heard = 0; this.probed = false;
      this.lastSpeechSample = 0; this.offeredSpeechSample = -1; this.lastSnapshotSample = 0;
    }
    // What happened since the last call: `{ type: 'early', id, samples }` when a pause is
    // long enough to start recognition, `{ type: 'resumed', id }` when speech went on after it.
    drain() { const events = this.events; this.events = []; return events; }
    push(samples) {
      const energy = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / samples.length);
      this.level = energy;
      const voiced = energy >= this.threshold;
      if (!this.speaking) {
        this.preRoll.push(samples); this.preSamples += samples.length;
        while (this.preSamples > this.rate * 0.35 && this.preRoll.length > 1) {
          this.preSamples -= this.preRoll.shift().length;
        }
        if (voiced) { this.voiceSamples += samples.length; this.onsetGap = 0; }
        else {
          this.onsetGap += samples.length;
          // Brief unvoiced consonants must not restart the onset detector.
          if (this.onsetGap > this.rate * 0.08) this.voiceSamples = 0;
        }
        if (this.voiceSamples < this.rate * this.minimumVoiceMs / 1000) return null;
        this.speaking = true;
        this.frames = this.preRoll; this.total = this.preSamples; this.lastSpeechSample = this.total;
        this.preRoll = []; this.preSamples = 0;
        return null;
      }
      if (this.total + samples.length > this.maxSamples) {
        throw new Error('This utterance is longer than the accepted size. Pause between ideas, then turn the microphone back on. No partial message was sent.');
      }
      this.frames.push(samples); this.total += samples.length; this.heard += samples.length;
      this.silenceSamples = voiced ? 0 : this.silenceSamples + samples.length;
      if (voiced) this.lastSpeechSample = this.total;
      if (voiced && this.earlyId !== null) { this.events.push({ type: 'resumed', id: this.earlyId }); this.earlyId = null; }
      const join = () => {
        const joined = new Float32Array(this.total);
        let offset = 0;
        for (const frame of this.frames) { joined.set(frame, offset); offset += frame.length; }
        return joined;
      };
      // `{ type: 'probe', samples }` once, when the sound has gone on for `probeMs`.
      if (this.probeMs && !this.probed && this.heard >= this.rate * this.probeMs / 1000) {
        this.probed = true; this.events.push({ type: 'probe', samples: join() });
      }
      if (this.silenceSamples < this.rate * this.endSilenceMs / 1000) {
        const pause = this.earlySilenceMs && !voiced && this.earlySilenceMs < this.endSilenceMs
          && this.silenceSamples >= this.rate * this.earlySilenceMs / 1000;
        // Whole-clip speculation is bounded to short turns. Long turns keep the
        // existing final-pause recognition; no transcript or audio is truncated.
        const rolling = this.progressive && voiced && this.total <= this.rate * 15
          && this.total - this.lastSnapshotSample >= this.rate * 2;
        if ((pause || rolling) && this.offeredSpeechSample !== this.lastSpeechSample) {
          this.earlyId = this.earlySeq = (this.earlySeq || 0) + 1;
          this.offeredSpeechSample = this.lastSpeechSample; this.lastSnapshotSample = this.total;
          this.events.push({ type: 'early', id: this.earlyId, samples: join(), progressive: !!this.progressive,
            speechSample: this.lastSpeechSample });
        }
        return null;
      }
      const result = join(), completedSilenceMs = this.silenceSamples / this.rate * 1000;
      // The pause that started recognition ran to the end of the turn: that text is the turn's.
      const completedEarlyId = this.offeredSpeechSample === this.lastSpeechSample ? this.earlyId : null, pending = this.events, sequence = this.earlySeq;
      this.reset();
      this.completedSilenceMs = completedSilenceMs; this.completedEarlyId = completedEarlyId; this.events = pending; this.earlySeq = sequence;
      return result;
    }
  }


  // One HTTP recognizer at a time, plus the latest waiting snapshot. Invalidating
  // coverage never starts a replacement beside an unfinished native decode.
  class SpeculativeRecognition {
    constructor(transcribe) { this.transcribe = transcribe; this.active = null; this.pending = null; this.current = null; }
    offer(blob, language, signal, info = {}) {
      this.invalidate();
      if (signal.aborted) return null;
      let resolve;
      const item = { ...info, bytes: blob.size, blob, language, signal, abort: new AbortController(),
        result: new Promise(done => { resolve = done; }), resolve: value => resolve(value) };
      item.cancel = () => { item.abort.abort(); item.resolve(null); if (this.pending === item) this.pending = null; };
      signal.addEventListener('abort', item.cancel, { once: true });
      this.current = item; this.pending = item; this.pump();
      return item;
    }
    invalidate(id) {
      const item = this.current;
      if (!item || id !== undefined && item.id !== id) return;
      this.current = null; item.resolve(null);
      if (this.pending === item) { this.pending = null; item.signal.removeEventListener('abort', item.cancel); item.blob = null; }
    }
    pump() {
      if (this.active || !this.pending) return;
      const item = this.active = this.pending; this.pending = null;
      let request;
      try { request = this.transcribe(item.blob, item.language, item.abort.signal); } catch { request = null; }
      item.blob = null;
      Promise.resolve(request).then(value => item.resolve(value ? { value } : null), () => item.resolve(null))
        .finally(() => { item.signal.removeEventListener('abort', item.cancel); this.active = null; this.pump(); });
    }
    reset() {
      this.invalidate();
      this.active?.cancel();
    }
  }
  const api = { Endpoint, SpeculativeRecognition, TURN_END_SILENCE_MS, INTERRUPTION_END_SILENCE_MS,
    MINIMUM_VOICE_MS, EARLY_RECOGNITION_SILENCE_MS, RECOGNITION_WARM_INTERVAL_MS, MAX_CAPTURE_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceCapture = api;
})(typeof window === 'undefined' ? globalThis : window);
