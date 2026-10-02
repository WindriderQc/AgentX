const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULTS,
  parseArgs,
  verifyNativeDataCollectors
} = require('../verify-native-data-collectors');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

function agent(scannerId, lastSeen) {
  return { scannerId, active: true, lastSeen: new Date(lastSeen).toISOString() };
}

test('CLI parsing keeps bounded defaults and rejects invalid modes', () => {
  assert.deepEqual(parseArgs([]), DEFAULTS);
  assert.deepEqual(parseArgs(['--mode', 'fresh', '--timeout-ms', '5000']), {
    ...DEFAULTS,
    mode: 'fresh',
    timeoutMs: 5000
  });
  assert.throws(() => parseArgs(['--mode', 'eventual']), /current or fresh/);
  assert.throws(() => parseArgs(['--poll-ms', '0']), /positive integer/);
  assert.deepEqual(
    parseArgs(['--expect-network', 'alternate-agent', '--expect-storage', 'none']).expectStorage,
    []
  );
  assert.deepEqual(parseArgs(['--expect-network', 'custom-host']).expectNetwork, ['custom-host']);
  assert.throws(() => parseArgs(['--expect-network', 'bad/id']), /scanner/);
  assert.throws(
    () => parseArgs(['--expect-network', 'none', '--expect-storage', 'none']),
    /At least one expected native agent/
  );
});

test('current mode proves the two Linux collectors without requiring the retired Windows vantage', async () => {
  const nowMs = Date.parse('2026-08-28T21:50:00.000Z');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (url.endsWith('/network/agents')) {
      return response(200, { data: { scanners: [agent('network-agent', nowMs - 2000)] } });
    }
    if (url.endsWith('/storage/agents')) {
      return response(200, { data: { scanners: [agent('storage-agent', nowMs - 3000)] } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };

  const result = await verifyNativeDataCollectors({ ...DEFAULTS }, { fetchImpl, now: () => nowMs });
  assert.deepEqual(result, { attempts: 1, mode: 'current', verifiedAgents: 2 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('unavailable projection fails without claiming healthy collectors', async () => {
  await assert.rejects(verifyNativeDataCollectors({ ...DEFAULTS }, {
    fetchImpl: async () => response(503, { status: 'error' })
  }), /projection/);
});

test('fresh mode waits for every heartbeat to advance beyond the check start', async () => {
  let nowMs = Date.parse('2026-08-28T21:50:00.000Z');
  const startedAt = nowMs;
  let projectionRound = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/network/agents')) {
      projectionRound += 1;
      const seen = projectionRound === 1 ? startedAt - 1 : startedAt + 1000;
      return response(200, { data: { scanners: [agent('alternate-agent', seen), agent('network-agent', seen)] } });
    }
    if (url.endsWith('/storage/agents')) {
      const seen = projectionRound === 1 ? startedAt - 1 : startedAt + 1000;
      return response(200, { data: { scanners: [agent('storage-agent', seen)] } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const sleep = async (ms) => { nowMs += ms; };

  const result = await verifyNativeDataCollectors(
    { ...DEFAULTS, mode: 'fresh', pollMs: 2500, timeoutMs: 5000 },
    { fetchImpl, now: () => nowMs, sleep }
  );
  assert.deepEqual(result, { attempts: 2, mode: 'fresh', verifiedAgents: 2 });
});

test('future-dated rows cannot satisfy the freshness contract', async () => {
  let nowMs = Date.parse('2026-08-28T21:50:00.000Z');
  const future = nowMs + 60000;
  const fetchImpl = async (url) => {
    if (url.endsWith('/network/agents')) {
      return response(200, { data: { scanners: [agent('alternate-agent', future), agent('network-agent', future)] } });
    }
    return response(200, { data: { scanners: [agent('storage-agent', future)] } });
  };
  const sleep = async (ms) => { nowMs += ms; };
  await assert.rejects(
    verifyNativeDataCollectors(
      { ...DEFAULTS, timeoutMs: 10, pollMs: 10 },
      { fetchImpl, now: () => nowMs, sleep }
    ),
    /expected agents: network-agent,storage-agent/
  );
});

test('failure identifies the narrowed expected agent set', async () => {
  let nowMs = Date.parse('2026-08-28T21:50:00.000Z');
  const fetchImpl = async (url) => {
    return response(200, { data: { scanners: [] } });
  };
  const sleep = async (ms) => { nowMs += ms; };
  await assert.rejects(
    verifyNativeDataCollectors(
      {
        ...DEFAULTS,
        mode: 'fresh',
        expectNetwork: ['alternate-agent'],
        expectStorage: [],
        timeoutMs: 10,
        pollMs: 10
      },
      { fetchImpl, now: () => nowMs, sleep }
    ),
    /expected agents: alternate-agent$/
  );
});

test('an expected GPU collector is proven from the hardware collector projection', async () => {
  const nowMs = Date.parse('2026-09-25T12:00:00.000Z');
  const fetchImpl = async (url) => {
    if (url.endsWith('/network/agents')) return response(200, { data: { scanners: [] } });
    if (url.endsWith('/storage/agents')) return response(200, { data: { scanners: [] } });
    if (url.endsWith('/hardware/collectors')) {
      return response(200, { data: { collectors: [{ collectorId: 'gpu-agent', active: true, lastSeen: new Date(nowMs - 1000).toISOString() }] } });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const options = parseArgs(['--expect-network', 'none', '--expect-storage', 'none', '--expect-gpu', 'gpu-agent']);
  const result = await verifyNativeDataCollectors(options, { fetchImpl, now: () => nowMs });
  assert.deepEqual(result, { attempts: 1, mode: 'current', verifiedAgents: 1 });
  let clock = nowMs;
  await assert.rejects(verifyNativeDataCollectors({ ...options, timeoutMs: 1 }, {
    fetchImpl: async (url) => url.endsWith('/hardware/collectors')
      ? response(200, { data: { collectors: [] } })
      : response(200, { data: { scanners: [] } }),
    now: () => { clock += 10; return clock; },
    sleep: async () => {}
  }), /gpu-agent/);
});
