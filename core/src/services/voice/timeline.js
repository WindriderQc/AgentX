'use strict';

// A voice turn's browser timeline: offsets in ms from the moment the end of the
// person's speech was decided. A surface stores only these known marks, as
// bounded whole numbers, on the turn it recorded.
const MARKS = Object.freeze(['sttDone', 'requestSent', 'firstDelta', 'holdingPhrase', 'firstAudio']);
const MAX_OFFSET_MS = 10 * 60 * 1000;
// Durations that explain the marks: silence waited before the end of speech was
// decided, length of the captured clip, recognition time reported by the speech service.
const MEASURES = Object.freeze(['silenceMs', 'audioMs', 'sttServer']);

function normalizeVoiceTimings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const timings = {};
  for (const mark of MARKS) {
    const value = input[mark];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_OFFSET_MS) return null;
    timings[mark] = Math.round(value);
  }
  if (!Object.keys(timings).length) return null;
  // A measure alone is not a timeline; an unusable one is dropped, never fatal.
  for (const measure of MEASURES) {
    const value = input[measure];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_OFFSET_MS) timings[measure] = Math.round(value);
  }
  return { ...timings, interrupted: input.interrupted === true };
}

module.exports = { normalizeVoiceTimings, MARKS, MEASURES, MAX_OFFSET_MS };
