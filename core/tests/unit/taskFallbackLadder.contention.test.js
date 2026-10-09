'use strict';

process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

jest.mock('../../src/services/routing/inferenceContentionCounters', () => ({
  countContention: jest.fn(async () => {}),
}));

const { countContention } = require('../../src/services/routing/inferenceContentionCounters');
const ladder = require('../../src/services/routing/taskFallbackLadder');

const PRIMARY = 'qwen3.6:27b';
const LIGHT = 'gemma4:12b-it-qat';

function deps({ offline = [] } = {}) {
  let clock = 1_000_000;
  return {
    now: () => clock,
    sleep: jest.fn(async (ms) => { clock += ms; }),
    readCoordination: jest.fn(async () => null),
    assertHostAvailable: jest.fn(async () => null),
    checkHostHealth: jest.fn(async (url) => ({ online: !offline.includes(url), models: [PRIMARY, LIGHT] })),
    readPinVramSpill: jest.fn(async () => []),
  };
}

const primary = { model: PRIMARY, host: 'primary', url: 'http://primary:11434', source: 'fallback' };

describe('fallback ladder contention counters', () => {
  beforeEach(() => {
    process.env.AGENTX_TASK_FALLBACKS_JSON = JSON.stringify({ quick_chat: [{ model: LIGHT, host: 'tertiary' }] });
    ladder._internal.resetForTests();
    countContention.mockClear();
  });
  afterAll(() => { delete process.env.AGENTX_TASK_FALLBACKS_JSON; });

  test('a served rung counts ladder_served with its reason', async () => {
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primary, deps({ offline: ['http://primary:11434'] }));
    expect(result.degraded).toMatchObject({ reason: 'host_down' });
    expect(countContention).toHaveBeenCalledWith('ladder_served', { taskType: 'quick_chat', code: 'host_down' });
  });

  test('an exhausted ladder counts ladder_exhausted with the primary reason', async () => {
    const result = await ladder.applyTaskFallbackLadder('quick_chat', primary,
      deps({ offline: ['http://primary:11434', 'http://tertiary:11434'] }));
    expect(result.degraded).toBeUndefined();
    expect(countContention).toHaveBeenCalledWith('ladder_exhausted', { taskType: 'quick_chat', code: 'host_down' });
    expect(countContention).not.toHaveBeenCalledWith('ladder_served', expect.anything());
  });
});
