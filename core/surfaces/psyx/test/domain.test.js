'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { boundedContext, composeSystemContext, normalizeControl } = require('../../../src/domains/psyx/domain');

test('trusted provider context stays inside external consumer message budgets', () => {
  const context = boundedContext(Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `m${index}-${'x'.repeat(11990)}`
  })));
  assert.ok(context.length < 40);
  assert.ok(context.every((item) => item.content.length <= 12000));
  assert.ok(context.reduce((sum, item) => sum + item.content.length, 0) <= 35000);
  const system = composeSystemContext({ activeThreads: [], notes: Array(100).fill('large '.repeat(300)), patterns: [], hypotheses: [], openLoops: [], experiments: [] }, normalizeControl({}));
  assert.ok(system.length < 16000);
});
