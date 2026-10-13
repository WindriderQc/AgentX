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
    finish(outcome) { if (['completed', 'failed'].includes(outcome)) this.playbackOutcome = outcome; }
    values(interrupted = false) { return { ...this.marks, ...this.measures, interrupted: interrupted === true,
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

  const api = { VoiceTimeline, MARKS, MEASURES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgentXVoiceTimeline = api;
})(typeof window === 'undefined' ? globalThis : window);
