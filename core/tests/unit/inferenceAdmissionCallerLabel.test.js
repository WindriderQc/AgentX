const { beginAdmittedOllamaAttempt } = require('../../src/services/routing/inferenceAttemptExecutor');

async function capture(options) {
  let seen = null;
  const stop = new Error('captured');
  await expect(beginAdmittedOllamaAttempt({ hostUrl: 'http://10.0.0.10:11434', model: 'm', payload: {}, ...options }, {
    beginInferenceAdmission: async (args) => { seen = args; throw stop; },
    hostGate: {}
  })).rejects.toBe(stop);
  return seen;
}

describe('inference admission caller label', () => {
  test('carries the caller detail for the live requests view', async () => {
    expect((await capture({ callerLabel: 'ops-watch', cacheLabels: { consumerContract: 'x-v1' } })).caller).toBe('ops-watch');
  });
  test('falls back to the consumer contract, then the task type', async () => {
    expect((await capture({ cacheLabels: { consumerContract: 'rag-service-v1', taskType: 't' } })).caller).toBe('rag-service-v1');
    expect((await capture({ cacheLabels: { taskType: 'mail_review' } })).caller).toBe('mail_review');
    expect((await capture({})).caller).toBeNull();
  });
});
