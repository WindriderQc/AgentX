'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  BENCHMARK_CATEGORIES, BENCHMARK_CATEGORY_KEYS, GENERALIST_CATEGORY_WEIGHTS, LEADERBOARD_TAB_GROUPS,
  browserModuleSource, browserGlobalSource
} = require('./benchmarkCategories');

test('one category list drives weights and leaderboard tabs', () => {
  assert.ok(BENCHMARK_CATEGORY_KEYS.includes('agent'));
  assert.deepEqual(Object.keys(GENERALIST_CATEGORY_WEIGHTS).sort(), [...BENCHMARK_CATEGORY_KEYS].sort());
  const total = Object.values(GENERALIST_CATEGORY_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  assert.deepEqual(LEADERBOARD_TAB_GROUPS.slice(1).map(tab => tab.key), BENCHMARK_CATEGORY_KEYS);
  for (const key of BENCHMARK_CATEGORY_KEYS) {
    for (const field of ['label', 'faIcon', 'color', 'emoji', 'abbr', 'short', 'tiny']) {
      assert.ok(BENCHMARK_CATEGORIES[key][field], `${key}.${field}`);
    }
  }
});

test('browser forms carry the same list', () => {
  const moduleSource = browserModuleSource()
    .replace(/^export const /gm, 'const ')
    .concat('\nresult = { CATEGORY_KEYS, CATEGORY_META };');
  const moduleContext = { result: null };
  vm.runInNewContext(moduleSource, moduleContext);
  assert.deepEqual([...moduleContext.result.CATEGORY_KEYS], BENCHMARK_CATEGORY_KEYS);
  assert.equal(moduleContext.result.CATEGORY_META.agent.label, 'Agent');

  const globalContext = { window: {} };
  vm.runInNewContext(browserGlobalSource(), globalContext);
  assert.deepEqual([...globalContext.window.AgentXBenchmarkCategories.keys], BENCHMARK_CATEGORY_KEYS);
});
