'use strict';

const http = require('http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  QUERY_FIELDS,
  readSettings,
  loadHosts,
  parseNvidiaSmiCsv,
  decodeThrottleReasons,
  commandFor,
  sampleHost,
  runCycle
} = require('../../../integrations/data-collectors/gpu-agent');

const AGENT = path.resolve(__dirname, '../../../integrations/data-collectors/gpu-agent.js');
const ROW = '0, NVIDIA Synthetic 24GB, GPU-11111111-2222-3333-4444-555555555555, 00000000:01:00.0, 87, 40, 20000, 24576, 71, 301.25, 350.00, 1905, 2100, 4, 4, 16, 16, 0x0000000000000004';
const ROW_NA = '1, NVIDIA Synthetic 24GB, GPU-66666666-7777-8888-9999-000000000000, 00000000:02:00.0, [N/A], [Not Supported], 512, 24576, 45, [N/A], [N/A], 210, 2100, 1, 4, 8, 16, [Not Supported]';

const settings = { ...readSettings({}), hostTimeoutMs: 10_000, dataUrl: 'http://data.test' };

describe('gpu-agent parsing', () => {
  test('parses every queried field and decodes throttle reasons', () => {
    const [gpu] = parseNvidiaSmiCsv(`${ROW}\n`);
    expect(gpu).toEqual({
      index: 0,
      name: 'NVIDIA Synthetic 24GB',
      uuid: 'GPU-11111111-2222-3333-4444-555555555555',
      busId: '00000000:01:00.0',
      utilizationPct: 87,
      memoryUtilizationPct: 40,
      memoryUsedMiB: 20000,
      memoryTotalMiB: 24576,
      temperatureC: 71,
      powerDrawW: 301.25,
      powerLimitW: 350,
      smClockMHz: 1905,
      smClockMaxMHz: 2100,
      pcieGen: 4,
      pcieGenMax: 4,
      pcieWidth: 16,
      pcieWidthMax: 16,
      throttleReasonsActive: '0x0000000000000004',
      throttleReasons: ['sw_power_cap']
    });
  });

  test('[N/A] and [Not Supported] become null, never zero', () => {
    const [, gpu] = parseNvidiaSmiCsv(`${ROW}\r\n${ROW_NA}\r\n`);
    expect(gpu).toMatchObject({
      index: 1, utilizationPct: null, memoryUtilizationPct: null, powerDrawW: null,
      powerLimitW: null, memoryUsedMiB: 512, pcieGen: 1, pcieWidth: 8,
      throttleReasonsActive: null, throttleReasons: []
    });
  });

  test('rejects malformed or empty output', () => {
    expect(() => parseNvidiaSmiCsv('')).toThrow(/no GPU rows/);
    expect(() => parseNvidiaSmiCsv('0, only, three')).toThrow(`expected ${QUERY_FIELDS.length} fields`);
  });

  test('decodes thermal and idle bits', () => {
    expect(decodeThrottleReasons('0x0000000000000061').reasons).toEqual(['idle', 'sw_thermal', 'hw_thermal']);
    expect(decodeThrottleReasons('garbage')).toEqual({ active: null, reasons: [] });
  });
});

