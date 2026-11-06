'use strict';

const mockFetch = jest.fn();
const mockRefresh = jest.fn();
const mockIsParkedHost = jest.fn();
const mockRegistry = { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() };
jest.mock('node-fetch', () => (...args) => mockFetch(...args));
jest.mock('../../models/ModelRegistry', () => mockRegistry);
jest.mock('../../src/helpers/httpAgent', () => ({ getFetchOptions: () => ({}) }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getHostUrls: () => ['http://gpu:11434', 'http://gpu:11437']
}));
jest.mock('../../src/services/runtimeTopologyParking', () => ({
  defaultParking: { refresh: () => mockRefresh() },
  isParkedHost: url => mockIsParkedHost(url)
}));
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { syncAllHosts } = require('../../src/services/modelSync/syncOrchestrator');

describe('registry discovery with inactive topology modes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsParkedHost.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
    mockRegistry.find.mockResolvedValue([{
      _id: 'lane-artifact', modelName: 'lane-model',
      installations: [{ hostUrl: 'http://gpu:11437', isActive: true, lastSeenAt: new Date(0) }]
    }]);
    // The startup observer has not run yet: only refresh reveals the parked lane.
    mockRefresh.mockImplementation(async () => {
      mockIsParkedHost.mockImplementation(url => url === 'http://gpu:11437');
    });
  });

  it('refreshes intent before probing and preserves parked installations', async () => {
    const result = await syncAllHosts();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(['http://gpu:11434/api/tags']);
    expect(result).toMatchObject({ errors: [], retired: 0 });
    expect(mockRegistry.updateOne).not.toHaveBeenCalled();
  });

  it('discovers a lane again when its mode becomes active', async () => {
    await syncAllHosts();
    mockFetch.mockClear();
    mockRefresh.mockImplementation(async () => mockIsParkedHost.mockReturnValue(false));
    mockRegistry.find.mockResolvedValue([]);
    await syncAllHosts();
    expect(mockFetch.mock.calls.map(([url]) => url)).toContain('http://gpu:11437/api/tags');
  });

  it('continues reporting failures on the intended active endpoint', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await syncAllHosts();
    expect(result.errors).toEqual(['http://gpu:11434: connect ECONNREFUSED']);
    expect(mockRegistry.updateOne).not.toHaveBeenCalled();
  });
});
