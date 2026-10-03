'use strict';
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { workflow } = require('../../src/services/images/workflows');
const { localUrl } = require('../../src/services/images/config');
const { decode } = require('../../src/services/images/codec');
const { PNG } = require('pngjs');

test('empty /free acknowledgement is followed by measured memory release', async () => {
  const fetcher = jest.fn(async url => ({ ok: true, text: async () => url.endsWith('/free') ? '' : JSON.stringify(
    url.endsWith('/queue') ? { queue_running: [], queue_pending: [] } : { devices: [{ vram_total: 12e9, vram_free: 11e9, torch_vram_total: 0, torch_vram_free: 0 }] }) }));
  const client = createComfyClient('http://127.0.0.1:8188', fetcher);
  const assertOwned = jest.fn(); await client.free(assertOwned);
  expect(fetcher.mock.calls.map(x => x[0])).toEqual(['http://127.0.0.1:8188/queue', 'http://127.0.0.1:8188/free', 'http://127.0.0.1:8188/system_stats']);
  expect(assertOwned).toHaveBeenCalledTimes(2);
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
  for (const value of ['https://example.com', 'http://user:pass@127.0.0.1', 'http://172.32.1.1', 'http://192.168.2.1/?key=a']) expect(() => localUrl(value)).toThrow();
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
  expect(graph.text.inputs).toMatchObject({ image_1: ['ref0', 0], image_2: ['ref1', 0], resolution: 1024 });
  expect(graph.sample.inputs.latent_image).toEqual(['text', 2]);
  expect(graph.cache.inputs).toMatchObject({ device: 'cpu', dtype: 'default' });
});
