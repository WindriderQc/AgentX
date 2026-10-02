let mqtt;
try { mqtt = require('mqtt'); } catch { mqtt = null; }

const { log } = require('../utils/logger');

let client;
let messageHandlers = [];
let subscribedTopics = new Set();
let messageListenerAttached = false;

function init(options = {}) {
  if (process.env.NODE_ENV === 'test') return;

  const brokerUrl = process.env.MQTT_BROKER_URL;
  if (!brokerUrl) {
    log('[MQTT] No MQTT_BROKER_URL configured — skipping');
    return;
  }
  if (!mqtt) {
    log('[MQTT] mqtt package not installed — skipping');
    return;
  }

  client = mqtt.connect(brokerUrl, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    ...options
  });

  client.on('connect', () => log('[MQTT] Connected'));
  client.on('error', (err) => log(`[MQTT] Error: ${err.message}`, 'error'));
  client.on('reconnect', () => log('[MQTT] Reconnecting...'));
  return client;
}

function publish(topic, message) {
  if (!client?.connected) return;
  const payload = typeof message === 'object' ? JSON.stringify(message) : message;
  client.publish(topic, payload, (err) => {
    if (err) log(`[MQTT] Publish error: ${err.message}`, 'error');
  });
}

// Subscribe to topic(s); `handler(topic, payloadStr)` runs for every message on
// any subscription. A single shared 'message' listener fans out to all handlers
// (mqtt.js buffers subscribes until the connection is up). Used by the live-data
// engine's push-in feeds.
function subscribe(topics, handler) {
  if (!client) { log('[MQTT] subscribe skipped — no client'); return; }
  const list = Array.isArray(topics) ? topics : [topics];
  client.subscribe(list, (err) => {
    if (err) log(`[MQTT] Subscribe error: ${err.message}`, 'error');
    else log(`[MQTT] Subscribed: ${list.join(', ')}`);
  });
  list.forEach(t => subscribedTopics.add(t));
  if (typeof handler === 'function') messageHandlers.push(handler);
  if (!messageListenerAttached) {
    client.on('message', (topic, payload) => {
      const str = payload.toString();
      for (const h of messageHandlers) {
        try { h(topic, str); } catch (e) { log(`[MQTT] handler error: ${e.message}`, 'error'); }
      }
    });
    messageListenerAttached = true;
  }
}

// Drop all live-data subscriptions + handlers (keeps the connection open).
function unsubscribeAll() {
  if (client && subscribedTopics.size) {
    try { client.unsubscribe([...subscribedTopics]); } catch { /* best effort */ }
  }
  subscribedTopics.clear();
  messageHandlers = [];
}

function close() {
  return new Promise((resolve) => {
    messageHandlers = [];
    subscribedTopics.clear();
    messageListenerAttached = false;
    if (client) { client.end(true, () => { client = null; resolve(); }); }
    else resolve();
  });
}

module.exports = { init, publish, subscribe, unsubscribeAll, close };
