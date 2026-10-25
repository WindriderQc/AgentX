'use strict';

const { publicTask, sortedPersonalTasks } = require('../../src/services/personalTaskView');
const { clipTitle, composePersonalBriefing } = require('../../src/services/personalBriefing');

const NOW = new Date('2026-09-23T11:30:00Z');
const task = (fields) => ({ pipelineId: fields.id, status: 'queued', createdAt: '2026-09-01T12:00:00Z', ...fields });
const brief = (rows) => composePersonalBriefing(sortedPersonalTasks(rows.map(task), NOW), NOW);

describe('personal task relevance', () => {
  test('a passed activity requests source review without proving closure', () => {
    const lunch = publicTask(task({ id: '0760', title: 'Lunch', dueAt: '2026-06-05', relevantUntil: '2026-06-05' }), NOW);
    expect(lunch).toMatchObject({ lane: 'expired', expired: true, overdue: false, recheck: false,
      status: 'queued', currentness: { state: 'unchecked', reason: 'activity_date_elapsed' } });
  });

  test('a missed form deadline stays late while its activity is still ahead', () => {
    const form = publicTask(task({ id: '0770', title: 'Form', dueAt: '2026-08-15', relevantUntil: '2026-10-10', createdAt: '2026-09-23T01:00:00Z' }), NOW);
    expect(form).toMatchObject({ lane: 'overdue', overdue: true, recheck: false, expired: false });
  });

  test('without an activity date, a task born late or late for weeks is asked about, never closed', () => {
    const bornLate = publicTask(task({ id: '0773', title: 'Old mail', dueAt: '2025-12-10', createdAt: '2026-09-23T01:00:00Z' }), NOW);
    const longLate = publicTask(task({ id: '0736', title: 'Long late', dueAt: '2026-08-31', createdAt: '2026-08-20T12:00:00Z' }), NOW);
    const recentLate = publicTask(task({ id: '0751', title: 'Recent late', dueAt: '2026-09-20', createdAt: '2026-09-10T12:00:00Z' }), NOW);
    expect(bornLate).toMatchObject({ lane: 'recheck', recheck: true, overdue: false, status: 'queued' });
    expect(longLate).toMatchObject({ lane: 'recheck', recheck: true });
    expect(recentLate).toMatchObject({ lane: 'overdue', overdue: true, recheck: false });
  });

  test('an undated task with a passed activity leaves the inbox', () => {
    const undated = publicTask(task({ id: '0701', title: 'Kimono', relevantUntil: '2026-09-01' }), NOW);
    expect(undated).toMatchObject({ lane: 'expired', unscheduled: false, stale: false });
  });
});

