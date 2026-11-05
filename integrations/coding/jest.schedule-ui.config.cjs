// Installed runner-owned profile, outside the worker's writable checkout.
const profile = require('./schedule_ui_profile.json');
module.exports = {
  rootDir: process.cwd(),
  testEnvironment: 'node',
  testMatch: profile.testFiles.map(path => `<rootDir>/${path}`),
  setupFilesAfterEnv: ['<rootDir>/shared/testing/noDatabase.js'],
  cacheDirectory: require('node:path').join(require('node:os').tmpdir(), 'agentx-schedule-ui-coding-jest'),
};
