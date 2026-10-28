'use strict';
// Production Nestor markup/component, synthetic photos, loopback only. No mic/model.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const express = require('express');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const core = path.resolve(__dirname, '../..');
const output = process.env.IDLE_PHOTOS_REPORT_DIR;
if (!output || path.resolve(output).startsWith(path.resolve(core, '..') + path.sep)) throw Error('Set IDLE_PHOTOS_REPORT_DIR outside checkout');
fs.mkdirSync(output, { recursive: true });
const source = fs.readFileSync(core + '/surfaces/household/public/conversation-page.js', 'utf8').replace(/\r\n/g, '\n');
const template = source.match(/app.innerHTML = (`[\s\S]*?`);\n  const el/)[1];
const markup = new Function('family', 'personas', 'agents', 'runtime', 'esc', 'return ' + template)(false, [], [], {}, String);
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ID2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let browser, server;
(async () => {
  const app = express();
  app.use('/assets/household', express.static(core + '/surfaces/household/public'));
  app.get('/api/photos/frame/:id/image', (req, res) => {
    if (req.params.id.startsWith('c')) return res.sendStatus(503);
    res.type('image/svg+xml').send('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#183f60"/><circle cx="1250" cy="180" r="80" fill="#f2cd80"/><path d="M0 850L480 260L950 850L1250 440L1600 850Z" fill="#439b93"/></svg>');
  });
  app.get('/fixture', (_req, res) => res.send(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Nestor photo fixture</title>${['app','conversation-experience','workflow-cockpit','page-presentation','idle-photos'].map(name => '<link rel="stylesheet" href="/assets/household/' + name + '.css">').join('')}
    <body><main id="app">${markup}</main>
    <script src="/assets/household/screen-commands.js"></script><script src="/assets/household/idle-photos.js"></script>
    <script>
      window.clockNow = 0; window.requests = []; window.busy = false; window.mode = 'normal'; window.calls = {};
      window.session = {sessionId:'fixture-conversation',turns:['existing conversation']};
      document.getElementById('conversationTranscript').textContent = 'Existing conversation stays here.';
      document.getElementById('conversationWorkflow').innerHTML = '<details><summary>Flow</summary>Microphone diagnostics</details>';
      const start = document.getElementById('conversationStart'); start.hidden = false; start.disabled = false;
      start.onclick = () => { calls.micro = (calls.micro || 0) + 1; };
      const api = async url => {
        requests.push(url);
        if (url.endsWith('/status')) return {enabled:true,idleSeconds:30,intervalSeconds:5};
        if (mode === 'empty') return null;
        if (mode === 'error') throw Error('Synthetic unavailable API');
        if (mode === 'defer') return new Promise(resolve => { window.resolvePhoto = resolve; });
        if (mode === 'malformed') return {id:'${ID}',src:'https://invalid.example/private'};
        const id = mode === 'bad-image' ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : url.includes('exclude=') ? '${ID2}' : '${ID}';
        return {id,src:'/api/photos/frame/' + id + '/image'};
      };
      window.frame = NestorIdlePhotos.mount({
        host:document.querySelector('.conversation-toolbar'), api, busy:() => busy, now:() => clockNow,
        controls:{
          Settings:() => { calls.settings = (calls.settings || 0) + 1; document.getElementById('conversationSettings').hidden = false; },
          Flow:() => { calls.flow = (calls.flow || 0) + 1; document.querySelector('#conversationWorkflow details').open = true; },
          'Diagnostic micro':() => { calls.diagnostics = (calls.diagnostics || 0) + 1; },
          'Micro · activer / pause':() => start.click()
        }
      });
    </script></html>`));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({headless:true,...(process.env.AGENTX_BROWSER_EXECUTABLE && {executablePath:process.env.AGENTX_BROWSER_EXECUTABLE})});
  const results = [], errors = [];
  for (const viewport of [{width:1440,height:1000},{width:390,height:844}]) {
    const context = await browser.newContext({viewport,hasTouch:true});
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', err => errors.push(err.message));
    await page.goto(origin + '/fixture');
    await page.getByRole('button', {name:'Photos en veille'}).waitFor();
    const shown = () => page.waitForFunction(() => frame.active());
    const hide = () => page.waitForFunction(() => !frame.active());
    const enter = async () => {
      await page.evaluate(() => { document.activeElement?.blur(); busy = false; mode = 'normal'; clockNow += 31000; frame.tick(); });
      await shown();
    };
    await page.evaluate(() => { clockNow = 29000; frame.tick(); });
    assert.equal(await page.evaluate(() => requests.filter(url => !url.endsWith('/status')).length), 0, 'no image before inactivity');
    await enter();
    for (const label of ['Retour à Nestor','Settings','Flow','Diagnostic micro','Micro · activer / pause']) {
      const rect = await page.locator('.nestor-idle-photos').getByRole('button',{name:label,exact:true}).boundingBox();
      assert.ok(rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height, label + ' reachable');
    }
    await page.screenshot({path:path.join(output,'frame-' + viewport.width + '.png')});
    await page.evaluate(() => { clockNow += 6000; frame.tick(); });
    await page.waitForFunction(id => document.querySelector('.nestor-idle-photos img').src.includes(id), ID2);
    assert.equal(await page.evaluate(() => requests.at(-1).includes('exclude=')), true, 'rotation uses native exclusion');
    await page.getByRole('button',{name:'Retour à Nestor',exact:true}).click(); await hide();
    assert.equal(await page.locator('#conversationTranscript').textContent(), 'Existing conversation stays here.');
    assert.equal(await page.evaluate(() => session.sessionId), 'fixture-conversation');
    await enter(); await page.locator('.nestor-idle-photos img').tap({position:{x:30,y:30}}); await hide();
    await enter(); await page.keyboard.press('Escape'); await hide();
    for (const [label,key] of [['Settings','settings'],['Flow','flow'],['Diagnostic micro','diagnostics'],['Micro · activer / pause','micro']]) {
      await page.evaluate(() => { document.getElementById('conversationSettings').hidden = true; });
      await enter(); await page.locator('.nestor-idle-photos').getByRole('button',{name:label,exact:true}).click(); await hide();
      assert.equal(await page.evaluate(key => calls[key], key), 1, label + ' routed to existing control');
    }
    await page.evaluate(() => { busy = true; clockNow += 31000; frame.tick(); });
    assert.equal(await page.evaluate(() => frame.active()), false, 'busy conversation is never covered');
    await page.evaluate(() => { busy = false; });
    await page.locator('#conversationMessage').focus();
    await page.evaluate(() => { clockNow += 31000; frame.tick(); });
    assert.equal(await page.evaluate(() => frame.active()), false, 'empty focused composer keeps focus');
    assert.equal(await page.locator('#conversationMessage').evaluate(node => node === document.activeElement), true);
    await page.locator('#conversationMessage').fill('Draft kept');
    await page.evaluate(() => { clockNow += 31000; frame.tick(); });
    assert.equal(await page.evaluate(() => frame.active()), false);
    await page.locator('#conversationMessage').fill('');
    await page.evaluate(() => {
      document.activeElement?.blur();
      const editor = document.createElement('iframe'); editor.id = 'embeddedEditor'; document.body.append(editor);
      editor.focus(); clockNow += 31000; frame.tick();
    });
    assert.equal(await page.evaluate(() => frame.active()), false, 'focused embedded page keeps focus');
    await page.evaluate(() => document.getElementById('embeddedEditor').remove());
    for (const mode of ['empty','error','malformed','bad-image']) {
      await page.evaluate(mode => { document.activeElement?.blur(); window.mode = mode; clockNow += 31000; frame.tick(); }, mode);
      await page.waitForFunction(() => !frame.active());
      // Allow a failed image decode or a rejected async API to settle.
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 40)));
      assert.equal(await page.evaluate(() => frame.active()), false, mode + ' keeps Nestor visible');
    }
    await page.evaluate(() => { mode = 'defer'; clockNow += 31000; frame.tick(); });
    await page.waitForFunction(() => !!window.resolvePhoto);
    await page.locator('#conversationMessage').fill('Still typing');
    await page.evaluate(id => resolvePhoto({id,src:'/api/photos/frame/' + id + '/image'}), ID);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 40)));
    assert.equal(await page.evaluate(() => frame.active()), false, 'late response cannot take over after user activity');
    assert.equal(await page.locator('#conversationMessage').inputValue(), 'Still typing');
    await page.locator('#conversationMessage').fill('');
    await enter();
    const outcome = await page.evaluate(() => {
      dispatchEvent(new CustomEvent('persona-presence',{detail:{space:'personal',state:'hearing'}}));
      dispatchEvent(new CustomEvent('persona-presence',{detail:{space:'personal',state:'transcribing'}}));
      return frame.localControl('Eille Nestor, ferme l’écran',{followup:false});
    });
    assert.equal(outcome.applied, true, 'existing addressed voice command returns locally after speech activity');
    await hide();
    await enter();
    assert.equal(await page.evaluate(() => frame.localControl('ferme',{followup:false})), null, 'wake standby does not accept unaddressed speech');
    await page.keyboard.press('Escape');
    await enter();
    assert.equal(await page.evaluate(() => frame.localControl('Explique cette photo',{followup:true})), null, 'real request remains a conversation request');
    await hide();
    await page.getByRole('button',{name:'Photos en veille',exact:true}).click();
    const count = await page.evaluate(() => requests.length);
    await page.evaluate(() => { clockNow += 31000; frame.tick(); });
    assert.equal(await page.evaluate(() => requests.length), count, 'disabled toggle makes no photo calls');
    await page.getByRole('button',{name:'Photos en veille',exact:true}).click(); await enter();
    await page.evaluate(() => document.getElementById('app').replaceChildren());
    await page.waitForFunction(() => !document.querySelector('.nestor-idle-photos'));
    results.push({viewport,passed:true}); await context.close();
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({ok:true,results,errors,liveModelCalls:0,privatePhotosRead:0},null,2));
  console.log(JSON.stringify({ok:true,viewports:results.length,liveModelCalls:0,output}));
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve());
});
