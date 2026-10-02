#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_ENDPOINT = process.env.AGENTX_USAGE_ENDPOINT || 'http://127.0.0.1:3180/api/analytics/codex-usage';
const DEFAULT_LOOKBACK_DAYS = 45;
const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  if (length <= 0) return '';
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  const text = buffer.toString('utf8');
  return stat.size > length ? text.slice(text.indexOf('\n') + 1) : text;
}

function parseStartFromName(filePath) {
  const match = path.basename(filePath).match(/rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeLimit(value) {
  if (!value || typeof value !== 'object') return null;
  const usedPercent = nullableNumber(value.used_percent);
  const windowMinutes = nullableNumber(value.window_minutes);
  const resetsSeconds = nullableNumber(value.resets_at);
  if (usedPercent === null && windowMinutes === null && resetsSeconds === null) return null;
  return {
    usedPercent,
    windowMinutes,
    resetsAtMs: resetsSeconds === null ? null : resetsSeconds * 1000,
  };
}

function parseCodexSession(filePath, sessionsRoot, maxBytes = DEFAULT_TAIL_BYTES) {
  const tail = readTail(filePath, maxBytes);
  let latestToken = null;
  let model = null;
  for (const line of tail.split(/\r?\n/)) {
    if (!line || (!line.includes('"token_count"') && !line.includes('"turn_context"'))) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type === 'turn_context' && row.payload && typeof row.payload.model === 'string') {
      model = row.payload.model.slice(0, 160);
    }
    if (row.type === 'event_msg' && row.payload && row.payload.type === 'token_count' && row.payload.info) {
      latestToken = row;
    }
  }
  if (!latestToken) return null;
  const usage = latestToken.payload.info.total_token_usage || {};
  const relative = path.relative(sessionsRoot, filePath).replace(/\\/g, '/');
  return {
    session: {
      sessionKey: crypto.createHash('sha256').update(relative).digest('hex'),
      startedAtMs: parseStartFromName(filePath),
      updatedAtMs: Date.parse(latestToken.timestamp) || fs.statSync(filePath).mtimeMs,
      model,
      inputTokens: numberOrZero(usage.input_tokens),
      cachedInputTokens: numberOrZero(usage.cached_input_tokens),
      outputTokens: numberOrZero(usage.output_tokens),
      reasoningOutputTokens: numberOrZero(usage.reasoning_output_tokens),
      totalTokens: numberOrZero(usage.total_tokens),
    },
    account: {
      observedAtMs: Date.parse(latestToken.timestamp) || fs.statSync(filePath).mtimeMs,
      planType: typeof latestToken.payload.rate_limits?.plan_type === 'string'
        ? latestToken.payload.rate_limits.plan_type.slice(0, 80)
        : null,
      primary: normalizeLimit(latestToken.payload.rate_limits?.primary),
      secondary: normalizeLimit(latestToken.payload.rate_limits?.secondary),
      credits: latestToken.payload.rate_limits?.credits
        ? {
            hasCredits: latestToken.payload.rate_limits.credits.has_credits === true,
            unlimited: latestToken.payload.rate_limits.credits.unlimited === true,
            balance: latestToken.payload.rate_limits.credits.balance == null
              ? null
              : String(latestToken.payload.rate_limits.credits.balance).slice(0, 64),
          }
        : null,
    },
  };
}

function listJsonlFiles(rootDir) {
  const result = [];
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(fullPath);
    }
  }
  return result;
}

