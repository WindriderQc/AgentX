'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isEmbeddingModelName } = require('./embeddingModels');

test('recognises embedding models, including org-prefixed bge tags', () => {
  for (const name of [
    'qllama/bge-m3:f16',
    'QLLAMA/BGE-M3:F16',
    'bge-m3',
    'bge-m3:f16',
    'bge-large:latest',
    'bge:latest',
    'library/bge-m3:567m',
    'nomic-embed-text:v1.5',
    'qwen3-embedding:0.6b',
    'embeddinggemma:300m',
    'mxbai-embed-large',
    'all-minilm:l6-v2'
  ]) {
    assert.equal(isEmbeddingModelName(name), true, name);
  }
});

test('does not flag generative models or empty names', () => {
  for (const name of [
    'ax/gemma4:26b-a4b-it-qat',
    'ax/qwen3.6:27b-mtp-q8_0',
    'qwen3-coder:30b',
    'llama3.2:3b',
    'gemma4:12b',
    'abge-chat:7b',
    '',
    null,
    undefined
  ]) {
    assert.equal(isEmbeddingModelName(name), false, String(name));
  }
});
