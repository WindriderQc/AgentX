'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { createHash } = require('node:crypto'), vm = require('node:vm');
const tree = path.resolve(__dirname, '../../..'), core = tree + '/core', reportDir = process.env.ATELIER_REPORT_DIR;
if (!reportDir || path.resolve(reportDir) === tree || path.resolve(reportDir).startsWith(tree + path.sep)) throw new Error('Set ATELIER_REPORT_DIR to a directory outside the checkout.');
fs.mkdirSync(reportDir, { recursive: true });
const req = createRequire(core + '/package.json'), express = req('express'), helmet = req('helmet'), { PNG } = req('pngjs');
const { chromium } = require('playwright');
const contract = req('./public/js/image-brief-constraints');
const textContract = req('./public/js/image-text-policy');
const parentId = '11111111-1111-4111-8111-111111111111', createdId = '22222222-2222-4222-8222-222222222222';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const longText = length => { const tail = '\nFIN DU BRIEF COMPLET — SENTINELLE'; return 'Une maison lumineuse, un hibou au centre, trois ateliers distincts.\n'.repeat(Math.ceil(length / 60)).slice(0, length - tail.length) + tail; };
const original = longText(9958), overBrief = longText(32001), overMessage = longText(32001), bigMessage = '  ' + 'm'.repeat(31983) + '\nFIN MESSAGE   ';
assert.equal(original.length, 9958); assert.equal(overBrief.length, 32001); assert.equal(bigMessage.length, 32000);
const sourcePaths = ['core/src/app.js', 'core/routes/local-images.js', 'core/routes/image-expert.js', 'core/public/js/local-images.js',
  'core/public/js/image-expert.js', 'core/public/js/image-brief-constraints.js', 'core/public/js/image-brief-constraints-ui.js',
  'core/src/services/images/expertService.js', 'core/views/pages/images.ejs', 'core/views/pages/image-expert.ejs',
  'core/views/pages/image-brief-proposal.ejs', 'core/views/pages/image-text-editor.ejs', 'core/views/pages/image-compare.ejs',
  'core/public/js/image-text-editor.js', 'core/public/js/image-compare.js',
  'core/public/js/image-text-policy.js', 'core/public/js/image-text-policy-ui.js',
  'core/public/css/image-text-policy.css', 'core/views/pages/image-text-policy.ejs',
  'core/public/css/local-images.css', 'core/public/css/image-expert.css'];
