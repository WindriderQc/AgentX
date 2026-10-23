'use strict';

const { requestPrincipal } = require('../../helpers/requestCaller');
const { resolveCallerPolicy } = require('./callerPolicy');

function inferenceCallerPrincipal(req) {
  return requestPrincipal(req);
}

/**
 * Resolve caller-supplied performance metadata into an effective policy.
 * Callers on the private LAN are trusted, so the requested policy is applied
 * as declared.
 */
function resolveInferenceRequestCaller(req) {
  const callerDetail = req.body?.callerDetail || '';
  const requestedPolicy = resolveCallerPolicy(callerDetail);
  return {
    principal: inferenceCallerPrincipal(req),
    requestedPolicy,
    effectivePolicy: requestedPolicy
  };
}

// Bind the known service principal at Core's existing private-LAN boundary.
// Free-form callerDetail and body.consumerContract never establish identity.
// This is telemetry only; workload proof/admission still decides execution.
function resolveExecutionCaller(body, callerContext, consumerContract) {
  if (!callerContext) {
    const policy = resolveCallerPolicy(body.callerDetail || '');
    callerContext = { principal: 'core-inference', requestedPolicy: policy, effectivePolicy: policy };
  }
  return { callerContext, consumerContract: consumerContract
    || (callerContext.principal === 'benchmark-service' ? 'benchmark-service-v1' : null) };
}

module.exports = {
  inferenceCallerPrincipal,
  resolveInferenceRequestCaller,
  resolveExecutionCaller
};
