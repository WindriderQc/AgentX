'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const toolbox = require('../index');
const rules = require('../../../../shared/mqttTopicRules');

const publicRoot = path.resolve(__dirname, '..', 'public');
const EPOCH = '2026-10-08T20:00:00.000Z';

// Shapes of Data's /api/v1/mqtt answers; hosts, devices and values are synthetic.
const statusBody = (overrides = {}) => ({
  configured: true, connected: true, broker: 'broker.example:1883', since: EPOCH, connectedAt: EPOCH,
  received: 1284, lastMessageAt: '2026-10-08T22:35:20.000Z', lastError: null, latestSeq: 1284, buffered: 500, bufferSize: 500, ...overrides
});
const message = (seq, overrides = {}) => ({
  seq, ts: new Date(Date.parse('2026-10-08T22:00:00.000Z') + seq * 1000).toISOString(), topic: 'liveData/iss',
  payload: `{"latitude":12.5,"longitude":-45.1,"n":${seq}}`, bytes: 40, truncated: false, binary: false, retained: false, qos: 0, ...overrides
});
const messagesBody = (messages, overrides = {}) => ({
  messages, latestSeq: messages.at(-1)?.seq ?? 0, oldestSeq: 1, nextSince: messages.at(-1)?.seq ?? 0, more: false,
  dropped: false, droppedCount: 0, reset: false, epoch: EPOCH, bufferSize: 500, topic: '#', ...overrides
});

function mqttBrowser(respond) {
  const elements = {};
  const element = (selector) => (elements[selector] ||= { innerHTML: '', textContent: '', value: '', disabled: false });
  const listeners = {};
  const requests = [];
  const timers = [];
  const cleared = [];
  const document = {
    hidden: false,
    querySelector: element,
    querySelectorAll() { return []; },
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const context = {
    document, location: { hash: '#mqtt' }, console, URLSearchParams, TextEncoder, Date,
    // The tab reports every outcome inline: an alert would fail the test.
    window: { addEventListener() {}, alert(text) { throw new Error(`unexpected alert: ${text}`); } },
    setInterval(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
    fetch: async (url, options = {}) => {
      const parsed = new URL(url, 'http://localhost');
      const request = { path: parsed.pathname.replace('/api/data-toolbox', ''), query: parsed.searchParams, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined };
      requests.push(request);
      const answer = await respond(request);
      if (answer instanceof Error) {
        return { ok: false, status: answer.status || 502, json: async () => ({ ok: false, status: 'error', message: answer.message }) };
      }
      return { ok: true, status: 200, json: async () => ({ status: 'success', data: answer }) };
    }
  };
  const source = ['mqtt.js', 'app.js'].map((file) => fs.readFileSync(path.join(publicRoot, file), 'utf8')).join('\n')
    .replace(/\nrender\(\);\s*$/, '\nglobalThis.page = { state, mqttState, render, renderers, mqttTab, mqttPoll, mqttSetFilter, mqttTogglePause, mqttClear, mqttSend, mqttPublishProblem, mqttFilterProblem };');
  vm.runInNewContext(source, context);
  return { ...context.page, document, location: context.location, elements, listeners, requests, timers, cleared, content: element('#content') };
}

// A broker whose monitor holds `store.messages`; reads follow Data's contract.
function broker(store = {}) {
  store.status ||= statusBody();
  store.messages ||= [];
  return (request) => {
    if (request.path === '/mqtt/status') return store.status;
    if (request.path === '/mqtt/messages') {
      if (store.messagesError) return store.messagesError;
      const since = request.query.has('since') ? Number(request.query.get('since')) : null;
      const selected = store.messages.filter((item) => since === null || item.seq > since);
      return messagesBody(selected, { latestSeq: store.messages.at(-1)?.seq ?? 0, nextSince: store.messages.at(-1)?.seq ?? 0, topic: request.query.get('topic'), ...store.answer });
    }
    if (request.path === '/mqtt/publish') return store.publish ? store.publish(request) : new Error('unexpected publish');
    return new Error(`unexpected ${request.path}`);
  };
}

async function openMqtt(store = {}) {
  const browser = mqttBrowser(broker(store));
  await browser.render();
  return browser;
}
const stream = (browser) => browser.elements['#mqttStream']?.innerHTML || browser.content.innerHTML;
// Values built inside the page's vm context are compared as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));
const messageReads = (browser) => browser.requests.filter((request) => request.path === '/mqtt/messages');

test('the MQTT tab follows Live Data and loads its script before the page script', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  assert.match(html, /data-tab="live-data">Live Data<\/a>\s*<a href="#mqtt" data-tab="mqtt">MQTT<\/a>\s*<a href="#janitor"/);
  assert.ok(html.indexOf('/assets/data-toolbox/mqtt.js') > 0);
  assert.ok(html.indexOf('/assets/data-toolbox/mqtt.js') < html.indexOf('/assets/data-toolbox/app.js'));
  // No raw-HTML sink for network text, and no blocking dialog.
  const source = fs.readFileSync(path.join(publicRoot, 'mqtt.js'), 'utf8');
  assert.doesNotMatch(source, /alert\(|confirm\(|prompt\(|insertAdjacentHTML|document\.write|eval\(/);
});

test('the status projection says five write families are exposed and none on the filesystem', async (t) => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) });
  const status = await toolbox.buildStatus();
  assert.equal(status.readOnly, false);
  assert.equal(status.mutationsExposed, true);
  assert.deepEqual(status.writes, ['network-device-update', 'network-scan-request', 'mqtt-publish', 'storage-scan-request', 'janitor-review-decision']);
  assert.equal(status.filesystemMutationsExposed, false);
  assert.equal(status.version, toolbox.version);
});

async function relayApp(t, respond) {
  const express = require('express');
  const original = global.fetch;
  const calls = [];
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    return respond ? respond(url, options) : { ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: {} }) };
  };
  const app = express();
  app.use(express.json());
  toolbox.register({ contractVersion: 2, app, express });
  return { app, calls, request: require('supertest') };
}

