'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jpeg = require('jpeg-js');
const { createConversationImages } = require('../conversation-images');
const { recentShown, contextText, editSize } = require('../shown-images');
const { createReplyChannels } = require('../reply-channels');
const { createVisuals, publicAddress } = require('../visuals');
const packs = require('../packs');

const opId = '44444444-4444-4444-8444-444444444444';
const family = { sessionId: 'family-session', packId: 'kidx_nestor', scopeId: 'family', status: 'active', agentId: 'family' };
const privateSession = { sessionId: 'private-session', packId: 'personal_operator', scopeId: 'personal', status: 'active', agentId: 'main' };
const picture = (title, url, source = 'web') => ({ id: 'b1', kind: 'image', source, title, body: title, status: 'found', image: { url } });
const photo = (width, height) => Buffer.from(jpeg.encode({ width, height, data: Buffer.alloc(width * height * 4, 180) }, 80).data);
// Newest turn first, as Core's turn listing returns them.
const turns = [
  { display: [{ id: 'b1', kind: 'text', body: 'note' }, picture('Renard roux', 'https://images.example.test/fox.jpg')] },
  { display: [picture('Introuvable', null), { ...picture('Chat', ''), status: 'missing' }] },
  { display: [picture('Cabane', '/api/voice-personas/family/visuals/file?source=photos&path=cabane.jpg', 'photos'),
    { id: 'b2', kind: 'image', source: 'local', title: 'Dragon', body: 'Un dragon', status: 'completed', operation: { id: opId } }] }
];

function fixture({ bytes = photo(1600, 900) } = {}) {
  const calls = [], events = [], reads = [];
  const service = {
    status: () => ({ configured: true, conversationProfile: { id: 'quick', width: 1024, height: 1024 } }),
    async accept(body, options) {
      calls.push({ body, options });
      if (body.width !== 1024 && body.height !== 1024 && body.profile === 'square-only') throw Object.assign(new Error('Resolution not qualified for this profile.'), { statusCode: 400 });
      return { id: opId, state: 'accepted', runtimeRestored: false };
    },
    async getForConversation() { return { id: opId, state: 'completed', artifact: { sha256: 'a'.repeat(64) } }; },
    async listForConversation() { return []; },
    image: async () => ({ bytes: photo(512, 512), mimeType: 'image/jpeg' })
  };
  const conversations = { listTurns: async () => turns };
  const visuals = { bytesFor: async (image, options) => { reads.push({ image, options }); return bytes; } };
  const images = createConversationImages({ conversations, service, visuals });
  const complete = (display, overrides = {}) => images.complete({ session: family, pack: packs.packById(family.packId), backend: 'hermes',
    display, turnId: 'synthetic-turn', signal: new AbortController().signal, onShow: block => events.push(block), ...overrides });
  return { service, calls, events, reads, images, complete };
}
const change = (from, body = 'Ajoute une moustache de shérif') => ({ id: 'b1', kind: 'image', source: 'draw', from, title: 'Shérif', body });

test('pictures on screen are numbered newest first, without missing ones', async () => {
  const shown = await recentShown({ conversations: { listTurns: async () => turns }, session: family });
  assert.deepEqual(shown.map(block => block.title), ['Renard roux', 'Dragon', 'Cabane']);
  const text = contextText(shown);
  assert.match(text, /1\. Renard roux \(Internet\)\n2\. Dragon \(local creation\)\n3\. Cabane \(family photo\)/);
  assert.match(text, /from="N"/);
  assert.equal(contextText([]), '');
});

test('a change edits the named picture, fitted, in its own shape', async () => {
  const { calls, events, reads, complete } = fixture();
  const display = [change(1)];
  await complete(display);
  assert.equal(calls.length, 1);
  const { body } = calls[0];
  assert.equal(body.references.length, 1);
  const reference = jpeg.decode(Buffer.from(body.references[0], 'base64'));
  assert.equal(Math.max(reference.width, reference.height), 1536, 'fitted to the reference limit');
  assert.match(body.prompt, /^Age-appropriate illustration for children\.\nEdit the reference image\./);
  assert.match(body.prompt, /moustache de shérif$/);
  assert.ok(body.width > body.height, 'a landscape picture stays landscape');
  assert.ok(body.width * body.height <= 1024 * 1024);
  assert.equal(reads[0].image.url, 'https://images.example.test/fox.jpg');
  assert.equal(reads[0].options.family, true);
  assert.equal(display[0].status, 'accepted'); assert.equal(display[0].from, undefined);
  assert.equal(events.length, 1);
});

