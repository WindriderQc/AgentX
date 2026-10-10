/**
 * Bucket arithmetic of the IoT store: what a minute holds, when it closes,
 * how late a reading may be, and how buckets combine into larger ones.
 */
const {
  MINUTE_MS, HOUR_MS, LATE_ACCEPT_MS, CLOSE_GRACE_MS,
  median, summarize, combine, rebucket, createMinuteAggregator
} = require('../../services/iot/buckets');

const T0 = Date.UTC(2026, 0, 5, 10, 0, 0);
const at = (seconds) => T0 + seconds * 1000;

describe('median', () => {
  test('odd, even, unsorted and empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
    expect(median([])).toBeNull();
  });

  test('ignores a stray glitch that the mean and the max keep', () => {
    const bucket = summarize([21.1, 21.2, 21.2, 21.3, 85].map((value, i) => ({ at: at(i * 5), value })));
    expect(bucket.median).toBe(21.2);
    expect(bucket.max).toBe(85);
    expect(bucket.mean).toBeCloseTo(33.96, 6);
  });
});

describe('summarize', () => {
  test('count, min, max, mean, median, first and last from readings in any order', () => {
    const bucket = summarize([{ at: at(30), value: -2 }, { at: at(5), value: 4 }, { at: at(55), value: 1 }]);
    expect(bucket).toEqual({
      count: 3, min: -2, max: 4, mean: 1, median: 1, first: new Date(at(5)), last: new Date(at(55))
    });
    expect(summarize([])).toBeNull();
  });
});

describe('combine', () => {
  const minute = (start, count, min, max, mean, med) => ({
    count, min, max, mean, median: med, first: new Date(at(start)), last: new Date(at(start + 55))
  });

  test('true extremes, mean weighted by count, median of the medians', () => {
    const hour = combine([minute(0, 12, 20, 22, 21, 21), minute(60, 12, 19, 30, 22, 20), minute(120, 2, 25, 26, 25.5, 25.5)]);
    expect(hour.count).toBe(26);
    expect(hour.min).toBe(19);
    expect(hour.max).toBe(30);
    expect(hour.mean).toBeCloseTo((21 * 12 + 22 * 12 + 25.5 * 2) / 26, 6);
    expect(hour.median).toBe(21); // median of 21, 20, 25.5
    expect(hour.first).toEqual(new Date(at(0)));
    expect(hour.last).toEqual(new Date(at(175)));
    expect(combine([])).toBeNull();
  });

  test('rebucket groups by device, measure and span and counts what it combined', () => {
    const rows = [0, 60, 120, 3600].flatMap((start) => ['temperature', 'pressure'].map((measure) => ({
      device: 'SYN_01', measure, ts: new Date(at(start)), ...minute(start, 12, 1, 3, 2, 2)
    })));
    const hours = rebucket(rows, HOUR_MS);
    expect(hours).toHaveLength(4);
    const first = hours.find((hour) => hour.measure === 'temperature' && hour.ts.getTime() === T0);
    expect(first).toMatchObject({ device: 'SYN_01', count: 36, buckets: 3, median: 2 });
    expect(hours.find((hour) => hour.ts.getTime() === T0 + HOUR_MS).buckets).toBe(1);
  });
});

describe('minute aggregator', () => {
  test('holds the open minute and gives a bucket once the minute has closed', () => {
    const aggregator = createMinuteAggregator();
    for (const [seconds, value] of [[1, 20], [6, 22], [11, 21]]) {
      expect(aggregator.add('SYN_01', 'temperature', value, at(seconds), at(seconds))).toBe('ok');
    }
    expect(aggregator.takeClosed(at(59))).toEqual([]);
    expect(aggregator.takeClosed(T0 + MINUTE_MS + CLOSE_GRACE_MS - 1)).toEqual([]);
    const closed = aggregator.takeClosed(T0 + MINUTE_MS + CLOSE_GRACE_MS);
    expect(closed).toEqual([{
      device: 'SYN_01', measure: 'temperature', ts: new Date(T0),
      count: 3, min: 20, max: 22, mean: 21, median: 21, first: new Date(at(1)), last: new Date(at(11))
    }]);
    expect(aggregator.size()).toBe(0);
  });

  test('keeps devices, measures and minutes apart', () => {
    const aggregator = createMinuteAggregator();
    aggregator.add('SYN_01', 'temperature', 1, at(10), at(10));
    aggregator.add('SYN_01', 'pressure', 1000, at(10), at(10));
    aggregator.add('SYN_02', 'temperature', 2, at(10), at(10));
    aggregator.add('SYN_01', 'temperature', 3, at(70), at(70));
    expect(aggregator.size()).toBe(4);
    expect(aggregator.takeClosed(at(70))).toHaveLength(3);
    expect(aggregator.takeAll()).toHaveLength(1);
  });

  test('out-of-order readings inside the minute are summarised like ordered ones', () => {
    const aggregator = createMinuteAggregator();
    aggregator.add('SYN_01', 'temperature', 5, at(40), at(40));
    aggregator.add('SYN_01', 'temperature', 1, at(10), at(41));
    aggregator.add('SYN_01', 'temperature', 3, at(20), at(42));
    const [bucket] = aggregator.takeAll();
    expect(bucket).toMatchObject({ count: 3, min: 1, max: 5, median: 3, first: new Date(at(10)), last: new Date(at(40)) });
  });

  test('a reading up to two minutes late opens its own minute again; an older one is refused', () => {
    const aggregator = createMinuteAggregator();
    const now = at(200);
    expect(aggregator.add('SYN_01', 'temperature', 9, now - LATE_ACCEPT_MS, now)).toBe('ok');
    expect(aggregator.add('SYN_01', 'temperature', 9, now - LATE_ACCEPT_MS - 1, now)).toBe('late');
    expect(aggregator.add('SYN_01', 'temperature', 9, now + 60_000, now)).toBe('future');
    const closed = aggregator.takeClosed(now);
    expect(closed).toHaveLength(1);
    expect(closed[0].ts).toEqual(new Date(T0 + MINUTE_MS));
  });

  test('beyond the per-minute bound, count and extremes stay exact and the median uses the first readings', () => {
    const aggregator = createMinuteAggregator({ maxValues: 3 });
    [1, 2, 3, 100, 200].forEach((value, i) => aggregator.add('SYN_01', 'temperature', value, at(i), at(i)));
    const [bucket] = aggregator.takeAll();
    expect(bucket).toMatchObject({ count: 5, min: 1, max: 200, mean: 61.2, median: 2 });
  });

  test('takeAll returns the open minute too (shutdown)', () => {
    const aggregator = createMinuteAggregator();
    aggregator.add('SYN_01', 'temperature', 4, at(3), at(3));
    expect(aggregator.takeAll()).toHaveLength(1);
    expect(aggregator.takeAll()).toEqual([]);
  });
});
