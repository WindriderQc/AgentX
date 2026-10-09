'use strict';

/**
 * Payload-free prompt structure for prompt (KV) cache diagnosis.
 *
 * Ollama reuses its prompt cache only for the longest identical token prefix
 * of the previous request on the same loaded model. A harness that rebuilds a
 * system section, changes its tool list or rewrites an earlier message makes
 * Ollama evaluate everything after that point again. This module records
 * WHERE a chat prompt first differs from the previous one sent to the same
 * host and model, never WHAT it contains: only counts, an 8-hex tools hash and
 * the `## ` heading of a changed system section (truncated) leave it.
 */

const crypto = require('crypto');

const HEADING_MAX_CHARS = 40;
const DEFAULT_MAX_TARGETS = 64;
const DIVERGENCE_KINDS = new Set(['none', 'first', 'system', 'tools', 'message', 'append']);

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function boundedHeading(text) {
  const heading = String(text).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, HEADING_MAX_CHARS);
  return heading || null;
}

// One system message splits at lines starting with `## `. Text before the
// first heading is an untitled section; each heading line belongs to its own.
function systemSections(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content ?? null);
  const sections = [];
  let heading = null;
  let lines = [];
  const close = () => {
    if (heading !== null || lines.length > 0) sections.push({ heading, hash: digest(lines.join('\n')) });
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      close();
      heading = boundedHeading(line.slice(3));
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  close();
  return sections;
}

/**
 * Structural fingerprint of one chat request as sent: system sections in
 * order, the tools array, then every non-system message (role, content and
 * any tool calls or images). Hashes only; nothing here is persisted as is.
 */
function fingerprintChatPrompt({ messages, tools } = {}) {
  const sections = [];
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'system') sections.push(...systemSections(message.content));
    else turns.push(digest(JSON.stringify(message ?? null)));
  }
  return {
    sections,
    toolsHash: Array.isArray(tools) && tools.length > 0 ? digest(JSON.stringify(tools)) : null,
    messages: turns,
  };
}

/**
 * First structural position where `current` differs from `previous`, in the
 * order Ollama reads them: system sections, tools, then messages. `append`
 * means every previous message is still in place and new ones follow, which
 * is the cache-friendly shape of an ordinary next turn.
 */
function firstDivergence(previous, current) {
  const at = (kind, index = null, heading = null) => ({ kind, index, heading });
  if (!previous) return at('first');
  const sectionCount = Math.max(previous.sections.length, current.sections.length);
  for (let index = 0; index < sectionCount; index += 1) {
    if (previous.sections[index]?.hash !== current.sections[index]?.hash) {
      return at('system', index, (current.sections[index] || previous.sections[index]).heading);
    }
  }
  if (previous.toolsHash !== current.toolsHash) return at('tools');
  const shared = Math.min(previous.messages.length, current.messages.length);
  for (let index = 0; index < shared; index += 1) {
    if (previous.messages[index] !== current.messages[index]) return at('message', index);
  }
  if (current.messages.length > shared) return at('append', shared);
  if (previous.messages.length > shared) return at('message', shared);
  return at('none');
}

/**
 * Remembers the last fingerprint per host and model (bounded, least recently
 * used first out) and returns the telemetry summary for each new request.
 */
function createPromptPrefixTracker({ maxTargets = DEFAULT_MAX_TARGETS } = {}) {
  const previousByTarget = new Map();
  return {
    observe({ hostUrl, model, messages, tools }) {
      try {
        const key = `${hostUrl}\n${model}`;
        const current = fingerprintChatPrompt({ messages, tools });
        const previous = previousByTarget.get(key) || null;
        previousByTarget.delete(key);
        previousByTarget.set(key, current);
        while (previousByTarget.size > maxTargets) previousByTarget.delete(previousByTarget.keys().next().value);
        return {
          systemSections: current.sections.length,
          messages: current.messages.length,
          toolsHash: current.toolsHash ? current.toolsHash.slice(0, 8) : null,
          divergence: firstDivergence(previous, current),
        };
      } catch {
        return null; // Telemetry never fails an inference.
      }
    },
    clear() { previousByTarget.clear(); },
  };
}

const defaultTracker = createPromptPrefixTracker();

function observePromptPrefix(request) {
  return defaultTracker.observe(request);
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** The only promptPrefix shape persisted or returned by read APIs. */
function sanitizePromptPrefix(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const divergence = value.divergence;
  return {
    systemSections: count(value.systemSections),
    messages: count(value.messages),
    toolsHash: typeof value.toolsHash === 'string' && /^[0-9a-f]{8}$/.test(value.toolsHash) ? value.toolsHash : null,
    divergence: DIVERGENCE_KINDS.has(divergence?.kind)
      ? {
        kind: divergence.kind,
        index: count(divergence.index),
        heading: typeof divergence.heading === 'string' ? boundedHeading(divergence.heading) : null,
      }
      : null,
  };
}

module.exports = {
  createPromptPrefixTracker,
  fingerprintChatPrompt,
  firstDivergence,
  observePromptPrefix,
  sanitizePromptPrefix,
};