const before = sourcePaths.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(tree, file))) }));
const productionImgSrc = vm.runInNewContext('[' + /imgSrc:\s*\[([\s\S]*?)\]/.exec(fs.readFileSync(core + '/src/app.js', 'utf8'))[1] + ']');
const checks = [], errors = [], cspErrors = [], requests = [], bridgeCalls = [], generation = [], sessions = new Map(), turns = new Map();
let available = true, failNextPlan = false, browser, server;
const copy = value => value === undefined ? undefined : structuredClone(value);
const conversations = {
  async listSessions() { return [...sessions.values()].map(copy); },
  async createSession(input) { const session = { ...input, createdAt: new Date().toISOString() }; sessions.set(input.sessionId, session); return copy(session); },
  async getSession(input) { return copy(sessions.get(input.sessionId)); },
  async listTurns(input) { return [...turns.values()].filter(turn => turn.sessionId === input.sessionId).reverse().map(copy); },
  async getTurn(input) { const turn = turns.get(input.traceId); return turn?.sessionId === input.sessionId ? copy(turn) : undefined; },
  async recordTurn(input) { const turn = { ...copy(input), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; turns.set(input.traceId, turn); return copy(turn); },
  async updateTurn(input, update) { const turn = turns.get(input.traceId); assert.equal(turn.sessionId, input.sessionId); Object.assign(turn, copy(update.$set), { updatedAt: new Date().toISOString() }); return copy(turn); }
};
const condensed = 'Maison en coupe, un hibou au centre, trois ateliers distincts avec des enseignes lisibles.';
const bridge = { configured: () => available, async invoke(envelope) {
  bridgeCalls.push(copy(envelope));
  if (envelope.action === 'describe') return { routing: { provider: 'synthetic', model: 'fixture-hermes' }, resources: [{ id: 'identity', title: 'Identity fixture', available: true }] };
  if (envelope.action === 'resource') return { resource: { available: true, content: 'Synthetic identity', path: 'IDENTITY.md', updatedAt: '2026-01-01T00:00:00Z', bytes: 18, sha256: 'a'.repeat(64) } };
  if (envelope.action === 'consult') return { ok: true, expert: 'hermes', text: 'Conseil synthétique, sans modèle.', model: 'fixture-hermes' };
  assert.equal(envelope.action, 'plan');
  if (failNextPlan) { failNextPlan = false; throw new Error('Image expert changed the requested width'); }
  const policy = envelope.request.textPolicy;
  const textPlan = policy?.enabled ? { version: 1, strategy: policy.strategy === 'auto' ? 'two-pass' : policy.strategy,
    reason: 'Synthetic recommendation: preserve exact lettering in reviewed layers.', labels: textContract.known(policy, envelope.request.constraints) } : undefined;
  return { ok: true, expert: 'hermes', text: 'Proposition synthétique.', model: 'fixture-hermes', proposal: {
    prompt: condensed, profile: envelope.request.profile, width: envelope.request.width, height: envelope.request.height, reason: 'Description condensée ; les contraintes sont conservées.', ...(textPlan && { textPlan }) } };
} };
const fixturePng = new PNG({ width: 1024, height: 1024 }); fixturePng.data.fill(180); const imageBytes = PNG.sync.write(fixturePng), imageSha = hash(imageBytes);
const operation = id => ({ id, state: 'completed', runtimeRestored: true, profile: 'quality', label: 'Synthetic recipe',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: id === createdId ? new Date(Date.UTC(2026, 0, 1) + generation.length).toISOString() : '2026-01-01T00:00:00Z', artifact: { width: 1024, height: 1024, sha256: imageSha, url: `/api/images/operations/${id}/image` } });
const imageService = { status: () => ({ configured: true, defaultProfile: 'quality', profiles: [{ id: 'quality', label: 'Synthetic recipe', maxPixels: 4194304 }] }),
  list: async () => [operation(parentId)], get: async id => operation(id), image: async () => ({ bytes: imageBytes, mimeType: 'image/png' }),
  draft: async () => ({ ...copy(generation.at(-1)), visualPrompt: generation.at(-1)?.prompt }),
  async accept(body) { textContract.compose(body.prompt, body.constraints, body.textPolicy); generation.push(copy(body)); return operation(createdId); } };
const workshop = { overview: async () => ({ worker: null, profiles: [{ id: 'quality', family: 'qwen21', label: 'Synthetic recipe', steps: 25, maxPixels: 4194304 }] }),
  details: async id => ({ id, recipe: { id: 'quality', label: 'Synthetic recipe', family: 'qwen21', steps: 25 }, request: { prompt: 'Synthetic archived image', seed: 42, width: 1024, height: 1024 },
    ...(id === createdId && { request: { ...copy(generation.at(-1)), prompt: textContract.compose(generation.at(-1).prompt, generation.at(-1).constraints, generation.at(-1).textPolicy) } }),
    ...(id === createdId && generation.at(-1)?.parent && { lineage: { version: 1, parent: { ...generation.at(-1).parent, width: 1024, height: 1024 } } }), actualDimensions: { width: 1024, height: 1024 }, runtimeRestored: true }) };
const expertService = req('./src/services/images/expertService').createService({ conversations, bridge, workshop, imageService });
async function paste(page, id, text) {
  await page.evaluate(text => navigator.clipboard.writeText(text), text);
  await page.locator('#' + id).click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Control+V');
  await page.waitForFunction(({ id, text }) => document.getElementById(id).value === text, { id, text });
}
async function enabled(page, id) { await page.waitForFunction(id => !document.getElementById(id).disabled, id); }
async function open(page, id) { const selector = ['seed-settings', 'brief-plan-instruction'].includes(id) ? '.' + id : '#' + id; if (!(await page.locator(selector).evaluate(el => el.open))) await page.locator(selector + ' > summary').click(); }
(async () => {
  const app = express(); app.set('view engine', 'ejs'); app.set('views', path.join(core, 'views'));
  app.locals.buildProductNavigation = req('../shared/productNavigation').buildProductNavigation;
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'"], styleSrc: ["'self'", "'unsafe-inline'"],
    fontSrc: ["'self'", 'data:'], imgSrc: productionImgSrc, mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"],
    objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"], scriptSrcAttr: ["'none'"]
  } }, hsts: false, crossOriginOpenerPolicy: false, originAgentCluster: false }));
  app.use(express.json({ limit: '12mb' }));
  app.use('/api/images', (request, _response, next) => { if (request.method === 'POST') requests.push({ url: request.originalUrl, body: copy(request.body) }); next(); });
  app.use('/api/images/expert', req('./routes/image-expert').createRouter(expertService));
  app.use('/api/images', req('./routes/local-images').createRouter(imageService, workshop));
  app.use('/api/images', (_request, response) => response.status(404).json({ ok: false, message: 'Endpoint absent du fixture synthétique.' }));
  req('../shared/localStyleVendorAssets').registerLocalStyleVendorAssets(app, core + '/node_modules');
  app.use(express.static(path.join(core, 'public'))); req('./routes/local-images').mount(app);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/images`;
  browser = await chromium.launch({ headless: true });
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1100 }], ['mobile', { width: 390, height: 844 }]]) {
    available = true;
    const context = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (/Content Security Policy|violates.*policy|Refused to load/.test(message.text())) cspErrors.push(message.text()); });
    const renderBefore = generation.length, requestsBefore = requests.length;
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('imagex-connection').textContent.includes('connecté'));
    await page.waitForFunction(() => !document.getElementById('image-new').disabled);
    assert.equal(await page.locator('#imagex').evaluate(el => el.open), false);
    assert.equal(await page.locator('#image-create').isDisabled(), true);
    assert.equal(await page.locator('#image-text-editor').isVisible(), false);
    assert.equal(await page.locator('#image-compare').isVisible(), false);
    assert.equal(await page.locator('#image-protected-composition').isVisible(), false);
    assert.equal(await page.locator('#imagex-message').isVisible(), false);
    assert.equal(await page.locator('#image-prompt').evaluate(el => el.compareDocumentPosition(document.getElementById('imagex')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
    for (const id of ['image-prompt', 'imagex-message', 'imagex-plan-instruction', 'imagex-proposal-prompt']) assert.equal(await page.locator('#' + id).getAttribute('maxlength'), null);
    await page.screenshot({ path: path.join(reportDir, `entry-${device}.png`), fullPage: true });
    await page.screenshot({ path: path.join(reportDir, `entry-viewport-${device}.png`) });
    // Import stays available before a result exists, without creating an image.
    await page.locator('#image-text-open').click();
    assert.equal(await page.locator('#image-text-file').isVisible(), true);
    await page.locator('#image-text-editor > summary').click();
    assert.equal(generation.length, renderBefore);
    checks.push(`${device}: brief leads the page; advice is collapsed; irrelevant result tools are hidden and JSON reopening stays accessible.`);

    const gallery = page.locator('#image-gallery button').first(); await gallery.click(); await page.locator('#image-use-reference').click();
    await open(page, 'seed-settings');
    await page.locator('#image-seed').fill('73');
    const paddedBrief = ' '.repeat(20) + 'x'.repeat(7990);
    await paste(page, 'image-prompt', paddedBrief);
    assert.equal(await page.locator('#image-create').isDisabled(), true); await enabled(page, 'imagex-plan');
    await page.locator('#image-form').evaluate(form => form.requestSubmit()); assert.equal(generation.length, renderBefore);
    await paste(page, 'image-prompt', original);
    await page.locator('#image-text-enabled').check(); await page.locator('#image-text-strategy').selectOption('single-pass');
    await open(page, 'image-constraints'); await page.locator('#image-constraint-text').fill('ÉCOSYSTÈME AGENTX'); await page.locator('#image-constraint-add').click();
    await page.locator('#image-constraints > summary').click();
    assert.equal(await page.locator('#image-brief-counter').isVisible(), true);
    assert.equal(await page.locator('#image-create').isDisabled(), true); await enabled(page, 'imagex-plan');
    assert.match(await page.locator('#image-brief-counter').textContent(), /9\s?958/);
    assert.equal(await page.locator('#image-prompt').inputValue(), original);
    assert.equal(await page.locator('#image-prompt').evaluate(node => node.validationMessage), '');
    await page.locator('#image-form').evaluate(form => form.requestSubmit()); assert.equal(generation.length, renderBefore);
    await page.screenshot({ path: path.join(reportDir, `long-brief-${device}.png`), fullPage: true });
    checks.push(`${device}: actual clipboard retains the complete 9958-character brief; counters stay visible and render is refused before POST.`);

    await paste(page, 'image-prompt', overBrief);
    assert.equal(await page.locator('#imagex-plan').isDisabled(), true);
    await page.locator('#imagex-plan').dispatchEvent('click'); assert.equal(requests.length, requestsBefore);
    assert.equal(await page.locator('#image-prompt').inputValue(), overBrief);
    await paste(page, 'image-prompt', original);
    // A separate unsent advice draft cannot affect brief preparation.
    await page.locator('[data-imagex-open]').click();
    assert.equal(await page.locator('#imagex').evaluate(el => el.open), true);
    await paste(page, 'imagex-message', overMessage);
    assert.equal(await page.locator('#imagex-send').isDisabled(), true);
    assert.equal(await page.locator('#imagex-plan').isDisabled(), false);
    await page.locator('#imagex-chat-form').dispatchEvent('submit'); assert.equal(requests.length, requestsBefore);
    assert.equal(await page.locator('#imagex-message').inputValue(), overMessage);
    await page.locator('#imagex > summary').click();
    await open(page, 'brief-plan-instruction');
    await paste(page, 'imagex-plan-instruction', overMessage);
    assert.equal(await page.locator('#imagex-plan').isDisabled(), true);
    await page.locator('#imagex-plan').dispatchEvent('click'); assert.equal(requests.length, requestsBefore);
    await paste(page, 'imagex-plan-instruction', 'Préserve le hibou et condense la description.');
    failNextPlan = true;
    await page.locator('#imagex-plan').click();
    await page.waitForFunction(() => document.getElementById('imagex-notice').textContent.includes('la largeur'));
    await enabled(page, 'imagex-retry');
    assert.equal(await page.locator('#image-prompt').inputValue(), original);
    assert.equal(await page.locator('#imagex-proposal-panel').isVisible(), false);
    assert.equal(await page.locator('#imagex-recovery').isVisible(), true);
    assert.equal(await page.locator('#imagex-use-brief').isVisible(), false);
    assert.equal((await page.locator('#imagex-notice').textContent()).includes('travaille'), false);
    assert.equal(generation.length, renderBefore);
    // Reload has no textarea draft; the canonical failed request still provides recovery.
    const recovery = await context.newPage(); await recovery.goto(url);
    await recovery.waitForFunction(() => document.getElementById('imagex-restore-brief').hidden === false);
    const beforeRecoveryPosts = requests.length;
    await recovery.locator('#imagex-restore-brief').click();
    assert.equal(await recovery.locator('#image-prompt').inputValue(), original);
    assert.equal(await recovery.locator('#image-constraint-list textarea').first().inputValue(), 'ÉCOSYSTÈME AGENTX');
    assert.equal(requests.length, beforeRecoveryPosts);
    assert.equal(await recovery.locator('#image-create').isDisabled(), true);
    await recovery.close();
    await page.screenshot({ path: path.join(reportDir, `failed-refinement-${device}.png`), fullPage: true });
    const failedRequest = requests.at(-1);
    await page.locator('#imagex-retry').click(); await enabled(page, 'imagex-apply');
    const retriedRequest = requests.at(-1);
    assert.notEqual(retriedRequest.body.clientTurnId, failedRequest.body.clientTurnId);
    assert.deepEqual(retriedRequest.body.context, failedRequest.body.context);
    assert.equal(retriedRequest.body.message, failedRequest.body.message);
    assert.equal(await page.locator('#imagex-recovery').isVisible(), false);
    checks.push(`${device}: a refused width has a French diagnosis beside the preserved brief, a terminal status and a deliberate retry with protected settings and a new identity; no image is submitted.`);
    const planPost = requests.slice(requestsBefore).findLast(request => request.body.mode === 'plan');
    const plan = bridgeCalls.findLast(call => call.action === 'plan');
    assert.equal(planPost.body.context.prompt, original);
    assert.equal(plan.request.prompt, contract.composeBrief(original, planPost.body.context.constraints));
    assert.equal(planPost.body.message, 'Préserve le hibou et condense la description.');
    assert.equal(await page.locator('#imagex-message').inputValue(), overMessage);
    assert.equal(await page.locator('#image-prompt').inputValue(), original);
    assert.equal(await page.locator('#imagex-proposal-original').textContent(), original);
    assert.equal(await page.locator('#imagex').evaluate(el => el.open), false);
    assert.equal(await page.locator('#imagex-proposal-panel').evaluate(el => el.open), true);
    assert.equal(generation.length, renderBefore);
    checks.push(`${device}: preparation gets the full brief and its own instruction, preserves the advice draft, opens a proposal next to the brief and starts no render.`);

    await open(page, 'image-constraints');
    const constraintInput = page.locator('#image-constraint-list textarea').first(); await constraintInput.fill('Titre modifié');
    assert.equal(await page.locator('#imagex-apply').isDisabled(), true); await constraintInput.fill('ÉCOSYSTÈME AGENTX'); await enabled(page, 'imagex-apply');
    await page.locator('#image-seed').fill('74'); assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await page.locator('#image-seed').fill('73'); await enabled(page, 'imagex-apply');
    await page.locator('#image-size').selectOption('1280,768'); assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await page.locator('#image-size').selectOption('1024,1024'); await enabled(page, 'imagex-apply');
    await paste(page, 'imagex-proposal-prompt', 'x'.repeat(7990));
    assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await paste(page, 'imagex-proposal-prompt', longText(9000));
    assert.equal((await page.locator('#imagex-proposal-prompt').inputValue()).length, 9000); assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await paste(page, 'imagex-proposal-prompt', condensed); await enabled(page, 'imagex-apply');
    await page.screenshot({ path: path.join(reportDir, `proposal-${device}.png`), fullPage: true });
    await page.locator('#imagex-apply').click();
    await enabled(page, 'image-create');
    assert.equal(await page.locator('#imagex-proposal-panel').evaluate(el => el.open), false);
    assert.equal(await page.locator('#image-prompt').inputValue(), condensed);
    await open(page, 'image-render-preview');
    const approvedPolicy = { ...planPost.body.context.textPolicy, labels: textContract.known(planPost.body.context.textPolicy, planPost.body.context.constraints) };
    assert.equal(await page.locator('#image-render-prompt').textContent(), textContract.compose(condensed, planPost.body.context.constraints, approvedPolicy));
    assert.equal(await page.locator('#image-seed').inputValue(), '73');
    assert.equal(generation.length, renderBefore);
    await page.locator('#image-create').click();
    await page.waitForFunction(() => document.getElementById('image-status').textContent.includes('Image prête'));
    const rendered = generation.at(-1);
    assert.equal(generation.length, renderBefore + 1); assert.equal(rendered.prompt, condensed);
    assert.equal(rendered.seed, 73); assert.deepEqual(rendered.parent, { operationId: parentId, sha256: imageSha });
    assert.deepEqual(rendered.constraints, planPost.body.context.constraints);
    assert.deepEqual(rendered.expert, { sessionId: planPost.url.split('/')[5], turnId: planPost.body.clientTurnId });
    assert.equal(contract.compose(rendered.prompt, rendered.constraints).length <= 8000, true);
    await page.locator('#image-compare').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#image-protected-composition').isVisible(), true);
    assert.equal(await page.locator('#image-text-editor').isVisible(), true);
    await open(page, 'image-compare'); await page.locator('#image-compare-load').click();
    await page.locator('#image-compare-workspace').waitFor({ state: 'visible' });
    await open(page, 'image-text-editor'); await page.locator('#image-text-prepare').click();
    await page.locator('#image-text-workspace').waitFor({ state: 'visible' });
    await page.locator('#image-text-add').click(); await page.locator('#image-text-content').fill('Texte exact 123');
    const download = page.waitForEvent('download'); await page.locator('#image-text-json').click(); await download;
    assert.equal(generation.length, renderBefore + 1);
    await page.screenshot({ path: path.join(reportDir, `result-${device}.png`), fullPage: true });
    checks.push(`${device}: apply and create are distinct; stale contexts and oversized proposals refuse; parent, seed and constraints survive; result tools load verified archives without another render.`);

    await page.locator('#image-new').click(); await page.locator('#image-prompt').fill('A mechanical infrastructure diagram with blank plaques.');
    assert.equal(await page.locator('#image-text-enabled').isChecked(), false);
    assert.match(await page.locator('#image-render-prompt').textContent(), /Aucun texte/);
    await page.locator('#image-prompt').fill('v'.repeat(7987));
    assert.equal(await page.locator('#image-create').isDisabled(), true);
    const completePrompt = await page.locator('#image-render-prompt').textContent();
    assert.equal(completePrompt.startsWith('v'.repeat(7987)), true);
    assert.equal(completePrompt.length > 8000, true);
    assert.match(await page.locator('#image-brief-counter').textContent(), /rendu final : 8\s?\d{3}/);
    assert.match(await page.locator('#image-brief-counter').textContent(), /Consignes ajoutées.*description disponible/);
    assert.match(await page.locator('#image-create-help').textContent(), /dont.*consignes/);
    const beforeOverflow = generation.length;
    await page.locator('#image-form').evaluate(form => form.requestSubmit());
    assert.equal(generation.length, beforeOverflow);
    await page.locator('#image-prompt').fill('A mechanical infrastructure diagram with blank plaques.');
    await page.locator('#image-text-enabled').check();
    assert.equal(await page.locator('#image-create').isDisabled(), true);
    await page.locator('#image-text-policy-add').click();
    await page.locator('#image-text-policy-labels textarea').nth(0).fill('École & façade 💡');
    await page.locator('#image-text-policy-labels textarea').nth(1).fill('cartouche central');
    await page.locator('#image-text-policy-advice').click(); await enabled(page, 'imagex-apply');
    assert.match(await page.locator('#imagex-proposal-text-plan').textContent(), /Deux passes/);
    await page.locator('#image-text-strategy').selectOption('single-pass'); assert.equal(await page.locator('#imagex-apply').isDisabled(), true);
    await page.locator('#image-text-strategy').selectOption('auto'); await enabled(page, 'imagex-apply');
    await page.locator('#imagex-apply').click(); await enabled(page, 'image-create');
    assert.equal(await page.locator('#image-text-strategy').inputValue(), 'two-pass');
    assert.equal((await page.locator('#image-render-prompt').textContent()).includes('École & façade 💡'), false);
    await page.locator('#image-create').click(); await page.locator('#image-text-planned').waitFor({ state: 'visible' });
    const twoPassCount = generation.length;
    await open(page, 'image-text-editor');
    page.once('dialog', dialog => dialog.accept()); await page.locator('#image-text-planned').click();
    await page.waitForFunction(() => document.getElementById('image-text-content').value === 'École & façade 💡');
    assert.match(await page.locator('#image-text-placement-hint').textContent(), /provisoire/);
    const plannedDownload = page.waitForEvent('download'); await page.locator('#image-text-json').click();
    const plannedFile = await plannedDownload;
    const project = JSON.parse(fs.readFileSync(await plannedFile.path(), 'utf8'));
    assert.equal(project.labels[0].text, 'École & façade 💡');
    assert.equal(generation.length, twoPassCount);
    await page.locator('#image-reuse-brief').click();
    await page.waitForFunction(() => document.getElementById('image-draft-source').hidden === false);
    assert.equal(await page.locator('#image-text-strategy').inputValue(), 'two-pass');
    assert.equal(await page.locator('#image-text-policy-labels textarea').first().inputValue(), 'École & façade 💡');
    await page.locator('#image-text-policy').screenshot({ path: path.join(reportDir, `lettering-controls-${device}.png`) });
    await page.locator('#image-text-editor').screenshot({ path: path.join(reportDir, `lettering-layers-${device}.png`) });
    await page.screenshot({ path: path.join(reportDir, `two-pass-${device}.png`), fullPage: true });
    checks.push(`${device}: unchecked is text-free, automatic requires a proposal, changed strategy invalidates it, two-pass saves exact spelling, prefills verified layers, exports JSON and restores its draft without a second generation.`);

    await page.locator('[data-imagex-open]').click();
    await paste(page, 'imagex-message', bigMessage); await enabled(page, 'imagex-send'); await page.locator('#imagex-send').click();
    await page.waitForFunction(() => document.getElementById('imagex-message').value === '');
    assert.equal(bridgeCalls.findLast(call => call.action === 'consult').prompt, bigMessage);
    await page.locator('#imagex-tab-files').click();
    await page.locator('#imagex-resource').selectOption('identity');
    await page.waitForFunction(() => document.getElementById('imagex-file-content').textContent.includes('Synthetic identity'));
    assert.equal(await page.locator('#imagex-file-download').isVisible(), true);
    await page.locator('#imagex-tab-files').press('ArrowLeft');
    assert.equal(await page.locator('#imagex-tab-activity').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#imagex-events li').count() > 0, true);
    assert.equal(generation.length, twoPassCount);
    checks.push(`${device}: secondary advice, full 32000-character messages, console, keyboard tabs and profile files remain accessible.`);
    await page.locator('#image-new').click();
    assert.equal(await page.locator('#image-prompt').inputValue(), '');
    assert.equal(await page.locator('#imagex-proposal-panel').isVisible(), false);
    await page.locator('#imagex-tab-proposal').click();
    assert.equal(await page.locator('#imagex-proposal-prompt').inputValue(), condensed);
    assert.equal(await page.locator('#imagex-apply').isDisabled(), true, 'A new brief cannot apply the previous proposal');
    assert.equal(generation.length, twoPassCount);

    // Use a fresh browser storage scope for unavailable Hermes and manual creation.
    available = false;
    const offlineContext = await browser.newContext({ viewport, permissions: ['clipboard-read', 'clipboard-write'] });
    const offline = await offlineContext.newPage(); offline.on('pageerror', error => errors.push(error.message));
    const offlineRequests = requests.length;
    await offline.goto(url); await offline.waitForFunction(() => document.getElementById('imagex-connection').textContent.includes('indisponible'));
    await paste(offline, 'image-prompt', original);
    assert.equal(await offline.locator('#imagex-plan').isDisabled(), true);
    assert.equal(await offline.locator('#image-create').isDisabled(), true);
    assert.equal(await offline.locator('#image-prompt').inputValue(), original);
    assert.match(await offline.locator('#imagex-planning-help').textContent(), /indisponible/);
    assert.equal(await offline.locator('#imagex').evaluate(el => el.open), false);
    await offline.screenshot({ path: path.join(reportDir, `unavailable-${device}.png`), fullPage: true });
    await paste(offline, 'image-prompt', condensed); await enabled(offline, 'image-create');
    assert.match(await offline.locator('#imagex-planning-help').textContent(), /créer directement/);
    await open(offline, 'image-layout-guide'); await offline.locator('#image-layout-new').click();
    await offline.locator('#image-layout-add').click(); await offline.locator('#image-layout-name').fill('Hibou central');
    await offline.locator('#image-layout-attach').click();
    await offline.waitForFunction(() => document.getElementById('image-reference-help').textContent.includes('1 référence'));
    assert.equal(requests.length, offlineRequests, 'Composition preparation starts no render or model');
    assert.match(await offline.locator('#image-create-label').textContent(), /Créer/);
    await offline.locator('#image-create').click();
    await offline.waitForFunction(() => document.getElementById('image-status').textContent.includes('Image prête'));
    assert.equal(requests.length, offlineRequests + 1);
    assert.equal(requests.at(-1).url, '/api/images/operations');
    assert.equal(generation.at(-1).expert, undefined); assert.equal(generation.at(-1).references.length, 1);
    assert.equal(await offline.locator('#image-compare').isVisible(), false, 'A new creation has no archived parent');
    checks.push(`${device}: unavailable Hermes keeps all 9958 characters; manual reduction and a composition sketch allow direct creation without any expert POST.`);

    for (const width of [320, 390, 768, 1440]) {
      await offline.setViewportSize({ width, height: viewport.height });
      const overflow = await offline.evaluate(() => [...document.querySelectorAll('body *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && (r.right > innerWidth + 1 || r.left < -1); }).map(el => ({ tag: el.tagName, id: el.id, class: el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right })));
      if (await offline.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        fs.writeFileSync(path.join(reportDir, `overflow-${width}.json`), JSON.stringify(overflow, null, 2));
        await offline.screenshot({ path: path.join(reportDir, `overflow-${width}.png`), fullPage: true });
      }
      assert.equal(await offline.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px`);
    }
    await offlineContext.close(); await context.close();
  }
  const after = sourcePaths.map(file => ({ file, sha256: hash(fs.readFileSync(path.join(tree, file))) }));
  const changedSourcesDuringRun = after.filter((file, index) => file.sha256 !== before[index].sha256); assert.deepEqual(changedSourcesDuringRun, []);
  assert.deepEqual(errors, []); assert.deepEqual(cspErrors, []);
  const report = { verdict: 'passed', checks, sourceFiles: after, changedSourcesDuringRun, browser: browser.version(), csp: 'Production-equivalent directives from core/src/app.js',
    fixtureBriefUnits: original.length, fixtureBriefSha256: hash(original), pastedMessageUnits: bigMessage.length, preservedMessageSha256: hash(bigMessage),
    pageErrors: errors, cspErrors, mockedBridgeConsultations: bridgeCalls.filter(call => ['plan', 'consult'].includes(call.action)).length, mockedGenerationRequests: generation.length,
    limits: ['Synthetic clipboard/browser acceptance only', 'Actual expert route/service with memory store and mocked Bridge', 'No model, inference, GPU or deployed-head claim'] };
  fs.writeFileSync(path.join(reportDir, 'browser-review.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ verdict: report.verdict, checks: checks.length, report: path.join(reportDir, 'browser-review.json') }));
})().catch(error => { fs.writeFileSync(path.join(reportDir, 'browser-failure.json'), JSON.stringify({ error: error.stack, checks, errors, cspErrors }, null, 2)); console.error(error.stack); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
