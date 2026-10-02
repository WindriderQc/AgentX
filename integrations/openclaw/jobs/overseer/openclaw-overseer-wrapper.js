#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');

const {
  sha256Text,
  verifyTranscriptText,
} = require('./openclaw-overseer-postcondition');

const OPENCLAW_CLI = 'openclaw';
const OVERSEER_AGENT_ID = 'overseer';
const REQUIRED_TOOLS = Object.freeze(['read', 'agentx__ecosystem_snapshot']);
const REQUIRED_MCP_TOOLS = Object.freeze([
  'agentx__add_email_action',
  'agentx__add_personal_task',
  'agentx__check_health',
  'agentx__complete_personal_task',
  'agentx__create_todo',
  'agentx__ecosystem_snapshot',
  'agentx__get_escalation_recommendation',
  'agentx__get_sound',
  'agentx__list_personal_tasks',
  'agentx__rag_search',
]);
const MCP_PENDING_NOTICE_IDS = Object.freeze([
  'mcp-not-yet-connected',
  'mcp-not-yet-listed',
  'mcp-stale-catalog',
]);
const ALLOWED_THINKING = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
  'ultra',
]);
const AGENT_TIMEOUT_SECONDS = 600;
const GATEWAY_TIMEOUT_MS = 630000;
const PROCESS_OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const MESSAGE_MAX_BYTES = 16 * 1024;
const REPLY_MAX_BYTES = 64 * 1024;

class OverseerWrapperError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OverseerWrapperError';
    this.code = code;
  }
}

function fail(code) {
  throw new OverseerWrapperError(code);
}

function decodeUtf8(bytes, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(code);
  }
}

function readBoundedStdin(read = fs.readSync) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(4096);
    let count;
    try {
      count = read(0, chunk, 0, chunk.length, null);
    } catch {
      fail('input-read-failed');
    }
    if (count === 0) break;
    total += count;
    if (total > MESSAGE_MAX_BYTES) fail('input-oversize');
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks, total);
}

function validateMessage(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? '');
  if (bytes.length === 0) fail('input-empty');
  if (bytes.length > MESSAGE_MAX_BYTES) fail('input-oversize');
  const message = decodeUtf8(bytes, 'input-utf8-invalid');
  if (!message.trim()) fail('input-empty');
  if (message.includes('\0')) fail('input-invalid');
  return message;
}

function exactStringSet(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && new Set(value).size === expected.length
    && expected.every((entry) => value.includes(entry));
}

function parseAgentList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('agent-config-json-invalid');
  }
  const value = parsed?.value ?? parsed;
  const list = Array.isArray(value) ? value
    : value?.entries && typeof value.entries === 'object' && !Array.isArray(value.entries)
      ? Object.entries(value.entries).map(([id, agent]) => ({ ...agent, id }))
      : value?.list;
  if (!Array.isArray(list)) fail('agent-config-shape-invalid');
  return list;
}

function validateOverseerToolPolicy(agentList) {
  const matches = agentList.filter((entry) => entry?.id === OVERSEER_AGENT_ID);
  if (matches.length !== 1) fail('overseer-agent-config-invalid');
  const tools = matches[0]?.tools;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    fail('overseer-tool-policy-invalid');
  }
  if (tools.profile !== 'minimal'
    || tools.allow !== undefined
    || !exactStringSet(tools.alsoAllow, REQUIRED_TOOLS)
    || !Array.isArray(tools.deny)
    || !tools.deny.includes('session_status')
    || REQUIRED_TOOLS.some((tool) => tools.deny.includes(tool))) {
    fail('overseer-tool-policy-invalid');
  }
  return true;
}

function parseSessionList(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('session-list-json-invalid');
  }
  const sessions = parsed?.sessions;
  if (!Array.isArray(sessions)) fail('session-list-shape-invalid');
  const session = sessions.find((entry) => typeof entry?.key === 'string'
    && entry.key.startsWith('agent:overseer:'));
  if (!session) fail('overseer-session-unavailable');
  return session.key;
}

function validateMcpProbe(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('mcp-probe-json-invalid');
  }
  if (!exactStringSet(parsed?.tools, REQUIRED_MCP_TOOLS)
    || !Array.isArray(parsed?.diagnostics)
    || parsed.diagnostics.length !== 0) {
    fail('mcp-probe-invalid');
  }
  return true;
}

