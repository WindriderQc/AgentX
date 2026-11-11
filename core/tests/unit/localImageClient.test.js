'use strict';
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { workflow } = require('../../src/services/images/workflows');
const { localUrl } = require('../../src/services/images/config');
const { decode } = require('../../src/services/images/codec');
const { PNG } = require('pngjs');

test('acceptance checks installed models on a busy worker while execution still requires it free', async () => {
  const nodes = Object.fromEntries([['UNETLoader', 'unet_name', 'diffusion'], ['CLIPLoader', 'clip_name', 'encoder'], ['VAELoader', 'vae_name', 'vae']]
    .map(([node, input, value]) => [node, { input: { required: { [input]: [[value]] } } }]));
  const fetcher = jest.fn(async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/object_info') ? nodes
    : url.endsWith('/queue') ? { queue_running: [['synthetic-running']], queue_pending: [] } : { devices: [] }) }));
  const client = createComfyClient('http://127.0.0.1:8188', fetcher);
  const profile = { diffusion: 'diffusion', encoder: 'encoder', vae: 'vae' };
  await expect(client.ready(profile, { allowBusy: true })).resolves.toEqual({ devices: [] });
  await expect(client.ready(profile)).rejects.toThrow('already busy');
  await expect(client.ready({ ...profile, diffusion: 'missing' }, { allowBusy: true })).rejects.toThrow('not installed');
  expect(fetcher.mock.calls.every(([url]) => !url.endsWith('/prompt'))).toBe(true);
});

test('empty /free acknowledgement is followed by measured memory release', async () => {
  const fetcher = jest.fn(async url => ({ ok: true, text: async () => url.endsWith('/free') ? '' : JSON.stringify(
    url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : { devices: [{ vram_total: 12e9, vram_free: 11e9, torch_vram_total: 0, torch_vram_free: 0 }] }) }));
  const client = createComfyClient('http://127.0.0.1:8188', fetcher);
  const assertOwned = jest.fn(); await client.free(assertOwned);
  expect(fetcher.mock.calls.map(x => x[0])).toEqual(['http://127.0.0.1:8188/queue', 'http://127.0.0.1:8188/free', 'http://127.0.0.1:8188/system_stats']);
  expect(assertOwned).toHaveBeenCalledTimes(2);
});
test('the worker release answer reaches the caller without changing or blocking the measured release', async () => {
  const answer = { resources: { contract: 'agentx.image-worker-resources/v1' } };
  const fetcher = jest.fn(async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/free') ? answer
    : url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : { devices: [{ vram_total: 12e9, vram_free: 11e9, torch_vram_total: 0, torch_vram_free: 0 }] }) }));
  const client = createComfyClient('http://127.0.0.1:8188', fetcher);
  const seen = jest.fn();
  await expect(client.free(jest.fn(), true, 0.85, seen)).resolves.toMatchObject({ devices: [expect.any(Object)] });
  expect(seen).toHaveBeenCalledWith(answer);
  await expect(client.free(jest.fn(), true, 0.85, () => { throw new Error('bad receipt'); })).resolves.toMatchObject({ devices: [expect.any(Object)] });
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/system_stats'))).toHaveLength(2);
});
test('submission has an exact identity and never retries a lost response', async () => {
  const fetcher = jest.fn().mockRejectedValue(new Error('lost'));
  await expect(createComfyClient('http://127.0.0.1:8188', fetcher).submit('id', {})).rejects.toThrow('lost');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test('terminal failure is observed before it can authorize GPU restoration', async () => {
  const fetcher = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify({ test: { status: { status_str: 'error', completed: false } } }) }));
  const terminal = jest.fn();
  await expect(createComfyClient('http://127.0.0.1:8188', fetcher).observe('test', {
    timeoutMs: 5000, cancelled: async () => false, assertOwned: async () => {}, onTerminal: terminal
  })).rejects.toMatchObject({ terminal: true });
  expect(terminal).toHaveBeenCalledTimes(1);
});
test('public endpoints, credentials and malformed local addresses are rejected', () => {
  for (const value of ['https://example.com', 'http://user:pass@127.0.0.1', 'http://172.32.1.1', 'http://192.168.50.1/?key=a']) expect(() => localUrl(value)).toThrow();
  expect(localUrl('http://172.27.0.1:8188')).toBe('http://172.27.0.1:8188');
});
test('full decode refuses truncated output and pixel bombs before allocating pixels', () => {
  const valid = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16) });
  expect(decode(valid)).toMatchObject({ width: 2, height: 2 });
  expect(() => decode(valid.subarray(0, 30))).toThrow();
  const bomb = Buffer.from(valid); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(100000, 20);
  expect(() => decode(bomb)).toThrow('pixel limit');
});
test('graphs keep reference order and cap editing pixels independently of uploaded dimensions', () => {
  const profile = { family: 'qwen21', diffusion: 'a.safetensors', encoder: 'b.safetensors', vae: 'c.safetensors', steps: 25 };
  const graph = workflow(profile, { prompt: 'Edit image 1', width: 1024, height: 1024, seed: 1 }, ['first.png', 'second.png'], 'operation');
  expect(graph.text.inputs).toMatchObject({ 'images.image_1': ['ref0', 0], 'images.image_2': ['ref1', 0], resolution: 992 });
  expect(graph.sample.inputs.latent_image).toEqual(['text', 2]);
  expect(graph.cache.inputs).toMatchObject({ device: 'cpu', dtype: 'default' });
});


test.each([undefined, null, {}, [], 'agentx.image-output-removal/v1', { contract: 'foreign/v1' }])(
  'temporary readiness refuses absent or malformed output removal proof: %j without any effect', async outputRemoval => {
    const profile = { diffusion: 'diffusion', encoder: 'encoder', vae: 'vae' };
    const nodes = Object.fromEntries([['UNETLoader', 'unet_name', 'diffusion'], ['CLIPLoader', 'clip_name', 'encoder'], ['VAELoader', 'vae_name', 'vae']]
      .map(([node, input, value]) => [node, { input: { required: { [input]: [[value]] } } }]));
    const stats = { devices: [], ...(outputRemoval !== undefined && { outputRemoval }) };
    const fetcher = jest.fn(async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/object_info') ? nodes
      : url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : stats) }));
    const client = createComfyClient('http://127.0.0.1:8188', fetcher);
    await expect(client.ready(profile, { requireQueueProof: true, requireOutputRemoval: true })).rejects.toThrow('output removal');
    await expect(client.ready(profile)).resolves.toEqual(stats);
    expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
  }
);

test('temporary readiness accepts the exact advertised native output removal contract using read-only probes', async () => {
  const profile = { diffusion: 'diffusion', encoder: 'encoder', vae: 'vae' };
  const nodes = Object.fromEntries([['UNETLoader', 'unet_name', 'diffusion'], ['CLIPLoader', 'clip_name', 'encoder'], ['VAELoader', 'vae_name', 'vae']]
    .map(([node, input, value]) => [node, { input: { required: { [input]: [[value]] } } }]));
  const stats = { outputRemoval: { contract: 'agentx.image-output-removal/v1' } };
  const fetcher = jest.fn(async url => ({ ok: true, text: async () => JSON.stringify(url.endsWith('/object_info') ? nodes
    : url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : stats) }));
  await expect(createComfyClient('http://127.0.0.1:8188', fetcher).ready(profile,
    { requireQueueProof: true, requireOutputRemoval: true })).resolves.toEqual(stats);
  expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true);
});