function buildCodexUsagePayload(options = {}) {
  const sessionsRoot = options.sessionsRoot || path.join(os.homedir(), '.codex', 'sessions');
  const lookbackDays = numberOrZero(options.lookbackDays || DEFAULT_LOOKBACK_DAYS);
  const tailBytes = numberOrZero(options.tailBytes || DEFAULT_TAIL_BYTES);
  const hostId = String(options.hostId || process.env.COMPUTERNAME || os.hostname() || 'unknown-host')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 96);
  if (!fs.existsSync(sessionsRoot)) throw new Error(`Codex sessions directory not found: ${sessionsRoot}`);
  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const files = listJsonlFiles(sessionsRoot)
    .filter((filePath) => fs.statSync(filePath).mtimeMs >= cutoff)
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
  const sessions = [];
  let latestAccount = null;
  let filesSkipped = 0;

  for (const filePath of files) {
    let parsed;
    try {
      parsed = parseCodexSession(filePath, sessionsRoot, tailBytes);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      filesSkipped += 1;
      continue;
    }
    sessions.push(parsed.session);
    if (!latestAccount || parsed.account.observedAtMs > latestAccount.observedAtMs) {
      latestAccount = parsed.account;
    }
  }

  const observedAtMs = latestAccount?.observedAtMs || Date.now();
  return {
    version: 1,
    source: 'codex-local',
    hostId,
    observedAtMs,
    sessions,
    account: latestAccount
      ? {
          planType: latestAccount.planType,
          primary: latestAccount.primary,
          secondary: latestAccount.secondary,
          credits: latestAccount.credits,
        }
      : null,
    scan: {
      filesScanned: files.length,
      sessionsFound: sessions.length,
      filesSkipped,
      lookbackDays,
    },
  };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--payload-stdout') options.payloadStdout = true;
    else if (arg === '--endpoint') options.endpoint = argv[++i];
    else if (arg === '--access-code-file') options.accessCodeFile = argv[++i];
    else if (arg === '--sessions-root') options.sessionsRoot = argv[++i];
    else if (arg === '--lookback-days') options.lookbackDays = Number(argv[++i]);
    else if (arg === '--tail-bytes') options.tailBytes = Number(argv[++i]);
    else if (arg === '--host-id') options.hostId = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function postPayload(payload, options) {
  const codeFile = options.accessCodeFile || process.env.AGENTX_ACCESS_CODE_FILE;
  const code = codeFile ? fs.readFileSync(codeFile, 'utf8').trim() : '';
  if (codeFile && !code) throw new Error('Configured access-code file is empty');
  const response = await fetch(options.endpoint || DEFAULT_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(code ? { authorization: `Bearer ${code}` } : {}),
    },
    redirect: 'error',
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`AgentX returned ${response.status}: ${body.error || body.message || 'unknown error'}`);
  if (body.ok !== true) throw new Error(`AgentX rejected the Codex usage payload: ${body.error || 'missing acceptance receipt'}`);
  return body;
}

function printHelp() {
  console.log(`Usage: node integrations/operations/codex-usage-sync.js [options]

Reads only token_count and turn_context.model fields from local Codex JSONL files.
Prompts, responses, tool calls, paths, and raw session identifiers are never sent.

Options:
  --dry-run                 Build and summarize without sending
  --payload-stdout          Write the sanitized JSON payload only (for SSH piping)
  --endpoint URL            AgentX analytics endpoint (default: ${DEFAULT_ENDPOINT})
  --access-code-file PATH   Existing parental code for the HTTPS household entry
  --sessions-root PATH      Override ~/.codex/sessions
  --lookback-days N         Scan files updated in the last N days (default: ${DEFAULT_LOOKBACK_DAYS})
  --tail-bytes N            Bytes read from the tail of each file (default: ${DEFAULT_TAIL_BYTES})
  --host-id ID              Override the sanitized host identifier`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  const payload = buildCodexUsagePayload(options);
  if (options.payloadStdout) {
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  const safeSummary = {
    hostId: payload.hostId,
    observedAt: new Date(payload.observedAtMs).toISOString(),
    sessions: payload.sessions.length,
    tokens: payload.sessions.reduce((sum, session) => sum + session.totalTokens, 0),
    planType: payload.account?.planType || null,
    primaryUsedPercent: payload.account?.primary?.usedPercent ?? null,
    scan: payload.scan,
  };
  if (options.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, summary: safeSummary }, null, 2));
    return;
  }
  const result = await postPayload(payload, options);
  console.log(JSON.stringify({ ok: true, summary: safeSummary, result: result.result }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`codex-usage-sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCodexUsagePayload,
  normalizeLimit,
  parseCodexSession,
  parseStartFromName,
  postPayload,
  readTail,
};
