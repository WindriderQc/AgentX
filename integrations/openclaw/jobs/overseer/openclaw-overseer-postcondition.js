#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

function defaultSessionsRoot(environment = process.env) {
  const home = environment.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
  return path.join(home, 'agents', 'overseer', 'sessions');
}

const DEFAULT_SESSIONS_ROOT = defaultSessionsRoot();
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const REQUIRED_HEADINGS = Object.freeze([
  '## Stale claims',
  '## Conflicts and duplication',
  '## Architecture drift',
  '## Automation health',
  '## Recommended next actions',
]);
const REQUIRED_TOOLS = Object.freeze([
  'read',
  'agentx__ecosystem_snapshot',
]);

class OverseerPostconditionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OverseerPostconditionError';
    this.code = code;
  }
}

function fail(code) {
  throw new OverseerPostconditionError(code);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
    && !path.isAbsolute(relative);
}

function guardedTranscriptPath(transcriptPath, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    fail('transcript-required');
  }
  if (typeof sessionsRoot !== 'string' || sessionsRoot.length === 0) {
    fail('sessions-root-invalid');
  }

  const root = path.resolve(sessionsRoot);
  const candidate = path.resolve(transcriptPath);
  if (!isInside(root, candidate)) fail('transcript-outside-sessions-root');
  if (!TRANSCRIPT_NAME.test(path.basename(candidate))) fail('transcript-name-invalid');

  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    fail('sessions-root-unavailable');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('sessions-root-invalid');
  }

  const relativeParts = path.relative(root, candidate).split(path.sep);
  let current = root;
  let candidateStat;
  try {
    for (const part of relativeParts) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) fail('transcript-symlink-rejected');
      candidateStat = stat;
    }
  } catch (error) {
    if (error instanceof OverseerPostconditionError) throw error;
    fail('transcript-unavailable');
  }
  if (!candidateStat?.isFile()) fail('transcript-not-regular-file');
  if (candidateStat.size <= 0) fail('transcript-empty');
  if (candidateStat.size > MAX_TRANSCRIPT_BYTES) fail('transcript-oversize');

  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (!isInside(realRoot, realCandidate)) fail('transcript-outside-sessions-root');
  } catch (error) {
    if (error instanceof OverseerPostconditionError) throw error;
    fail('transcript-unavailable');
  }
  return candidate;
}

function parseTranscriptText(text) {
  if (typeof text !== 'string' || text.length === 0) fail('transcript-empty');
  if (Buffer.byteLength(text, 'utf8') > MAX_TRANSCRIPT_BYTES) fail('transcript-oversize');

  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!normalized || normalized.split('\n').some((line) => line.trim() === '')) {
    fail('transcript-jsonl-invalid');
  }
  return normalized.split('\n').map((line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail('transcript-jsonl-invalid');
    }
    if (!isPlainObject(row)) fail('transcript-row-invalid');
    if (row.type === 'message' && !isPlainObject(row.message)) {
      fail('transcript-message-invalid');
    }
    return row;
  });
}

function textBlocks(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseSnapshotHeader(text) {
  // OpenClaw may prepend a sorted structured-content projection; the source
  // snapshot is also returned as its own text block, sometimes bounded mid-JSON.
  const prefix = text.replace(/^structuredContent:\s*/, '').slice(0, 4096);
  const match = prefix.match(
    /^\{\s*"mode"\s*:\s*"full"\s*,\s*"schemaVersion"\s*:\s*5\s*,\s*"generatedAt"\s*:\s*"([^"]+)"\s*,\s*"readOnly"\s*:\s*true\s*,\s*"authority"\s*:\s*"aio-ops-runtime-bridges"\s*,\s*"status"\s*:\s*"(ok|degraded)"\s*,/,
  );
  if (!match
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(match[1])
    || Number.isNaN(Date.parse(match[1]))) return null;
  const remainder = prefix.slice(match[0].length);
  const full = /^\s*"lead"\s*:/.test(remainder);
  const bounded = /^\s*"truncated"\s*:\s*true\s*,\s*"maxChars"\s*:\s*60000\s*,/.test(remainder);
  if (!full && !bounded) return null;
  return `schema-5/status-${match[2]}`;
}