function toolsEffectiveArguments(sessionKey) {
  return [
    'gateway',
    'call',
    'tools.effective',
    '--params',
    JSON.stringify({ agentId: OVERSEER_AGENT_ID, sessionKey }),
    '--expect-final',
    '--json',
    '--timeout',
    '30000',
  ];
}

function validateEffectiveToolInventory(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('effective-tools-json-invalid');
  }
  if (parsed?.agentId !== OVERSEER_AGENT_ID
    || parsed?.profile !== 'minimal'
    || !Array.isArray(parsed?.groups)) {
    fail('effective-tools-invalid');
  }
  const tools = parsed.groups.flatMap((group) => (Array.isArray(group?.tools) ? group.tools : []));
  const ids = tools.map((tool) => tool?.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    fail('effective-tools-invalid');
  }
  if (exactStringSet(ids, REQUIRED_TOOLS)) return true;
  const noticeIds = Array.isArray(parsed.notices)
    ? parsed.notices.map((notice) => notice?.id).filter((id) => typeof id === 'string')
    : [];
  if (!exactStringSet(ids, ['read'])
    || noticeIds.length !== 1
    || !MCP_PENDING_NOTICE_IDS.includes(noticeIds[0])) {
    fail('effective-tools-invalid');
  }
  return true;
}

function validateThinking(environment) {
  const thinking = environment.OPENCLAW_OVERSEER_THINKING;
  if (typeof thinking !== 'string' || !ALLOWED_THINKING.includes(thinking)) {
    fail('thinking-config-invalid');
  }
  return thinking;
}

function resolveOpenclawCli(environment = process.env) {
  const configured = environment.OPENCLAW_BIN;
  return typeof configured === 'string' && configured.trim() ? configured : OPENCLAW_CLI;
}

function runProcess(args, code, dependency = spawnSync, cli = OPENCLAW_CLI) {
  let result;
  try {
    result = dependency(cli, args, {
      encoding: 'buffer',
      maxBuffer: PROCESS_OUTPUT_MAX_BYTES,
      timeout: args[0] === 'gateway' && args[2] === 'agent'
        ? GATEWAY_TIMEOUT_MS + 10000
        : 40000,
      windowsHide: true,
    });
  } catch {
    fail(code);
  }
  if (result?.error || result?.signal || result?.status !== 0
    || !Buffer.isBuffer(result.stdout) || result.stdout.length > PROCESS_OUTPUT_MAX_BYTES) {
    fail(code);
  }
  return decodeUtf8(result.stdout, `${code}-utf8`);
}

function requireInstalledContract(dependency = spawnSync, cli = OPENCLAW_CLI) {
  const configText = runProcess(
    ['config', 'get', 'agents', '--json'],
    'agent-config-read-failed',
    dependency,
    cli,
  );
  validateOverseerToolPolicy(parseAgentList(configText));
  const sessionsText = runProcess(
    ['sessions', '--agent', OVERSEER_AGENT_ID, '--limit', '1', '--json'],
    'session-list-read-failed',
    dependency,
    cli,
  );
  const sessionKey = parseSessionList(sessionsText);
  const mcpProbeText = runProcess(
    ['mcp', 'probe', 'agentx', '--json'],
    'mcp-probe-failed',
    dependency,
    cli,
  );
  validateMcpProbe(mcpProbeText);
  const effectiveToolsText = runProcess(
    toolsEffectiveArguments(sessionKey),
    'effective-tools-read-failed',
    dependency,
    cli,
  );
  validateEffectiveToolInventory(effectiveToolsText);
}

function buildAgentParams({ message, runId, thinking }) {
  return {
    message,
    agentId: OVERSEER_AGENT_ID,
    sessionId: runId,
    thinking,
    deliver: false,
    timeout: AGENT_TIMEOUT_SECONDS,
    cleanupBundleMcpOnRunEnd: true,
    bootstrapContextMode: 'full',
    bootstrapContextRunKind: 'cron',
    disableMessageTool: true,
    idempotencyKey: runId,
  };
}

function gatewayArguments(params) {
  return [
    'gateway',
    'call',
    'agent',
    '--params',
    JSON.stringify(params),
    '--expect-final',
    '--json',
    '--timeout',
    String(GATEWAY_TIMEOUT_MS),
  ];
}

