'use strict';

// #287 — a date-only personal-task deadline is the household calendar day, not
// the UTC day. The process TZ is forced to UTC for the whole file, so every
// assertion below proves the configured household zone (PLANNING_TIME_ZONE,
// default America/Toronto) owns the deadline. A full ISO datetime with an
// explicit offset keeps its exact instant; relevantUntil keeps its own,
// distinct activity semantics.

const previousTz = process.env.TZ;
const previousZone = process.env.PLANNING_TIME_ZONE;
process.env.TZ = 'UTC';

const { parseDueAt } = require('../../src/services/personalTaskService');
const { publicTask } = require('../../src/services/personalTaskView');
const { composePersonalBriefing, dayLabel } = require('../../src/services/personalBriefing');
const { endOfHouseholdDay } = require('../../src/domains/household/family');

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
  if (previousZone === undefined) delete process.env.PLANNING_TIME_ZONE;
  else process.env.PLANNING_TIME_ZONE = previousZone;
});

function withHouseholdZone(zone, fn) {
  const before = process.env.PLANNING_TIME_ZONE;
  if (zone === undefined) delete process.env.PLANNING_TIME_ZONE;
  else process.env.PLANNING_TIME_ZONE = zone;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.PLANNING_TIME_ZONE;
    else process.env.PLANNING_TIME_ZONE = before;
  }
}

const task = (fields) => ({ pipelineId: fields.id, status: 'queued', createdAt: '2026-09-01T12:00:00Z', ...fields });
const view = (row, now) => publicTask(task(row), now);
const brief = (rows, now) => composePersonalBriefing(rows.map((row) => view(row, now)), now);

describe('parseDueAt: the date-only deadline contract (#287)', () => {
  test('acceptance: dueAt 2026-10-04 is the end of Sunday October 4 in America/Toronto', () => {
    const stored = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-04'));
    expect(stored.toISOString()).toBe('2026-10-05T03:59:59.999Z'); // = 23:59:59.999 EDT
    expect(dayLabel(stored, 'America/Toronto')).toBe('dimanche 4 octobre');
  });

  test('the same local-day result holds when the household zone is UTC', () => {
    const stored = withHouseholdZone('UTC', () => parseDueAt('2026-10-04'));
    expect(stored.toISOString()).toBe('2026-10-04T23:59:59.999Z');
    expect(dayLabel(stored, 'UTC')).toBe('dimanche 4 octobre');
  });

  test('spring-forward boundary 2026-03-08: the deadline is that same household day', () => {
    const stored = withHouseholdZone('America/Toronto', () => parseDueAt('2026-03-08'));
    expect(stored.toISOString()).toBe('2026-03-09T03:59:59.999Z'); // = 23:59:59.999 EDT, after 02:00->03:00
    expect(dayLabel(stored, 'America/Toronto')).toBe('dimanche 8 mars');
  });

  test('fall-back boundary 2026-11-01: the deadline is that same household day', () => {
    const stored = withHouseholdZone('America/Toronto', () => parseDueAt('2026-11-01'));
    expect(stored.toISOString()).toBe('2026-11-02T04:59:59.999Z'); // = 23:59:59.999 EST
    expect(dayLabel(stored, 'America/Toronto')).toBe('dimanche 1 novembre');
  });

  test('a zone east of UTC ends the same household day later, not at UTC midnight', () => {
    const stored = withHouseholdZone('Pacific/Auckland', () => parseDueAt('2026-10-04'));
    expect(stored.toISOString()).toBe('2026-10-04T10:59:59.999Z');
    expect(dayLabel(stored, 'Pacific/Auckland')).toBe('dimanche 4 octobre');
  });

  test('a full ISO datetime with an explicit offset keeps its exact instant', () => {
    const stored = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-03T23:59:00-04:00'));
    expect(stored.toISOString()).toBe('2026-10-04T03:59:00.000Z');
    expect(stored.getTime()).toBe(Date.parse('2026-10-04T03:59:00.000Z'));
  });

  test('a full ISO datetime with Z keeps its exact instant', () => {
    const stored = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-04T02:00:00Z'));
    expect(stored.toISOString()).toBe('2026-10-04T02:00:00.000Z');
  });

  test('null, undefined and empty clear the deadline', () => {
    for (const value of [null, undefined, '']) expect(withHouseholdZone('America/Toronto', () => parseDueAt(value))).toBeNull();
  });

  test.each([
    ['2026-13-40', 'a month beyond twelve'],
    ['2026-02-30', 'a day beyond the month'],
    ['2026-10-04extra', 'trailing garbage on a date'],
    ['soon', 'free text'],
    ['2026-10-32', 'a day the month does not have'],
  ])('rejects the invalid date %s (%s) with SECRETARY_BAD_DUE_DATE', (value) => {
    let error = null;
    try {
      withHouseholdZone('America/Toronto', () => parseDueAt(value));
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'SECRETARY_BAD_DUE_DATE' });
  });
});

describe('endOfHouseholdDay: the shared household calendar helper (#287, #292)', () => {
  test.each([
    ['America/Toronto', '2026-10-04', '2026-10-05T03:59:59.999Z'],
    ['America/Toronto', '2026-03-08', '2026-03-09T03:59:59.999Z'],
    ['America/Toronto', '2026-11-01', '2026-11-02T04:59:59.999Z'],
    ['UTC', '2026-10-04', '2026-10-04T23:59:59.999Z'],
    ['UTC', '2026-11-01', '2026-11-01T23:59:59.999Z'],
    ['Pacific/Auckland', '2026-10-04', '2026-10-04T10:59:59.999Z'],
    ['Asia/Tokyo', '2026-10-04', '2026-10-04T14:59:59.999Z']
  ])('the end of %s in %s is 23:59:59.999 local (%s)', (zone, day, expectedIso) => {
    const instant = withHouseholdZone(zone, () => endOfHouseholdDay(day, zone));
    expect(instant.toISOString()).toBe(expectedIso);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(instant).filter((part) => part.type !== 'literal');
    expect(parts.map((part) => part.value).join('-')).toBe(`${day}-23-59-59`);
  });
});

