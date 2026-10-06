// Regression: a dead Ollama host used to hang /api/inference/embed forever
// (no timeout, no failover), which took down RAG search *and* ingest, which
// took down memory storage. Env must be set before requiring the route so the
// module-level timeout constant and the host allowlist pick it up.
process.env.EMBED_TIMEOUT_MS = '600';
process.env.EMBED_PROBE_TIMEOUT_MS = '200';
process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_2 = 'http://secondary:11434';

const express = require('express');
const request = require('supertest');
const fetch = require('node-fetch');

jest.mock('node-fetch');

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  // Mirrors the real defect: embedding models resolved to the secondary host.
  getTargetForModel: jest.fn(() => 'http://secondary:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn(() => null)
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({
    readiness: { stage: 'available', benchmarkQualified: false, stale: false, isReady: false }
  }))
}));

jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: jest.fn(async ({ signal } = {}) => ({
    signal: signal || new AbortController().signal,
    markDispatched: jest.fn(),
    assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    abandon: jest.fn(async () => ({ released: true })),
  })),
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null), evaluateEvent: jest.fn(async () => ({})) }));

const { recordInference } = require('../../src/services/modelRouter');
const { evaluateEvent } = require('../../src/services/alertService');
const { beginInferenceAdmission } = require('../../src/services/inferenceAdmissionService');
const { emit: emitBuddyEvent } = require('../../src/services/buddyEvents');
const apiRoutes = require('../../routes/api');
const inferenceRouter = require('../../routes/inference');

/** A fetch that never settles until its AbortController fires. */
function hangingFetch(_url, opts) {
  return new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (!signal) return;
    const onAbort = () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort);
  });
}