describe('the morning brief', () => {
  test('gives one late task an explicit decision while keeping the brief bounded', () => {
    const result = brief([
      { id: '0751', title: 'Rapporter les contenants de collations', dueAt: '2026-09-21T12:00:00Z', createdAt: '2026-09-20T12:00:00Z' },
      { id: '0760', title: 'Lunch froid journée pédagogique', dueAt: '2026-06-05', relevantUntil: '2026-06-05' },
      { id: '0773', title: 'Réserver la séance', dueAt: '2025-12-10', createdAt: '2026-09-23T01:00:00Z' },
      { id: '0763', title: 'Ramener le kimono', dueAt: '2026-09-24T12:00:00Z' },
      { id: '0800', title: 'Sans date ancienne' },
      { id: '0801', title: 'Sans date nouvelle', createdAt: '2026-09-23T02:00:00Z' }
    ]);
    expect(result.lines).toEqual([
      "Bonjour Dad — voici l'essentiel.",
      'En retard : Rapporter les contenants de collations',
      'Pour la tâche #0751 : faite, à reporter (avec une date) ou encore utile ?',
      'À recouper : 1 ancienne échéance (ex. « Réserver la séance »). Vérifier les derniers échanges.',
      'À préparer : Ramener le kimono (jeudi 24 septembre).',
      'Activité passée : 1 dossier à vérifier (ex. « Lunch froid journée pédagogique »). La date seule ne prouve pas la clôture.'
    ]);
    expect(result.focus).toMatchObject({ id: '0751', lane: 'overdue' });
    expect(result.counts).toMatchObject({ overdue: 1, recheck: 1, expired: 1, unscheduled: 2, newUnscheduled: 1 });
  });

  test('never exceeds six lines and says how many urgent items it could not show', () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `09${index}`, title: `Tâche ${index}`, dueAt: '2026-09-22T12:00:00Z', createdAt: '2026-09-20T12:00:00Z' }));
    const result = brief([...rows, { id: '0999', title: 'Sans date' }]);
    expect(result.lines).toHaveLength(6);
    expect(result.lines[4]).toBe("+3 autres en retard ou pour aujourd'hui.");
    expect(result.lines[5]).toBe('1 tâche sans date.');
  });

  test('when six lines overflow, keeps old deadlines to confirm and the next preparation before the hidden count', () => {
    const late = Array.from({ length: 5 }, (_, index) => ({ id: `09${index}`, title: `Tâche ${index}`, dueAt: '2026-09-22T12:00:00Z', createdAt: '2026-09-20T12:00:00Z' }));
    const result = brief([...late,
      { id: '0773', title: 'Vieux courriel', dueAt: '2025-12-10', createdAt: '2026-09-23T01:00:00Z' },
      { id: '0763', title: 'Rendez-vous', dueAt: '2026-09-24T13:30:00Z' },
      { id: '0999', title: 'Sans date' }]);
    expect(result.lines).toHaveLength(6);
    expect(result.lines.slice(4)).toEqual([
      'À recouper : 1 ancienne échéance (ex. « Vieux courriel »). Vérifier les derniers échanges.',
      'À préparer : Rendez-vous (jeudi 24 septembre).'
    ]);
    expect(result.counts.hiddenUrgent).toBe(3);
  });

  test('surfaces a task due today ahead of an overdue backlog with its stable id', () => {
    const overdue = Array.from({ length: 3 }, (_, index) => ({
      id: `late-${index}`, title: `Late task ${index}`,
      dueAt: '2026-09-22T12:00:00Z', createdAt: '2026-09-20T12:00:00Z'
    }));
    const result = brief([...overdue, {
      id: 'today-1', title: 'Current deadline',
      dueAt: '2026-09-23T12:00:00Z', createdAt: '2026-09-20T12:00:00Z'
    }]);
    expect(result.lines[1]).toBe("Aujourd'hui : Current deadline");
    expect(result.focus).toEqual({
      id: 'today-1', title: 'Current deadline', lane: 'today', dueAt: '2026-09-23T12:00:00.000Z'
    });
    expect(result.counts).toMatchObject({ dueToday: 1, overdue: 3, hiddenUrgent: 2 });
  });

  test('says when nothing is urgent', () => {
    const result = brief([]);
    expect(result.text).toBe("Bonjour Dad — voici l'essentiel.\nRien d'urgent dans la liste aujourd'hui.");
    expect(result.focus).toBeNull();
  });

  test('cuts long titles on a word boundary', () => {
    const title = 'Vérifier et apprêter les casquettes, le sac à dos et la boîte à lunch pour le camp de jour de la semaine prochaine';
    const clipped = clipTitle(title, 60);
    expect(clipped.length).toBeLessThanOrEqual(60);
    expect(clipped.endsWith('…')).toBe(true);
    expect(title.startsWith(clipped.slice(0, -1))).toBe(true);
    expect(title[clipped.length - 1]).toBe(' ');
  });

  test('a proposed replacement is presented for decision instead of repeating the old action as an urgent commitment', () => {
    const old = publicTask(task({ id: '0700', title: 'Choose a meeting date', dueAt: '2026-09-22T12:00:00Z', createdAt: '2026-09-20T12:00:00Z' }), NOW);
    const result = composePersonalBriefing([{ ...old, dossierReview: { action: 'update', summary: 'Date confirmed; prepare the documents.' } }], NOW);
    expect(result.focus).toBeNull();
    expect(result.counts).toMatchObject({ open: 1, dossierReview: 1, overdue: 0 });
    expect(result.text).toContain('Date confirmed; prepare the documents.');
    expect(result.text).not.toContain('En retard : Choose a meeting date');
  });
});
