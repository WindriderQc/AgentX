'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { PNG } = require('pngjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Conversation = require('../../models/Conversation');
const Attachment = require('../../models/ConversationAttachment');
const ImageOperation = require('../../models/ImageOperation');
const { createService } = require('../../src/services/images/expertService');
const { createResolver, hash } = require('../../src/services/images/expertReferences');
const provenance = require('../../src/services/images/expertProvenance');
const { analyzeImages } = require('../../src/services/imageAnalysisService');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createImageArchive } = require('../../src/services/imageArchive');
const context = { prompt: 'A lake', profile: 'quick', width: 1024, height: 1024, referenceCount: 1 };
const proposal = { prompt: 'A lake at dawn', profile: 'quick', width: 1024, height: 1024, reason: 'Keep composition.' };
const imageService = { status: () => ({ configured: true, profiles: [{ id: 'quick', maxPixels: 1048576 }] }) };
const workshop = { overview: async () => ({ profiles: [{ id: 'quick', maxPixels: 1048576 }] }) };
const png = value => PNG.sync.write({ width: 2, height: 2, data: Buffer.alloc(16, value) });
const completed = (requestId, text = 'A blue lake. Text could be uncertain.') => ({ text,
  nativeReceipt: { source: 'openclaw', mode: 'agent', requestId, runId: 'synthetic-native-run', requested: { agentId: 'main' }, completion: 'completed' } });
const settle = async (service, id) => {
  for (let i = 0; i < 100; i++) {
    const rows = await service.turns(id);
    if (!rows.some(row => ['accepted', 'running'].includes(row.state))) return rows;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture did not settle');
};
async function fixture(overrides = {}) {
  const bridge = { configured: () => true, invoke: jest.fn(async () => ({ proposal, text: proposal.reason, model: 'configured-fixture' })) };
  const resolver = createResolver();
  const references = Object.fromEntries(Object.entries(resolver).map(([key, value]) => [key, jest.fn(value)]));
  const analyze = jest.fn(async input => completed(input.requestId));
  const service = createService({ bridge, workshop, imageService, references, analyze, ...overrides });
  const session = await service.createSession();
  const bytes = png(32);
  const reference = await service.uploadReference(session.sessionId, { kind: 'upload', name: 'working-copy.png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64') });
  const input = { clientTurnId: randomUUID(), mode: 'plan', message: 'Keep the composition',
    context: { ...context, inspectReferences: true, references: [reference] } };
  return { service, session, input, reference, bytes, bridge, analyze, references };
}
beforeEach(async () => { await Conversation.deleteMany({}); await Attachment.deleteMany({}); await ImageOperation.createCollection(); await ImageOperation.deleteMany({}); });

