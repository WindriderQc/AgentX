'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const atlas = path.join(__dirname, '..', 'public', 'atlas');
const entryId = 'c'.repeat(24), hash = 'd'.repeat(64);
const reply = data => ({ ok: true, json: async () => ({ status: 'success', data }) });

test('source text stays readable without treating photo APIs, Gmail or public URLs as owner files', async () => {
  const { readSource } = await import(path.join(atlas, 'data.js'));
  const original = global.fetch;
  try {
    const pointers = ['/api/photos/assets/synthetic-asset', 'gmail:synthetic-message', 'https://example.invalid/source.pdf', '//example.invalid/source.pdf'];
    for (const [n, nativePath] of pointers.entries()) {
      const requests = [], source = { id: `reference-${n}`, kind: 'media', metadataOnly: true, nativePath,
        body: '{"source":"exact retained metadata"}', bodySha256: hash, ...(n ? { contentSha256: hash } : {}) };
      global.fetch = async url => { requests.push(url); return reply({ source }); };
      const result = await readSource(`ctx|${entryId}|${source.id}`);
      assert.equal(requests.length, 1);assert.match(requests[0], /\/sources\//);
      assert.equal(result.body, source.body);assert.equal(result.bodySha256, source.bodySha256);
    }
  } finally { global.fetch = original; }
});

test('native documents and stored mail open with binary hashes; missing or malformed hashes retain the text', async () => {
  const { readSource } = await import(path.join(atlas, 'data.js'));
  const original = global.fetch;
  try {
    for (const [n, contentSha256] of [hash, hash, undefined, 'not-a-binary-hash'].entries()) {
      const requests = [], source = { id: `document-${n}`, kind: n === 1 ? 'mail' : 'document',
        nativePath: n === 1 ? '/owner/documents/synthetic.eml' : '/owner/documents/synthetic.pdf',
        body: 'Exact documentary passage.', bodySha256: hash, contentSha256 };
      global.fetch = async url => { requests.push(url); return reply(url.includes('/files/read?')
        ? { kind: 'document', url: '/api/secretary/files/content?locator=documents:synthetic.pdf', type: 'application/pdf', bytes: 12 }
        : { source }); };
      const result = await readSource(`ctx|${entryId}|${source.id}`);
      assert.equal(result.body, source.body);assert.equal(requests.length, n < 2 ? 2 : 1);
      if (n < 2) {
        const file = new URL(requests[1], 'http://atlas.test');
        assert.equal(file.searchParams.get('nativePath'), source.nativePath);assert.equal(file.searchParams.get('sha256'), hash);
        assert.match(result.fileUrl, /^\/api\/secretary\/files\/content\?/);
      } else assert.equal(result.fileUrl, undefined);
    }
  } finally { global.fetch = original; }
});

test('metadata-only album folders keep Core’s folder resolution without claiming a binary hash', async () => {
  const { readSource } = await import(path.join(atlas, 'data.js'));
  const original = global.fetch, requests = [];
  const source = { id: 'folder-reference', kind: 'media', metadataOnly: true, nativePath: '/owner/photos/synthetic-album', body: 'Folder metadata.', bodySha256: hash };
  try {
    global.fetch = async url => { requests.push(url); return reply(url.includes('/files/read?')
      ? { kind: 'folder', images: [{ name: 'synthetic.jpg', url: '/api/secretary/files/folder-image?locator=photos:synthetic-album' }] }
      : { source }); };
    const result = await readSource(`ctx|${entryId}|${source.id}`);
    assert.equal(requests.length, 2);assert.equal(new URL(requests[1], 'http://atlas.test').searchParams.get('sha256'), '');
    assert.equal(result.images.length, 1);assert.equal(result.body, source.body);
  } finally { global.fetch = original; }
});
