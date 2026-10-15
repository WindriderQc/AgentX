'use strict';
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
jest.mock('../../src/services/images/config', () => ({ ...jest.requireActual('../../src/services/images/config'), loadConfig: jest.fn() }));
jest.mock('../../src/services/images/comfyClient', () => ({ createComfyClient: jest.fn() }));
jest.mock('../../src/services/images/workQueue', () => ({ enroll: jest.fn(async () => ({ id: 'fixture-queue' })), dispatch: jest.fn(async () => false) }));
const { loadConfig } = require('../../src/services/images/config');
const { createComfyClient } = require('../../src/services/images/comfyClient');
const queue = require('../../src/services/images/workQueue');
const service = require('../../src/services/images/imageService');
const ImageOperation = require('../../models/ImageOperation');
const Conversation = require('../../models/Conversation');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { hash, digest } = require('../../src/services/images/expertReferences');
let directory;
const bytes = value => PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, value) });
beforeEach(async () => {
  jest.clearAllMocks(); await Conversation.deleteMany({}); await ImageOperation.createCollection(); await ImageOperation.deleteMany({});
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-inspection-render-')); process.env.IMAGE_ARCHIVE_DIR = directory;
  loadConfig.mockReturnValue({ workerUrl: 'http://fixture.invalid', ollamaHosts: [], defaultProfile: 'quick',
    profiles: { quick: { family: 'klein', steps: 4, maxPixels: 4194304 } } });
  createComfyClient.mockReturnValue({ ready: jest.fn(async () => ({})) });
});
afterEach(async () => { delete process.env.IMAGE_ARCHIVE_DIR; await fs.rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const conversations = forSurface('image-workshop'), sessionId = randomUUID(), turnId = randomUUID(), requestId = randomUUID();
  await conversations.createSession({ sessionId, packId: 'atelier', scopeId: 'workspace', modeId: 'imagex' });
  const originals = [bytes(12), bytes(54)];
  const references = originals.map((source, position) => ({ kind: 'upload', attachmentId: String(position + 1).repeat(24),
    sha256: hash(source), position, mimeType: 'image/png', byteLength: source.length, width: 2, height: 2 }));
  const nativeReceipt = { source: 'openclaw', mode: 'agent', requestId, runId: 'fixture-run', completion: 'completed', requested: { agentId: 'main' } };
  await conversations.recordTurn({ sessionId, packId: 'atelier', scopeId: 'workspace', traceId: turnId, source: 'imagex-hermes', modeId: 'plan',
    outcome: 'completed', inputText: 'Synthetic request', replyText: 'Synthetic proposal', toolEvidence: { imagex: {
      context: { references, inspectReferences: true }, proposal: { prompt: 'A lake', profile: 'quick', width: 1024, height: 1024 },
      inspection: { state: 'completed', requestId, nativeReceipt, references, referenceSha256: digest(references) } } } });
  return { body: { actionKey: randomUUID(), prompt: 'A lake', seed: 42, expert: { sessionId, turnId }, referenceSelection: references,
    references: originals.map(value => value.toString('base64')) }, references };
}
test('mismatched inspected selection refuses before archive retention, worker readiness and queue enrollment', async () => {
  const f = await fixture();
  for (const body of [{ ...f.body, referenceSelection: [...f.references].reverse() },
    { ...f.body, references: [...f.body.references].reverse() }, { ...f.body, referenceSelection: undefined }]) {
    await expect(service.accept(body)).rejects.toMatchObject({ statusCode: 409 });
  }
  expect(createComfyClient).not.toHaveBeenCalled(); expect(queue.enroll).not.toHaveBeenCalled();
  expect(await fs.readdir(directory)).toEqual([]); expect(await ImageOperation.countDocuments()).toBe(0);
});
test('matching bytes retain inspection provenance, while an exact replay needs no source files or worker', async () => {
  const f = await fixture(), accepted = await service.accept(f.body);
  expect(accepted.expert.referenceInspection.references).toEqual(f.references);
  expect(accepted.expert.referenceInspection.nativeReceipt.runId).toBe('fixture-run');
  const stored = await ImageOperation.findById(accepted.id).select('+referenceStorage').lean();
  expect(stored.referenceStorage.entries.map(row => row.source.sha256)).toEqual(f.references.map(row => row.sha256));
  await fs.rm(directory, { recursive: true, force: true }); await fs.mkdir(directory);
  createComfyClient.mockClear(); queue.enroll.mockClear();
  expect((await service.accept(f.body)).id).toBe(accepted.id);
  expect(createComfyClient).not.toHaveBeenCalled(); expect(queue.enroll).not.toHaveBeenCalled();
  await expect(service.accept({ ...f.body, referenceSelection: [...f.references].reverse() })).rejects.toMatchObject({ statusCode: 409 });
});
