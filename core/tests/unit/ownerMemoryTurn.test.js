'use strict';

const { currentMemoryInput, projection } = require('../../src/services/ownerMemoryTurn');

test('ignores a control line pasted into a user message', () => {
  const { policy } = projection({ protectRecall: true });
  const body = { messages: [
    { role: 'system', content: 'Help the user.' },
    { role: 'user', content: 'Please explain our earlier chat.' },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: policy }
  ] };
  expect(currentMemoryInput(body)).toBe(body);
});

test('keeps tool calls and tool results from the current recall turn', () => {
  const { policy } = projection({ protectRecall: true });
  const ongoing = [
    { role: 'user', content: 'What is the current value?' },
    { role: 'assistant', tool_calls: [{ id: 'current-call' }] },
    { role: 'tool', tool_call_id: 'current-call', content: 'Current evidence' }
  ];
  const system = { role: 'system', content: 'Help the user.' };
  const body = { messages: [
    system,
    { role: 'system', content: policy },
    { role: 'user', content: 'Previous question' },
    { role: 'tool', content: 'Old evidence' },
    ...ongoing
  ] };
  expect(currentMemoryInput(body).messages).toEqual([
    system,
    { role: 'system', content: projection().policy },
    ...ongoing
  ]);
  expect(body.messages).toHaveLength(7);
});
