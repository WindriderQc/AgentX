'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const inference = require('../../../src/services/pipelineCodingInferenceService');
const { registerHermesProtocol } = require('../hermes/protocol');

test('frozen inference result streams content but holds terminal until the native coding receipt is durable', async () => {
  const prior = inference.prepare;
  let release;
  let completed;
  const persisted = new Promise(resolve => { release = resolve; });
  inference.prepare = async () => ({ options: { codingCapacity: { pipelineId: '0001', leaseId: 'synthetic' } },
    finish: async state => { completed = state; await persisted; } });
  try {
    const routes = [];
    const express = { Router: () => Object.fromEntries(['get', 'post', 'all'].map(method => [method,
      (path, ...handlers) => routes.push({ method, path, handlers })])) };
    const source = new PassThrough();
    let finish;
    const native = new Promise(resolve => { finish = resolve; });
    let options;
    registerHermesProtocol({ express, logger: {}, runtimeServices: {
      routing: { getEffectiveSnapshot: async () => ({ tasks: { code_generation: { model: 'synthetic' } } }) },
      inference: { execute: async (_input, opts) => { options = opts; return Object.freeze({ ok: true, status: 200,
        stream: source, completion: native, metadata: { model: 'synthetic', upstreamProtocol: 'ollama' } }); } }
    } });
    const req = new EventEmitter(); req.headers = {}; req.body = { model: 'synthetic', stream: true, messages: [{ role: 'user', content: 'Synthetic fixture' }] };
    const res = new PassThrough(); res.status = () => res; res.set = () => res;
    res.json = value => { throw new Error(JSON.stringify(value)); };
    let output = ''; res.on('data', data => { output += data.toString(); });
    await routes.find(route => route.path === '/v1/chat/completions').handlers[0](req, res);
    source.write('{"message":{"content":"first"},"done":false}\n');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(output, /first/);
    source.end('{"done":true}\n'); finish({ completed: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, 'completed'); assert.doesNotMatch(output, /\[DONE\]/);
    assert.equal(options.codingCapacity.pipelineId, '0001');
    const ended = once(res, 'end'); release(); await ended;
    assert.match(output, /\[DONE\]/);
  } finally { inference.prepare = prior; }
});
