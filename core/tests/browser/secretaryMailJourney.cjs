'use strict';
// Loopback server and synthetic mailbox only. No Gmail, Core deployment or model.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const tree = path.resolve(__dirname, '../../..');
const req = createRequire(tree + '/core/package.json');
const express = req('express');
const { dadDesk } = req('./surfaces/household/briefing');
const { chromium } = require('playwright');
const reportDir = process.env.SECRETARY_MAIL_REPORT_DIR;
if (!reportDir || path.resolve(reportDir).startsWith(tree + path.sep)) throw Error('Set SECRETARY_MAIL_REPORT_DIR outside the checkout');
fs.mkdirSync(reportDir, { recursive: true });
const tid = 'aaaaaaaaaaaaaaaa', other = 'bbbbbbbbbbbbbbbb';
const displayed = '1111111111111111', unseen = '2222222222222222', paged = '3333333333333333';
const token = 'opaque; <&" page';
const checks = [], errors = [];
let browser, server, handled = [], current = displayed, pageReads = 0;
const row = (threadId, mid) => ({ threadId, messageIds: [mid], messageCount: 1, unread: true,
  from: 'Synthetic sender', date: '2030-01-01', subject: 'Synthetic <img src=x onerror=alert(1)>', gmailUrl: `https://mail.google.com/mail/#all/${threadId}` });
(async () => {
  const app = express();
  app.use(express.json());
  app.get('/api/secretary/desk', (_q, res) => res.json({ data: dadDesk({ data: { alerts: {}, memoryReview: {} } }, [], { data: [] },
    new Date('2030-01-01T00:00:00Z'), {}, {}, {}, {}, { known: true, journalPending: 1,
      objectiveReviews: [{ objectiveId: 'life-timeline', version: 'v1', phase: 'failed' }] }) }));
  app.get('/api/secretary/mail', (q, res) => {
    if (q.query.label !== 'urgent') return res.json({ data: { count: 0, threads: [], more: false } });
    if (q.query.pageToken) {
      assert.equal(q.query.pageToken, token); pageReads++;
      return res.json({ data: { count: 1, threads: [row(other, paged)], more: false } });
    }
    return res.json({ data: { count: 1, threads: [row(tid, current)], more: true, nextPageToken: token } });
  });
  app.post('/api/secretary/mail/handled', (q, res) => {
    assert.deepEqual(q.body.messageIds, [displayed]);
    assert.equal(q.body.threadId, tid);
    handled.push(q.body);
    current = unseen; // A new urgent reply arrives at acknowledgement time.
    res.json({ data: { verified: true, scope: 'messages', messageIds: [displayed] } });
  });
  app.use('/api', (_q, res) => res.json({ data: { items: [], ideas: [], profiles: [], chores: [], rules: [], counts: {} } }));
  app.use('/assets/household', express.static(tree + '/core/surfaces/household/public'));
  app.use('/css', express.static(tree + '/core/public/css'));
  const styles = [...fs.readFileSync(tree + '/core/surfaces/household/public/index.html', 'utf8').matchAll(/<link rel="stylesheet"[^>]+>/g)].map(m => m[0]).join('');
  app.get('/', (_q, res) => res.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body class="household-product"><main id="app"></main><script src="/assets/household/personal-finding-view.js"></script><script src="/assets/household/personal-task-review.js"></script><script src="/assets/household/personal-actions.js"></script><script src="/assets/household/dad-day.js"></script><script>
  window.HouseholdShopping={mount(){}};
  window.HouseholdDadDay.load({app:document.getElementById('app'),api:async(url,options)=>{const r=await fetch(url,{...options,headers:{'Content-Type':'application/json'}});return(await r.json()).data;},esc:x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),toast(){},setRuntime(){},speak(){},clock(){}});
  </script></body></html>`));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  for (const [device, width] of [['desktop', 1440], ['mobile', 390], ['narrow', 320]]) {
    current = displayed; handled = []; pageReads = 0;
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#dadSecretaryNotice').isVisible(), true);
    assert.match(await page.locator('#dadSecretaryNotice').textContent(), /Relecture historique arrêtée/);
    await page.locator('#dad-mail-actions').evaluate(el => { el.open = true; el.hidden = false; });
    await page.getByRole('button', { name: 'Voir les messages suivants' }).click();
    await page.locator(`[data-mail-messages="${paged}"]`).waitFor();
    assert.equal(pageReads, 1);
    assert.equal(await page.locator('#dadMailUrgent img').count(), 0);
    const action = page.locator(`[data-mail-messages="${displayed}"]`);
    await action.focus(); await page.keyboard.press('Enter');
    await page.locator(`[data-mail-messages="${unseen}"]`).waitFor();
    assert.equal(handled.length, 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    assert.equal(overflow, false);
    await page.screenshot({ path: path.join(reportDir, `${device}-mail.png`), fullPage: true });
    checks.push({ device, visibleStoppedReview: true, opaquePagination: true, exactDisplayedSelection: true, newReplyRetained: true, escapedMetadata: true, keyboardActivation: true, noOverflow: true });
    await page.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(reportDir, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
