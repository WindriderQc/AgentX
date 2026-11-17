'use strict';
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs/promises'), os = require('node:os');
const express = require('express');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const { registerPhone } = require('../../surfaces/diskx/phone');
const { query } = require('../../src/services/photos/photoLibraryBrowse');
(async () => {
  const calls = [], writes = new Map(), rows = Array.from({ length: 82 }, (_, i) => ({
    sha256: i.toString(16).padStart(64,'0'), assetId: 'fixture-'+i,
    proposal: { description: i === 81 ? '<img onerror=alert(1)> Un souvenir de la montagne' : 'Un paysage de démonstration '+(i+1),
      tags: ['nature', 'demo'], quality: i % 3 ? 'bonne' : 'moyenne', frameSuitability: i >= 60 ? 'oui' : 'non',
      privacyReview: i === 80, reasons: ['Composition de démonstration'] },
    metadata: { type: 'IMAGE', exif: { city: 'Ville de démonstration', dateTimeOriginal: '2026-01-02T12:00:00Z' } },
    review: { revision: 0, approved: false }, frame: { revision: 0, selected: false },
  }));
  let effects = 0, lose = true, unavailable = false;
  const paused = { paused: true, revision: 5, inFlight: [] };
  function library(input) {
    query(input);
    const matches = rows.filter(r => (!input.search || r.proposal.description.toLowerCase().includes(input.search.toLowerCase()))
      && (!input.quality || input.quality === 'all' || r.proposal.quality === input.quality)
      && (!input.filter || input.filter === 'all' || input.filter === 'suggested' && r.proposal.frameSuitability === 'oui' && !r.frame.selected
        || input.filter === 'frame' && r.frame.selected || input.filter === 'review' && !r.review.approved
        || input.filter === 'reviewed' && r.review.approved || input.filter === 'privacy' && r.proposal.privacyReview));
    return { configured: true, frameEnabled: true, control: paused, total: matches.length, offset: input.offset || 0, limit: input.limit || 60,
      summary: { total: rows.length, suggested: rows.filter(r => r.proposal.frameSuitability === 'oui' && !r.frame.selected).length,
        frame: rows.filter(r => r.frame.selected).length, review: rows.filter(r => !r.review.approved).length,
        reviewed: rows.filter(r => r.review.approved).length, privacy: 1 },
      results: structuredClone(matches.slice(input.offset || 0, (input.offset || 0)+(input.limit || 60))) };
  }
  const processing = {
    status: () => ({ configured: true }), control: async () => paused,
    library: async input => { calls.push(input); if (unavailable) throw Error('Fixture offline'); return library(input); },
    frame: async input => {
      calls.push(input); const row = rows.find(r => r.sha256 === input.sha256);
      if (writes.has(input.writeId)) return writes.get(input.writeId);
      effects++; row.frame = { selected: input.selected, revision: input.expectedRevision+1 };
      writes.set(input.writeId, row.frame);
      if (lose) { lose = false; throw Error('Fixture lost reply'); }
      return row.frame;
    },
    review: async input => {
      calls.push(input); const row = rows.find(r => r.sha256 === input.sha256);
      row.review = { approved: input.approved, description: input.description, tags: input.tags, revision: input.expectedRevision+1 }; return row.review;
    },
  };
  const app = express();
  app.use('/assets/diskx', express.static(path.join(__dirname,'../../surfaces/diskx/public')));
  app.get('/api/photos/assets/:id/thumbnail', (req,res) => {
    const i = Number(req.params.id.replace('fixture-','')) || 0, hue = (i*17)%80;
    res.type('svg').send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="hsl(${hue+170},35%,78%)"/><stop offset="1" stop-color="#f7e9c5"/></linearGradient></defs><rect width="640" height="480" fill="url(#s)"/><circle cx="${440+i%70}" cy="110" r="48" fill="#fff4c9"/><path d="M0 390L200 140L440 430L600 210L640 400V480H0" fill="hsl(${hue+90},18%,43%)"/><path d="M0 460L280 310L640 450V480H0" fill="hsl(${hue+100},20%,27%)"/></svg>`);
  });
  registerPhone({ app, express, processing, bridge: { call: async () => { throw Error('Phone must not be accessed'); } } });
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  const browser = await chromium.launch({ headless:true, ...(process.env.AGENTX_BROWSER_EXECUTABLE ? { executablePath:process.env.AGENTX_BROWSER_EXECUTABLE } : {}) });
  const report = process.env.AGENTX_BROWSER_REPORT_DIR || path.join(os.tmpdir(),'agentx-photo-library'); await fs.mkdir(report,{recursive:true});
  try {
    const page = await browser.newPage({ viewport:{width:1440,height:1100}, reducedMotion:'reduce' }), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const url=`http://127.0.0.1:${server.address().port}/diskx/photos`;
    await page.goto(url); await page.locator('.global-photo').first().waitFor();
    assert.equal(await page.locator('.global-photo').count(),60);
    assert.equal(await page.locator('#total-count').textContent(),'82');
    assert.match(await page.locator('#analysis-control').textContent(),/Analyses en pause/);
    await page.screenshot({path:path.join(report,'photo-library-desktop.png'),fullPage:false});
    await page.locator('.compare-photo').first().click(); await page.locator('#global-next').click();
    await page.waitForFunction(()=>document.getElementById('library-status').textContent.startsWith('61–82'));
    assert.equal(await page.locator('.global-photo').count(),22);
    await page.locator('.compare-photo').first().click();
    await page.locator('#show-comparison').click(); assert.equal(await page.locator('.library-comparison figure').count(),2);
    await page.locator('#detail-close').click();
    await page.locator('[data-filter=suggested]').click(); await page.waitForFunction(()=>document.getElementById('library-status').textContent.includes('sur 22 images'));
    assert.equal(await page.locator('.global-photo').count(),22); assert.equal(await page.locator('#total-count').textContent(),'82');
    await page.locator('.photo-open').first().click(); await page.getByRole('button',{name:'Ajouter au Cadre Photo',exact:true}).click();
    await page.getByRole('button',{name:'Reprendre mon choix Cadre',exact:true}).waitFor();
    await page.getByRole('button',{name:'Reprendre mon choix Cadre',exact:true}).click();
    await page.getByRole('button',{name:'Retirer du Cadre Photo',exact:true}).waitFor();
    assert.equal(effects,1); const attempts=calls.filter(x=>x.op==='frame'); assert.equal(attempts.length,2); assert.deepEqual(attempts[0],attempts[1]);
    assert.equal(await page.locator('#frame-count').textContent(),'1');
    await page.locator('summary').filter({hasText:'Relire et corriger'}).click();
    await page.getByLabel('Ta description',{exact:true}).fill('Description corrigée de démonstration');
    page.once('dialog',d=>d.dismiss()); await page.keyboard.press('Escape'); assert.equal(await page.locator('#photo-detail').evaluate(d=>d.open),true);
    await page.getByRole('button',{name:'Enregistrer ma relecture',exact:true}).click();
    await page.locator('.detail-feedback').filter({hasText:'Relecture enregistrée'}).waitFor();
    await page.locator('#detail-close').click();
    await page.locator('#global-search').fill('montagne'); await page.locator('#library-search').evaluate(f=>f.requestSubmit());
    await page.waitForFunction(()=>document.getElementById('library-status').textContent.includes('sur 1 image'));
    assert.equal(await page.locator('.global-photo').count(),1);
    assert.equal(await page.locator('.global-photo h3 img').count(),0); assert.match(await page.locator('.global-photo h3').textContent(),/<img/);
    assert.match(page.url(),/search=montagne/);
    await page.reload(); await page.locator('.global-photo').first().waitFor(); assert.equal(await page.locator('.global-photo').count(),1);
    unavailable=true; await page.locator('#refresh-library').click(); await page.locator('#library-error').waitFor(); assert.equal(await page.locator('.global-photo').count(),0);
    assert.match(await page.locator('#analysis-control').textContent(),/indisponible/);
    unavailable=false; await page.locator('#retry-library').click(); await page.locator('.global-photo').first().waitFor();
    await page.locator('#reset-filters').click(); await page.waitForFunction(()=>document.querySelectorAll('.global-photo').length===60);
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(report,'photo-library-mobile.png'),fullPage:false});
    await page.locator('.photo-open').first().click();
    assert.equal(await page.locator('#photo-detail').evaluate(d=>d.scrollWidth<=d.clientWidth+1),true);
    await page.locator('#detail-close').click();
    assert.deepEqual(errors,[]); assert(calls.every(x=>['library','frame','review'].includes(x.op)));
    console.log(JSON.stringify({passed:true,globalPagination:true,crossPageComparison:true,lostDecisionReconciled:true,desktopMobile:true,pausePreserved:true,modelOrPhoneCalls:0}));
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
