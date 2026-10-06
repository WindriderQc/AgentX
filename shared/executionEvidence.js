'use strict';

function normalizeExecutionEvidence(value) {
  const invalid = () => { throw Object.assign(new Error('Invalid native execution evidence.'), { code: 'EXECUTION_EVIDENCE_INVALID' }); };
  if (value?.source !== 'openclaw' || value.mode !== 'model' || value.modelCalls !== 1 || value.toolsExecuted !== 0
      || value.modelVersionSource !== 'not-observed' || value.upstreamProvider !== null || value.costSource !== 'runtime-estimate') invalid();
  const result = { source: 'openclaw', mode: 'model', modelCalls: 1, toolsExecuted: 0,
    modelVersionSource: 'not-observed', upstreamProvider: null, costSource: 'runtime-estimate' };
  for (const key of ['nativeReceiptFingerprint', 'targetFingerprint', 'contextFingerprint', 'payloadFingerprint']) {
    if (!/^[a-f0-9]{64}$/.test(value[key] || '')) invalid(); result[key] = value[key];
  }
  for (const key of ['noMemory', 'noAgentPrompt', 'noTools', 'noRuntimeFallback', 'providerRoutingPinned']) {
    if (value[key] !== true) invalid(); result[key] = true;
  }
  return result;
}
module.exports = { normalizeExecutionEvidence };
