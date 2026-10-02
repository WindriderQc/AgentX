'use strict';
const { generate } = require('../clients/ollamaClient');
const { jsonMutationDuration } = require('./profiler/profilerMutationObservation');
async function sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs, signal = null, numPredict) {
  const start = Date.now();
  try {
    const data = await generate(hostUrl, {
      model: modelName,
      prompt,
      stream: false,
      think: false,
      options: {
        num_ctx: numCtx,
        num_predict: numPredict,
        temperature: 0,
        seed: 7
      }
    }, { timeoutMs, signal });

    const latencyMs = jsonMutationDuration(data, Date.now() - start);
    const evalCount = data.eval_count || 0;
    const evalDuration = data.eval_duration || 0;
    const promptTokens = data.prompt_eval_count || 0;
    const durationSec = evalDuration / 1e9;
    const tokensPerSec = durationSec > 0 ? evalCount / durationSec : 0;

    return {
      ok: true,
      tokensPerSec: Number(tokensPerSec.toFixed(2)),
      promptTokens,
      completionTokens: evalCount,
      latencyMs
    };
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    return {
      ok: false,
      tokensPerSec: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      error: err.message,
      errorCode: err.code || null,
      // Set by ollamaClient when Ollama returned no verdict at all.
      transportFailure: err.transportFailure === true
    };
  }
}


module.exports = { sendProbeRequest };
