'use strict';

const path = require('node:path');
const { fork } = require('node:child_process');
const http = require('node:http');
const receipts = require('../../src/services/conversations/exchangeReceipts');
const children = new Set();

function child() {
  const peer = fork(path.join(__dirname, '../fixtures/conversationExchange.child.js'), [], {
    env: { ...process.env, EXCHANGE_TEST_MONGO_URI: process.env.MONGODB_URI },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  children.add(peer);
  const events = new Map(), waiting = new Map();
  let stderr = '';
  peer.stderr.on('data', data => { stderr += data; });
  peer.exited = new Promise(resolve => peer.once('exit', code => {
    children.delete(peer);
    for (const waiter of waiting.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Fixture exited ${code}: ${stderr}`)); }
    waiting.clear();
    resolve(code);
  }));
  peer.on('message', value => {
    events.set(value.event, value);
    const waiter = waiting.get(value.event);
    if (waiter) { clearTimeout(waiter.timer); waiting.delete(value.event); waiter.resolve(value); }
  });
  peer.event = name => events.has(name) ? Promise.resolve(events.get(name)) : new Promise((resolve, reject) => {
    waiting.set(name, { resolve, reject, timer: setTimeout(() => reject(new Error(`Missing fixture event ${name}`)), 8000) });
  });
  return peer;
}
afterEach(async () => {
  await Promise.all([...children].map(async peer => { peer.kill('SIGKILL'); await peer.exited; }));
});

test('a killed Core retains acknowledged input and delivered bytes; a fresh worker refuses uncertain replay', async () => {
  const original = { message: '  Complete synthetic question after an abrupt stop.  ' };
  const first = child();
  const ready = await first.event('ready');
  const request = http.request({ host: '127.0.0.1', port: ready.port, path: '/chat', method: 'POST', agent: false,
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'killed-turn' } });
  request.on('error', () => {});
  const delivered = new Promise((resolve, reject) => request.once('response', response => {
    response.on('error', reject);
    response.once('data', bytes => resolve(bytes.toString('utf8')));
    response.resume();
  }));
  request.end(JSON.stringify(original));
  const acknowledged = await first.event('delivered');
  expect(await delivered).toContain('réponse partielle');
  first.kill('SIGKILL');
  await first.exited;
  request.destroy();
  expect(await receipts.read('synthetic:process-crash', acknowledged.receiptId)).toMatchObject({
    request: { body: original }, response: { body: expect.stringContaining('réponse partielle') }, complete: false
  });
  const second = child();
  const restarted = await second.event('ready');
  const retry = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: restarted.port, path: '/chat', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'killed-turn' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(original));
  });
  expect(retry.status).toBe(409);
  expect(retry.body.code).toBe('EXCHANGE_OUTCOME_UNKNOWN');
}, 15000);
