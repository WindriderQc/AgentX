'use strict';

// Use the measured settings only for tool turns on an exact qualified target.
// Plain chat and historical evidence without an execution profile stay unchanged.
function qualifiedToolExecution(body, target) {
  if (!(Array.isArray(body.tools) && body.tools.length) && body.messages?.at(-1)?.role !== 'tool') return null;
  const tools = target?.inferenceContract?.capabilities?.tools;
  const execution = tools?.qualifiedExecution;
  if (tools?.qualified !== true || tools.supported !== true || !execution) return null;
  const sampling = execution.sampling;
  if (execution.think !== false || !sampling || sampling.temperature !== 0
    || !Number.isFinite(sampling.top_p) || sampling.top_p < 0 || sampling.top_p > 1
    || !Number.isSafeInteger(sampling.top_k) || sampling.top_k <= 0
    || !Number.isFinite(sampling.repeat_penalty) || sampling.repeat_penalty <= 0) {
    throw Object.assign(new Error('The qualified tool execution profile is unavailable.'), {
      statusCode: 409, code: 'TOOL_EXECUTION_PROFILE_UNAVAILABLE'
    });
  }
  if (body.reasoning_effort && body.reasoning_effort !== 'none') {
    throw Object.assign(new Error('This tool profile requires thinking disabled; use a separate chat turn for reasoning.'), {
      statusCode: 409, code: 'TOOL_EXECUTION_PROFILE_MISMATCH'
    });
  }
  return { think: false, temperature: sampling.temperature, top_p: sampling.top_p,
    options: { top_k: sampling.top_k, repeat_penalty: sampling.repeat_penalty } };
}

module.exports = { qualifiedToolExecution };
