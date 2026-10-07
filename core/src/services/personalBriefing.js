'use strict';

// The morning personal brief, composed once here and relayed verbatim by every
// channel (OpenClaw Telegram job, Dad's Desk preview). Channels do not rebuild it.

const MAX_LINES = 6;
const MAX_URGENT = 2;
const TITLE_CHARS = 110;
const PREPARE_WINDOW_MS = 36 * 3600000;

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

// Cut on a word boundary so a title never ends in the middle of a word.
function clipTitle(value, max = TITLE_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

function dayLabel(date, timeZone) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

function example(tasks) {
  return tasks.length ? ` (ex. « ${clipTitle(tasks[0].title, 60)} »)` : '';
}

/**
 * @param {object[]} tasks public personal tasks (personalTaskView.publicTask)
 */
function defaultBriefingTimeZone() {
  // Lazy require: the household domain owns the configured calendar zone and
  // imports this module's view layer, so resolve it at call time, not load time.
  const { familyTimeZone } = require('../domains/household/family');
  return familyTimeZone();
}

function composePersonalBriefing(tasks = [], now = new Date(), options = {}) {
  const timeZone = options.timeZone || defaultBriefingTimeZone();
  const open = tasks.filter((task) => task && !['done', 'cancelled'].includes(task.status) && task.lane !== 'done');
  const byDue = (left, right) => new Date(left.dueAt) - new Date(right.dueAt) || left.priority - right.priority;
  const overdue = open.filter((task) => task.overdue).sort(byDue);
  const dueToday = open.filter((task) => task.dueToday && !task.overdue).sort(byDue);
  const recheck = open.filter((task) => task.recheck).sort(byDue);
  const expired = open.filter((task) => task.expired);
  const unscheduled = open.filter((task) => task.unscheduled);
  const fresh = unscheduled.filter((task) => task.createdAt && now - new Date(task.createdAt) < 86400000);
  const upcoming = open
    .filter((task) => task.lane === 'upcoming' && new Date(task.dueAt) - now <= PREPARE_WINDOW_MS)
    .sort(byDue)[0] || null;

  const urgent = [
    ...dueToday.map((task) => ({ task, prefix: "Aujourd'hui" })),
    ...overdue.map((task) => ({ task, prefix: 'En retard' }))
  ];
  const shown = urgent.slice(0, MAX_URGENT);
  const focusTask = shown[0]?.task || null;
  const lines = ["Bonjour Dad — voici l'essentiel."];
  if (!shown.length) lines.push("Rien d'urgent aujourd'hui.");
  for (const { task, prefix } of shown) lines.push(`${prefix} : ${clipTitle(task.title)}`);
  // The scheduled delivery and Dad's reply may use different agent sessions.
  if (focusTask) lines.push(`Pour la tâche #${focusTask.id} : faite, à reporter (avec une date) ou encore utile ?`);

  const hidden = urgent.length - shown.length;
  // Order is priority: when six lines overflow, the last ones drop first.
  const optional = [
    recheck.length ? `À confirmer : ${recheck.length} ${plural(recheck.length, 'vieille échéance', 'vieilles échéances')}${example(recheck)}. Encore ${plural(recheck.length, 'utile')} ?` : null,
    upcoming ? `À préparer : ${clipTitle(upcoming.title)} (${dayLabel(new Date(upcoming.dueAt), timeZone)}).` : null,
    hidden > 0 ? `+${hidden} ${plural(hidden, 'autre')} en retard ou pour aujourd'hui.` : null,
    expired.length ? `Activité passée : ${expired.length} ${plural(expired.length, 'tâche')} à fermer${example(expired)}.` : null,
    unscheduled.length ? `${unscheduled.length} ${plural(unscheduled.length, 'tâche')} sans date${fresh.length ? `, dont ${fresh.length} ${plural(fresh.length, 'nouvelle')}` : ''}.` : null
  ].filter(Boolean);
  lines.push(...optional.slice(0, MAX_LINES - lines.length));

  return {
    generatedAt: new Date(now).toISOString(),
    language: 'fr',
    text: lines.join('\n'),
    lines,
    focus: focusTask ? {
      id: focusTask.id,
      title: focusTask.title,
      lane: focusTask.lane,
      dueAt: focusTask.dueAt
    } : null,
    counts: {
      open: open.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      recheck: recheck.length,
      expired: expired.length,
      unscheduled: unscheduled.length,
      newUnscheduled: fresh.length,
      hiddenUrgent: hidden
    }
  };
}

module.exports = { clipTitle, composePersonalBriefing, dayLabel };
