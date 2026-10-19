'use strict';

/**
 * Night slots for lane measurements. A Full profile loads its machine (GPU,
 * CPU and memory bandwidth), so two lanes of the same machine never share a
 * slot even when they use different Ollama endpoints. Different machines run
 * in parallel. Slots are packed from the window start, after any reserved or
 * running heavy work already planned on that machine, and a slot fits only
 * when it also ends inside the window.
 */

const BUSY_STATES = ['reserved', 'dispatching', 'running', 'uncertain'];

function machineOf(hostUrl) {
  try { return new URL(hostUrl).hostname.toLowerCase(); } catch { return String(hostUrl || ''); }
}

/** Intervals already taken on each machine by other heavy-work requests. */
function busyByMachine(jobs = [], { exceptIds = [], now = Date.now() } = {}) {
  const busy = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!BUSY_STATES.includes(job?.state) || exceptIds.includes(job.id)) continue;
    const active = job.state !== 'reserved';
    const start = active ? now : Date.parse(job.reservation?.start);
    // Running work past its estimate still holds the machine until it ends.
    const end = active ? Math.max(now, Date.parse(job.reservation?.end) || now) + 60000 : Date.parse(job.reservation?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    for (const host of job.hosts || []) {
      const key = machineOf(host);
      if (!busy.has(key)) busy.set(key, []);
      busy.get(key).push({ start, end, id: job.id, title: job.title });
    }
  }
  return busy;
}

/** First start at or after `from` that overlaps none of `taken`. */
function firstFree(from, minutes, taken) {
  let start = from;
  for (let guard = 0; guard < 100; guard += 1) {
    const end = start + minutes * 60000;
    const clash = taken.find(slot => slot.start < end && slot.end > start);
    if (!clash) return start;
    start = clash.end;
  }
  return start;
}

/**
 * targets: [{ model, hostUrl, hostId, hostName }]. Returns one slot per
 * target in order, with `fits` false when it would end after the window.
 */
function planNight(targets, { notBefore, startBefore, minutes, jobs = [], exceptIds = [], now = Date.now() }) {
  const windowStart = Math.max(Date.parse(notBefore), now);
  const windowEnd = Date.parse(startBefore);
  const busy = busyByMachine(jobs, { exceptIds, now });
  const slots = targets.map(target => {
    const machine = machineOf(target.hostUrl);
    const taken = busy.get(machine) || [];
    const start = firstFree(windowStart, minutes, taken);
    const end = start + minutes * 60000;
    taken.push({ start, end, id: null, title: target.model });
    busy.set(machine, taken);
    return { ...target, machine, start: new Date(start).toISOString(), end: new Date(end).toISOString(), fits: end <= windowEnd };
  });
  const machines = [...new Set(slots.map(slot => slot.machine))].map(machine => {
    const own = slots.filter(slot => slot.machine === machine);
    return { machine, lanes: own.length, minutes: own.length * minutes,
      lastEnd: own.reduce((last, slot) => (slot.end > last ? slot.end : last), own[0].end), fits: own.every(slot => slot.fits) };
  });
  return { windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(),
    windowMinutes: Math.max(0, Math.round((windowEnd - windowStart) / 60000)), minutesPerLane: minutes,
    fits: slots.every(slot => slot.fits), slots, machines };
}

module.exports = { planNight, machineOf, busyByMachine, BUSY_STATES };
