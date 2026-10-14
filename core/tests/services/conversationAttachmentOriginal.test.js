'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const Attachment = require('../../models/ConversationAttachment');
const conversations = require('../../src/services/surfaceConversationService').forSurface('household');
const attachments = require('../../src/services/conversationAttachmentService');
const { createImageArchive } = require('../../src/services/imageArchive');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0WQAAAAASUVORK5CYII=';
const original = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(4096, 7)]);
const text = value => `data:text/plain;base64,${Buffer.from(value).toString('base64')}`;

describe('original of a reduced photo attachment', () => {
  let session, store, dir;
  beforeAll(async () => { await Attachment.createCollection(); await Attachment.createIndexes(); });
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-original-'));
    session = await conversations.createSession({ sessionId: randomUUID(), packId: 'personal_operator', modeId: 'personal', scopeId: 'personal' });
    store = attachments.forConversation({ surface: 'household', ...session });
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('archives the original and records its receipt on the attachment the model receives', async () => {
    const sent = await store.upload({ name: 'photo.png', dataUrl: `data:image/png;base64,${png}` });
    const result = await store.attachOriginal(sent.id, { bytes: original, name: 'IMG_0042.jpg' }, createImageArchive({ dir }));
    expect(result).toMatchObject({ id: sent.id, original: { mimeType: 'image/jpeg', size: original.length } });
    const row = await Attachment.findById(sent.id).lean();
    expect(row.original.path).toMatch(/^uploaded\/\d{4}\/\d{2}\/[a-f0-9]{64}\.jpg$/);
    expect(fs.readFileSync(path.join(dir, ...row.original.path.split('/'))).equals(original)).toBe(true);
    expect(Buffer.from(row.data.buffer || row.data).toString('base64')).toBe(png);
    expect((await store.references([sent.id]))[0].original.sha256).toBe(row.original.sha256);
  });

  test('refuses a document, and answers not found when the instance keeps no archive', async () => {
    const document = await store.upload({ name: 'note.txt', dataUrl: text('Synthetic note') });
    await expect(store.attachOriginal(document.id, { bytes: original }, createImageArchive({ dir })))
      .rejects.toMatchObject({ statusCode: 400 });
    const image = await store.upload({ name: 'photo.png', dataUrl: `data:image/png;base64,${png}` });
    await expect(store.attachOriginal(image.id, { bytes: original }, createImageArchive({ dir: '' })))
      .rejects.toMatchObject({ statusCode: 404 });
  });
  test.each([false, true])('concurrent native writers preserve one original binding (same bytes: %s)', async sameBytes => {
    const sent = await store.upload({ name: 'photo.png', dataUrl: `data:image/png;base64,${png}` });
    const second = attachments.forConversation({ surface: 'household', ...session });
    const nativeArchive = createImageArchive({ dir });
    let ready = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const archive = { ...nativeArchive, store: async input => {
      const receipt = await nativeArchive.store(input);
      if (++ready === 2) release();
      await gate; return receipt;
    } };
    const other = sameBytes ? original : Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.alloc(4096, 9)]);
    const results = await Promise.allSettled([store.attachOriginal(sent.id, { bytes: original }, archive),
      second.attachOriginal(sent.id, { bytes: other }, archive)]);
    const successes = results.filter(result => result.status === 'fulfilled');
    expect(successes).toHaveLength(sameBytes ? 2 : 1);
    if (!sameBytes) expect(results.find(result => result.status === 'rejected').reason.statusCode).toBe(409);
    const row = await Attachment.findById(sent.id).lean();
    expect(row.original.sha256).toBe(successes[0].value.original.sha256);
    const loaded = await nativeArchive.read(row.original);
    expect(createHash('sha256').update(loaded.bytes).digest('hex')).toBe(row.original.sha256);
    expect(Buffer.from(row.data.buffer || row.data).toString('base64')).toBe(png);
    const repeated = await second.attachOriginal(sent.id, { bytes: loaded.bytes }, nativeArchive);
    expect(repeated.original.sha256).toBe(row.original.sha256);
  });

});
