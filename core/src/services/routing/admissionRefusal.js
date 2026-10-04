'use strict';

// Core refuses an inference itself while a maintenance lease, a workload or a
// quarantine holds the host: nothing reached a model. The attempt stays in the
// inference log, but it is not an inference call, so rates over the log leave
// it out.
const ADMISSION_REFUSED = 'admission_refused';

function isAdmissionRefusal(error) {
  return String(error?.code || '').startsWith('RUNTIME_INFERENCE_');
}

// Reason recorded on a failed embedding attempt.
function embedFailureReason(error) {
  if (error?.name === 'AbortError') return 'pre_response_timeout';
  return isAdmissionRefusal(error) ? ADMISSION_REFUSED : 'connection_failure';
}

// Mongo filter that keeps the inference rows dispatched to a model.
const DISPATCHED_ONLY = Object.freeze({ 'routeDecision.outcome.reasonCode': { $ne: ADMISSION_REFUSED } });

module.exports = { ADMISSION_REFUSED, DISPATCHED_ONLY, embedFailureReason, isAdmissionRefusal };