describe('POST /api/inference/embed — dead-host failover', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRoutes);

  beforeEach(() => {
    jest.clearAllMocks();
    inferenceRouter._resetEmbedLivenessForTests();
    delete process.env.REQUIRE_PROFILED_MODELS;
  });

  it('fails over to a healthy host when the routed host is a black hole', async () => {
    fetch.mockImplementation((url, opts) => {
      if (url.includes('secondary')) return hangingFetch(url, opts);
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }))
      });
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(200);

    expect(response.body.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(response.headers['x-routed-host']).toBe('http://primary:11434');
    expect(response.headers['x-agentx-fallback-used']).toBe('true');

    // The failed liveness probe is recorded as an error, the healthy one as the success,
    // so telemetry names the host that actually answered.
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'http://secondary:11434',
        status: 'error',
        routeDecision: expect.objectContaining({
          outcome: expect.objectContaining({
            code: 'upstream_error',
            reasonCode: 'host_offline'
          })
        })
      })
    );
    expect(recordInference).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'http://primary:11434',
        routedHostUrl: 'http://secondary:11434',
        status: 'success',
        fallbackUsed: true,
        fallbackReason: expect.stringMatching(/unreachable|timed out/i)
      })
    );
    expect(emitBuddyEvent).toHaveBeenCalledWith(
      'failover_triggered',
      'infrastructure',
      expect.stringContaining('Embedding failover'),
      'high',
      { intent: 'warning', surfaceScope: 'core' }
    );
  }, 10000);

  it('raises no host-unreachable incident when Core itself refuses admission on a host', async () => {
    fetch.mockImplementation(url => Promise.resolve(url.includes('/api/tags') ? { ok: true, status: 200 }
      : { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ embeddings: [[0.4]] })) }));
    beginInferenceAdmission.mockImplementationOnce(async () => {
      throw Object.assign(new Error('incompatible residency blocks inference on this host'),
        { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503 });
    });

    const response = await request(app).post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' }).expect(200);

    expect(response.headers['x-routed-host']).toBe('http://primary:11434');
    expect(evaluateEvent).not.toHaveBeenCalledWith(expect.objectContaining({ metric: 'host_unreachable' }));
    // The refused attempt is logged as a refusal, not as a host that failed to answer.
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ status: 'error',
      routeDecision: expect.objectContaining({ outcome: expect.objectContaining({ reasonCode: 'admission_refused' }) }) }));
  });

  it('still raises it when the host does not answer', async () => {
    fetch.mockImplementation(url => {
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      if (url.includes('secondary')) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ embeddings: [[0.4]] })) });
    });

    await request(app).post('/api/inference/embed').send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' }).expect(200);

    expect(evaluateEvent).toHaveBeenCalledWith(expect.objectContaining({
      metric: 'host_unreachable', additionalData: expect.objectContaining({ host: 'http://secondary:11434' }) }));
    expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ status: 'error',
      routeDecision: expect.objectContaining({ outcome: expect.objectContaining({ reasonCode: 'connection_failure' }) }) }));
  });

  it('gives up with 502 rather than hanging when every host is unreachable', async () => {
    fetch.mockImplementation(hangingFetch);

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(502);

    expect(response.body.status).toBe('error');
    expect(response.body.message).toMatch(/unreachable|timed out/i);
  }, 10000);

  it('keeps exhausted fallback timeout rows coherent with their decisions', async () => {
    fetch.mockImplementation((url, opts) => {
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return hangingFetch(url, opts);
    });

    await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(502);

    const rows = recordInference.mock.calls.map(([entry]) => entry);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'timeout')).toBe(true);
    expect(rows[0].routeDecision.outcome).toEqual(expect.objectContaining({
      code: 'upstream_timeout', reasonCode: 'pre_response_timeout'
    }));
    expect(rows.at(-1).routeDecision.outcome).toEqual(expect.objectContaining({
      code: 'fallback_failed', reasonCode: 'pre_response_timeout'
    }));
  }, 10000);

  it('honours an explicit host override instead of failing over past it', async () => {
    fetch.mockImplementation((url, opts) => {
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return hangingFetch(url, opts);
    });

    await request(app)
      .post('/api/inference/embed')
      .send({
        model: 'nomic-embed-text:v1.5',
        prompt: 'probe',
        ollamaHost: 'http://secondary:11434'
      })
      .expect(502);

    // Only the pinned host should have been contacted — never primary.
    const hosts = [...new Set(fetch.mock.calls.map(([url]) => new URL(url).host))];
    expect(hosts).toEqual(['secondary:11434']);
    const rows = recordInference.mock.calls.map(([entry]) => entry);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === 'timeout')).toBe(true);
    expect(rows.every((row) => row.routeDecision.outcome.code === 'upstream_timeout')).toBe(true);
  }, 10000);

  describe('a host without the model', () => {
    const { setRegisteredHosts } = require('../../src/helpers/ollamaHostConfig');
    afterEach(() => setRegisteredHosts([]));
    const embedOk = { ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ embeddings: [[0.7]] })) };
    const missing = { ok: false, status: 404, statusText: 'Not Found',
      text: () => Promise.resolve(JSON.stringify({ error: 'model "nomic-embed-text:v1.5" not found, try pulling it first' })) };

    it('does not end the chain: the next host serves, and the skip is recorded', async () => {
      fetch.mockImplementation(url => Promise.resolve(url.includes('/api/tags') ? { ok: true, status: 200 }
        : url.includes('secondary') ? missing : embedOk));

      const response = await request(app).post('/api/inference/embed')
        .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' }).expect(200);

      expect(response.body.embedding).toEqual([0.7]);
      expect(response.headers['x-routed-host']).toBe('http://primary:11434');
      expect(response.headers['x-agentx-fallback-used']).toBe('true');
      expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ host: 'http://secondary:11434', status: 'error',
        routeDecision: expect.objectContaining({ outcome: expect.objectContaining({ reasonCode: 'model_not_installed' }) }) }));
      // The host answered: its admission completes, and no unreachable-host incident is raised.
      const [missingAdmission] = await Promise.all(beginInferenceAdmission.mock.results.map(result => result.value));
      expect(missingAdmission.complete).toHaveBeenCalled();
      expect(missingAdmission.abandon).not.toHaveBeenCalled();
      expect(evaluateEvent).not.toHaveBeenCalledWith(expect.objectContaining({ metric: 'host_unreachable' }));
    });

    it('reaches a registered CPU host when the GPU hosts are refused or lack the model', async () => {
      setRegisteredHosts([{ id: 'cpu-embed', url: 'http://cpu-host:11435', residency: 'cpu' }]);
      fetch.mockImplementation(url => Promise.resolve(url.includes('/api/tags') ? { ok: true, status: 200 }
        : url.includes('cpu-host') ? embedOk : missing));
      beginInferenceAdmission.mockImplementationOnce(async () => {
        throw Object.assign(new Error('workload blocks inference on this host'), { code: 'RUNTIME_INFERENCE_ADMISSION_DENIED', statusCode: 503 });
      });

      const response = await request(app).post('/api/inference/embed')
        .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' }).expect(200);

      expect(response.headers['x-routed-host']).toBe('http://cpu-host:11435');
      expect(response.headers['x-agentx-fallback-used']).toBe('true');
      expect(recordInference).toHaveBeenCalledWith(expect.objectContaining({ host: 'http://cpu-host:11435', status: 'success', fallbackUsed: true }));
    });

    it('still answers 404 when the last host lacks the model too', async () => {
      fetch.mockImplementation(url => Promise.resolve(url.includes('/api/tags') ? { ok: true, status: 200 } : missing));

      const response = await request(app).post('/api/inference/embed')
        .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' }).expect(404);

      expect(response.body.message).toMatch(/not found/);
      const hosts = [...new Set(fetch.mock.calls.filter(([url]) => url.endsWith('/api/embed')).map(([url]) => new URL(url).host))];
      expect(hosts).toEqual(['secondary:11434', 'primary:11434']);
    });
  });

  it('lets a slow cold model load finish instead of aborting it', async () => {
    // Reproduces the measured 15.8s cold load: the host is alive and answers
    // the probe instantly, but the embed body takes far longer than the probe
    // budget. It must not be mistaken for a dead host.
    fetch.mockImplementation((url) => {
      if (url.includes('/api/tags')) return Promise.resolve({ ok: true, status: 200 });
      return new Promise((resolve) => {
        setTimeout(() => resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({ embeddings: [[0.9]] }))
        }), 400); // > EMBED_PROBE_TIMEOUT_MS (200), < EMBED_TIMEOUT_MS (600)
      });
    });

    const response = await request(app)
      .post('/api/inference/embed')
      .send({ model: 'nomic-embed-text:v1.5', prompt: 'probe' })
      .expect(200);

    expect(response.body.embedding).toEqual([0.9]);
  }, 10000);
});
