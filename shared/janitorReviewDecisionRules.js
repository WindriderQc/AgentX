'use strict';

/**
 * Rules for a stored duplicate-review decision, shared by Data (which stores
 * it) and the Core Toolbox relay (which checks the body again before
 * forwarding it). Pure functions: no database, no environment.
 *
 * A decision records what the owner INTENDS for one duplicate group. Nothing
 * in these rules, and nothing that stores a decision, approves, previews or
 * runs a file deletion.
 */

const DECISIONS = Object.freeze(['keep_all', 'dedupe', 'defer']);
const SOURCES = Object.freeze(['toolbox', 'browser-draft-import']);
const BATCH_MODES = Object.freeze(['upsert', 'insert_missing']);
const LIST_STATES = Object.freeze(['current', 'stale']);
// The two roots Data's shared-drive strategy reads. Data keeps its own
// constant (janitorStrategyPolicy.SHARED_ROOTS); a test compares the two.
const SHARED_DRIVE_ROOTS = Object.freeze(['/mnt/media', '/mnt/datalake']);
const LIMITS = Object.freeze({
  paths: 500,
  pathBytes: 1024,
  noteLength: 500,
  batch: 200,
  listLimit: 200,
  listOffset: 100000,
  shaFilter: 100
});
const DECISION_KEYS = Object.freeze(['sha256', 'decision', 'survivorPath', 'note', 'evidence', 'source']);
const EVIDENCE_KEYS = Object.freeze(['size', 'paths', 'reportId', 'reportGeneratedAt']);
const BATCH_KEYS = Object.freeze(['mode', 'decisions']);
const LIST_KEYS = Object.freeze(['decision', 'state', 'pathPrefix', 'sha256', 'limit', 'offset']);

const SHA256 = /^[0-9a-f]{64}$/;
const REPORT_ID = /^[0-9a-f]{24}$/;

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);
// A key the caller sent, shortened and quoted so a hostile name stays inert in a message.
const shown = (key) => JSON.stringify(String(key).slice(0, 40));

function unknownKeys(input, allowed, label) {
  return Object.keys(input).filter((key) => !allowed.includes(key)).slice(0, 5)
    .map((key) => `unknown ${label} field ${shown(key)}`);
}

/** Why a path cannot be part of a decision, or '' when it can. */
function pathProblem(value, roots = SHARED_DRIVE_ROOTS) {
  if (typeof value !== 'string' || !value.length) return 'must be a non-empty string';
  if (Buffer.byteLength(value, 'utf8') > LIMITS.pathBytes) return `must be at most ${LIMITS.pathBytes} bytes`;
  if (value.includes('\u0000')) return 'must not contain a NUL character';
  if (!value.isWellFormed()) return 'must be valid Unicode text';
  if (!value.startsWith('/')) return 'must be an absolute path';
  const segments = value.split('/').slice(1);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'must be normalized: no empty, "." or ".." segment and no trailing slash';
  }
  if (!roots.some((root) => value.startsWith(`${root}/`))) return `must be under one of ${roots.join(', ')}`;
  return '';
}

/** Why a path prefix cannot filter a list, or '' when it can: a root, or a path under one. */
function pathPrefixProblem(value, roots = SHARED_DRIVE_ROOTS) {
  if (typeof value !== 'string' || !value.length) return 'must be a non-empty string';
  const trimmed = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (roots.includes(trimmed)) return '';
  return pathProblem(trimmed, roots);
}

/**
 * Check one decision. Returns `{ errors, value }`: `errors` is empty when the
 * decision is valid, and `value` is then the normalized decision (paths sorted,
 * note trimmed, absent optional fields as null).
 *
 * `sha256` in options is the identity taken from the URL: a body naming
 * another one is refused.
 */
