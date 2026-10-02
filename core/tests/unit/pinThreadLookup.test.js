'use strict';

const HostPreference = require('../../models/HostPreference');
const hostConfig = require('../../src/helpers/ollamaHostConfig');
const { pinNumThread, watchdogProbeOptions } = require('../../src/services/pinThreadLookup');

const HOST = 'http://cpu-thread-host:11435';

beforeEach(async () => {
  hostConfig.setRegisteredHosts([{ id: 'cpu-thread-host', url: HOST, residency: 'cpu' }]);
  await HostPreference.deleteMany({});
  await HostPreference.create({ hostUrl: HOST, hostKey: 'cpu-thread-host', pinnedModels: [
    { model: 'gemma4:26b-a4b-it-qat', contextSize: 32768, numThread: 6 },
    { model: 'qllama/bge-m3:f16' }
  ] });
});

test('reads the pinned thread count, 0 when unset or unknown', async () => {
  await expect(pinNumThread(HOST, 'gemma4:26b-a4b-it-qat')).resolves.toBe(6);
  await expect(pinNumThread(HOST, 'qllama/bge-m3:f16')).resolves.toBe(0);
  await expect(pinNumThread(HOST, 'other:1b')).resolves.toBe(0);
  await expect(pinNumThread('http://nowhere:11434', 'gemma4:26b-a4b-it-qat')).resolves.toBe(0);
});

test('a watchdog probe keeps the resident runner options so it never reloads it', async () => {
  await expect(watchdogProbeOptions(HOST, 'gemma4:26b-a4b-it-qat', 32768))
    .resolves.toEqual({ num_predict: 1, num_ctx: 32768, num_thread: 6 });
  await expect(watchdogProbeOptions(HOST, null, null)).resolves.toEqual({ num_predict: 1 });
  await expect(watchdogProbeOptions('http://gpu:11434', 'gemma4:12b-it-qat', 114688))
    .resolves.toEqual({ num_predict: 1, num_ctx: 114688 });
});
