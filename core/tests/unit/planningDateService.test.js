const {
  defaultPlanningTimeZone,
  dateOnlyKey,
  zonedDateOnly,
  zonedDayBounds,
  isDateOnlyOverdue
} = require('../../src/services/planningDateService');

describe('planningDateService date-only semantics', () => {
  test('uses UTC as the reusable default and honors deployment configuration', () => {
    expect(defaultPlanningTimeZone({})).toBe('UTC');
    expect(defaultPlanningTimeZone({ PLANNING_TIME_ZONE: 'America/Toronto' })).toBe('America/Toronto');
  });

  test('preserves the calendar date from stored ISO values', () => {
    expect(dateOnlyKey('2026-07-16T00:00:00.000Z')).toBe('2026-07-16');
    expect(dateOnlyKey(new Date('2026-07-16T00:00:00.000Z'))).toBe('2026-07-16');
  });

  test('uses the Planning timezone instead of UTC for the current day', () => {
    const now = new Date('2026-07-16T02:00:00.000Z');
    expect(zonedDateOnly(now, 'America/Toronto')).toBe('2026-07-15');
  });

  test('does not mark a target overdue until its local calendar day has ended', () => {
    expect(isDateOnlyOverdue(
      '2026-07-16T00:00:00.000Z',
      new Date('2026-07-17T03:59:00.000Z'),
      'America/Toronto'
    )).toBe(false);
    expect(isDateOnlyOverdue(
      '2026-07-16T00:00:00.000Z',
      new Date('2026-07-17T04:01:00.000Z'),
      'America/Toronto'
    )).toBe(true);
  });

  test('uses the complete local day, including daylight-saving transitions', () => {
    expect(zonedDayBounds('2026-10-08', 'America/Toronto')).toEqual({
      start: new Date('2026-10-08T04:00:00.000Z'),
      end: new Date('2026-10-09T04:00:00.000Z')
    });
    expect(zonedDayBounds('2026-03-08', 'America/Toronto')).toEqual({
      start: new Date('2026-03-08T05:00:00.000Z'),
      end: new Date('2026-03-09T04:00:00.000Z')
    });
    expect(zonedDayBounds('2026-11-01', 'America/Toronto')).toEqual({
      start: new Date('2026-11-01T04:00:00.000Z'),
      end: new Date('2026-11-02T05:00:00.000Z')
    });
  });
});
