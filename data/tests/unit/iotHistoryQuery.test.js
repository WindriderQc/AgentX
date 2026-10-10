/**
 * History query validation and the automatic choice of a bucket size.
 */
const { chooseResolution, parseQuery, RESOLUTIONS, AUTO_TARGET_POINTS, MAX_POINTS } = require('../../services/iot/history');

const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date(NOW);
const KNOWN = ['temperature', 'pressure'];

describe('auto resolution', () => {
  test.each([
    ['1 hour', HOUR, 'minute'],
    ['1 day', DAY, 'minute'],
    ['25 hours', 25 * HOUR, 'minute'],
    ['2 days', 2 * DAY, '5min'],
    ['1 week', 7 * DAY, '30min'],
    ['30 days', 30 * DAY, '30min'],
    ['60 days', 60 * DAY, 'hour'],
    ['90 days', 90 * DAY - HOUR, '2hour'],
    ['1 year', 365 * DAY, 'day'],
    ['4 years', 4 * 365 * DAY, 'day']
  ])('%s -> %s', (_label, span, expected) => {
    const bucket = chooseResolution(NOW - span, NOW, NOW);
    expect(bucket).toBe(expected);
    if (span <= 4 * 365 * DAY) expect(Math.ceil(span / RESOLUTIONS[bucket].ms)).toBeLessThanOrEqual(AUTO_TARGET_POINTS + 1);
  });

  test('a short range older than the minute tier is read from the hour tier', () => {
    expect(chooseResolution(NOW - 200 * DAY, NOW - 199 * DAY, NOW)).toBe('hour');
    expect(chooseResolution(NOW - 89 * DAY, NOW - 88 * DAY, NOW)).toBe('minute');
  });
});

describe('parseQuery', () => {
  test('defaults: every measure of the device, the last 24 hours, auto', () => {
    const params = parseQuery({}, KNOWN, now);
    expect(params).toEqual({
      measures: KNOWN, fromMs: NOW - DAY, toMs: NOW, resolution: 'auto', bucket: 'minute', size: 60_000, source: 'minute'
    });
  });

  test('several measures, ISO and epoch dates, explicit resolution, range aligned on the bucket', () => {
    const params = parseQuery({
      measure: 'pressure, temperature,pressure', from: '2026-06-01T00:10:00Z', to: String(Date.UTC(2026, 5, 3)), resolution: 'day'
    }, KNOWN, now);
    expect(params).toMatchObject({
      measures: ['pressure', 'temperature'], fromMs: Date.UTC(2026, 5, 1), toMs: Date.UTC(2026, 5, 3),
      resolution: 'day', bucket: 'day', size: DAY, source: 'hour'
    });
    expect(parseQuery({ resolution: '5min' }, KNOWN, now)).toMatchObject({ bucket: '5min', source: 'minute' });
  });

  test.each([
    [{ measure: 'nope' }, /Unknown measure/],
    [{ measure: ['a', 'b'] }, /given once/],
    [{ from: 'yesterday' }, /from must be/],
    [{ to: 'x' }, /to must be/],
    [{ from: '2026-06-02T00:00:00Z', to: '2026-06-01T00:00:00Z' }, /before/],
    [{ resolution: 'second' }, /resolution must be one of/],
    [{ resolution: 'toString' }, /resolution must be one of/],
    [{ from: '2026-01-01T00:00:00Z', resolution: 'minute' }, new RegExp(`more than ${MAX_POINTS}`)]
  ])('refuses %j', (query, message) => {
    expect(() => parseQuery(query, KNOWN, now)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(message) }));
  });

  test('more than twelve measures need to be named', () => {
    const many = Array.from({ length: 13 }, (_, i) => `m${i}`);
    expect(() => parseQuery({}, many, now)).toThrow(/At most 12/);
    expect(parseQuery({ measure: 'm1,m2' }, many, now).measures).toEqual(['m1', 'm2']);
  });
});
