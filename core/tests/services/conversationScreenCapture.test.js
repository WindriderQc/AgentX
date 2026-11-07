'use strict';
const { randomUUID } = require('node:crypto');
const express = require('express');
const Conversation = require('../../models/Conversation');
const Attachment = require('../../models/ConversationAttachment');
const conversations = require('../../src/services/surfaceConversationService').forSurface('household');
const attachments = require('../../src/services/conversationAttachmentService');
const service = require('../../src/services/conversationScreenCapture');
const { handleOwnerMcp } = require('../../src/services/mcpOwnerTools');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const call = args => handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'screen_capture', arguments: args } });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
let session, input, store, http;
beforeAll(async () => {
  await Attachment.createIndexes();
  const app = express(); app.use(express.json());
  require('../../surfaces/household/screen-capture-routes').registerScreenCaptureRoutes(app, {
    envelope: (res, data) => res.json({ data }), fail: (res, status, message, code) => res.status(status).json({ message, code })
  });
  http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await http?.close(); });
beforeEach(async () => {
  session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'personal', backend: 'hermes' });
  input = { action: 'request', sessionId: session.sessionId, requestId: randomUUID(), purpose: 'Explain this synthetic window.' };
  store = attachments.forConversation({ surface: 'household', ...session });
});
const endpoint = () => `/private/sessions/${session.sessionId}/screen-capture`;
const upload = () => store.upload({ name: 'synthetic-screen.png', dataUrl: 'data:image/png;base64,' + png });

test('tool request is nonblocking, replayable and visible only in its exact browser conversation', async () => {
  const listed = await handleOwnerMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(listed.result.tools.find(tool => tool.name === 'screen_capture').annotations.readOnlyHint).toBe(false);
  const [a, b] = await Promise.all([call(input), call(input)]);
  expect(a.result.isError).toBe(false);
  expect(b.result.structuredContent).toEqual(a.result.structuredContent);
  expect(a.result.structuredContent.request.status).toBe('awaiting_consent');
  expect(a.result.structuredContent.nextAction).toContain('do not wait or poll');
  expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(0);
  const result = await http.request.get(endpoint()).expect(200);
  expect(result.body.data.request.requestId).toBe(input.requestId);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect((await Conversation.findById(session.conversationId)).surfaceSession.screenCaptures).toHaveLength(1);
  expect((await call({ ...input, purpose: 'Changed intent' })).result.isError).toBe(true);
  expect((await call({ ...input, requestId: randomUUID() })).result.isError).toBe(true);
  expect((await call({ ...input, action: 'status', purpose: undefined })).result.structuredContent.request.status).toBe('awaiting_consent');
});

test('attachment resolution is scoped, durable and idempotent; the next ordinary turn gets the image', async () => {
  await call(input);
  const file = await upload();
  const body = { requestId: input.requestId, status: 'attached', attachmentId: file.id };
  const first = await http.request.post(endpoint()).send(body).expect(200);
  const retry = await http.request.post(endpoint()).send(body).expect(200);
  expect(retry.body).toEqual(first.body);
  expect(first.body.data.request.attachment).toEqual(file);
  expect(JSON.stringify(first.body)).not.toContain(png);
  expect((await service.read({ sessionId: session.sessionId })).request).toBeNull();
  await conversations.recordTurn({ ...session, traceId: randomUUID(), inputText: 'Look at this synthetic window.', replyText: 'Synthetic reply', attachments: [file] });
  const turns = await conversations.readTurns({ sessionId: session.sessionId });
  const prepared = await store.prepare([{ role: 'user', content: turns[0].inputText, attachments: turns[0].attachments }], 'agentx');
  expect(prepared[0].images).toEqual([png]);
  expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(1);
});

test('resolution cannot accept a different conversation image, a document or caller-selected scope', async () => {
  await call(input);
  const other = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', scopeId: 'personal', modeId: 'personal' });
  const foreign = await attachments.forConversation({ surface: 'household', ...other }).upload({ name: 'other.png', dataUrl: 'data:image/png;base64,' + png });
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'attached', attachmentId: foreign.id }).expect(404);
  const text = await store.upload({ name: 'text.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('Synthetic text').toString('base64') });
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'attached', attachmentId: text.id }).expect(400);
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'declined', scopeId: 'family' }).expect(400);
  await expect(service.read({ sessionId: other.sessionId, requestId: input.requestId })).rejects.toMatchObject({ statusCode: 404 });
  expect((await service.read(input)).request.status).toBe('awaiting_consent');
});

test('decline and expiry never attach an image or create a replacement request on retry', async () => {
  await call(input);
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'declined' }).expect(200);
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'declined' }).expect(200);
  expect((await call(input)).result.structuredContent.request.status).toBe('declined');
  input.requestId = randomUUID(); await call(input);
  await Conversation.updateOne({ _id: session.conversationId, 'surfaceSession.screenCaptures.requestId': input.requestId },
    { $set: { 'surfaceSession.screenCaptures.$.expiresAt': new Date(0) } });
  expect((await call(input)).result.structuredContent.request.status).toBe('expired');
  const file = await upload();
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'attached', attachmentId: file.id }).expect(409);
});

test.each([{ scopeId: 'family' }, { packId: 'kidx_nestor' }, { status: 'closed' }, { ephemeral: true }, { llmx: { enabled: true } }])('nonpersonal or unavailable scope is refused: %p', async change => {
  const update = Object.fromEntries(Object.entries(change).map(([key, value]) => ['surfaceSession.' + key, value]));
  await Conversation.updateOne({ _id: session.conversationId }, { $set: update });
  expect((await call(input)).result.structuredContent.error).toBe('SCREEN_CAPTURE_CONVERSATION_NOT_FOUND');
  await http.request.get(endpoint()).expect(404);
});

test('strict tool schema refuses extra authority, malformed identities and incomplete actions', async () => {
  for (const args of [{ ...input, consent: true }, { ...input, requestId: 'invalid' }, { ...input, purpose: undefined },
    { ...input, action: 'status' }, { ...input, action: 'capture' }]) expect((await call(args)).result.isError).toBe(true);
  expect((await service.read({ sessionId: session.sessionId })).request).toBeNull();
});

test('forget removes request content and bytes; late browser responses and tool retries cannot restore it', async () => {
  await call(input); const file = await upload();
  await conversations.deleteSession(session);
  await http.request.post(endpoint()).send({ requestId: input.requestId, status: 'attached', attachmentId: file.id }).expect(404);
  expect((await call(input)).result.isError).toBe(true);
  const row = await Conversation.findById(session.conversationId).lean();
  expect(row.surfaceSession.screenCaptures).toBeUndefined();
  expect(JSON.stringify(row)).not.toContain(input.purpose);
  expect(await Attachment.countDocuments({ conversationId: session.conversationId })).toBe(0);
});

test('tool guidance uses the bound personal session, excluding family and ephemeral context', () => {
  expect(service.contextFor(session)).toContain(session.sessionId);
  expect(service.contextFor({ ...session, scopeId: 'family' })).toBe('');
  expect(service.contextFor({ ...session, ephemeral: true })).toBe('');
});
