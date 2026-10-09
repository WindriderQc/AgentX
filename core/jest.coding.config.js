'use strict';

const base = require('./jest.config');

// A single network-free subset for the guarded Core test profile. The verifier
// runs in a read-only checkout and a private network namespace.
module.exports = {
  ...base,
  globalSetup: undefined,
  globalTeardown: undefined,
  setupFilesAfterEnv: ['<rootDir>/../shared/testing/noDatabase.js'],
  testMatch: ['**/tests/unit/inferenceRuntimePolicy.test.js'],
  cacheDirectory: '/tmp/agentx-coding-jest'
};
