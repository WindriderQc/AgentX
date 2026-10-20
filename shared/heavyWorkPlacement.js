'use strict';

/**
 * Where heavy work fits in time (#878). Shared by Core, which places queue
 * requests, and Benchmark, which previews a lane campaign before recording it.
 *
 * Heavy work loads its whole machine (GPU, CPU, memory bandwidth), so two
 * requests on the same machine never share a slot even when they use
 * different Ollama endpoints. Different machines run in parallel. A slot is
 * the first gap after work already reserved or running there.
 */

const BUSY_STATES = ['reserved', 'dispatching', 'running', 'uncertain'];
const MINUTE = 60000;
const DEFAULT_NIGHT = '23:00-06:00';

function machineOf(hostUrl) {
  try { return new URL(hostUrl).hostname.toLowerCase(); } catch { return String(hostUrl || '').toLowerCase(); }
}

/** Intervals already taken on each machine by queue requests. */
function busyByMachine(jobs = [], { exceptIds = [], now = Date.now() } = {}) {
  const busy = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!BUSY_STATES.includes(job?.state) || exceptIds.includes(job.id)) continue;
    const active = job.state !== 'reserved';
    const start = active ? now : Date.parse(job.reservation?.start);
    // Running work past its estimate still holds the machine until it ends.
    const end = active ? Math.max(now, Date.parse(job.reservation?.end) || now) + MINUTE : Date.parse(job.reservation?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (const key of new Set((job.hosts || []).map(machineOf))) {
      if (!busy.has(key)) busy.set(key, []);
      busy.get(key).push({ start, end, id: job.id, title: job.title });
    }
  }
  return busy;
}

/** First start at or after `from` that overlaps none of `taken`. */
function firstFree(from, minutes, taken) {
  let start = from;
  for (let guard = 0; guard < 500; guard += 1) {
    const end = start + minutes * MINUTE;
    const clash = taken.filter(slot => slot.start < end && slot.end > start)
      .reduce((late, slot) => (!late || slot.end > late.end ? slot : late), null);
    if (!clash) return start;
    start = clash.end;
  }
  return start;
}

/** Wall-clock parts of an instant in a time zone. */
function zoned(ms, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(part => [part.type, Number(part.value)]));
  return parts;
}
/** The instant of a wall-clock time in a time zone (DST-safe). */
function instantOf(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const p = zoned(guess, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - shown;
  }
  return guess;
}
function parseWindow(spec = DEFAULT_NIGHT) {
  const match = String(spec || DEFAULT_NIGHT).trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!match) return parseWindow(DEFAULT_NIGHT);
  const [sh, sm, eh, em] = match.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return parseWindow(DEFAULT_NIGHT);
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

/**
 * The current or next night window: { start, end } in ms. When `now` falls
 * inside tonight's window, it starts now.
 */
function nightWindow(now = Date.now(), { timeZone = 'UTC', spec = DEFAULT_NIGHT } = {}) {
  const window = parseWindow(spec);
  const p = zoned(now, timeZone);
  const overnight = window.end <= window.start;
  const at = (dayOffset, minutes) => {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + dayOffset));
    return instantOf(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), Math.floor(minutes / 60), minutes % 60, timeZone);
  };
  for (const offset of [-1, 0, 1]) {
    const start = at(offset, window.start);
    const end = at(offset + (overnight ? 1 : 0), window.end);
    if (end > now && start < end) return { start: Math.max(start, now), end };
  }
  return { start: at(1, window.start), end: at(overnight ? 2 : 1, window.end) };
}

/**
 * Place each target ({ hostUrl, ... }) in order inside [windowStart,
 * windowEnd). `fits` is false when the slot would end after the window.
 */
function planSlots(targets, { windowStart, windowEnd, minutes, jobs = [], exceptIds = [], now = Date.now() }) {
  const busy = busyByMachine(jobs, { exceptIds, now });
  const from = Math.max(windowStart, now);
  return targets.map(target => {
    const length = Number(target.minutes) > 0 ? Number(target.minutes) : minutes;
    const machines = [...new Set((target.hosts || [target.hostUrl]).map(machineOf))];
    const taken = machines.flatMap(key => busy.get(key) || []);
    const start = firstFree(from, length, taken);
    const end = start + length * MINUTE;
    for (const key of machines) {
      if (!busy.has(key)) busy.set(key, []);
      busy.get(key).push({ start, end, id: target.id || null, title: target.title || target.model || null });
    }
    return { ...target, machine: machines.join(', '), start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      fits: Number.isFinite(windowEnd) ? end <= windowEnd : true };
  });
}

/** Night campaign plan with a per-machine summary. */
function planNight(targets, { notBefore, startBefore, minutes, jobs = [], exceptIds = [], now = Date.now() }) {
  const windowStart = Math.max(Date.parse(notBefore), now);
  const windowEnd = Date.parse(startBefore);
  const slots = planSlots(targets, { windowStart, windowEnd, minutes, jobs, exceptIds, now });
  const machines = [...new Set(slots.map(slot => slot.machine))].map(machine => {
    const own = slots.filter(slot => slot.machine === machine);
    return { machine, lanes: own.length, minutes: own.length * minutes,
      lastEnd: own.reduce((last, slot) => (slot.end > last ? slot.end : last), own[0].end), fits: own.every(slot => slot.fits) };
  });
  return { windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(),
    windowMinutes: Math.max(0, Math.round((windowEnd - windowStart) / MINUTE)), minutesPerLane: minutes,
    fits: slots.every(slot => slot.fits), slots, machines };
}

module.exports = { BUSY_STATES, DEFAULT_NIGHT, machineOf, busyByMachine, firstFree, nightWindow, parseWindow, planSlots, planNight };