function reportHasRequiredHeadings(text) {
  let previousIndex = -1;
  for (const heading of REQUIRED_HEADINGS) {
    const expression = new RegExp(`(?:^|\\n)${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n|$)`, 'g');
    const matches = [...text.matchAll(expression)];
    if (matches.length !== 1 || matches[0].index <= previousIndex) return false;
    previousIndex = matches[0].index;
  }
  return true;
}

function verifyTranscriptText(text) {
  const rows = parseTranscriptText(text);
  const calls = [];
  const results = [];
  const finalCandidates = [];

  rows.forEach((row, rowIndex) => {
    if (row.type !== 'message') return;
    const message = row.message;
    if (typeof message.role !== 'string') fail('transcript-message-invalid');

    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) fail('assistant-content-invalid');
      const rowCalls = message.content.filter(
        (block) => isPlainObject(block) && block.type === 'toolCall',
      );
      for (const block of rowCalls) {
        if (typeof block.id !== 'string' || typeof block.name !== 'string') {
          fail('tool-call-invalid');
        }
        calls.push({
          arguments: block.arguments,
          id: block.id,
          name: block.name,
          rowIndex,
        });
      }
      if (rowCalls.length === 0) {
        const textContent = textBlocks(message.content);
        if (textContent) finalCandidates.push({ content: message.content, rowIndex, text: textContent });
      }
    } else if (message.role === 'toolResult') {
      if (!Array.isArray(message.content)
        || typeof message.toolCallId !== 'string'
        || typeof message.toolName !== 'string'
        || typeof message.isError !== 'boolean') {
        fail('tool-result-invalid');
      }
      results.push({
        content: message.content,
        id: message.toolCallId,
        isError: message.isError,
        name: message.toolName,
        rowIndex,
      });
    }
  });

  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    fail('tool-call-id-duplicate');
  }
  if (calls.some((call) => !REQUIRED_TOOLS.includes(call.name))) {
    fail('forbidden-tool-call');
  }
  if (calls.length < REQUIRED_TOOLS.length) fail('required-tool-count-invalid');

  const readCalls = calls.filter((call) => call.name === 'read');
  const snapshotCalls = calls.filter((call) => call.name === 'agentx__ecosystem_snapshot');
  if (readCalls.length === 0) fail('bootstrap-read-count-invalid');
  if (snapshotCalls.length === 0) fail('snapshot-call-count-invalid');

  if (results.length !== calls.length) fail('tool-result-count-invalid');
  const matched = new Map();
  for (const result of results) {
    if (matched.has(result.id)) fail('tool-result-duplicate');
    const call = calls.find((candidate) => candidate.id === result.id);
    if (!call || call.name !== result.name) fail('tool-result-mismatch');
    if (result.rowIndex <= call.rowIndex) fail('tool-result-failed');
    matched.set(result.id, result);
  }
  if (matched.size !== calls.length) fail('tool-result-missing');

  // Read-only retries do not invalidate evidence already returned successfully.
  const succeeded = (call) => matched.get(call.id)?.isError === false;
  const readCall = readCalls.find(succeeded);
  const snapshotCall = snapshotCalls.find(succeeded);
  if (!readCall || !snapshotCall) fail('tool-result-failed');
  if (readCall.rowIndex > snapshotCall.rowIndex) fail('required-tool-order-invalid');

  if (!exactKeys(readCall.arguments, ['path'])
    || typeof readCall.arguments.path !== 'string'
    || path.basename(readCall.arguments.path) !== 'BOOTSTRAP.md') {
    fail('bootstrap-read-arguments-invalid');
  }
  if (!exactKeys(snapshotCall.arguments, ['maxChars', 'mode'])
    || snapshotCall.arguments.mode !== 'full'
    || snapshotCall.arguments.maxChars !== 60000) {
    fail('snapshot-arguments-invalid');
  }

  const readResult = matched.get(readCall.id);
  const snapshotResult = matched.get(snapshotCall.id);
  if (readCall.rowIndex !== snapshotCall.rowIndex
    && readResult.rowIndex >= snapshotCall.rowIndex) {
    fail('required-tool-order-invalid');
  }
  const snapshotHeader = snapshotResult.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => parseSnapshotHeader(block.text))
    .find(Boolean);
  if (!snapshotHeader) fail('snapshot-header-invalid');

  const finalResponse = finalCandidates.at(-1);
  if (!finalResponse || finalResponse.rowIndex <= Math.max(...results.map((result) => result.rowIndex))) {
    fail('final-report-missing');
  }
  const finalTextBlocks = finalResponse.content.filter(
    (block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string',
  );
  if (finalTextBlocks.length !== 1
    || finalResponse.content.some((block) => !isPlainObject(block)
      || (block.type !== 'text' && block.type !== 'thinking')
      || (block.type === 'thinking' && typeof block.thinking !== 'string'))) {
    fail('final-report-content-invalid');
  }
  if (!reportHasRequiredHeadings(finalResponse.text)) fail('final-report-headings-invalid');

  return Object.freeze({
    finalText: finalResponse.text,
    finalTextSha256: sha256Text(finalResponse.text),
    headings: REQUIRED_HEADINGS.length,
    snapshotHeader,
    toolCalls: calls.length,
    ...(results.some((result) => result.isError) && {
      failedToolCalls: results.filter((result) => result.isError).length,
    }),
  });
}

