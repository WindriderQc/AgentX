/* Actual native TUI input, local /help only: no model or microphone request. */
const { chromium } = require(process.env.AGENTX_PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const url = process.env.AGENTX_HERMES_NATIVE_URL;
if (!url) throw Error('AGENTX_HERMES_NATIVE_URL must name the authorized native chat page');
const report = process.env.AGENTX_HERMES_VOICE_REPORT || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hermes-paste-'));
fs.mkdirSync(report, { recursive: true });
const source = stripTypeScriptTypes(fs.readFileSync(path.join(__dirname, '../host/chat-plugin-context.ts'), 'utf8'), { mode: 'strip' })
  .replace('export function createChatPluginContext', 'function createChatPluginContext');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    let output = '', sent = [], microphoneCalls = 0;
    await page.exposeFunction('microphoneWasCalled', () => { microphoneCalls++; });
    await page.addInitScript(() => {
      window.nativePasteSockets = [];
      const Native = WebSocket;
      window.WebSocket = class extends Native { constructor(...args) { super(...args); window.nativePasteSockets.push(this); } };
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { window.microphoneWasCalled(); return Promise.reject(Error('CPU test never records')); };
    });
    page.on('websocket', socket => {
      if (!new URL(socket.url()).pathname.endsWith('/api/pty')) return;
      socket.on('framereceived', frame => { output += frame.payload; });
      socket.on('framesent', frame => { sent.push(String(frame.payload)); });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.nativePasteSockets.some(ws => new URL(ws.url).pathname.endsWith('/api/pty') && ws.readyState === 1), { timeout: 45000 });
    // The native PTY connection opens before the native TUI has painted.
    for (let i = 0; i < 80 && !output.includes('for commands'); i++) await page.waitForTimeout(250);
    assert.ok(output.includes('for commands'), 'real native welcome must have painted');
    await page.waitForTimeout(250); output = ''; sent = [];
    await page.evaluate(async source => {
      const sockets = window.nativePasteSockets.filter(ws => new URL(ws.url).pathname.endsWith('/api/pty') && ws.readyState === 1);
      if (sockets.length !== 1) throw Error('Ambiguous native terminal');
      const create = new Function(source + ';return createChatPluginContext')();
      const chat = create({ channel: 'cpu-check', profile: 'fixture', scope: 'cpu', active: true, ready: true, getSocket: () => sockets[0], getScope: () => 'cpu' });
      await chat.submitText('/help');
    }, source);
    for (let i = 0; i < 40 && !output.includes('/new'); i++) await page.waitForTimeout(100);
    assert.ok(output.includes('/new'), 'native help executes without another Enter');
    assert.equal(sent.filter(frame => frame === '\x1b[200~/help\x1b[201~').length, 1);
    assert.equal(sent.filter(frame => frame === '\r').length, 1);
    assert.equal(microphoneCalls, 0);
    const result = { nativeLocalHelpExecuted: true, pasteFrames: 1, separateEnterFrames: 1, microphoneCalls, modelRequests: 0 };
    fs.writeFileSync(path.join(report, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await page.screenshot({ path: path.join(report, 'native.png'), fullPage: true });
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
