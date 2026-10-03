'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attributionForTurn, attributedConversations } = require('../turn-attribution');
const { nativePerformedBy } = require('../native-attribution');
const { publicAudit } = require('../persona-records');

const session = { sessionId: 'synthetic', agentId: 'main', persona: { id: 'example', version: 3, name: 'Example',
  voice: { provider: 'kokoro', presentation: 'masculine', voices: { en: 'am_michael', fr: 'ff_siwis' } } } };

test('every Household write captures the speaker, performers and requested voice including interrupted turns', async () => {
  const recorded = [];
  const conversations = attributedConversations({ getSession: async () => session,
    recordTurn: async input => { recorded.push(input); return input; } });
  for (const input of [{ replyText: 'Bonjour.' }, { replyText: '', interrupted: true }, { replyText: 'Bonjour.', routeTier: 'deterministic' }]) {
    const audit = await conversations.recordTurn({ ...input, sessionId: session.sessionId });
    assert.deepEqual(audit.speaker, { agentId: 'main', personaId: 'example', personaVersion: 3, name: 'Example' });
    assert.deepEqual(audit.performedBy, [{ agentId: 'main', runId: null }]);
    assert.deepEqual(audit.voice, { provider: audit.replySpeech.provider, voice: audit.replySpeech.voice });
    assert.deepEqual(publicAudit(audit).speaker, audit.speaker);
    assert.deepEqual(publicAudit(audit).performedBy, audit.performedBy);
    assert.deepEqual(publicAudit(audit).voice, audit.voice);
  }
  assert.equal(recorded.length, 3);
  assert.equal(recorded.some(input => 'replySpeech' in input), false);
  assert.equal(publicAudit({}).speaker, null, 'legacy rows receive no invented attribution');
});

test('a directly addressed member is attributed with its own personality and voice', () => {
  const audit = attributionForTurn(session, { speakerAgentId: 'secretary', replyText: 'Bonjour.',
    toolEvidence: { authority: 'openclaw/secretary', runId: 'synthetic-run' } });
  assert.deepEqual(audit.speaker, { agentId: 'secretary', personaId: 'secretary', personaVersion: 0, name: 'Secretary' });
  assert.deepEqual(audit.performedBy, [{ agentId: 'secretary', runId: 'synthetic-run' }]);
  assert.deepEqual(audit.voice, { provider: 'kokoro', voice: 'ff_siwis' });
});

test('native attribution preserves original and delivery runs without inventing consulted agent executions', () => {
  const performedBy = nativePerformedBy({ run: { agentId: 'main', runId: 'original' },
    answer: { status: 'ready', runId: 'original', deliveredBy: 'image_generate:synthetic:done' },
    progress: [{ agentId: 'secretary', tool: 'sessions_spawn' }] }, 'main', 'original');
  assert.deepEqual(performedBy, [{ agentId: 'main', runId: 'original' }, { agentId: 'main', runId: 'image_generate:synthetic:done' }]);
  assert.deepEqual(attributionForTurn(session, { toolEvidence: { performedBy } }).performedBy, performedBy);
  assert.deepEqual(nativePerformedBy({ answer: { status: 'ready', runId: 'other', deliveredBy: 'unrelated' } }, 'main', 'original'),
    [{ agentId: 'main', runId: 'original' }]);
});