function readTranscript(transcriptPath, sessionsRoot = DEFAULT_SESSIONS_ROOT) {
  const guardedPath = guardedTranscriptPath(transcriptPath, sessionsRoot);
  let bytes;
  try {
    bytes = fs.readFileSync(guardedPath);
  } catch {
    fail('transcript-unavailable');
  }
  if (bytes.length <= 0) fail('transcript-empty');
  if (bytes.length > MAX_TRANSCRIPT_BYTES) fail('transcript-oversize');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('transcript-utf8-invalid');
  }
}

function verifyTranscriptFile(transcriptPath, options = {}) {
  const sessionsRoot = options.sessionsRoot || DEFAULT_SESSIONS_ROOT;
  return verifyTranscriptText(readTranscript(transcriptPath, sessionsRoot));
}

function parseArgs(argv = process.argv.slice(2), environment = process.env) {
  let transcript;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--transcript') fail('argument-invalid');
    index += 1;
    if (index >= argv.length || transcript !== undefined) fail('argument-invalid');
    transcript = argv[index];
  }
  if (!transcript) fail('transcript-required');
  return {
    sessionsRoot: environment.OPENCLAW_OVERSEER_SESSIONS_ROOT || defaultSessionsRoot(environment),
    transcript,
  };
}

function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, dependencies.environment || process.env);
  const result = verifyTranscriptFile(options.transcript, {
    sessionsRoot: options.sessionsRoot,
  });
  const write = dependencies.write || ((line) => console.log(line));
  write(
    `OVERSEER_POSTCONDITION_OK tools=${result.toolCalls} `
      + `snapshot_header=${result.snapshotHeader} headings=${result.headings}`,
  );
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    const code = error instanceof OverseerPostconditionError ? error.code : 'internal-error';
    console.error(`OVERSEER_POSTCONDITION_FAILED code=${code}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_SESSIONS_ROOT,
  MAX_TRANSCRIPT_BYTES,
  OverseerPostconditionError,
  REQUIRED_HEADINGS,
  defaultSessionsRoot,
  guardedTranscriptPath,
  parseArgs,
  parseSnapshotHeader,
  parseTranscriptText,
  reportHasRequiredHeadings,
  runCli,
  sha256Text,
  verifyTranscriptFile,
  verifyTranscriptText,
};
