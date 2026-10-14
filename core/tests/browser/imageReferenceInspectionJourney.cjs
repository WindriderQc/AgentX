'use strict';
// Synthetic browser/HTTP fixture. No inference, image worker or host control exists here.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const core = path.resolve(__dirname, '../..'), tree = path.dirname(core), reportDir = process.env.ATELIER_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(tree + path.sep)) throw new Error('ATELIER_REPORT_DIR must be outside Git.');
fs.mkdirSync(reportDir, { recursive: true });
const req = createRequire(path.join(core, 'package.json'));
const express = req('express'), { PNG } = req('pngjs'), jpeg = req('jpeg-js');
const { chromium } = process.env.PLAYWRIGHT_MODULE_PATH ? require(process.env.PLAYWRIGHT_MODULE_PATH) : require('playwright');
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');
const image = color => { const png = new PNG({ width: 12, height: 12 }); png.data.fill(color); return PNG.sync.write(png); };
const parentBytes = image(120), uploadBytes = image(180), replacementBytes = image(210), parentId = randomUUID();
const profile = { id: 'quality', label: 'Synthetic recipe', maxPixels: 4194304, steps: 4, family: 'qwen21' };
const parent = { id: parentId, state: 'completed', runtimeRestored: true, profile: profile.id, label: profile.label,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', artifact: {
    sha256: checksum(parentBytes), width: 12, height: 12, url: `/api/images/operations/${parentId}/image` } };
