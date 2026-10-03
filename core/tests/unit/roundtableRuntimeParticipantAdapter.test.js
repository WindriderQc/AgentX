'use strict';

const {
  buildRuntimePrompt,
  callRuntimeParticipant,
  validateRuntimeConfiguration,
} = require('../../src/services/roundtable/runtimeParticipantAdapter');

describe('roundtable Codex participant bridge', () => {
  test('builds a bounded advisory prompt', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'Evaluate the proposal.' }],
      { agentId: 'reviewer', role: 'Reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt).toContain('do not execute commands');
    expect(prompt).toContain('Do not reveal hidden chain-of-thought');
    expect(prompt).toContain('[USER]\nEvaluate the proposal.');
  });

  test('keeps the guard when a long transcript is truncated', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'x'.repeat(40000) }],
      { agentId: 'reviewer', role: 'Reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt.length).toBeLessThanOrEqual(30000);
  });

  test('uses only the server-configured Codex bridge URL', async () => {
    let requestedUrl;
    const result = await callRuntimeParticipant(
      { runtime: 'codex', agentId: 'codex-reviewer', role: 'Codex', runtimeConfig: { sessionKey: 'rt-2' } },
      [{ role: 'user', content: 'Review this design.' }],
      { roundtableId: 'rt-2', round: 1, timeoutMs: 5000 },
      {
        env: {
          ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
          ROUNDTABLE_CODEX_BRIDGE_URL: 'http://codex-bridge.internal/turn',
          ROUNDTABLE_CODEX_BRIDGE_TOKEN: 'private-token',
        },
        fetchImpl: async (url, options) => {
          requestedUrl = url;
          expect(options.headers.Authorization).toBe('Bearer private-token');
          return { ok: true, json: async () => ({ response: 'Looks sound.', sessionId: 's-1' }) };
        },
      }
    );
    expect(requestedUrl).toBe('http://codex-bridge.internal/turn');
    expect(result).toEqual(expect.objectContaining({ response: 'Looks sound.', runtimeRef: 's-1', error: null }));
  });

  test('fails closed for unsupported runtimes and disabled bridges', async () => {
    const unsupported = await callRuntimeParticipant(
      { runtime: 'external-runtime', agentId: 'external', role: 'External' },
      [{ role: 'user', content: 'Discuss.' }],
      { roundtableId: 'rt-3', round: 1, timeoutMs: 5000 },
      { env: {} }
    );
    expect(unsupported.error).toContain('Unsupported runtime participant');

    expect(() => validateRuntimeConfiguration([{ runtime: 'codex' }], {}))
      .toThrow('Runtime participants are disabled');
  });

  test('requires an HTTP(S) Codex bridge', () => {
    expect(() => validateRuntimeConfiguration([{ runtime: 'codex' }], {
      ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
      ROUNDTABLE_CODEX_BRIDGE_URL: 'file:///tmp/not-allowed',
    })).toThrow('http or https');
    expect(validateRuntimeConfiguration([{ runtime: 'codex' }], {
      ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
      ROUNDTABLE_CODEX_BRIDGE_URL: 'https://codex.example/turn',
    })).toBe(true);
  });
});

describe('roundtable OpenClaw agent participants', () => {
  const { finalOpenClawText, listOpenClawAgents } = require('../../src/services/roundtable/runtimeParticipantAdapter');
  const env = { ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true', OPENCLAW_GATEWAY_URL: 'ws://gateway.invalid:18789', OPENCLAW_GATEWAY_TOKEN: 'synthetic-token' };
  const completed = (text) => ({ status: 'completed', output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Je vérifie.' }] },
    { type: 'function_call', name: 'read' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
  ] });

  test('seats a named agent in a session dedicated to this Council and keeps its final answer', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => completed('Deux factures attendent.') }; };
    const result = await callRuntimeParticipant({ agentId: 'secretary', role: 'Secrétaire', runtime: 'openclaw' },
      [{ role: 'user', content: 'Quelles dépenses surveiller?' }], { roundtableId: '6ac0abc', round: 1, timeoutMs: 5000 }, { env, fetchImpl });
    expect(result).toMatchObject({ response: 'Deux factures attendent.', error: null, runtime: 'openclaw',
      target: 'openclaw://secretary', runtimeRef: 'agent:secretary:roundtable:6ac0abc' });
    expect(calls[0].url).toBe('http://gateway.invalid:18789/v1/responses');
    expect(calls[0].options.headers).toMatchObject({ Authorization: 'Bearer synthetic-token', 'x-openclaw-session-key': 'agent:secretary:roundtable:6ac0abc' });
    const body = JSON.parse(calls[0].options.body);
    expect(body).toMatchObject({ model: 'openclaw/secretary', stream: false });
    expect(body.instructions).toContain('advisory only');
    expect(body.input[0].content).toContain('Quelles dépenses surveiller?');
  });

  test('an unfinished run or an invalid agent id is a participant error, not an answer', async () => {
    expect(() => finalOpenClawText({ status: 'incomplete', output: [] })).toThrow('OpenClaw run ended incomplete');
    const fetchImpl = async () => ({ ok: true, json: async () => ({ status: 'failed' }) });
    const failed = await callRuntimeParticipant({ agentId: 'secretary', runtime: 'openclaw' }, [], { roundtableId: 'x', timeoutMs: 5000 }, { env, fetchImpl });
    expect(failed.response).toBe('');
    expect(failed.error).toContain('OpenClaw run ended failed');
    expect(() => validateRuntimeConfiguration([{ agentId: 'Not An Agent', runtime: 'openclaw' }], env)).toThrow('OpenClaw agent id');
    expect(() => validateRuntimeConfiguration([{ agentId: 'secretary', runtime: 'openclaw' }], { ...env, OPENCLAW_GATEWAY_TOKEN: '' })).toThrow('OPENCLAW_GATEWAY_TOKEN');
    expect(validateRuntimeConfiguration([{ agentId: 'secretary', runtime: 'openclaw' }], env)).toBe(true);
  });

  test('the roster comes from the gateway, never offers the family agent, and is empty when runtimes are off', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ authority: 'openclaw.nestor', agents: [
      { id: 'main', name: 'Main' }, { id: 'secretary', name: 'Secrétaire' }, { id: 'family', name: 'Nestor Famille' }, { id: 'Bad Id' }] }) });
    expect(await listOpenClawAgents(env, fetchImpl)).toEqual([{ id: 'main', name: 'Main' }, { id: 'secretary', name: 'Secrétaire' }]);
    expect(await listOpenClawAgents({ ...env, ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: '' }, fetchImpl)).toEqual([]);
    expect(await listOpenClawAgents(env, async () => { throw new Error('down'); })).toEqual([]);
  });
});
