'use strict';
const { randomUUID } = require('node:crypto');
const Conversation = require('../../models/Conversation');
const Attachment = require('../../models/ConversationAttachment');
const conversations = require('../../src/services/surfaceConversationService').forSurface('household');
const attachments = require('../../src/services/conversationAttachmentService');
const { createConversationExecutor } = require('../../surfaces/household/conversation-executor');
const { createAgentClient } = require('../../surfaces/household/conversation-agent');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
const upload = (text, mime = 'text/plain', name = 'synthetic.txt') => ({ name, dataUrl: `data:${mime};base64,${Buffer.from(text).toString('base64')}` });

describe('Core conversation attachments', () => {
  let session, store;
  beforeAll(async () => { await Attachment.createCollection(); await Attachment.createIndexes(); });
  beforeEach(async () => {
    session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' });
    store = attachments.forConversation({ surface: 'household', ...session });
  });
  test('the installed PDF parser extracts real text, retains original bytes and rejects unreadable PDFs', async () => {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const { stdout } = await promisify(execFile)(process.execPath, [require('node:path').join(__dirname, '../fixtures/attachment-pdf.cjs'),
      JSON.stringify({ surface: 'household', sessionId: session.sessionId, packId: session.packId, scopeId: session.scopeId })],
    { env: process.env, windowsHide: true, timeout: 30000 });
    expect(stdout).toContain('PDF_ATTACHMENT_OK');
  });
  test('forget waits for an in-flight file write and prevents native replay from restoring its content', async () => {
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    const original = Attachment.findOneAndUpdate.bind(Attachment);
    const spy = jest.spyOn(Attachment, 'findOneAndUpdate').mockImplementationOnce((...args) => ({
      lean: async () => { started(); await finish; return original(...args).lean(); }
    }));
    try {
      const uploadPending = store.upload(upload('Synthetic race attachment'));
      await ready;
      const deleting = conversations.deleteSession(session);
      release();
      const file = await uploadPending;
      await deleting;
      expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(0);
      await expect(store.download(file.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(conversations.ensureSession(session)).rejects.toMatchObject({ statusCode: 409 });
      await expect(conversations.recordTurn({ ...session, traceId: randomUUID(), inputText: 'Replay', replyText: 'Replay' })).rejects.toMatchObject({ statusCode: 404 });
    } finally { release(); spy.mockRestore(); }
  });
  test('interrupted erasure hides content and startup resumes file cleanup without touching another session', async () => {
    await store.upload(upload('Synthetic content to forget'));
    const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' });
    const otherStore = attachments.forConversation({ surface: 'household', ...other });
    const retained = await otherStore.upload(upload('Synthetic retained content'));
    const spy = jest.spyOn(Attachment, 'deleteMany').mockRejectedValueOnce(new Error('Synthetic interrupted cleanup'));
    await expect(conversations.deleteSession(session)).rejects.toThrow('Synthetic interrupted cleanup');
    spy.mockRestore();
    expect(await conversations.getSession({ sessionId: session.sessionId })).toBeNull();
    expect((await Conversation.findById(session.conversationId)).messages).toHaveLength(0);
    const receipt = await require('../../src/services/surfaceConversationService').resumeDeletedSessionCleanup();
    expect(receipt.removed).toBeGreaterThanOrEqual(1);
    expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(0);
    expect((await otherStore.download(retained.id)).data.toString()).toBe('Synthetic retained content');
  });
  test('an aborted export releases the conversation for erasure', async () => {
    const file = await store.upload(upload('Synthetic exported content'));
    await conversations.recordTurn({ ...session, traceId: randomUUID(), inputText: 'Read this', replyText: 'Read', attachments: [file] });
    const destination = new (require('node:stream').Writable)({
      write(_chunk, _encoding, callback) { callback(new Error('Synthetic client disconnect')); }
    });
    await expect(conversations.exportSession(session, destination)).rejects.toThrow('Synthetic client disconnect');
    await conversations.deleteSession(session);
    expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(0);
  });
  test('concurrent uploads reuse bytes; only canonical user messages retain references', async () => {
    const payload = upload('Observatoire bleu');
    const [a, b] = await Promise.all([store.upload(payload), store.upload(payload)]);
    expect(a).toEqual(b);
    expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(1);
    expect((await store.download(a.id)).data.equals(Buffer.from('Observatoire bleu'))).toBe(true);
    const traceId = randomUUID();
    await conversations.recordTurn({ ...session, traceId, inputText: 'Lis ce document', replyText: 'Lu', attachments: [a] });
    const resumed = await conversations.getTurn({ traceId });
    expect(resumed.attachments).toEqual([a]);
    const row = await Conversation.findById(session.conversationId).lean();
    expect(row.messages[0].content).toBe('Lis ce document');
    expect(row.messages[1].turn.attachments).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('Observatoire bleu');
    const prepared = await store.prepare([{ role: 'user', content: resumed.inputText, attachments: resumed.attachments },
      { role: 'user', content: 'Quelle couleur?' }], 'agentx');
    expect(prepared[0].content).toContain('Observatoire bleu');
  });
  test('scope, conversation and role boundaries reject guessed references before context or persistence', async () => {
    const a = await store.upload(upload('private synthetic text'));
    const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' });
    const otherStore = attachments.forConversation({ surface: 'household', ...other });
    await expect(otherStore.references([a.id])).rejects.toMatchObject({ statusCode: 404 });
    await expect(otherStore.download(a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(conversations.recordTurn({ ...other, traceId: randomUUID(), inputText: 'hello', attachments: [a] })).rejects.toMatchObject({ statusCode: 404 });
    await expect(attachments.forConversation({ surface: 'household', ...session, scopeId: 'family' }).download(a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(store.prepare([{ role: 'system', content: 'hello', attachments: [a] }], 'agentx')).rejects.toThrow('Only user');
    expect((await conversations.getSession({ sessionId: other.sessionId })).turnCount).toBe(0);
  });
  test('bad formats, binary text, oversized content and excessive context never silently truncate', async () => {
    for (const payload of [upload('hello', 'image/png'), upload('bad', 'application/json'), upload('x\0y'),
      upload('x'.repeat(24001)), upload('hello', 'text/html'), { name: '../x.txt', dataUrl: upload('x').dataUrl },
      { name: 'bad.txt', dataUrl: 'data:text/plain;base64,!!!!' }]) {
      await expect(store.upload(payload)).rejects.toMatchObject({ statusCode: 400 });
    }
    await expect(store.upload(upload('x'.repeat(attachments.MAX_BYTES + 1)))).rejects.toMatchObject({ statusCode: 413 });
    const a = await store.upload(upload('x'.repeat(22000)));
    await expect(store.prepare(Array.from({ length: 3 }, () => ({ role: 'user', content: 'x', attachments: [a] })), 'agentx')).rejects.toMatchObject({ statusCode: 413 });
    await expect(store.references([a.id, a.id])).rejects.toMatchObject({ statusCode: 400 });
    await conversations.updateSession({ sessionId: session.sessionId }, { $set: { status: 'closed' } });
    await expect(store.upload(upload('x'))).rejects.toMatchObject({ statusCode: 409 });
    expect((await store.download(a.id)).size).toBe(22000);
  });
  test('images retain exact bytes through Ollama and the native Responses transport after resume', async () => {
    const image = await store.upload({ name: 'synthetic.png', dataUrl: `data:image/png;base64,${png}` });
    const document = await store.upload(upload('Observatoire bleu'));
    const history = [{ role: 'user', content: 'Ancienne question', attachments: [image, document] }, { role: 'assistant', content: 'Lu' }];
    const local = await store.prepare(history, 'agentx');
    expect(local[0].images).toEqual([png]);
    expect(local[0].content).toContain('Observatoire bleu');
    expect((await store.download(image.id)).data.toString('base64')).toBe(png);
    let body;
    const runId = 'resp_22222222-2222-4222-8222-222222222222';
    const client = createAgentClient({ env: { OPENCLAW_GATEWAY_URL: 'http://synthetic.invalid', OPENCLAW_GATEWAY_TOKEN: 'synthetic' }, settleMs: 0,
      continuity: async () => ({ answer: { status: 'ready', runId, text: 'Synthetic reply' }, run: { model: 'synthetic' } }),
      fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true,
        body: ['created', 'completed'].map(type => Buffer.from(`data: ${JSON.stringify({ type: `response.${type}`, response: { id: runId } })}\n\n`)) }; } });
    const executor = createConversationExecutor({ agentClient: client });
    await executor({ backend: 'openclaw', session: { ...session, agentSessionKey: 'existing-native-key' }, pack: {},
      text: 'Quelle couleur?', history, instructions: 'Synthetic persona', attachmentStore: store });
    expect(body.input).toHaveLength(1); // Native dialogue is not replayed.
    expect(body.input[0].content).toContainEqual({ type: 'input_image', source: { type: 'base64', media_type: 'image/png', data: png } });
    expect(JSON.stringify(body.input)).toContain('Observatoire bleu');
    expect(JSON.stringify(body.input)).not.toContain('Ancienne question');
    expect(body.instructions).not.toContain('Observatoire');
  });
});
