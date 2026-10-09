'use strict';
const { createHash } = require('node:crypto');
const { recordInference } = require('../routing/inferenceTelemetry');

async function executeWithTelemetry(client, input, options, attribution = {}) {
  const started = Date.now(); let result, error;
  try { result = await client.execute(input, options); return result; }
  catch (failure) { error = failure; throw failure; }
  finally {
    const receipt = result?.receipt || error?.executionReceipt, usage = receipt?.usage;
    let host = 'openclaw'; try { host = new URL(process.env.OPENCLAW_GATEWAY_URL).origin; } catch { /* unconfigured */ }
    void recordInference({ host, model: input.model, caller: attribution.caller || 'proxy', callerDetail: attribution.callerDetail || 'openclaw-source',
      consumerContract: attribution.consumerContract || null, runtime: 'agentx', taskType: attribution.taskType || null,
      executionSource: 'openclaw', executionMode: input.execution.mode,
      executionReceiptFingerprint: receipt ? createHash('sha256').update(JSON.stringify(receipt)).digest('hex') : null,
      tokensIn: usage?.input != null ? usage.input + (usage.cacheRead || 0) + (usage.cacheWrite || 0) : usage?.input_tokens ?? null,
      tokensOut: usage?.output ?? usage?.output_tokens ?? null, durationMs: Date.now() - started,
      fallbackUsed: receipt?.isolation?.noRuntimeFallback ? false : null,
      status: error ? 'error' : 'success', error: error ? 'OPENCLAW_EXECUTION_FAILED' : null });
  }
}
module.exports = { executeWithTelemetry };
