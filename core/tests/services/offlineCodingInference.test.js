'use strict';

jest.mock('mongoose', () => ({ connect: jest.fn(async () => {}), disconnect: jest.fn(async () => {}) }));
jest.mock('../../config/logger', () => ({ transports: [] }));
jest.mock('../../src/services/inferenceHostRegistry', () => ({ load: jest.fn(async () => {}) }));
jest.mock('../../src/services/modelRouterConfig', () => ({
  ensureTaskModelOverridesLoaded: jest.fn(async () => {}), refreshPinCache: jest.fn(async () => {})
}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ validateHostUrl: jest.fn(url => ({ valid: true, host: url })) }));
jest.mock('../../src/services/hostPreferenceService', () => ({ getByHost: jest.fn(async () => ({})), getPinnedModelNames: jest.fn(() => ['candidate']) }));
jest.mock('../../src/extensions/trustedRuntimeServices', () => ({ createTrustedRuntimeServices: jest.fn() }));
jest.mock('../../src/services/routing/taskFallbackLadder', () => ({ refusedBeforeDispatch: jest.fn(error => error.code === 'BUSY') }));
const mongoose = require('mongoose');
const preferences = require('../../src/services/hostPreferenceService');
const { createTrustedRuntimeServices } = require('../../src/extensions/trustedRuntimeServices');
const { open } = require('../../src/services/offlineCodingInference');

describe('offline coding inference admission', () => {
  let execute;
  const options = { model: 'candidate', hostUrl: 'http://gpu.example.test:11434', outputTokens: 1000, timeoutMs: 60000 };
  beforeEach(() => {
    jest.clearAllMocks(); preferences.getPinnedModelNames.mockReturnValue(['candidate']);
    execute = jest.fn(async () => ({ ok: true, body: { model: 'candidate', done: true, message: { content: 'patch' } } }));
    createTrustedRuntimeServices.mockReturnValue({ inference: { execute } });
  });
  test('refuses an unpinned model before inference and closes the read connection', async () => {
    preferences.getPinnedModelNames.mockReturnValue(['other']);
    await expect(open(options)).rejects.toThrow('not pinned');
    expect(execute).not.toHaveBeenCalled(); expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  });
  test('passes the exact model and host through Core and requires their terminal result', async () => {
    const runtime = await open(options), messages = [{ role: 'user', content: 'task' }];
    await expect(runtime.infer(messages)).resolves.toMatchObject({ model: 'candidate', done: true });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ model: 'candidate', messages, stream: false }),
      { hostUrl: options.hostUrl, consumerContract: 'completed-coding-replay' });
    execute.mockResolvedValueOnce({ ok: true, body: { model: 'fallback', done: true } });
    await expect(runtime.infer(messages)).rejects.toMatchObject({ code: 'UNVERIFIED_INFERENCE', replay: 'stop' });
    execute.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'BUSY' }));
    await expect(runtime.infer(messages)).rejects.toMatchObject({ replay: 'busy' });
    execute.mockRejectedValueOnce(new Error('unknown upstream result'));
    await expect(runtime.infer(messages)).rejects.toMatchObject({ replay: 'stop' });
  });
});
