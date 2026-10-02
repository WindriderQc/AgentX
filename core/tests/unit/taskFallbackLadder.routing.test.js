'use strict';

// Router-level ladder behavior against the real claim guard and runtime
// coordination documents (in-memory Mongo); only host reachability is faked.
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';
process.env.AGENTX_TASK_FALLBACK_WAIT_MS = '0';
process.env.AGENTX_LIGHTWEIGHT_HOST = 'primary';
process.env.AGENTX_CODING_SPECIALIST_HOST = 'primary';

const mongoose = require('mongoose');

const mockHealth = { offline: new Set(), models: ['gemma4:12b-it-qat'] };

jest.mock('../../src/helpers/schedulerClient', () => ({
  resolveAdvisoryHost: jest.fn(async ({ fallbackHostId, fallbackHostUrl }) => ({
    source: 'fallback', hostId: fallbackHostId, hostUrl: fallbackHostUrl, reason: 'test',
    claimId: null, claimExpiresAt: null, recommendation: null,
  })),
}));
jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: null })),
  compareReadiness: jest.fn(() => 0),
}));
jest.mock('../../src/services/modelRouter', () => ({
  checkHostHealth: jest.fn(async (hostUrl) => (mockHealth.offline.has(hostUrl)
    ? { status: 'offline', models: [] }
    : { status: 'online', models: mockHealth.models })),
}));

const routerConfig = require('../../src/services/modelRouterConfig');
const ladder = require('../../src/services/routing/taskFallbackLadder');

const PRIMARY = 'http://primary:11434';
const TERTIARY = 'http://tertiary:11434';

describe('getAdvisoryModelForTask with a fallback ladder', () => {
  beforeEach(async () => {
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({
      quick_chat: [{ model: 'gemma4:12b-it-qat', host: 'tertiary' }],
    });
    ladder._internal.resetForTests();
    mockHealth.offline = new Set();
    await mongoose.connection.db.collection('hostpreferences').deleteMany({});
    await mongoose.connection.db.collection('runtime_coordination').deleteMany({});
  });

  afterAll(() => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    delete process.env.AGENTX_TASK_FALLBACK_WAIT_MS;
    delete process.env.AGENTX_LIGHTWEIGHT_HOST;
    delete process.env.AGENTX_CODING_SPECIALIST_HOST;
  });

  it('routes as before without configuration', async () => {
    delete process.env.AGENTX_TASK_FALLBACKS_JSON;
    mockHealth.offline.add(PRIMARY);
    const result = await routerConfig.getAdvisoryModelForTask('quick_chat');
    expect(result).toMatchObject({ host: 'primary', url: PRIMARY });
    expect(result.degraded).toBeUndefined();
  });

  it('degrades a light task when its primary host is down', async () => {
    mockHealth.offline.add(PRIMARY);
    const result = await routerConfig.getAdvisoryModelForTask('quick_chat');
    expect(result).toMatchObject({ model: 'gemma4:12b-it-qat', host: 'tertiary', url: TERTIARY, source: 'task_fallback_ladder' });
    expect(result.degraded).toMatchObject({ degraded: true, reason: 'host_down', fallbackTo: { host: 'tertiary' } });
  });

  it('never degrades a strict task', async () => {
    mockHealth.offline.add(PRIMARY);
    const result = await routerConfig.getAdvisoryModelForTask('code_generation');
    expect(result.degraded).toBeUndefined();
    expect(result).toMatchObject({ host: 'primary', url: PRIMARY });
  });

  it('does not use a fallback host held by a benchmark claim', async () => {
    mockHealth.offline.add(PRIMARY);
    await mongoose.connection.db.collection('hostpreferences').insertOne({
      hostUrl: TERTIARY, status: 'benchmarking', benchmarkClaim: { batchId: 'batch-1' },
    });
    const result = await routerConfig.getAdvisoryModelForTask('quick_chat');
    expect(result.degraded).toBeUndefined();
    expect(result.host).not.toBe('tertiary');
    expect(ladder.getTaskFallbackStats().exhausted).toBe(1);
  });

  it('treats an UNKNOWN quarantine on the primary as unavailable for a light task', async () => {
    await mongoose.connection.db.collection('runtime_coordination').insertOne({
      _id: 'runtime', maintenance: null, workloads: [],
      inferences: [{ host: PRIMARY, model: 'x', state: 'UNKNOWN', mode: 'shared', expiresAt: new Date(0) }],
    });
    const light = await routerConfig.getAdvisoryModelForTask('quick_chat');
    expect(light.degraded).toMatchObject({ reason: 'quarantined' });
  });

  it('does not use a quarantined fallback host', async () => {
    mockHealth.offline.add(PRIMARY);
    await mongoose.connection.db.collection('runtime_coordination').insertOne({
      _id: 'runtime', maintenance: null, workloads: [],
      inferences: [{ host: TERTIARY, model: 'x', state: 'UNKNOWN', mode: 'shared', expiresAt: new Date(0) }],
    });
    const result = await routerConfig.getAdvisoryModelForTask('quick_chat');
    expect(result.degraded).toBeUndefined();
  });
});
