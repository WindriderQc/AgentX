'use strict';

/**
 * MQTT monitor: the operator's view of the broker.
 *
 * It holds its own broker connection, separate from services/mqttClient.js:
 * the live-feed engine drops every subscription of that client on each config
 * reload, which would silence a monitor sharing it. This one subscribes to `#`
 * and keeps the last messages in memory only (nothing is stored in MongoDB).
 * It also publishes the messages an operator sends by hand, and never queues
 * one: a command that reaches a device minutes late is worse than a refusal.
 *
 * It connects when MQTT_BROKER_URL is set, whether or not background jobs are
 * enabled, and reports its state instead of throwing into the server.
 */

const { log } = require('../utils/logger');
const {
  MAX_PAYLOAD_BYTES, validatePublish, topicFilterProblem, topicMatches
} = require('../../shared/mqttTopicRules');

const BUFFER_SIZE = 500;
const HEX_PREVIEW_BYTES = 64;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const PUBLISH_CONFIRM_MS = 5000;
const DEFAULT_PORTS = Object.freeze({ 'mqtt:': '1883', 'tcp:': '1883', 'mqtts:': '8883', 'ssl:': '8883', 'tls:': '8883', 'ws:': '80', 'wss:': '443' });

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/** Host and port of a broker URL, never its credentials. */
function describeBroker(brokerUrl) {
  try {
    const url = new URL(brokerUrl);
    if (!url.hostname) return null;
    const port = url.port || DEFAULT_PORTS[url.protocol];
    return port ? `${url.hostname}:${port}` : url.hostname;
  } catch {
    return null;
  }
}

/**
 * A received payload as displayable text: UTF-8 cut at 4 KiB on a character
 * boundary, or a short hex preview when the bytes are not UTF-8.
 */
function decodePayload(buffer) {
  const bytes = buffer.length;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // A cut may fall inside a multi-byte character: step back up to three bytes.
  for (let end = Math.min(bytes, MAX_PAYLOAD_BYTES), tries = 0; end >= 0 && tries < 4; end--, tries++) {
    try {
      return { payload: decoder.decode(buffer.subarray(0, end)), bytes, truncated: end < bytes, binary: false };
    } catch { if (bytes <= MAX_PAYLOAD_BYTES) break; }
  }
  return {
    payload: buffer.subarray(0, HEX_PREVIEW_BYTES).toString('hex').replace(/(..)(?=.)/g, '$1 '),
    bytes, truncated: bytes > HEX_PREVIEW_BYTES, binary: true
  };
}

