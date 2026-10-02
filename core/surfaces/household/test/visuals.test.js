'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { createVisuals, searchTerms, parseRoots } = require('../visuals');
const { createReplyChannels, storedDisplay, historyText, contract } = require('../reply-channels');

function mountBase() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'household-visuals-'));
  fs.mkdirSync(path.join(base, 'photos', 'Vacances 2024'), { recursive: true });
  fs.writeFileSync(path.join(base, 'photos', 'Vacances 2024', 'cabane.jpg'), 'jpeg-bytes');
  fs.writeFileSync(path.join(base, 'photos', 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(base, 'secret.jpg'), 'outside the root');
  return base;
}

const ENV = base => ({ SEARXNG_URL: 'http://searxng.example.test/', HOUSEHOLD_IMAGE_MOUNT_BASE: base,
  HOUSEHOLD_IMAGE_ROOTS_JSON: JSON.stringify({ photos: '/mnt/indexed/photos', media: '/mnt/indexed/media', other: '/x' }) });

function webFetch(results, calls = []) {
  return async url => { calls.push(new URL(url)); return { ok: true, json: async () => ({ results }) }; };
}

function dataFetch(files, calls = []) {
  return async (route, { query }) => {
    calls.push({ route, query: new URLSearchParams(query) });
    const search = new URLSearchParams(query).get('search');
    return { response: { ok: true }, body: { data: { files: files.filter(file => file.path.toLowerCase().includes(search.toLowerCase())) } } };
  };
}

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  Object.assign(res, { statusCode: 200, headers: {}, headersSent: false,
    status(code) { this.statusCode = code; return this; },
    set(headers) { Object.assign(this.headers, headers); return this; },
    json(body) { this.body = body; this.end(); return this; } });
  res.text = () => Buffer.concat(chunks).toString();
  return res;
}

async function served(visuals, query, family) {
  const res = response();
  const finished = new Promise(resolve => res.on('finish', resolve));
  visuals.sendFile({ query }, res, { family });
  await finished;
  return res;
}

test('only configured, mounted sources are offered, and Famille follows its own list', () => {
  const base = mountBase();
  assert.deepEqual(parseRoots('{"photos":"/a/b/","media":"relative","x":"/y"}'), { photos: '/a/b' });
  assert.deepEqual(createVisuals({ env: ENV(base) }).sources(), ['web', 'photos'], 'media is configured but not mounted');
  assert.deepEqual(createVisuals({ env: { ...ENV(base), HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'photos' } }).sources({ family: true }), ['photos']);
  assert.deepEqual(createVisuals({ env: {} }).sources(), []);
});

test('a web image is an https result from SearXNG, with strict SafeSearch in Famille', async () => {
  const calls = [];
  const visuals = createVisuals({ env: { SEARXNG_URL: 'http://searxng.example.test' },
    fetchImpl: webFetch([{ img_src: 'http://insecure.example.test/a.jpg' }, { img_src: 'javascript:alert(1)' },
      { img_src: 'https://images.example.test/giraffe.jpg', url: 'https://zoo.example.test/giraffe', title: 'Girafe' }], calls) });
  const block = { kind: 'image', source: 'web', title: 'Une girafe', body: 'girafe' };
  const shown = await visuals.present(block, { family: true, language: 'fr' });
  assert.equal(shown, block, 'the display entry itself is resolved');
  assert.equal(block.status, 'found');
  assert.deepEqual(block.image, { url: 'https://images.example.test/giraffe.jpg', origin: 'https://zoo.example.test/giraffe',
    originTitle: 'Girafe', sourceLabel: 'Internet' });
  assert.equal(calls[0].searchParams.get('categories'), 'images');
  assert.equal(calls[0].searchParams.get('safesearch'), '2');
  await visuals.present({ kind: 'image', source: 'web', body: 'girafe' }, { family: false });
  assert.equal(calls[1].searchParams.get('safesearch'), '1');
});

