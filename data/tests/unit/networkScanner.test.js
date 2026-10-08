jest.mock('child_process', () => ({ spawn: jest.fn() }));

const { spawn } = require('child_process');
const networkScanner = require('../../services/networkScanner');
const { isIPv4, isScanTarget, sanitizeDevice } = require('../../utils/networkInput');

const HOST_UP = '<host><status state="up"/><address addr="192.0.2.10" addrtype="ipv4"/>'
  + '<address addr="AA:BB:CC:DD:EE:FF" addrtype="mac" vendor="Acme"/>'
  + '<hostnames><hostname name="printer"/></hostnames></host>';
const report = (body) => `<?xml version="1.0"?><nmaprun scanner="nmap">${body}`
  + '<runstats><finished exit="success"/><hosts up="0" down="0" total="0"/></runstats></nmaprun>';

describe('parseNmapOutput', () => {
  test('returns the hosts that are up', async () => {
    const devices = await networkScanner.parseNmapOutput(
      report(HOST_UP + '<host><status state="down"/><address addr="192.0.2.11" addrtype="ipv4"/></host>')
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ ip: '192.0.2.10', mac: 'AA:BB:CC:DD:EE:FF', vendor: 'Acme', hostname: 'printer' });
  });

  test('a valid report without any host is an empty result, not an error', async () => {
    await expect(networkScanner.parseNmapOutput(report(''))).resolves.toEqual([]);
  });

  test.each([
    ['empty text', ''],
    ['text that is not XML', 'Starting Nmap 7.94'],
    ['truncated XML', '<nmaprun><host><status state="up"/>'],
    ['another document', '<html><body/></html>'],
    ['a host without status', '<nmaprun><host><address addr="192.0.2.10" addrtype="ipv4"/></host></nmaprun>']
  ])('rejects %s instead of reporting an empty network', async (_label, xml) => {
    await expect(networkScanner.parseNmapOutput(xml)).rejects.toMatchObject({
      code: 'NMAP_XML_INVALID', message: expect.stringMatching(/^Invalid nmap XML: /)
    });
  });
});

describe('enrichDevice', () => {
  test.each(['-iL', '--script=x', '192.0.2.10 -oN /tmp/x', '192.0.2.0/24', '192.0.2.256', '', undefined, { ip: '192.0.2.10' }])(
    'refuses stored address %p without starting nmap', async (ip) => {
      await expect(networkScanner.enrichDevice(ip)).rejects.toMatchObject({ code: 'INVALID_TARGET' });
      expect(spawn).not.toHaveBeenCalled();
    }
  );
});

describe('network input validation', () => {
  test('isIPv4 checks every octet', () => {
    expect(isIPv4('192.0.2.255')).toBe(true);
    expect(isIPv4('0.0.0.0')).toBe(true);
    expect(isIPv4('192.0.2.256')).toBe(false);
    expect(isIPv4('192.0.2')).toBe(false);
    expect(isIPv4(' 192.0.2.1')).toBe(false);
    expect(isIPv4(['192.0.2.1'])).toBe(false);
  });

  test('isScanTarget limits the prefix to /16../32', () => {
    expect(isScanTarget('192.0.2.0/16')).toBe(true);
    expect(isScanTarget('192.0.2.0/32')).toBe(true);
    expect(isScanTarget('192.0.2.1')).toBe(true);
    expect(isScanTarget('192.0.2.0/15')).toBe(false);
    expect(isScanTarget('0.0.0.0/0')).toBe(false);
    expect(isScanTarget('192.0.2.0/')).toBe(false);
    expect(isScanTarget('192.0.2.0/24 -oN x')).toBe(false);
    expect(isScanTarget(undefined)).toBe(false);
  });

  test('sanitizeDevice returns plain strings only', () => {
    expect(sanitizeDevice({ ip: '192.0.2.1', mac: null, extra: { $set: 1 } }))
      .toEqual({ ip: '192.0.2.1', mac: '', hostname: '', vendor: '' });
    expect(sanitizeDevice({ ip: '192.0.2.1', mac: { $ne: '' } })).toBeNull();
    expect(sanitizeDevice({ ip: '192.0.2.1', hostname: 5 })).toBeNull();
  });
});
