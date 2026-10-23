'use strict';

const { requestPrincipal } = require('../../helpers/requestCaller');
const { trustedNestorConsumer } = require('../nestorConsumerAttribution');
const { resolveCallerPolicy } = require('./callerPolicy');

const SERVICE_CONTRACTS = Object.freeze({ 'benchmark-service': 'benchmark-service-v1', 'rag-service': 'rag-service-v1' });
const serviceContract = principal => Object.hasOwn(SERVICE_CONTRACTS, principal) ? SERVICE_CONTRACTS[principal] : null;

function resolveInferenceConsumer(req) {
  return trustedNestorConsumer(req) || serviceContract(requestPrincipal(req));
}

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
    || serviceContract(callerContext.principal) };
}

module.exports = {
  inferenceCallerPrincipal,
  resolveInferenceRequestCaller,
  resolveExecutionCaller,
  resolveInferenceConsumer
};
