'use strict';

// #292 — the due-today lane of a personal task is a question of the household
// calendar, not of the Core process time zone. The process TZ of the worker
// machine is forced to UTC for the whole file, so every assertion below proves
// the configured household zone wins; the explicit dueAt instant is preserved
// for the overdue comparison and for the public ISO output.

const previousTz = process.env.TZ;
const previousZone = process.env.PLANNING_TIME_ZONE;
process.env.TZ = 'UTC';

const { publicTask, sortedPersonalTasks } = require('../../src/services/personalTaskView');
const { composePersonalBriefing, dayLabel } = require('../../src/services/personalBriefing');

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
  if (previousZone === undefined) delete process.env.PLANNING_TIME_ZONE;
  else process.env.PLANNING_TIME_ZONE = previousZone;
});

const task = (fields) => ({ pipelineId: fields.id, status: 'queued', createdAt: '2026-09-01T12:00:00Z', ...fields });
const list = (rows, now) => sortedPersonalTasks(rows.map(task), now);
const brief = (rows, now) => composePersonalBriefing(list(rows, now), now);

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

function withProcessTz(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('the list projection classifies days in the household zone (#292)', () => {
  // Acceptance: the Core process runs in UTC while the household is America/Toronto.
  // Now is Saturday 01:30 EDT; the due instant is Saturday 23:59 EDT, i.e. Sunday
  // 03:59 UTC — a UTC day window would call it tomorrow, the calendar says today.
  test('acceptance: Saturday 23:59 EDT due at Saturday 01:30 EDT is dueToday in the today lane', () => {
    const now = new Date('2026-10-03T05:30:00Z');
    const view = withHouseholdZone('America/Toronto', () =>
      list([
        { id: '0903', title: 'Payer l’assurance', dueAt: '2026-10-04T03:59:00Z' },
        { id: '0904', title: 'Dépôt dimanche', dueAt: '2026-10-04T05:00:00Z' },
        { id: '0905', title: 'Vieux dépôt', dueAt: '2026-10-02T05:00:00Z' }
      ], now));
    const byId = Object.fromEntries(view.map((t) => [t.id, t]));
    expect(byId['0903']).toMatchObject({ dueToday: true, overdue: false, lane: 'today' });
    expect(byId['0904']).toMatchObject({ dueToday: false, lane: 'upcoming' });
    expect(byId['0905']).toMatchObject({ dueToday: false, overdue: true, lane: 'overdue' });
    // The explicit dueAt instant is preserved verbatim in the public output.
    expect(byId['0903'].dueAt).toBe('2026-10-04T03:59:00.000Z');
    // The list contract (personalTaskService.listPersonalTasks) counts from these same flags.
    expect(view.filter((t) => t.dueToday)).toHaveLength(1);
    expect(view.filter((t) => t.overdue)).toHaveLength(1);
    expect(view.map((t) => t.lane).sort()).toEqual(['overdue', 'today', 'upcoming']);
  });

  test('acceptance: the same view keeps working when the process time zone is not UTC', () => {
    const now = new Date('2026-10-03T05:30:00Z');
    const view = withHouseholdZone('America/Toronto', () =>
      withProcessTz('America/Chicago', () =>
        publicTask(task({ id: '0903', title: 'Payer l’assurance', dueAt: '2026-10-04T03:59:00Z' }), now)));
    expect(view).toMatchObject({ dueToday: true, lane: 'today' });
  });

  test('a late local evening whose UTC date is the next day stays in the today lane', () => {
    const now = new Date('2026-10-04T02:30:00Z'); // Saturday 22:30 EDT, already Sunday in UTC.
    const due = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1001', title: 'Appel du soir', dueAt: '2026-10-04T03:00:00Z' }), now)); // Sat 23:00 EDT.
    const past = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1002', title: 'Dépôt de samedi soir', dueAt: '2026-10-04T03:59:00Z' }),
        new Date('2026-10-04T04:30:00Z'))); // Sat 23:59 EDT, already past on Sunday.
    expect(due).toMatchObject({ dueToday: true, overdue: false, lane: 'today' });
    expect(past).toMatchObject({ dueToday: false, overdue: true, lane: 'overdue' });
  });

  test('spring-forward boundary (2026-03-08, 07:00 UTC): Sunday 23:59 EDT is the household today', () => {
    const now = new Date('2026-03-08T17:00:00Z'); // Sunday 13:00 EDT.
    const due = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1101', title: 'Tâche du jour', dueAt: '2026-03-09T03:59:00Z' }), now)); // Sun 23:59 EDT.
    const yesterday = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1102', title: 'Tâche d’hier', dueAt: '2026-03-08T03:59:00Z', createdAt: '2026-03-07T12:00:00Z' }), now));
    expect(due).toMatchObject({ dueToday: true, lane: 'today' });
    expect(yesterday).toMatchObject({ dueToday: false, overdue: true, lane: 'overdue' });
  });

  test('fall-back boundary (2026-11-01, 06:00 UTC): Sunday 23:59 EST is the household today', () => {
    const now = new Date('2026-11-01T17:00:00Z'); // Sunday 12:00 EST.
    const due = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1201', title: 'Tâche du jour', dueAt: '2026-11-02T04:59:00Z' }), now)); // Sun 23:59 EST.
    const yesterday = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1202', title: 'Tâche d’hier', dueAt: '2026-10-31T12:00:00Z', createdAt: '2026-10-30T12:00:00Z' }), now)); // Sat 07:00 EDT.
    expect(due).toMatchObject({ dueToday: true, lane: 'today' });
    expect(yesterday).toMatchObject({ dueToday: false, overdue: true, lane: 'overdue' });
  });

  test('an explicit-offset dueAt round-trips: same instant, same lane, normalized ISO output', () => {
    const now = new Date('2026-10-03T05:30:00Z');
    const zoned = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1301', title: 'Borne horaire', dueAt: '2026-10-03T23:59:00-04:00' }), now));
    const utc = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1301', title: 'Borne horaire', dueAt: '2026-10-04T03:59:00Z' }), now));
    expect(zoned.dueToday).toBe(utc.dueToday);
    expect(zoned.lane).toBe(utc.lane);
    expect(zoned.dueToday).toBe(true);
    expect(zoned.lane).toBe('today');
    expect(zoned.dueAt).toBe('2026-10-04T03:59:00.000Z');
  });

  test('the overdue comparison keeps the explicit dueAt instant, not the day window', () => {
    const now = new Date('2026-10-03T05:30:00Z'); // Saturday 01:30 EDT.
    // Saturday 00:00 EDT: the household day is still Saturday, but the instant has passed.
    const past = withHouseholdZone('America/Toronto', () =>
      publicTask(task({ id: '1401', title: 'Déjà passé', dueAt: '2026-10-03T04:00:00Z' }), now));
    expect(past).toMatchObject({ overdue: true, lane: 'overdue' });
  });

  test('the household zone is configured through PLANNING_TIME_ZONE, defaulting to America/Toronto', () => {
    const now = new Date('2026-10-03T05:30:00Z');
    const rows = [{ id: '1501', title: 'Tâche', dueAt: '2026-10-04T03:59:00Z' }];
    expect(withHouseholdZone(undefined, () => publicTask(task(rows[0]), now))).toMatchObject({ dueToday: true, lane: 'today' });
    // One hour behind Toronto, the due instant is Friday night: upcoming, not today.
    const auckland = withHouseholdZone('Pacific/Auckland', () => publicTask(task(rows[0]), now));
    expect(auckland).toMatchObject({ dueToday: false, lane: 'upcoming' });
  });
});

