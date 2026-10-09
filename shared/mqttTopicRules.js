'use strict';

/**
 * MQTT topic rules shared by Data (which owns the broker connection) and the
 * Core Toolbox relay (which checks a publish again before forwarding it).
 * Pure functions: no connection, no environment.
 */

const MAX_TOPIC_BYTES = 256;
const MAX_PAYLOAD_BYTES = 4096;
const PUBLISH_KEYS = Object.freeze(['topic', 'payload', 'retain']);

const byteLength = (text) => Buffer.byteLength(text, 'utf8');

function refuse(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

/** Why a topic cannot be published to, or '' when it can. */
function publishTopicProblem(topic) {
  if (typeof topic !== 'string' || !topic.length) return 'topic must be a non-empty string';
  if (byteLength(topic) > MAX_TOPIC_BYTES) return `topic must be at most ${MAX_TOPIC_BYTES} bytes`;
  if (topic.includes('\u0000')) return 'topic must not contain a NUL character';
  if (!topic.isWellFormed()) return 'topic must be valid Unicode text';
  if (/[#+]/.test(topic)) return 'topic must not contain the wildcards # or +';
  if (topic.startsWith('$')) return 'topic must not start with $ (reserved for the broker)';
  return '';
}

/** Why a payload cannot be published, or '' when it can. */
function publishPayloadProblem(payload) {
  if (typeof payload !== 'string') return 'payload must be a string (it may be empty)';
  if (byteLength(payload) > MAX_PAYLOAD_BYTES) return `payload must be at most ${MAX_PAYLOAD_BYTES} bytes`;
  return '';
}

/**
 * Validate a publish request body. Returns { topic, payload, retain } or
 * throws an Error with statusCode 400 and a message fit for the operator.
 */
function validatePublish(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw refuse('Expected a JSON object with topic, payload and an optional retain flag');
  }
  const unknown = Object.keys(body).filter((key) => !PUBLISH_KEYS.includes(key));
  if (unknown.length) throw refuse(`Unknown field: ${unknown.slice(0, 5).map((key) => key.slice(0, 40)).join(', ')}`);
  const problem = publishTopicProblem(body.topic) || publishPayloadProblem(body.payload);
  if (problem) throw refuse(problem);
  if (body.retain !== undefined && typeof body.retain !== 'boolean') throw refuse('retain must be true or false');
  return { topic: body.topic, payload: body.payload, retain: body.retain === true };
}

/** Why a subscription filter is not valid MQTT, or '' when it is. */
function topicFilterProblem(filter) {
  if (typeof filter !== 'string' || !filter.length) return 'topic filter must be a non-empty string';
  if (byteLength(filter) > MAX_TOPIC_BYTES) return `topic filter must be at most ${MAX_TOPIC_BYTES} bytes`;
  if (filter.includes('\u0000')) return 'topic filter must not contain a NUL character';
  const levels = filter.split('/');
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    if (level.includes('#') && (level !== '#' || index !== levels.length - 1)) {
      return 'in a topic filter, # must be alone in the last level';
    }
    if (level.includes('+') && level !== '+') return 'in a topic filter, + must fill a whole level';
  }
  return '';
}

/**
 * MQTT 3.1.1 §4.7 matching of a topic name against a valid filter: `+` is
 * exactly one level, `#` is the rest including the parent level itself
 * (`a/#` matches `a`), and a filter starting with a wildcard never matches a
 * topic starting with `$`.
 */
function topicMatches(filter, topic) {
  if (typeof filter !== 'string' || typeof topic !== 'string' || !topic.length) return false;
  const want = filter.split('/');
  const have = topic.split('/');
  if (topic.startsWith('$') && (want[0] === '#' || want[0] === '+')) return false;
  for (let index = 0; index < want.length; index++) {
    if (want[index] === '#') return index === want.length - 1;
    if (index >= have.length) return false;
    if (want[index] !== '+' && want[index] !== have[index]) return false;
  }
  return want.length === have.length;
}

module.exports = {
  MAX_TOPIC_BYTES,
  MAX_PAYLOAD_BYTES,
  PUBLISH_KEYS,
  publishTopicProblem,
  publishPayloadProblem,
  validatePublish,
  topicFilterProblem,
  topicMatches
};
