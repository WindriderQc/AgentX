'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { observedTurnPhases } = require('../turn-phase-evidence');
const { publicAudit } = require('../persona-records');
const { createConversationExecutor } = require('../conversation-executor');
const { VoiceTimeline } = require('../../../public/js/voice/voice-timeline');
const { harness } = require('./fixtures/persona-journey.cjs');

const session = { sessionId: 'synthetic-session', packId: 'personal_operator', backend: 'openclaw' };
const hash = value => createHash('sha256').update(value).digest('hex');

test('canonical payload and audit retain input channel without equating text read aloud to voice capture', async () => {
  for (const channel of ['text', 'voice']) {
    const h = harness({ packId: 'personal_operator', backend: 'agentx' });
    const result = await h.turn('Réponse synthétique.', channel);
    assert.deepEqual(result.phaseEvidence, h.turns[0].phaseEvidence);
    assert.deepEqual(publicAudit(h.turns[0]).phaseEvidence, result.phaseEvidence);
    assert.equal(result.phaseEvidence.inputChannel, channel);
    assert.equal(result.phaseEvidence.inputChannelProvenance, 'browser-reported');
    assert.equal(result.phaseEvidence.consumer, 'household');
    assert.equal(result.phaseEvidence.selectedBackend, 'agentx');
    assert.equal(result.phaseEvidence.responseKind, 'conversation_reply');
    assert.equal(result.phaseEvidence.execution.identity.model, 'synthetic');
    assert.equal(result.phaseEvidence.execution.identity.provenance, 'runtime-declared');
    assert.equal(result.phaseEvidence.execution.identity.provider, undefined, 'a Core lane does not imply Ollama');
    assert.equal(result.phaseEvidence.execution.identity.runId, undefined);
    assert.equal(result.voiceTimings, undefined, 'reading a text reply creates no capture measurement');
  }
});

test('native identity is runtime-declared and independent of the selected backend', () => {
  for (const [authority, source] of [['openclaw/main', 'openclaw/main'], ['hermes', 'hermes/nestor']]) {
    const result = observedTurnPhases({ prepared: 500, agent: { generating: 10, firstDelta: 40, answer: 90 } }, {
      session, channel: 'voice', metadata: { routingSource: source, provider: 'synthetic-provider', model: 'synthetic-model', runId: 'synthetic-run' },
      toolEvidence: { authority, runId: 'synthetic-run' }
    });
    assert.deepEqual(result.phaseEvidence.execution, { provenance: 'Core-observed', source,
      identity: { provenance: 'runtime-declared', provider: 'synthetic-provider', model: 'synthetic-model', runId: 'synthetic-run' } });
    assert.equal(result.phaseEvidence.selectedBackend, 'openclaw');
    assert.equal(result.phaseEvidence.clocks.agent, 'Core-observed/core-local/native-request');
    assert.equal(result.phaseEvidence.clocks.voiceTimings, 'browser-reported/browser-local/endpoint-decision');
    assert.equal(result.serverTimings.agent.firstDelta, 40, 'retain the inner origin even when outer preparation took longer');
    assert.equal(result.phaseEvidence.responseKind, 'conversation_reply');
    assert.equal(result.phaseEvidence.firstAudio, undefined);
  }
});

test('a configured native backend with missing identity or phases leaves them unknown', () => {
  const result = observedTurnPhases({}, { session, channel: 'voice' });
  assert.equal(result.serverTimings, undefined);
  assert.equal(result.phaseEvidence.execution.source, undefined);
  assert.equal(result.phaseEvidence.execution.identity.provider, undefined);
  assert.equal(result.phaseEvidence.execution.identity.model, undefined);
  assert.equal(result.phaseEvidence.execution.identity.runId, undefined);
  assert.equal(publicAudit({ interrupted: true, outcome: 'cancelled' }).phaseEvidence, undefined, 'older or early-cancelled turns receive no invented qualification');
  assert.equal(publicAudit({}).serverTimings, undefined);
  const invalid = observedTurnPhases({ agent: { firstDelta: -1 } }, { metadata: { model: { name: 'invalid' }, provider: 'x'.repeat(201), runId: 'bad\nidentity' } });
  assert.equal(invalid.serverTimings, undefined);
  assert.deepEqual(invalid.phaseEvidence.execution.identity, { provenance: 'runtime-declared' });
});