describe('the personal morning briefing follows the household zone (#292)', () => {
  const NOW = new Date('2026-10-03T05:30:00Z'); // Saturday 01:30 EDT / 05:30 UTC.

  test('acceptance: a task due Saturday 23:59 EDT appears in the Saturday briefing with the Core process in UTC', () => {
    const result = withHouseholdZone('America/Toronto', () =>
      brief([
        { id: '0903', title: 'Payer l’assurance', dueAt: '2026-10-04T03:59:00Z' },
        { id: '1501', title: 'Préparer le souper', dueAt: '2026-10-04T05:00:00Z' },
        { id: '1502', title: 'Tâche en retard', dueAt: '2026-10-02T12:00:00Z', createdAt: '2026-10-01T12:00:00Z' }
      ], NOW));
    expect(result.lines).toEqual([
      "Bonjour Dad — voici l'essentiel.",
      "Aujourd'hui : Payer l’assurance",
      'En retard : Tâche en retard',
      'Pour la tâche #0903 : faite, à reporter (avec une date) ou encore utile ?',
      'À préparer : Préparer le souper (dimanche 4 octobre).'
    ]);
    expect(result.focus).toEqual({
      id: '0903',
      title: 'Payer l’assurance',
      lane: 'today',
      dueAt: '2026-10-04T03:59:00.000Z'
    });
    expect(result.counts).toMatchObject({ open: 3, dueToday: 1, overdue: 1, hiddenUrgent: 0 });
    expect(dayLabel(NOW, 'America/Toronto')).toBe('samedi 3 octobre');
  });

  test('a late local evening whose UTC date is the next day still reads as today in the brief', () => {
    const result = withHouseholdZone('America/Toronto', () =>
      brief([{ id: '1001', title: 'Appel du soir', dueAt: '2026-10-04T03:00:00Z' }], new Date('2026-10-04T02:30:00Z')));
    expect(result.lines[1]).toBe("Aujourd'hui : Appel du soir");
    expect(result.counts.dueToday).toBe(1);
  });

  test('at the spring-forward boundary the household today is in the brief', () => {
    const result = withHouseholdZone('America/Toronto', () =>
      brief([{ id: '1101', title: 'Tâche du jour', dueAt: '2026-03-09T03:59:00Z' }], new Date('2026-03-08T17:00:00Z')));
    expect(result.lines[1]).toBe("Aujourd'hui : Tâche du jour");
    expect(result.counts).toMatchObject({ dueToday: 1, overdue: 0 });
  });

  test('at the fall-back boundary the household today is in the brief', () => {
    const result = withHouseholdZone('America/Toronto', () =>
      brief([{ id: '1201', title: 'Tâche du jour', dueAt: '2026-11-02T04:59:00Z' }], new Date('2026-11-01T17:00:00Z')));
    expect(result.lines[1]).toBe("Aujourd'hui : Tâche du jour");
    expect(result.counts).toMatchObject({ dueToday: 1, overdue: 0 });
  });

  test('the whole briefing follows the configured zone: the same due instant is today in Toronto, tomorrow in Auckland', () => {
    // 2026-10-03T14:00:00Z is Saturday 10:00 EDT and Sunday 03:00 NZDT.
    const toronto = withHouseholdZone('America/Toronto', () => brief([{ id: '1501', title: 'Préparer le souper', dueAt: '2026-10-03T14:00:00Z' }], NOW));
    expect(toronto.lines[1]).toBe("Aujourd'hui : Préparer le souper");
    expect(toronto.counts.dueToday).toBe(1);
    const auckland = withHouseholdZone('Pacific/Auckland', () => brief([{ id: '1501', title: 'Préparer le souper', dueAt: '2026-10-03T14:00:00Z' }], NOW));
    expect(auckland.lines).toContain('À préparer : Préparer le souper (dimanche 4 octobre).');
    expect(auckland.counts.dueToday).toBe(0);
  });
});
