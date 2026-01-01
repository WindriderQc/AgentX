module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    'routes/**/*.js',
    'models/**/*.js',
    '!**/node_modules/**',
    '!**/tests/**'
  ],
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  verbose: true,
  testTimeout: 30000,
  setupFilesAfterEnv: ['./tests/setup-env.js'],
  globalTeardown: './tests/teardown.js',
  forceExit: false,
  detectOpenHandles: false
};
