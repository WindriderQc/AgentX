'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const ImageOperation = require('../../models/ImageOperation');
jest.mock('../../src/services/images/config', () => ({ loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/gpuReservation', () => ({ reserve: jest.fn() }));
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const { reserve } = require('../../src/services/images/gpuReservation');
const service = require('../../src/services/images/imageService');
const profile = { family: 'klein', diffusion: 'diffusion.safetensors', encoder: 'encoder.safetensors', vae: 'vae.safetensors', steps: 4, maxPixels: 4194304, label: 'Test image' };
const bytes = PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, 255) });
const waitFor = async (id, state) => {
  for (let i = 0; i < 100; i++) { const op = await service.get(id); if (op.state === state) return op; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`Operation did not reach ${state}: ${JSON.stringify(await service.get(id))}`);
};
describe('durable local image operations', () => {
  let dir, client, reservation;
  beforeEach(async () => {
    jest.clearAllMocks();
    await ImageOperation.deleteMany({});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-image-test-'));
    process.env.IMAGE_ARCHIVE_DIR = dir;
    loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:8188', profiles: { quality: profile }, defaultProfile: 'quality' });
    client = { ready: jest.fn().mockResolvedValue({}), json: jest.fn().mockResolvedValue({ devices: [{ vram_total: 12e9, vram_free: 11e9 }] }),
      upload: jest.fn().mockImplementation(async (_bytes, name) => name), submit: jest.fn().mockResolvedValue({}),
      observe: jest.fn().mockImplementation(async (_id, options) => { await options.onTerminal(); return { filename: 'result.png', subfolder: 'agentx', type: 'output' }; }),
      read: jest.fn().mockResolvedValue(bytes), free: jest.fn().mockResolvedValue({}) };
    reservation = { assertOwned: jest.fn().mockResolvedValue(), verified: jest.fn().mockResolvedValue(), restore: jest.fn().mockResolvedValue(), quarantine: jest.fn().mockResolvedValue() };
    reserve.mockResolvedValue(reservation); createComfyClient.mockReturnValue(client);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); delete process.env.IMAGE_ARCHIVE_DIR; });
  test('archives and restores before reporting completion, then replays the same action', async () => {
    const body = { actionKey: 'action-first', prompt: 'A lake', references: [bytes.toString('base64')] };
    const first = await service.accept(body);
    const done = await waitFor(first.id, 'completed');
    expect(done.runtimeRestored).toBe(true);
    expect((await service.image(first.id)).bytes).toEqual(bytes);
    expect(client.upload).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining(first.id));
    expect(reservation.restore).toHaveBeenCalledTimes(1);
    expect((await service.accept(body)).id).toBe(first.id);
    expect(client.submit).toHaveBeenCalledTimes(1);
    await expect(service.accept({ ...body, prompt: 'A mountain' })).rejects.toMatchObject({ statusCode: 409 });
  });
  test('a lost submission response is UNKNOWN and cannot be automatically repeated', async () => {
    client.submit.mockRejectedValue(new Error('connection lost after dispatch'));
    const first = await service.accept({ actionKey: 'action-unknown', prompt: 'A lake' });
    await waitFor(first.id, 'unknown');
    expect(reservation.restore).not.toHaveBeenCalled();
    expect(reservation.quarantine).toHaveBeenCalledTimes(1);
    expect((await service.accept({ actionKey: 'action-unknown', prompt: 'A lake' })).state).toBe('unknown');
    await expect(service.accept({ actionKey: 'action-another', prompt: 'A mountain' })).rejects.toMatchObject({ statusCode: 409 });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('unavailable worker refuses immediately without persisting dormant work', async () => {
    client.ready.mockRejectedValue(new Error('offline'));
    await expect(service.accept({ actionKey: 'action-offline', prompt: 'A lake' })).rejects.toMatchObject({ statusCode: 503 });
    expect(await ImageOperation.countDocuments()).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
  });
  test('archive failure restores the GPU and permits storage-only recovery', async () => {
    client.read.mockRejectedValueOnce(new Error('output temporarily unavailable'));
    const first = await service.accept({ actionKey: 'action-storage', prompt: 'A lake' });
    const failed = await waitFor(first.id, 'archive_failed');
    expect(failed.runtimeRestored).toBe(true);
    expect((await service.retryArchive(first.id)).state).toBe('completed');
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('changing the worker cannot retrieve a different worker’s output', async () => {
    client.read.mockRejectedValueOnce(new Error('output temporarily unavailable'));
    const first = await service.accept({ actionKey: 'action-worker-change', prompt: 'A lake' });
    await waitFor(first.id, 'archive_failed');
    loadConfig.mockReturnValue({ workerUrl: 'http://127.0.0.1:9999', profiles: { quality: profile }, defaultProfile: 'quality' });
    await expect(service.retryArchive(first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });
  test('corrupt archived bytes are refused even when their size matches', async () => {
    const first = await service.accept({ actionKey: 'action-corrupt', prompt: 'A lake' });
    await waitFor(first.id, 'completed');
    const record = await ImageOperation.findById(first.id).lean();
    await fs.promises.writeFile(path.join(dir, record.artifact.path), Buffer.alloc(bytes.length));
    await expect(service.image(first.id)).rejects.toMatchObject({ statusCode: 503 });
  });
  test('a valid new action generates a distinct variant; identical prompts are not deduplicated', async () => {
    const first = await service.accept({ actionKey: 'action-variant-1', prompt: 'A lake' });
    await waitFor(first.id, 'completed');
    const second = await service.accept({ actionKey: 'action-variant-2', prompt: 'A lake' });
    await waitFor(second.id, 'completed');
    expect(first.id).not.toBe(second.id); expect(client.submit).toHaveBeenCalledTimes(2);
  });
});
