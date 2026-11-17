'use strict';

// Production page, parser, written transport and renderer; synthetic model,
// speech and API fixtures only. No native instance, inference or GPU calls.
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const report = process.env.NESTOR_WRITTEN_REPORT_DIR;
if (!report || path.resolve(report) === root || path.resolve(report).startsWith(root + path.sep)) throw new Error('Set NESTOR_WRITTEN_REPORT_DIR outside the checkout.');
const { createReplyChannels, storedDisplay } = require('../../surfaces/household/reply-channels');
const { captureWritten } = require('../../src/services/conversations/writtenPresentation');
const written = require('../../public/js/conversation-written');
const body = 'Un détail utile qui reste entièrement disponible à l’écran. '.repeat(90) + 'DERNIER_DETAIL_UNIQUE';
const source = `Voici les points essentiels. <show kind="text" title="Explication complète">${body}</show> Dernière réserve.`;
const persona = { id: 'nestor', name: 'Nestor', version: 1, voice: { provider: 'voxcpm', source: 'instance', voices: { fr: 'gazz', en: 'gazz' } } };
const sessions = new Map(), calls = [], speech = [], errors = [];
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
function wav() {
  const pcm = Buffer.alloc(12000), header = Buffer.alloc(44);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(2000 * Math.sin(i * 2 * Math.PI * 220 / 24000)), i * 2);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture'), p = url.pathname;
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: value })); };
    if (p.startsWith('/api/')) {
      const raw = Buffer.concat(await Array.fromAsync(req));
      const input = req.headers['content-type']?.includes('application/json') && raw.length ? JSON.parse(raw) : {};
      calls.push({ path: p, method: req.method, channel: input.channel });
      if (p === '/api/voix/player.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(root + '/integrations/voix/app/web/voice-audio.js')); }
      if (p === '/api/voice-personas/catalog') return json({ personas: [persona], runtime: { defaultBackend: 'agentx', openclawConfigured: false } });
      if (p === '/api/voice-personas/private/agents') return json({ agents: [{ id: 'main', name: 'Main', personalNotes: true }] });
      if (p === '/api/voix/catalog') return json({ providers: [{ id: 'voxcpm', name: 'Pocket TTS', available: true }],
        voices: ['fr', 'en'].map(language => ({ id: 'gazz', name: 'Gazz', provider: 'voxcpm', language, available: true })) });
      if (p === '/api/household/avatar/llmx-face.js') { res.statusCode = 503; return json({ error: 'Avatar is absent in this fixture' }); }
      if (p.endsWith('/synthesize/stream')) { speech.push(input.text); res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('X-Voix-Provider', 'voxcpm'); res.setHeader('X-Voix-Voice', 'gazz'); res.setHeader('X-Voix-Language', 'fr'); return res.end(wav()); }
      if (p.includes('conversation-preferences')) return json({ revision: 0, preferences: {} });
      if (p.endsWith('/sessions/recap/latest')) return json({ recap: null });
      if (p.endsWith('/sessions/recent')) return json({ sessions: [...sessions.values()].map(({ session }) => session).reverse() });
      if (p === '/api/voice-personas/private/sessions' && req.method === 'POST') {
        const session = { ...input, sessionId: crypto.randomUUID(), label: 'Written journey', packId: 'personal_operator',
          scopeId: 'personal', modeId: 'personal', agentId: 'main', backend: 'agentx', status: 'active', persona,
          turnCount: 0, createdAt: new Date().toISOString(), voice: input.voice || {} };
        sessions.set(session.sessionId, { session, turns: [] }); return json({ session });
      }
      const match = /\/private\/sessions\/([^/]+)(.*)/.exec(p), state = match && sessions.get(match[1]);
      if (state && match[2] === '/history') return json({ session: state.session, turns: state.turns, policy: { maximumDisplayedTurns: 100 } });
      if (state && match[2] === '/turns/text') {
        if (input.text === 'Fixture replay request') { const previous = state.turns.at(-1); res.statusCode = 202;
          return json({ traceId: previous.traceId, reply: { text: previous.replyText, language: 'fr' } }); }
        res.setHeader('Content-Type', 'application/x-ndjson');
        const event = (type, value = {}) => res.write(JSON.stringify({ type, ...value }) + '\n');
        const channels = createReplyChannels({ onWritten: value => event('written', value),
          onSay: delta => event('delta', { delta }), onShow: block => event('show', { block }) });
        for (let i = 0; i < source.length; i += 31) channels.push(source.slice(i, i + 31));
        const parsed = channels.end(), traceId = crypto.randomUUID();
        const presentation = captureWritten({ draft: parsed.written, traceId });
        const turn = { ...presentation, traceId, clientTurnId: input.turnId, inputText: input.text,
          replyText: parsed.say, display: storedDisplay(parsed.display), createdAt: new Date().toISOString() };
        state.turns.push(turn); state.session.turnCount++; state.session.lastTurnAt = turn.createdAt;
        event('say_end'); event('done', { data: { ...presentation, traceId, session: state.session,
          reply: { text: parsed.say, language: 'fr' }, display: parsed.display, continuity: {}, routing: {} } });
        return res.end();
      }
      return json({});
    }
    let file;
    if (p === '/dad') { res.setHeader('Content-Type', 'text/html'); return res.end(fs.readFileSync(root + '/core/surfaces/household/public/index.html', 'utf8')
      .replace('<!-- product-navigation -->', '<nav><span id="runtimePill"></span></nav>')); }
    if (p.startsWith('/assets/household/')) file = root + '/core/surfaces/household/public/' + p.slice('/assets/household/'.length);
    else file = root + '/core/public' + p;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) { res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); return res.end(fs.readFileSync(file)); }
    res.statusCode = 404; res.end('Missing fixture asset');
  } catch (error) { res.statusCode = 500; res.end(error.stack); }
});

