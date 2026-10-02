'use strict';

/**
 * Pin context proposal from a completed profile (pure; no I/O).
 *
 * The proposal is the largest probe candidate that passed with the model fully
 * in VRAM *and* every other pinned resident of the host loaded fully in VRAM
 * beside it, as recorded in the same sample. A context verified alone is not
 * a fit with co-residents: when that proof is missing the limit is reported
 * as unknown and the qualification to run is described, never estimated.
 *
 * The pin is an allocation. The interactive/document recommendations are
 * per-task budgets (Benchmark modelContextResolver) and are shown beside the
 * proposal, never proposed as the pin.
 */

const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { isEmbeddingModelName } = require('../../../../shared/embeddingModels');

const BYTES_PER_MIB = 1024 * 1024;

function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function pinEntries(hostPreference) {
  return (Array.isArray(hostPreference?.pinnedModels) ? hostPreference.pinnedModels : [])
    .filter(entry => typeof entry?.model === 'string' && entry.model)
    .map(entry => ({ model: entry.model, contextSize: Number(entry.contextSize) || 0 }));
}

function proposalIdFor(evidence) {
  if (evidence?.authorityWriteId) return String(evidence.authorityWriteId);
  const profiledAt = evidence?.profile?.profiledAt ? new Date(evidence.profile.profiledAt).toISOString() : 'unknown';
  return `${evidence?._id || 'profile'}:${profiledAt}`;
}

function fullyInVram(size, sizeVram) {
  return positive(size) !== null && Number.isFinite(sizeVram) && sizeVram >= size;
}

// Placed as the host declares: wholly in VRAM, or (CPU host) none of it.
function placedAsDeclared(size, sizeVram, residency) {
  if (residency === 'cpu') return positive(size) !== null && sizeVram === 0;
  return fullyInVram(size, sizeVram);
}

function sampleModelInVram(sample) {
  if (positive(sample?.gpuSizeTotal) !== null && Number.isFinite(sample?.gpuSizeVram)) {
    return placedAsDeclared(sample.gpuSizeTotal, sample.gpuSizeVram, sample.residency);
  }
  return Number(sample?.gpuPercent) === (sample?.residency === 'cpu' ? 0 : 100);
}

/**
 * Whether a co-resident observation satisfies a pin: placed as the host
 * declares, and at the pinned allocation when the pin names one.
 */
function residentSatisfiesPin(observed, pin, residency = 'gpu') {
  if (!observed || !placedAsDeclared(observed.size, observed.sizeVram, residency)) return false;
  return !(pin.contextSize > 0) || Number(observed.contextLength) === pin.contextSize;
}

/**
 * Classify one probe step against the host's other pins. A sample saved
 * without its residency is read with the host's (profiles saved before it was
 * persisted would otherwise read a CPU sample as a GPU spill).
 */
function assessStep(step, otherPins, hostResidency = 'gpu') {
  const samples = (Array.isArray(step?.samples) ? step.samples : [])
    .map(sample => (sample && !sample.residency ? { ...sample, residency: hostResidency } : sample));
  if (step?.passed !== true || samples.length === 0) return { proven: false, recorded: false, missing: [] };
  const recorded = samples.every(sample => Array.isArray(sample?.coResidents));
  if (!recorded) return { proven: false, recorded: false, missing: otherPins.map(pin => pin.model) };
  const missing = otherPins.filter(pin => !samples.every(sample => residentSatisfiesPin(
    sample.coResidents.find(item => isSameOllamaModel(item?.model, pin.model)), pin, sample.residency
  ))).map(pin => pin.model);
  const modelInVram = samples.every(sample => sample.passed !== false && sampleModelInVram(sample));
  return { proven: modelInVram && missing.length === 0, recorded: true, missing };
}

function expectedVram(step) {
  const samples = step.samples || [];
  const max = values => {
    const finite = values.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : null;
  };
  const modelBytes = max(samples.map(sample => sample.gpuSizeVram));
  return {
    hostUsedMiB: max(samples.map(sample => sample.vramUsedMiB)),
    hostTotalMiB: max(samples.map(sample => sample.vramTotalMiB)),
    modelMiB: modelBytes == null ? null : Math.round(modelBytes / BYTES_PER_MIB)
  };
}

function coResidentSummary(step, otherPins) {
  const sample = (step.samples || [])[0] || {};
  return otherPins.map(pin => {
    const observed = (sample.coResidents || []).find(item => isSameOllamaModel(item?.model, pin.model));
    return {
      model: pin.model,
      pinnedContext: pin.contextSize,
      observedContext: observed?.contextLength ?? null,
      vramMiB: Number.isFinite(observed?.sizeVram) ? Math.round(observed.sizeVram / BYTES_PER_MIB) : null
    };
  });
}

/**
 * @param {object} input
 * @param {string} input.modelName
 * @param {string} input.hostId
 * @param {string} input.hostUrl
 * @param {object|null} input.evidence    active ModelPerformanceProfile (lean)
 * @param {object|null|undefined} input.hostPreference Core host preference; undefined = unreadable
 * @param {object|null} input.decision    latest ContextProposalDecision for this model/host
 */
