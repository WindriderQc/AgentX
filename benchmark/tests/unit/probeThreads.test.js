'use strict';

jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getHostPinThreads: jest.fn() }));

const hostConfig = require('../../src/helpers/ollamaHostConfig');
const { withPinThreads } = require('../../src/services/probeThreads');

const CPU = 'http://cpu-a:11435';

describe('Profiler probe CPU threads', () => {
  beforeEach(() => hostConfig.getHostPinThreads.mockReset());

  it('adds the pinned thread count of the host and keeps every other option', () => {
    hostConfig.getHostPinThreads.mockReturnValue(4);
    const body = { model: 'example:latest', prompt: 'Hi', options: { num_ctx: 8192, num_predict: 1 } };
    expect(withPinThreads(CPU, body)).toEqual({ model: 'example:latest', prompt: 'Hi',
      options: { num_ctx: 8192, num_predict: 1, num_thread: 4 } });
    expect(body.options.num_thread).toBeUndefined();
    expect(hostConfig.getHostPinThreads).toHaveBeenCalledWith(CPU, 'example:latest');
    expect(withPinThreads(CPU, { model: 'example:latest', prompt: 'Hi' }).options).toEqual({ num_thread: 4 });
  });

  it('leaves the request alone without a pinned count, with a caller count, or for an unload', () => {
    hostConfig.getHostPinThreads.mockReturnValue(0);
    const plain = { model: 'example:latest', options: { num_ctx: 8192 } };
    expect(withPinThreads('http://gpu-a:11434', plain)).toBe(plain);

    hostConfig.getHostPinThreads.mockReturnValue(4);
    const own = { model: 'example:latest', options: { num_thread: 2 } };
    expect(withPinThreads(CPU, own)).toBe(own);
    for (const keepAlive of [0, '0']) {
      const unload = { model: 'example:latest', keep_alive: keepAlive, stream: false };
      expect(withPinThreads(CPU, unload)).toBe(unload);
    }
    expect(withPinThreads(CPU, null)).toBeNull();
  });
});
