/* Timeline of one voice turn: offsets in ms from the moment the end of the
   person's speech was decided. Browser timing, not an acoustic measurement. */
(function (root) {
  'use strict';
  const MARKS = Object.freeze(['sttDone', 'requestSent', 'firstDelta', 'holdingPhrase', 'firstAudio']);
  // Durations in ms that explain the marks: the silence waited before the end of
  // speech was decided, the length of the captured clip, and the recognition time
  // the speech service reports (the rest of `sttDone` is upload and transport).
  const MEASURES = Object.freeze(['silenceMs', 'audioMs', 'sttServer']);

  class VoiceTimeline {
    constructor(now = () => Date.now()) { this.now = now; this.origin = now(); this.marks = {}; this.measures = {}; this.sent = false; }
    // Only the first occurrence of a mark counts.
    mark(name) {
      if (MARKS.includes(name) && this.marks[name] === undefined) this.marks[name] = Math.max(0, Math.round(this.now() - this.origin));
    }
    // A reported duration; anything that is not a finite, non-negative number is ignored.
    measure(name, value) {
      if (MEASURES.includes(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0) this.measures[name] = Math.round(value);
    }
    values(interrupted = false) { return { ...this.marks, ...this.measures, interrupted: interrupted === true }; }
    // Sent once per turn, and only for a turn that reached the model. A surface
    // that keeps the turn's record answers { pending: true } while that record
    // is not written yet: the timeline is sent once more when `ended` settles.
    async report(send, interrupted = () => false, ended = Promise.resolve()) {
      if (this.sent || typeof send !== 'function' || this.marks.requestSent === undefined) return;
      this.sent = true;
      try {
        const receipt = await send(this.values(interrupted()));
        if (receipt?.pending) { await ended; await send(this.values(interrupted())); }
      } catch { /* a measurement never fails or delays a conversation */ }
    }
  }

  const api = { VoiceTimeline, MARKS, MEASURES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceTimeline = api;
})(typeof window === 'undefined' ? globalThis : window);
