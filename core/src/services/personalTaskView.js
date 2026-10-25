'use strict';

const { mailDerived, personalReview, sourceUrl } = require('./personalTaskReview');

function boundedText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

const TASK_ORIGINS = Object.freeze(['chat', 'email', 'manual']);

// Where a personal task came from. New rows store it; older rows only carry the
// writer's `source`, and the Secretary's email reviews sign their note.
function taskOrigin(task) {
  if (mailDerived(task)) return 'email';
  const explicit = boundedText(task?.origin, 16).toLowerCase();
  if (TASK_ORIGINS.includes(explicit)) return explicit;
  if (boundedText(task?.source, 120) !== 'nestor-secretary') return 'manual';
  return /^Secretary deep review\b/i.test(boundedText(task?.spec || task?.note, 40)) ? 'email' : 'chat';
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

// Days an overdue task keeps its "late" label before Dad is asked whether it
// still matters. Age alone never closes a task: a late form can still be due.
const RECHECK_AFTER_DAYS = 14;

// Day classification ("due today", "the today lane") belongs to the household
// calendar, not the process: a late local evening is still "today" even when its
// UTC date is the next day. The overdue/recheck/late flags keep the explicit
// dueAt instant, independent of this day window.
function zonedDayKeys(now, dueAt, timeZone) {
  // Lazy require: family.js imports this module, so resolving it at load time
  // would hit the circular import before its exports are populated.
  const { familyTimeZone, calendarDayKey } = require('../domains/household/family');
  const zone = familyTimeZone(timeZone);
  return {
    todayKey: calendarDayKey(now, zone),
    dueKey: dueAt ? calendarDayKey(dueAt, zone) : null
  };
}

function publicTask(task, now = new Date(), timeZone) {
  const review = personalReview(task);
  const needsReview = review.state === 'pending';
  const dueAt = validDate(task?.dueAt);
  const createdAt = validDate(task?.createdAt);
  const relevantUntil = validDate(task?.relevantUntil);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const open = !['done', 'cancelled'].includes(task?.status) && review.state !== 'dismissed';
  const actionable = open && !needsReview;
  const { todayKey, dueKey } = zonedDayKeys(now, dueAt, timeZone);
  const ageDays = createdAt ? Math.max(0, Math.floor((now - createdAt) / 86400000)) : null;
  // A passed activity date is a reason to review sources. It does not prove
  // completion, cancellation or that preparation/follow-up is no longer needed.
  const expired = Boolean(actionable && relevantUntil && relevantUntil < today);
  const late = Boolean(dueAt && dueAt < now && actionable && !expired);
  // Without a known activity date, a task captured already late (an old email)
  // or late for weeks is a question for Dad rather than an emergency.
  const bornLate = Boolean(dueAt && createdAt && createdAt - dueAt > 86400000);
  const lateDays = late ? Math.floor((now - dueAt) / 86400000) : 0;
  const recheck = late && !relevantUntil && (bornLate || lateDays >= RECHECK_AFTER_DAYS);
  const overdue = late && !recheck;
  const dueToday = Boolean(dueAt && dueKey && dueKey === todayKey && actionable && !expired);
  return {
    id: boundedText(task?.pipelineId || task?.id, 40),
    title: boundedText(task?.title, 200),
    status: boundedText(task?.status, 32),
    priority: Math.max(1, Math.min(Number(task?.priority) || 3, 5)),
    note: boundedText(task?.spec || task?.note, 2000),
    dueAt: dueAt ? dueAt.toISOString() : null,
    repeat: task?.personalRepeat || null,
    lastCompletedOccurrence: task?.personalLastCompletedOccurrence || null,
    dueDate: dueKey,
    relevantUntil: relevantUntil ? relevantUntil.toISOString() : null,
    personalReview: review,
    category: needsReview || review.state === 'dismissed' ? review.reason || 'email' : 'action',
    needsReview: open && needsReview,
    revision: task?.__v ?? task?.revision ?? 0,
    sourceUrl: sourceUrl(task),
    currentness: { state: 'unchecked', reason: expired ? 'activity_date_elapsed' : recheck ? 'old_due_date' : 'sources_not_reconciled' },
    lastDossierDecision: task?.personalDossierDecisions?.length ? task.personalDossierDecisions.at(-1) : null,
    overdue,
    dueToday,
    expired,
    recheck,
    unscheduled: Boolean(actionable && !dueAt && !expired),
    stale: Boolean(actionable && !dueAt && !expired && ageDays !== null && ageDays >= 14),
    ageDays,
    lane: review.state === 'dismissed' ? 'dismissed' : !open ? 'done' : needsReview ? 'review' : expired ? 'expired' : recheck ? 'recheck' : overdue ? 'overdue' : dueToday ? 'today' : dueAt ? 'upcoming' : 'inbox',
    origin: taskOrigin(task),
    source: boundedText(task?.source, 120),
    createdAt: createdAt ? createdAt.toISOString() : null,
    completedAt: task?.status === 'done' ? task?.updatedAt || task?.completedAt || null : null
  };
}

function sortedPersonalTasks(tasks = [], now = new Date()) {
  return tasks.map((task) => publicTask(task, now)).sort((left, right) => {
    if (left.dueAt && right.dueAt) return new Date(left.dueAt) - new Date(right.dueAt);
    if (left.dueAt) return -1;
    if (right.dueAt) return 1;
    return left.priority - right.priority || String(left.id).localeCompare(String(right.id));
  });
}

module.exports = { TASK_ORIGINS, taskOrigin, publicTask, sortedPersonalTasks };
