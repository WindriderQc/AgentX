/**
 * MQTT monitor: topic matcher, ring buffer and `since` logic, publish rules.
 * The broker client is a fake; no test opens a broker connection.
 */
const { EventEmitter } = require('events');
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

const { log } = require('../../utils/logger');
const rules = require('../../../shared/mqttTopicRules');
const mqttMonitor = require('../../services/mqttMonitor');
const { createMqttMonitor, describeBroker, decodePayload } = mqttMonitor;

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.subscriptions = [];
    this.published = [];
    this.publishError = null;
    this.confirm = true;
    this.unconfirmed = [];
    this.ended = false;
  }
  subscribe(topic, options, callback) { this.subscriptions.push({ topic, options }); callback(null, [{ topic, qos: 0 }]); }
  publish(topic, payload, options, callback) {
    this.published.push({ topic, payload, options });
    if (this.confirm) callback(this.publishError);
    else this.unconfirmed.push(callback);
  }
  end(_force, callback) { this.ended = true; this.connected = false; callback(); }
  goOnline() { this.connected = true; this.emit('connect'); }
  goOffline() { this.connected = false; this.emit('close'); }
}

const ENV = { MQTT_BROKER_URL: 'mqtt://broker.example:1883', MQTT_USERNAME: 'data-user', MQTT_PASSWORD: 'synthetic-secret' };

function connectedMonitor(options = {}, env = ENV) {
  const client = new FakeClient();
  const calls = [];
  const monitor = createMqttMonitor(options);
  monitor.init({ env, connect: (url, opts) => { calls.push({ url, opts }); return client; } });
  client.goOnline();
  return { monitor, client, calls };
}

