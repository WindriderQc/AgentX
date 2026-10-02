'use strict';

const http = require('http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const {
  VERSION,
  MAX_METADATA_PROBE_PATHS,
  MAX_CONTENT_PROBE_BYTES,
  defaultSources,
  isExcludedTopLevel,
  fingerprint,
  metadataProbePathSet,
  detectContentType,
  probeContentType,
  selectHashGroups,
  summarizeHashGroups,
  requestJsonWithHttp,
  reconcileCompletion,
  finishScan,
  startScanHeartbeat,
  serviceScan
} = require('../../../integrations/data-collectors/storage-agent');

const GiB = 1024 ** 3;

test('storage collector CLI starts without a token, polls once and exits naturally', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'close');
    res.end(JSON.stringify({ data: { scan: null } }));
  });
  let child;
  let deadline;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const env = { ...process.env, DATA_URL: `http://127.0.0.1:${server.address().port}`,
      SCANNER_ID: 'startup-fixture', STORAGE_AGENT_ONCE: '1' };
    delete env.NETWORK_AGENT_TOKEN;
    child = spawn(process.execPath, [path.resolve(__dirname,
      '../../../integrations/data-collectors/storage-agent.js')], { env, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exit = await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Collector did not finish its single poll')), 10000);
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    expect({ ...exit, output }).toEqual({ code: 0, signal: null,
      output: expect.stringContaining('starting') });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toContain('/api/v1/storage/agent/requests?scannerId=startup-fixture');
    expect(requests[0].headers.authorization).toBeUndefined();
  } finally {
    clearTimeout(deadline);
    if (child && child.exitCode === null) child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}, 15000);

function record(name, size, mtime = 1) {
  return { path: `/mnt/media/${name}`, size, mtime };
}

