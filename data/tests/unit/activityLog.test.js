/**
 * Activity log rules that need no database: event bounds, posted-event
 * validation, read filters and paging.
 */
jest.mock('../../utils/logger', () => ({ log: jest.fn() }));

const activityLog = require('../../services/activityLog');
const appEmitter = require('../../utils/eventEmitter');
const { log } = require('../../utils/logger');

describe('buildEvent', () => {
  test('keeps type, severity, a bounded sentence and a bounded meta', () => {
    const at = new Date('2026-10-08T12:00:00.000Z');
    const event = activityLog.buildEvent({
      type: 'storage.scan_finished', severity: 'warning', at,
      message: `line one\nline two ${'x'.repeat(500)}`,
      meta: {
        scanId: 'abc', count: 3, ok: true, none: null, when: at, nan: NaN, fn: () => 1,
        $where: 'dropped', 'a.b': 'dropped', long: 'y'.repeat(500),
        list: Array.from({ length: 100 }, (_, i) => i),
        nested: { a: { b: { c: 'too deep' } } }
      }
    });
    expect(event).toMatchObject({ type: 'storage.scan_finished', severity: 'warning', timestamp: at });
    expect(event.message.length).toBe(activityLog.MAX_MESSAGE_CHARS);
    expect(event.message).not.toMatch(/\n/);
    expect(event.meta).toMatchObject({ scanId: 'abc', count: 3, ok: true, none: null, when: at.toISOString() });
    expect(event.meta).not.toHaveProperty('nan');
    expect(event.meta).not.toHaveProperty('fn');
    expect(event.meta).not.toHaveProperty('$where');
    expect(event.meta).not.toHaveProperty('a.b');
    expect(event.meta.long.length).toBe(200);
    expect(event.meta.list).toHaveLength(25);
    expect(event.meta.nested).toEqual({ a: {} });
  });

  test('a meta over 4 KiB is replaced, never stored', () => {
    const meta = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, 'z'.repeat(200)]));
    expect(activityLog.buildEvent({ type: 'storage.scan_queued', message: 'm', meta }).meta).toEqual({ truncated: true });
  });

  test.each([
    [{ type: 'nodots', message: 'm' }],
    [{ type: 'Storage.Scan', message: 'm' }],
    [{ type: 'storage.scan_queued', message: '' }],
    [{ type: 'storage.scan_queued', message: 'm', severity: 'fatal' }]
  ])('refuses %j', (event) => {
    expect(() => activityLog.buildEvent(event)).toThrow();
  });

  test('every documented type is a valid type', () => {
    for (const type of Object.keys(activityLog.EVENT_TYPES)) {
      expect(activityLog.buildEvent({ type, message: 'm' }).type).toBe(type);
    }
  });
});

describe('record', () => {
  test('stores, pushes to subscribers and returns the public shape', async () => {
    const insertOne = jest.fn().mockResolvedValue({ insertedId: 'id-1' });
    const seen = [];
    const listener = (event) => seen.push(event);
    appEmitter.on('newEvent', listener);
    const stored = await activityLog.record({ collection: () => ({ insertOne }) }, { type: 'collector.back', message: 'Back.' });
    appEmitter.removeListener('newEvent', listener);
    expect(stored).toMatchObject({ id: 'id-1', type: 'collector.back', severity: 'info', message: 'Back.', meta: {} });
    expect(new Date(stored.at).toISOString()).toBe(stored.at);
    expect(insertOne.mock.calls[0][0]).toMatchObject({ type: 'collector.back', severity: 'info', timestamp: expect.any(Date) });
    expect(seen).toEqual([stored]);
  });

  test('never throws: a failed write or an invalid event is logged and gives null', async () => {
    const failing = { collection: () => ({ insertOne: jest.fn().mockRejectedValue(new Error('mongo down')) }) };
    await expect(activityLog.record(failing, { type: 'collector.back', message: 'Back.' })).resolves.toBeNull();
    await expect(activityLog.record(failing, { type: 'bad', message: 'x' })).resolves.toBeNull();
    await expect(activityLog.record(null, { type: 'collector.back', message: 'Back.' })).resolves.toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/Could not record collector\.back: mongo down/), 'warn');
  });
});

