'use strict';

const { normalizeRecognition, MARKS, MEASURES } = require('../../../public/js/voice/voice-timeline');

// A voice turn's browser timeline: offsets in ms from the moment the end of the
// person's speech was decided. A surface stores only these known marks, as
// bounded whole numbers, on the turn it recorded.
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
  // A measure alone is not a timeline; an unusable one is dropped, never fatal.
  for (const measure of MEASURES) {
    const value = input[measure];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_OFFSET_MS) timings[measure] = Math.round(value);
  }
  const recognition = normalizeRecognition(input.recognition);
  return { ...timings, interrupted: input.interrupted === true, ...(recognition && { recognition }),
    ...(['completed', 'failed'].includes(input.playbackOutcome) && { playbackOutcome: input.playbackOutcome }) };
}

module.exports = { normalizeVoiceTimings, MARKS, MEASURES, MAX_OFFSET_MS };
