'use strict';

/**
 * Who cost a call its prompt cache (#364).
 *
 * Ollama reuses a model's prompt (KV) cache only for the longest prefix
 * identical to a request it processed before. With one cache slot (the
 * `qwen35` family), that is the request just before: any other call to the
 * same model in between makes the next agent turn read its whole prompt again.
 *
 * Every admitted call is observed at dispatch, in the order Ollama receives
 * them, against the last few requests sent to the same host and model:
 * - `reusableChars`: the longest prefix it shares with any of them, what the
 *   cache could have offered had nothing come between;
 * - `sharedChars`: the prefix it shares with the request just before, what the
 *   cache still holds.
 * The difference was lost to the calls dispatched in between, named by labels
 * only (admission kind, consumer contract, task type). Segment hashes stay in
 * this process's memory; rows get character counts and labels, never content.
 *
 * At record time the observation becomes a verdict with Ollama's timings:
 * `reload` when `loadMs` shows the model was loaded again (its cache with it),
 * `interleaved`, `warm`, `cold` (nothing earlier to reuse) or `untracked`
 * (Core has seen no earlier request to this host and model since it started).
 */

const crypto = require('crypto');

const DEFAULT_MAX_TARGETS = 64;
const DEFAULT_HISTORY = 8;
const MAX_INTERLEAVERS = 3;
// A resident model answers with a load_duration of tens of milliseconds;
// loading one again takes seconds.
const RELOAD_LOAD_MS = 1000;
const VERDICTS = Object.freeze(['warm', 'interleaved', 'reload', 'cold', 'untracked']);
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function segment(text) {
  return { hash: digest(text), chars: text.length };
}

function textOf(value) {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

// A system prompt is read in sections split at `## ` lines, so a section that
// changes keeps the ones before it reusable.
function sectionSegments(text) {
  const segments = [];
  let lines = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('## ') && lines.length > 0) {
      segments.push(segment(lines.join('\n')));
      lines = [];
    }
    lines.push(line);
  }
  if (lines.length > 0) segments.push(segment(lines.join('\n')));
  return segments;
}

/**
 * The prompt as Ollama reads it, in hashed segments: the leading system
 * message, the tools, then each message (chat); or the system text, then the
 * prompt's paragraphs (generate). Null for anything else (embeddings), empty
 * for an empty prompt.
 */
function promptSegments(payload) {
  if (Array.isArray(payload?.messages)) {
    const messages = payload.messages;
    const leadingSystem = messages[0]?.role === 'system';
    const segments = leadingSystem ? sectionSegments(textOf(messages[0].content)) : [];
    if (Array.isArray(payload.tools) && payload.tools.length > 0) segments.push(segment(JSON.stringify(payload.tools)));
    for (const message of messages.slice(leadingSystem ? 1 : 0)) segments.push(segment(JSON.stringify(message ?? null)));
    return segments;
  }
  if (typeof payload?.prompt === 'string') {
    const segments = typeof payload.system === 'string' && payload.system ? sectionSegments(payload.system) : [];
    for (const paragraph of payload.prompt.split(/(?<=\n\n)/)) if (paragraph) segments.push(segment(paragraph));
    return segments;
  }
  return null;
}

function sharedPrefixChars(previous, current) {
  let chars = 0;
  const length = Math.min(previous.length, current.length);
  for (let index = 0; index < length && previous[index].hash === current[index].hash; index += 1) {
    chars += current[index].chars;
  }
  return chars;
}

function label(value) {
  return typeof value === 'string' && LABEL_PATTERN.test(value) ? value : null;
}

function callerLabels({ kind, consumerContract, taskType } = {}) {
  return { kind: label(kind) || 'other', consumerContract: label(consumerContract), taskType: label(taskType) };
}

const sameLabels = (a, b) => a.kind === b.kind && a.consumerContract === b.consumerContract && a.taskType === b.taskType;

/**
 * Remembers the last requests per host and model (bounded, least recently
 * used target first out) and returns each new request's observation.
 */