test('connection configuration and credential-shaped metadata never enter the phase qualification', () => {
  for (const provider of ['https://private.invalid', 'http://127.0.0.1:1234', 'Bearer synthetic', 'sk-synthetic', 'ghp_synthetic',
    '{"apiKey":"synthetic"}', { baseUrl: 'http://private.invalid', token: 'synthetic' }]) {
    const result = observedTurnPhases({}, { metadata: { provider, model: 'https://private.invalid/model',
      routingSource: 'http://private.invalid', runId: 'sk-synthetic', token: 'synthetic', connection: { secret: 'synthetic' } } });
    assert.deepEqual(result.phaseEvidence.execution, { provenance: 'Core-observed', identity: { provenance: 'runtime-declared' } });
  }
  assert.equal(observedTurnPhases({}, { metadata: { model: 'synthetic/model:q4', provider: 'native-provider', routingSource: 'task_router+pin-ctx' } })
    .phaseEvidence.execution.identity.model, 'synthetic/model:q4');
});

test('actual Core work acknowledgments stay acknowledgments even when a result is ready', async () => {
  const text = 'Résume mes courriels récents.', turnId = 'synthetic-turn';
  for (const resultReady of [false, true]) {
    const work = { authority: 'core.conversation-works', accepted: true, id: hash(session.sessionId + '\n' + turnId),
      sessionId: session.sessionId, turnId, requestSha256: hash(text), state: resultReady ? 'completed' : 'queued', resultReady };
    const execute = createConversationExecutor({ agentClient: () => assert.fail('No native dispatch'), inference: { execute: () => assert.fail('No inference') } });
    const result = await execute({ backend: 'openclaw', session: { ...session, scopeId: 'personal', modeId: 'standard' }, text,
      channel: 'voice', readAcceptedNativeWork: async () => work });
    const { phaseEvidence } = observedTurnPhases({ prepared: 5, executed: 10 }, { session, channel: 'voice', metadata: result.metadata, toolEvidence: result.tools });
    assert.equal(phaseEvidence.responseKind, 'work_acknowledgment');
    assert.equal(phaseEvidence.workId, work.id);
    assert.deepEqual(phaseEvidence.execution, { provenance: 'Core-observed', source: 'core.conversation-works' });
    assert.equal(phaseEvidence.resultReady, undefined, 'this response is not a verified delivery or playback of the result');
  }
});

test('only an explicit guardian result qualifies a relay, without making it the primary target', () => {
  const result = observedTurnPhases({}, { metadata: { guardianDisposition: 'awaiting_main' }, session });
  assert.equal(result.phaseEvidence.responseKind, 'guardian_relay');
  assert.equal(result.phaseEvidence.workId, undefined);
  assert.equal(result.phaseEvidence.execution.identity.model, undefined);
  assert.equal(observedTurnPhases({}, { metadata: { guardianDisposition: 'invented' } }).phaseEvidence.responseKind, 'conversation_reply');
});

test('retransmitted and cancelled browser snapshots retain qualification without creating audio or work completion', async () => {
  const { phaseEvidence } = observedTurnPhases({}, { session, channel: 'voice', toolEvidence: { authority: 'core.conversation-works', acceptedWork: { id: 'synthetic-work' } } });
  const timeline = new VoiceTimeline(() => 100);
  timeline.mark('requestSent'); timeline.mark('holdingPhrase');
  timeline.finish('interrupted', 'barge_in');
  timeline.mark('firstAudio');
  const snapshots = [];
  await timeline.report(async values => { snapshots.push(publicAudit({ phaseEvidence, voiceTimings: values })); return { pending: snapshots.length === 1 }; }, () => true);
  assert.equal(snapshots.length, 2);
  for (const row of snapshots) {
    assert.deepEqual(row.phaseEvidence, phaseEvidence);
    assert.equal(row.phaseEvidence.responseKind, 'work_acknowledgment');
    assert.equal(row.voiceTimings.firstAudio, undefined);
    assert.equal(row.voiceTimings.firstSignalScheduled, undefined);
    assert.equal(row.voiceTimings.playbackOutcome, 'interrupted');
    assert.equal(row.voiceTimings.holdingPhrase, 0, 'holding does not establish reply playback');
  }
});