test('an unavailable source falls back to one that is, and a failed lookup shows nothing', async () => {
  const visuals = createVisuals({ env: { SEARXNG_URL: 'http://searxng.example.test' },
    fetchImpl: async () => { throw new Error('offline'); } });
  const block = { kind: 'image', source: 'photos', body: 'cabane' };
  await visuals.present(block);
  assert.equal(block.source, 'web');
  assert.equal(block.status, 'missing');
  assert.equal(block.image, null);
  const text = { kind: 'list', body: 'a' };
  assert.equal(await visuals.present(text), text, 'other blocks pass through untouched');
});

test('a household photo is found by name under its root and served only from the mount', async () => {
  const base = mountBase(), calls = [];
  const visuals = createVisuals({ env: ENV(base), dataFetch: dataFetch([
    { path: '/mnt/indexed/photos/Vacances 2024/cabane.mov' },
    { path: '/mnt/indexed/elsewhere/cabane.jpg' },
    { path: '/mnt/indexed/photos/../secret-cabane.jpg' },
    { path: '/mnt/indexed/photos/Vacances 2024/cabane.jpg' }
  ], calls) });
  const block = { kind: 'image', source: 'photos', title: 'La cabane', body: 'notre cabane dans l’arbre' };
  await visuals.present(block, { family: true });
  assert.equal(block.status, 'found');
  assert.equal(block.image.url, '/api/voice-personas/family/visuals/file?source=photos&path=Vacances+2024%2Fcabane.jpg');
  assert.equal(block.image.sourceLabel, 'Photos de la famille');
  assert.equal(calls[0].route, '/api/v1/storage/files/browse');
  assert.equal(calls[0].query.get('root'), '/mnt/indexed/photos');
  assert.equal(calls[0].query.get('includeDirname'), 'true');
  assert.deepEqual(calls.map(call => call.query.get('search')), ['notre cabane dans l’arbre', 'cabane']);

  const ok = await served(visuals, { source: 'photos', path: 'Vacances 2024/cabane.jpg' }, true);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.headers['Content-Type'], 'image/jpeg');
  assert.equal(ok.text(), 'jpeg-bytes');
  for (const query of [{ source: 'photos', path: '../secret.jpg' }, { source: 'photos', path: 'notes.txt' },
    { source: 'photos', path: '/etc/passwd.jpg' }, { source: 'media', path: 'x.jpg' }, { source: 'web', path: 'x.jpg' }]) {
    assert.equal((await served(visuals, query, false)).statusCode, 404, JSON.stringify(query));
  }
  const familyOff = createVisuals({ env: { ...ENV(base), HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'web' } });
  assert.equal((await served(familyOff, { source: 'photos', path: 'Vacances 2024/cabane.jpg' }, true)).statusCode, 404);
  assert.equal((await served(familyOff, { source: 'photos', path: 'Vacances 2024/cabane.jpg' }, false)).statusCode, 200);
});

test('a photo with a camera filename is found by its album folder', async () => {
  const base = mountBase();
  fs.mkdirSync(path.join(base, 'photos', 'Camping Riviere'), { recursive: true });
  fs.writeFileSync(path.join(base, 'photos', 'Camping Riviere', 'icon.gif'), 'gif-bytes');
  fs.writeFileSync(path.join(base, 'photos', 'Camping Riviere', 'IMG_0001.jpg'), 'jpeg-bytes');
  const calls = [];
  const visuals = createVisuals({ env: ENV(base), dataFetch: dataFetch([
    { path: '/mnt/indexed/photos/Camping Riviere/icon.gif', size: 10000 },
    { path: '/mnt/indexed/photos/Camping Riviere/IMG_0001.jpg', size: 350000 }
  ], calls) });
  const block = { kind: 'image', source: 'photos', body: 'Camping Riviere' };
  await visuals.present(block, { family: true });
  assert.equal(block.status, 'found');
  assert.equal(block.image.url,
    '/api/voice-personas/family/visuals/file?source=photos&path=Camping+Riviere%2FIMG_0001.jpg');
  assert.deepEqual(calls.map(call => call.query.get('search')), ['Camping Riviere']);
  assert.equal(calls[0].query.get('includeDirname'), 'true');
  const image = await served(visuals, { source: 'photos', path: 'Camping Riviere/IMG_0001.jpg' }, true);
  assert.equal(image.statusCode, 200);
});