describe('a date-only deadline lands in its household day and morning briefing (#287)', () => {
  test('acceptance: created on the 2nd, it is dueToday on the morning of Sunday October 4 and leads the brief', () => {
    const created = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-04'));
    const morning = new Date('2026-10-04T12:00:00Z'); // Sunday 08:00 EDT.
    const row = view({ id: '2870', title: 'Dépôt de dimanche', dueAt: created }, morning);
    expect(row.dueAt).toBe('2026-10-05T03:59:59.999Z');
    expect(row).toMatchObject({ dueToday: true, overdue: false, lane: 'today' });
    const result = brief([{ id: '2870', title: 'Dépôt de dimanche', dueAt: created }], morning);
    expect(result.lines).toEqual([
      "Bonjour Dad — voici l'essentiel.",
      "Aujourd'hui : Dépôt de dimanche",
      'Pour la tâche #2870 : faite, à reporter (avec une date) ou encore utile ?'
    ]);
    expect(result.focus).toEqual({
      id: '2870', title: 'Dépôt de dimanche', lane: 'today', dueAt: '2026-10-05T03:59:59.999Z'
    });
  });

  test('the same hold with the household zone set to UTC', () => {
    const created = withHouseholdZone('UTC', () => parseDueAt('2026-10-04'));
    const morning = new Date('2026-10-04T09:00:00Z'); // Sunday 09:00 UTC.
    const row = view({ id: '2871', title: 'Dépôt de dimanche', dueAt: created }, morning);
    expect(row).toMatchObject({ dueToday: true, overdue: false, lane: 'today' });
    expect(brief([{ id: '2871', title: 'Dépôt de dimanche', dueAt: created }], morning).lines[1])
      .toBe("Aujourd'hui : Dépôt de dimanche");
  });

  test('spring-forward morning of 2026-03-08: the day-only deadline is in the brief for that day', () => {
    const created = withHouseholdZone('America/Toronto', () => parseDueAt('2026-03-08'));
    const morning = new Date('2026-03-08T17:00:00Z'); // Sunday 13:00 EDT.
    expect(view({ id: '2872', title: 'Tâche du jour', dueAt: created }, morning))
      .toMatchObject({ dueToday: true, lane: 'today' });
    expect(brief([{ id: '2872', title: 'Tâche du jour', dueAt: created }], morning).lines[1])
      .toBe("Aujourd'hui : Tâche du jour");
  });

  test('fall-back morning of 2026-11-01: the day-only deadline is in the brief for that day', () => {
    const created = withHouseholdZone('America/Toronto', () => parseDueAt('2026-11-01'));
    const morning = new Date('2026-11-01T17:00:00Z'); // Sunday 12:00 EST.
    expect(view({ id: '2873', title: 'Tâche du jour', dueAt: created }, morning))
      .toMatchObject({ dueToday: true, lane: 'today' });
    expect(brief([{ id: '2873', title: 'Tâche du jour', dueAt: created }], morning).lines[1])
      .toBe("Aujourd'hui : Tâche du jour");
  });

  test('the deadline does not leak into the previous household day, east or west of UTC', () => {
    const created = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-04'));
    // Saturday 01:30 EDT: a UTC-midnight deadline (the old bug) is already past here.
    const saturday = view({ id: '2874', title: 'Dépôt de dimanche', dueAt: created }, new Date('2026-10-03T05:30:00Z'));
    expect(saturday).toMatchObject({ dueToday: false, overdue: false, lane: 'upcoming' });
    const auckland = withHouseholdZone('Pacific/Auckland', () =>
      view({ id: '2874', title: 'Dépôt de dimanche', dueAt: created }, new Date('2026-10-03T05:30:00Z')));
    // The Toronto instant is already Saturday in Auckland: upcoming, never "today".
    expect(auckland).toMatchObject({ dueToday: false, lane: 'upcoming' });
  });

  test('relevantUntil keeps its distinct activity semantics: the start of its day, never the end of the deadline day', () => {
    const deadline = withHouseholdZone('America/Toronto', () => parseDueAt('2026-10-04'));
    // The activity date reads as the start of its day — the opposite boundary
    // of the deadline, which holds until the end of its day.
    const activity = new Date('2026-10-04T04:00:00.000Z'); // Midnight in Toronto, the household zone.
    expect(deadline.getTime()).not.toBe(activity.getTime());
    // On the activity day itself the task is still in the today lane; once the
    // activity day has passed it is expired, not overdue.
    const onDay = view({ id: '2875', title: 'Lunch', dueAt: deadline, relevantUntil: activity }, new Date('2026-10-04T12:00:00Z'));
    expect(onDay).toMatchObject({ expired: false, dueToday: true, lane: 'today' });
    const after = view({ id: '2875', title: 'Lunch', dueAt: deadline, relevantUntil: activity }, new Date('2026-10-05T12:00:00Z'));
    expect(after).toMatchObject({ expired: true, dueToday: false, overdue: false, lane: 'expired' });
  });
});
