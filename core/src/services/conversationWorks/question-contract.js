'use strict';
const { hash, fail } = require('./contract');
const CAPABILITY = 'question-conditional-resolve-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text = (value, max = 4096) => typeof value === 'string' && value.length > 0 && value.length <= max;
const invalid = () => fail('CONVERSATION_QUESTION_INVALID', 'Select the current question and submit its answer explicitly.');
const unavailable = () => fail('CONVERSATION_QUESTIONS_UNAVAILABLE', 'Native questions are unavailable. No answer was sent.', 503);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));

// Deliberately small ordinary form contract. Resource, secret and unknown input
// types stay with their native UI rather than being silently reinterpreted.
function ordinary(record, attempt) {
  if (!record || record.status !== 'pending' || record.agentId !== attempt.agentId
      || record.sessionKey !== attempt.sessionKey || record.runId !== attempt.runId
      || !text(record.id, 200) || !text(record.incarnation, 128)
      || !Number.isSafeInteger(record.createdAtMs) || !Number.isSafeInteger(record.expiresAtMs)
      || !Array.isArray(record.questions) || !record.questions.length || record.questions.length > 3) return null;
  const questions = [];
  for (const q of record.questions) {
    if (!exactKeys(q, ['questionId', 'header', 'question', 'options', 'multiSelect', 'isOther', 'isSecret'])
        || q.isSecret || !/^[a-z][a-z0-9_]{0,63}$/.test(q.questionId || '')
        || !text(q.question, 4000) || typeof q.header !== 'string' || q.header.length > 12
        || !Array.isArray(q.options) || q.options.length > 16
        || q.options.some(o => !exactKeys(o, ['label', 'description', 'value']) || !text(o.label)
          || o.value !== undefined && !text(o.value) || o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 4000))
        || q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean'
        || q.isOther !== undefined && typeof q.isOther !== 'boolean') return null;
    questions.push({ questionId: q.questionId, header: q.header, question: q.question,
      options: q.options.map(o => ({ label: o.label, ...(o.value !== undefined && { value: o.value }),
        ...(o.description !== undefined && { description: o.description }) })), multiSelect: q.multiSelect === true, isOther: q.isOther === true });
  }
  if (new Set(questions.map(q => q.questionId)).size !== questions.length) return null;
  return { id: record.id, incarnation: record.incarnation, agentId: record.agentId,
    sessionKey: record.sessionKey, runId: record.runId, createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs, questions };
}
function basisFor(row, question) {
  const questionSha256 = hash(JSON.stringify([row._id, row.requestSha256, row.attempt.id,
    row.attempt.sessionKey, row.attempt.runId, question]));
  return { version: 1, workId: row._id, requestSha256: row.requestSha256, attemptId: row.attempt.id,
    questionId: question.id, incarnation: question.incarnation, questionSha256 };
}
function answersFor(questions, input) {
  if (!exactKeys(input, ['answers']) || !input.answers || Array.isArray(input.answers)
      || typeof input.answers !== 'object' || Object.keys(input.answers).length !== questions.length) throw invalid();
  const answers = {};
  for (const q of questions) {
    const values = Object.hasOwn(input.answers, q.questionId) && input.answers[q.questionId];
    if (!Array.isArray(values) || !values.length || values.length > (q.multiSelect ? 16 : 1)
        || new Set(values).size !== values.length || values.some(v => !text(v)
          || q.options.length && !q.isOther && !q.options.some(o => (o.value ?? o.label) === v))) throw invalid();
    Object.defineProperty(answers, q.questionId, { value: [...values], enumerable: true });
  }
  return { answers };
}
const bindingMatches = (row, observation) => row?.mode === 'native' && !row.erased && row.requestSha256 === observation?.requestSha256
  && row.attempt?.id === observation?.attemptId && row.attempt?.sessionKey === observation?.sessionKey
  && row.attempt?.runId === observation?.runId;
module.exports = { CAPABILITY, uuid, exactKeys, ordinary, basisFor, answersFor, bindingMatches, invalid, unavailable };