describe('externalEvent', () => {
  test('defaults to an external note and accepts the former severity-in-type form', () => {
    expect(activityLog.externalEvent({ message: 'Hello' }))
      .toEqual({ type: 'external.note', severity: 'info', message: 'Hello', meta: {} });
    expect(activityLog.externalEvent({ message: 'Hello', type: 'warn' }))
      .toMatchObject({ type: 'external.note', severity: 'warning' });
    expect(activityLog.externalEvent({ message: 'Hello', type: 'external.core_watch', severity: 'error', meta: { a: 1 } }))
      .toEqual({ type: 'external.core_watch', severity: 'error', message: 'Hello', meta: { a: 1 } });
  });

  test.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{}, /message is required/],
    [{ message: '   ' }, /message is required/],
    [{ message: 5 }, /message is required/],
    [{ message: 'x'.repeat(301) }, /at most 300/],
    [{ message: 'm', type: 'storage.scan_finished' }, /external\./],
    [{ message: 'm', type: 'external' }, /external\./],
    [{ message: 'm', type: { $ne: 1 } }, /external\./],
    [{ message: 'm', severity: 'fatal' }, /severity/],
    [{ message: 'm', meta: 'text' }, /plain object/],
    [{ message: 'm', meta: [1] }, /plain object/],
    [{ message: 'm', meta: { big: Array.from({ length: 25 }, () => 'z'.repeat(200)) } }, /4096 bytes/],
    [{ message: 'm', stack: 'trace' }, /unknown field: stack/]
  ])('refuses %j', (body, pattern) => {
    let error;
    try { activityLog.externalEvent(body); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ statusCode: 400 });
    expect(error.message).toMatch(pattern);
  });
});

describe('parseQuery', () => {
  test('paging falls back instead of producing NaN, and is bounded', () => {
    expect(activityLog.parseQuery({})).toMatchObject({ filter: {}, page: 1, limit: 50, skip: 0 });
    expect(activityLog.parseQuery({ page: 'abc', limit: 'xyz' })).toMatchObject({ page: 1, limit: 50, skip: 0 });
    expect(activityLog.parseQuery({ page: '-3', limit: '0' })).toMatchObject({ page: 1, limit: 50 });
    expect(activityLog.parseQuery({ page: '99999', limit: '99999' })).toMatchObject({ page: 500, limit: 200, skip: 499 * 200 });
    expect(activityLog.parseQuery({ page: '3', limit: '20' })).toMatchObject({ page: 3, limit: 20, skip: 40 });
  });

  test('type is an anchored prefix, with severity and a time window', () => {
    const parsed = activityLog.parseQuery({
      type: 'storage.scan_', severity: 'error', since: '2026-10-01T00:00:00Z', until: '1791590400000'
    });
    expect(parsed.filter).toEqual({
      type: { $regex: '^storage\\.scan_' },
      severity: 'error',
      timestamp: { $gte: new Date('2026-10-01T00:00:00Z'), $lte: new Date(1791590400000) }
    });
    expect(parsed.applied).toEqual({
      type: 'storage.scan_', severity: 'error', since: '2026-10-01T00:00:00.000Z', until: new Date(1791590400000).toISOString()
    });
  });

  test.each([
    [{ type: 'storage.*' }], [{ type: '^a' }], [{ type: ['a'] }], [{ type: 'x'.repeat(65) }],
    [{ severity: 'warn' }], [{ since: 'yesterday' }], [{ until: ['2026'] }],
    [{ since: '2026-10-02', until: '2026-10-01' }]
  ])('refuses %j with 400', (query) => {
    expect(() => activityLog.parseQuery(query)).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});

describe('publicEvent', () => {
  test('a document from before the typed log keeps its severity', () => {
    const at = new Date('2026-09-01T00:00:00Z');
    expect(activityLog.publicEvent({ _id: 'x', message: 'old', type: 'warn', timestamp: at }))
      .toEqual({ id: 'x', type: 'external.note', severity: 'warning', message: 'old', meta: {}, at: at.toISOString() });
  });

  test('matches filters a stream on type prefix and severity', () => {
    const event = { type: 'gpu.host_stale', severity: 'warning' };
    expect(activityLog.matches(event, {})).toBe(true);
    expect(activityLog.matches(event, { type: 'gpu' })).toBe(true);
    expect(activityLog.matches(event, { type: 'storage' })).toBe(false);
    expect(activityLog.matches(event, { type: 'gpu', severity: 'error' })).toBe(false);
  });
});