function createPromptCacheTracker({ maxTargets = DEFAULT_MAX_TARGETS, history = DEFAULT_HISTORY, now = Date.now } = {}) {
  const recentByTarget = new Map();
  return {
    observe({ hostUrl, model, payload, labels }) {
      try {
        const segments = promptSegments(payload);
        // An empty prompt (a bare load) leaves the cache as it is.
        if (!segments?.length || !hostUrl || !model) return null;
        const key = `${hostUrl}\n${model}`;
        const recent = recentByTarget.get(key) || [];
        const at = now();
        const caller = callerLabels(labels);
        const chars = segments.reduce((sum, item) => sum + item.chars, 0);
        let observation = { tracked: false, chars, sharedChars: 0, reusableChars: 0 };
        if (recent.length > 0) {
          const previous = recent[recent.length - 1];
          const sharedChars = sharedPrefixChars(previous.segments, segments);
          let best = recent.length - 1;
          let reusableChars = sharedChars;
          for (let index = recent.length - 2; index >= 0; index -= 1) {
            const shared = sharedPrefixChars(recent[index].segments, segments);
            if (shared > reusableChars) { reusableChars = shared; best = index; }
          }
          const between = recent.slice(best + 1);
          const interleavedBy = [];
          for (const entry of [...between].reverse()) {
            if (interleavedBy.length < MAX_INTERLEAVERS && !interleavedBy.some(item => sameLabels(item, entry.caller))) {
              interleavedBy.push(entry.caller);
            }
          }
          observation = {
            tracked: true,
            chars,
            sharedChars,
            reusableChars,
            sincePreviousMs: Math.max(0, at - previous.at),
            interleaved: between.length,
            interleavedBy,
          };
        }
        recent.push({ at, caller, segments });
        while (recent.length > history) recent.shift();
        recentByTarget.delete(key);
        recentByTarget.set(key, recent);
        while (recentByTarget.size > maxTargets) recentByTarget.delete(recentByTarget.keys().next().value);
        return observation;
      } catch {
        return null; // Telemetry never fails an inference.
      }
    },
    clear() { recentByTarget.clear(); },
  };
}

const defaultTracker = createPromptCacheTracker();

function observePromptCache(request) {
  return defaultTracker.observe(request);
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ms(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The row's `promptCache`: the dispatch observation with its verdict, the
 * characters of reusable prefix lost and the prefill time they cost. That time
 * is `promptEvalMs` prorated over the characters Ollama evaluated, so it never
 * exceeds the call's own prefill.
 */
function promptCacheVerdict(observation, { loadMs, promptEvalMs } = {}) {
  if (!observation || typeof observation !== 'object') return null;
  const chars = count(observation.chars) ?? 0;
  const shared = Math.min(count(observation.sharedChars) ?? 0, chars);
  const reusable = Math.max(Math.min(count(observation.reusableChars) ?? 0, chars), shared);
  let verdict = 'warm';
  let lostChars = 0;
  if (observation.tracked !== true) verdict = 'untracked';
  else if (reusable === 0) verdict = 'cold';
  else if (ms(loadMs) != null && loadMs >= RELOAD_LOAD_MS) { verdict = 'reload'; lostChars = reusable; }
  else if (reusable > shared) { verdict = 'interleaved'; lostChars = reusable - shared; }
  const evaluated = chars - (verdict === 'reload' ? 0 : shared);
  const prefill = ms(promptEvalMs);
  return {
    verdict,
    chars,
    sharedChars: shared,
    reusableChars: reusable,
    lostChars: verdict === 'untracked' ? null : lostChars,
    lostPrefillMs: verdict === 'untracked' || prefill == null ? null
      : Math.round(lostChars === 0 ? 0 : prefill * Math.min(1, lostChars / Math.max(1, evaluated))),
    sincePreviousMs: ms(observation.sincePreviousMs),
    interleaved: count(observation.interleaved),
    interleavedBy: Array.isArray(observation.interleavedBy)
      ? observation.interleavedBy.slice(0, MAX_INTERLEAVERS).map(callerLabels) : [],
  };
}

/** The only promptCache shape persisted or returned by read APIs. */
function sanitizePromptCache(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !VERDICTS.includes(value.verdict)) return null;
  return {
    verdict: value.verdict,
    chars: count(value.chars),
    sharedChars: count(value.sharedChars),
    reusableChars: count(value.reusableChars),
    lostChars: count(value.lostChars),
    lostPrefillMs: count(value.lostPrefillMs),
    sincePreviousMs: ms(value.sincePreviousMs),
    interleaved: count(value.interleaved),
    interleavedBy: Array.isArray(value.interleavedBy)
      ? value.interleavedBy.slice(0, MAX_INTERLEAVERS).map(callerLabels) : [],
  };
}

module.exports = {
  RELOAD_LOAD_MS,
  VERDICTS,
  createPromptCacheTracker,
  observePromptCache,
  promptCacheVerdict,
  promptSegments,
  sanitizePromptCache,
};
