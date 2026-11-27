'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const { PNG } = require('pngjs');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const familyDevice = require('../../surfaces/household/family-device');
const { replyForTurn } = require('../../surfaces/household/family-picture-lookup');
const { createImmichClient } = require('../../src/services/photos/immichClient');
const { createPhotoFrameService } = require('../../src/services/photos/photoFrameService');
const { createPhotoRoutes } = require('../../routes/photos');

async function listen(app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => server.close(resolve)) };
}

// Only the Immich v3.3.3 fields consumed by these requests. Search items can
// omit tags, so the direct asset response remains necessary before delivery.
function providerFixture() {
  const album = randomUUID();
  const processingLibrary = randomUUID();
  const library = randomUUID();
  const assets = ['triangle', 'disque'].map(name => ({
    id: randomUUID(), libraryId: library, originalFileName: name + '.png',
    type: 'IMAGE', visibility: 'timeline', isOffline: false, isTrashed: false
  }));
  const members = new Set([assets[0].id]);
  const thumbnails = [];
  const errors = [];
  const png = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const color = x < 16 ? [20, 80, 140, 255] : [200, 60, 30, 255];
      png.data.set(color, (y * png.width + x) * 4);
    }
  }
  const bytes = PNG.sync.write(png);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    assert.equal(req.get('x-api-key'), 'fixture-key');
    next();
  });
  app.post('/api/search/metadata', (req, res) => {
    const { size, filter } = req.body;
    assert.equal(size, 1);
    assert.deepEqual(filter.albumIds, { any: [album] });
    assert.deepEqual(filter.type, { eq: 'IMAGE' });
    assert.deepEqual(filter.visibility, { eq: 'timeline' });
    assert.deepEqual(filter.isOffline, { eq: false });
    assert.deepEqual(filter.trashedAt, { eq: null });
    if (filter.originalFileName || filter.libraryId) assert.deepEqual(filter.libraryId, { ne: processingLibrary });
    const items = assets.filter(row => members.has(row.id) && (filter.id
      ? row.id === filter.id.eq : row.originalFileName.includes(filter.originalFileName.like)));
    res.json({ albums: { items: [] }, assets: { items, total: items.length, nextPage: null } });
  });
  app.get('/api/assets/:id', (req, res) => {
    const row = assets.find(row => row.id === req.params.id);
    if (!row) return res.sendStatus(404);
    res.json({ ...row, tags: [] });
  });
  app.get('/api/assets/:id/thumbnail', (req, res) => {
    assert.equal(req.query.size, 'preview');
    thumbnails.push(req.params.id);
    res.type('png').send(bytes);
  });
  app.use((error, req, res, next) => {
    errors.push(error.message);
    res.sendStatus(500);
  });
  return { app, album, processingLibrary, members, thumbnails, errors, approved: assets[0].id };
}

async function journey() {
  const fixture = providerFixture();
  const provider = await listen(fixture.app);
  let site, browser;
  try {
    const client = createImmichClient({ env: { IMMICH_URL: provider.url, IMMICH_API_KEY_FILE: 'fixture' },
      readFile: () => 'fixture-key' });
    const frame = createPhotoFrameService({ client, config: () => ({ conversationLookup: { enabled: true, albumId: fixture.album } }),
      processingConfig: () => ({ libraryId: fixture.processingLibrary }) });
    const app = express();
    const tokens = ['fixture-first-browser', 'fixture-second-browser'];
    const hashes = new Set(tokens.map(familyDevice.hashToken));
    const devices = { findOneAndUpdate: ({ tokenHash }) => ({ lean: async () => hashes.has(tokenHash) ? { tokenHash } : null }) };
    const session = { sessionId: 'fixture-session', packId: 'kidx_nestor', scopeId: 'family', status: 'active' };
    app.use(cookieParser());
    familyDevice.register({ app, mongoose: { models: { AgentXHouseholdFamilyDevice: devices } },
      ownerUnlock: { activeUntil: async () => null }, standardJsonParser: express.json(),
      fail: (res, status) => res.sendStatus(status) });
    app.use('/api/photos', createPhotoRoutes({ service: {}, frame,
      readAlbumSession: async id => id === session.sessionId ? session : null }));
    app.get('/assets/household/display-board.js', (req, res) => res.sendFile(path.resolve(__dirname, '../../surfaces/household/public/display-board.js')));
    app.get('/panel', (req, res) => res.send('<section id="text"></section><section id="visual"></section><script src="/assets/household/display-board.js"></script>'));
    app.post('/api/family/fixture-turn', express.json(), async (req, res, next) => {
      try {
        res.json(await replyForTurn(req.familyDevice, session.packId, session, { text: req.body.text, language: 'fr', turnId: 'fixture-turn', signal: new AbortController().signal,
          album: () => frame,
          visuals: { sources: () => { throw Error('Unexpected public search'); } } }));
      } catch (error) { next(error); }
    });
    site = await listen(app);
    browser = await chromium.launch({ headless: true, executablePath: process.env.AGENTX_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([{ name: familyDevice.COOKIE, value: tokens[0], url: site.url }]);
    const page = await context.newPage();
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    await page.goto(site.url + '/panel');
    const ask = async text => {
      const response = await context.request.post(site.url + '/api/family/fixture-turn', { data: { text } });
      assert.equal(response.status(), 200);
      return response.json();
    };
    const found = await ask('Montre-moi nos photos de triangle.');
    assert.equal(found.display.length, 1);
    const block = found.display[0];
    const receiptURL = new URL(block.image.url, site.url);
    assert.match(receiptURL.pathname, /^\/api\/photos\/frame\/album\/[A-Za-z0-9_-]{43}\/image$/);
    const render = () => page.evaluate(block => {
      const board = DisplayBoard.createScreen({ text: document.querySelector('#text'), visual: document.querySelector('#visual') }, { space: 'family' });
      if (!board.add(block)) throw Error('Photo card was declined');
    }, block);
    await render();
    const img = page.locator('#visual article figure img');
    await img.waitFor({ state: 'visible' });
    await img.evaluate(element => element.decode());
    // Compare rendered pixels in the actual screenshot, not only image dimensions.
    const shot = PNG.sync.read(await img.screenshot());
    for (const [fraction, expected] of [[0.25, [20, 80, 140]], [0.75, [200, 60, 30]]]) {
      const offset = (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width * fraction)) * 4;
      assert.deepEqual([...shot.data.subarray(offset, offset + 3)], expected);
    }
    const second = await browser.newContext();
    await second.addCookies([{ name: familyDevice.COOKIE, value: tokens[1], url: site.url }]);
    assert.equal((await second.request.get(receiptURL.href)).status(), 404);
    const missing = await ask('Retrouve une photo de disque dans nos photos.');
    assert.deepEqual(missing.display, []);
    assert.match(missing.text, /pas trouvé/);
    fixture.members.clear();
    // A fresh document must authorize the bytes again. A previously displayed
    // copy can remain in a renderer even after the album changes.
    await page.reload();
    const denied = page.waitForResponse(response => response.url() === receiptURL.href && response.status() === 404);
    await render();
    await denied;
    await page.getByText('Cette photo n’est plus disponible.', { exact: false }).waitFor();
    assert.equal(await page.locator('article img').count(), 0);
    assert.deepEqual(fixture.thumbnails, [fixture.approved]);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(browserErrors, []);
    console.log('PASS: matching display pixels, scoped browser receipt, out-of-album photo, revocation before reload, one authorized thumbnail');
  } finally {
    if (browser) await browser.close();
    if (site) await site.close();
    await provider.close();
  }
}
journey().catch(error => { console.error(error); process.exitCode = 1; });