describe('native shared-storage agent evidence policy', () => {
  test('Media excludes only its exact top-level Datalake child', () => {
    expect(defaultSources()).toEqual({});
    const sources = { media: { hostPath: '/example/media', canonicalRoot: '/mnt/media', excludeTopLevel: ['Datalake'] },
      datalake: { hostPath: '/example/media/Datalake', canonicalRoot: '/mnt/datalake', excludeTopLevel: [] } };
    expect(sources.media.excludeTopLevel).toContain('Datalake');
    expect(isExcludedTopLevel('Datalake/models/blob', sources.media.excludeTopLevel)).toBe(true);
    expect(isExcludedTopLevel('datalake\\models\\blob', sources.media.excludeTopLevel)).toBe(true);
    expect(isExcludedTopLevel('Datalake-Archive/file.zip', sources.media.excludeTopLevel)).toBe(false);
    expect(sources.datalake.canonicalRoot).toBe('/mnt/datalake');
  });

  test('a group larger than the run budget progresses across scans', () => {
    const first = record('first.iso', 6 * GiB);
    const second = record('second.iso', 6 * GiB);
    const scan = { hash_mode: 'candidates', hash_max_files: 10, hash_max_bytes: 10 * GiB };

    const firstPlan = selectHashGroups([first, second], {}, scan);
    expect(firstPlan.selected).toHaveLength(1);
    expect(firstPlan.selected[0].files).toEqual([first]);

    const cache = {
      [first.path]: { fingerprint: fingerprint(first), sha256: 'first-hash' }
    };
    expect(summarizeHashGroups(firstPlan.groups, cache, firstPlan.maxBytes)).toMatchObject({
      completeGroups: 0,
      partialGroups: 1,
      deferredGroups: 1,
      deferredFiles: 1,
      oversizedGroups: 0
    });

    const secondPlan = selectHashGroups([first, second], cache, scan);
    expect(secondPlan.selected[0].files).toEqual([second]);
    cache[second.path] = { fingerprint: fingerprint(second), sha256: 'second-hash' };
    expect(summarizeHashGroups(secondPlan.groups, cache, secondPlan.maxBytes)).toMatchObject({
      completeGroups: 1,
      partialGroups: 0,
      deferredGroups: 0
    });
  });

  test('individual files beyond the byte budget remain explicit oversized candidates', () => {
    const files = [record('first.vdi', 12 * GiB), record('second.vdi', 12 * GiB)];
    const plan = selectHashGroups(files, {}, {
      hash_mode: 'candidates', hash_max_files: 10, hash_max_bytes: 10 * GiB
    });

    expect(plan.selected).toHaveLength(0);
    expect(summarizeHashGroups(plan.groups, {}, plan.maxBytes)).toMatchObject({
      deferredGroups: 1,
      deferredFiles: 2,
      oversizedGroups: 1,
      oversizedFiles: 2,
      oversizedBytes: 24 * GiB
    });
  });

  test('a fingerprint without a SHA256 is not treated as cached evidence', () => {
    const files = [record('first.bin', 100), record('second.bin', 100)];
    const cache = {
      [files[0].path]: { fingerprint: fingerprint(files[0]), sha256: '' }
    };
    const plan = selectHashGroups(files, cache, {
      hash_mode: 'candidates', hash_max_files: 10, hash_max_bytes: 1000
    });
    expect(plan.selected[0].files).toEqual(files);
  });

  test('metadata probe paths are exact-root scoped and bounded', () => {
    const candidates = Array.from(
      { length: MAX_METADATA_PROBE_PATHS + 5 },
      (_, index) => `/mnt/media/item-${index}`
    );
    candidates.unshift('/mnt/datalake/not-media');
    const paths = metadataProbePathSet({
      root: '/mnt/media',
      metadata_probe_paths: candidates
    });
    expect(paths.size).toBe(MAX_METADATA_PROBE_PATHS - 1);
    expect(paths.has('/mnt/datalake/not-media')).toBe(false);
    expect(metadataProbePathSet({ root: '/mnt/media' }).size).toBe(0);
  });

  test('content signatures classify only strong bounded evidence', async () => {
    expect(detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from('ID3\u0004\u0000\u0000', 'binary'))).toBe('audio/mpeg');
    expect(detectContentType(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe('audio/mpeg');
    expect(detectContentType(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01]))).toBe('application/vnd.rar');
    expect(detectContentType(Buffer.from('#EXTM3U\r\ntrack.mp3\r\n'))).toBe('audio/x-mpegurl');
    expect(detectContentType(Buffer.from(
      'From: <Saved by Blink>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related\r\n'
    ))).toBe('message/rfc822');
    expect(detectContentType(Buffer.from([0x01, 0x02, 0x03, 0x04]))).toBeNull();
    const portableExecutable = Buffer.alloc(128);
    portableExecutable.write('MZ');
    portableExecutable.writeUInt32LE(64, 0x3c);
    portableExecutable.write('PE\0\0', 64, 'binary');
    expect(detectContentType(portableExecutable)).toBe('application/vnd.microsoft.portable-executable');
    expect(detectContentType(Buffer.from('MZ but not a PE'))).toBeNull();
    expect(detectContentType(Buffer.alloc(0))).toBeNull();

    const transportStream = Buffer.alloc((188 * 4) + 1);
    const m2tsStream = Buffer.alloc(4 + (192 * 4) + 1);
    for (let packet = 0; packet < 5; packet += 1) {
      transportStream[packet * 188] = 0x47;
      m2tsStream[4 + (packet * 192)] = 0x47;
    }
    expect(detectContentType(transportStream)).toBe('video/mp2t');
    expect(detectContentType(m2tsStream)).toBe('video/mp2t');

    const oneSyncByte = Buffer.alloc((188 * 4) + 1);
    oneSyncByte[0] = 0x47;
    expect(detectContentType(oneSyncByte)).toBeNull();

    const fourSyncBytes = Buffer.alloc((188 * 4) + 1);
    for (let packet = 0; packet < 4; packet += 1) fourSyncBytes[packet * 188] = 0x47;
    expect(detectContentType(fourSyncBytes)).toBeNull();

    const wrongSpacing = Buffer.alloc((190 * 4) + 1);
    for (let packet = 0; packet < 5; packet += 1) wrongSpacing[packet * 190] = 0x47;
    expect(detectContentType(wrongSpacing)).toBeNull();

    const truncatedBeforeFifthSync = transportStream.subarray(0, 188 * 4);
    expect(detectContentType(truncatedBeforeFifthSync)).toBeNull();

    const readPrefix = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.7'));
    await expect(probeContentType('/host/file', {
      maxBytes: Number.MAX_SAFE_INTEGER,
      readPrefix
    })).resolves.toBe('application/pdf');
    expect(readPrefix).toHaveBeenCalledWith('/host/file', MAX_CONTENT_PROBE_BYTES);
  });
});

