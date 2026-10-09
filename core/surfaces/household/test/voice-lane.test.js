'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const lane = require('../voice-lane');
const { PERSONAL_OPERATOR_SURFACE_CONTRACT, packById } = require('../packs');

const modeInstruction = id => packById('personal_operator').modes.find(mode => mode.id === id).instruction;

test('the lane offers one delegate tool with a task and a closed list of reasons', () => {
  const tool = lane.delegateTool();
  assert.equal(tool.type, 'function');
  assert.equal(tool.function.name, 'delegate');
  assert.deepEqual(Object.keys(tool.function.parameters.properties), ['task', 'reason']);
  assert.equal(tool.function.parameters.properties.task.type, 'string');
  assert.deepEqual(tool.function.parameters.properties.reason.enum, ['live_data', 'action', 'memory_change', 'web', 'other']);
  assert.deepEqual(tool.function.parameters.required, ['task', 'reason']);
  tool.function.parameters.properties.reason.enum.push('changed');
  assert.equal(lane.delegateTool().function.parameters.properties.reason.enum.length, 5);
});

test('the lane instructions stay bounded and name what to answer, what to hand over and what never to say', () => {
  const text = lane.fastLaneInstructions();
  assert.ok(text.length < 2000, `instructions grew to ${text.length} characters`);
  for (const expected of ['small talk', 'delegate', 'calendar', 'search the web', 'remember, forget or correct a note',
    'generate images', 'Never say that you will check', 'never say that you cannot do', 'Hand over:', 'Answer yourself:']) {
    assert.ok(text.includes(expected), expected);
  }
});

test('the stable system prompt is the routing line, the personal pack, the personality, then the full rule', () => {
  const prompt = lane.fastLaneSystemPrompt();
  assert.ok(prompt.startsWith(lane.fastLaneHeader()));
  const pack = prompt.indexOf(PERSONAL_OPERATOR_SURFACE_CONTRACT);
  const identity = prompt.indexOf('use the name Nestor');
  const instructions = prompt.indexOf(lane.fastLaneInstructions());
  assert.ok(pack >= 0 && identity > pack && instructions > identity);
  assert.ok(prompt.endsWith(lane.fastLaneInstructions()));
  assert.ok(prompt.includes(modeInstruction('operator')));
  // Nothing that changes from one turn to the next.
  for (const volatile of ['Saved notes', 'Approved knowledge', 'Latest-message language', 'pour ce tour']) {
    assert.ok(!prompt.includes(volatile), volatile);
  }
  assert.equal(lane.fastLaneSystemPrompt(), prompt);
});

test('the system prompt follows the recorded mode and personality', () => {
  const prompt = lane.fastLaneSystemPrompt({ modeId: 'plan', identity: 'A synthetic personality.' });
  assert.ok(prompt.includes(modeInstruction('plan')) && !prompt.includes(modeInstruction('operator')));
  assert.ok(prompt.includes('\n\nA synthetic personality.\n\n'));
  assert.ok(!prompt.includes('use the name Nestor'));
});

test('a delegate call is read from Ollama and OpenAI answers', () => {
  const expected = { decision: 'delegated', task: 'Check the synthetic calendar', reason: 'live_data', valid: true };
  assert.deepEqual(lane.laneDecision({ message: { role: 'assistant', content: '',
    tool_calls: [{ function: { name: 'delegate', arguments: { task: ' Check the synthetic calendar ', reason: 'live_data' } } }] } }), expected);
  assert.deepEqual(lane.laneDecision({ choices: [{ message: { content: null,
    tool_calls: [{ type: 'function', function: { name: 'delegate', arguments: '{"task":"Check the synthetic calendar","reason":"live_data"}' } }] } }] }), expected);
});

test('a delegate call wins over text spoken beside it', () => {
  const decision = lane.laneDecision({ message: { content: 'One moment.',
    tool_calls: [{ function: { name: 'delegate', arguments: { task: 'Send the synthetic note', reason: 'action' } } }] } });
  assert.equal(decision.decision, 'delegated');
  assert.equal(decision.reason, 'action');
});

test('a delegate call with unusable arguments still delegates and says so', () => {
  for (const args of [{ task: '', reason: 'web' }, { task: 'Something', reason: 'because' }, 'not json', undefined, ['task']]) {
    const decision = lane.laneDecision({ message: { tool_calls: [{ function: { name: 'delegate', arguments: args } }] } });
    assert.equal(decision.decision, 'delegated');
    assert.equal(decision.valid, false);
    assert.equal(decision.problem, 'invalid_arguments');
  }
});

test('plain text is an answer', () => {
  assert.deepEqual(lane.laneDecision({ message: { role: 'assistant', content: '  A synthetic greeting.  ' } }),
    { decision: 'answered', answer: 'A synthetic greeting.' });
});

test('unusable answers are malformed', () => {
  assert.deepEqual(lane.laneDecision({ message: { content: '', tool_calls: [{ function: { name: 'web_search', arguments: {} } }] } }),
    { decision: 'malformed', problem: 'unknown_tool' });
  for (const body of [undefined, {}, { message: { content: '   ' } }, { message: { content: null, tool_calls: [] } }]) {
    assert.deepEqual(lane.laneDecision(body), { decision: 'malformed', problem: 'empty' });
  }
  for (const content of ['<tool_call>{"name":"delegate","arguments":{}}</tool_call>',
    '{"name": "delegate", "arguments": {"task": "x", "reason": "web"}}', 'delegate({"task":"x","reason":"web"})']) {
    const decision = lane.laneDecision({ message: { content } });
    assert.equal(decision.decision, 'malformed');
    assert.equal(decision.problem, 'tool_call_as_text');
  }
  // Talking about delegation is still an answer.
  assert.equal(lane.laneDecision({ message: { content: 'I would delegate that to a colleague.' } }).decision, 'answered');
});