describe('gpu-agent configuration', () => {
  test('loads hosts from JSON or a file and validates them', () => {
    const hosts = loadHosts({ GPU_AGENT_HOSTS_JSON: JSON.stringify([
      { id: 'gpu-a', name: 'GPU A', ssh: 'user@gpu-a.example', ollamaUrl: 'http://gpu-a.example:11434/' },
      { id: 'core', local: true }
    ]) });
    expect(hosts).toEqual([
      { id: 'gpu-a', name: 'GPU A', local: false, ssh: 'user@gpu-a.example', sshPort: null, nvidiaSmi: '', ollamaUrl: 'http://gpu-a.example:11434' },
      { id: 'core', name: 'core', local: true, ssh: '', sshPort: null, nvidiaSmi: '', ollamaUrl: '' }
    ]);
    const readFile = jest.fn(() => '[{"id":"core","local":true}]');
    expect(loadHosts({ GPU_AGENT_HOSTS_FILE: '/etc/agentx/gpu-hosts.json' }, readFile)).toHaveLength(1);
    expect(readFile).toHaveBeenCalledWith('/etc/agentx/gpu-hosts.json', 'utf8');
  });

  test('the shipped generic host example is a valid configuration', () => {
    const file = path.resolve(__dirname, '../../../integrations/data-collectors/gpu-hosts.example.json');
    const hosts = loadHosts({ GPU_AGENT_HOSTS_FILE: file });
    expect(hosts.map(host => host.id)).toEqual(['gpu-a', 'gpu-b', 'core']);
    expect(hosts.every(host => host.local || host.ssh.endsWith('.example'))).toBe(true);
  });

  test('refuses ambiguous, unsafe or missing host settings', () => {
    expect(() => loadHosts({})).toThrow(/GPU_AGENT_HOSTS_JSON/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[]' })).toThrow(/non-empty/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"a","ssh":"-oProxyCommand=x"}]' })).toThrow(/ssh must be/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"a","local":true,"ssh":"h"}]' })).toThrow(/exactly one/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"a","local":true},{"id":"a","local":true}]' })).toThrow(/Duplicate/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"a","local":true,"nvidiaSmi":"x; rm -rf /"}]' })).toThrow(/nvidiaSmi/);
    expect(() => loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"a","ssh":"h","ollamaUrl":"http://u:p@h:11434"}]' })).toThrow(/credentials/);
  });

  test('interval and per-host timeout are bounded', () => {
    expect(readSettings({})).toMatchObject({ intervalMs: 30000, hostTimeoutMs: 10000, dataUrl: 'http://127.0.0.1:3083' });
    expect(readSettings({ GPU_AGENT_INTERVAL_MS: '10', GPU_AGENT_HOST_TIMEOUT_MS: '999999' }))
      .toMatchObject({ intervalMs: 5000, hostTimeoutMs: 60000 });
  });

  test('remote sampling uses batch-mode SSH and never a local shell', () => {
    const [remote] = loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"gpu-a","ssh":"user@gpu-a.example","sshPort":2222}]' });
    const command = commandFor(remote, settings);
    expect(command.file).toBe('ssh');
    expect(command.args.slice(0, 8)).toEqual(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-p', '2222', '--', 'user@gpu-a.example']);
    expect(command.args[8]).toBe(`nvidia-smi --query-gpu=${QUERY_FIELDS.join(',')} --format=csv,noheader,nounits`);
    const [local] = loadHosts({ GPU_AGENT_HOSTS_JSON: '[{"id":"core","local":true}]' });
    expect(commandFor(local, settings)).toEqual({ file: 'nvidia-smi', args: [`--query-gpu=${QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'] });
  });
});

describe('gpu-agent sampling', () => {
  const hosts = loadHosts({ GPU_AGENT_HOSTS_JSON: JSON.stringify([
    { id: 'gpu-a', ssh: 'user@gpu-a.example', ollamaUrl: 'http://gpu-a.example:11434' },
    { id: 'gpu-b', ssh: 'user@gpu-b.example' },
    { id: 'core', local: true }
  ]) });

  function fakeExec(behaviour) {
    return jest.fn((file, args, options, callback) => {
      const target = file === 'ssh' ? args[args.indexOf('--') + 1] : 'local';
      const outcome = behaviour[target];
      if (outcome === 'hang') {
        const error = new Error('Command failed');
        error.killed = true;
        error.signal = 'SIGKILL';
        setTimeout(() => callback(error, '', ''), 5);
        return;
      }
      if (outcome instanceof Error) return setImmediate(() => callback(outcome, '', 'Permission denied (publickey).'));
      return setImmediate(() => callback(null, outcome, ''));
    });
  }

  test('a failing or hung host never blocks the others and all results are posted once', async () => {
    const execFileImpl = fakeExec({
      'user@gpu-a.example': `${ROW}\n${ROW_NA}\n`,
      'user@gpu-b.example': new Error('exit 255'),
      local: 'hang'
    });
    const posts = [];
    const fetchImpl = jest.fn(async (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ data: { accepted: 1, failed: 2 } }) };
    });
    const cycle = await runCycle({ settings: { ...settings, collectorId: 'gpu-agent-test' }, hosts, execFileImpl, fetchImpl });

    expect(execFileImpl).toHaveBeenCalledTimes(3);
    expect(execFileImpl.mock.calls[0][2]).toMatchObject({ timeout: 10000, windowsHide: true });
    expect(cycle.failedHosts).toBe(2);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('http://data.test/api/v1/hardware/samples');
    const { results, collectorId, intervalMs, hosts: declared } = posts[0].body;
    expect({ collectorId, intervalMs }).toEqual({ collectorId: 'gpu-agent-test', intervalMs: 30000 });
    expect(declared.map(host => host.id)).toEqual(['gpu-a', 'gpu-b', 'core']);
    expect(results[0]).toMatchObject({ hostId: 'gpu-a', ok: true, ollamaUrl: 'http://gpu-a.example:11434' });
    expect(results[0].gpus).toHaveLength(2);
    expect(results[1]).toMatchObject({ hostId: 'gpu-b', ok: false, error: 'Permission denied (publickey).' });
    expect(results[2]).toMatchObject({ hostId: 'core', ok: false, error: 'timed out after 10000ms' });
  });

  test('unparseable output is reported as a host error', async () => {
    const result = await sampleHost(hosts[0], settings, fakeExec({ 'user@gpu-a.example': 'garbage\n' }));
    expect(result).toMatchObject({ ok: false, hostId: 'gpu-a' });
    expect(result.error).toMatch(/expected 18 fields/);
  });

  test('an unavailable Data service is reported without throwing', async () => {
    const fetchImpl = jest.fn(async () => { throw new Error('connect ECONNREFUSED'); });
    const cycle = await runCycle({ settings, hosts: [hosts[0]], execFileImpl: fakeExec({ 'user@gpu-a.example': ROW }), fetchImpl });
    expect(cycle).toMatchObject({ failedHosts: 0, posted: null, postError: 'connect ECONNREFUSED' });
  });
});

test('gpu collector CLI runs one cycle, posts a failed host and exits non-zero', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Connection', 'close');
      res.end(JSON.stringify({ data: { accepted: 0, failed: 1 } }));
    });
  });
  let child;
  let deadline;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    // The Node binary stands in for nvidia-smi: it rejects the query flags, so
    // the host fails the way a missing driver would, without touching a GPU.
    const env = {
      ...process.env,
      DATA_URL: `http://127.0.0.1:${server.address().port}`,
      GPU_AGENT_ID: 'gpu-agent-fixture',
      GPU_AGENT_HOSTS_JSON: JSON.stringify([{ id: 'core', local: true }]),
      NVIDIA_SMI_BIN: process.execPath,
      GPU_AGENT_ONCE: '1'
    };
    child = spawn(process.execPath, [AGENT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('gpu agent did not exit')), 20000);
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/api/v1/hardware/samples' });
    expect(requests[0].body).toMatchObject({ collectorId: 'gpu-agent-fixture', results: [{ hostId: 'core', ok: false }] });
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null) child.kill();
    await new Promise(resolve => server.close(resolve));
  }
}, 30000);
