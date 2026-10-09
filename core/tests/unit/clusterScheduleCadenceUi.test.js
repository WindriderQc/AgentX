const fs = require('fs');
const path = require('path');
const vm = require('vm');
const projection = require('../../public/js/cluster-schedule-upcoming');

const minute = 60_000;
const hour = 60 * minute;
const base = Date.parse('2026-08-28T00:00:00Z');
const slot = (offset, duration = minute) => ({
  start: new Date(base + offset).toISOString(),
  end: new Date(base + offset + duration).toISOString()
});
const clock = value => new Date(value).toISOString().slice(11, 16);
const label = entry => projection.getCadenceLabel(entry, clock);

describe('Cluster Schedule cadence labels', () => {
  test('uses the declared interval regardless of the projected slot count', () => {
    expect(label({ scheduleType: 'interval', intervalMs: 5 * minute, slots: [slot(0)] }))
      .toBe('every 5 min');
    expect(label({ scheduleType: 'interval', intervalMs: 4 * hour, slots: [] }))
      .toBe('every 4 h');
    expect(label({ scheduleType: 'interval', intervalMs: 90 * minute }))
      .toBe('every 1.5 h');
    expect(label({ scheduleType: 'interval', slots: [slot(0)] })).toBe('');
  });

  test('uses cron start spacing, including truncated and unsorted projections', () => {
    expect(label({ scheduleType: 'cron', slots: [slot(8 * hour), slot(0), slot(4 * hour)] }))
      .toBe('every 4 h');
    expect(label({ scheduleType: 'cron', slots: Array.from({ length: 20 }, (_, i) => slot(i * 5 * minute)) }))
      .toBe('every 5 min');
  });

  test('shows daily time, irregular daily counts and continuous schedules', () => {
    expect(label({ scheduleType: 'cron', slots: [slot(23 * hour + 15 * minute)] })).toBe('daily 23:15');
    expect(label({ scheduleType: 'cron', slots: [slot(9 * hour), slot(17 * hour)] })).toBe('2×/day');
    expect(label({ scheduleType: 'cron', slots: [slot(hour), slot(4 * hour), slot(19 * hour)] })).toBe('3×/day');
    expect(label({ scheduleType: 'continuous', slots: [] })).toBe('24/7');
    expect(label({ slots: [{ ...slot(0), continuous: true }] })).toBe('24/7');
    expect(label({ slots: [] })).toBe('');
    expect(label({ slots: [{ start: 'invalid', end: 'invalid' }] })).toBe('');
  });

  test('does not mistake one short run duration for recurrence', () => {
    const entry = { scheduleType: 'cron', slots: [slot(23 * hour, minute)] };
    expect(projection.deriveIntervalMs(entry, entry.slots[0])).toBeNull();
    expect(projection.isHighFrequencyLightJob(entry)).toBe(false);
  });

  test('joins real interval metadata by entry identity, not display name', () => {
    const result = projection.withScheduleDetails([
      { id: 'a', name: 'Same name', slots: [slot(0)] },
      { id: 'b', name: 'Same name', slots: [slot(0)] }
    ], [
      { _id: 'a', schedule: { type: 'interval', intervalMs: 5 * minute } },
      { _id: 'b', schedule: { type: 'interval', intervalMs: 4 * hour } }
    ]);
    expect(result.map(label)).toEqual(['every 5 min', 'every 4 h']);
  });
});

test('timeline filters and service ticks share thresholds and exclude GPU jobs', () => {
  const context = vm.createContext({
    window: {
      ClusterScheduleUpcoming: projection,
      ClusterScheduleDate: { browserTimeZone: () => 'UTC', localDateKey: () => '2026-08-28' },
      addEventListener: jest.fn()
    },
    document: { addEventListener: jest.fn() }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/js/cluster-schedule.js'), 'utf8'), context);
  const timelineFilter = vm.runInContext('isHighFrequencyLightJob', context);
  const serviceTick = vm.runInContext('isServiceTick', context);
  const cases = [
    [{ scheduleType: 'interval', intervalMs: 59 * minute, slots: [slot(0)] }, true],
    [{ scheduleType: 'interval', intervalMs: hour, dailyCount: 12 }, false],
    [{ scheduleType: 'interval', intervalMs: hour, dailyCount: 13 }, true],
    [{ scheduleType: 'interval', intervalMs: 0 }, false],
    [{ scheduleType: 'cron', slots: [slot(0), slot(5 * minute), slot(10 * minute)] }, true],
    [{ scheduleType: 'cron', intervalMs: 5 * minute, dailyCount: 3 }, true],
    [{ scheduleType: 'cron', slots: [slot(0)] }, false],
    [{ scheduleType: 'continuous' }, true],
    [{ model: 'example-model', scheduleType: 'interval', intervalMs: minute }, false],
    [{ source: 'ollama-persistent', slots: [{ ...slot(0), continuous: true }] }, false],
    [null, false]
  ];
  for (const [entry, expected] of cases) {
    expect(timelineFilter(entry)).toBe(expected);
    expect(serviceTick(entry)).toBe(expected);
  }
});
