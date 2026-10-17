const { enforceHostPin, stripLoadOptions, LOAD_OPTION_KEYS } = require('../../src/services/hostPinGuard');

const HOST = 'http://pinned.test:11434';
const pref = {
  pinnedModels: [
    { model: 'principal:27b', contextSize: 196608, keepAlive: -1 },
    { model: 'embed:f16', contextSize: 0, keepAlive: -1 }
  ]
};

describe('hostPinGuard', () => {
  test('a request without load options inherits the pin', () => {
    const result = enforceHostPin(pref, { hostUrl: HOST, model: 'principal:27b', options: { temperature: 0.2, keep_alive: '10m' } });
    expect(result.options).toEqual({ temperature: 0.2, num_ctx: 196608 });
    expect(result.keepAlive).toBe(-1);
  });

  test('a request repeating the pin passes', () => {
    const result = enforceHostPin(pref, { hostUrl: HOST, model: 'principal:27b', options: { num_ctx: '196608' } });
    expect(result.options.num_ctx).toBe(196608);
  });

  test('another model on the pinned host is refused', () => {
    expect(() => enforceHostPin(pref, { hostUrl: HOST, model: 'other:27b' }))
      .toThrow(expect.objectContaining({ code: 'HOST_PIN_MISMATCH', statusCode: 409, pin: expect.objectContaining({ field: 'model' }) }));
  });

  test.each(LOAD_OPTION_KEYS.map(key => [key]))('a different %s is refused', key => {
    const options = { [key]: key === 'use_mmap' ? false : 4 };
    expect(() => enforceHostPin(pref, { hostUrl: HOST, model: 'principal:27b', options }))
      .toThrow(expect.objectContaining({ code: 'HOST_PIN_MISMATCH', pin: expect.objectContaining({ field: key }) }));
  });

  test('the chat UI values are ignored instead of refused, but not another model', () => {
    const result = enforceHostPin(pref, { hostUrl: HOST, model: 'principal:27b', onDiffer: 'ignore',
      options: { num_ctx: 8192, num_gpu: 1, temperature: 0 } });
    expect(result.options).toEqual({ num_ctx: 196608, temperature: 0 });
    expect(result.ignored).toEqual(['num_ctx', 'num_gpu']);
    expect(() => enforceHostPin(pref, { hostUrl: HOST, model: 'other:27b', onDiffer: 'ignore' }))
      .toThrow(expect.objectContaining({ code: 'HOST_PIN_MISMATCH' }));
  });

  test('an embedding pin without context refuses a caller context', () => {
    expect(enforceHostPin(pref, { hostUrl: HOST, model: 'embed:f16' }).options).toEqual({});
    expect(() => enforceHostPin(pref, { hostUrl: HOST, model: 'embed:f16', options: { num_ctx: 8192 } }))
      .toThrow(expect.objectContaining({ code: 'HOST_PIN_MISMATCH' }));
  });

  test('a claim holder, a matching session hold or an unpinned host keep their own options', () => {
    const options = { num_ctx: 8192 };
    expect(enforceHostPin(pref, { hostUrl: HOST, model: 'other:27b', options, claimed: true })).toEqual({ unpinned: true });
    expect(enforceHostPin({ pinnedModels: [] }, { hostUrl: HOST, model: 'other:27b', options })).toEqual({ unpinned: true });
    const now = Date.now();
    const held = { ...pref, sessionHold: { holdId: 'h1', model: 'other:27b', expiresAt: new Date(now + 60_000) } };
    expect(enforceHostPin(held, { hostUrl: HOST, model: 'other:27b', options, now })).toEqual({ unpinned: true });
    const expired = { ...pref, sessionHold: { holdId: 'h1', model: 'other:27b', expiresAt: new Date(now - 1) } };
    expect(() => enforceHostPin(expired, { hostUrl: HOST, model: 'other:27b', options, now })).toThrow(/host pin owns/);
  });

  test('CPU pins carry their thread count', () => {
    const cpu = { pinnedModels: [{ model: 'cpu:26b', contextSize: 32768, numThread: 6, keepAlive: -1 }] };
    expect(enforceHostPin(cpu, { hostUrl: HOST, model: 'cpu:26b' }).options).toEqual({ num_ctx: 32768, num_thread: 6 });
  });

  test('stripLoadOptions keeps sampling options only', () => {
    expect(stripLoadOptions({ num_ctx: 1, num_batch: 2, temperature: 0.1 })).toEqual({ temperature: 0.1 });
    expect(stripLoadOptions(undefined)).toEqual({});
  });
});

describe('model creation on a pinned host (#829)', () => {
  // A variant built from the pinned blob with other load options evicts the
  // pin like any other model. Core sends no /api/create, and Benchmark's
  // client refuses it (CUSTOM_MODEL_DEPLOY_DISABLED); a future create path
  // must go through the fenced runtime-mutation lifecycle and this guard.
  test('Core source sends no Ollama model creation request', () => {
    const fs = require('fs');
    const path = require('path');
    const root = path.resolve(__dirname, '../..');
    const offenders = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'test', 'tests', 'public'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(c|m)?js$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('/api/create')) offenders.push(path.relative(root, full));
      }
    };
    ['src', 'routes', 'integrations', 'surfaces'].forEach(dir => walk(path.join(root, dir)));
    expect(offenders).toEqual([]);
  });
});