describe('native shared-storage agent completion handling', () => {
  test('busy heartbeat is versioned, non-overlapping, and cancellable', async () => {
    expect(VERSION).toBe('storage-1.4.1');
    let releaseFirst;
    let scheduledTick;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const send = jest.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ ok: true });
    const cancel = jest.fn();
    const timer = { unref: jest.fn() };
    const heartbeat = startScanHeartbeat('scan-live', {
      send,
      intervalMs: 10,
      schedule: (callback, interval) => {
        scheduledTick = callback;
        expect(interval).toBe(10);
        return timer;
      },
      cancel
    });

    await new Promise(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    scheduledTick();
    await new Promise(resolve => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);

    releaseFirst({ ok: true });
    await first;
    await new Promise(resolve => setImmediate(resolve));
    await expect(heartbeat.tick()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(2);

    heartbeat.stop();
    heartbeat.stop();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(timer);
    await expect(heartbeat.tick()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('built-in HTTP completion client accepts delayed response headers', async () => {
    let received;
    const server = http.createServer((req, res) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        received = { method: req.method, path: req.url, body: JSON.parse(raw) };
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'success', data: { accepted: true } }));
        }, 40);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      const result = await requestJsonWithHttp(
        `http://127.0.0.1:${address.port}`,
        '/api/v1/storage/scan/test',
        { method: 'PATCH', body: { status: 'completed' }, timeoutMs: 1000 }
      );

      expect(result).toEqual({ accepted: true });
      expect(received).toEqual({
        method: 'PATCH',
        path: '/api/v1/storage/scan/test',
        body: { status: 'completed' }
      });
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  test('reconciliation waits through running and accepts the expected terminal state', async () => {
    let clock = 0;
    const getStatus = jest.fn()
      .mockResolvedValueOnce({ status: 'running' })
      .mockResolvedValueOnce({ status: 'complete' });

    await expect(reconcileCompletion('scan-1', 'completed', {
      getStatus,
      now: () => clock,
      sleep: async ms => { clock += ms; },
      maxWaitMs: 100,
      pollMs: 10
    })).resolves.toMatchObject({ ok: true, status: 'complete', attempts: 2 });
  });

  test('reconciliation rejects a different authoritative terminal state', async () => {
    await expect(reconcileCompletion('scan-2', 'completed', {
      getStatus: jest.fn().mockResolvedValue({ status: 'failed' }),
      maxWaitMs: 100,
      pollMs: 10
    })).resolves.toMatchObject({
      ok: false,
      status: 'failed',
      reason: 'unexpected_terminal_status'
    });
  });

  test('reconciliation reports a bounded timeout while the scan remains running', async () => {
    let clock = 0;
    await expect(reconcileCompletion('scan-3', 'completed', {
      getStatus: jest.fn().mockResolvedValue({ status: 'running' }),
      now: () => clock,
      sleep: async ms => { clock += ms; },
      maxWaitMs: 10,
      pollMs: 10
    })).resolves.toMatchObject({
      ok: false,
      status: 'running',
      reason: 'reconciliation_timeout'
    });
  });

  test('an interrupted acknowledgement succeeds when authoritative state reconciles', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(finishScan('scan-4', 'completed', { files_seen: 1 }, {
        completeRequest: jest.fn().mockRejectedValue(new Error('socket closed')),
        reconcile: jest.fn().mockResolvedValue({ ok: true, status: 'complete', attempts: 2 })
      })).resolves.toMatchObject({ reconciled: true, ok: true, status: 'complete' });
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  test('service scan does not send a false failed state after completion succeeds', async () => {
    const finish = jest.fn().mockResolvedValue({ reconciled: true });
    const stopHeartbeat = jest.fn();
    const startHeartbeat = jest.fn().mockReturnValue({ stop: stopHeartbeat });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await serviceScan({
        scan_id: 'scan-5', source: 'media', root: '/mnt/media'
      }, {
        sources: { media: { root: '/fixture/media', canonicalRoot: '/mnt/media' } },
        inventory: jest.fn().mockResolvedValue({
          files: [],
          stats: { files_seen: 1, metadata_errors: 0, hashed: 0 }
        }),
        hashCandidates: jest.fn().mockResolvedValue(),
        finishScan: finish,
        startHeartbeat
      });

      expect(result).toMatchObject({ ok: true, status: 'completed' });
      expect(finish).toHaveBeenCalledTimes(1);
      expect(finish).toHaveBeenCalledWith('scan-5', 'completed', expect.any(Object));
      expect(startHeartbeat).toHaveBeenCalledWith('scan-5');
      expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  test('service scan retains the best-effort failed update after a true completion failure', async () => {
    const finish = jest.fn()
      .mockRejectedValueOnce(new Error('completion unresolved'))
      .mockResolvedValueOnce({ status: 'failed' });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const stopHeartbeat = jest.fn();
    try {
      const result = await serviceScan({
        scan_id: 'scan-6', source: 'media', root: '/mnt/media'
      }, {
        sources: { media: { root: '/fixture/media', canonicalRoot: '/mnt/media' } },
        inventory: jest.fn().mockResolvedValue({
          files: [],
          stats: { files_seen: 1, metadata_errors: 0, hashed: 0 }
        }),
        hashCandidates: jest.fn().mockResolvedValue(),
        finishScan: finish,
        startHeartbeat: jest.fn().mockReturnValue({ stop: stopHeartbeat })
      });

      expect(result).toMatchObject({ ok: false, status: 'failed' });
      expect(finish).toHaveBeenNthCalledWith(1, 'scan-6', 'completed', expect.any(Object));
      expect(finish).toHaveBeenNthCalledWith(2, 'scan-6', 'failed', { errors: 1 });
      expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
