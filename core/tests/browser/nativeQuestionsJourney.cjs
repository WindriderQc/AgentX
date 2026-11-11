'use strict';
// Browser form/restore proof only. Native authority and Mongo are qualified separately.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../..');
const report = process.env.QUESTIONS_REPORT_DIR;
if (!report || path.resolve(report).startsWith(root + path.sep)) throw Error('Use a report directory outside the checkout.');
const script = fs.readFileSync(path.join(root, 'core/surfaces/household/public/conversation-questions.js'));
const workId = 'a'.repeat(64), sha = 'b'.repeat(64), originalId = '174c1870-6f09-4b77-a83b-e493238b928a';
const basis = { version: 1, workId, requestSha256: 'c'.repeat(64), attemptId: 'fixture-attempt',
  questionId: 'ask_fixture', incarnation: 'fixture-original-incarnation', questionSha256: sha };
const input = { basis, answerable: true, expiresAtMs: Date.now() + 60000,
  questions: [{ questionId: 'day', header: 'Jour', question: 'Quel jour pour cette demande de test ?',
    options: [{ label: 'Lundi', value: 'Monday' }, { label: 'Mardi', value: 'Tuesday' }], isOther: true, multiSelect: false }] };
let item, posts = [], reads = 0, resumes = 0, intent, loseResponse = false;
const initial = () => ({ id: workId, sessionId: 'fixture-owner', nativeQuestions: { supported: true, questions: [input], intents: [] } });
function pageHtml() {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><style>body{font:18px sans-serif;max-width:50rem;margin:2rem;padding:1rem}label{display:flex;gap:.7rem;margin:.7rem}fieldset{margin:1rem 0}textarea{min-height:4rem}button{font:inherit;padding:.6rem}</style><h1>Question synthétique · aucun modèle ni instance</h1><main id="host"></main><script src="/questions.js"></script><script>
  const host=document.querySelector('#host');
  const api=async(url,options)=>{const response=await fetch(url,options);if(!response.ok)throw Error('Unavailable');return response.json()};
  const panel=NestorQuestions.create({api,base:'/api/sessions',getLanguage:()=> 'fr',onRefresh:()=>window.mount?.()});
  panel.reset('fixture-owner');
  window.mount=async()=>{host.replaceChildren();panel.render(host,await api('/fixture-state'))};window.mount();
  </script></html>`;
}
const server = http.createServer(async (req, res) => {
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(pageHtml()); return; }
  if (req.url === '/questions.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return; }
  if (req.url === '/fixture-state') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(item)); return; }
  const bytes = []; for await (const chunk of req) bytes.push(chunk);
  if (req.method === 'POST' && req.url.endsWith('/questions')) {
    const body = JSON.parse(Buffer.concat(bytes).toString()); posts.push(body);
    intent = { requestId: body.requestId, resolutionId: body.requestId, state: loseResponse ? 'unknown' : 'answered', questionSha256: sha };
    item.nativeQuestions.intents = [intent]; input.answerable = false;
    if (loseResponse) { res.destroy(); return; }
  } else if (req.method === 'POST' && req.url.endsWith('/resume')) {
    resumes++; assert.equal(req.url.split('/').at(-2), intent.requestId);
    assert.deepEqual(JSON.parse(Buffer.concat(bytes).toString()), {});
    intent.state = 'answered';
  } else if (req.method === 'GET' && req.url.includes('/question-intents/')) { reads++; intent.state = 'answered'; }
  else { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ workId, intent }));
});
(async () => {
  fs.mkdirSync(report, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE_PATH && { executablePath: process.env.BROWSER_EXECUTABLE_PATH }) });
  const context = await browser.newContext({ viewport: { width: 1040, height: 800 } });
  const page = await context.newPage(); const errors = []; const browserPosts = []; page.on('request', req => { if (req.method() === 'POST') browserPosts.push(req.url()); }); page.on('pageerror', e => errors.push(e.message));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    item = initial(); await page.goto(url); await page.getByText(input.questions[0].question).waitFor();
    await page.screenshot({ path: path.join(report, 'question-desktop.png'), fullPage: true });
    await page.getByLabel('Mardi', { exact: true }).check();
    await page.getByLabel('Autre réponse').fill('Wednesday');
    assert.equal(await page.getByLabel('Mardi', { exact: true }).isChecked(), false);
    await page.getByRole('button', { name: 'Envoyer cette réponse' }).click();
    await page.getByText('Réponse reçue.', { exact: true }).waitFor();
    assert.deepEqual(posts[0].answers, { answers: { day: ['Wednesday'] } });
    assert.deepEqual(posts[0].basis, basis);

    // The journal contains references only and a reload performs no second POST.
    await page.evaluate(() => sessionStorage.clear()); posts = []; item = initial(); input.answerable = true; loseResponse = true;
    await page.reload(); await page.getByLabel('Mardi', { exact: true }).check();
    await page.getByRole('button', { name: 'Envoyer cette réponse' }).click();
    await page.getByText(/Envoi à vérifier/).waitFor(); assert.ok(posts.length >= 1);
    const originalPostCount = posts.length; assert.equal(new Set(posts.map(post => post.requestId)).size, 1);
    assert.equal(new Set(posts.map(post => JSON.stringify(post))).size, 1);
    const lostId = posts[0].requestId;
    const journal = await page.evaluate(() => Object.values(sessionStorage).join(''));
    assert.equal(journal.includes('Tuesday'), false); assert.equal(journal.includes('Quel jour'), false);
    await page.reload(); await page.getByRole('button', { name: 'Vérifier la réponse' }).click();
    await page.waitForFunction(() => document.querySelector('main').textContent.includes('Réponse reçue.'));
    assert.equal(posts.length, originalPostCount); assert.ok(reads >= 1); assert.equal(intent.resolutionId, lostId);

    // A known never-admitted intent has an explicit resume using the same UUID.
    intent = { requestId: originalId, resolutionId: originalId, questionSha256: sha, state: 'accepted' };
    item = initial(); item.nativeQuestions.intents = [intent]; input.answerable = false;
    await page.reload(); await page.getByRole('button', { name: 'Reprendre cet envoi' }).click();
    await page.getByText('Réponse reçue.', { exact: true }).waitFor();
    assert.equal(resumes, 1); assert.equal(posts.length, originalPostCount); assert.equal(intent.requestId, originalId);
    await page.setViewportSize({ width: 390, height: 844 });
    item = initial(); item.nativeQuestions.intents = []; input.answerable = true;
    await page.evaluate(() => sessionStorage.clear()); await page.reload();
    await page.getByText(input.questions[0].question).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(report, 'question-mobile.png'), fullPage: true });
    item = { id: workId, sessionId: 'fixture-owner', nativeQuestions: { supported: false, questions: [], intents: [] } };
    await page.evaluate(() => window.mount());
    await page.getByText('Question indisponible. Actualise son état.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Envoyer cette réponse' }).count(), 0);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify({ status: 'passed', checks: ['explicit-submit', 'single-other', 'lost-response-lookup-only', 'accepted-resume-same-id', 'mobile'], posts: posts.length, browserPostEvents: browserPosts.length, identicalInitialTransportPosts: originalPostCount, reads, resumes }, null, 2));
    console.log('Native question browser fixture passed: explicit form, Other, lost response/reload lookup, same-intent resume, mobile.');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
