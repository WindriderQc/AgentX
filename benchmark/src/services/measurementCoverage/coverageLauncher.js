'use strict';

/**
 * Starts one bite of coverage: a standard profile, or a small batch of the
 * catalog prompts a cell still misses.
 *
 * It calls Benchmark's own HTTP routes on loopback, exactly as an operator
 * launch does, so judge selection, preflight, host claims and refusals are
 * the ones every other launch gets. Nothing here bypasses them.
 */

const { findContextProfile } = require('../modelContextProfileService');

const LEVELS = [1, 2, 3, 4, 5];
const CPU_TEST_TIMEOUT_MS = 20 * 60 * 1000;
// Below this context the default answer budget cannot fit beside the prompt.
const SMALL_CONTEXT = 65536;

function baseUrl() {
  return `http://127.0.0.1:${process.env.PORT || 3081}`;
}

async function post(path, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AgentX-Caller': 'benchmark-coverage' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === 'error') {
    const message = payload.error || payload.message || `HTTP ${response.status}`;
    throw Object.assign(new Error(String(message).slice(0, 300)), { statusCode: response.status, code: payload.code || null });
  }
  return payload.data || payload;
}

/**
 * Execution settings a cell needs to run at all. Answers are produced without
 * thinking, as the catalog campaigns are. A pin wider than the context the
 * Profiler verified runs at the verified context, and a small context gets an
 * answer budget that fits in it.
 */
async function executionConfigFor(cell, deps = {}) {
  const config = { think: false };
  const profile = cell.artifact?.digest
    ? await (deps.findContextProfile || findContextProfile)(cell.model, cell.hostUrl, cell.artifact).catch(() => null)
    : null;
  const verified = Number(profile?.maxVerifiedContext) || 0;
  const pinned = Number(cell.pinContext) || 0;
  if (verified && (!pinned || pinned > verified)) config.force_num_ctx = verified;
  const context = config.force_num_ctx || pinned;
  if (context && context <= SMALL_CONTEXT) config.response_max_tokens = Math.floor(context / 4);
  if (cell.residency === 'cpu') config.per_test_timeout_ms = CPU_TEST_TIMEOUT_MS;
  return config;
}

function runName(cell, promptCount, now = new Date()) {
  return `coverage ${now.toISOString().slice(0, 16)}Z - ${cell.hostName} - ${cell.model} - ${promptCount} prompts`.slice(0, 200);
}

/**
 * @returns {Promise<{ kind: 'profile'|'benchmark', id: string, prompts?: number }>}
 */
async function launchBite(cell, settings, deps = {}) {
  const send = deps.post || post;
  if (cell.next === 'profile') {
    const data = await send('/api/profiler/pipeline/profile', { modelName: cell.model, hostId: cell.hostId, depth: 'standard' });
    return { kind: 'profile', id: String(data.profileId || '') };
  }
  const promptIds = cell.missingPromptIds.slice(0, settings.bitePrompts);
  const data = await send('/api/benchmark/batch', {
    targets: [{ host: cell.hostUrl, model: cell.model }],
    levels: LEVELS,
    prompt_ids: promptIds,
    run_name: runName(cell, promptIds.length, deps.now ? deps.now() : new Date()),
    tags: ['coverage'],
    execution_config: await executionConfigFor(cell, deps)
  });
  return { kind: 'benchmark', id: String(data.batch_id || ''), prompts: promptIds.length };
}

module.exports = { launchBite, executionConfigFor, runName };
