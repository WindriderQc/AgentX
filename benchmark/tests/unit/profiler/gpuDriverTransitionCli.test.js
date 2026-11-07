'use strict';

const { main } = require('../../../scripts/gpu-driver-preparation');
const common = ['--url', 'http://benchmark.example:3002', '--host-id', 'synthetic-host'];

test.each(['activate', 'abandon'])('%s sends one exact action and preparation identity through the owner API', async action => {
  const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const fetch = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'success', data: { state: 'synthetic-result' } }) }));
    await main([action, ...common, '--request-id', 'action-synthetic-host', '--preparation-id', 'prepare-synthetic-host'], fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(`http://benchmark.example:3002/api/profiler/hosts/gpu-driver/synthetic-host/${action}`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ requestId: 'action-synthetic-host', preparationId: 'prepare-synthetic-host' }) }));
  } finally { write.mockRestore(); }
});

test.each([
  ['activate', ...common, '--request-id', 'action-synthetic-host'],
  ['abandon', ...common, '--preparation-id', 'prepare-synthetic-host'],
  ['activate', ...common, '--request-id', '--preparation-id', 'prepare-synthetic-host'],
  ['activate', ...common, '--request-id', 'action-synthetic-host', '--request-id', 'action-synthetic-other']
])('incomplete or conflicting native action intent is refused before transport (%j)', async (...args) => {
  const fetch = jest.fn();
  await expect(main(args, fetch)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