function createMqttMonitor({ bufferSize = BUFFER_SIZE, now = () => new Date(), confirmMs = PUBLISH_CONFIRM_MS } = {}) {
  let client = null;
  let configured = false;
  let broker = null;
  let secrets = [];
  let buffer = [];
  let seq = 0;
  let received = 0;
  let startedAt = now();
  let connectedAt = null;
  let lastMessageAt = null;
  let lastError = null;

  // Broker and socket errors do not carry credentials, but nothing that
  // reaches a response or a log may: scrub them anyway.
  function scrub(message) {
    let text = String(message || 'unknown error').split('\n')[0].slice(0, 300);
    for (const secret of secrets) text = text.split(secret).join('***');
    return text.replace(/\/\/[^/@\s]*@/g, '//***@');
  }

  function fail(message) {
    lastError = scrub(message);
    log(`[MQTT monitor] ${lastError}`, 'warn');
  }

  function record(topic, payload, packet = {}) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload ?? ''));
    const at = now();
    seq += 1;
    received += 1;
    lastMessageAt = at;
    buffer.push({
      seq, ts: at.toISOString(), topic: String(topic), ...decodePayload(body),
      retained: packet.retain === true, qos: Number.isInteger(packet.qos) ? packet.qos : 0
    });
    if (buffer.length > bufferSize) buffer.splice(0, buffer.length - bufferSize);
  }

  /**
   * Connect when MQTT_BROKER_URL is set. `connect` is the mqtt package's
   * connect function; tests inject a fake one, and without it a test process
   * never opens a broker connection.
   */
  function init({ env = process.env, connect } = {}) {
    if (client) return client;
    const brokerUrl = env.MQTT_BROKER_URL;
    configured = Boolean(brokerUrl);
    if (!configured) return null;
    broker = describeBroker(brokerUrl);
    let credentials = null;
    try { credentials = new URL(brokerUrl); } catch { /* reported below */ }
    secrets = [env.MQTT_PASSWORD, credentials?.password, credentials?.password && decodeURIComponent(credentials.password)]
      .filter((secret) => typeof secret === 'string' && secret.length >= 3);
    if (!broker) { fail('MQTT_BROKER_URL is not a valid broker URL'); return null; }
    if (!connect) {
      if (env.NODE_ENV === 'test') return null;
      try { connect = require('mqtt').connect; } catch { fail('the mqtt package is not installed'); return null; }
    }
    startedAt = now();
    try {
      client = connect(brokerUrl, {
        username: env.MQTT_USERNAME,
        password: env.MQTT_PASSWORD,
        // A publish made while disconnected must fail, never wait for the link.
        queueQoSZero: false,
        // The subscription is made again by the connect handler below.
        resubscribe: false,
        reconnectPeriod: 5000,
        connectTimeout: 10000
      });
    } catch (error) {
      client = null;
      fail(`connection could not be started: ${error.message}`);
      return null;
    }
    client.on('connect', () => {
      connectedAt = now();
      lastError = null;
      log(`[MQTT monitor] Connected to ${broker}`);
      client.subscribe('#', { qos: 0 }, (error, granted) => {
        if (error) fail(`subscription to # failed: ${error.message}`);
        else if (Array.isArray(granted) && granted[0]?.qos === 128) fail('the broker refused the subscription to #');
      });
    });
    client.on('close', () => { connectedAt = null; });
    client.on('error', (error) => fail(error?.message));
    client.on('message', (topic, payload, packet) => {
      try { record(topic, payload, packet); } catch (error) { fail(`message dropped: ${error.message}`); }
    });
    return client;
  }

  function status() {
    return {
      configured,
      connected: Boolean(client?.connected),
      broker,
      since: startedAt.toISOString(),
      connectedAt: connectedAt ? connectedAt.toISOString() : null,
      received,
      lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null,
      lastError,
      latestSeq: seq,
      buffered: buffer.length,
      bufferSize
    };
  }

  /**
   * Messages after `since`, oldest first. Without `since`, the newest `limit`
   * messages. `nextSince` is what to ask next; `dropped` says the buffer no
   * longer holds everything after `since`.
   */
  function messages({ since, limit, topic } = {}) {
    const hasSince = since !== undefined && since !== null && since !== '';
    if (hasSince && !/^\d{1,15}$/.test(String(since))) throw httpError(400, 'since must be a non-negative integer');
    const hasFilter = topic !== undefined && topic !== null && topic !== '';
    if (hasFilter) {
      const problem = topicFilterProblem(typeof topic === 'string' ? topic : null);
      if (problem) throw httpError(400, problem);
    }
    const parsedLimit = Number.parseInt(limit, 10);
    const max = Number.isFinite(parsedLimit) ? Math.min(MAX_LIMIT, Math.max(1, parsedLimit)) : DEFAULT_LIMIT;
    const asked = hasSince ? Number(since) : 0;
    // A sequence ahead of ours comes from before a restart of this monitor.
    const reset = hasSince && asked > seq;
    const from = reset ? 0 : asked;
    const oldestSeq = buffer.length ? buffer[0].seq : seq + 1;
    const droppedCount = hasSince ? Math.max(0, oldestSeq - 1 - from) : 0;
    const matching = (message) => !hasFilter || topicMatches(topic, message.topic);

    let selected = [];
    let nextSince = seq;
    let more = false;
    if (hasSince) {
      for (const message of buffer) {
        if (message.seq <= from || !matching(message)) continue;
        if (selected.length === max) { more = true; break; }
        selected.push(message);
      }
      if (more) nextSince = selected[selected.length - 1].seq;
    } else {
      selected = buffer.filter(matching).slice(-max);
    }
    return {
      messages: selected,
      latestSeq: seq,
      oldestSeq: buffer.length ? oldestSeq : null,
      nextSince,
      more,
      dropped: droppedCount > 0,
      droppedCount,
      reset,
      epoch: startedAt.toISOString(),
      bufferSize,
      topic: hasFilter ? topic : '#'
    };
  }

  /**
   * Publish one message at QoS 0 and resolve once the client has written it.
   * Rejects with statusCode 400 (invalid), 503 (no broker link: nothing is
   * queued) or 504 (the write was not confirmed in time).
   */
  function publish(body) {
    const { topic, payload, retain } = validatePublish(body);
    if (!configured) throw httpError(503, 'MQTT broker is not configured: set MQTT_BROKER_URL on Data. The message was not sent.');
    if (!client?.connected) throw httpError(503, 'MQTT broker is not connected. The message was not sent and is not queued.');
    const bytes = Buffer.byteLength(payload, 'utf8');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          log(`[MQTT monitor] Publish failed topic=${JSON.stringify(topic)} bytes=${bytes}: ${scrub(error.message)}`, 'warn');
          return reject(error.statusCode ? error : httpError(503, `MQTT publish failed: ${scrub(error.message)}. The message was not sent.`));
        }
        log(`[MQTT monitor] Published topic=${JSON.stringify(topic)} bytes=${bytes} retain=${retain}`);
        return resolve({ topic, bytes, retain, qos: 0, publishedAt: now().toISOString() });
      };
      const timer = setTimeout(() => finish(httpError(504,
        `The broker connection did not confirm the write within ${confirmMs / 1000} s: the message may or may not have been sent.`)), confirmMs);
      try { client.publish(topic, payload, { qos: 0, retain }, (error) => finish(error || null)); }
      catch (error) { finish(error); }
    });
  }

  function close() {
    return new Promise((resolve) => {
      const current = client;
      client = null;
      connectedAt = null;
      if (!current) return resolve();
      try { return current.end(true, () => resolve()); } catch { return resolve(); }
    });
  }

  return { init, status, messages, publish, close, record };
}

const monitor = createMqttMonitor();

module.exports = { ...monitor, createMqttMonitor, describeBroker, decodePayload, BUFFER_SIZE };
