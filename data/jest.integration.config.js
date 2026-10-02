// Integration tests — exercise REAL MongoDB (not the mocked unit suite).
// npm test now runs these too, using its launcher-owned disposable MongoDB.
// For this subset use npm run test:integration; never pass a personal URI.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/integration/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/.worktrees/'],
  clearMocks: true
};
