'use strict';

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const receipts = require('../../src/services/conversations/exchangeReceipts');
const { durableConversationExchange } = require('../../src/middleware/durableConversationExchange');

describe('conversation acceptance and response durability', () => {
  beforeEach(async () => {
    await mongoose.connection.collection('conversation_exchange_receipts').deleteMany({});
    await mongoose.connection.collection('conversation_exchange_packets').deleteMany({});
    await mongoose.connection.collection('conversation_payload_chunks').deleteMany({});
    await mongoose.connection.collection('conversation_write_fences').deleteMany({});
  });
  function app(handler, store = receipts, scope = 'synthetic:owner') {
    const instance = express();
    instance.use(express.json());
    instance.use(durableConversationExchange({ scope: () => scope, store }));
    instance.post('/chat', handler);
    return instance;
  }

  test('saves the full input before a context refusal and makes it recoverable', async () => {
    const input = ' question '.repeat(10000);
    const response = await request(app(async (_req, res) => {
      expect(await mongoose.connection.collection('conversation_exchange_receipts').countDocuments({ state: 'accepted' })).toBe(1);
      res.status(413).json({ code: 'INFERENCE_CONTEXT_OVERFLOW' });
    })).post('/chat').send({ message: input });
    expect(response.status).toBe(413);
    const saved = await receipts.read('synthetic:owner', response.headers['x-agentx-receipt-id']);
    expect(saved.request.body.message).toBe(input);
    expect(saved.response.body).toBe(response.text);
    expect(saved.complete).toBe(true);
    expect(await receipts.read('other:owner', saved.id)).toBeNull();
  });

  test('refuses processing when initial durable storage fails', async () => {
    const handler = jest.fn();
    const response = await request(app(handler, { accept: async () => { throw new Error('disk unavailable'); } })).post('/chat').send({ message: 'Keep me' });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('EXCHANGE_SAVE_FAILED');
    expect(handler).not.toHaveBeenCalled();
  });

  test('writes every streamed byte before it is delivered and replays a completed retry without another inference', async () => {
    const handler = jest.fn((_req, res) => {
      res.type('text/event-stream');
      res.write('event: delta\ndata: {"text":"Bonjour"}\n\n');
      res.end('event: done\ndata: {"partial":true}\n\n');
    });
    const instance = app(handler);
    const first = await request(instance).post('/chat').set('Idempotency-Key', 'turn-1').send({ message: 'Original' });
    const saved = await receipts.read('synthetic:owner', first.headers['x-agentx-receipt-id']);
    expect(saved.response.body).toBe(first.text);
    const replay = await request(instance).post('/chat').set('Idempotency-Key', 'turn-1').send({ message: 'Original' });
    expect(replay.text).toBe(first.text);
    expect(handler).toHaveBeenCalledTimes(1);
    const conflict = await request(instance).post('/chat').set('Idempotency-Key', 'turn-1').send({ message: 'Changed' });
    expect(conflict.status).toBe(409);
  });

  test('after a crash, retains partial output and refuses to execute the uncertain request again', async () => {
    const original = { path: '/chat', method: 'POST', body: { message: 'Original' } };
    const { receipt } = await receipts.accept('synthetic:owner', original, 'crashed');
    await receipts.append(receipt, 0, Buffer.from('Partial received response'));
    const handler = jest.fn();
    const response = await request(app(handler)).post('/chat').set('Idempotency-Key', 'crashed').send(original.body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EXCHANGE_OUTCOME_UNKNOWN');
    expect(handler).not.toHaveBeenCalled();
    const read = await receipts.read('synthetic:owner', receipt._id);
    expect(read.request).toEqual(original);
    expect(read.response.body).toBe('Partial received response');
    expect(read.complete).toBe(false);
  });

  test('explicit erasure removes original content and packets and prevents replay of its identity', async () => {
    const { receipt } = await receipts.accept('synthetic:owner', { body: { message: 'Erase this original' } }, 'forgotten', 'conversation-1');
    await receipts.append(receipt, 0, Buffer.from('Erase this response'));
    await receipts.finish(receipt, 'completed', { packets: 1, statusCode: 200 });
    await receipts.eraseConversation('conversation-1');
    expect(await receipts.read('synthetic:owner', receipt._id)).toBeNull();
    expect(await mongoose.connection.collection('conversation_exchange_packets').countDocuments({ receiptId: receipt._id })).toBe(0);
    expect(await mongoose.connection.collection('conversation_payload_chunks').countDocuments({ owner: `exchange:${receipt._id}` })).toBe(0);
    await expect(receipts.accept('synthetic:owner', { body: { message: 'Erase this original' } }, 'forgotten')).rejects.toMatchObject({ code: 'EXCHANGE_ERASED', statusCode: 410 });
    await expect(receipts.append(receipt, 1, Buffer.from('Late delivery'))).rejects.toMatchObject({ code: 'EXCHANGE_CLOSED' });
  });

  test('a missing response packet refuses recovery rather than returning a complete-looking reply', async () => {
    const { receipt } = await receipts.accept('synthetic:owner', { body: { message: 'Original' } });
    await receipts.append(receipt, 0, Buffer.from('First'));
    await receipts.append(receipt, 1, Buffer.from('Last'));
    await receipts.finish(receipt, 'completed', { packets: 2, statusCode: 200 });
    await mongoose.connection.collection('conversation_exchange_packets').deleteOne({ _id: `${receipt._id}:0` });
    await expect(receipts.read('synthetic:owner', receipt._id)).rejects.toMatchObject({ code: 'EXCHANGE_INTEGRITY_FAILED' });
  });

  test('concurrent local retries receive the settled reply without executing another inference', async () => {
    const handler = jest.fn(async (_req, res) => {
      await new Promise(resolve => setTimeout(resolve, 80));
      res.json({ response: 'Synthetic settled answer' });
    });
    const instance = app(handler);
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(instance)
      .post('/chat').set('Idempotency-Key', 'concurrent-turn').send({ message: 'One inference' })));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(responses.map(response => response.text)).size).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