(async () => {
  fs.mkdirSync(report, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port, browser = await chromium.launch({ headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'] });
  let page;
  try {
    const context = await browser.newContext();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.addInitScript(() => {
      localStorage.setItem('household.avatar.personal.layout', 'cache');
      localStorage.setItem('household.conversation.preferences.v2', JSON.stringify({ personaId: 'nestor', profiles: { nestor: { language: 'fr' } } }));
      navigator.permissions.query = async () => ({ state: 'prompt' });
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext(), destination = audio.createMediaStreamDestination();
        const oscillator = audio.createOscillator(), gain = audio.createGain();
        gain.gain.value = 0; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await audio.resume();
        for (const track of destination.stream.getTracks()) track.addEventListener('ended', () => audio.close());
        return destination.stream;
      };
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/dad'); await page.locator('#conversationMessage').waitFor();
    await page.locator('#conversationMessage').fill('Fixture typed request'); await page.locator('#conversationMessage').press('Enter');
    const transcript = page.locator('#conversationTranscript');
    await transcript.getByText('DERNIER_DETAIL_UNIQUE', { exact: false }).first().waitFor();
    await page.waitForFunction(() => document.querySelector('.written-reply-status')?.textContent === '');
    const expected = written.text([...sessions.values()][0].turns[0]);
    assert.equal(await transcript.locator('.written-reply-body').innerText(), expected);
    assert.equal((await transcript.innerText()).split('DERNIER_DETAIL_UNIQUE').length, 2);
    await page.evaluate(() => {
      const row = document.querySelector('.conversation-message.assistant'), saved = row._writtenTurn;
      WrittenReply.render(row, { ...saved, interrupted: true });
      const late = { ...saved, written: { ...saved.written, status: 'partial', segments: [{ kind: 'text', text: 'STALE_FRAGMENT' }] } };
      window.staleWrittenAccepted = WrittenReply.render(row, late);
    });
    assert.equal(await page.evaluate(() => window.staleWrittenAccepted), false);
    assert.match(await transcript.locator('.written-reply-status').innerText(), /Lecture interrompue/);
    assert.equal(await transcript.locator('.written-reply-body').innerText(), expected);
    await transcript.getByRole('button', { name: 'Copier la réponse' }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
    await transcript.locator('summary').click(); assert.equal(await transcript.locator('.written-reply-body').isVisible(), false);
    await transcript.locator('summary').click();
    await transcript.screenshot({ path: report + '/complete-written-desktop.png' });
    await page.reload();
    await page.locator('#conversationResume button').first().click();
    await transcript.locator('.written-reply-body').waitFor();
    assert.equal(await transcript.locator('.written-reply-body').innerText(), expected);
    // The same complete source remains visible while the production voice loop
    // receives only its shorter speech projection through the existing adapter.
    await page.locator('#conversationStart').click();
    await page.waitForFunction(() => document.getElementById('conversationPresence').dataset.state === 'listening');
    await page.locator('#conversationMessage').fill('Fixture request during voice'); await page.locator('#conversationMessage').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.written-reply-body').length === 2);
    await page.waitForFunction(() => document.getElementById('conversationPresence').dataset.state === 'listening');
    assert.ok(calls.some(call => call.channel === 'voice'));
    assert.ok(speech.some(text => text?.includes('points essentiels')));
    assert.ok(speech.every(text => !text?.includes('DERNIER_DETAIL_UNIQUE')));
    await page.locator('#conversationStart').click();
    await page.locator('#conversationMessage').fill('Fixture replay request'); await page.locator('#conversationMessage').press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.written-reply-body').length === 3);
    assert.equal([...sessions.values()][0].turns.length, 2, 'a recovered reply uses a read, never another generation/write');
    assert.equal(await transcript.locator('.written-reply-body').last().innerText(), expected);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await transcript.evaluate(node => { node.scrollTop = node.querySelector('.conversation-message.assistant:last-of-type').offsetTop; });
    await page.screenshot({ path: report + '/complete-written-mobile.png' });
    assert.deepEqual(errors, []);
    fs.writeFileSync(report + '/result.json', JSON.stringify({ passed: true, mode: 'synthetic CPU browser',
      checks: ['typed complete answer', 'late fragment refused', 'playback interruption preserves source', 'copy and collapse', 'history reload', 'voice projection', '202 recovery without generation', 'mobile layout'],
      calls, speech, errors }, null, 2));
    console.log(JSON.stringify({ passed: true, report }));
  } catch (error) {
    const state = page && await page.evaluate(() => ({ state: document.getElementById('conversationPresence')?.dataset.state,
      status: document.getElementById('conversationStatus')?.textContent })).catch(() => null);
    fs.writeFileSync(report + '/failure.json', JSON.stringify({ error: error.message, state, calls, speech, errors }, null, 2));
    if (page) await page.screenshot({ path: report + '/failure.png' }).catch(() => {});
    throw error;
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
