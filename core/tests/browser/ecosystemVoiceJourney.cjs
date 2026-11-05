'use strict';
// Actual Core route, GraphysX embed, Nestor adapter and Web Audio player.
// Only the catalog and speech bytes are synthetic; no model or installed service is called.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../../..');
const bundle = process.env.DISKX_TEST_MODULE;
const report = process.env.ECOSYSTEM_BROWSER_REPORT;
if (!bundle || !report) throw new Error('DISKX_TEST_MODULE and ECOSYSTEM_BROWSER_REPORT required');
fs.mkdirSync(report, { recursive: true });
const app = express(), requests = [];
app.use(express.json());
app.get('/api/voice-personas/catalog', (_req, res) => res.json({ data: { personas: [{ id: 'nestor', voice: { provider: 'voxcpm', source: 'instance', voices: { fr: 'fixture-voice' } } }] } }));
app.get('/api/voix/player.js', (_req, res) => res.sendFile(path.join(root, 'integrations/voix/app/web/voice-audio.js')));
app.post('/api/voix/synthesize/stream', (req, res) => {
  const item = { body: req.body, res, closed: false }; requests.push(item);
  res.on('close', () => { item.closed = true; });
  res.type('application/x-ndjson');
  const samples = 800, pcm = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) pcm.writeFloatLE(Math.sin(i * Math.PI / 20) * 0.01, i * 4);
  res.write(JSON.stringify({ type: 'meta', protocol: 'voix-pcm-v1', encoding: 'f32le', channels: 1, sample_rate: 8000 }) + '\n');
  res.write(JSON.stringify({ type: 'audio', sequence: 1, samples, pcm: pcm.toString('base64') }) + '\n');
  item.release = () => res.end(JSON.stringify({ type: 'done', frames: 1, samples }) + '\n');
});
app.use('/js', express.static(path.join(root, 'core/public/js')));
app.use('/assets/household', express.static(path.join(root, 'core/surfaces/household/public')));
require('../../surfaces/diskx').register({ app, express, env: { DISKX_MODULE_URL: 'https://assets.example/embed/diskx.js' },
  fetchData: () => assert.fail('No domain data required'),
  fetchWithTimeout: async () => ({ ok: true, headers: new Map([['content-type', 'text/javascript']]), text: async () => fs.readFileSync(bundle, 'utf8') }) });
(async () => {
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], responses = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) responses.push(response.status() + ' ' + response.url()); });
    await page.addInitScript(() => {
      window.audioEvents = [];
      for (const name of ['start', 'stop']) {
        const original = AudioBufferSourceNode.prototype[name];
        AudioBufferSourceNode.prototype[name] = function (...args) { window.audioEvents.push(name); return original.apply(this, args); };
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/diskx?app=ecosystem&play=overview,frank,summary`);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state()?.presentation);
    assert.equal(requests.length, 0, 'visiting never starts speech without a click');
    await page.getByRole('button', { name: '🔊 Activer la voix', exact: true }).click();
    const count = async n => { for (let i = 0; i < 100 && requests.length < n; i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(requests.length, n); };
    await count(1);
    const first = await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation);
    assert.equal(requests[0].body.text, first.narration);
    assert.equal(requests[0].body.voice, 'fixture-voice');
    // The former seven-second overview timer must never cut an unfinished spoken phrase.
    await page.waitForTimeout(7600);
    assert.equal(await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index), 0);
    assert.ok((await page.evaluate(() => audioEvents)).includes('start'), 'real Web Audio scheduled the synthetic PCM');
    requests[0].release(); await count(2);
    await page.waitForFunction(() => document.querySelector('agentx-ecosystem').state().presentation.tour.index === 1);
    await page.getByRole('button', { name: 'Étape suivante', exact: true }).click(); await count(3);
    for (let i = 0; i < 100 && !requests[1].closed; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests[1].closed, true, 'changing stop cancels the old stream');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(requests[2].closed, true);
    assert.equal(await page.evaluate(() => document.querySelector('agentx-ecosystem').state().presentation.tour.playing), false);
    await page.getByRole('button', { name: 'Lire', exact: true }).click(); await count(4);
    assert.equal(requests[3].body.text, requests[2].body.text, 'resume reads the interrupted stop again');
    requests[3].release();
    await page.waitForFunction(() => !document.querySelector('agentx-ecosystem').state().presentation.tour.playing);
    await page.setViewportSize({ width: 390, height: 900 });
    await page.screenshot({ path: path.join(report, 'ecosystem-voice-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.getByRole('button', { name: 'Lire', exact: true }).click(); await count(5);
    await page.getByRole('button', { name: 'Quitter', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(requests[4].closed, true, 'closing releases speech');
    assert.deepEqual(errors, []); assert.deepEqual(responses, []);
    const result = { ok: true, nativeModelCalls: 0, syntheticSpeech: true, realWebAudio: true,
      checks: ['explicit activation', 'installed voice choice', 'full displayed narration', 'waits for speech completion', 'automatic next step', 'step replacement abort', 'pause abort', 'resume', 'last step stops', 'mobile controls', 'close abort'], errors, responses };
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
