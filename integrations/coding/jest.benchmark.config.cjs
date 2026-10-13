// Native verifier configuration. The worker checkout cannot replace this profile.
module.exports = {
  rootDir: process.cwd(), testEnvironment: 'node',
  testMatch: ['**/benchmark/tests/unit/benchmark/artifactComparison*.test.js',
    '**/benchmark/tests/unit/benchmark/pairedStatistics.test.js',
    '**/benchmark/tests/unit/benchmark/regressionDetector.paired.test.js'],
  cacheDirectory: '/tmp/agentx-benchmark-coding-jest',
};
