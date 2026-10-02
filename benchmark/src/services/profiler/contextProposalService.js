'use strict';

/**
 * Read and decide pin context proposals.
 *
 * Benchmark owns the profile evidence and the operator's decision; Core owns
 * the pin. "Apply" is forwarded to Core's guarded pin/context route, which
 * re-checks the pin, verifies every resident in VRAM and short-prompt speed,
 * and rolls back on regression. This service never writes a pin itself.
 */

const ContextProposalDecision = require('../../../models/ContextProposalDecision');
const hostProfileService = require('./hostProfileService');
const modelPerformanceProfileService = require('./modelPerformanceProfileService');
const coreApiClient = require('../../clients/coreApiClient');
const { hostUrlKey } = require('../../../../shared/ollamaHostConfig');
const { buildContextProposal } = require('./contextProposal');
const logger = require('../../../config/logger');

function proposalError(message, code, statusCode, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

/** Core preference for a host: null when Core has none, undefined when unreadable. */
async function loadHostPreference(hostUrl, deps = {}) {
  const readStatuses = deps.getDedicationStatuses || coreApiClient.getDedicationStatuses;
  try {
    const prefs = await readStatuses();
    const key = hostUrlKey(hostUrl);
    return prefs.find(pref => hostUrlKey(pref.hostUrl || pref.host) === key) || null;
  } catch (error) {
    logger.warn('Context proposal could not read Core host pins', { hostUrl, error: error.message });
    return undefined;
  }
}

async function latestDecision(modelName, hostId) {
  return ContextProposalDecision.findOne({ modelName, hostId }).sort({ decidedAt: -1 }).lean();
}

async function resolveHost(hostId) {
  const host = await hostProfileService.getById(hostId);
  if (!host?.hostUrl) throw proposalError('Host not found', 'HOST_NOT_FOUND', 404);
  return host;
}

async function proposalFor(modelName, host, hostPreference) {
  const [evidence, decision] = await Promise.all([
    modelPerformanceProfileService.getActiveProfile(modelName, host.hostId),
    latestDecision(modelName, host.hostId)
  ]);
  return buildContextProposal({
    modelName,
    hostId: host.hostId,
    hostUrl: hostPreference?.hostUrl || host.hostUrl,
    evidence,
    hostPreference,
    decision
  });
}

async function getProposal({ modelName, hostId }, deps = {}) {
  const host = await resolveHost(hostId);
  return proposalFor(modelName, host, await loadHostPreference(host.hostUrl, deps));
}

/** Proposals for every model pinned on the host (the card view). */
async function listProposals({ hostId }, deps = {}) {
  const host = await resolveHost(hostId);
  const hostPreference = await loadHostPreference(host.hostUrl, deps);
  if (hostPreference === undefined) return { hostId, pinsReadable: false, proposals: [] };
  const pinned = (hostPreference?.pinnedModels || []).map(entry => entry.model).filter(Boolean);
  const proposals = await Promise.all(pinned.map(model => proposalFor(model, host, hostPreference)));
  return { hostId, pinsReadable: true, proposals };
}

function coreFailure(error) {
  let body = null;
  try { body = error.body ? JSON.parse(error.body) : null; } catch { body = null; }
  return {
    httpStatus: error.status || null,
    code: body?.code || error.code || 'CORE_PIN_CONTEXT_APPLY_FAILED',
    message: body?.message || error.message,
    rollback: body?.rollback || null,
    details: body?.details || null
  };
}

async function recordDecision(proposal, decision, outcome = null) {
  return ContextProposalDecision.create({
    modelName: proposal.modelName,
    hostId: proposal.hostId,
    hostUrl: proposal.hostUrl,
    proposalId: proposal.proposalId,
    decision,
    currentContext: proposal.currentContext,
    proposedContext: proposal.proposedContext,
    outcome
  });
}

/**
 * Record "keep_current" or forward "apply". The request must name the exact
 * proposal the operator saw; anything else is stale and changes nothing.
 */
async function decide({ modelName, hostId, proposalId, contextSize, decision }, deps = {}) {
  if (!['apply', 'keep_current'].includes(decision)) {
    throw proposalError('decision must be "apply" or "keep_current"', 'PROPOSAL_DECISION_INVALID', 400);
  }
  const proposal = await getProposal({ modelName, hostId }, deps);
  if (proposal.status !== 'proposed' || proposal.proposalId !== proposalId || proposal.proposedContext !== contextSize) {
    throw proposalError('The proposal changed; review the current one before deciding', 'PROPOSAL_STALE', 409, { proposal });
  }

  if (decision === 'keep_current') {
    await recordDecision(proposal, 'keep_current');
    return { decision, proposal: await getProposal({ modelName, hostId }, deps) };
  }

  const request = deps.coreRequest || coreApiClient.coreRequest;
  let response;
  try {
    response = await request(`/api/nerve-center/host-preferences/${encodeURIComponent(proposal.hostUrl)}/pin/context`, {
      method: 'POST',
      operationId: coreApiClient.CORE_OPERATIONS.PIN_CONTEXT_APPLY,
      body: JSON.stringify({
        model: proposal.pinnedModel,
        contextSize: proposal.proposedContext,
        expectedContextSize: proposal.currentContext,
        operatorDecision: 'apply'
      })
    });
  } catch (error) {
    // Without an HTTP answer (deadline, lost connection) Core may still have
    // applied the pin: record the outcome as unknown and re-read the live pin.
    if (!error.status) {
      const outcome = {
        httpStatus: null,
        code: 'PIN_CONTEXT_APPLY_OUTCOME_UNKNOWN',
        message: `No answer from Core (${error.message}); the apply outcome is unknown. Check the current pin before retrying.`,
        rollback: null,
        details: null
      };
      await recordDecision(proposal, 'apply_outcome_unknown', outcome);
      throw proposalError(outcome.message, outcome.code, 504, {
        outcome, proposal: await getProposal({ modelName, hostId }, deps)
      });
    }
    const outcome = coreFailure(error);
    await recordDecision(proposal, 'apply_failed', outcome);
    throw proposalError(outcome.message, outcome.code, outcome.httpStatus || 502, {
      outcome, proposal: await getProposal({ modelName, hostId }, deps)
    });
  }
  const contextApply = response?.data?.contextApply || null;
  await recordDecision(proposal, 'applied', { contextApply });
  return { decision: 'applied', contextApply, proposal: await getProposal({ modelName, hostId }, deps) };
}

module.exports = { getProposal, listProposals, decide, loadHostPreference, _internal: { coreFailure } };
