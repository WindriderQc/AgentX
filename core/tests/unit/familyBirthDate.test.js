'use strict';

const { ageInYears, birthdayLabel, familyBirthDate, instanceToday } = require('../../src/domains/household/familyBirthDate');

describe('household profile birth date', () => {
  const now = new Date('2026-06-15T12:00:00Z');
  let previousZone;
  beforeEach(() => { previousZone = process.env.PLANNING_TIME_ZONE; process.env.PLANNING_TIME_ZONE = 'UTC'; });
  afterEach(() => { if (previousZone === undefined) delete process.env.PLANNING_TIME_ZONE; else process.env.PLANNING_TIME_ZONE = previousZone; });

  test('accepts a real past date and clears on empty input', () => {
    expect(familyBirthDate('2016-02-29', now)).toBe('2016-02-29');
    expect(familyBirthDate(' 1900-01-01 ', now)).toBe('1900-01-01');
    expect(familyBirthDate('2026-06-15', now)).toBe('2026-06-15');
    for (const empty of [null, undefined, '', '  ']) expect(familyBirthDate(empty, now)).toBeNull();
  });

  test('refuses impossible, future, pre-1900 and non date-only values', () => {
    for (const bad of ['2015-02-29', '2016-13-01', '2016-04-31', '2026-06-16', '1899-12-31',
      '2016-3-14', '2016-03-14T00:00:00Z', 'yesterday', 20160314]) {
      expect(() => familyBirthDate(bad, now)).toThrow(expect.objectContaining({ status: 400, code: 'FAMILY_PROFILE_BAD_BIRTH_DATE' }));
    }
  });

  test('computes the age on the instance date and names the birthday without the year', () => {
    expect(ageInYears('2016-06-16', '2026-06-15')).toBe(9);
    expect(ageInYears('2016-06-15', '2026-06-15')).toBe(10);
    expect(ageInYears('2026-01-01', '2026-06-15')).toBe(0);
    expect(ageInYears('2027-01-01', '2026-06-15')).toBeNull();
    expect(ageInYears(undefined, '2026-06-15')).toBeNull();
    expect(birthdayLabel('2016-03-01')).toBe('1er mars');
    expect(birthdayLabel('2016-08-14')).toBe('14 août');
  });

  test('uses the configured time zone, else the server local date', () => {
    const lateUtc = new Date('2026-06-16T02:00:00Z');
    expect(instanceToday(lateUtc, 'UTC')).toBe('2026-06-16');
    expect(instanceToday(lateUtc, 'America/Toronto')).toBe('2026-06-15');
    const local = instanceToday(lateUtc, '');
    expect(local).toBe(`${lateUtc.getFullYear()}-${String(lateUtc.getMonth() + 1).padStart(2, '0')}-${String(lateUtc.getDate()).padStart(2, '0')}`);
    expect(instanceToday(lateUtc, 'Not/AZone')).toBe(local);
  });
});