test('exact selected pixels reach only native Main after a durable fence, while Hermes receives bounded verified evidence', async () => {
  let captured;
  const analyze = jest.fn(async input => {
    const conversations = forSurface('image-workshop');
    const session = await conversations.getSession({ sessionId: input.sessionId, packId: 'atelier', scopeId: 'workspace' });
    const turn = await conversations.getTurn({ sessionId: input.sessionId, traceId: session.imageInspection.turnId, packId: 'atelier', scopeId: 'workspace' });
    expect(session.imageInspection).toMatchObject({ requestId: input.requestId, state: 'unknown' });
    expect(turn.toolEvidence.imagex.inspection.state).toBe('running');
    return analyzeImages({ ...input, runtimeServices: { inference: { execute: async (request, options) => {
      captured = { request, options };
      const result = completed(request.requestId);
      return { ok: true, body: { message: { content: result.text }, executionReceipt: result.nativeReceipt } };
    } } } });
  });
  const f = await fixture({ analyze });
  const longBrief = 'Complete original brief. '.repeat(420) + 'BRIEF_TERMINAL_SENTINEL';
  f.input.context.prompt = longBrief;
  await f.service.accept(f.session.sessionId, f.input);
  const [turn] = await settle(f.service, f.session.sessionId);
  expect(turn).toMatchObject({ state: 'completed', inspection: { state: 'completed', references: [f.reference], nativeReceipt: { runId: 'synthetic-native-run' } } });
  expect(turn.context.prompt).toBe(longBrief);
  expect(captured.request.execution).toEqual({ source: 'openclaw', mode: 'agent', agentId: 'main' });
  expect(captured.request.messages[1].content[1].source.data).toBe(f.bytes.toString('base64'));
  expect(captured.request.messages[1].content[0].text).toContain(longBrief);
  expect(captured.request.tools).toBeUndefined(); expect(captured.request.options).toBeUndefined();
  expect(captured.options.consumerContract).toBe('atelier-reference-inspection-v1');
  const envelope = f.bridge.invoke.mock.calls[0][0];
  expect(envelope.request.prompt).toBe(longBrief); expect(envelope.referenceInspection.analysis).toContain('blue lake');
  expect(JSON.stringify(envelope)).not.toContain(f.bytes.toString('base64'));
  expect(JSON.stringify(envelope)).not.toContain('data:image');
  const row = await Conversation.findOne({ 'surfaceSession.sessionId': f.session.sessionId }).lean();
  expect(row.messages[0].attachments[0].id.toString()).toBe(f.reference.attachmentId);
  expect(row.surfaceSession.imageInspection).toBeUndefined();
  const calls = f.references.resolve.mock.calls.length;
  await f.service.accept(f.session.sessionId, f.input);
  expect(analyze).toHaveBeenCalledTimes(1); expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
  expect(f.references.resolve.mock.calls.length).toBe(calls); // Replay does not reread archives.
  const restarted = createService({ bridge: f.bridge, workshop, imageService, analyze });
  expect((await restarted.turns(f.session.sessionId))[0].inspection).toEqual(turn.inspection);
  const expert = { sessionId: f.session.sessionId, turnId: f.input.clientTurnId };
  const verified = await provenance.resolve(expert, { ...context, prompt: proposal.prompt }, 'quick', { selection: [f.reference], originals: [f.bytes] });
  expect(verified.referenceInspection.references).toEqual([f.reference]);
  expect(new ImageOperation({ _id: randomUUID(), actionKey: randomUUID(), requestHash: 'a', profile: {}, request: {}, state: 'queued', expert: verified }).toObject().expert.referenceInspection).toEqual(verified.referenceInspection);
  await expect(provenance.resolve(expert, context, 'quick', { selection: [f.reference], originals: [png(64)] })).rejects.toMatchObject({ statusCode: 409 });
  await expect(provenance.resolve(expert, context, 'quick')).rejects.toMatchObject({ statusCode: 409 });
});

test('unknown native response remains fenced across restart and history growth; explicit text advice does not inspect', async () => {
  const analyze = jest.fn(async () => { throw Object.assign(new Error('Lost native response'), { executionState: 'unknown' }); });
  const f = await fixture({ analyze });
  await f.service.accept(f.session.sessionId, f.input);
  expect((await settle(f.service, f.session.sessionId))[0]).toMatchObject({ state: 'unknown', inspection: { state: 'unknown', executionState: 'unknown' } });
  const restarted = createService({ bridge: f.bridge, workshop, imageService, analyze });
  expect((await restarted.accept(f.session.sessionId, f.input)).state).toBe('unknown');
  await expect(restarted.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
  expect(analyze).toHaveBeenCalledTimes(1); expect(f.bridge.invoke).not.toHaveBeenCalled();
  const conversations = forSurface('image-workshop');
  for (let i = 0; i < 51; i++) await conversations.recordTurn({ sessionId: f.session.sessionId, packId: 'atelier', scopeId: 'workspace',
    traceId: randomUUID(), modeId: 'consult', outcome: 'failed', inputText: 'Synthetic history', replyText: '' });
  await expect(restarted.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
  await restarted.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID(), context: { ...context, inspectReferences: false } });
  await settle(restarted, f.session.sessionId);
  expect(analyze).toHaveBeenCalledTimes(1); expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
  expect(f.bridge.invoke.mock.calls[0][0].referenceInspection).toBeUndefined();
  expect((await conversations.getSession({ sessionId: f.session.sessionId })).imageInspection.state).toBe('unknown');
});