test('search terms try the phrase, then its longest words', () => {
  assert.deepEqual(searchTerms('La cabane de papa'), ['La cabane de papa', 'cabane', 'papa']);
  assert.deepEqual(searchTerms(''), []);
});

test('an image block carries its source through the reply and into history', () => {
  const shown = [];
  const channels = createReplyChannels({ onShow: block => shown.push(block) });
  channels.push('Regarde! <show kind="image" source="WEB" title="Girafe">girafe au zoo</show> Elle est grande.');
  const { say, display } = channels.end();
  assert.equal(say, 'Regarde! Elle est grande.');
  assert.deepEqual(shown[0], { id: 'b1', kind: 'image', title: 'Girafe', body: 'girafe au zoo', source: 'web' });
  display[0].status = 'found';
  display[0].image = { url: 'https://images.example.test/g.jpg', origin: '', originTitle: '', sourceLabel: 'Internet' };
  const stored = storedDisplay(display);
  assert.equal(stored[0].image.url, 'https://images.example.test/g.jpg');
  assert.match(historyText(say, stored), /<show kind="image" source="web" title="Girafe">\ngirafe au zoo\n<\/show>$/);
  assert.match(historyText(say, [{ ...stored[0], status: 'missing' }]), /No image was found/);
});

test('the contract offers pictures only when a source is available', () => {
  assert.doesNotMatch(contract(), /kind="image"/);
  assert.match(contract({ family: true, imageSources: ['web', 'photos'] }), /kind="image" source="web\|photos"/);
  assert.match(contract({ imageSources: ['web'] }), /Never write a URL or a path/);
});

test('a generated picture cited by the harness is relayed from the gateway media route only', async () => {
  const env = { OPENCLAW_GATEWAY_URL: 'ws://gateway.example.test:18789', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' };
  const ref = '/home/example/.openclaw/media/tool-image-generation/mind.png';
  const calls = [];
  const visuals = createVisuals({ env, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response('png-bytes', { headers: { 'Content-Type': 'image/png' } });
  } });
  const block = { kind: 'image', source: 'generated', body: 'mind.png', ref };
  await visuals.present(block, { family: false });
  assert.equal(block.status, 'found');
  assert.equal(block.ref, undefined, 'the harness path is not stored beside the display entry');
  assert.equal(block.image.sourceLabel, 'Image générée');
  assert.equal(block.image.url, '/api/voice-personas/private/visuals/generated?path=' + encodeURIComponent(ref).replace(/%20/g, '+'));

  const res = response();
  await visuals.sendGenerated({ query: { path: ref } }, res, { family: false });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.text(), 'png-bytes');
  assert.equal(calls[0].url.href, 'http://gateway.example.test:18789/api/nestor/media?path=' + encodeURIComponent(ref));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');

  for (const bad of ['/etc/passwd.png', '/home/example/.openclaw/media/../secret.png', 'relative/media/a.png', '/home/example/.openclaw/media/voice.mp3']) {
    const refused = response();
    await visuals.sendGenerated({ query: { path: bad } }, refused, { family: false });
    assert.equal(refused.statusCode, 404, bad);
  }
  assert.equal(calls.length, 1, 'refused paths never reach the gateway');

  const html = createVisuals({ env, fetchImpl: async () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) });
  const notImage = response();
  await html.sendGenerated({ query: { path: ref } }, notImage, { family: false });
  assert.equal(notImage.statusCode, 404);

  const familyOff = createVisuals({ env: { ...env, HOUSEHOLD_IMAGE_FAMILY_SOURCES: 'web' } });
  const familyBlock = { kind: 'image', source: 'generated', body: 'mind.png', ref };
  await familyOff.present(familyBlock, { family: true });
  assert.equal(familyBlock.status, 'missing');
  const noGateway = { kind: 'image', source: 'generated', body: 'mind.png', ref };
  await createVisuals({ env: {} }).present(noGateway);
  assert.equal(noGateway.status, 'missing');
});
