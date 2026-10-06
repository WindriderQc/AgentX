'use strict';

/**
 * When may the coverage job start a bite?
 *
 * Inside the quiet hours, with nothing owning the runtime (no workload,
 * maintenance, announced recreate or unknown inference), no batch or profile
 * running, and the household quiet for the configured minutes. A bite that
 * has started still yields to a household turn like any batch.
 *
 * Conversations that reach Core through an external agent harness are not
 * distinguishable from that harness's scheduled jobs, so they do not count as
 * activity: the quiet hours are the protection for them.
 */

const MIN_REMAINING_MINUTES = 20;

function minutesOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = type => Number(parts.find(part => part.type === type).value);
  return value('hour') * 60 + value('minute');
}

const toMinutes = time => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** { inside, remainingMinutes } for a window that may cross midnight. */
function quietWindow(settings, now = new Date()) {
  const start = toMinutes(settings.quietStart);
  const end = toMinutes(settings.quietEnd);
  const current = minutesOfDay(now, settings.timeZone);
  const length = (end - start + 1440) % 1440;
  const elapsed = (current - start + 1440) % 1440;
  const inside = elapsed < length;
  return { inside, remainingMinutes: inside ? length - elapsed : 0 };
}

/**
 * @returns {Promise<{ idle: boolean, reasons: string[] }>}
 */
async function checkIdle(settings, deps) {
  const reasons = [];
  const window = quietWindow(settings, deps.now ? deps.now() : new Date());
  if (!window.inside) reasons.push(`outside quiet hours (${settings.quietStart} to ${settings.quietEnd}, ${settings.timeZone})`);
  else if (window.remainingMinutes < MIN_REMAINING_MINUTES) reasons.push('quiet hours end too soon to start a measurement');
  // Outside the window nothing else matters: do not query Core every minute all day.
  if (reasons.length) return { idle: false, reasons };

  const [runtime, household, activeBatch, activeProfiles] = await Promise.all([
    deps.getRuntimeActive(), deps.getHouseholdIdle(), deps.getActiveBatch(), deps.getActiveProfiles()
  ]);
  if (runtime.maintenance) reasons.push('maintenance in progress');
  if (runtime.drain) reasons.push('a service recreate is announced');
  if ((runtime.workloads || []).length) reasons.push('another workload holds a host');
  if ((runtime.inferences || []).some(item => item.state === 'UNKNOWN')) reasons.push('an inference with unknown outcome blocks a host');
  if (activeBatch) reasons.push('a benchmark batch is running');
  if (activeProfiles) reasons.push('a profile is running');
  if (household.activeTurns > 0 || household.idleMs < settings.idleMinutes * 60000) {
    reasons.push(`household active in the last ${settings.idleMinutes} minutes`);
  }
  return { idle: reasons.length === 0, reasons };
}

module.exports = { checkIdle, quietWindow, MIN_REMAINING_MINUTES };
