'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsTaskCheck, taskCheckObserved } = require('../tool-turn-guard');
const { createAgentClient } = require('../conversation-agent');
const { nativeWorkRuntime } = require('../native-work-runtime');
const { hash } = require('../../../src/services/conversationWorks/contract');

const calendarOnly = [
  'Dans mon calendrier, aucun autre calendrier ni tâche à toucher. Lis la cible avant de modifier et vérifie-la ensuite.',
  'Vérifie mon agenda ; aucune autre tâche personnelle à toucher.',
  'Lis mon calendrier sans toucher à mes tâches.',
  'Lis mon calendrier sans consulter mes tâches.',
  'Lis mon calendrier, pas mes tâches.',
  'Lis mon calendrier, pas ma liste de tâches.',
  'Lis mon calendrier sans toucher à ma liste de tâches.',
  'Lis mon agenda sans consulter la liste de mes tâches.',
  'Read my calendar, not my tasks.',
  'Read my calendar without touching my tasks.',
  'Read my calendar, no other personal tasks to touch.',
  'Ne lis pas mes tâches ; vérifie mon agenda.'
];
const positiveTaskReads = [
  'Lis mes tâches personnelles ouvertes. Ne modifie rien.',
  'Ne modifie pas mon calendrier, puis regarde mes tâches.',
  'Ne regarde pas mon calendrier et montre mes tâches.',
  'Lis mon calendrier et mes tâches.',
  'Dans mon calendrier, aucune autre tâche à toucher. Ensuite, montre mes tâches ouvertes.',
  'Ne lis pas mes tâches archivées ; montre mes tâches ouvertes.',
  'Do not read my calendar, but show my tasks.',
  'Don’t change my calendar, then read my tasks.'
];

test('calendar-only requests do not acquire a task-list requirement from excluded task scope', () => {
  for (const text of calendarOnly) assert.equal(requestsTaskCheck(text), false, text);
});

test('an explicit positive task read survives unrelated or earlier negative scope', () => {
  for (const text of positiveTaskReads) assert.equal(requestsTaskCheck(text), true, text);
});

const runId = 'resp_22222222-2222-4222-8222-222222222222';
const session = { sessionId: '11111111-1111-4111-8111-111111111111',
  packId: 'personal_operator', scopeId: 'personal', agentId: 'main' };
const finalText = 'Le rendez-vous synthétique est déplacé et relu.';
const evidence = () => ({ ok: true, authority: 'openclaw.nestor', operation: 'turn',
  run: { runId, status: 'completed', model: 'synthetic-native' },
  answer: { runId, status: 'ready', text: finalText },
  toolChecks: { status: 'observed', runId, completedTools: ['personal_calendar'], loop: null },
  receipts: [{ runId, tool: 'personal_calendar', status: 'verified', resultRef: 'synthetic-calendar-operation' }]
});
const event = type => Buffer.from('data: ' + JSON.stringify({ type, response: { id: runId } }) + '\n\n');

for (const channel of ['voice', 'text']) {
  test(`a calendar answer reaches ${channel} unchanged, while mixed task reads still need their own proof`, async () => {
    for (const [mixed, taskProof] of [[false, false], [true, false], [true, true]]) {
      let dispatches = 0;
      const deltas = [], proof = evidence();
      if (taskProof) {
        proof.toolChecks.completedTools.push('list_personal_tasks');
        proof.receipts.push({ runId, tool: 'list_personal_tasks', status: 'verified' });
      }
      const client = createAgentClient({ settleMs: 0,
        env: { OPENCLAW_GATEWAY_URL: 'http://gateway.example.test', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' },
        continuity: async () => proof,
        fetchImpl: async () => { dispatches++; return { ok: true, body: [event('response.created'), event('response.completed')] }; }
      });
      const result = await client({ session, channel,
        text: calendarOnly[0] + (mixed ? ' Puis regarde mes tâches ouvertes.' : ''),
        onDelta: text => deltas.push(text) });
      assert.equal(dispatches, 1, 'the outcome must never trigger a replacement calendar operation');
      assert.equal(taskCheckObserved(proof, runId), taskProof, 'calendar evidence is never personal-task evidence');
      assert.deepEqual(result.tools.receipts, proof.receipts);
      assert.deepEqual(deltas, [result.text]);
      if (mixed && !taskProof) {
        assert.notEqual(result.text, finalText);
        assert.equal(result.tools.verification.reason, 'task_check_missing');
      } else {
        assert.equal(result.text, finalText);
        assert.equal(result.tools.verification, undefined);
      }
    }
  });
}

test('background Main publishes a calendar result but refuses the same proof for an explicit mixed task check', async () => {
  for (const [mixed, taskProof] of [[false, false], [true, false], [true, true]]) {
    const text = calendarOnly[0] + (mixed ? ' Puis regarde mes tâches ouvertes.' : '');
    const published = [];
    const runtime = nativeWorkRuntime({ works: {
      query: sessionId => ({ sessionId }),
      publishNative: async (...args) => published.push(args)
    }, conversations: { getTurn: async () => ({ inputText: text }) } });
    const row = { _id: 'synthetic-work', sessionId: session.sessionId, turnId: 'synthetic-turn',
      mode: 'native', classification: 'native_work', requestSha256: hash(text), attempt: { runId } };
    const proof = evidence();
    if (taskProof) proof.toolChecks.completedTools.push('list_personal_tasks');
    const result = await runtime.receive({ row, evidence: proof });
    assert.equal(taskCheckObserved(proof, runId), taskProof);
    const allowed = !mixed || taskProof;
    assert.equal(published.length, allowed ? 1 : 0);
    assert.deepEqual(result, allowed ? { published: true } : null);
    if (allowed) assert.deepEqual(published[0], [row._id, proof]);
  }
});
