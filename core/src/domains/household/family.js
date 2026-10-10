'use strict';

const { publicTask } = require('../../services/personalTaskView');

const AGE_BANDS = Object.freeze(['little', 'school', 'teen']);
const CADENCES = Object.freeze(['once', 'daily', 'weekly']);
const MAX_LAUNCH_ROUTINES = 5;
const DEFAULT_FAMILY_TIME_ZONE = 'America/Toronto';

class FamilyInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FamilyInputError';
    this.status = 400;
    this.code = code;
  }
}

function boundedText(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function familyTimeZone(value = process.env.PLANNING_TIME_ZONE) {
  const candidate = boundedText(value, 80) || DEFAULT_FAMILY_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch (_error) {
    return DEFAULT_FAMILY_TIME_ZONE;
  }
}

function calendarDayKey(value, timeZone = familyTimeZone()) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: familyTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(parsed).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Zone offset of one instant, in milliseconds (wall time minus UTC time). The
// fractional seconds are recovered from the instant itself: Intl formats only
// whole seconds, and Date.UTC would drop the milliseconds.
function zoneOffsetMs(instant, timeZone) {
  const parsed = instant instanceof Date ? new Date(instant.getTime()) : new Date(instant);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: familyTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(parsed).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
    parts.hour === '24' ? 0 : +parts.hour, +parts.minute, +parts.second)
    + parsed.getMilliseconds();
  return wall - parsed.getTime();
}

// #287 — the instant that ends one household calendar day: 23:59:59.999 local.
// Solves utc = wall − offset(utc) by fixed point; the offset is constant within
// a day except across the 00:00 edge, so it converges in at most three steps,
// spring-forward and fall-back days included.
function endOfHouseholdDay(yearMonthDay, timeZone) {
  const target = Date.UTC(+yearMonthDay.slice(0, 4), +yearMonthDay.slice(5, 7) - 1, +yearMonthDay.slice(8, 10)) + 86399999;
  let candidate = target - zoneOffsetMs(target, timeZone);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const next = target - zoneOffsetMs(candidate, timeZone);
    if (next === candidate) break;
    candidate = next;
  }
  return new Date(candidate);
}

function cleanProfileId(value) {
  return boundedText(value, 80).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kid';
}

function familyProfile(profile = {}) {
  return {
    id: cleanProfileId(profile.profileId || profile.id),
    displayName: boundedText(profile.displayName || profile.name || 'Kid', 80),
    ageBand: AGE_BANDS.includes(profile.ageBand) ? profile.ageBand : 'school',
    avatar: boundedText(profile.avatar || '⭐', 8),
    active: profile.active !== false,
    createdAt: profile.createdAt || null,
    updatedAt: profile.updatedAt || null
  };
}

function familyProfileInput(input = {}) {
  const displayName = boundedText(input.displayName, 80);
  if (!displayName) throw new FamilyInputError('displayName is required', 'FAMILY_PROFILE_NAME_REQUIRED');
  return {
    profileId: cleanProfileId(input.profileId || displayName),
    displayName,
    ageBand: AGE_BANDS.includes(input.ageBand) ? input.ageBand : 'school',
    avatar: boundedText(input.avatar || '⭐', 8)
  };
}

