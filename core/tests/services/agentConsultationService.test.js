'use strict';
const { randomUUID } = require('node:crypto');
const { forSurface } = require('../../src/services/surfaceConversationService');
const { createConsultations } = require('../../src/services/agentConsultationService');
const conversations = forSurface('agent-consultations');
const runId = 'resp_11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const request = () => ({ action: 'request', requestId: randomUUID(), member: 'secretary', question: 'Read synthetic mail. Do not send.' });
const catalog = { agents: [{ id: 'secretary' }, { id: 'main' }] };

test('concurrent delivery executes once and completed replay retains canonical evidence', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const execute = jest.fn(async args => {
    await args.onStarted(args.session.consultation.sessionKey, runId);
    await wait;
    return { text: 'Checked result.', sessionKey: args.session.consultation.sessionKey, runId,
      tools: { authority: 'openclaw/secretary', receipts: [{ tool: 'synthetic_read' }] } };
  });
  const service = createConsultations({ conversations, execute, observe: async () => catalog });
  const input = request();
  const calls = Array.from({ length: 5 }, () => service.operate(input));
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  const rows = await Promise.all(calls);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(new Set(rows.map(row => row.sessionId)).size).toBe(1);
  release();
  let result;
  for (let i = 0; i < 40; i++) {
    result = await service.operate({ action: 'status', requestId: input.requestId });
    if (result.state === 'completed') break;
    await tick();
  }
  expect(result).toMatchObject({ state: 'completed', answer: 'Checked result.', evidence: { authority: 'openclaw/secretary' } });
  expect((await service.operate(input)).answer).toBe(result.answer);
  expect(execute).toHaveBeenCalledTimes(1);
  expect((await conversations.getSession({ sessionId: rows[0].sessionId })).turnCount).toBe(1);
  await expect(service.operate({ ...input, question: 'Different request.' })).rejects.toMatchObject({ code: 'CONSULTATION_ID_CONFLICT' });
});

test('lost acceptance survives restart and recovers the original answer without replacement', async () => {
  const input = request();
  const execute = jest.fn(async () => { throw new Error('Lost acceptance'); });
  let service = createConsultations({ conversations, execute, observe: async () => catalog });
  const accepted = await service.operate(input);
  await tick();
  const observe = jest.fn(async args => args.operation === 'work_attempt'
    ? { sessionKey: accepted.sessionKey, runId }
    : { authority: 'openclaw.nestor', operation: 'turn', run: { sessionKey: accepted.sessionKey, runId, status: 'completed' },
      answer: { runId, status: 'ready', text: 'Recovered original answer.' }, receipts: [{ tool: 'original_read' }] });
  service = createConsultations({ conversations, execute, observe });
  expect(await service.operate(input)).toMatchObject({ state: 'completed', answer: 'Recovered original answer.', runId });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0][0]).toMatchObject({ operation: 'work_attempt', isolatedConsultation: true });
});

test('missing evidence keeps the durable fence across retries', async () => {
  const input = request();
  const execute = jest.fn(async () => { throw new Error('Network gone'); });
  const service = createConsultations({ conversations, execute, observe: async args => args.operation === 'agents' ? catalog : { runId: null } });
  await service.operate(input); await tick();
  expect((await service.operate(input)).state).toBe('uncertain');
  expect((await service.operate(input)).state).toBe('uncertain');
  expect(execute).toHaveBeenCalledTimes(1);
});

test('uninstalled specialists and invalid identities never launch', async () => {
  const execute = jest.fn();
  const service = createConsultations({ conversations, execute, observe: async () => ({ agents: [] }) });
  await expect(service.operate(request())).rejects.toMatchObject({ code: 'CONSULTATION_MEMBER_UNAVAILABLE' });
  await expect(service.operate({ ...request(), requestId: 'invalid' })).rejects.toMatchObject({ code: 'CONSULTATION_INVALID' });
  expect(execute).not.toHaveBeenCalled();
});
