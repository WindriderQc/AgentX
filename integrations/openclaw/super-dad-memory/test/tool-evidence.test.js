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

test('composite native call ids match exact results and keep loop detection provider independent', () => {
  const rows = [0, 1, 2, 3].flatMap(index => {
    const pair = turn(index, { tool: 'web_fetch' });
    pair[0].content[0].id = pair[1].toolCallId = 'call_synthetic_shared|fc_synthetic_' + index;
    return pair;
  });
  assert.deepEqual(checks(rows), { status: 'observed', runId, completedTools: ['web_fetch'], loop: { tool: 'web_fetch', repetitions: 4 } });
  const foreign = structuredClone(rows.slice(0, 2)); foreign[1].toolCallId = 'call_synthetic_shared|fc_foreign';
  assert.deepEqual(checks(foreign).completedTools, []);
  const otherRun = structuredClone(rows.slice(0, 2)); otherRun[1].__openclaw = { runId: 'other-run' };
  assert.deepEqual(checks(otherRun).completedTools, []);
  const malformed = structuredClone(rows.slice(0, 2)); malformed[0].content[0].id = malformed[1].toolCallId = 'call\nforged|fc_bad';
  assert.deepEqual(checks(malformed).completedTools, []);
});

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

test('a requester-settle return identifies the accepted child of this exact parent call', () => {
  const childRunId = '33333333-3333-4333-8333-333333333333';
  const childSessionKey = 'agent:secretary:subagent:44444444-4444-4444-8444-444444444444';
  const deliveredBy = `announce:requester-settle:main:${sessionKey}:${childRunId}:yield-1:retry-2`;
  const expected = { agentId: 'secretary', runId: childRunId };
  const accepted = { status: 'accepted', childSessionKey, runId: childRunId };
  const project = (rows, delivery = deliveredBy) => nativeToolChecks({ sessionKey, messages: rows }, sessionKey, runId, delivery);
  const direct = turn(1, { tool: 'sessions_spawn', args: { agentId: 'secretary' } });
  direct[0].content[0] = { type: 'toolCall', id: 'call-1', name: 'sessions_spawn', arguments: { agentId: 'secretary' } };
  direct[1].details = accepted;
  assert.deepEqual(project(direct).settledChild, expected);

  const wrapped = turn(1, { tool: 'sessions_spawn', args: { agentId: 'secretary' } });
  wrapped[0].content[0].arguments.id = 'openclaw:core:sessions_spawn';
  wrapped[1].details = { tool: { id: 'openclaw:core:sessions_spawn' }, result: { details: accepted } };
  assert.deepEqual(project(wrapped).settledChild, expected);
  for (const delivery of [deliveredBy.replace(childRunId, childSessionKey.split(':').at(-1)),
    deliveredBy.replace(childRunId, childRunId + ',' + childRunId), deliveredBy.replace(sessionKey, 'another-session')]) {
    assert.equal(project(wrapped, delivery).settledChild, null);
  }
  for (const patch of [{ toolCallId: 'other' }, { isError: true }, { __openclaw: { runId: 'other' } },
    { details: accepted }, { details: { tool: { id: 'other:sessions_spawn' }, result: { details: accepted } } }]) {
    assert.equal(project([wrapped[0], { ...wrapped[1], ...patch }]).settledChild, null);
  }
  assert.equal(project([direct[0], { ...direct[1], details: { ...accepted, childSessionKey: childSessionKey.replace('secretary', 'other') } }]).settledChild, null);
  assert.equal(project([direct[0], { ...direct[1], details: { ...accepted, status: 'denied' } }]).settledChild, null);
});