function familyRoutineInput(input = {}, defaultProfileId = '') {
  const profileId = cleanProfileId(input.profileId || defaultProfileId);
  if (!boundedText(input.profileId || defaultProfileId, 80)) {
    throw new FamilyInputError('profileId is required', 'FAMILY_PROFILE_ID_REQUIRED');
  }
  const title = boundedText(input.title, 160);
  if (!title) throw new FamilyInputError('title is required', 'FAMILY_CHORE_TITLE_REQUIRED');
  let dueAt = null;
  if (input.dueAt) {
    const value = input.dueAt instanceof Date && Number.isFinite(input.dueAt.getTime())
      ? input.dueAt.toISOString() : String(input.dueAt).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const parsed = new Date(`${value}T12:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new FamilyInputError('dueAt must name a real calendar day', 'FAMILY_CHORE_BAD_DUE_DATE');
      }
      dueAt = endOfHouseholdDay(value, familyTimeZone());
    } else dueAt = new Date(value);
    if (Number.isNaN(dueAt.getTime())) {
      throw new FamilyInputError('dueAt must be an ISO date or datetime', 'FAMILY_CHORE_BAD_DUE_DATE');
    }
  }
  return {
    profileId,
    title,
    note: boundedText(input.note, 1000),
    cadence: CADENCES.includes(input.cadence) ? input.cadence : 'once',
    stars: Math.max(1, Math.min(5, Math.floor(Number(input.stars) || 1))),
    priority: Math.max(1, Math.min(5, Math.floor(Number(input.priority) || 3))),
    dueAt
  };
}

function familyLaunchInput(input = {}) {
  const profile = familyProfileInput(input.profile || {});
  if (!Array.isArray(input.routines) || input.routines.length < 1 || input.routines.length > MAX_LAUNCH_ROUTINES) {
    throw new FamilyInputError(
      `Choose between 1 and ${MAX_LAUNCH_ROUTINES} starter routines`,
      'FAMILY_LAUNCH_ROUTINES_REQUIRED'
    );
  }
  const routines = input.routines.map((routine) => familyRoutineInput(routine, profile.profileId));
  const normalizedTitles = routines.map((routine) => routine.title.normalize('NFKC').toLocaleLowerCase('en-CA'));
  if (new Set(normalizedTitles).size !== normalizedTitles.length) {
    throw new FamilyInputError('Starter routine titles must be unique', 'FAMILY_LAUNCH_ROUTINES_DUPLICATE');
  }
  return { profile, routines };
}

function familyChore(task = {}, now = new Date(), timeZone = familyTimeZone()) {
  const base = publicTask(task, now);
  const cancelled = task.familyCancelled === true || base.status === 'cancelled';
  const status = cancelled ? 'cancelled' : base.status;
  const cadence = CADENCES.includes(task.cadence) ? task.cadence : 'once';
  const stars = Math.max(1, Math.min(5, Math.floor(Number(task.stars) || 1)));
  const todayKey = calendarDayKey(now, timeZone);
  const dueKey = base.dueAt ? calendarDayKey(base.dueAt, timeZone) : null;
  const open = !['done', 'cancelled'].includes(status);
  const dueToday = Boolean(open && dueKey && dueKey === todayKey);
  const overdue = Boolean(open && dueKey && dueKey < todayKey);
  return {
    ...base,
    status,
    completedAt: cancelled ? null : base.completedAt,
    overdue,
    dueToday,
    lane: !open ? 'done' : overdue ? 'overdue' : dueToday ? 'today' : dueKey ? 'upcoming' : 'inbox',
    profileId: cleanProfileId(task.profileId),
    cadence,
    stars,
    completionCount: Math.max(0, Math.floor(Number(task.completionCount) || 0)),
    checkedInAt: task.checkedInAt || null,
    lastCompletedAt: cancelled ? null : task.lastCompletedAt || base.completedAt,
    waitingParent: !cancelled && task.status === 'review',
    revision: Number.isInteger(task.__v) ? task.__v : 0,
    dueDay: dueKey
  };
}

function familyRoom(tasks = [], now = new Date(), timeZone = familyTimeZone()) {
  const resolvedTimeZone = familyTimeZone(timeZone);
  const todayKey = calendarDayKey(now, resolvedTimeZone);
  const chores = tasks.map((task) => familyChore(task, now, resolvedTimeZone)).filter((task) => task.status !== 'cancelled');
  const waiting = chores.filter((task) => task.status === 'review');
  const available = chores.filter((task) => task.status === 'in_progress' || (
    task.status === 'queued'
    && (!task.dueAt || task.overdue || task.dueToday)
  )).sort((left, right) => {
    if (left.overdue !== right.overdue) return left.overdue ? -1 : 1;
    if (left.dueToday !== right.dueToday) return left.dueToday ? -1 : 1;
    if (left.dueAt && right.dueAt) return new Date(left.dueAt) - new Date(right.dueAt);
    if (left.dueAt) return -1;
    if (right.dueAt) return 1;
    return left.priority - right.priority || String(left.id).localeCompare(String(right.id));
  });
  const completedToday = chores.filter((task) => {
    return task.lastCompletedAt && calendarDayKey(task.lastCompletedAt, resolvedTimeZone) === todayKey;
  }).length;
  return {
    status: available.length ? 'ready' : waiting.length ? 'waiting_parent' : 'clear',
    timeZone: resolvedTimeZone,
    next: available[0] || null,
    available,
    waiting,
    completedToday
  };
}

function nextRoutineDue(chore = {}, now = new Date()) {
  const cadence = CADENCES.includes(chore.cadence) ? chore.cadence : 'once';
  if (cadence === 'once') return null;
  const step = cadence === 'daily' ? 1 : 7;
  let next = chore.dueAt ? new Date(chore.dueAt) : new Date(now);
  if (Number.isNaN(next.getTime())) next = new Date(now);
  const zone = familyTimeZone(), day = calendarDayKey(next, zone);
  if (chore.dueAt && next.getTime() === endOfHouseholdDay(day, zone).getTime()) {
    const calendar = new Date(`${day}T12:00:00Z`), today = calendarDayKey(now, zone);
    let nextDay;
    do {
      calendar.setUTCDate(calendar.getUTCDate() + step);
      nextDay = calendar.toISOString().slice(0, 10);
    } while (nextDay <= today);
    return endOfHouseholdDay(nextDay, zone);
  }
  do { next.setDate(next.getDate() + step); } while (next <= now);
  return next;
}

module.exports = {
  AGE_BANDS,
  CADENCES,
  DEFAULT_FAMILY_TIME_ZONE,
  MAX_LAUNCH_ROUTINES,
  FamilyInputError,
  calendarDayKey,
  cleanProfileId,
  endOfHouseholdDay,
  familyChore,
  familyLaunchInput,
  familyProfile,
  familyProfileInput,
  familyRoom,
  familyRoutineInput,
  familyTimeZone,
  nextRoutineDue
};
