'use strict';

const { serverTimingsOf } = require('./turn-phases');

// Qualify the existing timelines on the canonical turn. This observes a result;
// it neither dispatches work nor turns an acknowledgment into a work result.
const credential = /^(?:bearer|sk-|gh[pousr]_|eyJ|api[_-]?key|token[=:])/i;
const tag = (value, pattern) => typeof value === 'string' && pattern.test(value) && !credential.test(value) ? value : undefined;
const label = value => tag(value, /^[a-zA-Z0-9][a-zA-Z0-9_.:+-]{0,199}$/);
const sourceTag = value => tag(value, /^[a-zA-Z0-9][a-zA-Z0-9_.\/+~-]{0,199}$/);
const providerTag = value => tag(value, /^[a-z][a-z0-9_-]{0,63}$/);
const modelTag = value => typeof value === 'string' && !value.includes('://') && tag(value, /^[a-zA-Z0-9][a-zA-Z0-9_.:\/+~-]{0,199}$/);
function observedTurnPhases(phases, { metadata = {}, toolEvidence, session = {}, channel } = {}) {
  const acknowledgment = toolEvidence?.authority === 'core.conversation-works';
  const relay = ['answered', 'awaiting_main'].includes(metadata.guardianDisposition);
  const source = sourceTag(metadata.routingSource);
  const runId = label(metadata.runId);
  // A configured backend alone never proves native execution, a provider or a model.
  const execution = { provenance: 'Core-observed', ...(source && { source }),
    ...(!acknowledgment && { identity: { provenance: 'runtime-declared',
      ...(providerTag(metadata.provider) && { provider: metadata.provider }),
      ...(modelTag(metadata.model) && { model: metadata.model }), ...(runId && { runId }) } }) };
  const work = toolEvidence?.acceptedWork;
  return { ...serverTimingsOf(phases), phaseEvidence: {
    schema: 1, provenance: 'Core-observed',
    consumer: 'household', ...(label(session.packId) && { packId: session.packId }),
    ...(['voice', 'text'].includes(channel) && { inputChannel: channel, inputChannelProvenance: 'browser-reported' }),
    ...(['auto', 'agentx', 'openclaw', 'hermes'].includes(session.backend) && { selectedBackend: session.backend }),
    responseKind: acknowledgment ? 'work_acknowledgment' : relay ? 'guardian_relay' : 'conversation_reply',
    ...(acknowledgment && label(work?.id) && { workId: work.id }),
    execution,
    // Clock domains/origins describe marks only when present. No offset from a
    // browser, native runtime or the outer turn is subtracted from another.
    clocks: { serverTimings: 'Core-observed/core-local/turn-request',
      agent: 'Core-observed/core-local/native-request', voiceTimings: 'browser-reported/browser-local/endpoint-decision' }
  } };
}

module.exports = { observedTurnPhases };
