'use strict';
const ImageOperation = require('../../models/ImageOperation');
const images = require('../../src/services/images/imageService');
const { acceptedImageReply } = require('../../surfaces/household/accepted-images');

test('reading a native accepted receipt observes the exact Core action without restarting, cancelling or generating', async () => {
  const id = '33333333-3333-4333-8333-333333333333', actionKey = 'a'.repeat(64);
  await ImageOperation.create({ _id: id, actionKey, requestHash: 'b'.repeat(64), state: 'generating',
    profile: { id: 'synthetic', label: 'Synthetic proof' }, request: { prompt: 'Synthetic landscape' },
    workerSlot: 'synthetic-worker', dispatchStarted: true });
  const before = await ImageOperation.findById(id).select('+request').lean();
  expect((await images.getForAction(id, actionKey)).state).toBe('generating');
  await expect(images.getForAction(id, 'different-action')).rejects.toMatchObject({ statusCode: 404 });
  const session = { packId: 'personal_operator', scopeId: 'personal' }, sessionKey = 'synthetic-native-session', runId = 'synthetic-native-run';
  const receipt = { tool: 'local_image', observed: true, status: 'unknown', sessionKey, runId,
    provenance: { origin: 'owner_turn' }, imageOperation: { id, actionKey } };
  const reply = await acceptedImageReply({ session, sessionKey, runId, evidence: { receipts: [receipt] } });
  expect(reply.operations[0]).toMatchObject({ id, state: 'generating', studioPath: `/images?operation=${id}` });
  expect(reply.text).toContain('demande image est acceptée');
  expect(await ImageOperation.findById(id).select('+request').lean()).toEqual(before);
  await ImageOperation.updateOne({ _id: id }, { $set: { state: 'queued' } });
  for (const tool of ['local_image', 'imagex']) {
    const queued = await acceptedImageReply({ session, sessionKey, runId, evidence: { receipts: [{ ...receipt, tool }] } });
    expect(queued.text).toContain('demande image est en file');
    expect(queued.operations[0].id).toBe(id);
  }
  const artifact = { sha256: 'c'.repeat(64), mimeType: 'image/png', width: 1024, height: 1024, path: 'synthetic.png', size: 42 };
  await ImageOperation.updateOne({ _id: id }, { $set: { state: 'completed', runtimeRestored: true, artifact }, $unset: { workerSlot: 1 } });
  const later = await acceptedImageReply({ session, sessionKey, runId, evidence: { receipts: [receipt] } });
  expect(later.operations[0]).toMatchObject({ id, state: 'completed', artifact: { sha256: artifact.sha256 } });
  expect(later.text).toContain('image est prête');
});