const sessions = new Map(), attachments = new Map(), consultations = [], renders = [], errors = [], checks = [];
let inspectionState = 'completed', resolveGate = null, server, browser;
function resolveReferences(sessionId, selected) {
  assert.ok(sessions.has(sessionId));
  return selected.map((row, position) => {
    if (row.kind === 'parent') {
      assert.equal(row.operationId, parentId); assert.equal(row.sha256, parent.artifact.sha256);
      return { kind: 'parent', operationId: parentId, sha256: row.sha256, position,
        mimeType: 'image/png', byteLength: parentBytes.length, width: 12, height: 12 };
    }
    const stored = attachments.get(row.attachmentId);
    assert.equal(stored.sessionId, sessionId); assert.equal(stored.reference.sha256, row.sha256);
    return { ...stored.reference, position };
  });
}
async function settle(page) { await page.waitForFunction(() => !document.getElementById('imagex-plan').disabled); }
async function attachFile(page, bytes, name = 'fixture.png') {
  await page.locator('#image-references').setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
}
async function inspect(page) {
  await page.locator('#imagex-inspect-references').click();
  await page.waitForFunction(() => document.getElementById('imagex-notice').textContent.includes('Proposal ready'));
  await settle(page);
}
(async () => {
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(core, 'views'));
  app.locals.buildProductNavigation = req('../shared/productNavigation').buildProductNavigation;
  app.post('/api/images/expert/sessions/:id/references/:attachmentId/original', express.raw({ type: 'image/*', limit: '50mb' }), (request, response) => {
    const stored = attachments.get(request.params.attachmentId); assert.equal(stored.sessionId, request.params.id);
    stored.reference.original = { sha256: checksum(request.body), mimeType: request.get('Content-Type'), byteLength: request.body.length };
    stored.reference.transform = 'browser-working-copy-v1'; response.json({ ok: true, original: stored.reference.original });
  });
  app.use(express.json({ limit: '4mb' }));
  app.use('/api/images/expert', async (request, response) => {
    const { method, path: route, body } = request;
    if (route === '/status') return response.json({ ok: true, available: true, resources: [], routing: { model: 'synthetic', provider: 'fixture' } });
    if (route === '/sessions' && method === 'POST') {
      const session = { sessionId: randomUUID(), label: 'Synthetic discussion', createdAt: '2026-01-01T00:00:00Z', turns: [] };
      sessions.set(session.sessionId, session); return response.json({ ok: true, session });
    }
    if (route === '/sessions') return response.json({ ok: true, sessions: [...sessions.values()] });
    const match = route.match(/^\/sessions\/([^/]+)\/(references(?:\/resolve)?|turns)$/);
    if (!match) return response.status(404).json({ ok: false, message: 'Unknown synthetic endpoint' });
    const [, sessionId, action] = match; assert.ok(sessions.has(sessionId));
    if (action === 'references' && method === 'POST') {
      const data = /^data:(image\/(?:jpeg|png));base64,(.*)$/.exec(body.dataUrl); assert.ok(data);
      const bytes = Buffer.from(data[2], 'base64'), decoded = data[1] === 'image/png' ? PNG.sync.read(bytes) : jpeg.decode(bytes);
      const attachmentId = createHash('sha256').update(sessionId + body.kind + checksum(bytes)).digest('hex').slice(0, 24);
      const reference = { attachmentId, kind: body.kind, sha256: checksum(bytes), mimeType: data[1], byteLength: bytes.length,
        width: decoded.width, height: decoded.height };
      attachments.set(attachmentId, { sessionId, reference, bytes }); return response.json({ ok: true, reference });
    }
    if (action === 'references/resolve') {
      if (resolveGate) await resolveGate;
      const references = resolveReferences(sessionId, body.references);
      return response.json({ ok: true, references, sha256: checksum(Buffer.from(JSON.stringify(references))) });
    }
    const session = sessions.get(sessionId);
    if (method === 'GET') return response.json({ ok: true, turns: session.turns });
    assert.equal(action, 'turns'); consultations.push(structuredClone(body));
    const references = body.context.inspectReferences ? resolveReferences(sessionId, body.context.references) : [];
    assert.ok(!JSON.stringify(body.context).includes('base64'));
    const turn = { id: body.clientTurnId, state: inspectionState === 'unknown' ? 'failed' : 'completed', mode: body.mode,
      input: body.message, context: body.context, envelope: { synthetic: true }, events: [], text: 'Synthetic advisory result',
      inspection: body.context.inspectReferences ? { state: inspectionState, requestId: 'synthetic-native-request', references,
        ...(inspectionState === 'completed' && { nativeReceipt: { runId: 'synthetic-native-run', completed: true } }) } : { state: 'not-requested' },
      ...(inspectionState === 'unknown' ? { error: 'Synthetic native outcome unknown' } : { proposal: {
        visualPrompt: 'A workshop with an owl', prompt: 'A workshop with an owl', profile: profile.id, width: 1024, height: 1024 } }) };
    session.turns.push(turn); response.json({ ok: true, turn });
  });
  app.use('/api/images', (request, response) => {
    const route = request.path;
    if (route === '/status') return response.json({ ok: true, configured: true, defaultProfile: profile.id, profiles: [profile] });
    if (route === '/workshop') return response.json({ ok: true, profiles: [profile], worker: null });
    if (route === '/operations' && request.method === 'GET') return response.json({ ok: true, operations: [parent] });
    if (route === '/operations' && request.method === 'POST') {
      renders.push(structuredClone(request.body));
      const operation = { ...parent, id: randomUUID() }; return response.json({ ok: true, operation });
    }
    if (route.endsWith('/image')) return response.type('image/png').send(parentBytes);
    if (route.endsWith('/details')) return response.json({ ok: true, details: { recipe: profile,
      request: { prompt: 'Synthetic scene', width: 1024, height: 1024 }, runtimeRestored: true } });
    if (route.endsWith('/draft')) return response.json({ ok: true, draft: { prompt: 'Synthetic scene', profile: profile.id, width: 1024, height: 1024 } });
    if (/^\/operations\/[^/]+$/.test(route)) return response.json({ ok: true, operation: parent });
    return response.status(404).json({ ok: false, message: 'Unknown synthetic endpoint' });
  });
  req('../shared/localStyleVendorAssets').registerLocalStyleVendorAssets(app, path.join(core, 'node_modules'));
  app.use(express.static(path.join(core, 'public'))); req('./routes/local-images').mount(app);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/images`;
  browser = await chromium.launch({ headless: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport }), page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#image-prompt').fill('A workshop with an owl'); await settle(page);
    assert.equal(await page.locator('#imagex-inspect-references').isDisabled(), true);
    await page.locator('#image-gallery button').first().click(); await page.locator('#image-use-reference').click(); await attachFile(page, uploadBytes);
    const beforeRender = renders.length; await inspect(page);
    const inspectedTurn = consultations.at(-1), descriptor = inspectedTurn.context.references[1], stored = attachments.get(descriptor.attachmentId);
    assert.deepEqual(inspectedTurn.context.references.map(value => value.kind), ['parent', 'upload']);
    assert.equal(descriptor.original.sha256, checksum(uploadBytes)); assert.equal(renders.length, beforeRender);
    assert.equal(await page.locator('#imagex-apply').isDisabled(), false);
    await page.locator('#imagex-apply').click(); assert.equal(renders.length, beforeRender);
    await page.locator('#image-create').click(); await page.waitForFunction(() => document.getElementById('image-status').textContent.includes('Image ready'));
    assert.equal(renders.at(-1).references[0], stored.bytes.toString('base64'));
    assert.deepEqual(renders.at(-1).referenceSelection, inspectedTurn.context.references);
    assert.equal(renders.at(-1).parent.operationId, parentId);
    checks.push(`${name}: parent then upload inspected; archived original retained; Apply starts no image; explicit Create reuses identical inspected working-copy bytes.`);
    // An equal-count upload replacement after the persisted proposal must not enable Apply.
    await attachFile(page, replacementBytes); assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await page.reload(); await page.locator('#image-prompt').fill('A workshop with an owl'); await settle(page);
    await page.locator('#image-gallery button').first().click(); await page.locator('#image-use-reference').click(); await attachFile(page, replacementBytes);
    assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    checks.push(`${name}: same-count replacement blocks persisted proposal after reload.`);
    await page.screenshot({ path: path.join(reportDir, `reference-inspection-${name}.png`), fullPage: true });
    await context.close();
  }
  const context = await browser.newContext(), page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(url); await page.locator('#image-prompt').fill('Preserved draft during a race'); await settle(page); await attachFile(page, uploadBytes);
  let release; resolveGate = new Promise(resolve => { release = resolve; });
  const beforeRace = consultations.length;
  await page.locator('#imagex-inspect-references').click(); await page.waitForFunction(() => document.getElementById('imagex-notice').textContent.includes('Verifying'));
  await attachFile(page, replacementBytes); release(); resolveGate = null;
  await page.waitForFunction(() => document.getElementById('imagex-notice').textContent.includes('references changed'));
  assert.equal(consultations.length, beforeRace); assert.equal(await page.locator('#image-prompt').inputValue(), 'Preserved draft during a race');
  checks.push('Selection change during preparation refuses before consultation and preserves the full draft.');
  inspectionState = 'unknown'; await page.locator('#imagex-inspect-references').click();
  await page.waitForFunction(() => document.getElementById('imagex-notice').textContent.includes('outcome is unknown'));
  assert.equal(await page.locator('#imagex-inspect-references').isDisabled(), true);
  assert.equal(await page.locator('#imagex-recovery').isVisible(), false);
  assert.equal(await page.locator('#image-prompt').inputValue(), 'Preserved draft during a race');
  checks.push('Unknown native outcome remains truthful, preserves the draft and disables replacement inspection/retry.');
  assert.deepEqual(errors, []); await context.close();
  fs.writeFileSync(path.join(reportDir, 'browser-reference-inspection.json'), JSON.stringify({ ok: true, checks, pageErrors: errors,
    syntheticConsultations: consultations.length, syntheticRenders: renders.length, liveInferenceCalls: 0, liveImageCalls: 0 }, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, checks: checks.length, syntheticConsultations: consultations.length, syntheticRenders: renders.length }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
});
