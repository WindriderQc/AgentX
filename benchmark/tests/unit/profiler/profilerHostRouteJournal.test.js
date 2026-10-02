'use strict';

const mockRunJournaledProfile = jest.fn(async (_lease, _host, operation) => operation());
jest.mock('../../../src/services/profiler/profilerRunJournal', () => ({
  runJournaledProfile: (...args) => mockRunJournaledProfile(...args),
}));
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: () => [
    { id: 'primary', url: 'http://192.0.2.20:11434' },
    { id: 'tertiary', url: 'http://192.0.2.10:11434/' },
  ],
}));

const { runHostJournaled, configuredHostId } = require('../../../src/services/profiler/profilerHostRouteJournal');

beforeEach(() => mockRunJournaledProfile.mockClear());

test('maps a configured host URL to its id, ignoring case and trailing slash', () => {
  expect(configuredHostId('http://192.0.2.10:11434')).toBe('tertiary');
  expect(configuredHostId('HTTP://192.0.2.20:11434/')).toBe('primary');
  expect(configuredHostId('http://elsewhere:11434')).toBeNull();
});

test('journals a configured host run under its host id', async () => {
  const lease = { operationId: 'op' };
  const result = await runHostJournaled(lease, { hostUrl: 'http://192.0.2.10:11434', modelName: 'gemma4:12b' }, async () => 'measured');
  expect(result).toBe('measured');
  expect(mockRunJournaledProfile).toHaveBeenCalledWith(lease,
    { hostId: 'tertiary', hostUrl: 'http://192.0.2.10:11434', modelName: 'gemma4:12b' }, expect.any(Function));
});

test('an explicit host id wins and long model lists are bounded', async () => {
  await runHostJournaled({}, { hostId: 'primary', hostUrl: 'http://x:11434', modelName: 'm'.repeat(500) }, async () => null);
  expect(mockRunJournaledProfile.mock.calls[0][1]).toMatchObject({ hostId: 'primary' });
  expect(mockRunJournaledProfile.mock.calls[0][1].modelName).toHaveLength(200);
});

test('a host outside the configuration runs unjournaled, as before', async () => {
  const result = await runHostJournaled({}, { hostUrl: 'http://elsewhere:11434', modelName: 'x' }, async () => 'direct');
  expect(result).toBe('direct');
  expect(mockRunJournaledProfile).not.toHaveBeenCalled();
});
