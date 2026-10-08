jest.useFakeTimers();

jest.mock('../../services/janitorProfiles', () => ({ list: jest.fn(), get: jest.fn(), MIN_INTERVAL_MINUTES: 5 }));
jest.mock('../../services/janitorRunner', () => ({
  runProfile: jest.fn(async () => ({ ok: true })),
  sweepStaleRuns: jest.fn(async () => 0)
}));
jest.mock('../../utils/logger', () => ({
  log: jest.fn()
}));
jest.mock('../../utils/backgroundJobs', () => ({ backgroundJobsEnabled: jest.fn(() => true) }));

const janitorProfiles = require('../../services/janitorProfiles');
const janitorRunner = require('../../services/janitorRunner');
const { log } = require('../../utils/logger');
const { backgroundJobsEnabled } = require('../../utils/backgroundJobs');
const janitorScheduler = require('../../services/janitorScheduler');

const mockDb = { collection: jest.fn() };

beforeEach(async () => {
  jest.clearAllMocks();
  jest.clearAllTimers();
  backgroundJobsEnabled.mockReturnValue(true);
  await janitorScheduler.close();
});

afterAll(async () => {
  await janitorScheduler.close();
});

describe('janitorScheduler.init', () => {
  test('arms a timer for each enabled profile', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'a', name: 'A', schedule: { enabled: true, intervalMinutes: 10 } },
      { _id: 'b', name: 'B', schedule: { enabled: false, intervalMinutes: 10 } },
      { _id: 'c', name: 'C', schedule: null }
    ]);
    await janitorScheduler.init(mockDb);
    expect(janitorScheduler._activeProfileIds()).toEqual(['a']);
  });

  test('leaves the stale-run sweep to server startup', async () => {
    janitorProfiles.list.mockResolvedValue([]);
    await janitorScheduler.init(mockDb);
    expect(janitorRunner.sweepStaleRuns).not.toHaveBeenCalled();
  });

  test('a bad profile does not crash init', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'a', name: 'A', schedule: { enabled: true } }, // missing intervalMinutes
      { _id: 'b', name: 'B', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);
    expect(janitorScheduler._activeProfileIds()).toEqual(['b']);
  });
});

describe('janitorScheduler.reload', () => {
  test('arms a newly-enabled profile', async () => {
    janitorProfiles.list.mockResolvedValue([]);
    await janitorScheduler.init(mockDb);

    janitorProfiles.get.mockResolvedValue({
      _id: 'x', name: 'X', schedule: { enabled: true, intervalMinutes: 10 }
    });
    await janitorScheduler.reload(mockDb, 'x');
    expect(janitorScheduler._activeProfileIds()).toEqual(['x']);
  });

  test('clears a disabled profile timer', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'x', name: 'X', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);
    expect(janitorScheduler._activeProfileIds()).toEqual(['x']);

    janitorProfiles.get.mockResolvedValue({
      _id: 'x', name: 'X', schedule: { enabled: false, intervalMinutes: 10 }
    });
    await janitorScheduler.reload(mockDb, 'x');
    expect(janitorScheduler._activeProfileIds()).toEqual([]);
  });

  test('clears the timer when profile is deleted (get returns null)', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'x', name: 'X', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);

    janitorProfiles.get.mockResolvedValue(null);
    await janitorScheduler.reload(mockDb, 'x');
    expect(janitorScheduler._activeProfileIds()).toEqual([]);
  });
});

describe('janitorScheduler with background jobs disabled', () => {
  const scheduled = { _id: 'x', name: 'X', schedule: { enabled: true, intervalMinutes: 10 } };

  beforeEach(() => backgroundJobsEnabled.mockReturnValue(false));

  test('init arms no timer', async () => {
    janitorProfiles.list.mockResolvedValue([scheduled]);
    await janitorScheduler.init(mockDb);
    expect(janitorScheduler._activeProfileIds()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reload after a profile create or update arms no timer and never runs the profile', async () => {
    janitorProfiles.get.mockResolvedValue(scheduled);
    await janitorScheduler.reload(mockDb, 'x');

    expect(janitorScheduler._activeProfileIds()).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(janitorRunner.runProfile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Background jobs disabled'));
  });
});

describe('janitorScheduler timer firing', () => {
  test('runProfile is called when timer fires', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'a', name: 'A', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);

    jest.advanceTimersByTime(10 * 60 * 1000);
    // Allow microtasks (the timer handler is async)
    await Promise.resolve();

    expect(janitorRunner.runProfile).toHaveBeenCalledWith(mockDb, 'a');
  });

  test('a runProfile rejection does not bubble out', async () => {
    janitorRunner.runProfile.mockRejectedValueOnce(new Error('boom'));
    janitorProfiles.list.mockResolvedValue([
      { _id: 'a', name: 'A', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);

    jest.advanceTimersByTime(10 * 60 * 1000);
    // Allow microtasks: timer handler, runProfile rejection, .catch handler
    await Promise.resolve();
    await Promise.resolve();

    expect(janitorRunner.runProfile).toHaveBeenCalled();
    // Verify the rejection was caught and routed through the warn logger
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('boom'),
      'warn'
    );
  });
});

describe('janitorScheduler.close', () => {
  test('clears all timers', async () => {
    janitorProfiles.list.mockResolvedValue([
      { _id: 'a', name: 'A', schedule: { enabled: true, intervalMinutes: 10 } }
    ]);
    await janitorScheduler.init(mockDb);
    await janitorScheduler.close();
    expect(janitorScheduler._activeProfileIds()).toEqual([]);
  });
});
