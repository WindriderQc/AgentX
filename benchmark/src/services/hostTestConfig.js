/**
 * Host test configuration (HOST_TEST_* env vars) and prompt workload plan.
 * Re-exported by ./hostTestService.
 */

// ── Configuration ──────────────────────────────────────────────────────────────

function _asInt(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getConfig(options = {}) {
  const envConfig = {
    timeoutMs:       _asInt(process.env.HOST_TEST_TIMEOUT_MS, 60000),
    numPredict:      _asInt(process.env.HOST_TEST_NUM_PREDICT, 64),
    contextFillPct:  _asInt(process.env.HOST_TEST_CONTEXT_FILL_PCT, 25),
    maxPromptTokens: _asInt(process.env.HOST_TEST_MAX_PROMPT_TOKENS, 2048),
    warmup:          (process.env.HOST_TEST_WARMUP || 'true').toLowerCase() !== 'false'
  };

  return {
    timeoutMs:       _asInt(options.timeoutMs, envConfig.timeoutMs),
    numPredict:      _asInt(options.numPredict, envConfig.numPredict),
    contextFillPct:  _asInt(options.contextFillPct, envConfig.contextFillPct),
    maxPromptTokens: _asInt(options.maxPromptTokens, envConfig.maxPromptTokens),
    warmup:          typeof options.warmup === 'boolean' ? options.warmup : envConfig.warmup,
    promptWorkloadMode: options.promptWorkloadMode === 'scaled' ? 'scaled' : 'fixed'
  };
}

function buildProbePlan(numCtx, cfg) {
  const safeNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
    ? Number(numCtx)
    : null;

  if (cfg.promptWorkloadMode === 'scaled') {
    const requestedPromptTokens = Math.max(100, Math.floor((safeNumCtx || cfg.maxPromptTokens || 2048) * (cfg.contextFillPct / 100)));
    return {
      promptWorkloadMode: 'scaled',
      requestedPromptTokens,
      targetPromptTokens: requestedPromptTokens
    };
  }

  const requestedPromptTokens = Math.max(100, cfg.maxPromptTokens || 2048);
  const targetPromptTokens = safeNumCtx
    ? Math.min(requestedPromptTokens, safeNumCtx)
    : requestedPromptTokens;

  return {
    promptWorkloadMode: targetPromptTokens < requestedPromptTokens
      ? 'fixed_fallback_to_ctx'
      : 'fixed',
    requestedPromptTokens,
    targetPromptTokens
  };
}

module.exports = { getConfig, buildProbePlan };