test('cancellation with a lost response is unknown; late verified completion stays recorded and never starts Hermes', async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const analyze = jest.fn(input => { entered(); return new Promise(resolve => { finish = () => resolve(completed(input.requestId)); }); });
  const f = await fixture({ analyze });
  await f.service.accept(f.session.sessionId, f.input); await started;
  expect(await f.service.cancel(f.session.sessionId, f.input.clientTurnId)).toEqual({ requested: true });
  finish();
  const [turn] = await settle(f.service, f.session.sessionId);
  expect(turn).toMatchObject({ state: 'cancelled', inspection: { state: 'completed', nativeReceipt: { completion: 'completed' } } });
  expect(turn.inspection).not.toHaveProperty('released'); expect(f.bridge.invoke).not.toHaveBeenCalled();
  await f.service.accept(f.session.sessionId, f.input); expect(analyze).toHaveBeenCalledTimes(1);
});

test('restart during native observation retains unknown identity and refuses a replacement', async () => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const analyze = jest.fn(() => { entered(); return new Promise((_resolve, reject) => { finish = reject; }); });
  const f = await fixture({ analyze }); await f.service.accept(f.session.sessionId, f.input); await started;
  const restarted = createService({ bridge: f.bridge, workshop, imageService, analyze });
  const [turn] = await restarted.turns(f.session.sessionId);
  expect(turn).toMatchObject({ state: 'unknown', inspection: { state: 'unknown', sessionKey: expect.stringContaining(turn.inspection.requestId) } });
  await expect(restarted.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
  finish(Object.assign(new Error('Lost response'), { executionState: 'unknown' })); await settle(f.service, f.session.sessionId);
  expect(analyze).toHaveBeenCalledTimes(1);
});

test('verified analysis overflow refuses reasoning without trimming the brief or discarding its completed receipt', async () => {
  const analyze = jest.fn(async input => completed(input.requestId, 'x'.repeat(16001)));
  const f = await fixture({ analyze }); await f.service.accept(f.session.sessionId, f.input);
  const [turn] = await settle(f.service, f.session.sessionId);
  expect(turn).toMatchObject({ state: 'failed', context: { prompt: context.prompt }, inspection: { state: 'completed' }, error: expect.stringContaining('capacity') });
  expect(f.bridge.invoke).not.toHaveBeenCalled();
});

