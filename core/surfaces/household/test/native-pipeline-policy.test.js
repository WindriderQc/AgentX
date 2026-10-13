'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestsPipelineRead } = require('../native-pipeline-policy');
const { requestsTaskCheck } = require('../tool-turn-guard');
test('current engineering pipeline questions select a read without selecting personal tasks', () => {
  for (const text of ['Quels éléments de mon pipeline sont prioritaires ?', 'Quoi dans mon pipeline en top priorité ?', 'Show the pipeline status.']) {
    assert.equal(requestsPipelineRead(text), true, text); assert.equal(requestsTaskCheck(text), false, text);
  }
  for (const text of ['Explique les priorités d’un pipeline.', 'Ne regarde pas mon pipeline.', 'Raconte une histoire de pipeline.', 'Quelles sont mes tâches prioritaires ?']) {
    assert.equal(requestsPipelineRead(text), false, text);
  }
});