function checkDecision(input, { roots = SHARED_DRIVE_ROOTS, sha256: expectedSha } = {}) {
  if (!isPlainObject(input)) return { errors: ['decision must be a JSON object'], value: null };
  const errors = unknownKeys(input, DECISION_KEYS, 'decision');

  const sha256 = input.sha256 === undefined ? expectedSha : input.sha256;
  if (!isSha256(sha256)) errors.push('sha256 must be 64 lowercase hexadecimal characters');
  else if (expectedSha !== undefined && sha256 !== expectedSha) errors.push('sha256 in the body must match the one in the address');

  if (!DECISIONS.includes(input.decision)) errors.push(`decision must be one of ${DECISIONS.join(', ')}`);

  let note = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string' || !input.note.isWellFormed() || input.note.includes('\u0000')) errors.push('note must be text');
    else if (input.note.trim().length > LIMITS.noteLength) errors.push(`note must be at most ${LIMITS.noteLength} characters`);
    else note = input.note.trim() || null;
  }

  let source = 'toolbox';
  if (input.source !== undefined) {
    if (!SOURCES.includes(input.source)) errors.push(`source must be one of ${SOURCES.join(', ')}`);
    else source = input.source;
  }

  const evidence = { size: null, paths: [], reportId: null, reportGeneratedAt: null };
  if (!isPlainObject(input.evidence)) {
    errors.push('evidence must be a JSON object with size and paths');
  } else {
    errors.push(...unknownKeys(input.evidence, EVIDENCE_KEYS, 'evidence'));
    if (!Number.isSafeInteger(input.evidence.size) || input.evidence.size < 1) {
      errors.push(`evidence.size must be a whole number of bytes from 1 to ${Number.MAX_SAFE_INTEGER}`);
    } else evidence.size = input.evidence.size;

    const paths = input.evidence.paths;
    if (!Array.isArray(paths) || paths.length < 2 || paths.length > LIMITS.paths) {
      errors.push(`evidence.paths must list from 2 to ${LIMITS.paths} paths`);
    } else {
      const problems = [];
      paths.forEach((value, index) => {
        const problem = pathProblem(value, roots);
        if (problem && problems.length < 3) problems.push(`evidence.paths[${index}] ${problem}`);
      });
      if (problems.length) errors.push(...problems);
      else if (new Set(paths).size !== paths.length) errors.push('evidence.paths must not repeat a path');
      else evidence.paths = [...paths].sort();
    }

    if (input.evidence.reportId !== undefined && input.evidence.reportId !== null) {
      if (typeof input.evidence.reportId !== 'string' || !REPORT_ID.test(input.evidence.reportId)) errors.push('evidence.reportId must be a 24-character report id');
      else evidence.reportId = input.evidence.reportId;
    }
    if (input.evidence.reportGeneratedAt !== undefined && input.evidence.reportGeneratedAt !== null) {
      const text = input.evidence.reportGeneratedAt;
      if (typeof text !== 'string' || text.length > 40 || Number.isNaN(new Date(text).getTime())) errors.push('evidence.reportGeneratedAt must be a date');
      else evidence.reportGeneratedAt = new Date(text).toISOString();
    }
  }

  let survivorPath = null;
  const given = input.survivorPath;
  if (input.decision === 'dedupe') {
    if (typeof given !== 'string' || !given) errors.push('survivorPath is required when decision is dedupe');
    else if (!evidence.paths.includes(given)) errors.push('survivorPath must be one of evidence.paths');
    else survivorPath = given;
  } else if (given !== undefined && given !== null) {
    errors.push('survivorPath is only accepted when decision is dedupe');
  }

  if (errors.length) return { errors, value: null };
  return { errors, value: { sha256, decision: input.decision, survivorPath, note, source, evidence } };
}

/**
 * Check a batch: `{ decisions: [...], mode }`. Every decision must be valid
 * and name a different group, otherwise nothing in the batch is accepted.
 */