test('scoped verified attachments and original retention reject cross-session, corruption, reorder and private parents', async () => {
  const f = await fixture(); const other = await f.service.createSession();
  await expect(f.service.resolveReferences(other.sessionId, [f.reference])).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.service.resolveReferences(f.session.sessionId, [{ ...f.reference, sha256: 'f'.repeat(64) }])).rejects.toMatchObject({ statusCode: 409 });
  const second = await f.service.uploadReference(f.session.sessionId, { kind: 'sketch', name: 'sketch.png', dataUrl: 'data:image/png;base64,' + png(90).toString('base64') });
  await expect(f.service.resolveReferences(f.session.sessionId, [second, f.reference])).rejects.toMatchObject({ statusCode: 400 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-inspection-original-'));
  const archive = createImageArchive({ dir });
  const factory = scope => {
    const store = require('../../src/services/conversationAttachmentService').forConversation(scope);
    return { ...store, downloadVerified: (id, options) => store.downloadVerified(id, options, archive), attachOriginal: (id, input) => store.attachOriginal(id, input, archive) };
  };
  const resolver = createResolver({ attachmentFactory: factory });
  try {
    await resolver.original(f.session.sessionId, f.reference.attachmentId, png(91), 'original.png');
    const resolved = await resolver.resolve(f.session.sessionId, [f.reference]);
    expect(resolved.references[0]).toMatchObject({ sha256: hash(f.bytes), original: { sha256: hash(png(91)) }, transform: 'browser-working-copy-v1' });
    expect(JSON.stringify(resolved.references)).not.toContain(dir); expect(resolved.references[0].original).not.toHaveProperty('path');
    await expect(resolver.original(f.session.sessionId, f.reference.attachmentId, png(92), 'replacement.png')).rejects.toMatchObject({ statusCode: 409 });
    const id = randomUUID();
    await ImageOperation.create({ _id: id, actionKey: id, requestHash: id, state: 'completed', runtimeRestored: true,
      artifact: { sha256: hash(f.bytes) }, profile: { family: 'qwen' }, request: {}, conversation: { surface: 'household', sessionId: randomUUID(), packId: 'private', scopeId: 'private' } });
    await expect(resolver.resolve(f.session.sessionId, [{ kind: 'parent', operationId: id, sha256: hash(f.bytes) }])).rejects.toMatchObject({ statusCode: 404 });
    // Default resolver requires the configured archive for an original; use the injected archive here.
    await Attachment.updateOne({ _id: f.reference.attachmentId }, { $set: { data: png(100) } });
    await expect(resolver.resolve(f.session.sessionId, [f.reference])).rejects.toMatchObject({ statusCode: 503 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('aggregate image capacity refuses before acceptance and a native pre-dispatch refusal permits a fresh explicit action', async () => {
  const f = await fixture();
  const large = PNG.sync.write({ width: 650, height: 650, data: randomBytes(650 * 650 * 4) }, { deflateLevel: 0 });
  expect(large.length).toBeGreaterThan(3 * 1024 * 1024 / 2);
  expect(large.length).toBeLessThan(2 * 1024 * 1024);
  const first = await f.service.uploadReference(f.session.sessionId, { kind: 'upload', name: 'first.png', dataUrl: 'data:image/png;base64,' + large.toString('base64') });
  const second = await f.service.uploadReference(f.session.sessionId, { kind: 'sketch', name: 'second.png', dataUrl: 'data:image/png;base64,' + large.toString('base64') });
  await expect(f.service.accept(f.session.sessionId, { ...f.input, context: { ...context, referenceCount: 2, inspectReferences: true, references: [first, second] } }))
    .rejects.toMatchObject({ statusCode: 413 });
  expect(await f.service.turns(f.session.sessionId)).toEqual([]); expect(f.analyze).not.toHaveBeenCalled(); expect(f.bridge.invoke).not.toHaveBeenCalled();
  f.analyze.mockRejectedValueOnce(Object.assign(new Error('Native admission refused'), { executionState: 'not-dispatched' }));
  await f.service.accept(f.session.sessionId, f.input);
  expect((await settle(f.service, f.session.sessionId))[0]).toMatchObject({ state: 'failed', inspection: { state: 'failed', executionState: 'not-dispatched' } });
  await f.service.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() }); await settle(f.service, f.session.sessionId);
  expect(f.analyze).toHaveBeenCalledTimes(2); expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
});

test('equal-count replacement and reordering refuse applying persisted inspected reference identities', async () => {
  const f = await fixture();
  const secondBytes = png(57);
  const second = await f.service.uploadReference(f.session.sessionId, { kind: 'upload', name: 'second.png', dataUrl: 'data:image/png;base64,' + secondBytes.toString('base64') });
  const selected = [f.reference, second];
  f.input.context = { ...context, referenceCount: 2, inspectReferences: true, references: selected };
  await f.service.accept(f.session.sessionId, f.input); await settle(f.service, f.session.sessionId);
  const expert = { sessionId: f.session.sessionId, turnId: f.input.clientTurnId };
  expect(await provenance.resolve(expert, context, 'quick', { selection: selected, originals: [f.bytes, secondBytes] })).toHaveProperty('referenceInspection');
  await expect(provenance.resolve(expert, context, 'quick', { selection: [second, f.reference], originals: [secondBytes, f.bytes] })).rejects.toMatchObject({ statusCode: 409 });
  await expect(provenance.resolve(expert, context, 'quick', { selection: selected, originals: [secondBytes, f.bytes] })).rejects.toMatchObject({ statusCode: 409 });
});

test('native evidence compatibility refuses before Main dispatch when the installed worker is older', async () => {
  const f = await fixture(); f.bridge.supportsReferenceInspection = jest.fn(async () => false);
  await expect(f.service.accept(f.session.sessionId, f.input)).rejects.toMatchObject({ statusCode: 503 });
  expect(await f.service.turns(f.session.sessionId)).toEqual([]); expect(f.analyze).not.toHaveBeenCalled();
  const status = await f.service.status(); expect(status.referenceInspection).toMatchObject({ supported: true, available: false });
});

test('production parser ordering accepts bounded reference uploads and raw originals without widening text consultation bodies', async () => {
  const express = require('express'), request = require('supertest');
  const f = await fixture(), app = express();
  require('../../src/middleware/productRequestParsers')(app, express);
  app.use('/api/images/expert', require('../../routes/image-expert').createRouter(f.service));
  const prefix = `/api/images/expert/sessions/${f.session.sessionId}/references`;
  const original = PNG.sync.write({ width: 650, height: 650, data: randomBytes(650 * 650 * 4) }, { deflateLevel: 0 });
  const uploaded = await request(app).post(prefix).send({ kind: 'upload', name: 'bounded.png', dataUrl: 'data:image/png;base64,' + original.toString('base64') });
  expect(uploaded.status).toBe(201); expect(uploaded.body.reference.byteLength).toBe(original.length);
  const downloaded = await request(app).get(`${prefix}/${uploaded.body.reference.attachmentId}`);
  expect(downloaded.status).toBe(200); expect(downloaded.body).toEqual(original);
  const wrongScope = await f.service.createSession();
  expect((await request(app).get(`/api/images/expert/sessions/${wrongScope.sessionId}/references/${uploaded.body.reference.attachmentId}`)).status).toBe(404);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-inspection-http-'));
  const previous = process.env.IMAGE_ARCHIVE_DIR; process.env.IMAGE_ARCHIVE_DIR = dir;
  try {
    const response = await request(app).post(`${prefix}/${uploaded.body.reference.attachmentId}/original`)
      .set('Content-Type', 'image/png').set('X-Attachment-Name', encodeURIComponent('École.png')).send(original);
    expect(response.status).toBe(200); expect(response.body.original.sha256).toBe(hash(original));
    expect(JSON.stringify(response.body)).not.toContain(dir);
  } finally {
    if (previous === undefined) delete process.env.IMAGE_ARCHIVE_DIR; else process.env.IMAGE_ARCHIVE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
  const rejected = await request(app).post(`/api/images/expert/sessions/${f.session.sessionId}/turns`).send({ oversized: 'x'.repeat(530000) });
  expect(rejected.status).toBe(413); expect(f.analyze).not.toHaveBeenCalled();
});

test.each([false, true])('two Core service instances atomically admit only one inspection (same client identity: %s)', async sameIdentity => {
  let finish;
  const analyze = jest.fn(input => new Promise(resolve => { finish = () => resolve(completed(input.requestId)); }));
  const f = await fixture({ analyze });
  let count = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const resolver = createResolver();
  f.references.resolve.mockImplementation(async (...args) => {
    const resolved = await resolver.resolve(...args); if (++count === 2) release(); await gate; return resolved;
  });
  const second = createService({ bridge: f.bridge, workshop, imageService, references: f.references, analyze });
  const results = await Promise.allSettled([f.service.accept(f.session.sessionId, f.input),
    second.accept(f.session.sessionId, { ...f.input, clientTurnId: sameIdentity ? f.input.clientTurnId : randomUUID() })]);
  if (sameIdentity) {
    expect(results.every(row => row.status === 'fulfilled')).toBe(true);
    expect(results[0].value.id).toBe(results[1].value.id);
  } else {
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(row => row.status === 'rejected').reason.statusCode).toBe(409);
  }
  for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(analyze).toHaveBeenCalledTimes(1); finish();
  for (let i = 0; i < 100; i++) {
    const rows = await forSurface('image-workshop').listTurns({ sessionId: f.session.sessionId });
    if (rows[0]?.outcome === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const rows = await forSurface('image-workshop').listTurns({ sessionId: f.session.sessionId });
  expect(rows).toHaveLength(1); expect(rows[0].outcome).toBe('completed'); expect(f.bridge.invoke).toHaveBeenCalledTimes(1);
});

test('a late prior owner cannot clear a successor fence or dispatch after its prepared ownership was revoked', async () => {
  const conversations = forSurface('image-workshop');
  const f = await fixture(); const scope = { sessionId: f.session.sessionId, packId: 'atelier', scopeId: 'workspace' };
  const old = { turnId: randomUUID(), requestId: randomUUID(), state: 'prepared' };
  const successor = { turnId: randomUUID(), requestId: randomUUID(), state: 'unknown' };
  await conversations.updateSession(scope, { $set: { imageInspection: successor } });
  const lifecycle = require('../../src/services/images/expertInspection').createLifecycle({ conversations, analyze: f.analyze });
  expect(await lifecycle.clear(scope, old.turnId, old.requestId, 'prepared')).toBeNull();
  expect(await lifecycle.clear(scope, old.turnId, old.requestId, 'unknown')).toBeNull();
  await expect(lifecycle.run({ scope, turnId: old.turnId, inspection: old, messages: [], signal: new AbortController().signal, save: jest.fn() }))
    .rejects.toMatchObject({ executionState: 'not-dispatched' });
  expect(f.analyze).not.toHaveBeenCalled(); expect((await conversations.getSession(scope)).imageInspection).toEqual(successor);
});

test('failed inspection-stage persistence retains the native identity and prevents dispatch', async () => {
  const native = forSurface('image-workshop'); let refused = false;
  const conversations = { ...native, updateTurn: async (query, change) => {
    if (!refused && change.$set?.toolEvidence?.imagex?.inspection?.state === 'running') { refused = true; return null; }
    return native.updateTurn(query, change);
  } };
  const f = await fixture({ conversations }); await f.service.accept(f.session.sessionId, f.input);
  const [turn] = await settle(f.service, f.session.sessionId);
  expect(turn).toMatchObject({ state: 'unknown', inspection: { state: 'unknown', requestId: expect.any(String) } });
  expect(f.analyze).not.toHaveBeenCalled(); expect(f.bridge.invoke).not.toHaveBeenCalled();
  const scope = { sessionId: f.session.sessionId, packId: 'atelier', scopeId: 'workspace' };
  expect((await native.getSession(scope)).imageInspection.requestId).toBe(turn.inspection.requestId);
  expect((await f.service.accept(f.session.sessionId, f.input)).inspection.requestId).toBe(turn.inspection.requestId);
  await expect(f.service.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
});

test('a cancel acknowledgement with an unobserved native outcome remains unknown and never authorizes release or replacement', async () => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const analyze = jest.fn(input => new Promise((_resolve, reject) => {
    input.signal.addEventListener('abort', () => reject(Object.assign(new Error('Observation cancelled'), { executionState: 'unknown' })), { once: true });
    entered();
  }));
  const f = await fixture({ analyze }); await f.service.accept(f.session.sessionId, f.input); await started;
  expect(await f.service.cancel(f.session.sessionId, f.input.clientTurnId)).toEqual({ requested: true });
  const [turn] = await settle(f.service, f.session.sessionId);
  expect(turn).toMatchObject({ state: 'unknown', inspection: { state: 'unknown', executionState: 'unknown' } });
  expect(turn.inspection).not.toHaveProperty('nativeReceipt'); expect(turn.inspection).not.toHaveProperty('released');
  expect(f.bridge.invoke).not.toHaveBeenCalled();
  await expect(f.service.accept(f.session.sessionId, { ...f.input, clientTurnId: randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
  expect(analyze).toHaveBeenCalledTimes(1);
});
