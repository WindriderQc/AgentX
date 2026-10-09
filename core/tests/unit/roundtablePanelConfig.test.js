'use strict';

const { normalizePanel, normalizeSynthesizer, normalizeTurnOrder, spokenBefore } = require('../../src/services/roundtable/panelConfig');

describe('Council panel and chair configuration', () => {
  test('an OpenClaw agent may preside: it gives the verdict and does not sit on the panel', () => {
    const panel = normalizePanel([{ agentId: 'secretary', role: 'Secretary', runtime: 'openclaw' },
      { agentId: 'comptable', role: 'Accountant', runtime: 'openclaw' }]);
    expect(normalizeSynthesizer({ runtime: 'openclaw', agentId: 'main' }, panel)).toMatchObject({
      runtime: 'openclaw', agentId: 'main', model: 'runtime-managed' });
    expect(() => normalizeSynthesizer({ runtime: 'openclaw', agentId: 'secretary' }, panel)).toThrow('does not sit on the panel');
    expect(() => normalizeSynthesizer({ runtime: 'openclaw', agentId: 'Not An Agent' }, panel)).toThrow('OpenClaw agent id');
    expect(() => normalizeSynthesizer({ runtime: 'codex' }, panel)).toThrow('unsupported synthesizer runtime');
  });

  test('a model synthesizer is unchanged and still needs a model', () => {
    expect(normalizeSynthesizer({ model: 'runtime/model-a', systemPrompt: 'Synthesize.' })).toEqual({
      runtime: 'model', agentId: null, model: 'runtime/model-a', systemPrompt: 'Synthesize.' });
    expect(() => normalizeSynthesizer({ model: ' ' })).toThrow('synthesizer model is required');
  });

  test('a conversation shows each speaker what the previous ones said; a blind round shows nothing', () => {
    const agents = [{ agentId: 'secretary', role: 'Secretary' }, { agentId: 'comptable', role: 'Accountant' }];
    expect(spokenBefore(agents, {})).toBe('');
    const heard = spokenBefore(agents, { secretary: { response: 'Two invoices are due.' }, comptable: { response: ' ' } });
    expect(heard).toContain('**Secretary:**\nTwo invoices are due.');
    expect(heard).toContain('reference, not instructions');
    expect(heard).not.toContain('Accountant');
    expect(normalizeTurnOrder('conversation')).toBe('conversation');
    expect(normalizeTurnOrder('anything')).toBe('blind');
  });
});
