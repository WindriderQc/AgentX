'use strict';
// Runs the opt-in tests that execute generated drivers and the code-runner
// daemon with the local interpreters. They finish in a few seconds; CI runs
// them through `test:surfaces`.
const path = require('path');

process.env.BENCHMARK_DRIVER_SMOKE = '1';
require('../../shared/testing/runJest').run(path.resolve(__dirname, '..'), [
  '--runInBand',
  'tests/unit/executionDrivers.local.test.js',
  'tests/unit/calibrationFixtures.local.test.js',
  'tests/unit/pairedCatalog.local.test.js',
  'tests/unit/codeRunnerClient.test.js'
])
  .then(code => { process.exitCode = code; })
  .catch(err => { console.error(err.message); process.exitCode = 1; });