test('a WebP, GIF or AVIF picture from the web is converted before the edit', async () => {
  const sharp = require('sharp');
  const raw = { raw: { width: 400, height: 200, channels: 3 } }, pixels = Buffer.alloc(400 * 200 * 3, 120);
  for (const format of ['webp', 'gif', 'avif']) {
    const { calls, events, complete } = fixture({ bytes: await sharp(pixels, raw)[format]().toBuffer() });
    await complete([change(1)]);
    assert.equal(calls.length, 1, format);
    const reference = jpeg.decode(Buffer.from(calls[0].body.references[0], 'base64'));
    assert.deepEqual([reference.width, reference.height], [400, 200], format);
    assert.equal(events[0].status, 'accepted', format);
  }
});

test('a local creation is read back from the image service', async () => {
  const { calls, reads, complete } = fixture();
  await complete([change(2)]);
  assert.equal(reads.length, 0);
  assert.equal(calls[0].body.width, 1024); assert.equal(calls[0].body.height, 1024);
});

test('an unknown number or an unusable picture fails with a clear card and no request', async () => {
  for (const [from, bytes] of [[9, undefined], [1, Buffer.from('<html>not a picture</html>')]]) {
    const { calls, events, complete } = fixture(bytes ? { bytes } : {});
    await complete([change(from)]);
    assert.equal(calls.length, 0);
    assert.equal(events[0].status, 'failed');
    assert.match(events[0].body, /cannot be used for a change/);
  }
});

test('OpenClaw keeps local_image for new images but edits a picture on screen through Core', async () => {
  const { calls, complete, images } = fixture();
  await complete([{ ...change(undefined), from: undefined }], { session: privateSession, backend: 'openclaw' });
  assert.equal(calls.length, 0, 'a new image stays with the native tool');
  await complete([change(1)], { session: privateSession, backend: 'openclaw' });
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].body.prompt, /children/);
  assert.match(images.contract(privateSession, 'openclaw'), /from="N"[\s\S]*Do not use local_image for such a change[\s\S]*local_image create once/);
  for (const session of [family, privateSession]) assert.match(images.contract(session, 'hermes'), /never ask for confirmation/);
});

test('a square-only profile still accepts the change in its preset', async () => {
  const f = fixture();
  f.service.status = () => ({ configured: true, conversationProfile: { id: 'square-only', width: 1024, height: 1024 } });
  await f.complete([change(1)]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual([f.calls[1].body.width, f.calls[1].body.height], [1024, 1024]);
});

test('output sizes keep the reference shape within the preset budget', () => {
  assert.deepEqual(editSize({ width: 1024, height: 1024 }, { width: 1536, height: 864 }), { width: 1344, height: 768 });
  assert.deepEqual(editSize({ width: 1024, height: 1024 }, { width: 100, height: 4000 }), { width: 704, height: 1440 });
});

test('the reply names a picture on screen only by a single digit', () => {
  const blocks = [];
  const channels = createReplyChannels({ onSay: () => {}, onShow: block => blocks.push(block) });
  channels.push('Je lui mets une moustache. <show kind="image" source="draw" from="1" title="Shérif">moustache</show>'
    + '<show kind="image" source="draw" from="https://x.test/a.jpg" title="Autre">chapeau</show>');
  channels.end();
  assert.equal(blocks[0].from, 1);
  assert.equal(blocks[1].from, undefined);
});

test('a web picture is read back only from a public address, never a redirect', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.2.99', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:192.168.1.1', '0.0.0.0'])
    assert.equal(publicAddress(address), false, address);
  for (const address of ['93.184.216.34', '2606:2800:220:1::1']) assert.equal(publicAddress(address), true, address);
  const fetches = [];
  const visuals = createVisuals({ env: {}, lookup: async host => [{ address: host === 'lan.example.test' ? '192.168.2.99' : '93.184.216.34' }],
    fetchImpl: async (url, options) => { fetches.push({ url, options }); return new Response(photo(8, 8), { headers: { 'content-type': 'image/jpeg' } }); } });
  await assert.rejects(visuals.bytesFor({ url: 'https://lan.example.test/a.jpg' }), /not public/);
  await assert.rejects(visuals.bytesFor({ url: 'https://192.168.2.99/a.jpg' }), /not public/);
  await assert.rejects(visuals.bytesFor({ url: 'http://images.example.test/a.jpg' }));
  await assert.rejects(visuals.bytesFor({ url: '/api/other/thing' }), /Unknown picture address/);
  assert.equal(fetches.length, 0);
  const bytes = await visuals.bytesFor({ url: 'https://images.example.test/a.jpg' });
  assert.ok(bytes.length > 0);
  assert.equal(fetches[0].options.redirect, 'error');
});