function checkBatch(input, { roots = SHARED_DRIVE_ROOTS } = {}) {
  if (!isPlainObject(input)) return { errors: ['expected a JSON object with decisions'], value: null };
  const errors = unknownKeys(input, BATCH_KEYS, 'batch');
  const mode = input.mode === undefined ? 'upsert' : input.mode;
  if (!BATCH_MODES.includes(mode)) errors.push(`mode must be one of ${BATCH_MODES.join(', ')}`);
  if (!Array.isArray(input.decisions) || !input.decisions.length || input.decisions.length > LIMITS.batch) {
    errors.push(`decisions must list from 1 to ${LIMITS.batch} decisions`);
    return { errors, value: null };
  }
  const decisions = [];
  const seen = new Set();
  let reported = 0;
  input.decisions.forEach((entry, index) => {
    const checked = checkDecision(entry, { roots });
    if (checked.errors.length) {
      // Bound the answer: the first problems are enough to fix the batch.
      if (reported < 10) errors.push(...checked.errors.slice(0, 3).map((message) => `decisions[${index}]: ${message}`));
      reported += 1;
      return;
    }
    if (seen.has(checked.value.sha256)) errors.push(`decisions[${index}]: sha256 appears more than once in the batch`);
    seen.add(checked.value.sha256);
    decisions.push(checked.value);
  });
  if (reported > 10) errors.push(`${reported - 10} more invalid decisions`);
  if (errors.length) return { errors, value: null };
  return { errors, value: { mode, decisions } };
}

function boundedInt(raw, fallback, min, max, name, errors) {
  if (raw === undefined || raw === '') return fallback;
  const text = String(Array.isArray(raw) ? raw[0] : raw);
  if (!/^\d{1,9}$/.test(text) || Number(text) < min || Number(text) > max) {
    errors.push(`${name} must be a whole number from ${min} to ${max}`);
    return fallback;
  }
  return Number(text);
}

/** Check the list filters. Returns `{ errors, value }` like the other checks. */
function checkListQuery(query = {}, { roots = SHARED_DRIVE_ROOTS } = {}) {
  const errors = unknownKeys(query, LIST_KEYS, 'query');
  const value = { decision: null, state: null, pathPrefix: null, sha256: null, limit: 50, offset: 0 };
  const one = (name) => (Array.isArray(query[name]) ? query[name][0] : query[name]);
  const present = (name) => one(name) !== undefined && one(name) !== '';

  if (present('decision')) {
    if (!DECISIONS.includes(one('decision'))) errors.push(`decision must be one of ${DECISIONS.join(', ')}`);
    else value.decision = one('decision');
  }
  if (present('state')) {
    if (!LIST_STATES.includes(one('state'))) errors.push(`state must be one of ${LIST_STATES.join(', ')}`);
    else value.state = one('state');
  }
  if (present('pathPrefix')) {
    const problem = pathPrefixProblem(one('pathPrefix'), roots);
    if (problem) errors.push(`pathPrefix ${problem}`);
    else value.pathPrefix = one('pathPrefix').length > 1 && one('pathPrefix').endsWith('/') ? one('pathPrefix').slice(0, -1) : one('pathPrefix');
  }
  if (present('sha256')) {
    const list = String(one('sha256')).split(',');
    if (list.length > LIMITS.shaFilter || !list.every(isSha256)) errors.push(`sha256 must be at most ${LIMITS.shaFilter} comma-separated SHA-256 values`);
    else value.sha256 = [...new Set(list)];
  }
  value.limit = boundedInt(query.limit, 50, 1, LIMITS.listLimit, 'limit', errors);
  value.offset = boundedInt(query.offset, 0, 0, LIMITS.listOffset, 'offset', errors);
  return errors.length ? { errors, value: null } : { errors, value };
}

module.exports = {
  DECISIONS,
  SOURCES,
  BATCH_MODES,
  LIST_STATES,
  SHARED_DRIVE_ROOTS,
  LIMITS,
  DECISION_KEYS,
  EVIDENCE_KEYS,
  isSha256,
  pathProblem,
  pathPrefixProblem,
  checkDecision,
  checkBatch,
  checkListQuery
};
