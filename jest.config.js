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
  globalSetup: './tests/jest.globalSetup.js',
  globalTeardown: './tests/jest.globalTeardown.js',
  forceExit: true,
  detectOpenHandles: false
};
