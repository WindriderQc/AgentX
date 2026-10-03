'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.mock('../../src/services/clusterScheduleService', () => ({
  recommendHost: jest.fn(),
  createClaim: jest.fn(async () => ({ claimId: 'claim-1', expiresAt: '2030-01-01T00:00:00.000Z' })),
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => [
    { id: 'primary', url: 'http://primary:11434' },
    { id: 'secondary', url: 'http://secondary:11434' },
  ]),
}));

jest.mock('../../src/services/routing/inferenceAttemptExecutor', () => ({
  modelExistsOnHost: jest.fn(async () => true),
}));

const clusterScheduleService = require('../../src/services/clusterScheduleService');
const { modelExistsOnHost } = require('../../src/services/routing/inferenceAttemptExecutor');
const { resolveAdvisoryHost } = require('../../src/helpers/schedulerClient');

const request = {
  model: 'pinned-model',
  caller: 'psyx/eval',
  createSoftClaim: true,
  fallbackHostId: 'primary',
  fallbackHostUrl: 'http://primary:11434',
  fallbackReason: 'Static task routing fallback',
};

// What the scheduler answers while a benchmark claim holds the primary.
const awayFromClaimedPrimary = {
  host: 'secondary',
  hostUrl: 'http://secondary:11434',
  reason: '12000 MiB free',
  _scored: [
    { host: 'secondary', name: 'Secondary', score: 62, reasons: ['12000 MiB free'] },
    { host: 'primary', name: 'Primary', score: null, reasons: ['benchmarking in progress'] },
  ],
};

describe('resolveAdvisoryHost', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelExistsOnHost.mockResolvedValue(true);
  });

  it('refuses instead of placing a model on a host that lacks it while its own host is claimed', async () => {
    clusterScheduleService.recommendHost.mockResolvedValue(awayFromClaimedPrimary);
    modelExistsOnHost.mockResolvedValue(false);

    const advisory = await resolveAdvisoryHost(request);

    expect(modelExistsOnHost).toHaveBeenCalledWith('http://secondary:11434', 'pinned-model');
    expect(advisory).toMatchObject({
      source: 'scheduler-blocked',
      hostId: null,
      hostUrl: null,
      claimId: null,
      recommendation: { blockedByBenchmarkClaim: true },
    });
    expect(advisory.reason).toBe('pinned-model is only installed on primary, which is held by an active benchmark claim');
    expect(clusterScheduleService.createClaim).not.toHaveBeenCalled();
  });

  it('keeps the configured host when the placement lacks the model and nothing is claimed', async () => {
    clusterScheduleService.recommendHost.mockResolvedValue({
      host: 'secondary',
      hostUrl: 'http://secondary:11434',
      reason: '12000 MiB free',
      _scored: [
        { host: 'secondary', name: 'Secondary', score: 62, reasons: ['12000 MiB free'] },
        { host: 'primary', name: 'Primary', score: 40, reasons: ['3 active claims'] },
      ],
    });
    modelExistsOnHost.mockResolvedValue(false);

    const advisory = await resolveAdvisoryHost(request);

    expect(advisory).toMatchObject({ source: 'fallback', hostId: 'primary', hostUrl: 'http://primary:11434', claimId: null });
    expect(clusterScheduleService.createClaim).not.toHaveBeenCalled();
  });

  it('follows the scheduler to another host that has the model', async () => {
    clusterScheduleService.recommendHost.mockResolvedValue(awayFromClaimedPrimary);

    const advisory = await resolveAdvisoryHost(request);

    expect(advisory).toMatchObject({
      source: 'scheduler', hostId: 'secondary', hostUrl: 'http://secondary:11434', claimId: 'claim-1',
    });
  });

  it('does not probe installation when the scheduler keeps the configured host', async () => {
    clusterScheduleService.recommendHost.mockResolvedValue({
      host: 'primary', hostUrl: 'http://primary:11434', reason: 'model already loaded', _scored: [],
    });

    const advisory = await resolveAdvisoryHost(request);

    expect(modelExistsOnHost).not.toHaveBeenCalled();
    expect(advisory).toMatchObject({ source: 'scheduler', hostId: 'primary', claimId: 'claim-1' });
  });
});
