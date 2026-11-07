'use strict';

const { buildLiveTransport } = require('../../../scripts/toolcall-qualification');
const { runScenario } = require('../../../src/services/qualification/toolCallHarness');
const { getScenario } = require('../../../src/services/qualification/toolCallFixtures');

const s4 = getScenario('s4_exec_error_recovery');
function toolMessage(id, word, content = '', thinking = '') {
  return { role: 'assistant', content, thinking, tool_calls: [{
    id, type: 'function', function: { index: 0, name: 'lookup_word', arguments: { word, language: 'fr' } }
  }] };
}

function run(messages, scenario = s4) {
  const replies = messages.map(message => structuredClone(message));
  const generateImpl = jest.fn(async () => ({ done: true, message: replies.shift() }));
  const live = buildLiveTransport({ model: 'synthetic-candidate', host: 'http://synthetic.test', generateImpl });
  return { generateImpl, result: runScenario(input => live({ ...input, workloadId: 'synthetic-admission' }), scenario) };
}

test('preserves native assistant text, reasoning and call metadata across an actual mocked error and retry', async () => {
  const first = toolMessage('call-original', 'gigantesqe', 'Je consulte le lexique.', 'Vérifier le résultat de la recherche.');
  const retry = toolMessage('call-retry', 'gigantesque', 'La première recherche a échoué.', 'Corriger le mot avant de conclure.');
  const last = { role: 'assistant', content: 'Gigantesque veut dire très grand, énorme.', thinking: 'Le second outil a réussi.' };
  const { result, generateImpl } = run([first, retry, last]);
  const report = await result;
  expect(report.pass).toBe(true);
  const afterError = generateImpl.mock.calls[1][1].messages;
  expect(afterError.slice(-2)).toEqual([
    first,
    { role: 'tool', tool_name: 'lookup_word', tool_call_id: 'call-original', content: '{"error":"not_found"}' }
  ]);
  const afterRetry = generateImpl.mock.calls[2][1].messages;
  expect(afterRetry.slice(-2)).toEqual([
    retry,
    { role: 'tool', tool_name: 'lookup_word', tool_call_id: 'call-retry', content: JSON.stringify(s4.scripted[1].result) }
  ]);
  expect(report.transcript.messages.filter(message => message.role === 'assistant')).toEqual([first, retry, last]);
  expect(report.transcript.finalText).toBe(last.content);
  expect(first.tool_calls[0].function.index).toBe(0);
});

test('correlates parallel calls of the same function by reported id', async () => {
  const first = toolMessage('first-id', 'bonjour');
  first.tool_calls.push({ id: 'second-id', function: {
    index: 1, name: 'lookup_word', arguments: { word: 'salut', language: 'fr' }
  } });
  const scenario = { ...s4, prompt: 'Cherche bonjour et salut dans le lexique.',
    expect: { ...s4.expect, recovery: null, finalMustMatch: ['salutations'] }, scripted: [
    { tool: 'lookup_word', result: { definition: 'salutation' } },
    { tool: 'lookup_word', result: { definition: 'salutation familière' } }
  ] };
  const { result, generateImpl } = run([first, { role: 'assistant', content: 'Ce sont des salutations.' }], scenario);
  expect((await result).pass).toBe(true);
  const history = generateImpl.mock.calls[1][1].messages;
  expect(history.at(-3)).toEqual(first);
  expect(history.filter(m => m.role === 'tool').map(m => [m.tool_name, m.tool_call_id]))
    .toEqual([['lookup_word', 'first-id'], ['lookup_word', 'second-id']]);
});

test('retaining a definition in a tool-call turn does not grade it as a final answer', async () => {
  const first = toolMessage('call-original', 'gigantesqe', 'Très grand, énorme.', 'Cette hypothèse doit être vérifiée.');
  const { result } = run([first], { ...s4, maxTurns: 1 });
  const report = await result;
  expect(report.transcript.messages.at(-2)).toEqual(first);
  expect(report.transcript.finalText).toBeNull();
  expect(report.classification).toBe('no_final_answer');
  expect(report.pass).toBe(false);
});

test('retained hidden reasoning never substitutes for a visible final answer', async () => {
  const first = toolMessage('call-original', 'gigantesqe');
  const retry = toolMessage('call-retry', 'gigantesque');
  const last = { role: 'assistant', content: '', thinking: 'Très grand, énorme.' };
  const { result } = run([first, retry, last]);
  const report = await result;
  expect(report.transcript.messages.at(-1)).toEqual(last);
  expect(report.dimensions.recovery.pass).toBe(true);
  expect(report.dimensions.visibleFinal.pass).toBe(false);
  expect(report.classification).toBe('no_final_answer');
});

test('an unacknowledged memory answer after the error still fails the unchanged recovery grade', async () => {
  const first = toolMessage('call-original', 'gigantesque', '', 'Use the actual tool result.');
  const last = { role: 'assistant', content: 'Gigantesque signifie très grand, énorme.' };
  const { result } = run([first, last]);
  const report = await result;
  expect(report.dimensions.visibleFinal.pass).toBe(true);
  expect(report.dimensions.recovery.pass).toBe(false);
  expect(report.pass).toBe(false);
});
