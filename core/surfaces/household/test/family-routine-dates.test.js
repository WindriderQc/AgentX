'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { familyRoutineInput, nextRoutineDue, calendarDayKey } = require('../../../src/domains/household/family');
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