function buildContextProposal({ modelName, hostId, hostUrl, evidence, hostPreference, decision = null }) {
  const base = { modelName, hostId, hostUrl, offer: false };
  const profile = evidence?.profile || null;
  if (!profile) return { ...base, status: 'no_profile', reason: 'No active profile for this model on this host.' };

  const proposalId = proposalIdFor(evidence);
  const taskBudgets = {
    interactive: positive(profile.recommendedInteractiveContext),
    document: positive(profile.recommendedDocumentContext)
  };
  const soloVerifiedContext = positive(profile.maxVerifiedContext);
  const common = { ...base, proposalId, profiledAt: profile.profiledAt || null, soloVerifiedContext, taskBudgets };

  if (hostPreference === undefined) {
    return { ...common, status: 'pins_unavailable', reason: 'Core host pins are unreadable; no proposal is made.' };
  }
  const pins = pinEntries(hostPreference);
  const pin = pins.find(entry => isSameOllamaModel(entry.model, modelName));
  if (!pin) {
    return { ...common, status: 'not_pinned', reason: 'This model is not pinned on this host, so there is no pin to change.' };
  }
  const currentContext = pin.contextSize;
  const withPin = { ...common, pinnedModel: pin.model, currentContext };
  if (isEmbeddingModelName(pin.model)) {
    return { ...withPin, status: 'not_applicable', reason: 'Embedding pins have no context proposal.' };
  }

  const steps = Array.isArray(profile.probeSteps) ? profile.probeSteps : [];
  if (!soloVerifiedContext || steps.length === 0) {
    return { ...withPin, status: 'insufficient_evidence', reason: 'The profile has no context probe; run a standard or full profile.' };
  }

  const otherPins = pins.filter(entry => entry !== pin);
  const hostResidency = require('../probePlacement').residencyOf(hostUrl);
  const assessed = steps.map(step => ({ step, ...assessStep(step, otherPins, hostResidency) }));
  const proven = assessed.filter(item => item.proven).sort((a, b) => b.step.numCtx - a.step.numCtx)[0] || null;

  if (!proven) {
    const passing = assessed.filter(item => item.step.passed === true);
    const recorded = passing.some(item => item.recorded);
    const missing = [...new Set(passing.flatMap(item => item.missing))];
    return {
      ...withPin,
      status: 'unknown_limit',
      reason: recorded
        ? 'No passing probe step had every other pinned resident fully in VRAM beside this model.'
        : 'This profile predates co-resident recording; the fit with the other pins is unknown.',
      qualification: {
        residents: otherPins.map(entry => ({ model: entry.model, contextSize: entry.contextSize })),
        missingResidents: missing,
        candidates: passing.map(item => item.step.numCtx).filter(ctx => ctx > currentContext).sort((a, b) => a - b),
        instruction: 'Reprofile this model on this host while the listed pins stay resident. Each probe sample records the models loaded beside it; a candidate qualifies only when every pin stays fully in VRAM.'
      }
    };
  }

  const proposedContext = proven.step.numCtx;
  const proof = {
    numCtx: proposedContext,
    samples: proven.step.samples.length,
    tokensPerSec: proven.step.tokPerSec ?? null,
    basis: otherPins.length ? 'co_resident_probe' : 'sole_resident_probe'
  };
  const evidenceFields = { proposedContext, expectedVram: expectedVram(proven.step), coResidents: coResidentSummary(proven.step, otherPins), proof };

  if (proposedContext === currentContext) {
    return { ...withPin, ...evidenceFields, status: 'matches', reason: 'The pin already uses the proposed context.' };
  }
  // A decrease needs proof that the current pin does not fit: a capacity
  // failure (spill/OOM, not a timeout) at or below it. A transport-bounded
  // ladder only proves a floor, and a pin the probe never failed at is not
  // shown to be too large. Core's speed check cannot catch a needless shrink.
  const capacityFailureAtPin = steps.some(step => step?.passed === false
    && step.failureKind === 'capacity' && Number(step.numCtx) <= currentContext);
  const transportCeiling = profile.contextCeilingFailureKind === 'transport';
  if (proposedContext < currentContext && (transportCeiling || !capacityFailureAtPin)) {
    return {
      ...withPin, ...evidenceFields,
      status: 'unknown_limit',
      reason: transportCeiling
        ? 'The probe stopped on a timeout or lost connection, so its largest context is only a floor; it does not show the current pin no longer fits.'
        : 'The current pin is larger than the co-resident proof, but the probe never failed for capacity at or below it.',
      qualification: {
        residents: otherPins.map(entry => ({ model: entry.model, contextSize: entry.contextSize })),
        missingResidents: [],
        candidates: [currentContext],
        instruction: transportCeiling
          ? 'Requalify with a longer CONTEXT_PROBE_TIMEOUT_MS and the other pins resident, so the ladder ends on a capacity result.'
          : 'Reprofile with the other pins resident to verify the current pin together with them.'
      }
    };
  }

  const declined = decision?.proposalId === proposalId && decision?.decision === 'keep_current'
    && decision.proposedContext === proposedContext;
  const lastAttempt = decision?.proposalId === proposalId
    && ['apply_failed', 'apply_outcome_unknown'].includes(decision?.decision)
    ? {
      decidedAt: decision.decidedAt,
      outcomeUnknown: decision.decision === 'apply_outcome_unknown',
      outcome: decision.outcome || null
    } : null;
  return {
    ...withPin, ...evidenceFields,
    status: 'proposed',
    offer: true,
    direction: proposedContext > currentContext ? 'increase' : 'decrease',
    declined,
    declinedAt: declined ? decision.decidedAt : null,
    lastAttempt,
    reason: proposedContext > currentContext
      ? 'A larger context passed with every pinned resident fully in VRAM.'
      : 'The probe failed for capacity at or below the current pin; the proposal is the largest context that passed.'
  };
}

module.exports = { buildContextProposal, assessStep, residentSatisfiesPin, proposalIdFor };
