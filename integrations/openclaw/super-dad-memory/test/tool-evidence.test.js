import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeToolChecks } from '../tool-evidence.js';

const sessionKey = 'agent:main:household:direct:11111111-1111-4111-8111-111111111111';
const runId = 'resp_22222222-2222-4222-8222-222222222222';
function turn(index, { tool = 'agents_list', args = { query: 'private-example' }, output = 'Private example result', error = false } = {}) {
  return [{ role: 'assistant', __openclaw: { runId }, content: [
    { type: 'toolCall', id: 'call-' + index, name: 'tool_call', arguments: { id: 'example:' + tool, args } }
  ] }, { role: 'toolResult', toolCallId: 'call-' + index, isError: error, content: [{ type: 'text', text: output }] }];
}
const checks = messages => nativeToolChecks({ sessionKey, messages }, sessionKey, runId);

test('four distinct completed identical calls expose a loop without arguments, results or fingerprints', () => {
  const result = checks([0, 1, 2, 3].flatMap(i => turn(i)));
  assert.deepEqual(result, { status: 'observed', runId, completedTools: ['agents_list'], loop: { tool: 'agents_list', repetitions: 4 } });
  assert.doesNotMatch(JSON.stringify(result), /private-example|Private example|[a-f0-9]{64}/);
});

test('changed arguments, changed results, another tool and incomplete calls break repetition', () => {
  for (const change of [{ args: { query: 'different' } }, { output: 'different' }, { tool: 'task_read' }]) {
    assert.equal(checks([...turn(0), ...turn(1), ...turn(2, change), ...turn(3), ...turn(4)]).loop, null);
  }
  assert.equal(checks([...turn(0), ...turn(1), turn(2)[0], ...turn(3), ...turn(4)]).loop, null);
  assert.equal(checks([...turn(0), ...turn(0), ...turn(0), ...turn(0)]).loop, null);
});

test('object key ordering does not hide identical arguments while legitimate native waits remain allowed', () => {
  assert.equal(checks([0, 1, 2, 3].flatMap(i => turn(i, { args: i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 } }))).loop.repetitions, 4);
  for (const tool of ['process', 'sessions_yield', 'sessions_history']) {
    assert.equal(checks([0, 1, 2, 3, 4].flatMap(i => turn(i, { tool }))).loop, null);
  }
});

test('failed, unfinished and other-run results never establish a successful task check', () => {
  for (const change of [{ error: true }, { output: '{"ok":false}' }, { output: '{"status":"error"}' }, { output: '{"error":"unavailable"}' }, { output: 'I will check' }, { output: '{}' }]) {
    assert.deepEqual(checks(turn(0, { tool: 'list_personal_tasks', ...change })).completedTools, []);
  }
  assert.deepEqual(checks([turn(0, { tool: 'list_personal_tasks' })[0]]).completedTools, []);
  const wrong = turn(0, { tool: 'list_personal_tasks' }); wrong[1].__openclaw = { runId: 'other' };
  assert.deepEqual(checks(wrong).completedTools, []);
  const future = turn(0, { tool: 'list_personal_tasks' });
  assert.deepEqual(checks([future[0], { role: 'user', content: 'Next turn' }, future[1]]).completedTools, []);
  assert.equal(nativeToolChecks({ sessionKey: 'other', messages: turn(0) }, sessionKey, runId).status, 'unavailable');
});

test('task-list and briefing success require the actual returned task data', () => {
  assert.deepEqual(checks(turn(0, { tool: 'list_personal_tasks', output: '{"tasks":[]}' })).completedTools, ['list_personal_tasks']);
  assert.deepEqual(checks(turn(0, { tool: 'agentx__list_personal_tasks', output: '{"ok":true,"data":{"tasks":[]}}' })).completedTools, ['agentx__list_personal_tasks']);
  assert.deepEqual(checks(turn(0, { tool: 'personal_briefing', output: '{"counts":{"open":0}}' })).completedTools, ['personal_briefing']);
  assert.deepEqual(checks(turn(0, { tool: 'personal_briefing', output: '{"counts":{"open":null}}' })).completedTools, []);
  const empty = turn(0, { tool: 'list_personal_tasks' }); empty[1].content = [];
  assert.deepEqual(checks(empty).completedTools, []);
});