describe('topic filter matching', () => {
  test.each([
    ['#', 'esp32', true],
    ['#', 'esp32/kitchen/io/2/on', true],
    ['esp32/#', 'esp32', true],
    ['esp32/#', 'esp32/kitchen', true],
    ['esp32/#', 'esp32/kitchen/io/2/on', true],
    ['esp32/#', 'esp321', false],
    ['esp32/#', 'liveData/iss', false],
    ['esp32/+/reboot', 'esp32/kitchen/reboot', true],
    ['esp32/+/reboot', 'esp32/kitchen/io/reboot', false],
    ['esp32/+', 'esp32', false],
    ['esp32/+', 'esp32/', true],
    ['+', 'esp32', true],
    ['+', 'esp32/kitchen', false],
    ['+/+', '/esp32', true],
    ['/+', '/esp32', true],
    ['esp32/+/io/#', 'esp32/kitchen/io', true],
    ['esp32/+/io/#', 'esp32/kitchen/io/2/off', true],
    ['liveData/pressure/+', 'liveData/pressure/46.81,-71.21', true],
    ['liveData/iss', 'liveData/iss', true],
    ['liveData/iss', 'liveData/iss/extra', false],
    ['liveData/iss', 'livedata/iss', false],
    ['#', '$SYS/broker/uptime', false],
    ['+/broker/uptime', '$SYS/broker/uptime', false],
    ['$SYS/#', '$SYS/broker/uptime', true],
    ['$SYS/+/uptime', '$SYS/broker/uptime', true]
  ])('%s against %s is %s', (filter, topic, expected) => {
    expect(rules.topicMatches(filter, topic)).toBe(expected);
  });

  test('a filter is refused when a wildcard is misplaced', () => {
    for (const filter of ['#', '+', 'esp32/#', 'esp32/+/io/#', '+/+', '$SYS/#', 'a b/c']) expect(rules.topicFilterProblem(filter)).toBe('');
    expect(rules.topicFilterProblem('esp32/#/io')).toMatch(/# must be alone in the last level/);
    expect(rules.topicFilterProblem('esp32#')).toMatch(/# must be alone in the last level/);
    expect(rules.topicFilterProblem('esp32/a+')).toMatch(/\+ must fill a whole level/);
    expect(rules.topicFilterProblem('')).toMatch(/non-empty/);
    expect(rules.topicFilterProblem('a\u0000b')).toMatch(/NUL/);
    expect(rules.topicFilterProblem('x'.repeat(257))).toMatch(/at most 256 bytes/);
  });
});

describe('received payloads', () => {
  test('text is kept as UTF-8 and cut at 4 KiB on a character boundary', () => {
    expect(decodePayload(Buffer.from('{"lat":46.81}'))).toEqual({ payload: '{"lat":46.81}', bytes: 13, truncated: false, binary: false });
    expect(decodePayload(Buffer.alloc(0))).toEqual({ payload: '', bytes: 0, truncated: false, binary: false });
    const long = decodePayload(Buffer.from('a'.repeat(5000)));
    expect(long).toMatchObject({ bytes: 5000, truncated: true, binary: false });
    expect(long.payload).toHaveLength(4096);
    // 'é' is two bytes: the 4 KiB cut falls in the middle of one.
    const accented = decodePayload(Buffer.from(`a${'é'.repeat(3000)}`));
    expect(accented).toMatchObject({ bytes: 6001, truncated: true, binary: false });
    expect(accented.payload).toBe(`a${'é'.repeat(2047)}`);
    expect(decodePayload(Buffer.from('a'.repeat(4096)))).toMatchObject({ bytes: 4096, truncated: false });
  });

  test('bytes that are not UTF-8 become a short hex preview with a flag', () => {
    expect(decodePayload(Buffer.from([0xff, 0x00, 0x10]))).toEqual({ payload: 'ff 00 10', bytes: 3, truncated: false, binary: true });
    const big = decodePayload(Buffer.alloc(9000, 0xfe));
    expect(big).toMatchObject({ bytes: 9000, truncated: true, binary: true });
    expect(big.payload.split(' ')).toHaveLength(64);
  });
});

describe('connection and status', () => {
  test('without MQTT_BROKER_URL nothing connects and the status says so', () => {
    const monitor = createMqttMonitor();
    const connect = jest.fn();
    expect(monitor.init({ env: {}, connect })).toBeNull();
    expect(connect).not.toHaveBeenCalled();
    expect(monitor.status()).toMatchObject({ configured: false, connected: false, broker: null, received: 0, lastMessageAt: null, lastError: null });
  });

  test('a test process never opens a real broker connection', () => {
    const monitor = createMqttMonitor();
    expect(monitor.init({ env: { ...ENV, NODE_ENV: 'test' } })).toBeNull();
    expect(monitor.status()).toMatchObject({ configured: true, connected: false, broker: 'broker.example:1883' });
    // The module-level monitor used by the routes is in the same state.
    expect(mqttMonitor.status().connected).toBe(false);
  });

  test('it connects with its own options, subscribes to # on every connect and does not depend on background jobs', () => {
    const { monitor, client, calls } = connectedMonitor();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENV.MQTT_BROKER_URL);
    expect(calls[0].opts).toMatchObject({ username: 'data-user', password: 'synthetic-secret', queueQoSZero: false, resubscribe: false });
    expect(client.subscriptions).toEqual([{ topic: '#', options: { qos: 0 } }]);
    expect(monitor.status()).toMatchObject({ configured: true, connected: true, broker: 'broker.example:1883' });
    client.goOffline();
    expect(monitor.status()).toMatchObject({ connected: false, connectedAt: null });
    client.goOnline();
    expect(client.subscriptions).toHaveLength(2);
    // A second init keeps the one connection.
    monitor.init({ env: ENV, connect: () => { throw new Error('must not reconnect'); } });
    expect(calls).toHaveLength(1);
  });

  test('the status never carries the username, the password or the URL', () => {
    const env = { MQTT_BROKER_URL: 'mqtts://url-user:url-secret@broker.example', MQTT_USERNAME: 'data-user', MQTT_PASSWORD: 'synthetic-secret' };
    const { monitor, client } = connectedMonitor({}, env);
    client.emit('error', new Error('connect failed for mqtts://url-user:url-secret@broker.example with synthetic-secret'));
    const text = JSON.stringify(monitor.status());
    expect(monitor.status().broker).toBe('broker.example:8883');
    expect(monitor.status().lastError).toMatch(/connect failed/);
    for (const secret of ['synthetic-secret', 'url-secret', 'url-user', 'data-user']) expect(text).not.toContain(secret);
    expect(log.mock.calls.flat().join(' ')).not.toMatch(/synthetic-secret|url-secret/);
  });

  test('broker host and port are read from the URL with the scheme default', () => {
    expect(describeBroker('mqtt://192.0.2.10')).toBe('192.0.2.10:1883');
    expect(describeBroker('mqtt://user:pass@broker.example:1884')).toBe('broker.example:1884');
    expect(describeBroker('wss://broker.example/mqtt')).toBe('broker.example:443');
    expect(describeBroker('not a url')).toBeNull();
  });

  test('an invalid URL, a failing connect and broker errors are reported, never thrown', () => {
    const invalid = createMqttMonitor();
    expect(invalid.init({ env: { MQTT_BROKER_URL: 'not a url' }, connect: jest.fn() })).toBeNull();
    expect(invalid.status()).toMatchObject({ configured: true, connected: false, broker: null, lastError: 'MQTT_BROKER_URL is not a valid broker URL' });

    const throwing = createMqttMonitor();
    expect(throwing.init({ env: ENV, connect: () => { throw new Error('bad protocol'); } })).toBeNull();
    expect(throwing.status().lastError).toMatch(/bad protocol/);

    const { monitor, client } = connectedMonitor();
    client.connected = false;
    expect(() => client.emit('error', new Error('connect ECONNREFUSED 192.0.2.10:1883'))).not.toThrow();
    expect(monitor.status()).toMatchObject({ connected: false, lastError: 'connect ECONNREFUSED 192.0.2.10:1883' });
    client.goOnline();
    expect(monitor.status().lastError).toBeNull();
  });

  test('close ends the connection', async () => {
    const { monitor, client } = connectedMonitor();
    await monitor.close();
    expect(client.ended).toBe(true);
    expect(monitor.status().connected).toBe(false);
    await expect(monitor.close()).resolves.toBeUndefined();
  });
});

describe('ring buffer and since', () => {
  function filled(count, options = { bufferSize: 5 }) {
    const context = connectedMonitor(options);
    for (let index = 1; index <= count; index++) {
      context.client.emit('message', index % 2 ? 'esp32/kitchen/state' : 'liveData/iss', Buffer.from(`m${index}`), { retain: index === 1, qos: 0 });
    }
    return context;
  }
  const seqs = (result) => result.messages.map((message) => message.seq);

  test('a message is stored with its sequence, time, size and flags', () => {
    const at = new Date('2026-10-08T12:00:00.000Z');
    const { monitor, client } = connectedMonitor({ now: () => at });
    client.emit('message', 'esp32/register', Buffer.from('{"id":"kitchen"}'), { retain: true, qos: 1 });
    expect(monitor.messages().messages).toEqual([{
      seq: 1, ts: '2026-10-08T12:00:00.000Z', topic: 'esp32/register', payload: '{"id":"kitchen"}',
      bytes: 16, truncated: false, binary: false, retained: true, qos: 1
    }]);
    expect(monitor.status()).toMatchObject({ received: 1, lastMessageAt: '2026-10-08T12:00:00.000Z', latestSeq: 1, buffered: 1 });
  });

  test('the buffer keeps the last N messages and the default is 500', () => {
    const { monitor } = filled(12);
    expect(seqs(monitor.messages())).toEqual([8, 9, 10, 11, 12]);
    expect(monitor.status()).toMatchObject({ received: 12, latestSeq: 12, buffered: 5, bufferSize: 5 });
    expect(mqttMonitor.BUFFER_SIZE).toBe(500);
    expect(createMqttMonitor().status().bufferSize).toBe(500);
  });

  test('since returns only newer messages, oldest first, with where to continue', () => {
    const { monitor, client } = filled(4);
    let result = monitor.messages({ since: 2 });
    expect(seqs(result)).toEqual([3, 4]);
    expect(result).toMatchObject({ latestSeq: 4, nextSince: 4, more: false, dropped: false, droppedCount: 0, reset: false });
    expect(monitor.messages({ since: '4' })).toMatchObject({ messages: [], latestSeq: 4, nextSince: 4, dropped: false });
    client.emit('message', 'esp32', Buffer.from('new'), {});
    result = monitor.messages({ since: 4 });
    expect(seqs(result)).toEqual([5]);
    expect(monitor.messages({ since: 0 }).messages).toHaveLength(5);
  });

  test('a since older than the buffer is reported as dropped messages', () => {
    const { monitor } = filled(12);
    const result = monitor.messages({ since: 3 });
    expect(seqs(result)).toEqual([8, 9, 10, 11, 12]);
    expect(result).toMatchObject({ dropped: true, droppedCount: 4, oldestSeq: 8, latestSeq: 12, nextSince: 12 });
    // Exactly at the edge nothing was lost; without since nothing is claimed.
    expect(monitor.messages({ since: 7 })).toMatchObject({ dropped: false, droppedCount: 0 });
    expect(monitor.messages()).toMatchObject({ dropped: false, droppedCount: 0 });
  });

  test('limit is bounded, pages forward with since and takes the newest without it', () => {
    const { monitor } = filled(400, { bufferSize: 1000 });
    let result = monitor.messages({ since: 0 });
    expect(result.messages).toHaveLength(100);
    expect(result).toMatchObject({ more: true, nextSince: 100, latestSeq: 400 });
    result = monitor.messages({ since: result.nextSince, limit: 9999 });
    expect(result.messages).toHaveLength(300);
    expect(result).toMatchObject({ more: false, nextSince: 400 });
    expect(seqs(monitor.messages({ since: 0, limit: 0 }))).toEqual([1]);
    expect(monitor.messages({ since: 0, limit: 'many' }).messages).toHaveLength(100);
    expect(seqs(monitor.messages({ limit: 3 }))).toEqual([398, 399, 400]);
    const { monitor: big } = filled(700, { bufferSize: 1000 });
    expect(big.messages({ since: 0, limit: 600 }).messages).toHaveLength(500);
  });

  test('the topic filter is applied before the limit and keeps the position exact', () => {
    const { monitor } = filled(10, { bufferSize: 50 });
    let result = monitor.messages({ since: 0, topic: 'esp32/#' });
    expect(seqs(result)).toEqual([1, 3, 5, 7, 9]);
    expect(result).toMatchObject({ topic: 'esp32/#', nextSince: 10, more: false });
    result = monitor.messages({ since: 0, topic: 'liveData/+', limit: 2 });
    expect(seqs(result)).toEqual([2, 4]);
    expect(result).toMatchObject({ more: true, nextSince: 4 });
    expect(seqs(monitor.messages({ since: 4, topic: 'liveData/+', limit: 2 }))).toEqual([6, 8]);
    expect(seqs(monitor.messages({ topic: 'esp32/+/state', limit: 2 }))).toEqual([7, 9]);
    expect(monitor.messages({ topic: 'sensors/#' }).messages).toEqual([]);
  });

  test('a since from before a restart starts again from the buffer', () => {
    const { monitor } = filled(3);
    const result = monitor.messages({ since: 900 });
    expect(seqs(result)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ reset: true, dropped: false, nextSince: 3 });
    expect(typeof result.epoch).toBe('string');
  });

  test('an invalid since or filter is refused with a clear message', () => {
    const { monitor } = filled(2);
    for (const since of ['-1', 'abc', '1.5', ['1', '2'], '9'.repeat(20)]) {
      expect(() => monitor.messages({ since })).toThrow(expect.objectContaining({ statusCode: 400, message: 'since must be a non-negative integer' }));
    }
    expect(() => monitor.messages({ topic: 'esp32/#/x' })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => monitor.messages({ topic: ['a', 'b'] })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('publish', () => {
  const refused = (monitor, body) => {
    try { monitor.publish(body); } catch (error) { return error; }
    throw new Error('publish was not refused');
  };

  test('a valid message is published at QoS 0 and answered after the client callback', async () => {
    const { monitor, client } = connectedMonitor();
    client.confirm = false;
    let answered = false;
    const pending = monitor.publish({ topic: 'esp32/kitchen/io/2/on', payload: 'do-not-log-me' }).then((result) => { answered = true; return result; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(answered).toBe(false);
    expect(client.published).toEqual([{ topic: 'esp32/kitchen/io/2/on', payload: 'do-not-log-me', options: { qos: 0, retain: false } }]);
    client.unconfirmed[0](null);
    await expect(pending).resolves.toMatchObject({ topic: 'esp32/kitchen/io/2/on', bytes: 13, retain: false, qos: 0, publishedAt: expect.any(String) });
    client.confirm = true;
    await expect(monitor.publish({ topic: 'esp32/kitchen/reboot', payload: '', retain: true }))
      .resolves.toMatchObject({ topic: 'esp32/kitchen/reboot', bytes: 0, retain: true });
    expect(client.published[1].options).toEqual({ qos: 0, retain: true });
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toMatch(/Published topic="esp32\/kitchen\/reboot" bytes=0 retain=true/);
    expect(logged).not.toContain('do-not-log-me');
  });

  test('topic rules: non-empty string, at most 256 bytes, no wildcard, no NUL, no leading $', () => {
    const { monitor, client } = connectedMonitor();
    const cases = [
      [{ payload: 'x' }, /topic must be a non-empty string/],
      [{ topic: '', payload: 'x' }, /topic must be a non-empty string/],
      [{ topic: 42, payload: 'x' }, /topic must be a non-empty string/],
      [{ topic: 'x'.repeat(257), payload: 'x' }, /topic must be at most 256 bytes/],
      [{ topic: 'é'.repeat(129), payload: 'x' }, /topic must be at most 256 bytes/],
      [{ topic: 'esp32/#', payload: 'x' }, /must not contain the wildcards # or \+/],
      [{ topic: 'esp32/+/reboot', payload: 'x' }, /must not contain the wildcards # or \+/],
      [{ topic: 'esp32/\u0000', payload: 'x' }, /NUL/],
      [{ topic: '$SYS/broker', payload: 'x' }, /must not start with \$/],
      [{ topic: 'esp32/\ud800', payload: 'x' }, /valid Unicode/],
      [{ topic: 'esp32/a' }, /payload must be a string/],
      [{ topic: 'esp32/a', payload: { on: true } }, /payload must be a string/],
      [{ topic: 'esp32/a', payload: 'x'.repeat(4097) }, /payload must be at most 4096 bytes/],
      [{ topic: 'esp32/a', payload: 'é'.repeat(2049) }, /payload must be at most 4096 bytes/],
      [{ topic: 'esp32/a', payload: 'x', retain: 'yes' }, /retain must be true or false/],
      [{ topic: 'esp32/a', payload: 'x', qos: 2 }, /Unknown field: qos/],
      [null, /Expected a JSON object/],
      [['esp32/a'], /Expected a JSON object/]
    ];
    for (const [body, message] of cases) {
      const error = refused(monitor, body);
      expect(error.statusCode).toBe(400);
      expect(error.message).toMatch(message);
    }
    expect(client.published).toEqual([]);
  });

  test('the limits themselves are accepted, and any topic is free', async () => {
    const { monitor, client } = connectedMonitor();
    await monitor.publish({ topic: 'x'.repeat(256), payload: 'y'.repeat(4096) });
    await monitor.publish({ topic: 'anything/the owner/wants', payload: '' });
    await monitor.publish({ topic: 'esp32', payload: '$ # + are fine in a payload', retain: false });
    expect(client.published).toHaveLength(3);
  });

  test('503 when the broker is not configured, and nothing is attempted', () => {
    const monitor = createMqttMonitor();
    monitor.init({ env: {}, connect: jest.fn() });
    const error = refused(monitor, { topic: 'esp32/a', payload: 'x' });
    expect(error.statusCode).toBe(503);
    expect(error.message).toMatch(/not configured: set MQTT_BROKER_URL on Data/);
    // An invalid body is still a 400: the caller's mistake comes first.
    expect(refused(monitor, { topic: '#', payload: 'x' }).statusCode).toBe(400);
  });

  test('503 when the broker is not connected: the message is not handed to the client to queue', () => {
    const { monitor, client } = connectedMonitor();
    client.goOffline();
    const error = refused(monitor, { topic: 'esp32/kitchen/reboot', payload: '' });
    expect(error.statusCode).toBe(503);
    expect(error.message).toMatch(/not connected\. The message was not sent and is not queued/);
    expect(client.published).toEqual([]);
  });

  test('a client error is a 503 and an unconfirmed write a 504 that says it is uncertain', async () => {
    const { monitor, client } = connectedMonitor({ confirmMs: 20 });
    client.publishError = new Error('No connection to broker');
    await expect(monitor.publish({ topic: 'esp32/a', payload: 'x' })).rejects.toMatchObject({ statusCode: 503, message: expect.stringMatching(/No connection to broker/) });
    client.publishError = null;
    client.publish = () => { throw new Error('client is disconnecting'); };
    await expect(monitor.publish({ topic: 'esp32/a', payload: 'x' })).rejects.toMatchObject({ statusCode: 503 });
    client.publish = () => {};
    await expect(monitor.publish({ topic: 'esp32/a', payload: 'x' })).rejects.toMatchObject({ statusCode: 504, message: expect.stringMatching(/may or may not have been sent/) });
  });
});

describe('routes', () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/mqtt', require('../../routes/mqtt.routes'));
    app.use(require('../../middleware/errorHandler'));
    return app;
  }

  test('status, messages and publish answer through the module monitor', async () => {
    const app = buildApp();
    const status = await request(app).get('/api/v1/mqtt/status').expect(200);
    expect(status.body).toMatchObject({ status: 'success', data: { connected: false, received: expect.any(Number) } });
    expect(Object.keys(status.body.data).sort()).toEqual(['broker', 'buffered', 'bufferSize', 'configured', 'connected', 'connectedAt',
      'lastError', 'lastMessageAt', 'latestSeq', 'received', 'since'].sort());

    const messages = await request(app).get('/api/v1/mqtt/messages?since=0&limit=5&topic=esp32/%23').expect(200);
    expect(messages.body.data).toMatchObject({ messages: [], latestSeq: 0, nextSince: 0, dropped: false, topic: 'esp32/#' });
    const bad = await request(app).get('/api/v1/mqtt/messages?since=nope').expect(400);
    expect(bad.body).toEqual({ status: 'error', message: 'since must be a non-negative integer' });
    await request(app).get('/api/v1/mqtt/messages?topic=esp32/%23/x').expect(400);

    const invalid = await request(app).post('/api/v1/mqtt/publish').send({ topic: 'esp32/+', payload: 'x' }).expect(400);
    expect(invalid.body.message).toBe('topic must not contain the wildcards # or +');
    // No broker in a test process: a valid message is refused, not queued.
    const unavailable = await request(app).post('/api/v1/mqtt/publish').send({ topic: 'esp32/kitchen/reboot', payload: '' }).expect(503);
    expect(unavailable.body.status).toBe('error');
    expect(unavailable.body.message).toMatch(/The message was not sent/);
  });
});
