'use strict';
// Pure qualification suites. Mongo and executable repository fixtures remain
// covered by test:unit and npm test.
module.exports = {
  testEnvironment: 'node',
  // No <rootDir> in the glob: Jest keeps a backslash before a dot segment
  // (e.g. a Windows .claude worktree path) and then nothing matches.
  testMatch: ['**/tests/unit/qualification/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/../shared/testing/noDatabase.js'],
  testPathIgnorePatterns: ['/node_modules/', 'toolCapabilityQualificationMongo.test.js',
    'repoQualificationRunner.test.js', 'executableRepoGrader.test.js', 'repoTaskFixtures.test.js']
};
