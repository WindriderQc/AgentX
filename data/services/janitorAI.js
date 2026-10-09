/**
 * janitorAI.js — Ollama integration for the janitor dashboard.
 * Builds prompts and routes them through Core by task type so the service
 * does not duplicate model or host selection logic locally.
 */
const { fetchWithTimeoutAndRetry } = require('../utils/fetch-utils');
const { log } = require('../utils/logger');

const CORE_PROXY_URL = (process.env.CORE_PROXY_URL || 'http://localhost:3080').replace(/\/+$/, '');

// How long one advisory request may take. The default suits a GPU host; raise
// it when `janitor_ai` is routed to a slow CPU-resident host.
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 20 * 60 * 1000;
// Past this, a retry would only queue a second long request behind the first.
const RETRY_BELOW_MS = 120000;

function requestLimits(env = process.env) {
  const value = Number(env.JANITOR_AI_TIMEOUT_MS);
  const timeout = Number.isFinite(value) && value > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(10000, Math.floor(value))) : DEFAULT_TIMEOUT_MS;
  return { timeout, retries: timeout <= RETRY_BELOW_MS ? 1 : 0 };
}

const ACTIONS = {
  triage: {
    system: `You are a storage analyst. Given file metadata (paths, sizes, ages, extensions), classify files into three categories: KEEP, ARCHIVE, or JUNK. KEEP = actively used or important. ARCHIVE = stale but potentially valuable (suggest cold storage). JUNK = safe to delete (temp, cache, orphaned). Respond ONLY with JSON: { "categories": [{ "label": "KEEP|ARCHIVE|JUNK", "reason": "string", "files_count": number, "total_size": number, "paths": ["..."] }] }`
  },
  resolve_duplicates: {
    system: `You are a deduplication advisor. Given a set of duplicate file paths with timestamps and locations, recommend which copy to keep and which to delete. Consider: originals over copies, organized paths over temp/backup paths, oldest creation date as the original. Respond ONLY with JSON: { "keep": "path", "delete": ["paths"], "reason": "string" }`
  },
  analyze_path: {
    system: `You are a storage analyst. Given directory statistics (file counts, sizes, extensions, ages), identify anomalies, waste patterns, and actionable recommendations. Respond ONLY with JSON: { "findings": [{ "type": "anomaly|waste|recommendation", "severity": "high|medium|low", "description": "string", "recommendation": "string" }] }`
  },
  chat: {
    system: `You are a disk janitor AI assistant for a self-hosted NAS/datalake. You have access to storage statistics and file metadata provided as context. Answer questions about the filesystem, suggest cleanups, identify waste, and help the user understand their storage usage. Be concise and actionable. When suggesting deletions, always recommend a dry-run first.`
  }
};

function buildPrompt(action, context = {}) {
  const actionDef = ACTIONS[action];
  if (!actionDef) throw new Error(`Unknown action: ${action}`);

  let prompt;
  switch (action) {
    case 'triage':
      prompt = `Analyze these files and classify them:\n\n${JSON.stringify(context.files || [], null, 2)}\n\nOverall stats: ${JSON.stringify(context.stats || {})}`;
      if (context.coverage) prompt += `\n\nSample coverage: ${JSON.stringify(context.coverage)}\nClassify only the supplied metadata. Unsampled actions and files have not been reviewed.`;
      break;
    case 'resolve_duplicates':
      prompt = `These files are duplicates (same SHA256 hash). Which copy should we keep?\n\n${JSON.stringify(context.duplicates || [], null, 2)}`;
      break;
    case 'analyze_path':
      prompt = `Analyze this directory:\nPath: ${context.path || 'unknown'}\nStats: ${JSON.stringify(context.stats || {})}`;
      break;
    case 'chat':
      prompt = context.message || '';
      if (context.stats) prompt += `\n\n[Storage context: ${JSON.stringify(context.stats)}]`;
      break;
  }

  return { taskType: 'janitor_ai', system: actionDef.system, prompt, stream: false };
}

function parseAIResponse(raw) {
  if (!raw || typeof raw !== 'string') return { text: '' };
  const trimmed = raw.trim();

  // 1) Whole string is clean JSON (object OR array).
  try { return JSON.parse(trimmed); } catch { /* fall through */ }

  // 2) Fenced ```json block.
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
  }

  // 3) Embedded object or array (prose around JSON). Take whichever appears first.
  const objMatch = raw.match(/\{[\s\S]*\}/);
  const arrMatch = raw.match(/\[[\s\S]*\]/);
  const candidates = [objMatch, arrMatch].filter(Boolean).sort((a, b) => a.index - b.index);
  for (const m of candidates) {
    try { return JSON.parse(m[0]); } catch { /* fall through */ }
  }

  return { text: raw };
}

async function callAI(action, context = {}) {
  const payload = buildPrompt(action, context);
  const start = Date.now();

  const res = await fetchWithTimeoutAndRetry(`${CORE_PROXY_URL}/api/inference/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      responseMode: 'normalized',
      think: false,
      callerDetail: `janitor-ai-${action}`
    }),
    ...requestLimits(),
    name: `janitor-ai-${action}`
  });

  const data = await res.json();
  const raw = data.response || '';
  const result = parseAIResponse(raw);
  const resolvedModel = typeof res.headers?.get === 'function' ? res.headers.get('x-resolved-model') : null;
  const routedHost = typeof res.headers?.get === 'function' ? res.headers.get('x-routed-host') : null;
  const routedHostKey = typeof res.headers?.get === 'function' ? res.headers.get('x-routed-host-key') : null;
  const routingSource = typeof res.headers?.get === 'function' ? res.headers.get('x-routing-source') : null;

  log(`Janitor AI [${action}] completed in ${Date.now() - start}ms`, 'info');

  return {
    action,
    result,
    taskType: payload.taskType,
    model: resolvedModel,
    target: { url: routedHost, host: routedHostKey, source: routingSource },
    duration_ms: Date.now() - start
  };
}

module.exports = {
  ACTIONS,
  buildPrompt,
  parseAIResponse,
  callAI,
  requestLimits,
  CORE_PROXY_URL
};