test('the MQTT read relays keep bounded since, limit and topic, and nothing else', async (t) => {
  const { app, calls, request } = await relayApp(t);
  await request(app).get('/api/data-toolbox/mqtt/status?verbose=1&password=x').expect(200);
  assert.equal(calls[0].url.pathname, '/api/v1/mqtt/status');
  assert.equal(calls[0].url.search, '');

  await request(app).get('/api/data-toolbox/mqtt/messages?since=120&limit=50&topic=esp32%2F%2B%2Fio%2F%23&retain=true&$where=1').expect(200);
  assert.equal(calls[1].url.pathname, '/api/v1/mqtt/messages');
  assert.deepEqual(Object.fromEntries(calls[1].url.searchParams), { since: '120', limit: '50', topic: 'esp32/+/io/#' });
  assert.match(calls[1].url.search, /topic=esp32%2F%2B%2Fio%2F%23/, 'the wildcards stay encoded on the way to Data');

  await request(app).get(`/api/data-toolbox/mqtt/messages?since=-5&limit=999999&topic=${'t'.repeat(400)}`).expect(200);
  assert.equal(calls[2].url.searchParams.get('since'), '0');
  assert.equal(calls[2].url.searchParams.get('limit'), '500');
  assert.equal(calls[2].url.searchParams.get('topic').length, 256);

  await request(app).get('/api/data-toolbox/mqtt/messages?since=later&limit=0&since=7').expect(200);
  assert.deepEqual(Object.fromEntries(calls[3].url.searchParams), { since: '0', limit: '1' });
  await request(app).get('/api/data-toolbox/mqtt/messages').expect(200);
  assert.equal(calls[4].url.search, '');
  assert.ok(calls.every((call) => (call.options.method || 'GET') === 'GET'));
});

