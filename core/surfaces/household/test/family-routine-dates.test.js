'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { familyChore, familyRoutineInput, isWinterDay, nextRoutineDue, calendarDayKey, routineIntervalDays, winterSeason } = require('../../../src/domains/household/family');
function inHouseholdZone(run) {
  const previous = process.env.PLANNING_TIME_ZONE;
  process.env.PLANNING_TIME_ZONE = 'America/Toronto';
  try { run(); } finally { if (previous === undefined) delete process.env.PLANNING_TIME_ZONE; else process.env.PLANNING_TIME_ZONE = previous; }
}
test('dated routines advance one household day across both daylight-saving transitions', () => inHouseholdZone(() => {
  for (const [day, now, expectedDay, expectedInstant] of [
    ['2026-03-07', '2026-03-07T15:00:00Z', '2026-03-08', '2026-03-09T03:59:59.999Z'],
    ['2026-10-31', '2026-10-31T15:00:00Z', '2026-11-01', '2026-11-02T04:59:59.999Z']
  ]) {
    const chore = familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'daily', dueAt: day });
    const next = nextRoutineDue(chore, new Date(now));
    assert.equal(calendarDayKey(next), expectedDay); assert.equal(next.toISOString(), expectedInstant);
  }
}));
test('a late daily completion does not create another deadline on the same household day', () => inHouseholdZone(() => {
  const daily = familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'daily', dueAt: '2026-03-06' });
  assert.equal(calendarDayKey(nextRoutineDue(daily, new Date('2026-03-08T14:00:00Z'))), '2026-03-09');
  const weekly = familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'weekly', dueAt: '2026-03-07' });
  assert.equal(calendarDayKey(nextRoutineDue(weekly, new Date('2026-03-08T14:00:00Z'))), '2026-03-14');
  assert.equal(nextRoutineDue({ cadence: 'once' }), null);
}));
test('interval routines repeat N household days after the approval day, never from a missed due day', () => inHouseholdZone(() => {
  const chore = familyRoutineInput({ profileId: 'sample', title: 'Water the plant', cadence: 'interval', intervalDays: 10, dueAt: '2026-06-01' });
  assert.equal(chore.intervalDays, 10); assert.equal(chore.winterIntervalDays, null);
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2026-06-01T15:00:00Z'))), '2026-06-11');
  // Approved five days late: the next one is ten days after the approval.
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2026-06-06T15:00:00Z'))), '2026-06-16');
  // Across the autumn DST change the due instant stays the end of the household day.
  const autumn = nextRoutineDue(chore, new Date('2026-10-25T15:00:00Z'));
  assert.equal(calendarDayKey(autumn), '2026-11-04'); assert.equal(autumn.toISOString(), '2026-11-05T04:59:59.999Z');
}));
test('the winter interval applies on approval days inside the configured season', () => inHouseholdZone(() => {
  const chore = familyRoutineInput({ profileId: 'sample', title: 'Water the plant', cadence: 'interval', intervalDays: 7, winterIntervalDays: 14 });
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2026-10-31T15:00:00Z'))), '2026-11-07');
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2026-11-01T15:00:00Z'))), '2026-11-15');
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2027-03-31T15:00:00Z'))), '2027-04-14');
  assert.equal(calendarDayKey(nextRoutineDue(chore, new Date('2027-04-01T15:00:00Z'))), '2027-04-08');
  assert.equal(routineIntervalDays(chore, '2027-01-15'), 14);
  assert.equal(familyChore({ ...chore, status: 'queued' }, new Date('2027-01-15T15:00:00Z')).currentIntervalDays, 14);
}));
test('the winter season is configurable, may wrap the year, and falls back on invalid bounds', () => {
  assert.deepEqual(winterSeason('12-15/02-28'), { start: '12-15', end: '02-28' });
  assert.equal(isWinterDay('2027-01-10', winterSeason('12-15/02-28')), true);
  assert.equal(isWinterDay('2026-12-01', winterSeason('12-15/02-28')), false);
  assert.equal(isWinterDay('2026-07-10', winterSeason('06-01/08-31')), true);
  for (const invalid of ['13-01/03-31', '02-30/03-31', 'winter', '']) assert.deepEqual(winterSeason(invalid), { start: '11-01', end: '03-31' });
});
test('interval routines require a bounded whole number of days and other frequencies carry none', () => {
  for (const intervalDays of [undefined, 1, 91, 2.5, 'ten']) {
    assert.throws(() => familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'interval', intervalDays }), { code: 'FAMILY_CHORE_BAD_INTERVAL' });
  }
  assert.throws(() => familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'interval', intervalDays: 7, winterIntervalDays: 120 }), { code: 'FAMILY_CHORE_BAD_INTERVAL' });
  const weekly = familyRoutineInput({ profileId: 'sample', title: 'Routine', cadence: 'weekly', intervalDays: 10, winterIntervalDays: 14 });
  assert.equal(weekly.intervalDays, null); assert.equal(weekly.winterIntervalDays, null);
  assert.equal(familyChore({ cadence: 'weekly', intervalDays: 10, status: 'queued' }).intervalDays, null);
});
