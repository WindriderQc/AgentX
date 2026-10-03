'use strict';
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const coordination = require('../../src/services/runtimeCoordinationService');
jest.mock('../../src/services/hostPinPrimitives', () => {
  const real = jest.requireActual('../../src/services/hostPinPrimitives');
  return { ...real, fetchRunningModelInfosStrict: jest.fn() };
});
jest.mock('../../src/services/hostModelRuntime', () => ({ warmDefaultModel: jest.fn(), unloadModel: jest.fn() }));
jest.mock('../../src/services/pinThreadLookup', () => ({ pinNumThread: jest.fn().mockResolvedValue(8) }));
jest.mock('../../src/services/benchmarkRuntimeSnapshot', () => ({
  ...jest.requireActual('../../src/services/benchmarkRuntimeSnapshot'), captureBenchmarkRuntime: jest.fn()
}));
const { fetchRunningModelInfosStrict } = require('../../src/services/hostPinPrimitives');
const { warmDefaultModel, unloadModel } = require('../../src/services/hostModelRuntime');
const { captureBenchmarkRuntime, benchmarkRuntimeSnapshotIdentity } = require('../../src/services/benchmarkRuntimeSnapshot');
const { reserve, restoreSnapshots } = require('../../src/services/images/gpuReservation');
const { recoverOperation } = require('../../src/services/images/imageRecovery');
const host = 'http://127.0.0.1:11434';
const resident = (model, contextLength) => ({ model, digest: `digest-${model}`, artifactSize: 1000,
  sizeVram: 1000, contextLength, keepAlive: -1, expiresAt: '2319-01-01T00:00:00Z' });
const runningInfo = r => ({ name: r.model, digest: r.digest, size: r.artifactSize,
  size_vram: r.sizeVram, context_length: r.contextLength, expires_at: r.expiresAt });

describe('image GPU handoff and original-job recovery', () => {
  let snap, running;
  beforeEach(async () => {
    jest.clearAllMocks();
    await RuntimeCoordination.deleteMany({});
    snap = { exact: true, capturedAt: new Date(), source: 'ollama_ps',
      residents: [resident('qllama/bge-m3:f16', 4096), resident('gemma:12b', 114688)] };
    snap.identityDigest = benchmarkRuntimeSnapshotIdentity(snap);
    running = snap.residents.map(runningInfo);
    captureBenchmarkRuntime.mockResolvedValue(snap);
    fetchRunningModelInfosStrict.mockImplementation(async () => running);
    unloadModel.mockImplementation(async (_host, name) => { running = running.filter(r => r.name !== name); return { status: 'ok' }; });
    warmDefaultModel.mockImplementation(async (_host, name) => {
      running = running.filter(r => r.name !== name);
      running.push(runningInfo(snap.residents.find(r => r.model === name)));
      return { status: 'ok' };
    });
  });
  afterEach(async () => RuntimeCoordination.deleteMany({}));
  async function heldOperation(id) {
    const op = { _id: id, state: 'unknown', dispatchStarted: true, jobId: id };
    const persist = jest.fn(async changes => Object.assign(op, changes));
    const reservation = await reserve({ ollamaHosts: [host], drainMs: 1 }, op, persist, async () => false);
    return { op, persist, reservation };
  }
  test('restores the large context before embeddings and releases only verified restoration', async () => {
    const { reservation } = await heldOperation('image-one');
    expect(running).toEqual([]);
    const blocked = await coordination.acquireInference({ principal: 'chat', requestId: 'during', host, model: 'gemma:12b' });
    expect(blocked.acquired).toBe(false);
    await reservation.verified({ jobTerminal: true });
    await reservation.restore();
    expect(warmDefaultModel.mock.calls.map(c => c[1])).toEqual(['gemma:12b', 'qllama/bge-m3:f16']);
    expect(warmDefaultModel.mock.calls[0][2]).toMatchObject({ contextSize: 114688, keepAlive: -1, numThread: 8 });
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(0);
    expect(await coordination.acquireInference({ principal: 'chat', requestId: 'after', host, model: 'gemma:12b' })).toMatchObject({ acquired: true });
  });
  test('loss of an unload acknowledgement keeps the runtime fenced', async () => {
    unloadModel.mockRejectedValue(new Error('lost unload response'));
    await expect(heldOperation('image-unload')).rejects.toMatchObject({ runtimeUnknown: true });
    expect(warmDefaultModel).not.toHaveBeenCalled();
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(1);
  });
  test('a spilled restored resident never counts as successful restoration', async () => {
    const { reservation } = await heldOperation('image-spill');
    warmDefaultModel.mockImplementation(async (_host, name) => {
      running.push({ ...runningInfo(snap.residents.find(r => r.model === name)), size_vram: 500 });
      return { status: 'ok' };
    });
    await reservation.verified({ jobTerminal: true });
    try { await expect(reservation.restore()).rejects.toThrow('unverified'); }
    finally { await reservation.quarantine('restoration mismatch'); }
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(1);
  });
  test('an empty queue or missing original history cannot authorize recovery', async () => {
    const { op, persist, reservation } = await heldOperation('image-missing');
    await reservation.quarantine('lost dispatch response');
    const client = { json: jest.fn().mockResolvedValue({}), free: jest.fn() };
    await expect(recoverOperation(op, client, persist, jest.fn())).rejects.toMatchObject({ statusCode: 409 });
    expect(client.free).not.toHaveBeenCalled();
    expect(warmDefaultModel).not.toHaveBeenCalled();
  });
  test('explicit recovery imports the original terminal image, restores once and never generates again', async () => {
    const { op, persist, reservation } = await heldOperation('image-original');
    await reservation.quarantine('lost dispatch response');
    const output = { filename: 'original.png', subfolder: 'agentx', type: 'output' };
    const client = { json: jest.fn().mockResolvedValue({ [op.jobId]: {
      status: { status_str: 'success', completed: true }, outputs: { save: { images: [output] } }
    } }), free: jest.fn().mockResolvedValue({}), submit: jest.fn() };
    const archive = jest.fn().mockResolvedValue({ sha256: 'original-artifact' });
    expect(await recoverOperation(op, client, persist, archive)).toMatchObject({ state: 'completed', runtimeRestored: true });
    expect(archive).toHaveBeenCalledWith(output);
    expect(client.submit).not.toHaveBeenCalled();
    expect(client.free).toHaveBeenCalledWith(expect.any(Function), false);
    expect((await RuntimeCoordination.findById('runtime').lean()).workloads).toHaveLength(0);
  });
  test('snapshot corruption and an unrelated resident prevent runtime mutation', async () => {
    await expect(restoreSnapshots({ [host]: { ...snap, identityDigest: 'wrong' } }, async () => {})).rejects.toThrow('Exact');
    running.push({ name: 'unrelated-model' });
    await expect(restoreSnapshots({ [host]: snap }, async () => {})).rejects.toThrow('Unexpected');
    expect(warmDefaultModel).not.toHaveBeenCalled();
  });
});