function parseGatewayReply(text, runId) {
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    fail('gateway-response-json-invalid');
  }
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || response.status !== 'ok' || response.runId !== runId
    || !response.result || typeof response.result !== 'object'
    || response.result.meta?.transport === 'embedded'
    || (response.result.meta?.agentMeta?.sessionId !== undefined
      && response.result.meta.agentMeta.sessionId !== runId)) {
    fail('gateway-response-invalid');
  }
  return true;
}

function verifyRunTranscript(
  runId,
  spawn = spawnSync,
  verify = verifyTranscriptText,
  cli = OPENCLAW_CLI,
) {
  let receipt;
  try {
    // The gateway owns session storage (SQLite in current OpenClaw).
    const response = JSON.parse(runProcess([
      'gateway', 'call', 'sessions.get', '--params', JSON.stringify({
        key: `agent:${OVERSEER_AGENT_ID}:explicit:${runId}`,
        agentId: OVERSEER_AGENT_ID,
        limit: 100,
      }), '--json', '--timeout', '30000',
    ], 'session-read-failed', spawn, cli));
    if (!Array.isArray(response?.messages)) fail('session-messages-invalid');
    receipt = verify(response.messages.map((message) => JSON.stringify({
      type: 'message', message,
    })).join('\n'));
  } catch {
    fail('transcript-postcondition-failed');
  }
  if (!receipt || typeof receipt.finalText !== 'string' || !receipt.finalText.trim()
    || receipt.finalText.includes('\0')
    || Buffer.byteLength(receipt.finalText, 'utf8') > REPLY_MAX_BYTES
    || typeof receipt.finalTextSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.finalTextSha256)
    || receipt.finalTextSha256 !== sha256Text(receipt.finalText)) {
    fail('transcript-postcondition-failed');
  }
  return receipt;
}

function executeOverseer(options = {}, dependencies = {}) {
  const message = validateMessage(options.input);
  const environment = options.environment || process.env;
  const thinking = validateThinking(environment);
  const spawn = dependencies.spawnSync || spawnSync;
  const cli = resolveOpenclawCli(environment);
  requireInstalledContract(spawn, cli);
  if (options.checkOnly === true) return { checked: true };

  const createRunId = dependencies.randomUUID || randomUUID;
  const runId = createRunId();
  if (typeof runId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
    fail('run-id-invalid');
  }
  const params = buildAgentParams({ message, runId, thinking });
  const responseText = runProcess(
    gatewayArguments(params),
    'gateway-call-failed',
    spawn,
    cli,
  );
  parseGatewayReply(responseText, runId);
  const receipt = verifyRunTranscript(
    runId,
    spawn,
    dependencies.verifyTranscriptText || verifyTranscriptText,
    cli,
  );
  return { checked: false, replyText: receipt.finalText };
}

function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 0) return { checkOnly: false };
  if (argv.length === 1 && argv[0] === '--check') return { checkOnly: true };
  fail('argument-invalid');
}

function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const input = dependencies.input ?? readBoundedStdin(dependencies.readSync || fs.readSync);
  const result = executeOverseer({
    ...args,
    input,
    environment: dependencies.environment || process.env,
  }, dependencies);
  const write = dependencies.write || ((value) => process.stdout.write(value));
  if (result.checked) write('OVERSEER_WRAPPER_CHECK_OK\n');
  else write(result.replyText.endsWith('\n') ? result.replyText : `${result.replyText}\n`);
  return result;
}

if (require.main === module) {
  try {
    runCli();
  } catch (error) {
    const code = error instanceof OverseerWrapperError ? error.code : 'internal-error';
    console.error(`OVERSEER_WRAPPER_FAILED code=${code}`);
    process.exitCode = 1;
  }
}

module.exports = {
  AGENT_TIMEOUT_SECONDS,
  GATEWAY_TIMEOUT_MS,
  MESSAGE_MAX_BYTES,
  OPENCLAW_CLI,
  OVERSEER_AGENT_ID,
  OverseerWrapperError,
  REQUIRED_MCP_TOOLS,
  REQUIRED_TOOLS,
  REPLY_MAX_BYTES,
  buildAgentParams,
  executeOverseer,
  exactStringSet,
  gatewayArguments,
  parseAgentList,
  parseArgs,
  parseSessionList,
  parseGatewayReply,
  readBoundedStdin,
  requireInstalledContract,
  resolveOpenclawCli,
  runCli,
  validateMessage,
  validateEffectiveToolInventory,
  validateMcpProbe,
  validateOverseerToolPolicy,
  validateThinking,
  verifyRunTranscript,
  toolsEffectiveArguments,
};