test('the publish relay forwards topic, payload and retain only, after Data\'s own checks', async (t) => {
  const { app, calls, request } = await relayApp(t, async () => ({ ok: true, status: 200,
    text: async () => JSON.stringify({ status: 'success', data: { topic: 'esp32/kitchen/io/2/on', bytes: 2, retain: false, qos: 0 } }) }));
  const sent = await request(app).post('/api/data-toolbox/mqtt/publish').send({ topic: 'esp32/kitchen/io/2/on', payload: 'on' }).expect(200);
  assert.equal(sent.body.data.bytes, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, '/api/v1/mqtt/publish');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { topic: 'esp32/kitchen/io/2/on', payload: 'on', retain: false });

  // Any topic is allowed; an empty payload and the size limits are too.
  await request(app).post('/api/data-toolbox/mqtt/publish').send({ topic: 'x'.repeat(256), payload: '', retain: true }).expect(200);
  assert.deepEqual(JSON.parse(calls[1].options.body), { topic: 'x'.repeat(256), payload: '', retain: true });
  await request(app).post('/api/data-toolbox/mqtt/publish').send({ topic: 'garden/pump', payload: 'y'.repeat(4096) }).expect(200);
  assert.equal(calls.length, 3);

  const refused = [
    [{ payload: 'x' }, /topic must be a non-empty string/],
    [{ topic: '', payload: 'x' }, /topic must be a non-empty string/],
    [{ topic: ['esp32'], payload: 'x' }, /topic must be a non-empty string/],
    [{ topic: 'x'.repeat(257), payload: 'x' }, /topic must be at most 256 bytes/],
    [{ topic: 'esp32/#', payload: 'x' }, /must not contain the wildcards # or \+/],
    [{ topic: 'esp32/+/reboot', payload: 'x' }, /must not contain the wildcards # or \+/],
    [{ topic: 'esp32/\u0000x', payload: 'x' }, /NUL/],
    [{ topic: '$SYS/broker', payload: 'x' }, /must not start with \$/],
    [{ topic: 'esp32/a' }, /payload must be a string/],
    [{ topic: 'esp32/a', payload: 12 }, /payload must be a string/],
    [{ topic: 'esp32/a', payload: 'x'.repeat(4097) }, /payload must be at most 4096 bytes/],
    [{ topic: 'esp32/a', payload: 'x', retain: 'true' }, /retain must be true or false/],
    [{ topic: 'esp32/a', payload: 'x', qos: 2 }, /Unknown field: qos/],
    [{ topic: 'esp32/a', payload: 'x', retain: false, clientId: 'x', dup: true }, /Unknown field: clientId, dup/],
    [[{ topic: 'esp32/a', payload: 'x' }], /Expected a JSON object/]
  ];
  for (const [body, expected] of refused) {
    const response = await request(app).post('/api/data-toolbox/mqtt/publish').send(body).expect(400);
    assert.equal(response.body.code, 'INVALID_MQTT_PUBLISH');
    assert.match(response.body.message, expected);
  }
  assert.equal(calls.length, 3, 'a refused body never reaches Data');
  // No other MQTT write exists.
  await request(app).post('/api/data-toolbox/mqtt/messages').send({}).expect(404);
  await request(app).delete('/api/data-toolbox/mqtt/messages').expect(404);
  await request(app).post('/api/data-toolbox/mqtt/subscribe').send({ topic: '#' }).expect(404);
});

test('a broker that is down, a Data outage and a Data timeout reach the page as distinct errors', async (t) => {
  let mode = 'offline';
  const { app, request } = await relayApp(t, async () => {
    if (mode === 'offline') return { ok: false, status: 503, text: async () => JSON.stringify({ status: 'error', message: 'MQTT broker is not connected. The message was not sent and is not queued.' }) };
    if (mode === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    throw new Error('fetch failed');
  });
  const body = { topic: 'esp32/kitchen/reboot', payload: '' };
  const offline = await request(app).post('/api/data-toolbox/mqtt/publish').send(body).expect(503);
  assert.match(offline.body.message, /not connected\. The message was not sent and is not queued/);
  mode = 'timeout';
  const timeout = await request(app).post('/api/data-toolbox/mqtt/publish').send(body).expect(502);
  assert.equal(timeout.body.code, 'DATA_TIMEOUT');
  assert.match(timeout.body.message, /may or may not have been sent/);
  mode = 'down';
  const down = await request(app).post('/api/data-toolbox/mqtt/publish').send(body).expect(502);
  assert.equal(down.body.code, 'DATA_UNAVAILABLE');
  assert.equal((await request(app).get('/api/data-toolbox/mqtt/status').expect(502)).body.code, 'DATA_UNAVAILABLE');
});

test('a connected broker shows its state, the stream newest first and the send form', async () => {
  const browser = await openMqtt({ messages: [
    message(1, { topic: 'liveData/pressure/46.81,-71.21', payload: '{"pressure":1013.2}', bytes: 19 }),
    message(2),
    message(3, { topic: 'esp32/register', payload: 'kitchen', bytes: 7, retained: true })
  ] });
  const html = browser.content.innerHTML;
  assert.match(html, /<h2>MQTT<\/h2>/);
  const status = html.match(/<section id="mqttStatus".*?<\/section>/s)[0];
  assert.match(status, /<span class="pill good">connected<\/span>/);
  assert.match(status, /Broker<\/span><strong class="mono">broker\.example:1883/);
  assert.match(status, /Messages received<\/span><strong>1,284/);
  assert.match(status, /Last message<\/span><strong>[^<]+<span class="muted">/);
  assert.doesNotMatch(status, /Last error|Not connected/);

  const rows = html.match(/<section id="mqttStream".*?<\/section>/s)[0].split('<tr><td').slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /class="mono">esp32\/register<\/td>/);
  assert.match(rows[0], /<pre class="mqtt-payload">kitchen<\/pre>/);
  assert.match(rows[0], /7 B/);
  assert.match(rows[0], /pill warn">retained/);
  assert.match(rows[1], /liveData\/iss/);
  assert.doesNotMatch(rows[1], /retained/);
  assert.match(rows[2], /liveData\/pressure\/46\.81,-71\.21/);

  // First read: the newest messages Data holds, no `since`.
  assert.deepEqual(Object.fromEntries(messageReads(browser)[0].query), { limit: '300', topic: '#' });
  for (const filter of ['#', 'esp32/#', 'liveData/#', 'sensors/#']) assert.ok(html.includes(`data-mqtt-filter="${filter}"`), filter);
  assert.match(html, /<strong>These messages reach real devices\.<\/strong> A message can switch an output or reboot a device/);
  assert.ok(html.indexOf('These messages reach real devices') < html.indexOf('<form id="mqttSend"'));
  assert.match(html, /<input id="mqttTopic" name="topic" class="mono" value="esp32\/"/);
  assert.match(html, /<textarea id="mqttPayload" name="payload"[^>]*><\/textarea>/);
  assert.match(html, /<input type="checkbox" name="retain"> Retain <span class="muted">— the broker keeps a retained message and delivers it again to every device that subscribes later\./);
  assert.equal(browser.elements['#mqttSendButton'].disabled, false);
  assert.equal(browser.timers.length, 1);
  assert.equal(browser.timers[0].ms, 2000);
});

test('not configured, not connected and Data unavailable are explained, not shown as an empty stream', async () => {
  let browser = await openMqtt({ status: statusBody({ configured: false, connected: false, broker: null, received: 0, lastMessageAt: null }) });
  assert.match(browser.content.innerHTML, /<strong>Broker not configured\.<\/strong> Data has no MQTT broker to connect to\. Set <code>MQTT_BROKER_URL<\/code> in Data's environment/);
  assert.match(browser.content.innerHTML, /No broker is configured on Data, so there is no stream\./);
  assert.equal(browser.elements['#mqttSendButton'].disabled, true);

  browser = await openMqtt({ status: statusBody({ connected: false, connectedAt: null, lastError: 'connect ECONNREFUSED 192.0.2.10:1883' }), messages: [message(1)] });
  const status = browser.content.innerHTML.match(/<section id="mqttStatus".*?<\/section>/s)[0];
  assert.match(status, /<span class="pill warn">not connected<\/span>/);
  assert.match(status, /<strong>Not connected\.<\/strong> Data retries on its own every few seconds\. Nothing is received meanwhile, and a message sent now is refused, not queued\./);
  assert.match(status, /Last error<\/span><strong class="bad">connect ECONNREFUSED 192\.0\.2\.10:1883/);
  assert.match(stream(browser), /liveData\/iss/, 'what Data still holds stays readable');
  assert.equal(browser.elements['#mqttSendButton'].disabled, true);

  browser = mqttBrowser(() => new Error('fetch failed'));
  await browser.render();
  assert.match(browser.content.innerHTML, /<strong>Data unavailable\.<\/strong> The broker state could not be read from Data: fetch failed\./);
  assert.doesNotMatch(browser.content.innerHTML, /Data projection unavailable/);
  assert.equal(messageReads(browser).length, 0);

  // The stream alone failing keeps the status and says which part is stale.
  const store = { messages: [message(1)] };
  browser = await openMqtt(store);
  store.messagesError = new Error('Data service request timed out');
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttNotice'].innerHTML, /The stream could not be read from Data: Data service request timed out\. The rows below are the last ones read\./);
  assert.match(browser.elements['#mqttStream'].innerHTML, /liveData\/iss/);
  store.messagesError = null;
  await browser.timers[0].callback();
  assert.doesNotMatch(browser.elements['#mqttNotice'].innerHTML, /could not be read/);
});

test('topics and payloads are untrusted text: escaped everywhere, never markup', async () => {
  const hostile = '<script>alert("x")</script><img src=x onerror=\'steal()\'>&amp;';
  const browser = await openMqtt({
    status: statusBody({ broker: '<b>broker</b>', lastError: '<script>bad()</script>' }),
    messages: [
      message(1, { topic: 'esp32/<script>alert(1)</script>', payload: hostile }),
      message(2, { topic: 'esp32/"quoted"', payload: `${hostile}\n`.repeat(40) })
    ]
  });
  const html = browser.content.innerHTML;
  assert.doesNotMatch(html, /<script|<img|<b>broker/i);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;img src=x onerror=&#39;steal()&#39;&gt;&amp;amp;'));
  assert.ok(html.includes('esp32/&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('esp32/&quot;quoted&quot;'));
  assert.ok(html.includes('&lt;b&gt;broker&lt;/b&gt;'));
  // The long one is collapsed behind an escaped summary.
  assert.match(html, /<details data-mqtt-seq="2"><summary class="mono">&lt;script&gt;/);

  // An error text and the echo of a sent topic are escaped too.
  browser.mqttState.status = { data: statusBody() };
  await browser.mqttSend({ topic: '<i>x</i>', payload: 'p' });
  assert.match(browser.elements['#mqttOutcome'].innerHTML, /Not sent: unexpected publish/);
  const failing = await openMqtt({ publish: () => new Error('<script>no()</script>') });
  await failing.mqttSend({ topic: 'esp32/a', payload: '' });
  assert.ok(failing.elements['#mqttOutcome'].innerHTML.includes('Not sent: &lt;script&gt;no()&lt;/script&gt;'));
  // A filter typed by the operator is echoed escaped as well.
  await failing.mqttSetFilter('<u>/#');
  assert.doesNotMatch(failing.elements['#mqttControls'].innerHTML, /<u>/);
});

test('a long, binary or cut payload is marked, and an expanded one stays expanded', async () => {
  const store = { messages: [
    message(1, { payload: 'x'.repeat(4096), bytes: 9000, truncated: true }),
    message(2, { payload: 'ff 00 10', bytes: 3, binary: true }),
    message(3, { payload: '', bytes: 0 })
  ] };
  const browser = await openMqtt(store);
  const [empty, binary, long] = browser.content.innerHTML.match(/<section id="mqttStream".*?<\/section>/s)[0].split('<tr><td').slice(1);
  assert.match(empty, /<span class="muted">\(empty\)<\/span>/);
  assert.match(empty, /0 B/);
  assert.match(binary, /<pre class="mqtt-payload">ff 00 10<\/pre>/);
  assert.match(binary, /binary, shown as hex/);
  assert.match(long, /<details data-mqtt-seq="1"><summary class="mono">x{100}…<\/summary><pre class="mqtt-payload">x{4096}<\/pre><\/details>/);
  assert.match(long, /8\.8 KiB/);
  assert.match(long, /cut for display/);

  browser.listeners.toggle[0]({ target: { dataset: { mqttSeq: '1' }, open: true } });
  store.messages.push(message(4));
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttStream'].innerHTML, /<details data-mqtt-seq="1" open>/);
  browser.listeners.toggle[0]({ target: { dataset: { mqttSeq: '1' }, open: false } });
  store.messages.push(message(5));
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttStream'].innerHTML, /<details data-mqtt-seq="1"><summary/);
});

test('the 2 s poll asks only for what is new, on a visible MQTT tab, and never redraws the form', async () => {
  const store = { messages: [message(1), message(2)] };
  const browser = await openMqtt(store);
  const whole = browser.content.innerHTML;
  const count = () => browser.requests.length;

  store.messages.push(message(3, { topic: 'esp32/kitchen/state' }));
  let before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before + 2, 'one status read and one message read');
  assert.deepEqual(Object.fromEntries(messageReads(browser).at(-1).query), { limit: '300', topic: '#', since: '2' });
  const rows = browser.elements['#mqttStream'].innerHTML.split('<tr><td').slice(1);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /esp32\/kitchen\/state/);
  assert.match(browser.elements['#mqttControls'].innerHTML, /3 messages shown/);
  assert.equal(browser.content.innerHTML, whole, 'the send form is not redrawn by a poll');

  // Nothing new: the next read starts after the last message seen.
  await browser.timers[0].callback();
  assert.equal(messageReads(browser).at(-1).query.get('since'), '3');
  assert.equal(browser.elements['#mqttStream'].innerHTML.split('<tr><td').length - 1, 3);

  browser.document.hidden = true;
  before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before, 'a hidden page asks nothing');
  browser.document.hidden = false;
  browser.listeners.visibilitychange[0]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count(), before + 2, 'becoming visible reads at once');

  // On another tab the timer stops without asking.
  browser.state.tab = 'storage';
  before = count();
  await browser.timers[0].callback();
  assert.equal(count(), before);
  assert.deepEqual(browser.cleared, [1]);
  assert.equal(browser.mqttState.timer, null);
});

test('a slow answer never writes into another tab or over a newer render', async () => {
  let release;
  let slow = false;
  const store = { messages: [message(1)] };
  const respond = broker(store);
  const browser = mqttBrowser(async (request) => {
    if (slow && request.path === '/mqtt/messages') await new Promise((resolve) => { release = resolve; });
    return respond(request);
  });
  await browser.render();
  slow = true;
  store.messages.push(message(2, { topic: 'esp32/late' }));
  const kept = browser.elements['#mqttStream'] = { innerHTML: 'storage tab content' };
  const pending = browser.mqttPoll();
  await new Promise((resolve) => setImmediate(resolve));
  browser.state.tab = 'storage';
  release();
  await pending;
  assert.equal(kept.innerHTML, 'storage tab content');
  assert.equal(browser.mqttState.rows.length, 1);

  browser.state.tab = 'mqtt';
  const second = browser.mqttPoll();
  await new Promise((resolve) => setImmediate(resolve));
  browser.state.renderSeq += 1;
  release();
  await second;
  assert.equal(kept.innerHTML, 'storage tab content');
  assert.equal(browser.mqttState.busy, false);
});

test('the page keeps at most 300 rows, catches up a burst and reports dropped messages', async () => {
  const store = { messages: Array.from({ length: 5 }, (_item, index) => message(index + 1)) };
  const browser = await openMqtt(store);

  // 700 new messages: Data answers 300 at a time and says there is more.
  const burst = Array.from({ length: 700 }, (_item, index) => message(index + 6));
  const respond = broker(store);
  browser.requests.length = 0;
  const paged = mqttBrowser((request) => {
    if (request.path !== '/mqtt/messages' || !request.query.has('since')) return respond(request);
    const since = Number(request.query.get('since'));
    const rest = burst.filter((item) => item.seq > since);
    const page = rest.slice(0, 300);
    return messagesBody(page, { latestSeq: 705, nextSince: rest.length > 300 ? page.at(-1).seq : 705, more: rest.length > 300 });
  });
  await paged.render();
  await paged.timers[0].callback();
  const reads = messageReads(paged).slice(1).map((request) => request.query.get('since'));
  assert.deepEqual(reads, ['5', '305', '605'], 'three reads in one poll, each from where the last one stopped');
  assert.equal(paged.mqttState.rows.length, 300);
  assert.equal(paged.mqttState.rows[0].seq, 705);
  assert.equal(paged.mqttState.rows.at(-1).seq, 406);
  assert.equal(paged.mqttState.since, 705);
  assert.match(paged.elements['#mqttControls'].innerHTML, /300 messages shown/);

  // Data's buffer moved past the last message seen.
  store.messages = [message(900), message(901)];
  store.answer = { dropped: true, droppedCount: 894, oldestSeq: 900 };
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttNotice'].innerHTML, /Noticed at [^<]+: 894 messages passed between two reads and are no longer in Data&#39;s buffer \(it keeps the last 500\)\. They are not shown\.</);
  assert.match(browser.elements['#mqttNotice'].innerHTML, /They are not shown\./);
  assert.equal(browser.mqttState.rows[0].seq, 901);
  store.answer = {};
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttNotice'].innerHTML, /894 messages passed/, 'the notice stays until Clear');
});

test('a Data restart starts the list again instead of mixing two sequences', async () => {
  const store = { messages: [message(40), message(41)] };
  const browser = await openMqtt(store);
  assert.equal(browser.mqttState.since, 41);
  store.messages = [message(1, { topic: 'esp32/after-restart' }), message(2)];
  store.answer = { epoch: '2026-10-08T23:00:00.000Z' };
  await browser.timers[0].callback();
  const reads = messageReads(browser).slice(-2);
  assert.equal(reads[0].query.get('since'), '41');
  assert.equal(reads[1].query.has('since'), false, 'the list is read anew');
  assert.deepEqual(plain(browser.mqttState.rows.map((row) => row.seq)), [2, 1]);
  assert.match(browser.elements['#mqttNotice'].innerHTML, /Data restarted its broker monitor/);
  assert.doesNotMatch(browser.elements['#mqttStream'].innerHTML, /"n":41/);
});

test('Pause stops the reads, Resume catches up, Clear empties the page list only', async () => {
  const store = { messages: [message(1), message(2)] };
  const browser = await openMqtt(store);
  browser.listeners.click[0]({ target: { closest: (selector) => selector === '[data-mqtt-action]' ? { dataset: { mqttAction: 'pause' } } : null } });
  assert.equal(browser.mqttState.paused, true);
  assert.match(browser.elements['#mqttControls'].innerHTML, /aria-pressed="true">Resume<\/button>/);
  assert.match(browser.elements['#mqttControls'].innerHTML, /paused<\/strong>: nothing is read until Resume/);

  store.messages.push(message(3));
  let reads = messageReads(browser).length;
  const statusReads = () => browser.requests.filter((request) => request.path === '/mqtt/status').length;
  const statusBefore = statusReads();
  await browser.timers[0].callback();
  assert.equal(messageReads(browser).length, reads, 'no message is read while paused');
  assert.equal(statusReads(), statusBefore + 1, 'the broker state is still followed');
  assert.equal(browser.mqttState.rows.length, 2);

  browser.mqttTogglePause();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(browser.elements['#mqttControls'].innerHTML, /aria-pressed="false">Pause<\/button>/);
  assert.equal(messageReads(browser).at(-1).query.get('since'), '2');
  assert.equal(browser.mqttState.rows.length, 3);

  reads = messageReads(browser).length;
  const before = browser.requests.length;
  browser.mqttClear();
  assert.equal(browser.requests.length, before, 'Clear asks Data nothing');
  assert.equal(browser.mqttState.rows.length, 0);
  assert.match(browser.elements['#mqttControls'].innerHTML, /0 messages shown/);
  assert.match(browser.elements['#mqttStream'].innerHTML, /No message on # yet/);
  store.messages.push(message(4));
  await browser.timers[0].callback();
  assert.equal(messageReads(browser).at(-1).query.get('since'), '3', 'cleared messages do not come back');
  assert.deepEqual(plain(browser.mqttState.rows.map((row) => row.seq)), [4]);
});

test('a topic filter is sent to Data and restarts the list; an invalid one is refused in the page', async () => {
  const store = { messages: [message(1), message(2, { topic: 'esp32/kitchen/state' })] };
  const browser = await openMqtt(store);
  browser.listeners.click[0]({ target: { closest: (selector) => selector === '[data-mqtt-filter]' ? { dataset: { mqttFilter: 'esp32/#' } } : null } });
  await new Promise((resolve) => setImmediate(resolve));
  const read = messageReads(browser).at(-1);
  assert.deepEqual(Object.fromEntries(read.query), { limit: '300', topic: 'esp32/#' });
  assert.equal(browser.mqttState.filter, 'esp32/#');
  assert.equal(browser.elements['#mqttFilterInput'].value, 'esp32/#');
  assert.match(browser.elements['#mqttControls'].innerHTML, /filter <span class="mono">esp32\/#<\/span>/);

  // The form submits the typed filter the same way.
  browser.listeners.submit[0]({ target: { id: 'mqttFilter', elements: { topic: { value: ' esp32/+/io/# ' } } }, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messageReads(browser).at(-1).query.get('topic'), 'esp32/+/io/#');
  await browser.timers[0].callback();
  assert.equal(messageReads(browser).at(-1).query.get('topic'), 'esp32/+/io/#', 'the poll keeps the filter');

  const before = browser.requests.length;
  for (const [filter, expected] of [['esp32/#/io', /# must be alone in the last level/], ['esp32/a+', /\+ must fill a whole level/], ['', /non-empty/]]) {
    await browser.mqttSetFilter(filter);
    assert.match(browser.elements['#mqttNotice'].innerHTML, /Filter not applied: /);
    assert.match(browser.elements['#mqttNotice'].innerHTML, expected);
    assert.equal(browser.mqttFilterProblem(filter), rules.topicFilterProblem(filter), 'same wording as Data');
  }
  assert.equal(browser.requests.length, before);
  assert.equal(browser.mqttState.filter, 'esp32/+/io/#');
  for (const filter of ['#', '+', 'esp32/#', 'esp32/+/io/#', '$SYS/#']) assert.equal(browser.mqttFilterProblem(filter), '');
});

test('the form refuses what Data would refuse, in Data\'s words, without a request', async () => {
  const browser = await openMqtt({ publish: () => { throw new Error('must not be called'); } });
  const cases = [
    ['', 'x'], ['esp32/#', 'x'], ['esp32/+/reboot', 'x'], ['$SYS/broker', 'x'], ['esp32/\u0000', 'x'],
    ['x'.repeat(257), 'x'], ['é'.repeat(129), 'x'], ['esp32/a', 'x'.repeat(4097)], ['esp32/a', 'é'.repeat(2049)]
  ];
  for (const [topic, payload] of cases) {
    let expected = '';
    try { rules.validatePublish({ topic, payload }); } catch (error) { expected = error.message; }
    assert.ok(expected, `Data refuses ${JSON.stringify(topic).slice(0, 30)}`);
    assert.equal(browser.mqttPublishProblem(topic, payload), expected);
    await browser.mqttSend({ topic, payload, retain: false });
    assert.ok(browser.elements['#mqttOutcome'].innerHTML.includes('class="notice warning">Not sent: '));
  }
  assert.equal(browser.requests.filter((request) => request.method !== 'GET').length, 0);
  // What Data accepts, the form accepts: any topic, an empty message, the limits.
  for (const [topic, payload] of [['esp32/', ''], ['garden/pump 1', 'on'], ['x'.repeat(256), 'y'.repeat(4096)], ['esp32/a', '# + $ are fine here']]) {
    assert.equal(browser.mqttPublishProblem(topic, payload), '');
    assert.doesNotThrow(() => rules.validatePublish({ topic, payload }));
  }
});

test('Send posts one message, is disabled while in flight, reports inline and fakes no row', async () => {
  let release;
  const store = { messages: [message(1)], publish: async (request) => {
    await new Promise((resolve) => { release = resolve; });
    return { topic: request.body.topic, bytes: 2, retain: request.body.retain, qos: 0, publishedAt: '2026-10-08T22:40:00.000Z' };
  } };
  const browser = await openMqtt(store);
  const button = browser.elements['#mqttSendButton'];
  // The submit handler reads the form.
  let prevented = false;
  browser.listeners.submit[0]({ preventDefault() { prevented = true; }, target: { id: 'mqttSend', elements: {
    topic: { value: 'esp32/kitchen/io/2/on' }, payload: { value: 'on' }, retain: { checked: true } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Sending…');
  // A second click while the first is in flight sends nothing more.
  await browser.mqttSend({ topic: 'esp32/kitchen/io/2/on', payload: 'on', retain: true });
  const posts = () => browser.requests.filter((request) => request.method === 'POST');
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].path, '/mqtt/publish');
  assert.deepEqual(posts()[0].body, { topic: 'esp32/kitchen/io/2/on', payload: 'on', retain: true });

  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Send');
  const outcome = browser.elements['#mqttOutcome'].innerHTML;
  assert.match(outcome, /class="notice success">Sent to esp32\/kitchen\/io\/2\/on at [^·]+ · 2 B · retained\. It appears in the stream when the broker delivers it back\./);
  // No row was invented: the list still holds only what Data returned.
  assert.deepEqual(plain(browser.mqttState.rows.map((row) => row.seq)), [1]);
  assert.doesNotMatch(stream(browser), /esp32\/kitchen\/io\/2\/on/);
  // The broker echoes it to Data's monitor; the next read shows it.
  store.messages.push(message(2, { topic: 'esp32/kitchen/io/2/on', payload: 'on', bytes: 2 }));
  await browser.timers[0].callback();
  assert.match(browser.elements['#mqttStream'].innerHTML, /esp32\/kitchen\/io\/2\/on/);

  // The topic and message survive a full redraw of the tab.
  await browser.render();
  assert.match(browser.content.innerHTML, /<input id="mqttTopic" name="topic" class="mono" value="esp32\/kitchen\/io\/2\/on"/);
  assert.match(browser.content.innerHTML, /<textarea id="mqttPayload"[^>]*>on<\/textarea>/);
  assert.match(browser.content.innerHTML, /<input type="checkbox" name="retain" checked>/);
});

test('a refused or failed send says so inline and leaves the form usable', async () => {
  const store = { publish: () => Object.assign(new Error('MQTT broker is not connected. The message was not sent and is not queued.'), { status: 503 }) };
  const browser = await openMqtt(store);
  await browser.mqttSend({ topic: 'esp32/kitchen/reboot', payload: '', retain: false });
  assert.match(browser.elements['#mqttOutcome'].innerHTML, /class="notice warning">Not sent: MQTT broker is not connected\. The message was not sent and is not queued\./);
  assert.equal(browser.elements['#mqttSendButton'].disabled, false);
  assert.equal(browser.mqttState.sending, false);
  assert.deepEqual(plain(browser.mqttState.draft), { topic: 'esp32/kitchen/reboot', payload: '', retain: false });
  // Typing updates the draft kept across redraws.
  browser.listeners.input[0]({ target: { form: { id: 'mqttSend', elements: { topic: { value: 'esp32/x' }, payload: { value: 'draft' }, retain: { checked: false } } } } });
  assert.deepEqual(plain(browser.mqttState.draft), { topic: 'esp32/x', payload: 'draft', retain: false });
});
