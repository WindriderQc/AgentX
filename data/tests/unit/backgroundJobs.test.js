const { backgroundJobsEnabled } = require('../../utils/backgroundJobs');

describe('backgroundJobsEnabled', () => {
  test('is on only for the explicit setting, and never under test', () => {
    expect(backgroundJobsEnabled({ DATA_BACKGROUND_JOBS_ENABLED: 'true' })).toBe(true);
    expect(backgroundJobsEnabled({ DATA_BACKGROUND_JOBS_ENABLED: 'true', NODE_ENV: 'production' })).toBe(true);
    expect(backgroundJobsEnabled({ DATA_BACKGROUND_JOBS_ENABLED: 'true', NODE_ENV: 'test' })).toBe(false);
    expect(backgroundJobsEnabled({ DATA_BACKGROUND_JOBS_ENABLED: 'false' })).toBe(false);
    expect(backgroundJobsEnabled({ DATA_BACKGROUND_JOBS_ENABLED: '1' })).toBe(false);
    expect(backgroundJobsEnabled({})).toBe(false);
  });

  test('reads the process environment by default', () => {
    expect(backgroundJobsEnabled()).toBe(false); // jest sets NODE_ENV=test
  });
});
