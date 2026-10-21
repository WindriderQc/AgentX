import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerPhotos, photoAudience } from '../photos.js';

const SESSION = '11111111-1111-1111-1111-111111111111';
const PHOTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const owner = { agentId: 'main', sessionKey: `agent:main:household:direct:${SESSION}` };
const child = { agentId: 'kidx', sessionKey: `agent:kidx:household:direct:${SESSION}` };
const config = { agents: { list: [{ id: 'main' }, { id: 'kidx' }] } };

function setup(respond) {
  let factory; let options; const calls = [];
  const api = { config, pluginConfig: { agentxUrl: 'http://core.test:3180', mediaRoot: null },
    registerTool(f, o) { factory = f; options = o; } };
  registerPhotos(api, { fetchImpl: async (url, init) => {
    calls.push({ url: new URL(String(url)), headers: init.headers });
    return respond(new URL(String(url)));
  } });
  return { factory, options, calls, api };
}

const ok = (data) => new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'content-type': 'application/json' } });

test('the audience comes from the host session: owner, family member, or no tool', () => {
  assert.equal(photoAudience(owner, config), 'owner');
  assert.equal(photoAudience(child, config), 'family');
  assert.equal(photoAudience({ ...child, sandboxed: true }, config), null);
  assert.equal(photoAudience({ agentId: 'stranger', sessionKey: `agent:stranger:household:direct:${SESSION}` }, config), null);
  assert.equal(photoAudience({ agentId: 'kidx', sessionKey: `agent:main:household:direct:${SESSION}` }, config), null);
  assert.equal(photoAudience({ agentId: 'main', sessionKey: 'agent:main:telegram:direct:42' }, config), null);
});

test('a child session always reads with audience=family, whatever the parameters say', async () => {
  const { factory, options, calls } = setup(() => ok({ query: 'plage', ranked: true, count: 0, items: [] }));
  assert.equal(options.name, 'nestor_photos');
  assert.equal(factory({ agentId: 'stranger', sessionKey: 'x' }), null);
  const tool = factory(child);
  assert.match(tool.description, /family conversation/);
  await tool.execute('call-1', { action: 'search', query: 'à la plage', person: 'Alice', year: '2025', audience: 'owner' });
  const url = calls[0].url;
  assert.equal(url.pathname, '/api/photos/search/smart');
  assert.equal(url.searchParams.get('q'), 'à la plage');
  assert.equal(url.searchParams.get('person'), 'Alice');
  assert.equal(url.searchParams.get('audience'), 'family');
  assert.equal(calls[0].headers['x-service-caller'], 'nestor-photos');
});

test('owner reads use the owner audience and the exact routes', async () => {
  const { factory, calls } = setup(() => ok({ total: 3, exact: true }));
  const tool = factory(owner);
  const counted = await tool.execute('c', { action: 'count', person: 'Alice' });
  assert.deepEqual(counted.details, { total: 3, exact: true });
  await tool.execute('s', { action: 'search', city: 'Sampleton', order: 'asc' });
  await tool.execute('d', { action: 'details', ids: [PHOTO] });
  await tool.execute('n', { action: 'names', kind: 'places' });
  assert.deepEqual(calls.map((call) => call.url.pathname), ['/api/photos/count', '/api/photos/search', `/api/photos/assets/${PHOTO}`, '/api/photos/places']);
  assert.equal(calls[0].url.searchParams.get('audience'), 'owner');
});

test('Core refusals reach the agent with their candidates', async () => {
  const { factory } = setup(() => new Response(JSON.stringify({ ok: false, code: 'PHOTOS_PERSON_AMBIGUOUS',
    error: { code: 'PHOTOS_PERSON_AMBIGUOUS', message: '"Jo" matches several named persons; ask which one',
      details: { candidates: ['Jo Example', 'Jo Sample'] } } }), { status: 409 }));
  await assert.rejects(factory(owner).execute('x', { action: 'search', person: 'Jo' }),
    /PHOTOS_PERSON_AMBIGUOUS: .*Candidates: Jo Example, Jo Sample/);
});

test('show copies previews into the media directory and attaches them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nestor-photos-'));
  try {
    const { factory, api, calls } = setup((url) => (url.pathname.endsWith('/thumbnail')
      ? new Response(Buffer.from('synthetic-webp'), { status: 200, headers: { 'content-type': 'image/webp' } })
      : ok({})));
    api.pluginConfig.mediaRoot = root;
    const result = await factory(child).execute('show', { action: 'show', ids: [PHOTO.toUpperCase()] });
    const file = path.join(root, 'photos', `${PHOTO}-preview.webp`);
    assert.deepEqual(result.details.shown, [{ id: PHOTO, mediaPath: file, deliveryHint: `Use MEDIA:${file} to present this photo.` }]);
    assert.equal(await readFile(file, 'utf8'), 'synthetic-webp');
    assert.equal(result.content[1].type, 'image');
    assert.equal(calls[0].url.searchParams.get('size'), 'preview');
    assert.equal(calls[0].url.searchParams.get('audience'), 'family');
    await assert.rejects(factory(owner).execute('bad', { action: 'show', ids: ['../etc/passwd'] }), /photo ids/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a photo the family may not see is reported, not attached', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nestor-photos-'));
  try {
    const { factory, api } = setup(() => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
    api.pluginConfig.mediaRoot = root;
    const result = await factory(child).execute('show', { action: 'show', ids: [PHOTO] });
    assert.deepEqual(result.details.shown, [{ id: PHOTO, error: 'not available' }]);
    assert.equal(result.content.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
