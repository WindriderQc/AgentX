'use strict';
const { createRelayContinuation } = require('../../src/services/routing/conversationRelayContinuation');
const messages = [{ role: 'user', content: 'Continue.' }];
function fixture({ family = false } = {}) {
  const occupation = { authority: 'hermes', state: 'running', runId: 'exact-run', sessionKey: 'exact-session' };
  const execute = jest.fn(async () => ({ ok: true }));
  const observeOccupation = jest.fn(async () => occupation);
  const observeFamilyOccupation = jest.fn(async () => true);
  const signal = new AbortController();
  const continuation = createRelayContinuation({ reduced: { model: 'synthetic-guardian', options: { num_ctx: 8192 } },
    target: { hostUrl: 'http://primary.fixture' }, execute, options: { observeOccupation, consumerContract: {} },
    hostUrl: 'http://guardian.fixture', routing: {}, continuity: { state: 'backup' }, maxInputChars: 2048,
    observeFamilyOccupation, occupation: family ? null : occupation, signal: signal.signal });
  return { continuation, execute, observeOccupation, observeFamilyOccupation, signal };
}

test.each([false, true])('continuations keep the selected host/context and ordinary admission without a new primary attempt (family=%s)', async family => {
  const w = fixture({ family });
  await w.continuation.execute(messages, []);
  expect(w.execute).toHaveBeenCalledWith(expect.objectContaining({ model: 'synthetic-guardian', messages, options: { num_ctx: 8192 } }),
    expect.objectContaining({ hostUrl: 'http://guardian.fixture', retry: { enabled: false } }));
});
test('stale or foreign Hermes occupation prevents another model request', async () => {
  const w = fixture();
  w.observeOccupation.mockResolvedValue({ authority: 'hermes', state: 'running', runId: 'foreign', sessionKey: 'exact-session' });
  await expect(w.continuation.execute(messages)).rejects.toMatchObject({ code: 'RELAY_OCCUPATION_CHANGED' });
  expect(w.execute).not.toHaveBeenCalled();
});
test('Family without fresh native occupation cannot execute a tool or another model call', async () => {
  const w = fixture({ family: true }); w.observeFamilyOccupation.mockResolvedValue(null);
  await expect(w.continuation.assertOccupied()).rejects.toMatchObject({ code: 'RELAY_OCCUPATION_CHANGED' });
  expect(w.execute).not.toHaveBeenCalled();
});
test('cancellation and context limits stop dispatch; two continuations are the absolute budget', async () => {
  const w = fixture();
  await expect(w.continuation.execute([{ role: 'tool', content: 'x'.repeat(3000) }])).rejects.toMatchObject({ code: 'RELAY_CONTEXT_EXCEEDED' });
  expect(w.execute).not.toHaveBeenCalled();
  const valid = fixture();
  await valid.continuation.execute(messages); await valid.continuation.execute(messages);
  await expect(valid.continuation.execute(messages)).rejects.toMatchObject({ code: 'RELAY_CONTEXT_EXCEEDED' });
  expect(valid.execute).toHaveBeenCalledTimes(2);
  const cancelled = fixture(); cancelled.signal.abort(Error('stop'));
  await expect(cancelled.continuation.execute(messages)).rejects.toThrow('stop');
  expect(cancelled.execute).not.toHaveBeenCalled();
});
