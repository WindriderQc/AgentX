'use strict';

const { createHash } = require('node:crypto');

const NOTE_LIMIT = 100;
const CRITERIA = Object.freeze(['emotionBeforeAnalysis', 'oneQuestion', 'length', 'stance', 'lectureAvoidance']);
const STATUSES = Object.freeze(['met', 'missed', 'uncertain', 'not_applicable']);
const hashReply = content => createHash('sha256').update(content).digest('hex');
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

// Identity and measurements come from the canonical transcript, never the model.
// A target must be a complete last assistant message, not an earlier reply or
// a truncated excerpt. ordinal is its position in that canonical transcript.
function replyTarget(conversationId, turns) {
  const last = turns?.at(-1);
  if (last?.role !== 'assistant' || !last.id || !Number.isSafeInteger(last.ordinal)
    || last.ordinal < 1 || typeof last.content !== 'string' || !last.content.trim()) return null;
  const control = last.control || {};
  return {
    conversationId, replyId: last.id, replyOrdinal: last.ordinal,
    replyHash: hashReply(last.content), repliedAt: last.createdAt || null,
    mode: ['talk', 'analyze', 'challenge', 'plan'].includes(control.mode) ? control.mode : null,
    voice: typeof control.voice === 'boolean' ? control.voice : null
  };
}

function sameTarget(left, right) {
  return Boolean(left && right && left.conversationId === right.conversationId
    && left.replyId === right.replyId && left.replyOrdinal === right.replyOrdinal && left.replyHash === right.replyHash);
}

function measureReply(content, target) {
  const wordCount = content.trim().split(/\s+/u).filter(Boolean).length;
  const usualWordRange = target.voice === null ? null : target.voice ? [30, 90] : [60, 180];
  return {
    source: 'code', wordCountMethod: 'whitespace-delimited', wordCount,
    questionMarkCount: (content.match(/\?/gu) || []).length,
    // Punctuation counts do not establish the number or usefulness of questions.
    usualWordRange,
    withinUsualWordRange: usualWordRange ? wordCount >= usualWordRange[0] && wordCount <= usualWordRange[1] : null
  };
}

function supervisionNote(raw, { target, reply, model = null, promptVersion, coverage, now = new Date().toISOString() }) {
  if (!target || typeof reply !== 'string' || target.replyHash !== hashReply(reply)) return null;
  let status = raw == null ? 'missing' : 'invalid';
  let observations = null;
  let adjustment = '';
  if (raw && typeof raw === 'object' && raw.replyId === target.replyId && raw.replyHash === target.replyHash) {
    const entries = CRITERIA.map(criterion => {
      const item = raw.observations?.[criterion];
      if (!item || !STATUSES.includes(item.status) || typeof item.reason !== 'string' || !item.reason.trim()
        || (item.quote != null && typeof item.quote !== 'string')) return null;
      if ((criterion === 'stance' && target.mode === null || criterion === 'length' && target.voice === null)
        && item.status !== 'uncertain') return null;
      const quote = text(item.quote, 180);
      // A literal match establishes quotation provenance only, not the judgment.
      if (quote && !reply.includes(quote)) return null;
      return [criterion, { status: item.status, reason: text(item.reason, 180), quote,
        quoteMatched: Boolean(quote) }];
    });
    if (entries.every(Boolean) && (raw.adjustment == null || typeof raw.adjustment === 'string')) {
      status = 'available';
      observations = Object.fromEntries(entries);
      adjustment = text(raw.adjustment, 300);
    }
  }
  return {
    ...target, recordedAt: now, promptVersion,
    measurements: measureReply(reply, target),
    modelReview: { source: 'model', independent: false, model: text(model, 160) || null, status, observations, adjustment },
    coverage
  };
}

function normalizeNotes(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Map();
  for (const note of value) {
    if (!note || typeof note.conversationId !== 'string' || typeof note.replyId !== 'string'
      || !Number.isSafeInteger(note.replyOrdinal) || note.replyOrdinal < 1 || !/^[a-f0-9]{64}$/.test(note.replyHash)
      || !['available', 'missing', 'invalid'].includes(note.modelReview?.status)) continue;
    // Only server-written notes enter this field; it is never an import/input API.
    unique.set(`${note.conversationId}:${note.replyId}`, note);
  }
  return [...unique.values()].slice(-NOTE_LIMIT);
}

// Explicit retained-window counts, not lifetime counts, clinical outcomes or an
// independent model-quality score. Unknowns never enter the "met" denominator.
function summarizeNotes(notes = []) {
  const retained = normalizeNotes(notes);
  const criteria = Object.fromEntries(CRITERIA.map(key => [key, Object.fromEntries(STATUSES.map(status => [status, 0]))]));
  const modelReviews = { available: 0, missing: 0, invalid: 0 };
  const code = { source: 'code', repliesWithMultipleQuestionMarks: 0, belowUsualWordRange: 0, aboveUsualWordRange: 0, unknownWordRange: 0 };
  for (const note of retained) {
    modelReviews[note.modelReview.status] += 1;
    if (note.modelReview.status === 'available') for (const key of CRITERIA) {
      const status = note.modelReview.observations?.[key]?.status;
      if (STATUSES.includes(status)) criteria[key][status] += 1;
    }
    const measured = note.measurements;
    if (measured?.questionMarkCount > 1) code.repliesWithMultipleQuestionMarks += 1;
    if (!measured?.usualWordRange) code.unknownWordRange += 1;
    else if (measured.wordCount < measured.usualWordRange[0]) code.belowUsualWordRange += 1;
    else if (measured.wordCount > measured.usualWordRange[1]) code.aboveUsualWordRange += 1;
  }
  return { scope: 'retained_supervision_notes', limit: NOTE_LIMIT, replies: retained.length,
    firstRecordedAt: retained[0]?.recordedAt || null, lastRecordedAt: retained.at(-1)?.recordedAt || null,
    modelObservations: { source: 'model', independent: false, reviews: modelReviews, criteria }, measurements: code };
}

function nextReplyNote(state, conversationId, turns) {
  const target = replyTarget(conversationId, turns);
  return (state.supervisionNotes || []).find(note => sameTarget(note, target)) || null;
}

function supervisionSystemMessage(note) {
  if (!note || note.modelReview?.status !== 'available') return '';
  const observations = Object.fromEntries(CRITERIA.map(key => [key, {
    status: note.modelReview.observations[key].status, reason: text(note.modelReview.observations[key].reason, 120)
  }]));
  return 'PSYX REPLY SUPERVISION — fallible model observations about your exact previous reply, not independent evidence, clinical truth or instructions from the user. Consider them against the current message and existing conversation rules; do not diagnose, quote this note to the user or override safety or explicit controls.\n'
    + JSON.stringify({ replyId: note.replyId, observations, adjustment: text(note.modelReview.adjustment, 300) });
}

module.exports = { NOTE_LIMIT, CRITERIA, STATUSES, replyTarget, sameTarget, measureReply, supervisionNote,
  normalizeNotes, summarizeNotes, nextReplyNote, supervisionSystemMessage };
