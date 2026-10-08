'use strict';
jest.mock('../../models/ImageOperation', () => ({ findById: jest.fn() }));
jest.mock('../../src/services/images/config', () => ({ loadConfig: jest.fn() }));
const ImageOperation = require('../../models/ImageOperation');
const { loadConfig } = require('../../src/services/images/config');
const { describe, details, workerInfo } = require('../../src/services/images/workshopPresentation');
const profile = { label: 'Synthetic recipe', family: 'qwen21', diffusion: 'model_int8.safetensors',
  encoder: 'encoder.safetensors', vae: 'vae.safetensors', steps: 25, maxPixels: 4194304 };
const config = { workerUrl: 'http://127.0.0.1:8188', presentation: { hostLabel: 'Workshop PC', gpuLabel: 'Configured GPU', vramGiB: 12 },
  profiles: { quality: profile }, privateCredential: 'never-return', ollamaHosts: ['http://127.0.0.1:11434'] };
beforeEach(() => { jest.clearAllMocks(); loadConfig.mockReturnValue(config); });
test('the overview reports declared models, steps and limits without leaking the manifest', () => {
  const view = describe(config);
  expect(view.worker).toMatchObject({ label: 'Workshop PC', gpu: 'Configured GPU', source: 'current-worker-configuration' });
  expect(view.profiles[0]).toMatchObject({ diffusion: 'model_int8.safetensors', steps: 25, maxPixels: 4194304, editingFraming: 'first-reference' });
  expect(view.profiles[0]).toMatchObject({ maxEdge: 2752, sizes: [{ ratio: '1:1', width: 2048, height: 2048 }] });
  expect(view.dimensions).toEqual({ minEdge: 256, maxEdge: 2752, multiple: 32 });
  expect(describe({ ...config, profiles: { quality: { ...profile, maxPixels: 4300800 } } }).profiles[0].sizes).toHaveLength(7);
  expect(describe({ ...config, profiles: { quick: { ...profile, family: 'klein' } } })).toMatchObject({ profiles: [{ sizes: null, maxEdge: 2048 }], dimensions: { maxEdge: 2048 } });
  expect(JSON.stringify(view)).not.toContain('never-return'); expect(view.ollamaHosts).toBeUndefined();
  expect(describe(null)).toMatchObject({ worker: null, profiles: [] });
});
test('an older operation on another worker does not inherit the currently configured GPU', () => {
  expect(workerInfo('http://127.0.0.2:8188', config)).toEqual({ address: '127.0.0.2', label: '127.0.0.2', gpu: null, vramGiB: null, source: 'recorded-worker-address' });
});
test('image details retain the historical recipe and distinguish requested and actual dimensions', async () => {
  const op = { _id: 'synthetic', profile: { ...profile, id: 'quality', steps: 40 }, workerUrl: config.workerUrl,
    request: { prompt: 'An illustration', width: 1024, height: 1024, seed: 0 },
    artifact: { width: 992, height: 992, path: 'generated/example.png' }, runtimeRestored: true,
    actionKey: 'private-action', admission: { secret: 'private-proof' }, timings: { totalMs: 12345 } };
  const lean = jest.fn(async () => op), select = jest.fn(() => ({ lean })); ImageOperation.findById.mockReturnValue({ select });
  const view = await details('synthetic');
  expect(select).toHaveBeenCalledWith('+request +workerUrl'); expect(view.recipe.steps).toBe(40);
  expect(view.request).toMatchObject({ width: 1024, height: 1024, seed: 0 });
  expect(view.actualDimensions).toEqual({ width: 992, height: 992 });
  expect(view.totalMs).toBe(12345); expect(view.actionKey).toBeUndefined(); expect(view.admission).toBeUndefined();
  expect(JSON.stringify(view)).not.toContain('private-proof');
});
test('missing image details return a bounded not-found outcome', async () => {
  ImageOperation.findById.mockReturnValue({ select: () => ({ lean: async () => null }) });
  await expect(details('missing')).rejects.toMatchObject({ statusCode: 404 });
});
