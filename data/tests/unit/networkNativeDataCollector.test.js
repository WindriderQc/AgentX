'use strict';

process.env.SCAN_CIDR = '192.0.2.0/24';
process.env.DATA_URL = 'http://data.invalid:3083';
process.env.SCANNER_ID = 'collector-fixture';

jest.mock('child_process', () => ({ execFile: jest.fn() }));

const { execFile } = require('child_process');
const { isScanTarget, serviceRequest, poll } = require('../../../integrations/data-collectors/network-agent');

const XML = '<nmaprun><runstats><finished exit="success"/></runstats></nmaprun>';
const jsonResponse = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
const originalFetch = global.fetch;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  execFile.mockImplementation((_bin, _args, _options, callback) => callback(null, XML, ''));
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

test('isScanTarget accepts only IPv4 targets from /16 to /32', () => {
  for (const target of ['192.0.2.0/24', '192.0.2.0/16', '192.0.2.7/32', '192.0.2.7']) {
    expect(isScanTarget(target)).toBe(true);
  }
  for (const target of ['0.0.0.0/0', '10.0.0.0/8', '192.0.2.0/15', '192.0.2.0/33', '999.1.1.1/24',
    '-iL /etc/hosts', '192.0.2.0/24 --script x', '192.0.2.0/24/24', '', null, { target: '192.0.2.0/24' }]) {
    expect(isScanTarget(target)).toBe(false);
  }
  // The operator's own SCAN_CIDR is checked for form only.
  expect(isScanTarget('10.0.0.0/8', 0)).toBe(true);
  expect(isScanTarget('10.0.0.999/8', 0)).toBe(false);
});

test.each(['0.0.0.0/0', '999.1.1.1/99', '-iL /etc/hosts', '10.0.0.0/8'])(
  'a queued request for %s never reaches nmap or Data', async (target) => {
    global.fetch = jest.fn();
    await serviceRequest({ requestId: 'r1', target });
    expect(execFile).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('invalid scan target'));
  }
);

test('a valid queued request runs nmap on its target and posts the XML with a timeout', async () => {
  global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { discovered: 0, updated: 0 } }));
  await serviceRequest({ requestId: 'r1', target: '192.0.2.0/28' });

  expect(execFile.mock.calls[0][1]).toEqual(['-sn', '--privileged', '-oX', '-', '192.0.2.0/28']);
  const [url, options] = global.fetch.mock.calls[0];
  expect(url).toBe('http://data.invalid:3083/api/v1/network/scan-results');
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.parse(options.body)).toMatchObject({ requestId: 'r1', format: 'nmap-xml', xml: XML });
});

test('poll passes a timeout and skips a tick while the previous poll is still waiting', async () => {
  let release;
  global.fetch = jest.fn(() => new Promise((resolve) => { release = resolve; }));

  const first = poll();
  await expect(poll()).resolves.toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);

  release(jsonResponse({ data: { requests: [] } }));
  await expect(first).resolves.toBe(true);

  // The guard is released, also after a failed poll.
  global.fetch = jest.fn().mockRejectedValue(new Error('The operation was aborted due to timeout'));
  await expect(poll()).resolves.toBe(true);
  await expect(poll()).resolves.toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
