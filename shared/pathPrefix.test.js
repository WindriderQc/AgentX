'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripPathPrefix } = require('./pathPrefix');

function strip(url) {
  const req = { url };
  let passed = false;
  stripPathPrefix('/benchmark')(req, {}, () => { passed = true; });
  assert.equal(passed, true);
  return req.url;
}

test('drops the prefix from the bare prefix, its slash and everything under it', () => {
  assert.equal(strip('/benchmark'), '/');
  assert.equal(strip('/benchmark/'), '/');
  assert.equal(strip('/benchmark?view=compare'), '/?view=compare');
  assert.equal(strip('/benchmark/leaderboard?tab=judges'), '/leaderboard?tab=judges');
  assert.equal(strip('/benchmark/api/benchmark/batches'), '/api/benchmark/batches');
});

test('leaves root paths and look-alike names untouched', () => {
  for (const url of ['/', '/leaderboard', '/api/benchmark/batches', '/benchmarkfoo', '/benchmark-v2.html',
    '/benchmarks/x', '/Benchmark/leaderboard', '/x/benchmark/leaderboard']) {
    assert.equal(strip(url), url);
  }
});
