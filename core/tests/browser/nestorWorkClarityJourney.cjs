'use strict';
// Real request cards and controls against deterministic local Core responses.
// No model, speech service, native executor or production database is used.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const express = require('express'), { chromium } = require('playwright');
const core = path.resolve(__dirname, '../..'), reportDir = process.env.WORK_CLARITY_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Set WORK_CLARITY_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
const row = (id, requestText, extra = {}) => ({ id, sessionId: 'synthetic-session', turnId: id, requestText, state: 'queued', revision: 1,
  pending: true, controllable: true, classification: 'native_work', receivedAt: '2026-01-02T14:25:30Z', ...extra });
let server, browser;
(async () => {
  const app = express(); app.use('/assets/household', express.static(core + '/surfaces/household/public'));
  app.get('/', (_req, res) => res.send(`<!doctype html><html lang="fr"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demandes de Nestor</title>
    <link rel="stylesheet" href="/assets/household/conversation-work.css"><style>
      *{box-sizing:border-box}body{font:16px system-ui,sans-serif;background:#07131d;color:#edf4fc;margin:0;padding:20px}
      main{max-width:780px;margin:auto}.button{font:inherit;color:inherit;background:#1a3042;border:1px solid #486078;padding:10px 14px;border-radius:8px;cursor:pointer}
      .button:disabled{opacity:.55}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h1{font-size:1.5rem}textarea{width:100%;padding:12px;color:inherit;background:#102333;border:1px solid #486078;border-radius:8px}
      #transcript{padding:16px;border:1px solid #243746;border-radius:12px;margin:16px 0;line-height:1.6}.muted{color:#afc3d5;font-size:.9rem}
    </style><main><header><h1>Avec Nestor</h1><button class="button" id="voice">Pause de la voix</button></header>
    <p class="muted">Vos demandes et leurs résultats</p><section class="conversation-work" id="work" aria-label="Demandes de Nestor" aria-live="polite" hidden></section>
    <section id="transcript"><strong>Nestor</strong><p>Vous pouvez continuer la conversation pendant le travail.</p></section>
    <label for="message">Votre message</label><textarea id="message" rows="2" placeholder="Écrire à Nestor…"></textarea></main>
    <script src="/assets/household/conversation-work.js"></script><script>
      window.posts=[];window.offline=false;window.language='fr';window.cursor=3;window.dispatch=null;
      window.rows=${JSON.stringify([
        row('request-a', 'Montre-moi la page d’activité.'),
        row('request-b', 'Lis mon prochain rendez-vous.'),
        row('request-c', 'Explique ce résultat.', { classification: 'native_review', state: 'running', controllable: false, attempt: { id: 'synthetic-native' } })
      ])};
      window.feed=NestorWork.create({host:document.getElementById('work'),base:'/sessions',getLanguage:()=>language,
        getConversation:()=>({state:'paused'}),pollMs:60000,api:async(url,options)=>{
          if(offline)throw Error('offline');
          if(options?.method==='POST'){
            const command=JSON.parse(options.body);posts.push({url,...command});
            const id=url.split('/').at(-2),row=rows.find(row=>row.id===id);row.revision++;cursor++;
            row.state=command.action==='cancel'?'cancelled':command.action==='pause'?'paused':'queued';row.pending=row.state!=='cancelled';row.controllable=row.pending;
            return {id,state:row.state,revision:row.revision};
          }
          return {items:structuredClone(rows),cursor,dispatch,hasMore:false};
        }});feed.follow('synthetic-session');
    </script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.WORK_CLARITY_BROWSER_EXECUTABLE && { executablePath: process.env.WORK_CLARITY_BROWSER_EXECUTABLE }) });
  const errors = [], results = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    const page = await browser.newPage({ viewport }); page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await page.goto(base); await page.locator('.conversation-work-card').last().waitFor();
    const first = page.locator('[data-work-id="request-a"]'), second = page.locator('[data-work-id="request-b"]');
    assert.match(await first.innerText(), /Montre-moi la page d’activité/);
    assert.match(await first.innerText(), /Le travail n’a pas commencé/);
    assert.match(await second.getByRole('button', { name: /Annuler/ }).getAttribute('aria-label'), /Lis mon prochain rendez-vous/);
    assert.equal(await page.locator('[data-work-id="request-c"] button').count(), 0);
    await page.evaluate(async () => { dispatch={state:'blocked',reason:'native_receipt_unverified'};await feed.poll(); });
    await first.getByText('Bloquée avant démarrage', { exact: true }).waitFor();
    assert.match(await first.innerText(), /Une exécution précédente doit être vérifiée/);
    await page.evaluate(async () => { dispatch=null;await feed.poll(); });
    await first.getByText('En attente de démarrage', { exact: true }).waitFor();
    const before = path.join(reportDir, `requests-${viewport.width}.png`); await page.screenshot({ path: before, fullPage: true });
    await second.getByRole('button', { name: /Annuler/ }).click();
    await second.getByText('Demande annulée', { exact: true }).waitFor();
    const posts = await page.evaluate(() => posts);
    assert.equal(posts.length, 1); assert.equal(posts[0].url, '/sessions/synthetic-session/work/request-b/control');
    assert.equal(posts[0].action, 'cancel'); assert.equal(posts[0].revision, 1);
    assert.equal(await first.getByRole('button', { name: /Annuler/ }).count(), 1);
    await first.getByRole('button', { name: /Mettre/ }).click(); await first.getByText('Demande en pause', { exact: true }).waitFor();
    await first.getByRole('button', { name: /Reprendre/ }).click(); await first.getByText('En attente de démarrage', { exact: true }).waitFor();
    await page.evaluate(async () => { offline=true; await feed.poll(); });
    assert.equal(await first.getByRole('button', { name: /Annuler/ }).isDisabled(), true);
    assert.match(await first.innerText(), /État indisponible/);
    await page.evaluate(async () => { offline=false; await feed.poll(); });
    assert.equal(await first.getByRole('button', { name: /Annuler/ }).isDisabled(), false);
    // Untrusted user text stays text, including a long request with identical prefixes.
    await page.evaluate(async () => { rows[0].requestText='Long request '.repeat(40)+'<img src=x onerror="window.injected=true">';rows[0].revision++;await feed.poll(); });
    await first.getByText('Lire la demande complète', { exact: true }).click();
    assert.match(await first.locator('details p').innerText(), /<img src=x onerror=/);
    assert.equal(await first.locator('img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.evaluate(() => { language='en';feed.refresh(); });
    assert.equal(await first.getByRole('button', { name: /Cancel this request/ }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    results.push({ viewport, screenshot: before, commands: await page.evaluate(() => posts.length) }); await page.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'browser-result.json'), JSON.stringify({ ok: true, modelCalls: 0, errors, results }, null, 2));
  console.log(JSON.stringify({ ok: true, modelCalls: 0, viewports: results.length, reportDir }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); });
