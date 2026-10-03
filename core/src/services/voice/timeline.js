'use strict';

// A voice turn's browser timeline: offsets in ms from the moment the end of the
// person's speech was decided. A surface stores only these known marks, as
// bounded whole numbers, on the turn it recorded.
const MARKS = Object.freeze(['sttDone', 'requestSent', 'firstDelta', 'holdingPhrase', 'firstAudio']);
const MAX_OFFSET_MS = 10 * 60 * 1000;

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
  return { ...timings, interrupted: input.interrupted === true };
}

module.exports = { normalizeVoiceTimings, MARKS, MAX_OFFSET_MS };
